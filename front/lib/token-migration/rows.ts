// Token migration (V1): the database rows as the routes read them, their
// public projection and the progress figures. Pure and isomorphic.
//
// Base-unit amounts are numeric(39,0) in the database and can exceed 2^53
// (one billion tokens of 9 decimals is 10^18 base units), so they never pass
// through a JavaScript number: the select lists below cast them to text
// (PostgREST `alias:column::text`), the narrowing keeps them as decimal
// strings, and arithmetic happens on bigint.

import {
  DEPOSIT_STATUSES,
  isIrregularReason,
  isMigrationStatus,
  MIGRATION_SOURCES,
  PUBLIC_REASON,
  UNCLAIMED_POLICIES,
  type DepositStatus,
  type IrregularReason,
  type MigrationSource,
  type MigrationStatus,
  type UnclaimedPolicy,
} from "@/lib/token-migration/model";

/** The columns of token_migrations the routes read (not the final report's text: only its route reads that). */
export const MIGRATION_SELECT = [
  "id", "network", "slug", "status", "company_name", "issuer_pda", "asset_pda", "share_class_pda", "new_mint",
  "old_chain", "old_mint", "old_token_program", "old_decimals", "old_symbol", "old_name",
  "old_total_supply:old_total_supply::text", "excluded_wallets",
  "excluded_wallet_amount:excluded_wallet_amount::text", "excluded_manual_amount:excluded_manual_amount::text",
  "excluded_amount:excluded_amount::text", "excluded_note", "supply_read_at",
  "equity_bps", "granularity", "lot_base_units:lot_base_units::text", "units_cap:units_cap::text",
  "source", "unclaimed_policy", "deposit_owner", "deposit_ata", "window_opens_at", "window_closes_at",
  "terms_doc_sha256", "terms_doc_url", "treasury_wallet", "final_report_sha256",
  "old_tokens_burn_tx", "old_tokens_burned:old_tokens_burned::text",
  "created_by", "opened_at", "closed_at", "completed_at", "cancelled_at", "created_at", "updated_at",
].join(",");

export const DEPOSIT_SELECT = [
  "id", "migration_id", "network", "holder_wallet", "deposit_tx", "deposit_slot", "block_time",
  "amount_base:amount_base::text", "units_due:units_due::text", "status", "reason_code", "reason",
  "delivery_tx", "refund_tx", "recorded_via", "delivered_at", "refunded_at", "created_at",
].join(",");

