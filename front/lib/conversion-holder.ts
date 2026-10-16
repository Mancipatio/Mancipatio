import type { Address } from "@solana/kit";
import type { SolanaClient } from "@solana/client";
import type { ConversionStatus } from "@/lib/conversion";

type TokenAccount = { pubkey: string; account: { data: unknown } };
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

/** Several token accounts can hold the same mint. An unreadable response is
 * unknown ownership, never a successful empty balance or a partial total. */
export function conversionBalances(rows: readonly TokenAccount[]): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.pubkey)) continue;
    seen.add(row.pubkey);
    const info = (row.account.data as { parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown } } } } | null)?.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    if (typeof info?.mint !== "string" || !info.mint || typeof amount !== "string" || !/^\d+$/.test(amount)) {
      throw new Error("Could not verify your token balances. Please try again.");
    }
    const balance = BigInt(amount);
    if (balance > BigInt(0)) balances.set(info.mint, (balances.get(info.mint) ?? BigInt(0)) + balance);
  }
  return balances;
}

/** Unlike the portfolio's best-effort reader, an RPC failure remains visible. */
export async function loadConversionBalances(rpc: SolanaClient["runtime"]["rpc"], owner: Address) {
  const response = await rpc.getTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM }, { encoding: "jsonParsed" }).send();
  return conversionBalances(response.value);
}

/** Older loads and requests started before a wallet change cannot commit. */
export function latestConversionRead() {
  let revision = 0;
  return {
    begin(isCurrent: () => boolean) {
      const started = ++revision;
      return () => started === revision && isCurrent();
    },
    invalidate() { revision++; },
  };
}

export function validConversionAmount(amount: string, balance: bigint): boolean {
  const value = amount.trim();
  if (!/^\d+$/.test(value)) return false;
  const units = BigInt(value);
  return units > BigInt(0) && units <= balance && units <= BigInt(Number.MAX_SAFE_INTEGER);
}

// ── Row order, liveness and the holder's next step ─────────────────────────

/**
 * Requests that still hold the holder's units: waiting for Manci, waiting for
 * the deposit, or deposited and waiting for the conversion. The server (the
 * create route) counts these against the on-chain balance; the page polls
 * while one exists.
 */
export const OPEN_CONVERSION_STATUSES: readonly ConversionStatus[] = ["requested", "vault_opened", "deposited"];

export function isOpenConversionStatus(status: string): status is "requested" | "vault_opened" | "deposited" {
  return (OPEN_CONVERSION_STATUSES as readonly string[]).includes(status);
}

/** True while any row still waits on the holder or on Manci. */
export function conversionRowsLive(rows: readonly { status: ConversionStatus }[]): boolean {
  return rows.some((row) => isOpenConversionStatus(row.status));
}

/**
 * Action first: the holder's own step (an open escrow waiting for the deposit),
 * then what Manci reviews, then deposits in escrow, then history. Unknown
 * statuses (an older schema's `approved`) sort with history.
 */
export function conversionStatusRank(status: ConversionStatus): number {
  switch (status) {
    case "vault_opened": return 0;
    case "requested": return 1;
    case "deposited": return 2;
    default: return 3;
  }
}

function compareCreatedDesc(a: string, b: string): number {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return y - x;
  return b.localeCompare(a);
}

/** Stable sort by conversionStatusRank, newest first within a group (the server stays created_at desc). */
export function sortConversionRequests<T extends { status: ConversionStatus; created_at: string }>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) =>
      conversionStatusRank(a.row.status) - conversionStatusRank(b.row.status) ||
      compareCreatedDesc(a.row.created_at, b.row.created_at) ||
      a.index - b.index)
    .map(({ row }) => row);
}

/** The one row the holder should look at first, or null when nothing is in progress. */
export function nextConversionStep<T extends { status: ConversionStatus; created_at: string }>(rows: readonly T[]): T | null {
  const [first] = sortConversionRequests(rows);
  return first && isOpenConversionStatus(first.status) ? first : null;
}

// ── Polling ────────────────────────────────────────────────────────────────

/** Background re-list while a row is in progress and the tab is visible. */
export const HOLDER_CONVERSION_POLL_MS = 20_000;
/** A refetch on visibility is skipped this soon after the last read. */
export const HOLDER_CONVERSION_MIN_GAP_MS = 10_000;

/** A poll runs only for a visible tab, an idle page, a live session and rows still in progress. */
export function shouldPollConversions(input: {
  live: boolean;
  visible: boolean;
  busy: boolean;
  sessionLost: boolean;
  lastReadAt: number;
  now: number;
  minGapMs?: number;
}): boolean {
  if (!input.live || !input.visible || input.busy || input.sessionLost) return false;
  return input.now - input.lastReadAt >= (input.minGapMs ?? HOLDER_CONVERSION_MIN_GAP_MS);
}

// ── The request button's gate ──────────────────────────────────────────────

/**
 * The holder's own KYC verdict, as /api/conversion/list-mine reports it from
 * the create route's resolver (lib/server/kyc-gate.ts lookupClientKyc):
 * `message` is the 403 text the create route would answer with.
 */
export type ConversionKycVerdict = {
  eligible: boolean;
  status: string | null;
  expired: boolean;
  message: string | null;
};

/** Why the signed list could not load: no wallet session (sign in), or anything else. */
export type ConversionListError = { kind: "session" | "error"; message: string };

export type ConversionRequestGate =
  | { kind: "checking" }
  | { kind: "sign" }
  | { kind: "list-error"; message: string }
  | { kind: "holdings-error"; message: string }
  | { kind: "kyc-unknown" }
  | { kind: "verify"; message: string; status: string | null; contactCompliance: boolean }
  | { kind: "no-tokens" }
  | { kind: "ready"; count: number };

/**
 * Exactly one reason the request button is enabled or not, always shown next
 * to it. Errors first (nothing else is known then), then the loads still
 * running, then the server's verdict, then the holdings. Only "ready" enables
 * the button, and "ready" is reached only once every read has answered.
 */
export function conversionRequestGate(input: {
  requestsLoaded: boolean;
  listError: ConversionListError | null;
  /** undefined = not loaded yet; null = the server could not check. */
  kyc: ConversionKycVerdict | null | undefined;
  /** null = not loaded yet. */
  holdings: readonly unknown[] | null;
  holdingsError: string | null;
}): ConversionRequestGate {
  if (input.listError?.kind === "session") return { kind: "sign" };
  if (input.listError) return { kind: "list-error", message: input.listError.message };
  if (input.holdingsError) return { kind: "holdings-error", message: input.holdingsError };
  if (!input.requestsLoaded || input.kyc === undefined || input.holdings === null) return { kind: "checking" };
  if (input.kyc === null) return { kind: "kyc-unknown" };
  if (!input.kyc.eligible) {
    return {
      kind: "verify",
      message: input.kyc.message ?? "KYC verification required before requesting a conversion.",
      status: input.kyc.status,
      contactCompliance: input.kyc.status === "suspended" || input.kyc.status === "rejected",
    };
  }
  if (input.holdings.length === 0) return { kind: "no-tokens" };
  return { kind: "ready", count: input.holdings.length };
}
