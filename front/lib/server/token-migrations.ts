// SERVER-ONLY — the database side of the token migration routes
// (app/api/token-migrations): parameter narrowing (manual, no zod), the
// network-scoped reads, and the one path that records a deposit from a
// finalized transaction (shared by the holder's own record and the
// operator's reconcile). Both tables are service-role only (migration 0085);
// every call here runs behind a signed route or the public read route.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isAddress } from "@solana/kit";
import { ChainEvidenceError, type ChainTransaction } from "@/lib/chain-evidence";
import { detectNetwork } from "@/lib/network";
import { readFinalizedTransaction, transactionSignature } from "@/lib/server/chain-evidence";
import { reportSanctionsHits } from "@/lib/server/sanctions";
import { SiwsError } from "@/lib/server/siws";
import { classifyDeposit, depositEvidence } from "@/lib/token-migration/evidence";
import {
  IRREGULAR_REASON_TEXT,
  UUID_RE,
  validSlug,
  type IrregularReason,
} from "@/lib/token-migration/model";
import {
  DEPOSIT_SELECT,
  MIGRATION_SELECT,
  parseDepositRow,
  parseMigrationRow,
  RowShapeError,
  type DepositRow,
  type MigrationRow,
} from "@/lib/token-migration/rows";
import { U64_MAX } from "@/lib/token-migration/ratio";

export const MIGRATIONS = "token_migrations";
export const DEPOSITS = "token_migration_deposits";

// ── Parameters ───────────────────────────────────────────────────────────────

export function uuidParam(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new SiwsError(400, `${field} must be an id`);
  return value;
}

export function addressText(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAddress(value)) throw new SiwsError(400, `${field} must be a valid address`);
  return value;
}

export function slugParam(value: unknown): string {
  if (typeof value !== "string" || !validSlug(value)) {
    throw new SiwsError(400, "slug must be 3–64 lowercase letters, digits and single hyphens");
  }
  return value;
}

export function textParam(value: unknown, field: string, opts: { min: number; max: number }): string {
  if (typeof value !== "string") throw new SiwsError(400, `${field} is required`);
  const text = value.trim();
  if (text.length < opts.min || text.length > opts.max) {
    throw new SiwsError(400, `${field} must be ${opts.min}–${opts.max} characters`);
  }
  return text;
}

/** A positive integer sent as decimal digits (or a safe integer), at most `max`. */
export function positiveIntegerParam(value: unknown, field: string, max: bigint = U64_MAX): bigint {
  let n: bigint | null = null;
  if (typeof value === "string" && /^[1-9]\d{0,19}$/.test(value)) n = BigInt(value);
  else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) n = BigInt(value);
  if (n === null || n < BigInt(1) || n > max) throw new SiwsError(400, `${field} must be a whole number between 1 and ${max.toString()}`);
  return n;
}

/** A non-negative amount of base units sent as decimal digits (at most u64::MAX). */
export function baseUnitsParam(value: unknown, field: string): bigint {
  if (value === undefined || value === null || value === "") return BigInt(0);
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value) || BigInt(value) > U64_MAX) {
    throw new SiwsError(400, `${field} must be a whole number of base units`);
  }
  return BigInt(value);
}

/** An ISO-8601 instant, returned normalized (toISOString). */
export function instantParam(value: unknown, field: string): string {
  const ms = typeof value === "string" && value.length <= 40 ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new SiwsError(400, `${field} must be a date and time`);
  return new Date(ms).toISOString();
}

/** 0–`max` distinct addresses. */
export function addressListParam(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new SiwsError(400, `${field} must be a list of at most ${max} addresses`);
  return [...new Set(value.map((v) => addressText(v, field)))];
}

/** 1–`max` distinct ids. */
export function idListParam(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new SiwsError(400, `${field} must be a list of 1–${max} ids`);
  const ids = value.map((v) => uuidParam(v, field));
  if (new Set(ids).size !== ids.length) throw new SiwsError(400, `${field} lists an id twice`);
  return ids;
}

export function signatureParam(value: unknown): string {
  return transactionSignature(value);
}

// ── Database errors ──────────────────────────────────────────────────────────

type DbError = { message?: string; code?: string } | null | undefined;

const RPC_REFUSALS: Array<[string, number, string]> = [
  ["MIGRATION_NOT_FOUND", 404, "This token migration does not exist on this network"],
  ["MIGRATION_NOT_RECORDING", 409, "This campaign is not recording deposits (it is a draft or already completed)"],
  ["DEPOSIT_TX_OTHER_MIGRATION", 409, "This transaction is already recorded for another campaign"],
  ["DELIVERY_TX_ALREADY_RECORDED", 409, "This transaction is already recorded as the delivery of other deposits"],
  ["DELIVERY_DEPOSITS_NOT_ACCEPTED", 409, "Some of these deposits are no longer waiting for delivery: reload the campaign"],
  ["MIGRATION_NOT_DELIVERING", 409, "Deliveries are recorded while the campaign is open or closed"],
  ["REFUND_TX_ALREADY_RECORDED", 409, "This transaction is already recorded as the refund of other deposits"],
  ["REFUND_DEPOSITS_NOT_REFUNDABLE", 409, "These deposits cannot be refunded together: one holder's irregular deposits (or, in a cancelled campaign, accepted ones) only. Reload the campaign"],
  ["MIGRATION_NOT_REFUNDING", 409, "Refunds are recorded while the campaign is open, closed or cancelled"],
  ["DEPOSIT_BEFORE_OPENING", 400, "This transfer happened before the campaign opened, so it is not one of its deposits"],
];

