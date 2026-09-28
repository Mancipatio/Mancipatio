// SERVER-ONLY — system alerts (migration 0072): the one writer
// (raise_system_alert), incidents with hysteresis (report_incident) and the
// outbox (one digest per alarm-worker run, over two channels).
//
// Privacy (design §8.5): a system alert never names a wallet or a client
// (the SQL functions have no such parameter), so it never blocks passport
// issuance. Emails carry no evidence, wallets or amounts: every row shows a
// fixed label, its severity and its time; only PLATFORM-format sources (the
// protocol's own authorities, pause, treasury, upgrades and operational
// incidents) add the summary and an explorer link. Issuer-, holder- and
// ledger-related rows are MINIMAL: label and time only. Decode (IDL drift)
// alerts are always minimal: the matched instruction may be about a holder.
// The webhook payload follows the same rules, row for row.
//
// Channels (ops-qa-2): email (COMPLIANCE_ALERT_EMAIL + an SMTP/Resend
// transport) and a generic JSON webhook (ALERT_WEBHOOK_URL, see
// alertWebhook). Both are sent in parallel under the same deadline; one
// channel failing or hanging never stops the other. A row is marked sent
// when at least one channel delivered it; rows no channel delivered back off
// (finish_alert_notifications).
//
// So one dead channel is NOT visible on /api/health/alarms: the other
// channel delivers the rows (nothing gets stuck), and the alarm worker's
// heartbeat moved before notify. Each channel's outcome is therefore an
// incident of its own (alert-channel-email, alert-channel-webhook: high,
// reportAlertChannels): a failing channel opens it, and the OTHER channel
// delivers that alert in the next digest; it clears after three digests the
// channel delivered. Only when every channel fails do rows stay pending, and
// /api/health/alarms goes red (notify_pending:stuck).
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
  "onchain:vault-vote": { label: "Payout vault vote opened", format: "minimal" },
  "onchain:yield-route": { label: "Yield routed into a payout vault", format: "minimal" },
  "onchain:milestone": { label: "Rights milestone published", format: "minimal" },
  "onchain:proposal": { label: "Governance proposal created", format: "minimal" },
  "onchain:supply-lock": { label: "Share class supply locked", format: "minimal" },
  "onchain:custody-vault": { label: "Custody vault action", format: "minimal" },
  "onchain:sale-approval": { label: "Sale approved", format: "minimal" },
  "indexer:queue-lag": { label: "Indexer queue is lagging", format: "platform" },
  "indexer:degraded": { label: "Indexer is degraded", format: "platform" },
  "indexer:gap": { label: "Transactions missing from the index", format: "platform" },
  "indexer:gap-scan-incomplete": { label: "Gap scan could not read the whole window", format: "platform" },
  "indexer:gap-scan-overdue": { label: "Gap scan is not running", format: "platform" },
  "worker:event-queue": { label: "Alarm queue is lagging", format: "platform" },
  "worker:event-invalid": { label: "Alarm jobs could not be verified", format: "platform" },
  "worker:retry-heartbeat": { label: "Retry worker is not completing runs", format: "platform" },
  "worker:test": { label: "Test alert", format: "platform" },
  "ledger:queue-lag": { label: "Raise-cap ledger queue is lagging", format: "platform" },
  "ledger:capacity-holds": { label: "Raise limits on hold", format: "platform" },
  "fx:missing": { label: "EUR rate missing for an on-chain fact", format: "platform" },
  "fx:stale": { label: "EUR rate out of date", format: "platform" },
  "fx:expiring": { label: "EUR rate about to expire", format: "platform" },
  "onchain:low-balance": { label: "Operational key low on SOL", format: "platform" },
  "onchain:squads-config": { label: "Squads multisig configuration changed", format: "platform" },
  "onchain:squads-proposal": { label: "Squads multisig proposal open", format: "platform" },
  "worker:ops-watch-config": { label: "Alarm watch configuration invalid", format: "platform" },
  "worker:alert-channel": { label: "Alert channel failing", format: "platform" },
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

