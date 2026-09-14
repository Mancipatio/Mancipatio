// POST /api/passport/status — minimal open-request probe for the portfolio
// passport card.
//
// UNSIGNED on purpose (same rationale + rate-limit pattern as
// /api/applications/eligibility): the card renders on page load and demanding
// a wallet signature just to show "application under review" would be a
// popup on every /portfolio visit. RLS cannot scope an anon SELECT to "own
// wallet" (the anon key carries no identity), so instead of the old
// table-wide anon read this endpoint returns ONLY the newest UNDECIDED
// request's { id, status, created_at } — no jurisdiction, no note, no
// registry, no handled_by, no decided history. The full queue is admin-only
// via the signed /api/passport/list.

import { NextResponse } from "next/server";
import { siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------------------------------------------------------------------------
// Best-effort per-IP rate limit — without one, an unsigned endpoint that
// answers "does wallet X have an open KYC application?" could be swept across
// many wallets. Same trusted-header logic as /api/applications/eligibility.
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
        ? (body as { wallet: string }).wallet.trim()
        : "";
    if (!BASE58_RE.test(wallet)) {
      throw new SiwsError(400, "wallet must be a base58 address");
    }

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("passport_requests")
      .select("id, status, created_at")
      .eq("wallet", wallet)
      .in("status", ["new", "in_review"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      console.error("[api/passport/status] query failed:", error.message);
      throw new SiwsError(500, "Could not check passport request status");
    }

    return NextResponse.json({ ok: true, data: { open: data?.[0] ?? null } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
