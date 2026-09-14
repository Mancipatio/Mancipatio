import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { reconcileIndexerJobs } from "@/lib/server/indexer-sync";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "admin.retryIndexer");
    await requireAdmin(wallet);
    const limit = params.limit ?? 10;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new SiwsError(400, "Provide a retry limit from 1 to 20");
    return NextResponse.json({ ok: true, data: await reconcileIndexerJobs(limit, Date.now() + 20_000, request.signal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return siwsErrorResponse(error); }
}
