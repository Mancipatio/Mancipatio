// POST /api/sale-approvals/settle — GONE (Talas 5.1, D11).
//
// Closed sales are booked by the server alone: the indexer mirror enqueues a
// ledger job when a sale closes (migration 0073) and the retry worker books
// it from the FINALIZED chain at the proven close date. A browser nudge could
// only race that. Kept for one release so an old client gets a clear answer;
// delete it in the next one.

import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { ok: false, error: "Sales are booked by the server when they close; nothing to settle here" },
    { status: 410, headers: { "Cache-Control": "private, no-store" } },
  );
}
