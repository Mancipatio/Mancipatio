"use client";

import type { WalletSession } from "@solana/client";
import { signedFetch } from "@/lib/siws-client";

export type AlertSeverity = "low" | "medium" | "high" | "critical";
export type AlertStatus = "open" | "dismissed" | "escalated" | "resolved";

export type ComplianceAlert = {
  id: string;
  created_at: string;
  updated_at: string;
  network: string;
  client_id: string | null;
  wallet: string | null;
  source: string;
  severity: AlertSeverity;
  confidence: number;
  hit_list: string;
  evidence: Record<string, unknown>;
  summary: string;
  status: AlertStatus;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  tx_signature: string | null;
};

/**
 * Admin-only alert list via the signed route (POST /api/compliance/list).
 * AML/sanctions rows are regulated data — they are NOT anon-readable, so the
 * read requires a connected admin wallet (one signature per refresh, same as
 * listFees). Throws on failure (rejected signature, 403, transport) so
 * callers can distinguish "no alerts" from "load failed".
 */
export async function listAlerts(
  session: WalletSession | null | undefined,
): Promise<ComplianceAlert[]> {
  const data = await signedFetch<{ alerts: ComplianceAlert[] }>(
    session,
    "/api/compliance/list",
    "compliance.list",
    {},
  );
  return data.alerts ?? [];
}

/**
 * Raise an alert via the signed admin route (POST /api/compliance/create).
 * `network` is stamped server-side. Throws on failure (unchanged contract).
 */
export async function createAlert(
  session: WalletSession | null | undefined,
  input: Omit<
    ComplianceAlert,
    "id" | "created_at" | "updated_at" | "network" | "status" | "resolution_note" | "resolved_by" | "resolved_at"
  >,
): Promise<void> {
  await signedFetch(session, "/api/compliance/create", "compliance.create", {
    client_id: input.client_id,
    wallet: input.wallet,
    source: input.source,
    severity: input.severity,
    confidence: input.confidence,
    hit_list: input.hit_list,
    evidence: input.evidence,
    summary: input.summary,
    tx_signature: input.tx_signature,
  });
}

/**
 * Resolve/dismiss/escalate an alert via the signed admin route
 * (POST /api/compliance/resolve). The server stamps resolved_by with the
 * VERIFIED signer wallet and resolved_at with its own clock — `resolvedBy`
 * is kept for call-site compatibility but is informational only.
 * Throws on failure (unchanged contract).
 */
export async function resolveAlert(
  session: WalletSession | null | undefined,
  id: string,
  status: AlertStatus,
  note: string,
  resolvedBy: string,
): Promise<void> {
  await signedFetch(session, "/api/compliance/resolve", "compliance.resolve", {
    id,
    status,
    note,
    resolved_by_hint: resolvedBy,
  });
}
