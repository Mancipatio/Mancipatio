// POST /api/conversion/admin-list — admin read of the conversion queue.
// Signed + requireAdmin (same stance as /api/compliance/list): the table has
// no anon SELECT because rows carry holder contact details (PII), so the
// custody admin page loads the queue through this route. Optional `vault_pda`
// filter (2D: the custody reclaim gate reads a vault's linked requests without
// paging the whole queue, which PostgREST caps at 1000 rows).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { vaultPdaFilter } from "@/lib/server/admin-list-filter";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "conversion.adminList");
    await requireAdmin(wallet);
    const vaultPda = vaultPdaFilter(params.vault_pda);

    const sb = getSupabaseAdmin();
    let q = sb
      .from("conversion_requests")
      .select("*")
      .eq("network", detectNetwork())
      .order("created_at", { ascending: false });
    if (vaultPda) q = q.eq("vault_pda", vaultPda);
    const { data, error } = await q;
    if (error) {
      console.error("[api/conversion/admin-list] query failed:", error.message);
      throw new SiwsError(500, "Could not load conversion requests");
    }

    return NextResponse.json({ ok: true, data: { requests: data ?? [] } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
