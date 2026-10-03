// SERVER-ONLY — buys by wallets not linked to the platform (D2, owner and
// counsel decision 2026-10-03).
//
// Buying share tokens of an Open class needs no KYC (D1), but it needs a
// wallet LINKED TO THE PLATFORM: connected and signed in (SIWS) on the site,
// the Terms in force accepted, the sanctions screen passed (D2). The site
// enforces this before the wallet opens: the Terms gate on the marketplace
// (fails closed on mainnet) and the sale page's pre-check
// /api/compliance/screen-wallet (sanctions, then the recorded acceptance
// where the server gate is enforced). The program cannot: an Open-class
// `buy` needs only the buyer's signature. A buy made by calling the program
// directly is not supported, and it is detected here, after the fact.
//
// The lasting proof of the link is the Terms acceptance: a tos_acceptances
// row (wallet, version) that only the signed /api/tos/accept route (bound to
// the site's origin and network) or the onboarding acceptance writes. Each
// Supabase project serves one network, so the table has no network column.
// An account_wallets row is no proof: the account is created lazily when the
// wallet opens /account, never by the buy path (it is evidence only).
//
// Rule: a buy at block time T is linked when the buyer accepted the Terms in
// force at T no later than T + LINK_GRACE_MS (a wallet that accepts right
// after buying, clock skew). The Terms in force at T are this build's version
// (tosVersionFor), unless the buy predates it — T before the version's date,
// or before anyone had accepted it (it was not deployed yet) — and then any
// version the wallet accepted counts, so a gap-scan buy or a buy in the
// minutes before a Terms update is not flagged.
//
// processEventJob (lib/server/onchain-alarms.ts) runs checkUnlinkedBuys on
// every finalized, successful transaction, after the sanctions screen. Every
// asset_registry `buy` counts, top-level or inner (CPI), Open or KYC-gated
// (telling them apart needs another RPC read; a gated buyer holds a passport
// and compliance can usually resolve at once). Not linked while now < T +
// grace: the job waits (LINK_GRACE) and decides once on its next run. Not
// linked after the grace: one compliance alert per (transaction, buyer),
// source onchain:unlinked-buy, the wallet as subject (an open alert blocks
// passport issuance until compliance resolves it), high on mainnet and
// medium elsewhere, emailed as label and time only. A read or write that
// fails is never a verdict: the function throws and the job retries.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  BUY_DISCRIMINATOR,
  getBuyInstructionDataDecoder,
} from "@/lib/generated/asset_registry";
import type { Network } from "@/lib/network";
import type { Severity } from "@/lib/server/system-alerts";
import { flattenInvocations, type InvocationTx } from "@/lib/server/tx-invocations";
import { tosVersionFor } from "@/lib/tos-version";

/** How long after the buy's block time an acceptance still links it. */
export const LINK_GRACE_MS = 120_000;
/** The job is retried this long after the grace ends. */
export const LINK_RETRY_MARGIN_MS = 5_000;
export const UNLINKED_BUY_SOURCE = "onchain:unlinked-buy";
/** The `buy` accounts the evidence names (IDL order, pinned by a test). */
export const BUY_ACCOUNTS = { buyer: 0, sale: 1, share_class: 2, mint: 3 } as const;
/** At most this many buys of one buyer are listed in the evidence (`buys_total` counts them all). */
export const MAX_EVIDENCE_BUYS = 20;

export type ObservedBuy = {
  ordinal: number;
  /** Called through another program (an inner instruction). */
  via_cpi: boolean;
  sale: string | null;
  share_class: string | null;
  mint: string | null;
  /** The `amount` argument as a decimal string, null when the data has another length. */
  units: string | null;
};
export type BuyerBuys = { buyer: string; buys: ObservedBuy[] };
export type TosAcceptance = { wallet: string; version: string; created_at: string };

const startsWith = (data: Uint8Array, d: Uint8Array) => data.length >= d.length && d.every((b, i) => data[i] === b);
const BUY_DATA_LENGTH = 16;

