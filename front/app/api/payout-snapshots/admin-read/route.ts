import { NextResponse } from "next/server";
import { address } from "@solana/kit";
import { requireAdmin } from "@/lib/server/admin-gate";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { canonicalPayoutSnapshot } from "@/lib/payout-snapshots";
import { detectNetwork } from "@/lib/network";
export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "payout-snapshots.adminRead"); await requireAdmin(wallet);
    let target: string; try { target = address(String(params.target_pda)).toString(); } catch { throw new SiwsError(400, "Invalid payout vault address"); }
    if (params.snapshot_id !== undefined) {
      if (typeof params.snapshot_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(params.snapshot_id)) throw new SiwsError(400, "Invalid snapshot id");
      const sb = getSupabaseAdmin();
      const snapshot = await sb.from("payout_snapshot_metadata").select("id,entry_count,rows_hash,root_hex,total_weight").eq("network", detectNetwork()).eq("target_pda", target).eq("id", params.snapshot_id).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
      if (snapshot.error) throw new SiwsError(503, "Snapshot review unavailable");
      if (!snapshot.data) throw new SiwsError(404, "Snapshot not found on this network");
      const entries: { wallet: string; weight: string }[] = [];
      for (let from = 0; from < 5000; from += 1000) {
        const page = await sb.from("payout_snapshot_proofs").select("wallet,weight").eq("snapshot_id", params.snapshot_id).order("wallet", { ascending: true }).range(from, from + 999).abortSignal(AbortSignal.timeout(10_000));
        if (page.error || !page.data) throw new SiwsError(503, "Original snapshot entries unavailable");
        entries.push(...page.data.map((e) => ({ wallet: String(e.wallet), weight: String(e.weight) })));
        if (page.data.length < 1000) break;
      }
      const canonical = await canonicalPayoutSnapshot(entries);
      if (canonical.count !== snapshot.data.entry_count || canonical.rows_hash !== snapshot.data.rows_hash || canonical.root_hex !== snapshot.data.root_hex || canonical.total_weight !== snapshot.data.total_weight) throw new SiwsError(503, "Original snapshot entries failed integrity verification");
      return NextResponse.json({ ok: true, data: { entries } }, { headers: { "Cache-Control": "no-store" } });
    }
    const { data, error } = await getSupabaseAdmin().from("payout_snapshot_metadata").select("*").eq("network", detectNetwork()).eq("target_pda", target).order("created_at", { ascending: false }).limit(100).abortSignal(AbortSignal.timeout(10_000));
    if (error) throw new SiwsError(503, "Snapshot review unavailable");
    return NextResponse.json({ ok: true, data: { snapshots: data ?? [] } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return siwsErrorResponse(error); }
}
