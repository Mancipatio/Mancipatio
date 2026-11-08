// SERVER-ONLY — transactional notifications: one email per event and
// recipient, at most once, never in the way of the route that caused it.
//
// notifyHolder() / notifyOperator() are the generic entry points (the first
// user is lib/server/conversion-notifications.ts); deliverNotification() is
// what both run:
//   1. claim the key (kind, ref_id, event, recipient_role) in
//      notification_log (migration 0088, claim_notification). Only the call
//      that inserted the row sends: a retried route, a double click or a
//      concurrent recording finds the row and sends nothing ("duplicate").
//      When the claim cannot be made (0088 not applied yet, the database
//      unreachable) nothing is sent ("unavailable"): no claim, no email, so
//      a later retry can never double-send.
//   2. resolve the recipient (below) and compose the message, only for a
//      claimed key;
//   3. send through lib/server/email.ts under a hard deadline
//      (NOTIFICATION_SEND_TIMEOUT_MS) with redacted errors;
//   4. record the outcome once (finish_notification): sent, failed or
//      skipped, with an error CLASS only. A failed send is not retried: the
//      log shows it to operators, and the holder still sees the status on the
//      page. Delivery is therefore at most once per key; a send that timed
//      out may still have gone through, and it is recorded as failed.
// Nothing here throws: every failure ends as a recorded outcome or a short
// log line without addresses, ids or provider messages.
//
// Timing: routes call afterResponse(), which hands the work to Next's
// after() (on Vercel, waitUntil): the status write and the response come
// first, and the email never delays or fails them. Each step has its own
// time budget, so the work ends long before the route's maxDuration.
//
// Recipients. The holder's address is resolved from what the platform has
// verified, in this order, and only the address is read:
//   account   the email of the account the wallet belongs to
//             (account_wallets → account_profiles), only once its owner
//             confirmed it (email_verified_at); the address the holder
//             chose for messages about requests (Privacy Policy §4);
//   dossier   the email of the verified client dossier the request was
//             filed under (conversion_requests.client_id → clients.email,
//             the address the KYC verdict emails already use), never any
//             other dossier field;
//   contact   the contact the holder typed on the request, only when it is
//             one plain email address (it is free text: "email or phone").
// Each is checked against a strict single-address pattern, so a list or a
// header fragment typed into a field can never add recipients. The operator
// recipient is COMPLIANCE_ALERT_EMAIL (validated by
// lib/server/system-alerts.ts alertRecipients): the operational mailbox
// ops/env-vars.md requires on mainnet, read by the same team that handles
// the KYC and sanctions side of a conversion.
//
// Content is the caller's: a message builder receives only the facts it
// needs and must never carry KYC data (names, documents, dates of birth,
// verification status), wallets or the holder's contact details.

import "server-only";

import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectNetwork } from "@/lib/network";
import { emailConfigured, sendEmail, type SendEmailResult } from "@/lib/server/email";
import { alertRecipients } from "@/lib/server/system-alerts";
import { withTimeout } from "@/lib/server/with-timeout";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export type RecipientRole = "holder" | "operator";
/** Which kind of address was used (stored in notification_log; never the address). */
export type RecipientSource = "account" | "dossier" | "contact" | "config";

export type NotificationKey = {
  /** What the notification is about, e.g. "conversion". */
  kind: string;
  /** The id of that record (a conversion request's uuid). */
  refId: string;
  /** The event of that record, e.g. "deposited". */
  event: string;
  role: RecipientRole;
};

export type NotificationMessage = { subject: string; html: string };
export type NotificationRecipient = { to: string | string[]; source: RecipientSource };

/**
 * sent / failed / skipped: this call owned the key and recorded the outcome;
 * duplicate: the key was claimed before, nothing sent; unavailable: the
 * claim could not be made, nothing sent.
 */
export type NotificationOutcome = "sent" | "failed" | "skipped" | "duplicate" | "unavailable";

/** The error classes notification_log.error stores (^[A-Z_]{1,40}$), never a provider message. */
export type NotificationErrorClass =
  | "NO_RECIPIENT"
  | "NOT_CONFIGURED"
  | "RESERVED_DOMAIN"
  | "TIMEOUT"
  | "REJECTED"
  | "TRANSPORT"
  | "RESOLVE_FAILED"
  | "MESSAGE_FAILED";

/** The send's hard deadline (lib/server/email.ts timeoutMs). */
export const NOTIFICATION_SEND_TIMEOUT_MS = 8_000;
/** Each database step: the claim, the recipient lookup, the outcome. */
export const NOTIFICATION_DB_TIMEOUT_MS = 4_000;

