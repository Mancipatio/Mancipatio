// SERVER-ONLY — the emails of a conversion request's status changes.
//
// The conversion routes call notifyConversionStatus() right after their
// status write succeeded:
//   /api/conversion/create       requested     holder + operator
//   /api/conversion/admin-update vault_opened, deposited, converted,
//                                cancelled, returned (when the status
//                                changed)            holder (+ operator for
//                                                    deposited)
//   /api/conversion/deposited    deposited     holder + operator
//   /api/conversion/cancel       cancelled     holder
//   /api/conversion/reclaim      returned      holder
// The work runs after the response (lib/server/notifications.ts
// afterResponse) and at most once per request, event and recipient
// (notification_log, migration 0088): a retried recording or a second admin
// click sends nothing, and an email failure is recorded and swallowed. The
// key carries the request id's canonical spelling (canonicalRequestId), so
// a replay that spells the same uuid differently finds its claim.
//
// What an email says. The holder's: the event, the request's short id, the
// asset label (derived on-chain by the create route) and the units, what
// happens next with the TYPICAL duration from lib/conversion-timeline.ts,
// the outcome transaction where there is one, and a link to
// /portfolio/conversion. The operator's (COMPLIANCE_ALERT_EMAIL): the event,
// the request's short id and a link to /admin/custody only, like the
// minimal system-alert rows (lib/server/system-alerts.ts): the queue holds
// the details. Neither ever carries KYC data, a wallet, the holder's
// contact or note, or an admin note (free text that may name a KYC reason):
// the message builders below receive only ConversionNoticeFacts.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { CONVERSION_TYPICAL_DURATIONS } from "@/lib/conversion-timeline";
import { detectNetwork, explorerTxUrl, type Network } from "@/lib/network";
import { escapeHtml } from "@/lib/server/email";
import {
  afterResponse,
  NOTIFICATION_DB_TIMEOUT_MS,
  notificationSiteOrigin,
  notifyHolder,
  notifyOperator,
  type NotificationMessage,
  type NotificationOutcome,
} from "@/lib/server/notifications";
import { withTimeout } from "@/lib/server/with-timeout";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export const CONVERSION_EVENTS = [
  "requested",
  "vault_opened",
  "deposited",
  "converted",
  "cancelled",
  "returned",
] as const;
export type ConversionEvent = (typeof CONVERSION_EVENTS)[number];

/** The events the operator mailbox hears about: a new request to review, units to file for. */
export const OPERATOR_CONVERSION_EVENTS: ReadonlySet<ConversionEvent> = new Set(["requested", "deposited"]);

export function isConversionEvent(value: unknown): value is ConversionEvent {
  return typeof value === "string" && (CONVERSION_EVENTS as readonly string[]).includes(value);
}

/**
 * A request id in its one canonical spelling (lowercase 8-4-4-4-12), from any
 * spelling PostgreSQL reads as the same uuid (upper case, braces, hyphens
 * after any group of four digits or none); null for anything else. The
 * recording routes echo the caller's id on a replay, and the claim compares
 * text, so without this a re-spelled id would claim (and email) again.
 */
