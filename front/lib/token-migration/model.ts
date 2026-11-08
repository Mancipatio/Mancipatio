// Token migration (V1, operator-delivered): the shared vocabulary of the
// campaign and its deposits. Pure and isomorphic (no React, no browser API,
// no server import), so the routes, the pages and the tests agree on every
// status, reason, memo and window rule. The database (migration 0085) holds
// the same rules a second time: its CHECKs and guard triggers are the
// authority under the routes, this file is what the routes check first and
// what the pages say.
//
// The flow in one paragraph: a company that already issued a token on
// Solana opens a campaign; during an opt-in window of 60–90 days its holders
// deposit exact multiples of the lot into a deposit token account that a
// Manci-controlled owner holds (a Squads vault recommended), with a memo
// naming the campaign; the operator then sends units of the company's Manci
// share class from the treasury wallet to each holder (the existing
// hook-aware "Send to holder" tooling), irregular deposits are refunded,
// and after the window the collected old tokens are burned and a final
// report is published with its SHA-256. Deposits are plain SPL transfers:
// no program instruction and no pause bit of the Manci programs covers them.

export const TOKEN_PROGRAM_CLASSIC = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_PROGRAM_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const OLD_TOKEN_PROGRAMS: readonly string[] = [TOKEN_PROGRAM_CLASSIC, TOKEN_PROGRAM_2022];

export const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A campaign's public address: /migrations/<slug> (unique per network). */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MIN = 3;
export const SLUG_MAX = 64;

export function validSlug(slug: string): boolean {
  return slug.length >= SLUG_MIN && slug.length <= SLUG_MAX && SLUG_RE.test(slug);
}

// ── The campaign ─────────────────────────────────────────────────────────────

export const MIGRATION_STATUSES = ["draft", "open", "closed", "completed", "cancelled"] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

/**
 * The campaign's lifecycle (the 0085 guard trigger is the authority):
 *   draft  → open | cancelled
 *   open   → closed | cancelled
 *   closed → completed | cancelled
 *   completed, cancelled: terminal.
 * Cancelling is refused once any deposit was delivered (units already left
 * the treasury: the campaign completes instead), and completing is refused
 * while any deposit is still accepted or irregular.
 */
export const MIGRATION_TRANSITIONS: Readonly<Record<MigrationStatus, readonly MigrationStatus[]>> = {
  draft: ["open", "cancelled"],
  open: ["closed", "cancelled"],
  closed: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function migrationTransitionAllowed(from: MigrationStatus, to: MigrationStatus): boolean {
  return MIGRATION_TRANSITIONS[from].includes(to);
}

export function isMigrationStatus(value: unknown): value is MigrationStatus {
  return typeof value === "string" && (MIGRATION_STATUSES as readonly string[]).includes(value);
}

export const MIGRATION_STATUS_LABEL: Record<MigrationStatus, string> = {
  draft: "Draft",
  open: "Open",
  closed: "Closed",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const MIGRATION_SOURCES = ["founder_transfer", "capital_increase"] as const;
export type MigrationSource = (typeof MIGRATION_SOURCES)[number];
export const MIGRATION_SOURCE_LABEL: Record<MigrationSource, string> = {
  founder_transfer: "Transferred from the founders' existing shares",
  capital_increase: "Issued in a capital increase",
};

export const UNCLAIMED_POLICIES = ["return_to_source", "not_issued"] as const;
export type UnclaimedPolicy = (typeof UNCLAIMED_POLICIES)[number];
export const UNCLAIMED_POLICY_LABEL: Record<UnclaimedPolicy, string> = {
  return_to_source: "Units nobody claims go back to their source after the window",
  not_issued: "Units nobody claims are never issued",
};

// ── The opt-in window ────────────────────────────────────────────────────────

/** Owner decision 2026-11-08: the window lasts 60–90 days, 75 by default. */
export const WINDOW_MIN_DAYS = 60;
export const WINDOW_MAX_DAYS = 90;
export const WINDOW_DEFAULT_DAYS = 75;
const DAY_MS = 86_400_000;

/** The window's length in days (fractional), or null when either date is unreadable. */
export function windowDays(opensAt: string, closesAt: string): number | null {
  const opens = Date.parse(opensAt);
  const closes = Date.parse(closesAt);
  if (!Number.isFinite(opens) || !Number.isFinite(closes)) return null;
  return (closes - opens) / DAY_MS;
}

/** True when the window lasts between 60 and 90 days (both inclusive), as the 0085 CHECK says. */
export function validWindow(opensAt: string, closesAt: string): boolean {
  const days = windowDays(opensAt, closesAt);
  return days !== null && days >= WINDOW_MIN_DAYS && days <= WINDOW_MAX_DAYS;
}

export type WindowState = "not_yet" | "open" | "ended";

/** Where `at` falls: before the window, inside it [opens, closes), or after it. */
export function windowStateAt(opensAt: string, closesAt: string, at: number): WindowState {
  const opens = Date.parse(opensAt);
  const closes = Date.parse(closesAt);
  if (!(at >= opens)) return "not_yet";
  return at < closes ? "open" : "ended";
}

// ── The deposit memo ─────────────────────────────────────────────────────────

/** `manci:migration:v1:<migration id>:<lots>`: the holder's statement, signed with the transfer. */
export const MIGRATION_MEMO_PREFIX = "manci:migration:v1:";
const MEMO_RE = /^manci:migration:v1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9]\d{0,19})$/;