function digestSubject(rows: readonly DigestRow[], network: Network) {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.severity, (counts.get(r.severity) ?? 0) + 1);
  const summary = [...SEVERITIES].reverse().filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${s}`).join(", ");
  return `[Manci ${network}] ${summary || "no alerts"}`;
}

const TX_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const utcTime = (at: string) => new Date(at).toISOString().replace("T", " ").slice(0, 19) + " UTC";

/** Pure: the digest's subject and HTML. Never evidence, wallets or amounts. */
export function alertDigest(rows: readonly DigestRow[], network: Network, origin: string | null = siteOrigin()) {
  const subject = digestSubject(rows, network);
  const items = rows.map((r) => {
    const { label, format } = sourceLabel(r.source);
    const when = utcTime(r.created_at);
    let line = `<strong>${escapeHtml(r.severity.toUpperCase())}</strong> — ${escapeHtml(label)} — ${escapeHtml(when)}`;
    if (format === "platform") {
      if (r.summary) line += `<br/>${escapeHtml(r.summary)}`;
      if (r.tx_signature && TX_RE.test(r.tx_signature)) {
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

// ── Webhook channel ──────────────────────────────────────────────────────

/**
 * The second alert channel (ops-qa-2): one JSON POST per digest.
 *
 *   ALERT_WEBHOOK_URL           https URL (http only for localhost); unset = off
 *   ALERT_WEBHOOK_TOKEN         optional; sent as `Authorization: Bearer …`
 *   ALERT_WEBHOOK_MIN_SEVERITY  medium | high | critical (default high); rows
 *                               below it go by email only. Without a
 *                               configured email channel the webhook gets
 *                               every row the outbox sends (never low).
 *   ALERT_WEBHOOK_FORMAT        json (default) | text
 *
 * json: the body (alertWebhookPayload) carries `text`, `title` and
 * `priority` (1–5) for ntfy templates
 * (`https://ntfy.sh/<topic>?tpl=yes&t={{.title}}&m={{.text}}&p={{.priority}}`),
 * and the structured `severity`, `network`, `count`, `alerts[]` and
 * `review_url` a relay (Telegram bot proxy, PagerDuty/Opsgenie bridge) can
 * map. text: the body is `{"text": …}` and nothing else, for chat incoming
 * webhooks that refuse unknown fields (Google Chat) or read `priority` as
 * something else (Mattermost); use it for Slack too. Anything 2xx counts as
 * delivered. The URL and token are secrets: never logged.
 */
export type WebhookFormat = "json" | "text";
export type AlertWebhook = { url: string; token: string | null; minSeverity: Severity; format: WebhookFormat };

export const WEBHOOK_MIN_SEVERITY_DEFAULT: Severity = "high";

/** The configured webhook, null when unset; `invalid` when set but unusable. */
export function alertWebhookConfig(env: Record<string, string | undefined> = process.env): AlertWebhook | null | "invalid" {
  const raw = env.ALERT_WEBHOOK_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid";
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (raw.length > 2048 || !(url.protocol === "https:" || (url.protocol === "http:" && local))) return "invalid";
  const token = env.ALERT_WEBHOOK_TOKEN?.trim() || null;
  if (token && (token.length > 4096 || /\s/.test(token))) return "invalid";
  const min = env.ALERT_WEBHOOK_MIN_SEVERITY?.trim().toLowerCase() || WEBHOOK_MIN_SEVERITY_DEFAULT;
  if (min !== "medium" && min !== "high" && min !== "critical") return "invalid";
  const format = env.ALERT_WEBHOOK_FORMAT?.trim().toLowerCase() || "json";
  if (format !== "json" && format !== "text") return "invalid";
  return { url: url.toString(), token, minSeverity: min, format };
}

/** The usable webhook, or null (unset or invalid: /api/health/alarms reports an invalid one). */
export function alertWebhook(env: Record<string, string | undefined> = process.env): AlertWebhook | null {
  const config = alertWebhookConfig(env);
  return config === "invalid" ? null : config;
}

/** ntfy-style priority (1..5) of the most severe row. */
const PRIORITY: Record<Severity, number> = { low: 2, medium: 3, high: 4, critical: 5 };

/** Pure: the webhook body for one digest (json format). The same privacy rules as the email. */
export function alertWebhookPayload(rows: readonly DigestRow[], network: Network, origin: string | null = siteOrigin()) {
  const title = digestSubject(rows, network);
  const top = [...SEVERITIES].reverse().find((s) => rows.some((r) => r.severity === s)) ?? "low";
  const reviewUrl = origin ? `${origin}/admin/compliance` : null;
  const alerts = rows.map((r) => {
    const { label, format } = sourceLabel(r.source);
    const alert: Record<string, string> = { id: r.id, severity: r.severity, label, created_at: new Date(r.created_at).toISOString() };
    if (format === "platform") {
      if (r.summary) alert.summary = r.summary;
      if (r.tx_signature && TX_RE.test(r.tx_signature)) alert.tx_url = explorerTxUrl(r.tx_signature, network);
    }
    return alert;
  });
  const lines = alerts.map((a) => `${a.severity.toUpperCase()} — ${a.label} — ${utcTime(a.created_at)}${a.summary ? `: ${a.summary}` : ""}`);
  const text = [title, ...lines, reviewUrl ? `Review: ${reviewUrl}` : "Review them on the Compliance page of the admin console."].join("\n");
  return { text, title, severity: top, priority: PRIORITY[top], network, count: rows.length, alerts, review_url: reviewUrl };
}