/**
 * Maps a database refusal onto a SiwsError: the recording functions' codes,
 * a guard trigger's own sentence (written for the operator, 409), a unique
 * violation (409), anything else a 500 whose detail stays in the log.
 */
export function dbFailure(error: DbError, context: string): never {
  const message = error?.message ?? "";
  for (const [code, status, text] of RPC_REFUSALS) if (message.includes(code)) throw new SiwsError(status, text);
  if (error?.code === "23514" && message && !/violates check constraint/.test(message)) throw new SiwsError(409, message);
  if (error?.code === "23514") throw new SiwsError(409, `The ${context} breaks a rule of the campaign; reload and check its values`);
  if (error?.code === "23505") throw new SiwsError(409, `The ${context} conflicts with one already recorded`);
  console.error(`[token-migrations] ${context} failed:`, error?.code ?? "no code", message);
  throw new SiwsError(500, `Could not save the ${context}`);
}

function rows<T>(data: unknown, parse: (raw: unknown) => T): T[] {
  try {
    return (Array.isArray(data) ? data : []).map(parse);
  } catch (err) {
    if (err instanceof RowShapeError) {
      console.error("[token-migrations] unexpected row:", err.message);
      throw new SiwsError(500, "Token migration data is unreadable");
    }
    throw err;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function readMigration(sb: SupabaseClient, id: string): Promise<MigrationRow> {
  const { data, error } = await sb.from(MIGRATIONS).select(MIGRATION_SELECT).eq("network", detectNetwork()).eq("id", id).maybeSingle();
  if (error) dbFailure(error, "campaign read");
  if (!data) throw new SiwsError(404, "This token migration does not exist on this network");
  return rows([data], parseMigrationRow)[0];
}

/** A campaign by its public slug (drafts included: the caller decides what to show). */
export async function readMigrationBySlug(sb: SupabaseClient, slug: string): Promise<MigrationRow | null> {
  const { data, error } = await sb.from(MIGRATIONS).select(MIGRATION_SELECT).eq("network", detectNetwork()).eq("slug", slug).maybeSingle();
  if (error) dbFailure(error, "campaign read");
  return data ? rows([data], parseMigrationRow)[0] : null;
}

/** Every campaign of this network, newest first; `publicOnly` leaves drafts out. */
export async function listMigrations(sb: SupabaseClient, opts: { publicOnly: boolean }): Promise<MigrationRow[]> {
  let query = sb.from(MIGRATIONS).select(MIGRATION_SELECT).eq("network", detectNetwork());
  if (opts.publicOnly) query = query.in("status", ["open", "closed", "completed", "cancelled"]);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(200);
  if (error) dbFailure(error, "campaign list");
  return rows(data, parseMigrationRow);
}

/** The deposits of the given campaigns (chain order is the caller's: rows.ts chainOrder). */
/** Rows one read returns at most: PostgREST caps every answer (max_rows, supabase/config.toml). */
const PAGE = 1000;
/** A campaign's deposits stop being read past this many (a flood of dust deposits would otherwise exhaust a route). */
const MAX_DEPOSIT_ROWS = 50_000;

/**
 * The deposits of the given campaigns, every one of them: read in pages of
 * PAGE rows in id order until a short page (PostgREST answers at most its
 * max_rows, so one unpaged read would silently stop at the first thousand).
 * Chain order is the caller's (rows.ts chainOrder).
 */
export async function readDeposits(sb: SupabaseClient, migrationIds: readonly string[]): Promise<DepositRow[]> {
  if (migrationIds.length === 0) return [];
  const out: DepositRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from(DEPOSITS)
      .select(DEPOSIT_SELECT)
      .eq("network", detectNetwork())
      .in("migration_id", [...migrationIds])
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) dbFailure(error, "deposit list");
    const page = rows(data, parseDepositRow);
    out.push(...page);
    if (page.length < PAGE) return out;
    if (out.length >= MAX_DEPOSIT_ROWS) throw new SiwsError(503, "This campaign has more deposits than one request can read; contact the operator");
  }
}

/** Units of accepted and delivered deposits: what the cap has left is units_cap minus this. */
export function unitsTaken(deposits: readonly DepositRow[]): bigint {
  return deposits.reduce((sum, d) => (d.status === "accepted" || d.status === "delivered" ? sum + BigInt(d.units_due) : sum), BigInt(0));
}

async function readDepositByTx(sb: SupabaseClient, signature: string): Promise<DepositRow | null> {
  const { data, error } = await sb.from(DEPOSITS).select(DEPOSIT_SELECT).eq("network", detectNetwork()).eq("deposit_tx", signature).maybeSingle();
  if (error) dbFailure(error, "deposit read");
  return data ? rows([data], parseDepositRow)[0] : null;
}

