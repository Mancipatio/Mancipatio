// POST /api/spvs/record-issuance — an OFF-CHAIN adjustment of an SPV's EUR 3M
// rolling ledger ("spvs.record_issuance", signed; Talas 5.1).
//
// Every on-chain issuance is booked by the server: a closed sale and a
// treasury mint through the ledger jobs (migration 0073, the retry worker).
// This route records only what the chain cannot show, with a reason code:
//   off_platform_issuance | correction | legacy_import
// and a note of at least 10 characters. It can never name a sale: sale_pubkey
// is refused, and an asset_pda that is an on-chain sale is refused by the
// ledger (REF_IS_SALE). When the asset already has server bookings in the
// last 12 months the route answers 409 POSSIBLE_DUPLICATE with them (date,
// amount, source) unless the admin confirms (confirm_not_duplicate: true).
//
// Authorization tiers:
//   * cap_override or an issued_at more than 30 days back -> requireSuperAdmin
//   * otherwise                                            -> requireAdmin
//
// Written by 0073 record_spv_adjustment under the ledger's subject lock: it
// must fit the rolling 12-month capacity including live reservations, and a
// subject on hold takes none without the override. The audit row is written
// by the server (writeServerAudit), attributed to the verified signer.
// Client wrapper: recordIssuance() in lib/spvs.ts.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin, requireSuperAdmin } from "@/lib/server/admin-gate";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { capacityError } from "@/lib/server/sale-capacity";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REASON_CODES = new Set(["off_platform_issuance", "correction", "legacy_import"]);

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(
      request,
      "spvs.record_issuance",
    );

    // Sale proceeds are booked by the server (0073 ledger jobs). An old
    // client that still sends source 'sale' gets a clear answer.
    if (params.source !== undefined && params.source !== "manual") {
      throw new SiwsError(
        410,
        "Sale issuances are booked by the server from the chain; nothing to record here",
      );
    }
    if (typeof params.sale_pubkey === "string" && params.sale_pubkey.trim()) {
      throw new SiwsError(400, "A manual adjustment cannot name a sale: sales are booked by the server when they close.");
    }

    const capOverride = params.cap_override === true;
    const spvId = typeof params.spv_id === "string" ? params.spv_id.trim() : "";
    if (!UUID_RE.test(spvId)) throw new SiwsError(400, "spv_id must be a UUID");

    const amountEur = typeof params.amount_eur === "number" ? params.amount_eur : NaN;
    if (!Number.isFinite(amountEur) || amountEur <= 0) {
      throw new SiwsError(400, "amount_eur must be a positive number");
    }

    const assetPda = typeof params.asset_pda === "string" ? params.asset_pda.trim() : "";
    if (assetPda.length > 64) throw new SiwsError(400, "asset_pda too long");

    const reasonCode = typeof params.reason_code === "string" ? params.reason_code : "";
    if (!REASON_CODES.has(reasonCode)) {
      throw new SiwsError(400, "reason_code must be off_platform_issuance, correction or legacy_import");
    }
    const note = typeof params.note === "string" ? params.note.trim() : "";
    if (note.length < 10) throw new SiwsError(400, "A note of at least 10 characters is required");
    if (note.length > 2000) throw new SiwsError(400, "note too long (≤2000 chars)");

    const today = new Date().toISOString().slice(0, 10);
    const issuedAt = typeof params.issued_at === "string" && params.issued_at.trim() ? params.issued_at.trim() : today;
    if (!DATE_RE.test(issuedAt) || Number.isNaN(Date.parse(`${issuedAt}T00:00:00Z`))) {
      throw new SiwsError(400, "issued_at must be YYYY-MM-DD");
    }
    const backdated = Date.parse(`${issuedAt}T00:00:00Z`) < Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000;

    // ---- Authorization (see header) ----
    if (capOverride || backdated) await requireSuperAdmin(wallet);
    else await requireAdmin(wallet);

    const sb = getSupabaseAdmin();

    // Server bookings of this asset in the window: possibly the same issuance.
    if (assetPda && params.confirm_not_duplicate !== true) {
      const since = new Date(Date.now() - 366 * 86_400_000).toISOString().slice(0, 10);
      const { data: bookings, error: bookingsError } = await sb.from("spv_issuances")
        .select("issued_at,amount_eur,source")
        .eq("spv_id", spvId).eq("asset_pda", assetPda).in("source", ["sale", "treasury_mint"])
        .gte("issued_at", since).order("issued_at", { ascending: false }).limit(20);
      if (bookingsError) throw new SiwsError(503, "The issuance ledger is unavailable; nothing was changed.");
      if (Array.isArray(bookings) && bookings.length) {
        return NextResponse.json({
          ok: false,
          code: "POSSIBLE_DUPLICATE",
          error: "Possible duplicate: this asset already has server bookings in the last 12 months. Confirm that this adjustment is a different issuance.",
          data: { bookings },
        }, { status: 409 });
      }
    }

    const { data, error } = await sb.rpc("record_spv_adjustment", {
      p_spv_id: spvId,
      p_amount_eur: amountEur,
      p_asset_pda: assetPda || null,
      p_issued_at: issuedAt,
      p_reason_code: reasonCode,
      p_note: note,
      p_recorded_by: wallet,
      p_cap_override: capOverride,
      p_allow_backdate: backdated,
    });
    if (error) {
      // The trigger's cap message is surfaced verbatim ("SPV annual issuance
      // cap exceeded: …"); the ledger's own refusals are mapped.
      if (/annual issuance cap/i.test(error.message ?? "")) throw new SiwsError(409, error.message);
      if (error.code === "P0001") throw capacityError(error);
      console.error("[api/spvs/record-issuance] insert failed:", error.code);
      throw new SiwsError(500, "Issuance insert failed");
    }

    // The row is written: an audit failure must not invite a second submit.
    await writeServerAudit(sb, {
      ix_name: "spv_adjustment",
      category: "platform",
      actor_wallet: wallet,
      actor_source: actorSourceOf(via),
      reason: `${reasonCode}: ${note}`.slice(0, 1000),
      target_label: spvId,
      metadata: {
        spv_id: spvId, amount_eur: amountEur, issued_at: issuedAt, reason_code: reasonCode,
        asset_pda: assetPda || null, cap_override: capOverride, backdated,
        confirmed_not_duplicate: params.confirm_not_duplicate === true,
        issuance_id: (data as { id?: unknown } | null)?.id ?? null,
      },
    }).catch(() => console.error("[api/spvs/record-issuance] audit row not written"));

    return NextResponse.json({
      ok: true,
      data: { spv_id: spvId, amount_eur: amountEur, issued_at: issuedAt, reason_code: reasonCode },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
