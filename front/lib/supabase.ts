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

/**
 * Fire-and-forget audit log write.
 *
 * Never throws — admin actions must not break if the backend is unreachable.
 * Returns the new row's id, or null on failure. A 429 (the shared audit
 * limit, app/api/audit/route.ts) is retried after each of `retryDelaysMs`
 * before the row is given up and logged.
 *
 * Internals: POSTs to /api/audit, which inserts server-side via the service
 * role (stamping metadata.server_received_at) — the anon-key write path to
 * audit_events is gone. The exported signature is unchanged.
 */
export async function recordAudit(input: AuditInput, retryDelaysMs: readonly number[] = AUDIT_RETRY_DELAYS_MS): Promise<string | null> {
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
    const post = () => fetch("/api/audit", { method: "POST", headers: { "Content-Type": "application/json" }, body });
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