export function migrationMemoText(migrationId: string, lots: bigint): string {
  if (!UUID_RE.test(migrationId)) throw new Error("Invalid migration id");
  if (typeof lots !== "bigint" || lots < BigInt(1)) throw new Error("A deposit is at least one lot");
  return `${MIGRATION_MEMO_PREFIX}${migrationId}:${lots.toString()}`;
}

export type ParsedMemo =
  | { kind: "migration"; migrationId: string; lots: bigint }
  /** Starts with the prefix but is not a well-formed migration memo. */
  | { kind: "malformed" }
  /** Some other memo (not ours). */
  | { kind: "other" };

export function parseMigrationMemo(text: string): ParsedMemo {
  if (!text.startsWith(MIGRATION_MEMO_PREFIX)) return { kind: "other" };
  const match = MEMO_RE.exec(text);
  if (!match) return { kind: "malformed" };
  return { kind: "migration", migrationId: match[1], lots: BigInt(match[2]) };
}

// ── Deposits ─────────────────────────────────────────────────────────────────

export const DEPOSIT_STATUSES = ["accepted", "irregular", "delivered", "refunded"] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

/**
 * A deposit's lifecycle (the 0085 guard trigger is the authority):
 *   accepted  → delivered | refunded (refunded only in a cancelled campaign)
 *   irregular → refunded
 *   delivered, refunded: terminal.
 */
export function depositTransitionAllowed(from: DepositStatus, to: DepositStatus, campaign: MigrationStatus): boolean {
  if (from === "accepted") return to === "delivered" || (to === "refunded" && campaign === "cancelled");
  if (from === "irregular") return to === "refunded";
  return false;
}

/**
 * Why a deposit cannot earn units and must be refunded. The database keeps
 * the code; the public pages show PUBLIC_REASON (a compliance hold says no
 * more than "held for review": a wallet's screening result is never
 * published).
 */
export const IRREGULAR_REASONS = [
  "not_lot_multiple",
  "outside_window",
  "excluded_wallet",
  "over_cap",
  "memo_mismatch",
  "not_signed_by_holder",
  "not_open",
  "compliance_hold",
] as const;
export type IrregularReason = (typeof IRREGULAR_REASONS)[number];

export function isIrregularReason(value: unknown): value is IrregularReason {
  return typeof value === "string" && (IRREGULAR_REASONS as readonly string[]).includes(value);
}

/** What the operator reads in the deposits table. */
export const IRREGULAR_REASON_TEXT: Record<IrregularReason, string> = {
  not_lot_multiple: "Not an exact multiple of the lot (at least one lot): refund it.",
  outside_window: "Deposited outside the opt-in window: refund it.",
  excluded_wallet: "Sent from an excluded wallet: refund it.",
  over_cap: "The units cap was already reached when it was recorded: refund it.",
  memo_mismatch: "Missing or wrong migration memo: refund it.",
  not_signed_by_holder: "The transfer was not signed by the holder wallet it came from: refund it.",
  not_open: "The campaign was not accepting deposits: refund it.",
  compliance_hold: "Sanctions screening hit: held for compliance review. Neither deliver nor refund without the compliance team's decision.",
};

/** What the public proof table and the holder read. */
export const PUBLIC_REASON: Record<IrregularReason, string> = {
  not_lot_multiple: "Not a whole number of lots",
  outside_window: "Outside the window",
  excluded_wallet: "Excluded wallet",
  over_cap: "Over the units cap",
  memo_mismatch: "Missing campaign memo",
  not_signed_by_holder: "Not signed by the holder",
  not_open: "Campaign not open",
  compliance_hold: "Held for review",
};

export const DEPOSIT_STATUS_LABEL: Record<DepositStatus, string> = {
  accepted: "Accepted: units due",
  irregular: "Irregular: refund due",
  delivered: "Units delivered",
  refunded: "Refunded",
};

// ── Plain words ──────────────────────────────────────────────────────────────

/** The memo-free part of a ratio sentence: "1 Manci unit for every 5,000 OLD". */
export function ratioSentence(lotText: string, symbol: string): string {
  return `1 Manci unit for every ${lotText} ${symbol}`;
}
