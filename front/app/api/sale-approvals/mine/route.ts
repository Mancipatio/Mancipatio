// POST /api/sale-approvals/mine — the issuer's view of its live sale
// approvals ("saleApprovals.mine"; a wallet session may authorize it).
// The chain is the source of truth for WHICH approvals exist (the launchpad
// lists them by memcmp); this adds what only the ledger knows: the linked
// application (for the listing) and the committed cliff / vesting terms.
// Gate: the signer is the issuer's on-chain authority. Params: issuer.

import { NextResponse } from "next/server";
import { fetchMaybeIssuer, ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { getServerRpc } from "@/lib/server/rpc";
import { detectNetwork } from "@/lib/network";
import { addressParam } from "@/lib/server/sale-capacity";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "saleApprovals.mine");
    const issuer = addressParam(params.issuer, "issuer");
    let authority: string | null = null;
    try {
      const account = await fetchMaybeIssuer(getServerRpc(), issuer, { commitment: "confirmed", abortSignal: AbortSignal.timeout(12_000) });
      if (account.exists && account.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS) authority = account.data.authority;
    } catch (err) {
      console.error("[api/sale-approvals/mine] RPC failure:", err);
      throw new SiwsError(503, "On-chain check unavailable — try again");
    }
    if (authority !== wallet) throw new SiwsError(403, "Only the issuer's authority may read its approvals");
    const { data, error } = await getSupabaseAdmin().from("sale_capacity_reservations")
      .select("approval_pda,share_class_pda,sale_id,application_id,application_hash,application_snapshot,status,raise_type,expires_at")
      .eq("network", detectNetwork()).eq("kind", "sale").eq("issuer_pda", issuer)
      .in("status", ["reserved", "consumed"]).order("created_at", { ascending: false }).limit(100);
    if (error) throw new SiwsError(503, "Could not load your approvals");
    const rows = (data ?? []).map((row) => {
      const snapshot = (row.application_snapshot ?? {}) as Record<string, unknown>;
      const months = (v: unknown) => (typeof v === "string" && /^\d{1,3}$/.test(v) ? Number(v) : null);
      return {
        approval_pda: row.approval_pda, share_class_pda: row.share_class_pda, sale_id: String(row.sale_id),
        application_id: row.application_id, application_hash: row.application_hash, status: row.status,
        raise_type: row.raise_type, expires_at: row.expires_at,
        company_name: typeof snapshot.company_name === "string" ? snapshot.company_name : null,
        cliff_months: months(snapshot.cliff_months), vesting_months: months(snapshot.vesting_months),
      };
    });
    return NextResponse.json({ ok: true, data: rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