/** Pure: every asset_registry `buy` in the transaction (top-level and inner), grouped by buyer in order. */
export function buysOf(tx: InvocationTx): BuyerBuys[] {
  const byBuyer = new Map<string, ObservedBuy[]>();
  for (const inv of flattenInvocations(tx)) {
    if (inv.programId !== ASSET_REGISTRY_PROGRAM_ADDRESS || !startsWith(inv.data, BUY_DISCRIMINATOR)) continue;
    const buyer = inv.accounts[BUY_ACCOUNTS.buyer];
    if (!buyer) continue;
    let units: string | null = null;
    if (inv.data.length === BUY_DATA_LENGTH) {
      try {
        units = getBuyInstructionDataDecoder().decode(inv.data).amount.toString();
      } catch {
        units = null;
      }
    }
    const list = byBuyer.get(buyer) ?? [];
    list.push({
      ordinal: inv.ordinal,
      via_cpi: inv.inner,
      sale: inv.accounts[BUY_ACCOUNTS.sale] ?? null,
      share_class: inv.accounts[BUY_ACCOUNTS.share_class] ?? null,
      mint: inv.accounts[BUY_ACCOUNTS.mint] ?? null,
      units,
    });
    byBuyer.set(buyer, list);
  }
  return [...byBuyer].map(([buyer, buys]) => ({ buyer, buys }));
}

/** Pure: the first instant of a Terms version ("YYYY-MM-DD…" → that day, 00:00 UTC); null when it carries no date. */
export function versionEffectiveMs(version: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(version);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Pure: whether any version the wallet accepted counts for a buy at
 * `blockTimeMs` (the buy predates the current version), or only `current`.
 * `currentLiveByBuy`: whether anyone had accepted `current` by the block time
 * (null: not known, treated as live).
 */
export function anyVersionCounts(blockTimeMs: number, current: string, currentLiveByBuy: boolean | null): boolean {
  const effective = versionEffectiveMs(current);
  if (effective !== null && blockTimeMs < effective) return true;
  return currentLiveByBuy === false;
}

export type LinkVerdict =
  | { linked: true; acceptance: TosAcceptance }
  /** An older version accepted in time, and the buy is on or after the current version's date: whether the
   * current version was live at the buy decides (anyVersionCounts). */
  | { linked: "ask-live"; acceptance: TosAcceptance }
  | { linked: false; acceptance: TosAcceptance | null };

const acceptedAt = (row: TosAcceptance) => Date.parse(row.created_at);

/**
 * Pure: the verdict for one buyer from its acceptances (`rows`, any wallet's
 * rows are filtered out). `currentLiveByBuy` as in anyVersionCounts; null
 * answers "ask-live" where it would decide.
 */
export function linkVerdict(
  rows: readonly TosAcceptance[], wallet: string, blockTimeMs: number, current: string,
  currentLiveByBuy: boolean | null = null, graceMs: number = LINK_GRACE_MS,
): LinkVerdict {
  const own = rows.filter((r) => r.wallet === wallet && Number.isFinite(acceptedAt(r)));
  const inTime = own.filter((r) => acceptedAt(r) <= blockTimeMs + graceMs);
  const latest = [...own].sort((a, b) => acceptedAt(b) - acceptedAt(a))[0] ?? null;
  const currentRow = inTime.find((r) => r.version === current);
  if (currentRow) return { linked: true, acceptance: currentRow };
  const older = [...inTime].sort((a, b) => acceptedAt(b) - acceptedAt(a))[0];
  if (!older) return { linked: false, acceptance: latest };
  const effective = versionEffectiveMs(current);
  if (effective !== null && blockTimeMs < effective) return { linked: true, acceptance: older };
  if (currentLiveByBuy === null) return { linked: "ask-live", acceptance: older };
  return currentLiveByBuy ? { linked: false, acceptance: latest } : { linked: true, acceptance: older };
}

/** The buy's time: the block time when the node gave one, else when the job was queued. */
export function buyTime(tx: InvocationTx, jobCreatedAt: string): { ms: number; source: "block" | "job" } {
  const blockTime = tx.blockTime === null || tx.blockTime === undefined ? null : Number(tx.blockTime);
  if (blockTime !== null && Number.isSafeInteger(blockTime) && blockTime > 0) return { ms: blockTime * 1000, source: "block" };
  return { ms: Date.parse(jobCreatedAt), source: "job" };
}

const short = (value: string | null) => (value ? `${value.slice(0, 4)}…${value.slice(-4)}` : "?");

/** Pure: the alert's summary (at most 500 characters). */
export function unlinkedBuySummary(buyer: string, buys: readonly ObservedBuy[], requiredVersion: string | null): string {
  const units = buys.every((b) => b.units !== null)
    ? buys.reduce((sum, b) => sum + BigInt(b.units as string), BigInt(0)).toString()
    : "an unknown number of";
  const sales = [...new Set(buys.map((b) => b.sale))];
  const sale = sales.length === 1 ? `sale ${short(sales[0])}` : `${sales.length} sales`;
  const terms = requiredVersion ? `the Terms in force (v${requiredVersion})` : "any version of the Terms";
  return (`Buy by a wallet not linked to the platform: ${short(buyer)} bought ${units} unit(s) of ${sale} without accepting `
    + `${terms} by ${Math.round(LINK_GRACE_MS / 60_000)} minutes after the buy. Buying outside the platform is not supported: `
    + "review in /admin/compliance; the Operator may blocklist the wallet and claw back its units "
    + "(runbook §15 \"Buys by wallets not linked to the platform\").").slice(0, 500);
}

export type UnlinkedBuyAlert = {
  network: Network;
  signature: string;
  buyer: string;
  clientId: string | null;
  severity: Severity;
  summary: string;
  evidence: Record<string, unknown>;
};

export const unlinkedBuyDedupKey = (signature: string, buyer: string) => `onchain:${signature}:unlinked-buy:${buyer}`;
export const unlinkedBuySeverity = (network: Network): Severity => (network === "mainnet" ? "high" : "medium");

const DB_TIMEOUT_MS = 8_000;
const dbSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(DB_TIMEOUT_MS)]);