// ── Recording a deposit ──────────────────────────────────────────────────────

export type RecordedDeposit = { created: boolean; deposit: DepositRow };

/** What the recording refuses for good (not a deposit of this campaign): the reconcile skips these. */
export class NotADepositError extends SiwsError {
  constructor(message: string) {
    super(400, message);
    this.name = "NotADepositError";
  }
}

/**
 * Records the deposit a finalized transaction proves, once:
 *   1. a signature already recorded answers with its row (idempotent; a
 *      holder may only read back its own deposit);
 *   2. the transaction is read at finalized (409 "awaiting finalization"
 *      while it is not, 503 when the node cannot be read) and must prove a
 *      deposit into this campaign's deposit account (lib/token-migration/
 *      evidence.ts; NotADepositError otherwise), from `holder` when one
 *      claims it, made at or after the campaign's opening slot (an older
 *      transfer into the account is not this campaign's);
 *   3. it is classified (window, excluded wallet, signer, lots, memo), and
 *      the depositing wallet is screened report-only (the tokens already
 *      moved): a hit raises the compliance alert and records the deposit as
 *      a compliance hold, neither delivered nor refunded until compliance
 *      decides; a screen that cannot answer where it fails closed (mainnet)
 *      refuses with 503, so nothing is ever accepted unscreened;
 *   4. record_token_migration_deposit inserts it under the campaign's lock
 *      (over the units cap it becomes irregular "over_cap").
 */
export async function recordDepositFromChain(
  sb: SupabaseClient,
  migration: MigrationRow,
  signatureInput: unknown,
  opts: { holder: string | null; via: "holder" | "reconcile" },
): Promise<RecordedDeposit> {
  const signature = signatureParam(signatureInput);
  if (migration.status !== "open" && migration.status !== "closed" && migration.status !== "cancelled") {
    throw new SiwsError(409, "This campaign is not recording deposits (it is a draft or already completed)");
  }
  const existing = await readDepositByTx(sb, signature);
  if (existing) {
    if (existing.migration_id !== migration.id) throw new SiwsError(409, "This transaction is already recorded for another campaign");
    if (opts.holder !== null && existing.holder_wallet !== opts.holder) throw new SiwsError(403, "This deposit was made by another wallet");
    return { created: false, deposit: existing };
  }

  const tx = (await readFinalizedTransaction(signature)) as unknown as ChainTransaction;
  let facts;
  try {
    facts = depositEvidence(tx, signature, { depositAta: migration.deposit_ata, oldMint: migration.old_mint, holder: opts.holder });
  } catch (err) {
    if (err instanceof ChainEvidenceError) throw new NotADepositError(err.message);
    throw err;
  }
  // Nothing that reached the deposit account before the campaign opened is one of its deposits.
  if (migration.opened_slot === null || facts.slot < BigInt(migration.opened_slot)) {
    throw new NotADepositError("This transfer happened before the campaign opened, so it is not one of its deposits");
  }
  if (facts.blockTime === null) {
    throw new SiwsError(503, "The network did not report when this transaction ran; retry recording shortly (do not deposit again)");
  }
  const verdict = classifyDeposit(facts, {
    migrationId: migration.id,
    status: migration.status,
    lot: BigInt(migration.lot_base_units),
    windowOpensAt: migration.window_opens_at,
    windowClosesAt: migration.window_closes_at,
    excludedWallets: migration.excluded_wallets,
  });
  const screen = await reportSanctionsHits(sb, {
    route: "token-migrations/record",
    wallets: [{ wallet: facts.holder, role: "self" }],
    txSignature: signature,
  });
  if (screen.retryLater) {
    throw new SiwsError(503, "Sanctions screening is unavailable right now, so the deposit cannot be recorded yet. It stays in the deposit account: retry recording later and do not deposit again.");
  }
  const reasonCode: IrregularReason | null = screen.hits.includes(facts.holder) ? "compliance_hold" : verdict.reasonCode;
  const { data, error } = await sb.rpc("record_token_migration_deposit", {
    p_migration_id: migration.id,
    p_holder_wallet: facts.holder,
    p_deposit_tx: signature,
    p_deposit_slot: Number(facts.slot),
    p_block_time: new Date(facts.blockTime * 1000).toISOString(),
    p_amount_base: facts.amount.toString(),
    p_lots: verdict.lots >= BigInt(1) ? verdict.lots.toString() : null,
    p_reason_code: reasonCode,
    p_reason: reasonCode ? IRREGULAR_REASON_TEXT[reasonCode] : null,
    p_recorded_via: opts.via,
  });
  if (error?.message?.includes("DEPOSIT_BEFORE_OPENING")) throw new NotADepositError("This transfer happened before the campaign opened, so it is not one of its deposits");
  if (error) dbFailure(error, "deposit");
  const result = data as { created?: unknown } | null;
  const recorded = await readDepositByTx(sb, signature);
  if (!recorded) throw new SiwsError(500, "The deposit was recorded but could not be read back; reload the campaign");
  return { created: result?.created === true, deposit: recorded };
}
