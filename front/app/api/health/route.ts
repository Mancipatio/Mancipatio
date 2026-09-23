// GET /api/health — deployment health for uptime monitors. 200 {ok:true} when
// no check fails, 503 {ok:false} otherwise; each check carries its own status
// and a fixed reason code (lib/server/health.ts). Never cached by the CDN or
// the browser, and never contains request data or personal information.

import { NextResponse } from "next/server";
import { readHealth } from "@/lib/server/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store, max-age=0", "X-Robots-Tag": "noindex" };

export async function GET() {
  try {
    const report = await readHealth();
    return NextResponse.json(report, { status: report.ok ? 200 : 503, headers: HEADERS });
  } catch {
    // Only an invalid network setting reaches here; report it without detail.
    return NextResponse.json({ ok: false, error: "Health check unavailable" }, { status: 503, headers: HEADERS });
  }
}