/**
 * Pure: the compliance_alerts row of one (transaction, buyer). An AML row
 * (no system category: it names a wallet), emailed through the 0072 outbox
 * (notify_state pending), idempotent on (network, dedup_key) (0072's unique
 * index; the key fits compliance_alerts_dedup_key_format).
 */
export function unlinkedBuyAlertRow(alert: UnlinkedBuyAlert, nowIso: string) {
  return {
    network: alert.network,
    client_id: alert.clientId,
    wallet: alert.buyer,
    source: UNLINKED_BUY_SOURCE,
    severity: alert.severity,
    confidence: 100,
    evidence: alert.evidence,
    summary: alert.summary.slice(0, 500),
    status: "open",
    tx_signature: alert.signature,
    dedup_key: unlinkedBuyDedupKey(alert.signature, alert.buyer),
    category: null,
    notify_state: "pending",
    next_notify_at: nowIso,
  };
}

/**
 * Opens the alert of one (transaction, buyer), idempotent on (network,
 * dedup_key): an existing row, or a concurrent insert's unique violation
 * (23505), is "already raised". Returns whether a row was inserted; THROWS
 * on any other database error (the job retries).
 */
export async function raiseUnlinkedBuyAlert(sb: SupabaseClient, alert: UnlinkedBuyAlert, signal: AbortSignal): Promise<boolean> {
  const row = unlinkedBuyAlertRow(alert, new Date().toISOString());
  const existing = await sb.from("compliance_alerts").select("id")
    .eq("network", alert.network).eq("dedup_key", row.dedup_key).limit(1).abortSignal(dbSignal(signal));
  if (existing.error) throw new Error("Compliance alerts unavailable");
  if ((existing.data ?? []).length > 0) return false;
  const { error } = await sb.from("compliance_alerts").insert(row).abortSignal(dbSignal(signal));
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`Compliance alert not written (${error.code ?? "error"})`);
}

export type LinkCheckInput = {
  network: Network;
  signature: string;
  tx: InvocationTx;
  /** onchain_event_jobs.created_at: the buy's time when the node gave no block time. */
  jobCreatedAt: string;
  now: number;
  signal: AbortSignal;
};

/**
 * The D2 check of one finalized, successful transaction. `{ alerts }`: the
 * number of (transaction, buyer) alerts it stands for (raised now or
 * before); `{ retryAt }`: a buyer is not linked yet and the grace is still
 * running. THROWS when a read or a write fails (never a verdict).
 */