const KEY_PART_RE = /^[a-z][a-z0-9_]{0,39}$/;
const REF_RE = /^[A-Za-z0-9_-]{1,100}$/;
/** One plain address: no display name, list, spaces or header characters (the same pattern as COMPLIANCE_ALERT_EMAIL). */
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;

/** True for exactly one plain email address of at most 254 characters. */
export function isSingleEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value);
}

/** The error class of an unsent email (lib/server/email.ts reasons, redacted). */
export function sendFailureClass(result: SendEmailResult): { status: "failed" | "skipped"; error: NotificationErrorClass } {
  const reason = result.error ?? "";
  if (reason === "TIMEOUT") return { status: "failed", error: "TIMEOUT" };
  if (reason === "Reserved recipient domain") return { status: "skipped", error: "RESERVED_DOMAIN" };
  if (/not configured/i.test(reason)) return { status: "skipped", error: "NOT_CONFIGURED" };
  if (/^HTTP 4\d\d\b/.test(reason)) return { status: "failed", error: "REJECTED" };
  return { status: "failed", error: "TRANSPORT" };
}

/** A short label for logs: kind, event and role, never the ref id or an address. */
const label = (key: NotificationKey) => `${key.kind}/${key.event}/${key.role}`;

/**
 * The site origin for links in emails: NEXT_PUBLIC_SITE_URL when it is an
 * https origin (or localhost), never a request's Host header; null otherwise
 * (the email then names the page instead of linking it).
 */
export function notificationSiteOrigin(): string | null {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "");
    return url.protocol === "https:" || url.hostname === "localhost" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Runs `task` after the response is sent (next/server after(); on Vercel the
 * function stays alive until it settles), so a notification never delays or
 * fails the route that scheduled it. Outside a request scope (a script, a
 * test) it runs detached. Never throws.
 */