/** Pure: the body a webhook of this format receives. */
export function alertWebhookBody(format: WebhookFormat, rows: readonly DigestRow[], network: Network, origin: string | null = siteOrigin()) {
  const payload = alertWebhookPayload(rows, network, origin);
  return format === "text" ? { text: payload.text } : payload;
}

/** One POST; never throws, never logs the URL, the token or the response body. */
export async function sendAlertWebhook(
  webhook: AlertWebhook, payload: ReturnType<typeof alertWebhookBody>, timeoutMs: number,
): Promise<{ sent: boolean; error?: "WEBHOOK_FAILED" | "WEBHOOK_TIMEOUT" }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { sent: false, error: "WEBHOOK_TIMEOUT" };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(webhook.token ? { Authorization: `Bearer ${webhook.token}` } : {}),
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal,
    });
    await response.body?.cancel().catch(() => {});
    if (response.ok) return { sent: true };
    console.error(`[alarms] webhook answered HTTP ${response.status}`);
    return { sent: false, error: "WEBHOOK_FAILED" };
  } catch {
    const timedOut = signal.aborted;
    console.error(`[alarms] webhook ${timedOut ? "timed out" : "request failed"}`);
    return { sent: false, error: timedOut ? "WEBHOOK_TIMEOUT" : "WEBHOOK_FAILED" };
  }
}

// ── The outbox ───────────────────────────────────────────────────────────

export type ChannelOutcome = "sent" | "failed" | "timeout" | "skipped" | "not_configured";
type Channel = "email" | "webhook";

/** Each channel's own incident (see the header): a dead channel is otherwise invisible. */
export const CHANNEL_INCIDENTS: Readonly<Record<Channel, string>> = {
  email: "alert-channel-email",
  webhook: "alert-channel-webhook",
};
const CHANNEL_REPORT_TIMEOUT_MS = 2_000;

/**
 * The outcome of each channel in one digest, as its incident: failed or
 * timed out is fail (high), delivered or no longer configured is pass; a
 * channel that had no row to send (skipped) says nothing. Never throws.
 */
export async function reportAlertChannels(
  sb: SupabaseClient, network: Network, channels: Record<Channel, ChannelOutcome>, count: number,
): Promise<void> {
  const names: Record<Channel, string> = { email: "email", webhook: "webhook (ALERT_WEBHOOK_URL)" };
  const reports = (Object.keys(CHANNEL_INCIDENTS) as Channel[]).flatMap((channel) => {
    const outcome = channels[channel];
    if (outcome === "skipped") return [];
    const failing = outcome === "failed" || outcome === "timeout";
    const other = channels[channel === "email" ? "webhook" : "email"];
    const summary = failing
      ? `The ${names[channel]} alert channel ${outcome === "timeout" ? "timed out" : "failed"} on a digest of ${count} alert(s); `
        + (other === "sent" ? "the other channel delivered it. Fix the channel: alerts reach one channel only" : "no other channel delivered it")
      : `The ${names[channel]} alert channel ${outcome === "sent" ? "delivered a digest" : "is not configured"}`;
    return [reportIncident(sb, {
      network, check: CHANNEL_INCIDENTS[channel], state: failing ? "fail" : "pass", category: "worker", source: "worker:alert-channel",
      severity: "high", summary, evidence: { channel, outcome, alerts: count },
    }, AbortSignal.timeout(CHANNEL_REPORT_TIMEOUT_MS))];
  });
  const results = await Promise.allSettled(reports);
  if (results.some((r) => r.status === "rejected")) console.error("[alarms] alert channel incident not recorded");
}
type SendError = "SEND_FAILED" | "SEND_TIMEOUT" | "WEBHOOK_FAILED" | "WEBHOOK_TIMEOUT";

export type NotifyResult =
  | { status: "not_configured" | "none" | "deferred" }
  | {
    status: "sent" | "failed";
    count: number;
    /** The first failing channel's code (email first). */
    error?: SendError;
    channels: { email: ChannelOutcome; webhook: ChannelOutcome };
  };

/**
 * One digest of the due pending alerts (at most 25; critical and high first),
 * within `deadlineMs`, over every configured channel in parallel.
 * No channel configured: NOT_CONFIGURED, rows stay pending. Never selects
 * evidence. "sent" only when every channel that had rows delivered them.
 * Each channel's outcome is also reported as its incident (reportAlertChannels).
 */
