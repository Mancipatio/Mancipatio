"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!url || !anonKey) return null;
  if (cached) return cached;
  cached = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export type AuditCategory =
  | "platform"
  | "admins"
  | "issuers"
  | "assets"
  | "share-class"
  | "launchpad"
  | "custody"
  | "otc"
  | "governance"
  | "rights"
  /** Server-only: KYC data access and GDPR actions (lib/server/audit.ts). */
  | "kyc"
  /** Server-only: sanctions screening records and their evidence (lib/server/screening-evidence.ts). */
  | "compliance"
  /** Server-only: operator records the server verified on chain (document anchors, lib/document-anchor.ts). */
  | "operator"
  | "other";

export type AuditStatus = "success" | "failed" | "pending";

export type AuditEvent = {
  id: string;
  created_at: string;
  network: string;
  ix_name: string;
  category: AuditCategory;
  actor_wallet: string;
  target_label: string | null;
  tx_signature: string | null;
  reason: string;
  status: AuditStatus;
  metadata: Record<string, unknown>;
};

export type AuditInput = {
  ix_name: string;
  category: AuditCategory;
  actor_wallet: string;
  reason: string;
  target_label?: string;
  tx_signature?: string;
  status?: AuditStatus;
  metadata?: Record<string, unknown>;
};

/** Waits before each retry of a rate-limited (429) audit write; a breadcrumb is never dropped on the first 429. */
export const AUDIT_RETRY_DELAYS_MS = [2_000, 10_000];

/** A keepalive request's body is capped (64 KiB for all of a page's in flight together); larger rows are sent without it. */
export const AUDIT_KEEPALIVE_MAX_BYTES = 32 * 1024;

export type RecordAuditOptions = {
  /**
   * `keepalive`: the request outlives the page (a tab closed right after a
   * send still delivers its audit row). Only for a body of at most
   * AUDIT_KEEPALIVE_MAX_BYTES; a larger one is sent as usual.
   */
  keepalive?: boolean;
  /** Each attempt (the POST and its answer) is given up after this long: a write never hangs. */
  timeoutMs?: number;
};

/**
 * Fire-and-forget audit log write.
 *
 * Never throws — admin actions must not break if the backend is unreachable.
 * Returns the new row's id, or null on failure (also when the row may have
 * been inserted but its answer was lost: the route has no idempotency key).
 * A 429 (the shared audit limit, app/api/audit/route.ts) is retried after
 * each of `retryDelaysMs` before the row is given up and logged.
 *
 * Internals: POSTs to /api/audit, which inserts server-side via the service
 * role (stamping metadata.server_received_at) — the anon-key write path to
 * audit_events is gone. The exported signature is unchanged (`options` is
 * optional).
 */
export async function recordAudit(
  input: AuditInput,
  retryDelaysMs: readonly number[] = AUDIT_RETRY_DELAYS_MS,
  options: RecordAuditOptions = {},
): Promise<string | null> {
  try {
    const body = JSON.stringify({
      ix_name: input.ix_name,
      category: input.category,
      actor_wallet: input.actor_wallet,
      target_label: input.target_label ?? null,
      tx_signature: input.tx_signature ?? null,
      reason: input.reason,
      status: input.status ?? "success",
      metadata: input.metadata ?? {},
    });
    const keepalive = options.keepalive === true && new TextEncoder().encode(body).byteLength <= AUDIT_KEEPALIVE_MAX_BYTES;
    const post = () => {
      // One timeout per attempt; it also ends reading that attempt's answer (res.json below).
      const signal = options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
      return fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        ...(keepalive ? { keepalive: true } : {}),
        ...(signal ? { signal } : {}),
      });
    };
    let res = await post();
    for (const delay of retryDelaysMs) {
      if (res.status !== 429) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      res = await post();
    }
    type Envelope = { ok?: boolean; data?: { id?: string | null }; error?: string };
    let json: Envelope | null = null;
    try {
      json = (await res.json()) as Envelope;
    } catch {
      // Non-JSON response — treated as failure below.
    }
    if (!res.ok || !json || json.ok !== true) {
      console.warn("[audit] write failed:", json?.error ?? `HTTP ${res.status}`);
      return null;
    }
    return json.data?.id ?? null;
  } catch (err) {
    console.warn(
      "[audit] write threw:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
