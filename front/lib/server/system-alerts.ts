// SERVER-ONLY — system alerts (migration 0072): the one writer
// (raise_system_alert), incidents with hysteresis (report_incident) and the
// email outbox (one digest per alarm-worker run).
//
// Privacy (design §8.5): a system alert never names a wallet or a client
// (the SQL functions have no such parameter), so it never blocks passport
// issuance. Emails carry no evidence, wallets or amounts: every row shows a
// fixed label, its severity and its time; only PLATFORM-format sources (the
// protocol's own authorities, pause, treasury, upgrades and operational
// incidents) add the summary and an explorer link. Issuer-, holder- and
// ledger-related rows are MINIMAL: label and time only. Decode (IDL drift)
// alerts are always minimal: the matched instruction may be about a holder.
//
// Delivery is at-least-once: a send that timed out may still have gone
// through, and its rows are sent again in the next digest.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectNetwork, explorerTxUrl, type Network } from "@/lib/network";
import { emailConfigured, escapeHtml, sendEmail } from "@/lib/server/email";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export type Severity = "low" | "medium" | "high" | "critical";
export type AlertCategory = "onchain" | "indexer" | "worker" | "ledger" | "fx";
export const SEVERITIES: readonly Severity[] = ["low", "medium", "high", "critical"];
export const severityRank = (s: string) => SEVERITIES.indexOf(s as Severity);

/** Fixed email labels. Anything not listed is "System alert", minimal. */
export const SOURCE_LABELS: Record<string, { label: string; format: "platform" | "minimal" }> = {
  "onchain:pause": { label: "Platform pause flags changed", format: "platform" },
  "onchain:treasury": { label: "Protocol treasury changed", format: "platform" },
  "onchain:platform-admin": { label: "Super admin transfer", format: "platform" },
  "onchain:admin-record": { label: "Admin added or removed", format: "platform" },
  "onchain:custody-authority": { label: "Custody authority transfer", format: "platform" },
  "onchain:blocklist-authority": { label: "Blocklist authority change", format: "platform" },
  "onchain:hook-config": { label: "Transfer hook configuration changed", format: "platform" },
  "onchain:kyc-registry": { label: "KYC registry change", format: "platform" },
  "onchain:program-upgrade": { label: "Program upgrade authority action", format: "platform" },
  "onchain:issuer-permissions": { label: "Issuer permissions changed", format: "minimal" },
  "onchain:issuer-kyb": { label: "Issuer KYB decision", format: "minimal" },
  "onchain:issuer-authority": { label: "Issuer authority transfer", format: "minimal" },
  "onchain:issuer-recovery": { label: "Issuer key recovery", format: "minimal" },
  "onchain:clawback": { label: "Holder clawback", format: "minimal" },
  "onchain:kyc-reclaim": { label: "KYC entry rent reclaimed", format: "minimal" },
  "onchain:decode": { label: "Event layout mismatch (IDL drift)", format: "minimal" },
  "indexer:queue-lag": { label: "Indexer queue is lagging", format: "platform" },
  "indexer:degraded": { label: "Indexer is degraded", format: "platform" },
  "indexer:gap": { label: "Transactions missing from the index", format: "platform" },
  "indexer:gap-scan-incomplete": { label: "Gap scan could not read the whole window", format: "platform" },
  "worker:event-queue": { label: "Alarm queue is lagging", format: "platform" },
  "worker:event-invalid": { label: "Alarm jobs could not be verified", format: "platform" },
  "worker:retry-heartbeat": { label: "Retry worker is not completing runs", format: "platform" },
  "worker:test": { label: "Test alert", format: "platform" },
  "ledger:queue-lag": { label: "Raise-cap ledger queue is lagging", format: "platform" },
  "ledger:capacity-holds": { label: "Raise limits on hold", format: "platform" },
  "fx:missing": { label: "EUR rate missing for an on-chain fact", format: "platform" },
  "fx:stale": { label: "EUR rate out of date", format: "platform" },
};

export function sourceLabel(source: string) {
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  if (source.startsWith("ledger:")) return { label: "Raise-cap ledger alert", format: "minimal" as const };
  return { label: "System alert", format: "minimal" as const };
}

const SOURCE_RE = /^[a-z]+:[a-z0-9-]{1,50}$/;
const DEDUP_RE = /^(onchain|ledger|incident|test):[A-Za-z0-9:._-]{1,200}$/;

export type SystemAlertInput = {
  network?: Network;
  dedupKey: string;
  category: AlertCategory;
  source: string;
  severity: Severity;
  summary: string;
  evidence: Record<string, unknown>;
  txSignature?: string | null;
  notify?: boolean;
};

function dbSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(8_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Idempotent on (network, dedupKey). Throws on a database error (callers
 * that must not fail catch it; the alarm jobs retry). */
export async function raiseSystemAlert(sb: SupabaseClient, input: SystemAlertInput, signal?: AbortSignal) {
  if (!DEDUP_RE.test(input.dedupKey) || !SOURCE_RE.test(input.source)) throw new Error("Invalid system alert");
  const { data, error } = await sb.rpc("raise_system_alert", {
    p_network: input.network ?? detectNetwork(),
    p_dedup_key: input.dedupKey,
    p_category: input.category,
    p_source: input.source,
    p_severity: input.severity,
    p_summary: input.summary.slice(0, 500) || input.source,
    p_evidence: input.evidence,
    p_tx_signature: input.txSignature ?? null,
    p_notify: input.notify ?? true,
  }).abortSignal(dbSignal(signal));
  if (error) throw new Error(`System alert unavailable (${error.code ?? "error"})`);
  return (data ?? { id: null, inserted: false }) as { id: string | null; inserted: boolean };
}

export type IncidentState = "fail" | "hold" | "pass";
export type IncidentInput = {
  network?: Network;
  check: string;
  state: IncidentState;
  category: AlertCategory;
  source: string;
  severity: Severity;
  summary: string;
  evidence?: Record<string, unknown>;
  notify?: boolean;
};

export async function reportIncident(sb: SupabaseClient, input: IncidentInput, signal?: AbortSignal) {
  const { data, error } = await sb.rpc("report_incident", {
    p_network: input.network ?? detectNetwork(),
    p_check: input.check,
    p_state: input.state,
    p_category: input.category,
    p_source: input.source,
    p_severity: input.severity,
    p_summary: input.summary.slice(0, 500) || input.check,
    p_evidence: input.evidence ?? {},
    p_notify: input.notify ?? true,
  }).abortSignal(dbSignal(signal));
  if (error) throw new Error(`Incident report unavailable (${error.code ?? "error"})`);
  return (data ?? { action: "unknown", alert_id: null }) as { action: string; alert_id: string | null };
}

// ── Email outbox ─────────────────────────────────────────────────────────

const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
export const MAX_RECIPIENTS = 5;
export const DIGEST_LIMIT = 25;
/** Below this, a digest is not started (it would be abandoned). */
export const MIN_SEND_MS = 4_000;

/** COMPLIANCE_ALERT_EMAIL: comma-separated, at most 5, each validated. Null when unset or invalid. */
export function alertRecipients(value = process.env.COMPLIANCE_ALERT_EMAIL): string[] | null {
  const list = (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!list.length || list.length > MAX_RECIPIENTS || !list.every((v) => EMAIL_RE.test(v))) return null;
  return [...new Set(list)];
}

export type DigestRow = {
  id: string;
  created_at: string;
  source: string;
  severity: string;
  summary: string | null;
  tx_signature: string | null;
  category: string | null;
};

function siteOrigin(): string | null {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "");
    return url.protocol === "https:" || url.hostname === "localhost" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Pure: the digest's subject and HTML. Never evidence, wallets or amounts. */
export function alertDigest(rows: readonly DigestRow[], network: Network, origin: string | null = siteOrigin()) {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.severity, (counts.get(r.severity) ?? 0) + 1);
  const summary = [...SEVERITIES].reverse().filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${s}`).join(", ");
  const subject = `[Manci ${network}] ${summary || "no alerts"}`;
  const items = rows.map((r) => {
    const { label, format } = sourceLabel(r.source);
    const when = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    let line = `<strong>${escapeHtml(r.severity.toUpperCase())}</strong> — ${escapeHtml(label)} — ${escapeHtml(when)}`;
    if (format === "platform") {
      if (r.summary) line += `<br/>${escapeHtml(r.summary)}`;
      if (r.tx_signature && /^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(r.tx_signature)) {
        line += `<br/><a href="${escapeHtml(explorerTxUrl(r.tx_signature, network))}">Transaction</a>`;
      }
    }
    return `<li style="margin-bottom:8px">${line}</li>`;
  });
  const footer = origin
    ? `<p>Review them at <a href="${escapeHtml(`${origin}/admin/compliance`)}">${escapeHtml(`${origin}/admin/compliance`)}</a>.</p>`
    : "<p>Review them on the Compliance page of the admin console.</p>";
  const html = `<p>${rows.length} new Manci ${escapeHtml(network)} alert${rows.length === 1 ? "" : "s"}:</p><ul>${items.join("")}</ul>${footer}`;
  return { subject, html };
}

export type NotifyResult =
  | { status: "not_configured" | "none" | "deferred" }
  | { status: "sent" | "failed"; count: number; error?: "SEND_FAILED" | "SEND_TIMEOUT" };

/**
 * One digest of the due pending alerts (at most 25), within `deadlineMs`.
 * No recipients or no transport: NOT_CONFIGURED, rows stay pending. Never
 * selects evidence.
 */
export async function notifyPendingAlerts(deadlineMs: number, signal?: AbortSignal, sb: SupabaseClient = getSupabaseAdmin()): Promise<NotifyResult> {
  const recipients = alertRecipients();
  if (!recipients || !emailConfigured()) return { status: "not_configured" };
  if (deadlineMs - Date.now() < MIN_SEND_MS) return { status: "deferred" };
  const network = detectNetwork();
  const { data, error } = await sb.from("compliance_alerts")
    .select("id,created_at,source,severity,summary,tx_signature,category")
    .eq("network", network).eq("notify_state", "pending").lte("next_notify_at", new Date().toISOString())
    .order("next_notify_at").limit(DIGEST_LIMIT).abortSignal(dbSignal(signal));
  if (error) throw new Error("Alert outbox unavailable");
  const rows = (data ?? []) as DigestRow[];
  if (!rows.length) return { status: "none" };
  const remaining = deadlineMs - Date.now();
  if (remaining < MIN_SEND_MS) return { status: "deferred" };
  const { subject, html } = alertDigest(rows, network);
  const sent = await sendEmail({ to: recipients, subject, html, redactErrors: true, timeoutMs: Math.min(8_000, remaining - 500) });
  const code = sent.sent ? null : sent.error === "TIMEOUT" ? "SEND_TIMEOUT" : "SEND_FAILED";
  const finish = await sb.rpc("finish_alert_notifications", {
    p_network: network,
    p_rows: rows.map((r) => ({ id: r.id, severity: r.severity })),
    p_sent: sent.sent,
    p_error: code,
  }).abortSignal(AbortSignal.timeout(3_000));
  if (finish.error) console.error("[alarms] outbox update failed");
  return sent.sent ? { status: "sent", count: rows.length } : { status: "failed", count: rows.length, error: code as "SEND_FAILED" | "SEND_TIMEOUT" };
}