export async function notifyPendingAlerts(deadlineMs: number, signal?: AbortSignal, sb: SupabaseClient = getSupabaseAdmin()): Promise<NotifyResult> {
  const recipients = alertRecipients();
  const email = recipients !== null && emailConfigured();
  const webhook = alertWebhook();
  if (!email && !webhook) return { status: "not_configured" };
  if (deadlineMs - Date.now() < MIN_SEND_MS) return { status: "deferred" };
  const network = detectNetwork();
  // Critical and high first, then the rest of the slots: a flood of older
  // medium rows (bootstrap, backfill, SMTP recovery) never delays a new
  // critical alert behind it.
  const due = new Date().toISOString();
  const read = (severities: readonly string[], limit: number) => sb.from("compliance_alerts")
    .select("id,created_at,source,severity,summary,tx_signature,category")
    .eq("network", network).eq("notify_state", "pending").lte("next_notify_at", due).in("severity", [...severities])
    .order("next_notify_at").limit(limit).abortSignal(dbSignal(signal));
  const urgent = await read(["critical", "high"], DIGEST_LIMIT);
  if (urgent.error) throw new Error("Alert outbox unavailable");
  const rows = [...((urgent.data ?? []) as DigestRow[])];
  if (rows.length < DIGEST_LIMIT) {
    const rest = await read(["medium", "low"], DIGEST_LIMIT - rows.length);
    if (rest.error) throw new Error("Alert outbox unavailable");
    rows.push(...((rest.data ?? []) as DigestRow[]));
  }
  if (!rows.length) return { status: "none" };
  const remaining = deadlineMs - Date.now();
  if (remaining < MIN_SEND_MS) return { status: "deferred" };
  const timeoutMs = Math.min(8_000, remaining - 500);

  // Without email, the webhook is the only channel: it takes every row.
  const hookRows = webhook
    ? (email ? rows.filter((r) => severityRank(r.severity) >= severityRank(webhook.minSeverity)) : rows)
    : [];
  const [mailResult, hookResult] = await Promise.allSettled([
    email
      ? (() => {
        const { subject, html } = alertDigest(rows, network);
        return sendEmail({ to: recipients!, subject, html, redactErrors: true, timeoutMs });
      })()
      : Promise.resolve(null),
    webhook && hookRows.length ? sendAlertWebhook(webhook, alertWebhookBody(webhook.format, hookRows, network), timeoutMs) : Promise.resolve(null),
  ]);
  const mail = mailResult.status === "fulfilled" ? mailResult.value : { sent: false, error: "FAILED" };
  const hook = hookResult.status === "fulfilled" ? hookResult.value : { sent: false, error: "WEBHOOK_FAILED" as const };
  const mailError: SendError | null = !mail || mail.sent ? null : mail.error === "TIMEOUT" ? "SEND_TIMEOUT" : "SEND_FAILED";
  const hookError: SendError | null = !hook || hook.sent ? null : hook.error ?? "WEBHOOK_FAILED";
  const outcome = (configured: boolean, result: { sent: boolean } | null, error: SendError | null): ChannelOutcome =>
    !configured ? "not_configured" : !result ? "skipped" : result.sent ? "sent" : error?.endsWith("TIMEOUT") ? "timeout" : "failed";
  const channels = { email: outcome(email, mail, mailError), webhook: outcome(webhook !== null, hook, hookError) };

  const delivered = new Set<string>();
  if (mail?.sent) rows.forEach((r) => delivered.add(r.id));
  if (hook?.sent) hookRows.forEach((r) => delivered.add(r.id));
  const error = mailError ?? hookError;
  const finish = async (list: DigestRow[], sent: boolean) => {
    if (!list.length) return;
    const result = await sb.rpc("finish_alert_notifications", {
      p_network: network,
      p_rows: list.map((r) => ({ id: r.id, severity: r.severity })),
      p_sent: sent,
      p_error: sent ? null : error ?? "SEND_FAILED",
    }).abortSignal(AbortSignal.timeout(3_000));
    if (result.error) console.error("[alarms] outbox update failed");
  };
  // In parallel with the outbox update: within the same few seconds.
  const channelIncidents = reportAlertChannels(sb, network, channels, rows.length);
  await finish(rows.filter((r) => delivered.has(r.id)), true);
  await finish(rows.filter((r) => !delivered.has(r.id)), false);
  await channelIncidents;
  return error
    ? { status: "failed", count: rows.length, error, channels }
    : { status: "sent", count: rows.length, channels };
}
