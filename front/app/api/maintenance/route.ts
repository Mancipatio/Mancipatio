// GET /api/maintenance — public maintenance flag of this deployment's network.
// Polled by the banner (lib/maintenance-client.ts) and read before wallet
// prompts (lib/maintenance.ts). Every open tab polls, so the CDN may share an
// answer for a few seconds (s-maxage=5, then at most 5 s stale while it
// revalidates); browsers never store it, and `?fresh=` readers (issuer
// recovery) get their own cache key. When the flag cannot be read this
// answers 503 uncached instead of guessing, and the page keeps the last state
// it knew.

import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { readMaintenance } from "@/lib/server/maintenance";
import type { MaintenanceState } from "@/lib/maintenance";

export const dynamic = "force-dynamic";

const SHARED_CACHE = "public, max-age=0, s-maxage=5, stale-while-revalidate=5";

export async function GET() {
  const network = detectNetwork();
  const { enabled, message, fresh } = await readMaintenance(network);
  if (!fresh) {
    return NextResponse.json(
      { ok: false, error: "Maintenance status is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
    );
  }
  const body: MaintenanceState = { enabled, message, network };
  return NextResponse.json(body, { headers: { "Cache-Control": SHARED_CACHE } });
}
