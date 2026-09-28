// SERVER-ONLY — a rate limit shared by every serverless instance (front-app-15).
//
// The per-instance limiters (app/api/clients/_helpers.ts rateLimited and the
// route-local Maps) count each Vercel instance separately, so spreading
// requests over instances multiplies them. This one counts in the database,
// through the existing sliding-window function consume_account_rate_limit
// (migration 0052: sha256 key, at most 100 hits per window of up to a day),
// so no migration is needed. Keys are hashed before they leave the process.
//
// It is a SECOND layer: routes keep their in-memory burst limit in front of
// it (cheap, no database round trip for a flood from one instance). When the
// database cannot answer, the result is "unavailable" and the caller goes on
// under its in-memory limit: every route that uses this writes to the same
// database next, so an outage fails the request there anyway, and a
// transient limiter error must not refuse a KYC submission. (Email sign-in
// keeps its own fail-closed DB caps: lib/server/account-profile.ts.)

import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export type SharedLimit = "ok" | "limited" | "unavailable";

const TIMEOUT_MS = 3_000;
let lastWarning = -Infinity;

export async function consumeSharedRateLimit(
  key: string, limit: number, windowSeconds: number, sb?: SupabaseClient,
): Promise<SharedLimit> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86_400) {
    throw new Error("Invalid shared rate limit");
  }
  try {
    const { data, error } = await (sb ?? getSupabaseAdmin()).rpc("consume_account_rate_limit", {
      p_key_hash: createHash("sha256").update(`shared:${key}`).digest("hex"), p_limit: limit, p_window_seconds: windowSeconds,
    }).abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error || typeof data !== "boolean") throw new Error("unavailable");
    return data ? "ok" : "limited";
  } catch {
    // At most once a minute per instance; never the key (it holds an IP or a wallet).
    if (Date.now() - lastWarning > 60_000) {
      lastWarning = Date.now();
      console.warn("[rate-limit] shared limiter unavailable; the per-instance limit still applies");
    }
    return "unavailable";
  }
}
