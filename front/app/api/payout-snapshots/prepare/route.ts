import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/admin-gate";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { prepareOriginalPayoutSnapshot } from "@/lib/server/payout-snapshots";
export const maxDuration = 30;
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length")) > 1_000_000) throw new SiwsError(413, "Snapshot request is too large");
    if (!request.body) throw new SiwsError(400, "Missing snapshot request");
    const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 1_000_000) throw new SiwsError(413, "Snapshot request is too large");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const copy = new Request(request.url, { method: "POST", headers: request.headers, body: bytes, signal: request.signal });
    const { wallet, params } = await verifySigned(copy.clone(), "payout-snapshots.prepare");
    await requireAdmin(wallet);
    const body = await copy.json();
    return NextResponse.json({ ok: true, data: await prepareOriginalPayoutSnapshot(wallet, params, body.snapshot_rows) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return siwsErrorResponse(error); }
}
