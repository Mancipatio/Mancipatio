// GET /api/health — deployment health for uptime monitors. 200 when no check
// fails, 503 otherwise (lib/server/health.ts). Anonymous callers get only
// {ok, network, checkedAt}, which the CDN may share for a few seconds so a
// flood is absorbed at the edge. With `Authorization: Bearer <HEALTH_TOKEN>`
// the full per-check report is returned, never cached. Neither form contains
// request data or personal information.

import { NextResponse } from "next/server";
import { healthDetailsAuthorized, readHealth, summarizeHealth } from "@/lib/server/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Requests carrying Authorization are never served from or stored in the
// shared cache; Vary keeps any other cache from mixing the two forms.
const PUBLIC_HEADERS = { "Cache-Control": "public, max-age=0, s-maxage=5", Vary: "Authorization", "X-Robots-Tag": "noindex" };
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", Vary: "Authorization", "X-Robots-Tag": "noindex" };

export async function GET(request: Request) {
  const detailed = healthDetailsAuthorized(request.headers.get("authorization"));
  try {
    const report = await readHealth();
    const status = report.ok ? 200 : 503;
    return detailed
      ? NextResponse.json(report, { status, headers: PRIVATE_HEADERS })
      : NextResponse.json(summarizeHealth(report), { status, headers: PUBLIC_HEADERS });
  } catch {
    // Only an invalid network setting reaches here; report it without detail.
    return NextResponse.json({ ok: false, error: "Health check unavailable" }, { status: 503, headers: PRIVATE_HEADERS });
  }
}