export async function checkUnlinkedBuys(
  sb: SupabaseClient, input: LinkCheckInput,
): Promise<{ alerts: number } | { retryAt: number }> {
  const buyers = buysOf(input.tx);
  if (buyers.length === 0) return { alerts: 0 };
  const time = buyTime(input.tx, input.jobCreatedAt);
  if (!Number.isFinite(time.ms)) throw new Error("Buy time unknown");
  const current = tosVersionFor(input.network);
  const { data, error } = await sb.from("tos_acceptances").select("wallet,version,created_at")
    .in("wallet", buyers.map((b) => b.buyer)).abortSignal(dbSignal(input.signal));
  if (error) throw new Error("Terms acceptances unavailable");
  const rows = (data ?? []) as TosAcceptance[];

  // Whether the current version was live at the buy: asked once, only when an
  // older acceptance would decide.
  let live: boolean | null = null;
  const currentLiveByBuy = async () => {
    if (live !== null) return live;
    const res = await sb.from("tos_acceptances").select("id").eq("version", current)
      .lte("created_at", new Date(time.ms).toISOString()).limit(1).abortSignal(dbSignal(input.signal));
    if (res.error) throw new Error("Terms acceptances unavailable");
    live = (res.data ?? []).length > 0;
    return live;
  };

  const unlinked: { buyer: BuyerBuys; acceptance: TosAcceptance | null }[] = [];
  for (const buyer of buyers) {
    let verdict = linkVerdict(rows, buyer.buyer, time.ms, current);
    if (verdict.linked === "ask-live") verdict = linkVerdict(rows, buyer.buyer, time.ms, current, await currentLiveByBuy());
    if (verdict.linked === false) unlinked.push({ buyer, acceptance: verdict.acceptance });
  }
  if (unlinked.length === 0) return { alerts: 0 };
  if (input.now < time.ms + LINK_GRACE_MS) return { retryAt: time.ms + LINK_GRACE_MS + LINK_RETRY_MARGIN_MS };

  // What the alert names as required: the current version, or "any" when
  // the buy predates it (only read here when the verdict did not need it).
  const effective = versionEffectiveMs(current);
  const predatesDate = effective !== null && time.ms < effective;
  const requiredVersion = anyVersionCounts(time.ms, current, predatesDate ? null : await currentLiveByBuy()) ? null : current;
  for (const { buyer, acceptance } of unlinked) {
    if (input.signal.aborted) throw new Error("Aborted");
    const [recorded, account, client] = await Promise.all([
      sb.from("purchase_evidence_jobs").select("id").eq("network", input.network).eq("signature", input.signature)
        .eq("buyer", buyer.buyer).limit(1).abortSignal(dbSignal(input.signal)),
      sb.from("account_wallets").select("wallet").eq("network", input.network).eq("wallet", buyer.buyer)
        .limit(1).abortSignal(dbSignal(input.signal)),
      sb.from("clients").select("id").eq("network", input.network).eq("wallet", buyer.buyer)
        .order("created_at", { ascending: true }).limit(1).abortSignal(dbSignal(input.signal)),
    ]);
    if (recorded.error || account.error || client.error) throw new Error("Link evidence unavailable");
    const buys = buyer.buys.slice(0, MAX_EVIDENCE_BUYS);
    await raiseUnlinkedBuyAlert(sb, {
      network: input.network,
      signature: input.signature,
      buyer: buyer.buyer,
      clientId: ((client.data ?? [])[0] as { id?: string } | undefined)?.id ?? null,
      severity: unlinkedBuySeverity(input.network),
      summary: unlinkedBuySummary(buyer.buyer, buyer.buys, requiredVersion),
      evidence: {
        check: "platform-link (D2)",
        buyer: buyer.buyer,
        buys,
        buys_total: buyer.buys.length,
        via_cpi: buyer.buys.some((b) => b.via_cpi),
        block_time: new Date(time.ms).toISOString(),
        block_time_source: time.source,
        grace_seconds: LINK_GRACE_MS / 1000,
        terms_version_required: requiredVersion ?? "any",
        terms_accepted: acceptance ? { version: acceptance.version, accepted_at: acceptance.created_at } : null,
        purchase_recorded: (recorded.data ?? []).length > 0,
        account_linked: (account.data ?? []).length > 0,
      },
    }, input.signal);
  }
  return { alerts: unlinked.length };
}
