// POST /api/applications/eligibility — read-only apply-gate check for /apply.
//
// UNSIGNED on purpose: the /apply page needs to know whether the connected
// wallet may submit BEFORE the founder fills the wizard, and demanding a
// wallet signature just to render the gate would be a popup on page load.
// It exposes only { hasClient, kycStatus, eligible } — no PII from the
// clients row — and stays correct after W3-RLS locks the clients table to
// the service role (the browser can no longer read clients directly).
//
// The authoritative gate lives in the signed submit/resubmit routes
// (requireVerifiedClient); this endpoint is UX only.

import { NextResponse } from "next/server";
import { siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { lookupClientKyc } from "../_lib";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------------------------------------------------------------------------
// Best-effort rate limit — the endpoint is unsigned and returns a wallet's KYC
// status for ANY wallet param, so without a throttle a caller could enumerate
// verified/rejected/suspended status across many wallets. Cap per client IP
// (trusted source: x-real-ip, else the RIGHTMOST — non-spoofable — XFF hop; the
// LEFTMOST token is attacker-controlled). Per-instance memory, documented.
// ---------------------------------------------------------------------------
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const hits = new Map<string, number[]>();

function clientIp(request: Request): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return "unknown";
}

function rateLimited(ip: string, now: number): boolean {
  const windowStart = now - RATE_WINDOW_MS;
  const prev = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  if (prev.length >= RATE_MAX) {
    hits.set(ip, prev);
    return true;
  }
  prev.push(now);
  hits.set(ip, prev);
  if (hits.size > 10_000) {
    const oldest = hits.keys().next().value;
    if (oldest !== undefined) hits.delete(oldest);
  }
  return false;
}

export async function POST(request: Request) {
  try {
    if (rateLimited(clientIp(request), Date.now())) {
      throw new SiwsError(429, "Too many requests — slow down");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new SiwsError(400, "Invalid JSON body");
    }
    const wallet =
      typeof (body as { wallet?: unknown })?.wallet === "string"
        ? ((body as { wallet: string }).wallet).trim()
        : "";
    if (!BASE58_RE.test(wallet)) {
      throw new SiwsError(400, "wallet must be a base58 address");
    }

    const kyc = await lookupClientKyc(getSupabaseAdmin(), wallet);
    return NextResponse.json({ ok: true, data: kyc });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
