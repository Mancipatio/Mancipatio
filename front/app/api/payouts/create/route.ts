// POST /api/payouts/create — create a payout row + its recipient set.
//
// Signed + requireAdmin. The `author` column is stamped server-side from the
// verified wallet. Recipients are chunk-inserted (Supabase 1000-row cap); on
// a recipient failure the payout row is best-effort rolled back so no
// half-created drop survives.
//
// Client wrapper: createPayout() in lib/payouts.ts (action "payouts.create").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const KINDS = new Set(["dividend", "buyback", "airdrop", "other"]);
const SOURCES = new Set(["csv", "indexer", "manual"]);
const STATUSES = new Set([
  "draft",
  "snapshot_taken",
  "merkle_built",
  "funded",
  "live",
  "claimed_full",
  "cancelled",
]);
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX_RE = /^[0-9a-f]+$/i;
const MAX_RECIPIENTS = 5000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "payouts.create");
    await requireAdmin(wallet);

    if (!isPlainObject(params.payout)) {
      throw new SiwsError(400, "Missing payout");
    }
    const p = params.payout;

    const assetMint =
      typeof p.asset_mint === "string" ? p.asset_mint.trim() : "";
    if (!BASE58_RE.test(assetMint)) {
      throw new SiwsError(400, "asset_mint must be a base58 address");
    }
    const assetLabel =
      typeof p.asset_label === "string"
        ? p.asset_label.trim().slice(0, 120)
        : "";
    const kind = typeof p.kind === "string" && KINDS.has(p.kind) ? p.kind : null;
    if (!kind) throw new SiwsError(400, "Unknown payout kind");
    const totalAmount =
      typeof p.total_amount === "number" &&
      Number.isFinite(p.total_amount) &&
      p.total_amount > 0
        ? p.total_amount
        : null;
    if (totalAmount === null) {
      throw new SiwsError(400, "total_amount must be a positive number");
    }
    const currency =
      typeof p.currency === "string" &&
      p.currency.trim().length > 0 &&
      p.currency.trim().length <= 12
        ? p.currency.trim().toUpperCase()
        : null;
    if (!currency) throw new SiwsError(400, "currency required (≤12 chars)");
    const perShare =
      p.per_share === null || p.per_share === undefined
        ? null
        : typeof p.per_share === "number" && Number.isFinite(p.per_share)
          ? p.per_share
          : undefined;
    if (perShare === undefined) throw new SiwsError(400, "Invalid per_share");
    const snapshotSource =
      typeof p.snapshot_source === "string" && SOURCES.has(p.snapshot_source)
        ? p.snapshot_source
        : null;
    if (!snapshotSource) throw new SiwsError(400, "Unknown snapshot_source");
    const totalShares =
      typeof p.total_shares === "number" &&
      Number.isFinite(p.total_shares) &&
      p.total_shares >= 0
        ? p.total_shares
        : null;
    if (totalShares === null) throw new SiwsError(400, "Invalid total_shares");
    const merkleRoot =
      p.merkle_root === null || p.merkle_root === undefined
        ? null
        : typeof p.merkle_root === "string" &&
            p.merkle_root.length === 64 &&
            HEX_RE.test(p.merkle_root)
          ? p.merkle_root
          : undefined;
    if (merkleRoot === undefined) {
      throw new SiwsError(400, "merkle_root must be 64 hex chars");
    }
    const status =
      typeof p.status === "string" && STATUSES.has(p.status) ? p.status : null;
    if (!status) throw new SiwsError(400, "Unknown payout status");
    const paymentMint =
      p.payment_mint === null || p.payment_mint === undefined || p.payment_mint === ""
        ? null
        : typeof p.payment_mint === "string" && BASE58_RE.test(p.payment_mint.trim())
          ? p.payment_mint.trim()
          : undefined;
    if (paymentMint === undefined) {
      throw new SiwsError(400, "payment_mint must be a base58 address");
    }
    const paymentDecimals =
      typeof p.payment_decimals === "number" &&
      Number.isInteger(p.payment_decimals) &&
      p.payment_decimals >= 0 &&
      p.payment_decimals <= 12
        ? p.payment_decimals
        : null;
    if (paymentDecimals === null) {
      throw new SiwsError(400, "payment_decimals must be an integer 0–12");
    }
    const notes =
      typeof p.notes === "string" ? p.notes.slice(0, 2000) : "";

    // Recipients.
    const rawRecipients = params.recipients;
    if (!Array.isArray(rawRecipients) || rawRecipients.length === 0) {
      throw new SiwsError(400, "recipients must be a non-empty array");
    }
    if (rawRecipients.length > MAX_RECIPIENTS) {
      throw new SiwsError(400, `Too many recipients (max ${MAX_RECIPIENTS})`);
    }
    const recipients = rawRecipients.map((r, i) => {
      if (!isPlainObject(r)) {
        throw new SiwsError(400, `Recipient ${i}: not an object`);
      }
      const w = typeof r.wallet === "string" ? r.wallet.trim() : "";
      if (!BASE58_RE.test(w)) {
        throw new SiwsError(400, `Recipient ${i}: invalid wallet`);
      }
      const shares =
        typeof r.shares === "number" && Number.isFinite(r.shares) && r.shares > 0
          ? r.shares
          : null;
      if (shares === null) {
        throw new SiwsError(400, `Recipient ${i}: invalid shares`);
      }
      const amount =
        typeof r.amount === "number" && Number.isFinite(r.amount) && r.amount >= 0
          ? r.amount
          : null;
      if (amount === null) {
        throw new SiwsError(400, `Recipient ${i}: invalid amount`);
      }
      const merkleIndex =
        typeof r.merkle_index === "number" && Number.isInteger(r.merkle_index)
          ? r.merkle_index
          : null;
      if (merkleIndex === null) {
        throw new SiwsError(400, `Recipient ${i}: invalid merkle_index`);
      }
      const proof = Array.isArray(r.merkle_proof) ? r.merkle_proof : null;
      if (
        proof === null ||
        proof.length > 64 ||
        !proof.every((h) => typeof h === "string" && h.length === 64 && HEX_RE.test(h))
      ) {
        throw new SiwsError(400, `Recipient ${i}: invalid merkle_proof`);
      }
      return {
        wallet: w,
        shares,
        amount,
        merkle_index: merkleIndex,
        merkle_proof: proof as string[],
        claimed: false,
      };
    });

    const sb = getSupabaseAdmin();
    const { data: payout, error: payoutErr } = await sb
      .from("payouts")
      .insert({
        asset_mint: assetMint,
        asset_label: assetLabel || assetMint.slice(0, 8),
        kind,
        total_amount: totalAmount,
        currency,
        per_share: perShare,
        snapshot_source: snapshotSource,
        holder_count: recipients.length,
        total_shares: totalShares,
        merkle_root: merkleRoot,
        merkle_built_at: merkleRoot ? new Date().toISOString() : null,
        status,
        payment_mint: paymentMint,
        payment_decimals: paymentDecimals,
        notes,
        author: wallet,
      })
      .select("id")
      .single();
    if (payoutErr || !payout) {
      console.error("[api/payouts/create] payout insert failed:", payoutErr?.message);
      throw new SiwsError(500, "Payout insert failed");
    }

    // Supabase has a 1000-row insert cap — chunk.
    const CHUNK = 500;
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const { error: rcpErr } = await sb.from("payout_recipients").insert(
        recipients.slice(i, i + CHUNK).map((r) => ({
          ...r,
          payout_id: payout.id,
        })),
      );
      if (rcpErr) {
        console.error("[api/payouts/create] recipients insert failed:", rcpErr.message);
        // Best-effort rollback so no half-created drop survives.
        await sb.from("payout_recipients").delete().eq("payout_id", payout.id);
        await sb.from("payouts").delete().eq("id", payout.id);
        throw new SiwsError(500, "Recipient insert failed — payout rolled back");
      }
    }

    return NextResponse.json({ ok: true, data: { id: payout.id as string } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
