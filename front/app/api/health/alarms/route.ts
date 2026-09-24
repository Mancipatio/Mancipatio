// GET /api/health/alarms — the alarm dead-man switch for an external uptime
// monitor (Talas 4.4b, D10). Anonymous: {ok, network, checkedAt}, 200 or 503.
// What ok requires: lib/server/alarm-health.ts. Cached 10 s per instance.

import { NextResponse } from "next/server";
import { readAlarmHealth } from "@/lib/server/alarm-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const report = await readAlarmHealth();
    return NextResponse.json(
      { ok: report.ok, network: report.network, checkedAt: report.checkedAt },
      { status: report.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