export type MigrationRow = {
  id: string;
  network: string;
  slug: string;
  status: MigrationStatus;
  company_name: string;
  issuer_pda: string;
  asset_pda: string;
  share_class_pda: string;
  new_mint: string;
  old_chain: string;
  old_mint: string;
  old_token_program: string;
  old_decimals: number;
  old_symbol: string;
  old_name: string;
  old_total_supply: string;
  excluded_wallets: string[];
  excluded_wallet_amount: string;
  excluded_manual_amount: string;
  excluded_amount: string;
  excluded_note: string;
  supply_read_at: string;
  equity_bps: number;
  granularity: number;
  lot_base_units: string;
  units_cap: string;
  source: MigrationSource;
  unclaimed_policy: UnclaimedPolicy;
  deposit_owner: string;
  deposit_ata: string;
  window_opens_at: string;
  window_closes_at: string;
  terms_doc_sha256: string | null;
  terms_doc_url: string | null;
  treasury_wallet: string;
  final_report_sha256: string | null;
  old_tokens_burn_tx: string | null;
  old_tokens_burned: string | null;
  created_by: string;
  opened_at: string | null;
  closed_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DepositRow = {
  id: string;
  migration_id: string;
  network: string;
  holder_wallet: string;
  deposit_tx: string;
  deposit_slot: number;
  block_time: string;
  amount_base: string;
  units_due: string;
  status: DepositStatus;
  reason_code: IrregularReason | null;
  reason: string | null;
  delivery_tx: string | null;
  refund_tx: string | null;
  recorded_via: "holder" | "reconcile";
  delivered_at: string | null;
  refunded_at: string | null;
  created_at: string;
};

export class RowShapeError extends Error {
  constructor(column: string) {
    super(`Unexpected token migration row (${column})`);
    this.name = "RowShapeError";
  }
}

function str(raw: Record<string, unknown>, column: string): string {
  const v = raw[column];
  if (typeof v !== "string") throw new RowShapeError(column);
  return v;
}
function optStr(raw: Record<string, unknown>, column: string): string | null {
  const v = raw[column];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new RowShapeError(column);
  return v;
}
function int(raw: Record<string, unknown>, column: string): number {
  const v = raw[column];
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new RowShapeError(column);
  return n;
}
/** A non-negative integer amount as a decimal string (a safe JS integer is accepted and converted). */
function decimal(raw: Record<string, unknown>, column: string): string {
  const v = raw[column];
  if (typeof v === "string" && /^\d+$/.test(v)) return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  throw new RowShapeError(column);
}
function optDecimal(raw: Record<string, unknown>, column: string): string | null {
  const v = raw[column];
  return v === null || v === undefined ? null : decimal(raw, column);
}
function oneOf<T extends string>(raw: Record<string, unknown>, column: string, values: readonly T[]): T {
  const v = raw[column];
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw new RowShapeError(column);
  return v as T;
}

/** A token_migrations row as MIGRATION_SELECT reads it, or THROWS RowShapeError. */
export function parseMigrationRow(raw: unknown): MigrationRow {
  if (!raw || typeof raw !== "object") throw new RowShapeError("row");
  const r = raw as Record<string, unknown>;
  const status = r.status;
  if (!isMigrationStatus(status)) throw new RowShapeError("status");
  const wallets = r.excluded_wallets;
  if (!Array.isArray(wallets) || !wallets.every((w) => typeof w === "string")) throw new RowShapeError("excluded_wallets");
  return {
    id: str(r, "id"),
    network: str(r, "network"),
    slug: str(r, "slug"),
    status,
    company_name: str(r, "company_name"),
    issuer_pda: str(r, "issuer_pda"),
    asset_pda: str(r, "asset_pda"),
    share_class_pda: str(r, "share_class_pda"),
    new_mint: str(r, "new_mint"),
    old_chain: str(r, "old_chain"),
    old_mint: str(r, "old_mint"),
    old_token_program: str(r, "old_token_program"),
    old_decimals: int(r, "old_decimals"),
    old_symbol: str(r, "old_symbol"),
    old_name: str(r, "old_name"),
    old_total_supply: decimal(r, "old_total_supply"),
    excluded_wallets: wallets as string[],
    excluded_wallet_amount: decimal(r, "excluded_wallet_amount"),
    excluded_manual_amount: decimal(r, "excluded_manual_amount"),
    excluded_amount: decimal(r, "excluded_amount"),
    excluded_note: str(r, "excluded_note"),
    supply_read_at: str(r, "supply_read_at"),
    equity_bps: int(r, "equity_bps"),
    granularity: int(r, "granularity"),
    lot_base_units: decimal(r, "lot_base_units"),
    units_cap: decimal(r, "units_cap"),
    source: oneOf(r, "source", MIGRATION_SOURCES),
    unclaimed_policy: oneOf(r, "unclaimed_policy", UNCLAIMED_POLICIES),
    deposit_owner: str(r, "deposit_owner"),
    deposit_ata: str(r, "deposit_ata"),
    window_opens_at: str(r, "window_opens_at"),
    window_closes_at: str(r, "window_closes_at"),
    terms_doc_sha256: optStr(r, "terms_doc_sha256"),
    terms_doc_url: optStr(r, "terms_doc_url"),
    treasury_wallet: str(r, "treasury_wallet"),
    final_report_sha256: optStr(r, "final_report_sha256"),
    old_tokens_burn_tx: optStr(r, "old_tokens_burn_tx"),
    old_tokens_burned: optDecimal(r, "old_tokens_burned"),
    created_by: str(r, "created_by"),
    opened_at: optStr(r, "opened_at"),
    closed_at: optStr(r, "closed_at"),
    completed_at: optStr(r, "completed_at"),
    cancelled_at: optStr(r, "cancelled_at"),
    created_at: str(r, "created_at"),
    updated_at: str(r, "updated_at"),
  };
}

/** A token_migration_deposits row as DEPOSIT_SELECT reads it, or THROWS RowShapeError. */
export function parseDepositRow(raw: unknown): DepositRow {
  if (!raw || typeof raw !== "object") throw new RowShapeError("row");
  const r = raw as Record<string, unknown>;
  const reason = r.reason_code;
  if (reason !== null && reason !== undefined && !isIrregularReason(reason)) throw new RowShapeError("reason_code");
  return {
    id: str(r, "id"),
    migration_id: str(r, "migration_id"),
    network: str(r, "network"),
    holder_wallet: str(r, "holder_wallet"),
    deposit_tx: str(r, "deposit_tx"),
    deposit_slot: int(r, "deposit_slot"),
    block_time: str(r, "block_time"),
    amount_base: decimal(r, "amount_base"),
    units_due: decimal(r, "units_due"),
    status: oneOf(r, "status", DEPOSIT_STATUSES),
    reason_code: (reason ?? null) as IrregularReason | null,
    reason: optStr(r, "reason"),
    delivery_tx: optStr(r, "delivery_tx"),
    refund_tx: optStr(r, "refund_tx"),
    recorded_via: oneOf(r, "recorded_via", ["holder", "reconcile"] as const),
    delivered_at: optStr(r, "delivered_at"),
    refunded_at: optStr(r, "refunded_at"),
    created_at: str(r, "created_at"),
  };
}

// ── Progress and the public projection ───────────────────────────────────────

export type MigrationProgress = {
  /** Old tokens (base units) in accepted or delivered deposits. */
  depositedBase: string;
  /** Units owed by accepted deposits not delivered yet. */
  unitsDue: string;
  unitsDelivered: string;
  /** Distinct wallets with an accepted or delivered deposit. */
  holders: number;
  /** Deposits recorded, every status. */
  deposits: number;
  /** Deposits waiting for a refund (irregular). */
  refundsDue: number;
  refundedBase: string;
};

export function migrationProgress(deposits: readonly DepositRow[]): MigrationProgress {
  let depositedBase = BigInt(0);
  let unitsDue = BigInt(0);
  let unitsDelivered = BigInt(0);
  let refundedBase = BigInt(0);
  let refundsDue = 0;
  const holders = new Set<string>();
  for (const d of deposits) {
    if (d.status === "accepted" || d.status === "delivered") {
      depositedBase += BigInt(d.amount_base);
      holders.add(d.holder_wallet);
      if (d.status === "accepted") unitsDue += BigInt(d.units_due);
      else unitsDelivered += BigInt(d.units_due);
    }
    if (d.status === "irregular") refundsDue += 1;
    if (d.status === "refunded") refundedBase += BigInt(d.amount_base);
  }
  return {
    depositedBase: depositedBase.toString(),
    unitsDue: unitsDue.toString(),
    unitsDelivered: unitsDelivered.toString(),
    holders: holders.size,
    deposits: deposits.length,
    refundsDue,
    refundedBase: refundedBase.toString(),
  };
}

/** One row of the public proof table: on-chain facts only (no reason a screening produced). */
export type PublicDeposit = {
  holder_wallet: string;
  amount_base: string;
  units_due: string;
  status: DepositStatus;
  /** The public words for an irregular or refunded deposit's reason ("Held for review" for a compliance hold). */
  reason: string | null;
  deposit_tx: string;
  delivery_tx: string | null;
  refund_tx: string | null;
  block_time: string;
};

/** The campaign as the public pages and the public route show it (no operator wallet, no internal note). */
export type PublicMigration = Omit<MigrationRow, "created_by" | "updated_at" | "network"> & {
  progress: MigrationProgress;
  deposits: PublicDeposit[];
};

export function publicDeposit(d: DepositRow): PublicDeposit {
  return {
    holder_wallet: d.holder_wallet,
    amount_base: d.amount_base,
    units_due: d.units_due,
    status: d.status,
    reason: d.reason_code ? PUBLIC_REASON[d.reason_code] : null,
    deposit_tx: d.deposit_tx,
    delivery_tx: d.delivery_tx,
    refund_tx: d.refund_tx,
    block_time: d.block_time,
  };
}

/** Deposits in chain order (slot, then signature): the order of the proof table and of the final report. */
export function chainOrder(a: Pick<DepositRow, "deposit_slot" | "deposit_tx">, b: Pick<DepositRow, "deposit_slot" | "deposit_tx">): number {
  if (a.deposit_slot !== b.deposit_slot) return a.deposit_slot - b.deposit_slot;
  return a.deposit_tx < b.deposit_tx ? -1 : a.deposit_tx > b.deposit_tx ? 1 : 0;
}

export function publicMigration(row: MigrationRow, deposits: readonly DepositRow[]): PublicMigration {
  // The operator's wallet, the row revision and the network stay internal.
  const { created_by: createdBy, updated_at: updatedAt, network, ...facts } = row;
  void createdBy;
  void updatedAt;
  void network;
  return {
    ...facts,
    progress: migrationProgress(deposits),
    deposits: [...deposits].sort(chainOrder).map(publicDeposit),
  };
}