export function afterResponse(task: () => Promise<unknown>): void {
  const run = async () => {
    try {
      await task();
    } catch (err) {
      console.warn("[notifications] task failed:", err instanceof Error ? err.name : "unknown");
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}

async function claim(sb: SupabaseClient, key: NotificationKey): Promise<number | null> {
  return withTimeout(NOTIFICATION_DB_TIMEOUT_MS, async (signal) => {
    const { data, error } = await sb
      .rpc("claim_notification", {
        p_kind: key.kind,
        p_ref_id: key.refId,
        p_event: key.event,
        p_recipient_role: key.role,
      })
      .abortSignal(signal);
    if (error) throw new Error(typeof error.code === "string" ? error.code : "claim failed");
    if (data === null || data === undefined) return null;
    const id = Number(data);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("claim answered no id");
    return id;
  });
}

async function finish(
  sb: SupabaseClient,
  key: NotificationKey,
  id: number,
  status: "sent" | "failed" | "skipped",
  error: NotificationErrorClass | null,
  source: RecipientSource | null,
): Promise<void> {
  try {
    await withTimeout(NOTIFICATION_DB_TIMEOUT_MS, async (signal) => {
      const { error: rpcError } = await sb
        .rpc("finish_notification", { p_id: id, p_status: status, p_error: error, p_recipient_source: source })
        .abortSignal(signal);
      if (rpcError) throw new Error(typeof rpcError.code === "string" ? rpcError.code : "finish failed");
    });
  } catch {
    // The row stays pending, which reads as "outcome unknown": never resent.
    console.warn(`[notifications] ${label(key)}: outcome ${status} not recorded`);
  }
}

/** One notification, at most once (see the header). Never throws. */
export async function deliverNotification(input: {
  key: NotificationKey;
  recipient: (signal: AbortSignal) => Promise<NotificationRecipient | null>;
  message: () => NotificationMessage | Promise<NotificationMessage>;
  /** The service-role client (tests pass a stand-in). */
  sb?: SupabaseClient;
}): Promise<NotificationOutcome> {
  const { key } = input;
  if (!KEY_PART_RE.test(key.kind) || !KEY_PART_RE.test(key.event) || !REF_RE.test(key.refId)) {
    console.warn(`[notifications] refused a malformed key (${key.role})`);
    return "unavailable";
  }
  let sb: SupabaseClient;
  let id: number | null;
  try {
    sb = input.sb ?? getSupabaseAdmin();
    id = await claim(sb, key);
  } catch {
    console.warn(`[notifications] ${label(key)}: claim unavailable, not sent`);
    return "unavailable";
  }
  if (id === null) return "duplicate";

  let recipient: NotificationRecipient | null;
  try {
    recipient = await withTimeout(NOTIFICATION_DB_TIMEOUT_MS, input.recipient);
  } catch {
    await finish(sb, key, id, "failed", "RESOLVE_FAILED", null);
    return "failed";
  }
  if (!recipient) {
    await finish(sb, key, id, "skipped", "NO_RECIPIENT", null);
    return "skipped";
  }
  if (!emailConfigured()) {
    await finish(sb, key, id, "skipped", "NOT_CONFIGURED", recipient.source);
    return "skipped";
  }
  let message: NotificationMessage;
  try {
    message = await input.message();
  } catch {
    await finish(sb, key, id, "failed", "MESSAGE_FAILED", recipient.source);
    return "failed";
  }
  let result: SendEmailResult;
  try {
    result = await sendEmail({
      to: recipient.to,
      subject: message.subject,
      html: message.html,
      redactErrors: true,
      timeoutMs: NOTIFICATION_SEND_TIMEOUT_MS,
    });
  } catch {
    // sendEmail does not throw; a stand-in or a future change might.
    result = { sent: false, error: "Delivery failed" };
  }
  if (result.sent) {
    await finish(sb, key, id, "sent", null, recipient.source);
    return "sent";
  }
  const failure = sendFailureClass(result);
  await finish(sb, key, id, failure.status, failure.error, recipient.source);
  return failure.status;
}

/** The holder's address (see the header for the order). Reads only email columns; throws when a lookup fails. */
export async function resolveHolderEmail(
  sb: SupabaseClient,
  holder: { wallet: string; clientId: string | null; contact?: string | null },
  signal: AbortSignal,
): Promise<NotificationRecipient | null> {
  const network = detectNetwork();
  const member = await sb
    .from("account_wallets")
    .select("account_id")
    .eq("network", network)
    .eq("wallet", holder.wallet)
    .abortSignal(signal)
    .maybeSingle();
  if (member.error) throw new Error("account lookup failed");
  const accountId = (member.data as { account_id?: unknown } | null)?.account_id;
  if (typeof accountId === "string") {
    const profile = await sb
      .from("account_profiles")
      .select("email, email_verified_at")
      .eq("id", accountId)
      .eq("network", network)
      .abortSignal(signal)
      .maybeSingle();
    if (profile.error) throw new Error("account lookup failed");
    const row = profile.data as { email?: unknown; email_verified_at?: unknown } | null;
    if (row?.email_verified_at && isSingleEmailAddress(row.email)) return { to: row.email, source: "account" };
  }
  if (holder.clientId) {
    const client = await sb
      .from("clients")
      .select("email")
      .eq("id", holder.clientId)
      .eq("network", network)
      .abortSignal(signal)
      .maybeSingle();
    if (client.error) throw new Error("dossier lookup failed");
    const email = (client.data as { email?: unknown } | null)?.email;
    if (isSingleEmailAddress(email)) return { to: email, source: "dossier" };
  }
  const contact = holder.contact?.trim();
  if (isSingleEmailAddress(contact)) return { to: contact, source: "contact" };
  return null;
}

/** The operator mailbox (COMPLIANCE_ALERT_EMAIL), or null when unset or invalid. */
export function operatorRecipient(): NotificationRecipient | null {
  const list = alertRecipients();
  return list ? { to: list, source: "config" } : null;
}

/** A notification to the holder of a record: the address comes from resolveHolderEmail. */
export function notifyHolder(input: {
  kind: string;
  refId: string;
  event: string;
  /** Resolved lazily, only once the key is claimed; null when the record is gone. */
  holder: () => Promise<{ wallet: string; clientId: string | null; contact?: string | null } | null>;
  message: () => NotificationMessage | Promise<NotificationMessage>;
  sb?: SupabaseClient;
}): Promise<NotificationOutcome> {
  const sbFor = () => input.sb ?? getSupabaseAdmin();
  return deliverNotification({
    key: { kind: input.kind, refId: input.refId, event: input.event, role: "holder" },
    sb: input.sb,
    recipient: async (signal) => {
      const holder = await input.holder();
      return holder ? resolveHolderEmail(sbFor(), holder, signal) : null;
    },
    message: input.message,
  });
}

/** A notification to the operator mailbox. */
export function notifyOperator(input: {
  kind: string;
  refId: string;
  event: string;
  message: () => NotificationMessage | Promise<NotificationMessage>;
  sb?: SupabaseClient;
}): Promise<NotificationOutcome> {
  return deliverNotification({
    key: { kind: input.kind, refId: input.refId, event: input.event, role: "operator" },
    sb: input.sb,
    recipient: async () => operatorRecipient(),
    message: input.message,
  });
}
