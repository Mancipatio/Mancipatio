// GET /api/maintenance — public maintenance flag of this deployment's network.
// Polled by the banner (lib/maintenance-client.ts) and read fresh before every
// wallet transaction (lib/verified-solana-client.ts). Never cached: operators
// expect a switch to reach open pages within one poll.

import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { getMaintenance } from "@/lib/server/maintenance";
import type { MaintenanceState } from "@/lib/maintenance";

export const dynamic = "force-dynamic";

export async function GET() {
  const network = detectNetwork();
  const { enabled, message } = await getMaintenance(network);
  const body: MaintenanceState = { enabled, message, network };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
