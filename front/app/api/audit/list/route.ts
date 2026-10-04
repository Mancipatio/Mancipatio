import { NextResponse } from "next/server";
import { verifySigned, SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { isReconciledAuditRow } from "@/lib/server/reconciled-audit";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

// Each row carries chain_checked, computed here: whether it is the retry worker's chain-checked row
// (lib/server/reconciled-audit — its id, actor and actor_source, none of which the unsigned /api/audit
// lets a caller write). Readers use that flag, never the row's metadata (lib/audit-feed).
export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "audit.list");
    await requireAdmin(wallet);
    const page = params.page ?? 0;
    if (!Number.isSafeInteger(page) || Number(page) < 0 || Number(page) > 20_000) throw new SiwsError(400, "Invalid page");
    const network = detectNetwork();
    const { data, error } = await getSupabaseAdmin().from("audit_events")
      .select("id,created_at,ix_name,category,actor_wallet,target_label,tx_signature,reason,status,metadata")
      .eq("network", network).order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(Number(page) * 50, Number(page) * 50 + 49);
    if (error) throw new SiwsError(503, "Audit log unavailable — try again");
    const rows = (data ?? []).map((row) => ({ ...row, chain_checked: isReconciledAuditRow(network, row) }));
    return NextResponse.json({ ok: true, data: rows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) { return siwsErrorResponse(err); }
}
