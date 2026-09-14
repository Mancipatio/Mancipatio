// Rebuild all 14 existing mirror types from one complete finalized snapshot.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { reconcileAllIndexerAccounts } from "@/lib/server/indexer-sync";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "admin.reconcile");
    await requireAdmin(wallet);
    return NextResponse.json({ ok: true, data: await reconcileAllIndexerAccounts(Date.now() + 45_000, request.signal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return siwsErrorResponse(error); }
}
