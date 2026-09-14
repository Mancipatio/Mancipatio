"use client";

// Wallet-level Terms-of-Service acceptance check (P1 item 3c).
//
// Backs the <TosGate /> interstitial mounted in the marketplace + portfolio
// layouts: a connected wallet that has not accepted the CURRENT ToS version
// gets a blocking modal until it signs an acceptance via the signed
// /api/tos/accept route (W2-SD1). Acceptance rows live in tos_acceptances
// (wallet, version) — migration 0029 made client_id nullable so wallet-only
// rows (no onboarding) are possible.
//
// tos_acceptances has no anon SELECT (migration 0036); the read goes through
// the minimal unsigned /api/tos/status route (per-wallet boolean, no bulk
// enumeration) and the WRITE through the signed /api/tos/accept route.

import { TOS_VERSION } from "@/lib/clients";

// Re-export so gate consumers do not need to reach into lib/clients.ts.
export { TOS_VERSION };

/**
 * Tri-state check result:
 *  - "accepted"      — a tos_acceptances row exists for (wallet, TOS_VERSION)
 *  - "not_accepted"  — the query succeeded and found nothing → gate blocks
 *  - "unknown"       — Supabase unconfigured/unreachable → gate ALLOWS (fail
 *                      open, logged) per spec: availability over enforcement
 *                      for a client-side interstitial.
 */
export type TosCheckResult = "accepted" | "not_accepted" | "unknown";

type CacheEntry = { result: TosCheckResult; at: number };

// Module-level cache: "accepted" is sticky for the session (a version never
// un-accepts); negative/unknown results are re-checked after a short TTL.
const cache = new Map<string, CacheEntry>();
const NEGATIVE_TTL_MS = 60_000;

function cacheKey(wallet: string): string {
  return `${wallet}:${TOS_VERSION}`;
}

/** Check whether `wallet` has accepted the current ToS version (cached). */
export async function hasAcceptedTos(wallet: string): Promise<TosCheckResult> {
  const key = cacheKey(wallet);
  const hit = cache.get(key);
  if (hit) {
    if (hit.result === "accepted") return "accepted";
    if (Date.now() - hit.at < NEGATIVE_TTL_MS) return hit.result;
  }

  try {
    const res = await fetch("/api/tos/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, version: TOS_VERSION }),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: { accepted?: boolean } }
      | null;
    if (!res.ok || !json || json.ok !== true || !json.data) {
      // Unreachable/misconfigured → fail open (availability over enforcement
      // for a client-side interstitial), same as before.
      return "unknown";
    }
    const result: TosCheckResult = json.data.accepted
      ? "accepted"
      : "not_accepted";
    cache.set(key, { result, at: Date.now() });
    return result;
  } catch (err) {
    console.warn("[tos] acceptance check threw:", err);
    return "unknown";
  }
}

/**
 * Mark a wallet as accepted in the local cache (call after a successful
 * /api/tos/accept) so the gate closes without a re-fetch.
 */
export function markTosAccepted(wallet: string): void {
  cache.set(cacheKey(wallet), { result: "accepted", at: Date.now() });
}
