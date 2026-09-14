// POST /api/spvs/record-issuance — book an issuance against an SPV's EUR 3M
// annual cap (manual admin entry OR the launchpad's auto-book on close_sale).
//
// Authorization tiers:
//   * cap_override: true            -> requireSuperAdmin (server-enforced; the
//                                      UI's ConfirmModal reason flow is
//                                      cosmetic — THIS is the real gate).
//   * source === "sale"             -> the asset's on-chain issuer authority
//                                      (SD4: asset_pda -> Asset.issuer ->
//                                      Issuer.authority) OR an admin. This is
//                                      the launchpad auto-book on close_sale,
//                                      which is issuer-signed — it previously
//                                      always 403'd because the route required
//                                      admin, so cap-tracking never happened.
//   * source === "manual"           -> requireAdmin (admin ledger entry).
//
// The 0027 BEFORE INSERT trigger remains the authoritative cap guard: without
// cap_override it rejects any insert that would push the SPV over its
// calendar-year cap, and its error message is surfaced verbatim so the client
// toast stays meaningful.
//
// `recorded_by` is stamped with the VERIFIED signer wallet (client value is
// ignored). Client wrappers: recordIssuance() / recordSaleIssuance() in
// lib/spvs.ts (action "spvs.record_issuance").

import { NextResponse } from "next/server";
import { address as toAddress } from "@solana/kit";
import { getServerRpc } from "@/lib/server/rpc";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin, requireSuperAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  fetchMaybeAsset,
  fetchMaybeIssuer,
} from "@/lib/generated/asset_registry";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOURCES = new Set(["manual", "sale"]);

// SD4 issuer-authority resolution (asset_pda -> Issuer.authority), fail closed.

async function issuerAuthorityFor(assetPda: string): Promise<string | null> {
  try {
    const rpc = getServerRpc();
    const asset = await fetchMaybeAsset(rpc, toAddress(assetPda));
    if (!asset.exists) return null;
    const issuer = await fetchMaybeIssuer(rpc, asset.data.issuer);
    return issuer.exists ? issuer.data.authority.toString() : null;
  } catch (err) {
    console.error("[api/spvs/record-issuance] RPC failure:", err);
    throw new SiwsError(503, "Authorization check unavailable — try again");
  }
}

async function isAdminWallet(wallet: string): Promise<boolean> {
  try {
    await requireAdmin(wallet);
    return true;
  } catch (err) {
    if (err instanceof SiwsError && err.status === 403) return false;
    throw err;
  }
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "spvs.record_issuance",
    );

    const capOverride = params.cap_override === true;

    const spvId = typeof params.spv_id === "string" ? params.spv_id.trim() : "";
    if (!UUID_RE.test(spvId)) {
      throw new SiwsError(400, "spv_id must be a UUID");
    }

    const amountEur =
      typeof params.amount_eur === "number" ? params.amount_eur : NaN;
    if (!Number.isFinite(amountEur) || amountEur <= 0) {
      throw new SiwsError(400, "amount_eur must be a positive number");
    }

    const assetPda =
      typeof params.asset_pda === "string" ? params.asset_pda.trim() : "";
    if (assetPda.length > 64) {
      throw new SiwsError(400, "asset_pda too long");
    }
    const salePubkey =
      typeof params.sale_pubkey === "string" ? params.sale_pubkey.trim() : "";
    if (salePubkey.length > 64) {
      throw new SiwsError(400, "sale_pubkey too long");
    }

    const issuedAt =
      typeof params.issued_at === "string" && params.issued_at.trim()
        ? params.issued_at.trim()
        : new Date().toISOString().slice(0, 10);
    if (!DATE_RE.test(issuedAt)) {
      throw new SiwsError(400, "issued_at must be YYYY-MM-DD");
    }

    const note = typeof params.note === "string" ? params.note.trim() : "";
    if (note.length > 2000) {
      throw new SiwsError(400, "note too long (≤2000 chars)");
    }

    const source =
      typeof params.source === "string" ? params.source : "manual";
    if (!SOURCES.has(source)) {
      throw new SiwsError(400, "source must be 'manual' or 'sale'");
    }

    // ---- Authorization (see header) ----
    if (capOverride) {
      // Escalated path: only THE super admin may bypass the annual cap,
      // whatever the source.
      await requireSuperAdmin(wallet);
    } else if (source === "sale") {
      // Launchpad auto-book on close_sale — issuer-signed. Allow the asset's
      // on-chain issuer authority (or an admin). asset_pda is required so we
      // can resolve who is allowed to book this issuance.
      if (!BASE58_RE.test(assetPda)) {
        throw new SiwsError(
          400,
          "asset_pda (a valid address) is required for source='sale'",
        );
      }
      if (!(await isAdminWallet(wallet))) {
        const authority = await issuerAuthorityFor(assetPda);
        if (authority === null || authority !== wallet) {
          throw new SiwsError(
            403,
            "Only the asset's issuer authority or a platform admin may book this issuance",
          );
        }
      }
    } else {
      // Manual admin ledger entry.
      await requireAdmin(wallet);
    }

    const sb = getSupabaseAdmin();
    const { error } = await sb.from("spv_issuances").insert({
      spv_id: spvId,
      amount_eur: amountEur,
      asset_pda: assetPda || null,
      sale_pubkey: salePubkey || null,
      issued_at: issuedAt,
      note: note || null,
      recorded_by: wallet,
      source,
      ...(capOverride ? { cap_override: true } : {}),
    });
    if (error) {
      // Surface the 0027 trigger's cap message verbatim — the client relies
      // on it ("SPV annual issuance cap exceeded: …"). Other DB errors get a
      // generic message.
      if (/annual issuance cap/i.test(error.message)) {
        throw new SiwsError(409, error.message);
      }
      console.error("[api/spvs/record-issuance] insert failed:", error.message);
      throw new SiwsError(500, "Issuance insert failed");
    }

    return NextResponse.json({
      ok: true,
      data: { spv_id: spvId, amount_eur: amountEur, issued_at: issuedAt },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