export function canonicalRequestId(value: string): string | null {
  const hex = value.trim().replace(/^\{(.*)\}$/, "$1").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Everything a conversion email may say. No wallet, contact, note or dossier field. */
export type ConversionNoticeFacts = {
  id: string;
  assetLabel: string;
  amount: string;
  outcomeTx: string | null;
  network: Network;
};

const TX_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const UNITS_RE = /^\d{1,20}$/;

/** The request's short id, as the pages show it. */
const shortId = (id: string) => id.slice(0, 8);

/** The label as one plain line (no control characters), at most 120 characters. */
function plainLabel(label: string): string {
  const clean = label.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return clean || "your share class";
}

function units(amount: string): string {
  return UNITS_RE.test(amount) ? `${amount} ${amount === "1" ? "unit" : "units"}` : "your units";
}

function txLine(facts: ConversionNoticeFacts): string {
  if (!facts.outcomeTx || !TX_RE.test(facts.outcomeTx)) return "";
  const href = explorerTxUrl(facts.outcomeTx, facts.network);
  return `<p>Transaction: <a href="${escapeHtml(href)}">${escapeHtml(`${facts.outcomeTx.slice(0, 8)}…${facts.outcomeTx.slice(-6)}`)}</a></p>`;
}

function pageLine(origin: string | null, path: string, text: string, fallback: string): string {
  return origin
    ? `<p><a href="${escapeHtml(`${origin}${path}`)}">${escapeHtml(text)}</a></p>`
    : `<p>${escapeHtml(fallback)}</p>`;
}

const HOLDER_FOOTER =
  `<p style="color:#64748b;font-size:12px">You receive this email because you requested a conversion on Manci. ` +
  `Durations are typical, not guaranteed. Manci never asks for your recovery phrase or private keys.</p>`;

/** The holder's email for `event` (pure; see the header for what it may say). */
export function conversionHolderMessage(
  event: ConversionEvent,
  facts: ConversionNoticeFacts,
  origin: string | null,
): NotificationMessage {
  const id = escapeHtml(shortId(facts.id));
  const what = `${escapeHtml(units(facts.amount))} of ${escapeHtml(plainLabel(facts.assetLabel))}`;
  const typical = CONVERSION_TYPICAL_DURATIONS;
  let subject: string;
  let body: string;
  switch (event) {
    case "requested":
      subject = "Manci: we received your conversion request";
      body =
        `<p>We received your request ${id} to convert ${what}.</p>` +
        `<p>Next: Manci reviews it, typically in ${escapeHtml(typical.review)}, and opens an escrow vault for your deposit.</p>`;
      break;
    case "vault_opened":
      subject = "Manci: your conversion escrow vault is open";
      body =
        `<p>Manci approved your conversion request ${id} and opened its escrow vault.</p>` +
        `<p>Next: deposit ${what} from your wallet on the Conversion page, any time ${escapeHtml(typical.deposit)} shown there.</p>`;
      break;
    case "deposited":
      subject = "Manci: your units are in escrow";
      body =
        `<p>Your deposit of ${what} for conversion request ${id} is recorded in its escrow vault.</p>` +
        `<p>Next: Manci arranges the notary appointment and files with the business register, typically in ${escapeHtml(typical.filing)}; ` +
        `the register's decision typically follows ${escapeHtml(typical.registerDecision)}. We email you once the conversion is registered.</p>`;
      break;
    case "converted":
      subject = "Manci: your conversion is registered";
      body =
        `<p>The business register recorded the transfer for conversion request ${id}, and the escrowed ${what} were burned on Solana.</p>` +
        txLine(facts);
      break;
    case "cancelled":
      subject = "Manci: your conversion request was cancelled";
      body =
        `<p>Conversion request ${id} for ${what} was cancelled before any deposit. No units moved.</p>` +
        `<p>Any note from Manci is shown with the request on the Conversion page.</p>`;
      break;
    case "returned":
      subject = "Manci: your escrowed units were returned";
      body =
        `<p>The ${what} in the escrow of conversion request ${id} were returned to your wallet. Nothing was burned.</p>` +
        txLine(facts);
      break;
  }
  const page = pageLine(origin, "/portfolio/conversion", "Open your conversion requests", "Open Portfolio, then Conversion, on Manci.");
  return { subject, html: body + page + HOLDER_FOOTER };
}

/** The operator mailbox's email for `event` (pure): the event, the short id and the queue, nothing else. */
export function conversionOperatorMessage(
  event: ConversionEvent,
  facts: Pick<ConversionNoticeFacts, "id" | "network">,
  origin: string | null,
): NotificationMessage {
  const id = escapeHtml(shortId(facts.id));
  const network = escapeHtml(facts.network);
  const queue = pageLine(origin, "/admin/custody#conversion-requests", "Open the conversion queue", "Review it on /admin/custody, Conversion requests.");
  if (event === "deposited") {
    return {
      subject: `[Manci ${facts.network}] Units deposited for conversion ${shortId(facts.id)}`,
      html:
        `<p>The holder's units for conversion request ${id} (${network}) are in escrow.</p>` +
        `<p>Next: the notary appointment and the business register filing; confirm the conversion after the register decision and before the vault deadline.</p>` +
        queue,
    };
  }
  return {
    subject: `[Manci ${facts.network}] New conversion request ${shortId(facts.id)}`,
    html: `<p>A holder filed conversion request ${id} (${network}).</p><p>Next: review it; approving opens the escrow vault.</p>` + queue,
  };
}

type ConversionNoticeRow = {
  id: string;
  holder_wallet: string;
  client_id: string | null;
  contact: string | null;
  asset_label: string | null;
  amount: string | number | null;
  outcome_tx: string | null;
};

/** The columns a notice needs: the holder's three address sources and the facts. */
const NOTICE_COLUMNS = "id, holder_wallet, client_id, contact, asset_label, amount, outcome_tx";

async function readNoticeRow(sb: SupabaseClient, requestId: string): Promise<ConversionNoticeRow | null> {
  return withTimeout(NOTIFICATION_DB_TIMEOUT_MS, async (signal) => {
    const { data, error } = await sb
      .from("conversion_requests")
      .select(NOTICE_COLUMNS)
      .eq("id", requestId)
      .eq("network", detectNetwork())
      .abortSignal(signal)
      .maybeSingle();
    if (error) throw new Error("conversion request unavailable");
    return (data as ConversionNoticeRow | null) ?? null;
  });
}

function factsOf(row: ConversionNoticeRow, network: Network): ConversionNoticeFacts {
  return {
    id: row.id,
    assetLabel: row.asset_label ?? "",
    amount: row.amount === null || row.amount === undefined ? "" : String(row.amount),
    outcomeTx: row.outcome_tx,
    network,
  };
}

/**
 * Sends the emails of one status change now (the holder's and, for a new
 * request or a deposit, the operator's), each at most once. Never throws.
 */
export async function sendConversionNotifications(
  rawRequestId: string,
  event: ConversionEvent,
  opts: { sb?: SupabaseClient } = {},
): Promise<{ holder: NotificationOutcome; operator: NotificationOutcome | null }> {
  const network = detectNetwork();
  const origin = notificationSiteOrigin();
  const unavailable = { holder: "unavailable", operator: OPERATOR_CONVERSION_EVENTS.has(event) ? "unavailable" : null } as const;
  // The claim's key is the id's ONE spelling: a replayed recording that spells
  // the same uuid differently must find the key it claimed before.
  const requestId = canonicalRequestId(rawRequestId);
  if (!requestId) return unavailable;
  let sb: SupabaseClient;
  try {
    sb = opts.sb ?? getSupabaseAdmin();
  } catch {
    return unavailable;
  }
  // Read once, only after the holder's key is claimed (address and facts).
  let row: Promise<ConversionNoticeRow | null> | null = null;
  const loadRow = () => (row ??= readNoticeRow(sb, requestId));
  const requireRow = async () => {
    const found = await loadRow();
    if (!found) throw new Error("conversion request not found");
    return found;
  };
  const holder = notifyHolder({
    kind: "conversion",
    refId: requestId,
    event,
    sb,
    holder: async () => {
      const found = await loadRow();
      return found ? { wallet: found.holder_wallet, clientId: found.client_id, contact: found.contact } : null;
    },
    message: async () => conversionHolderMessage(event, factsOf(await requireRow(), network), origin),
  });
  // The operator's email names only the request and the queue: no row read.
  const operator = OPERATOR_CONVERSION_EVENTS.has(event)
    ? notifyOperator({
        kind: "conversion",
        refId: requestId,
        event,
        sb,
        message: () => conversionOperatorMessage(event, { id: requestId, network }, origin),
      })
    : null;
  const [holderOutcome, operatorOutcome] = await Promise.all([holder, operator]);
  return { holder: holderOutcome, operator: operatorOutcome };
}

/**
 * Schedules the emails of one status change for after the response. Call it
 * only after the status write succeeded; it never throws and never delays
 * the route.
 */
export function notifyConversionStatus(requestId: string, event: ConversionEvent): void {
  afterResponse(() => sendConversionNotifications(requestId, event));
}
