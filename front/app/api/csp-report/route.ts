// POST /api/csp-report — where browsers send Content-Security-Policy
// violation reports while the policy is report-only (next.config.ts). Each
// violation becomes one log line (directive, blocked origin, page path:
// lib/server/csp-report.ts), readable in the Vercel runtime logs and any log
// drain; nothing is stored. Always 204 for a well-formed request: browsers
// do not retry, and an attacker learns nothing. Bounded: 16 KiB per body,
// a per-instance cap per IP, at most 10 violations per body.

import { clientIpOf, ipRateLimitKey, rateLimited } from "@/app/api/clients/_helpers";
import { boundedRequest } from "@/lib/server/bounded-request";
import { summarizeCspReport } from "@/lib/server/csp-report";
import { SiwsError } from "@/lib/server/siws";

export const runtime = "nodejs";

const BODY_LIMIT = 16 * 1024;
const NO_CONTENT = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  if (rateLimited(`csp-report:${ipRateLimitKey(clientIpOf(request))}`, 30, 60_000)) return NO_CONTENT();
  let text: string;
  try {
    text = await (await boundedRequest(request, BODY_LIMIT)).text();
  } catch (error) {
    return error instanceof SiwsError && error.status === 413 ? new Response(null, { status: 413 }) : NO_CONTENT();
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NO_CONTENT();
  }
  for (const violation of summarizeCspReport(body)) console.warn(`[csp] ${JSON.stringify(violation)}`);
  return NO_CONTENT();
}
