// POST /api/spvs/record-issuance — book a manual admin issuance against an
// SPV's EUR 3M annual cap. Sale proceeds are booked by the server instead
// (/api/sale-approvals/settle, 0066).
//
// Authorization tiers:
//   * cap_override: true            -> requireSuperAdmin (server-enforced; the
//                                      UI's ConfirmModal reason flow is
//                                      cosmetic — THIS is the real gate).
//   * source === "sale"             -> 410 Gone (program package 2B): sale
//                                      proceeds are booked by the server from
//                                      the sale-approval reservation
//                                      (/api/sale-approvals/settle, retry
//                                      worker). Kept only so an old client
//                                      gets a clear answer.
//   * source === "manual"           -> requireAdmin (admin ledger entry).
//
// The 0027 BEFORE INSERT trigger remains the authoritative cap guard: without
// cap_override it rejects any insert that would push the SPV over its
// calendar-year cap, and its error message is surfaced verbatim so the client
// toast stays meaningful.
//
// `recorded_by` is stamped with the VERIFIED signer wallet (client value is
// ignored). Client wrapper: recordIssuance() in
// lib/spvs.ts (action "spvs.record_issuance").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin, requireSuperAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = new Set(["manual", "sale"]);

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "spvs.record_issuance",
    );

    const source =
      typeof params.source === "string" ? params.source : "manual";
    if (!SOURCES.has(source)) {
      throw new SiwsError(400, "source must be 'manual' or 'sale'");
    }

    // Sale proceeds are booked by the server from the sale's approval
    // reservation (/api/sale-approvals/settle and the retry worker, 0066).
    // A second, browser-side booking would count the same sale twice.
    if (source === "sale") {
      throw new SiwsError(
        410,
        "Sale issuances are booked by the server from the sale approval; nothing to record here",
      );
    }

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

    // ---- Authorization (see header) ----
    if (capOverride) {
      // Escalated path: only THE super admin may bypass the annual cap,
      // whatever the source.
      await requireSuperAdmin(wallet);
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
