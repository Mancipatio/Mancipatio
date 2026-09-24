// GET /api/priority-fee — the clamped compute-unit price wallet sends use on
// this deployment's network (lib/server/priority-fee.ts). No parameters, so
// nothing user-controlled reaches the RPC provider and the CDN key is fixed;
// the CDN may share an answer for a few seconds and browsers never store it.
// Read-only: it stays available during maintenance. The browser clamps the
// value again (lib/priority-fee) and uses the floor when this is unavailable.
//
// Body: { ok: true, network, microLamports: "<u64 decimal>", source, level }.

import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { readPriorityFee } from "@/lib/server/priority-fee";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHARED_CACHE = "public, max-age=0, s-maxage=5, stale-while-revalidate=10";

export async function GET() {
  try {
    const network = detectNetwork();
    const reading = await readPriorityFee(network);
    return NextResponse.json(
      {
        ok: true,
        network: reading.network,
        microLamports: reading.microLamports.toString(),
        source: reading.source,
        level: reading.level,
      },
      { headers: { "Cache-Control": SHARED_CACHE } },
    );
  } catch {
    // Only an invalid network setting reaches here; the browser uses its floor.
    return NextResponse.json(
      { ok: false, error: "Priority fee unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
