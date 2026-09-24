// SERVER-ONLY — EUR raise-cap reservations behind on-chain sale approvals
// (program package 2B, migration 0066).
//
// Flow (admin): reserve (this DB, under a per-subject lock) → approve_sale
// (wallet) → confirm (the on-chain approval matches the reservation). The
// issuer's open_sale consumes the approval; when the sale closes the server
// books what was actually sold at the FX rate locked at reservation. The
// retry worker (reconcileSaleCapacity) is the backstop for every step a
// browser did not finish.
//
// The application hash committed on-chain is sha256 over the CANONICAL JSON
// of the stored snapshot (keys sorted, u64 values as decimal strings): the
// stored jsonb's own key order is not the hashed order, so a verifier must
// re-canonicalize (canonicalSnapshotJson) before hashing.

import "server-only";
import { createHash } from "node:crypto";
import {
  address,
  isAddress,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  MINT_TO_TREASURY_DISCRIMINATOR,
  RaiseType,
  SaleStatus,
  fetchMaybeAsset,
  fetchMaybeSale,
  fetchMaybeSaleApproval,
  fetchMaybeShareClass,
  getMintToTreasuryInstructionDataDecoder,
  type Sale,
  type SaleApproval,
} from "@/lib/generated/asset_registry";
import { detectNetwork } from "@/lib/network";
import { isAllowedPaymentMint } from "@/lib/payment-mints";
import { findSalePda } from "@/lib/pdas";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  finalizedTransaction,
  listFinalizedSignatures,
  listLiveApprovals,
  readApprovalAndSale,
  type LiveApproval,
} from "@/lib/server/sale-capacity-chain";
import { intervalSeconds } from "@/lib/server/health";
import { raiseSystemAlert, reportIncident, type Severity } from "@/lib/server/system-alerts";
import { flattenInvocations, resolveAccountKeys } from "@/lib/server/tx-invocations";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const U64_MAX = BigInt("18446744073709551615");
/** Mirrors SALE_APPROVAL_MAX_TTL_SECS in the program. */
export const SALE_APPROVAL_MAX_TTL_SECS = 7_776_000;
/** Unconfirmed reservations younger than this are left to the admin's browser. */
const CONFIRM_GRACE_MS = 5 * 60_000;
/** Chain clock drift allowance before an expired approval's reservation is released. */
const EXPIRY_GRACE_SECS = 3_600;
/**
 * A treasury mint is sent right after its reservation, with a recent
 * blockhash (it can land for ~90 s): one with no matching finalized mint
 * after this long is expired by the worker.
 */
const TREASURY_TTL_MS = 30 * 60_000;
/** Released treasury rows are rechecked for a late-found mint for this long, */
const TREASURY_RECHECK_MS = 24 * 3_600_000;
/** at most this often each. */
const TREASURY_RECHECK_EVERY_MS = 10 * 60_000;
/** Block-time slack around a treasury reservation's window. */
const TREASURY_WINDOW_SLACK_SECS = 120;

export type RaiseTypeName = "mature" | "startup";
export const raiseTypeName = (t: RaiseType): RaiseTypeName => (t === RaiseType.Startup ? "startup" : "mature");
export const raiseTypeValue = (t: RaiseTypeName): RaiseType => (t === "startup" ? RaiseType.Startup : RaiseType.Mature);

export type SaleApprovalTerms = {
  shareClass: string;
  saleId: bigint;
  issuer: string;
  paymentMint: string;
  maxGrossRaise: bigint;
  minPricePerUnit: bigint;
  maxPricePerUnit: bigint;
  raiseType: RaiseTypeName;
  /** The payout schedule the sale must use (0/0 for mature). */
  cliffMonths: number;
  vestingMonths: number;
  /** Unix seconds. */
  expiresAt: bigint;
};

export type ApplicationForSnapshot = {
  id: string;
  network: string;
  applicant_wallet: string;
  revision_count: number;
  reviewed_at: string | null;
  company_name: string;
  raise_type: string;
  raise_amount: number | string;
  equity_offered: number | string;
  cliff_months: number;
  vesting_months: number;
};

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Sorted-key JSON with no whitespace. Numbers must be safe integers. */
export function canonicalSnapshotJson(value: unknown): string {
  const walk = (v: unknown): Json => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) throw new Error("Snapshot numbers must be safe integers; use decimal strings");
      return v;
    }
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") {
      const out: { [key: string]: Json } = {};
      for (const k of Object.keys(v as object).sort()) {
        const item = (v as Record<string, unknown>)[k];
        if (item !== undefined) out[k] = walk(item);
      }
      return out;
    }
    throw new Error("Unsupported snapshot value");
  };
  // JSON.stringify keeps insertion order, which walk() made sorted.
  return JSON.stringify(walk(value));
}

function termsSnapshot(network: string, terms: SaleApprovalTerms) {
  return {
    network,
    share_class: terms.shareClass,
    sale_id: terms.saleId.toString(),
    issuer: terms.issuer,
    payment_mint: terms.paymentMint,
    max_gross_raise: terms.maxGrossRaise.toString(),
    min_price_per_unit: terms.minPricePerUnit.toString(),
    max_price_per_unit: terms.maxPricePerUnit.toString(),
    raise_type: terms.raiseType,
    sale_cliff_months: String(terms.cliffMonths),
    sale_vesting_months: String(terms.vestingMonths),
    expires_at: terms.expiresAt.toString(),
  };
}

/** The reviewed application plus the approved on-chain terms (v1). */
export function applicationSnapshot(app: ApplicationForSnapshot, terms: SaleApprovalTerms): Record<string, unknown> {
  return {
    v: 1,
    kind: "application",
    ...termsSnapshot(app.network, terms),
    application_id: app.id,
    applicant_wallet: app.applicant_wallet,
    revision_count: String(app.revision_count),
    reviewed_at: app.reviewed_at,
    company_name: app.company_name,
    application_raise_type: app.raise_type,
    raise_amount: String(app.raise_amount),
    equity_offered: String(app.equity_offered),
    cliff_months: String(app.cliff_months),
    vesting_months: String(app.vesting_months),
  };
}

/** A super-admin approval without an application: the reason is committed. */
export function manualSnapshot(network: string, reason: string, terms: SaleApprovalTerms): Record<string, unknown> {
  return { v: 1, kind: "manual", reason, ...termsSnapshot(network, terms) };
}

export function snapshotHash(snapshot: unknown): { hex: string; bytes: Uint8Array } {
  const digest = createHash("sha256").update(canonicalSnapshotJson(snapshot), "utf8").digest();
  return { hex: digest.toString("hex"), bytes: new Uint8Array(digest) };
}

export const hexOf = (bytes: ReadonlyUint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Parses a non-negative u64 given as a decimal string (or safe integer). */
export function u64Param(value: unknown, field: string, { positive = false } = {}): bigint {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^(0|[1-9]\d{0,19})$/.test(text)) throw new SiwsError(400, `${field} must be a whole number`);
  const n = BigInt(text);
  if (n > U64_MAX || (positive && n === BigInt(0))) throw new SiwsError(400, `${field} is out of range`);
  return n;
}

export function addressParam(value: unknown, field: string): Address {
  try {
    if (typeof value !== "string") throw new Error();
    return address(value);
  } catch {
    throw new SiwsError(400, `${field} must be a valid address`);
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Database ───────────────────────────────────────────────────────────────

export type Reservation = {
  id: string;
  network: string;
  kind: "sale" | "treasury_mint";
  share_class_pda: string;
  sale_id: string | number | null;
  approval_pda: string | null;
  sale_pda: string | null;
  asset_pda: string | null;
  issuer_pda: string;
  spv_id: string | null;
  subject: string;
  application_id: string | null;
  application_snapshot: Record<string, unknown>;
  application_hash: string;
  payment_mint: string | null;
  payment_decimals: number | null;
  max_gross_raise: string | number | null;
  min_price_per_unit: string | number | null;
  max_price_per_unit: string | number | null;
  raise_type: RaiseTypeName | null;
  cliff_months: number | null;
  vesting_months: number | null;
  expires_at: string | null;
  adopted?: boolean;
  amount_units: string | number | null;
  amount_eur: string | number;
  status: "reserved" | "consumed" | "booked" | "released";
  chain_confirmed_at: string | null;
  approve_signature: string | null;
  mint_signature: string | null;
  booked_amount_eur: string | number | null;
  booked_issued_at?: string | null;
  booked_issuance_id?: string | number | null;
  fx_kind?: "eur_peg" | "rate" | "declared" | null;
  fx_rate?: string | number | null;
  fx_as_of?: string | null;
  released_at?: string | null;
  release_reason: string | null;
  reason: string | null;
  last_error: string | null;
  reserved_by: string;
  created_at: string;
  updated_at: string;
};

/** Exact integer from a numeric column (PostgREST may return a number or a string). */
export function dbU64(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) throw new Error("Missing numeric value");
  const text = typeof value === "number" ? (Number.isSafeInteger(value) ? String(value) : value.toFixed(0)) : value;
  if (!/^\d+$/.test(text)) throw new Error("Invalid numeric value");
  return BigInt(text);
}

const eur = (value: string | number) =>
  `€${Number(value).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** A mapped 0066 ledger refusal that keeps its machine code (FX_RATE_MISSING, …). */
export class CapacityError extends SiwsError {
  readonly code: string;
  constructor(code: string, status: number, message: string) {
    super(status, message);
    this.code = code;
  }
}

/** Whether `err` is the mapped ledger refusal `code` (see capacityError). */
export function isCapacityCode(err: unknown, code: string): boolean {
  return err instanceof CapacityError && err.code === code;
}

/** Maps the 0066 functions' P0001 messages onto readable route errors (CapacityError, with the code). */
export function capacityError(error: { code?: string; message?: string } | null | undefined): SiwsError {
  const message = error?.message ?? "";
  if (error?.code === "P0001") {
    const cap = /SALE_CAP_EXCEEDED remaining=([\d.]+) cap=([\d.]+) window_start=(\S+)/.exec(message);
    if (cap) {
      return new CapacityError("SALE_CAP_EXCEEDED", 409, `This would exceed the ${eur(cap[2])} limit over the last 12 months (booked issuances plus live sale approvals and treasury mints): only ${eur(cap[1])} remains.`);
    }
    const floor = /TREASURY_VALUE_BELOW_FLOOR floor=([\d.]+)/.exec(message);
    if (floor) {
      return new CapacityError("TREASURY_VALUE_BELOW_FLOOR", 409, `The declared value is below the floor for these units (${eur(floor[1])}: at least €1, and the units at the share class's latest sale or approved price).`);
    }
    const amount = /APPLICATION_AMOUNT_EXCEEDED amount=([\d.]+) raise_amount=([\d.]+)/.exec(message);
    if (amount) {
      return new CapacityError("APPLICATION_AMOUNT_EXCEEDED", 409, `The approved maximum (${eur(amount[1])}) is above the application's raise amount (${eur(amount[2])}). Adjust the application's terms first.`);
    }
    const known: Record<string, [number, string]> = {
      FX_RATE_MISSING: [409, "There is no EUR rate for this payment mint. Add one on the Raise limits page."],
      FX_RATE_STALE: [409, "The EUR rate for this payment mint is out of date. Update it on the Raise limits page."],
      FX_DECIMALS_MISMATCH: [409, "The EUR rate's decimals do not match the payment mint on-chain."],
      RESERVATION_EXISTS: [409, "This sale id already has a live approval. Revoke it before approving again."],
      APPLICATION_NOT_APPROVED: [409, "The application must be approved on this network."],
      RAISE_TYPE_MISMATCH: [409, "The raise type must match the application."],
      SPV_NOT_FOUND: [409, "The asset's SPV no longer exists."],
      RESERVATION_NOT_RELEASABLE: [409, "Only an unused reservation can be released."],
      RESERVATION_NOT_FOUND: [404, "Reservation not found."],
      RESERVATION_NOT_LIVE: [409, "The reservation is no longer live."],
      RESERVATION_NOT_CONSUMED: [409, "The approval has not been used by a sale yet."],
      RESERVATION_ALREADY_BOOKED: [409, "This reservation was booked with another transaction."],
      SALE_MISMATCH: [409, "The sale does not match the reservation."],
      SALE_EXCEEDS_RESERVATION: [409, "The sale is larger than its reservation."],
      INVALID_TERMS: [400, "Invalid approval terms."],
      INVALID_GROSS: [400, "Invalid sale total."],
      SCHEDULE_MISMATCH: [409, "The cliff and vesting months must match the application."],
      SPV_SUBJECT_CONFLICT: [409, "The asset's SPV does not match the issuer's SPV (spvs.issuer_pda / asset_profiles.spv_id). Fix the SPV registry first: one legal entity has one raise limit."],
      SPV_AMBIGUOUS: [409, "Two SPVs on this network are registered for this issuer. Keep one before approving."],
      MINT_ALREADY_BOOKED: [409, "This mint transaction is already booked by another reservation."],
      INVALID_SIGNATURE: [400, "A transaction signature is required."],
      ISSUED_AT_IN_FUTURE: [400, "issued_at cannot be in the future."],
      ISSUED_AT_BACKDATED: [403, "issued_at more than 30 days back needs the super admin."],
      APPLICATION_ALREADY_APPROVED: [409, "This application already backs a sale approval or a sale. One application backs one sale: revoke the live approval first, or ask for a new application."],
      SUBJECT_ON_HOLD: [409, "The raise limit is on hold until an on-chain sale or mint is counted; update the EUR rate on the Raise limits page."],
      SALE_PUBKEY_NOT_ALLOWED: [400, "A manual adjustment cannot name a sale: sales are booked by the server when they close."],
      REF_IS_SALE: [409, "This reference is an on-chain sale. Sales are booked by the server when they close; record only off-platform issuances here."],
      REVALUE_NOT_ALLOWED: [409, "Only a booked treasury mint that the ledger adopted at its floor value can be re-valued."],
      NO_REVALUE_HOLD: [409, "This row has no pending FX revaluation."],
    };
    for (const [code, [status, text]] of Object.entries(known)) {
      if (message.startsWith(code)) return new CapacityError(code, status, text);
    }
  }
  console.error("[sale-capacity] database error:", error?.code, message.slice(0, 200));
  return new SiwsError(503, "The raise-limit ledger is unavailable; nothing was changed. Try again.");
}

async function rpcCall<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let query = sb.rpc(fn, args);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw capacityError(error);
  return data as T;
}

export async function loadReservation(sb: SupabaseClient, id: string, signal?: AbortSignal): Promise<Reservation> {
  if (!UUID_RE.test(id)) throw new SiwsError(400, "reservation_id must be a UUID");
  let query = sb.from("sale_capacity_reservations").select("*").eq("id", id).eq("network", detectNetwork());
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query.maybeSingle();
  if (error) throw capacityError(error);
  if (!data) throw new SiwsError(404, "Reservation not found");
  return data as Reservation;
}

export async function findReservationByApproval(
  sb: SupabaseClient, approvalPda: string, signal?: AbortSignal,
): Promise<Reservation | null> {
  let query = sb.from("sale_capacity_reservations").select("*")
    .eq("network", detectNetwork()).eq("kind", "sale").eq("approval_pda", approvalPda)
    .in("status", ["reserved", "consumed", "booked"]).order("created_at", { ascending: false }).limit(1);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw capacityError(error);
  return ((data ?? [])[0] as Reservation | undefined) ?? null;
}

export const confirmReservation = (sb: SupabaseClient, id: string, signature: string | null, signal?: AbortSignal) =>
  rpcCall<Reservation>(sb, "confirm_sale_reservation", { p_id: id, p_signature: signature }, signal);
export const consumeReservation = (sb: SupabaseClient, id: string, salePda: string, grossMax: bigint, signal?: AbortSignal) =>
  rpcCall<Reservation & { grew?: boolean }>(sb, "consume_sale_reservation", { p_id: id, p_sale_pda: salePda, p_sale_gross_max: grossMax.toString() }, signal);
export type BookResult = Reservation & {
  book_error?: string; over_cap?: boolean; linked_existing?: boolean; linked_amount_eur?: string | number; amount_mismatch?: boolean;
};
/** Books a consumed sale. `issuedAt` (YYYY-MM-DD, UTC) is the proven close date; without it the SQL takes the ledger job's. */
export const bookReservation = (sb: SupabaseClient, id: string, gross: bigint, signal?: AbortSignal, issuedAt: string | null = null) =>
  rpcCall<BookResult>(sb, "book_sale_reservation", { p_id: id, p_gross_base_units: gross.toString(), p_issued_at: issuedAt }, signal);
export const releaseReservation = (sb: SupabaseClient, id: string, reason: string, by: string | null, signal?: AbortSignal) =>
  rpcCall<Reservation>(sb, "release_sale_reservation", { p_id: id, p_reason: reason, p_by: by }, signal);

export async function saleCapacity(sb: SupabaseClient, subject: string) {
  return rpcCall<Record<string, unknown>>(sb, "sale_capacity", { p_network: detectNetwork(), p_subject: subject });
}

/**
 * The SPV that (asset, issuer) counts against, or null for an issuer subject
 * (0066 sale_capacity_spv): the SPV registered with this issuer_pda, else
 * asset_profiles.spv_id. `strict` (new reservations) refuses a disagreement;
 * adoption (the chain already acted) lets the issuer's own SPV win.
 */
export async function resolveSubjectSpv(
  sb: SupabaseClient, asset: string | null, issuer: string, strict: boolean, signal?: AbortSignal,
): Promise<string | null> {
  const spv = await rpcCall<string | null>(sb, "sale_capacity_spv", {
    p_network: detectNetwork(), p_asset_pda: asset, p_issuer_pda: issuer, p_strict: strict,
  }, signal);
  return typeof spv === "string" && UUID_RE.test(spv) ? spv : null;
}

// ── Chain ──────────────────────────────────────────────────────────────────

function chainSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(12_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function fetchApproval(approvalPda: string, signal?: AbortSignal) {
  const approval = await fetchMaybeSaleApproval(getServerRpc(), address(approvalPda), {
    commitment: "confirmed", abortSignal: chainSignal(signal),
  });
  if (approval.exists && approval.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Unexpected approval owner");
  return approval.exists ? approval.data : null;
}

export async function fetchSale(salePda: string, commitment: "confirmed" | "finalized", signal?: AbortSignal) {
  const sale = await fetchMaybeSale(getServerRpc(), address(salePda), { commitment, abortSignal: chainSignal(signal) });
  if (sale.exists && sale.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Unexpected sale owner");
  return sale.exists ? sale.data : null;
}

/** Every stored term must equal the on-chain approval; returns the differing fields. */
export function approvalMismatches(r: Reservation, a: SaleApproval): string[] {
  const out: string[] = [];
  const check = (field: string, ok: boolean) => { if (!ok) out.push(field); };
  check("share_class", a.shareClass === r.share_class_pda);
  check("sale_id", r.sale_id !== null && a.saleId === dbU64(r.sale_id));
  check("issuer", a.issuer === r.issuer_pda);
  check("payment_mint", a.paymentMint === r.payment_mint);
  check("max_gross_raise", r.max_gross_raise !== null && a.maxGrossRaise === dbU64(r.max_gross_raise));
  check("min_price_per_unit", r.min_price_per_unit !== null && a.minPricePerUnit === dbU64(r.min_price_per_unit));
  check("max_price_per_unit", r.max_price_per_unit !== null && a.maxPricePerUnit === dbU64(r.max_price_per_unit));
  check("raise_type", raiseTypeName(a.raiseType) === r.raise_type);
  check("cliff_months", a.cliffMonths === r.cliff_months);
  check("vesting_months", a.vestingMonths === r.vesting_months);
  check("expires_at", r.expires_at !== null && a.expiresAt === BigInt(Math.floor(Date.parse(r.expires_at) / 1000)));
  check("application_hash", hexOf(a.applicationHash) === r.application_hash);
  check("approved_by", a.approvedBy === r.reserved_by);
  return out;
}

/** Consume (if needed) and book a reservation from the sale's on-chain state. */
export async function applySale(
  sb: SupabaseClient, r: Reservation, sale: Sale, signal?: AbortSignal, issuedAt: string | null = null,
): Promise<BookResult> {
  let current: BookResult & { grew?: boolean } = r;
  if (current.status === "reserved") {
    current = await consumeReservation(sb, r.id, r.sale_pda!, sale.pricePerUnit * sale.totalForSale, signal);
    // The chain allowed more than was reserved: counted at the sale's size.
    if (current.grew) {
      await ledgerAlert(sb, r, "SALE_GREW", "high", current.last_error ?? "The sale is larger than its reservation",
        { max_gross_raise: (sale.pricePerUnit * sale.totalForSale).toString() });
    }
  }
  if (current.status === "consumed" && sale.status === SaleStatus.Closed) {
    current = await bookReservation(sb, r.id, sale.sold * sale.pricePerUnit, signal, issuedAt);
    await bookingFlags(sb, current, signal);
  }
  return current;
}

/**
 * Alerts a booking result needs: refused, over the cap, a linked legacy row,
 * and FX_LOCK_DRIFT after a booking at a locked rate (D20). Every booking path
 * (ledger job, 2B backstop, orphan scans, the manual route) runs it, so the
 * drift check never depends on which of them booked first; its "once" key
 * makes a repeat harmless.
 */
export async function bookingFlags(sb: SupabaseClient, booked: BookResult, signal?: AbortSignal) {
  if (booked.book_error) {
    await ledgerAlert(sb, booked, "BOOK_REFUSED", "high", `Booking refused: ${booked.book_error}`,
      { code: /^[A-Z_]+/.exec(booked.book_error)?.[0] ?? "ERROR" }, {}, signal);
  }
  if (booked.over_cap) {
    await ledgerAlert(sb, booked, "OVER_CAP", "critical", "A server booking took the subject OVER its raise cap (recorded, never refused)",
      { issuance_id: String(booked.booked_issuance_id ?? booked.id) }, {}, signal);
  }
  if (booked.linked_existing) {
    await ledgerAlert(sb, booked, "LINKED_EXISTING", booked.amount_mismatch ? "high" : "medium",
      `The sale was already recorded (legacy row linked, not inserted again)${booked.amount_mismatch ? "; the amounts differ" : ""}`,
      { issuance_id: String(booked.booked_issuance_id ?? "") },
      { linked_amount_eur: String(booked.linked_amount_eur ?? ""), booked_amount_eur: String(booked.booked_amount_eur ?? "") }, signal);
  }
  if (!booked.book_error) {
    try {
      await lockDrift(sb, booked, signal ?? AbortSignal.timeout(8_000));
    } catch {
      console.error("[sale-capacity] FX drift check failed");
    }
  }
}

/**
 * The ONE sale-coverage predicate (design §5.1.2), shared by the ledger jobs
 * and the orphan-sale scan: a reservation of this sale PDA that is reserved,
 * consumed or booked, or released as closed_unsold. Only an uncovered sale
 * is adopted. Returns the covering row per sale PDA.
 */
export async function saleCoverage(sb: SupabaseClient, salePdas: readonly string[], signal?: AbortSignal): Promise<Map<string, Reservation>> {
  const covered = new Map<string, Reservation>();
  if (!salePdas.length) return covered;
  let query = sb.from("sale_capacity_reservations").select("*")
    .eq("network", detectNetwork()).eq("kind", "sale").in("sale_pda", [...salePdas]);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw new SiwsError(503, "Sale capacity ledger unavailable");
  const rank = (r: Reservation) => (r.status === "booked" ? 0 : r.status === "consumed" ? 1 : r.status === "reserved" ? 2 : 3);
  for (const row of (data ?? []) as Reservation[]) {
    if (!row.sale_pda || !salePdas.includes(row.sale_pda)) continue;
    if (row.status === "released" && row.release_reason !== "closed_unsold") continue;
    const current = covered.get(row.sale_pda);
    if (!current || rank(row) < rank(current)) covered.set(row.sale_pda, row);
  }
  return covered;
}

/** FX_LOCK_DRIFT above this relative rise of a fresh rate over the locked one (D20). */
const FX_DRIFT = 0.02;

export type FxRow = { kind: string; eur_per_token: string | number; as_of: string; max_age: string };

export async function fxRow(sb: SupabaseClient, mint: string, signal: AbortSignal): Promise<FxRow | null> {
  const { data, error } = await sb.from("fx_rates").select("kind,eur_per_token,as_of,max_age")
    .eq("network", detectNetwork()).eq("payment_mint", mint).abortSignal(AbortSignal.any([signal, AbortSignal.timeout(8_000)])).maybeSingle();
  if (error) return null;
  return (data as FxRow | null) ?? null;
}

export function fxStale(row: FxRow | null, now = Date.now()): boolean {
  if (!row || row.kind !== "rate") return false;
  const maxAge = intervalSeconds(row.max_age);
  return maxAge === null || now - Date.parse(row.as_of) >= maxAge * 1000;
}

/** After a booking at a locked `rate`: a fresh current rate more than 2% above it (D20). */
export async function lockDrift(sb: SupabaseClient, booked: BookResult, signal: AbortSignal) {
  if (booked.status !== "booked" || booked.fx_kind !== "rate" || !booked.payment_mint || booked.fx_rate == null) return;
  const row = await fxRow(sb, booked.payment_mint, signal);
  if (!row || row.kind !== "rate" || fxStale(row)) return;
  const fresh = Number(row.eur_per_token);
  const locked = Number(booked.fx_rate);
  if (locked > 0 && fresh > locked * (1 + FX_DRIFT)) {
    await ledgerAlert(sb, booked, "FX_LOCK_DRIFT", "medium",
      `Booked at the locked rate ${locked}; the current rate ${fresh} is more than 2% higher`, "once",
      { locked_rate: String(locked), current_rate: String(fresh) }, signal);
  }
}

/**
 * A stale current rate was used to adopt (a closed or open orphan sale, an
 * orphan approval, a job's adoption): hold the row for revaluation
 * (revalue_capacity_fx raises it once a fresh rate exists) and raise
 * fx-stale (high). Only when the row's rate is the current stale row.
 */
export async function holdIfStaleAdoption(sb: SupabaseClient, adopted: Reservation, signal: AbortSignal) {
  if (adopted.fx_kind !== "rate" || !adopted.payment_mint) return;
  const row = await fxRow(sb, adopted.payment_mint, signal);
  if (!row || !fxStale(row) || !adopted.fx_as_of || Date.parse(row.as_of) !== Date.parse(adopted.fx_as_of)) return;
  await placeHold(sb, adopted.subject, adopted.id, "FX_REVALUE", adopted.payment_mint, signal);
  try {
    await reportIncident(sb, {
      check: `fx-stale:${adopted.payment_mint}`, state: "fail", category: "fx", source: "fx:stale", severity: "high",
      summary: `An on-chain sale was counted at an out-of-date EUR rate for ${adopted.payment_mint}; the subject is on hold until the rate is updated.`,
      evidence: { payment_mint: adopted.payment_mint, subject: adopted.subject, reservation_id: adopted.id, fx_stale: true },
    }, signal);
  } catch {
    console.error("[ledger] fx-stale incident failed");
  }
}

// ── Treasury-mint evidence ─────────────────────────────────────────────────

type CompiledIx = { programIdIndex: number | bigint; accounts: readonly (number | bigint)[]; data: string };
type TokenBalance = { accountIndex: number | bigint; mint: string; owner?: string };
export type TreasuryTx = {
  blockTime?: number | bigint | null;
  transaction: { signatures: readonly string[]; message: { accountKeys: readonly string[]; header: { numRequiredSignatures: number | bigint }; instructions: readonly CompiledIx[] } };
  meta: null | {
    err: unknown; postTokenBalances?: readonly TokenBalance[] | null;
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] };
    innerInstructions?: readonly { index: number | bigint; instructions: readonly CompiledIx[] }[] | null;
    logMessages?: readonly string[] | null;
  };
};

const isMintToTreasury = (data: ReadonlyUint8Array) => MINT_TO_TREASURY_DISCRIMINATOR.every((b, i) => data[i] === b);

/** Every mint_to_treasury invocation of a transaction, top-level or inner (a Squads CPI), in execution order. */
export function treasuryMintInvocations(tx: TreasuryTx) {
  let invocations;
  try {
    invocations = flattenInvocations(tx);
  } catch {
    throw new SiwsError(400, "Malformed transaction");
  }
  return invocations.filter((inv) => inv.programId === ASSET_REGISTRY_PROGRAM_ADDRESS && isMintToTreasury(inv.data));
}

/**
 * Proves a finalized transaction ran exactly one `mint_to_treasury` (top-level
 * or inner) of `amount` units of `shareClass` by `authority` into a token
 * account OWNED by that authority (the treasury path). A top-level mint must
 * be signed by the authority in this transaction; an inner one proves it by
 * succeeding (the program's Signer constraint on account 0).
 */
export function treasuryMintEvidence(tx: TreasuryTx, sig: string, expected: { shareClass: string; authority: string; amount: bigint }) {
  if (!tx.meta || tx.meta.err !== null) throw new SiwsError(400, "Transaction did not complete successfully");
  if (tx.transaction.signatures[0] !== sig) throw new SiwsError(400, "Transaction signature does not match");
  const keys = resolveAccountKeys(tx);
  const signers = new Set(tx.transaction.message.accountKeys.slice(0, Number(tx.transaction.message.header.numRequiredSignatures)));
  const matches = treasuryMintInvocations(tx);
  if (matches.length !== 1) throw new SiwsError(400, "The transaction must contain exactly one treasury mint");
  const ix = matches[0];
  const account = (i: number) => ix.accounts[i];
  // MintToTreasury accounts: 0 authority, 1 admin_record, 2 issuer, 3 asset,
  // 4 share_class, 5 mint, 6 destination, 7 token_program, 8 platform.
  let amount: bigint;
  try {
    ({ amount } = getMintToTreasuryInstructionDataDecoder().decode(ix.data));
  } catch {
    throw new SiwsError(400, "Malformed treasury mint");
  }
  if (account(0) !== expected.authority || (!ix.inner && !signers.has(expected.authority))) {
    throw new SiwsError(400, "The treasury mint was signed by another key");
  }
  if (account(4) !== expected.shareClass) throw new SiwsError(400, "The treasury mint is for another share class");
  if (amount !== expected.amount) throw new SiwsError(400, "The minted amount does not match the reservation");
  const destinationIndex = keys.indexOf(account(6));
  const balance = (tx.meta.postTokenBalances ?? []).find((b) => Number(b.accountIndex) === destinationIndex);
  if (!balance || balance.owner !== expected.authority) throw new SiwsError(400, "The destination is not the issuer treasury");
  return { destination: account(6), mint: account(5), inner: ix.inner };
}

/** YYYY-MM-DD (UTC) of a block time in seconds, or null. */
export function utcDate(blockTime: number | bigint | null | undefined): string | null {
  if (blockTime === null || blockTime === undefined) return null;
  const ms = Number(blockTime) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null;
}

export async function finalizedTreasuryTx(sig: string, signal?: AbortSignal): Promise<TreasuryTx> {
  let tx;
  try {
    tx = await finalizedTransaction(sig, signal);
  } catch {
    throw new SiwsError(503, "Transaction verification unavailable; try again");
  }
  if (!tx) throw new SiwsError(409, "The transaction is not finalized yet; try again shortly");
  return tx as TreasuryTx;
}

/**
 * Finds the finalized `mint_to_treasury` a treasury reservation stands for
 * when nobody reported its signature (the browser failed or left): a
 * successful transaction on the share class, between the reservation and
 * `untilMs`, that is exactly one mint of these units by the reserving admin
 * into its own account, and that no other reservation booked. `complete` is
 * false when the share class's history in the window could not all be read.
 */
export async function findTreasuryMint(
  sb: SupabaseClient, r: Pick<Reservation, "network" | "share_class_pda" | "reserved_by" | "amount_units" | "created_at">,
  untilMs: number, signal?: AbortSignal,
): Promise<{ signature: string | null; complete: boolean; blockTime?: number }> {
  const from = Math.floor(Date.parse(r.created_at) / 1000) - TREASURY_WINDOW_SLACK_SECS;
  const to = Math.ceil(untilMs / 1000) + TREASURY_WINDOW_SLACK_SECS;
  const { signatures, complete } = await listFinalizedSignatures(r.share_class_pda, from, to, signal);
  if (!signatures.length) return { signature: null, complete };
  let query = sb.from("sale_capacity_reservations").select("mint_signature")
    .eq("network", r.network).in("mint_signature", signatures.map((s) => s.signature));
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw capacityError(error);
  const booked = new Set((data ?? []).map((row) => row.mint_signature as string));
  const expected = { shareClass: r.share_class_pda, authority: r.reserved_by, amount: dbU64(r.amount_units) };
  let checked = 0;
  for (const { signature, blockTime } of signatures) {
    if (booked.has(signature)) continue;
    // Bounded: a share class sees few transactions around one treasury mint.
    if (++checked > 10) return { signature: null, complete: false };
    const tx = (await finalizedTransaction(signature, signal)) as TreasuryTx | null;
    if (!tx) continue;
    try {
      treasuryMintEvidence(tx, signature, expected);
      return { signature, complete: true, blockTime: tx.blockTime == null ? blockTime : Number(tx.blockTime) };
    } catch (err) {
      if (!(err instanceof SiwsError)) throw err;
    }
  }
  return { signature: null, complete };
}

/** Books a treasury reservation with a verified signature (0073 book_treasury_mint; reactivates a released row).
 * `issuedAt` (YYYY-MM-DD, UTC) is the mint's block date; the SQL clamps it to today. */
export const bookTreasuryMintRow = (sb: SupabaseClient, id: string, signature: string, signal?: AbortSignal, issuedAt: string | null = null) =>
  rpcCall<BookResult & { adopted?: boolean }>(sb, "book_treasury_mint", {
    p_id: id, p_signature: signature, p_issued_at: issuedAt,
  }, signal);

// ── Retry-worker stage ─────────────────────────────────────────────────────

export type LedgerCode =
  | "ADOPTED" | "SALE_GREW" | "TERMS_DIFFER" | "OTHER_APPROVAL" | "BOOK_REFUSED" | "OVER_CAP" | "LINKED_EXISTING"
  | "TREASURY_LATE" | "UNRESERVED_MINT" | "ADOPTION_FAILED" | "REVALUED" | "FX_LOCK_DRIFT" | "SALE_MISSING"
  | "TREASURY_SCAN_INCOMPLETE";

export type LedgerSubject = Partial<Pick<Reservation, "id" | "network" | "approval_pda" | "sale_pda" | "subject" | "last_error"
  | "amount_eur" | "fx_kind" | "kind" | "mint_signature">>;

/** ledger:<reservation id | sale PDA | approval PDA>:<CODE>:<16 hex of sha256(canonical disc)>. */
export function ledgerDedupKey(r: LedgerSubject, code: LedgerCode, disc: unknown): string {
  const key = r.id ?? r.sale_pda ?? r.approval_pda ?? "unknown";
  const hash = createHash("sha256").update(canonicalSnapshotJson(disc), "utf8").digest("hex").slice(0, 16);
  return `ledger:${key}:${code}:${hash}`;
}

/**
 * A ledger alert (design §5.3): the reservation's last_error and an
 * audit_events row once per distinct message (as 2B did), plus a system alert
 * (category ledger, emailed as label and time only) deduplicated by code and
 * a discriminator, so a second distinct adoption of one reservation alerts
 * again while a rerun does not. Evidence never carries application_snapshot.
 * Never throws.
 */
export async function ledgerAlert(
  sb: SupabaseClient, r: LedgerSubject, code: LedgerCode, severity: Severity, message: string, disc: unknown,
  evidence: Record<string, unknown> = {}, signal?: AbortSignal,
) {
  const text = message.slice(0, 2000);
  console.error(`[sale-capacity] ${code} ${r.id ?? r.sale_pda ?? r.approval_pda ?? ""}`);
  try {
    if (r.id && UUID_RE.test(r.id) && r.last_error !== text) {
      await sb.from("sale_capacity_reservations").update({ last_error: text }).eq("id", r.id);
      await sb.from("audit_events").insert({
        network: r.network ?? detectNetwork(), ix_name: "sale_capacity_alert", category: "launchpad", actor_wallet: "server",
        target_label: r.approval_pda ?? r.id, reason: message.slice(0, 1000), status: "failed",
        metadata: { reservation_id: r.id, subject: r.subject, code, actor_verified: false, actor_source: "retry-worker" },
      });
    }
  } catch {
    console.error("[sale-capacity] alert audit write failed");
  }
  try {
    await raiseSystemAlert(sb, {
      dedupKey: ledgerDedupKey(r, code, disc), category: "ledger",
      source: `ledger:${code.toLowerCase().replace(/_/g, "-")}`, severity, summary: message.slice(0, 500),
      evidence: {
        code, reservation_id: r.id ?? null, subject: r.subject ?? null, approval_pda: r.approval_pda ?? null,
        sale_pda: r.sale_pda ?? null, kind: r.kind ?? null, amount_eur: r.amount_eur ?? null, fx_kind: r.fx_kind ?? null,
        ...evidence,
      },
      notify: true,
    }, signal);
  } catch {
    console.error(`[sale-capacity] ${code} system alert failed`);
  }
}

/** Places a capacity hold (0073); never throws. */
export async function placeHold(
  sb: SupabaseClient, subject: string, ref: string, code: "ADOPTION_PENDING" | "FX_REVALUE", paymentMint: string | null,
  signal?: AbortSignal,
) {
  try {
    let q = sb.rpc("place_capacity_hold", {
      p_network: detectNetwork(), p_subject: subject, p_ref: ref, p_code: code, p_payment_mint: paymentMint,
    });
    if (signal) q = q.abortSignal(signal);
    const { error } = await q;
    if (error) console.error("[sale-capacity] hold not placed");
  } catch {
    console.error("[sale-capacity] hold not placed");
  }
}

/** Clears a capacity hold (0073); never throws. */
export async function clearHold(sb: SupabaseClient, subject: string, ref: string, signal?: AbortSignal) {
  try {
    let q = sb.rpc("clear_capacity_hold", { p_network: detectNetwork(), p_subject: subject, p_ref: ref });
    if (signal) q = q.abortSignal(signal);
    await q;
  } catch {
    console.error("[sale-capacity] hold not cleared");
  }
}

/**
 * Clears the holds a counted sale settles: the sale PDA's, and its consumed
 * approval's (an orphan approval that could not be adopted put the hold on
 * the approval PDA; open_sale then closed the approval, so the approval scan
 * never sees it again). Never throws.
 */
export async function clearSaleHolds(sb: SupabaseClient, subject: string, salePda: string, approvalPda: string | null, signal?: AbortSignal) {
  await clearHold(sb, subject, salePda, signal);
  if (approvalPda && approvalPda !== salePda) await clearHold(sb, subject, approvalPda, signal);
}

/** The on-chain fact cannot be counted (no EUR rate): hold the subject and raise fx-missing. Never throws. */
export async function holdForMissingFx(
  sb: SupabaseClient, subject: string, ref: string, paymentMint: string | null, signal?: AbortSignal,
) {
  await placeHold(sb, subject, ref, "ADOPTION_PENDING", paymentMint, signal);
  if (!paymentMint) return;
  try {
    await reportIncident(sb, {
      check: `fx-missing:${paymentMint}`, state: "fail", category: "fx", source: "fx:missing", severity: "high",
      summary: `An on-chain sale or mint paid in ${paymentMint} cannot be counted: there is no EUR rate. New raises of the subject are on hold.`,
      evidence: { payment_mint: paymentMint, subject, ref },
    }, signal);
  } catch {
    console.error("[sale-capacity] fx-missing incident failed");
  }
}

type Adopted = Reservation & { action: "none" | "adopted_terms" | "reactivated" | "inserted"; over_cap: boolean };

/**
 * Counts an on-chain approval at its ON-CHAIN terms (0066
 * adopt_sale_approval): a live reservation with other terms takes them, a
 * released one is reactivated, and an approval nobody reserved gets a row.
 * The chain is the truth; the cap is only reported (over_cap), never refused.
 * Every adoption path (orphan scan, worker, confirm) raises the payment-mint
 * alarm here: when the ledger cannot count the chain's mint (no EUR rate;
 * the error is rethrown) and, on mainnet, when the counted mint is not
 * allowlisted.
 */
export async function adoptApproval(
  sb: SupabaseClient, a: SaleApproval, approvalPda: string, row: Reservation | null, source: string, signal?: AbortSignal,
): Promise<Adopted> {
  let asset = row?.asset_pda ?? null;
  let spvId = row?.spv_id ?? null;
  let salePda = row?.sale_pda ?? null;
  if (!row) {
    const sc = await fetchMaybeShareClass(getServerRpc(), a.shareClass, { commitment: "confirmed", abortSignal: chainSignal(signal) });
    if (!sc.exists || sc.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Approval share class not found");
    asset = sc.data.asset;
    spvId = await resolveSubjectSpv(sb, asset, a.issuer, false, signal);
    salePda = await findSalePda(a.shareClass, a.saleId);
  }
  let adopted: Adopted;
  try {
    adopted = await rpcCall<Adopted>(sb, "adopt_sale_approval", {
      p_network: detectNetwork(), p_share_class_pda: a.shareClass, p_sale_id: a.saleId.toString(), p_approval_pda: approvalPda,
      p_sale_pda: salePda, p_asset_pda: asset, p_issuer_pda: a.issuer, p_spv_id: spvId, p_payment_mint: a.paymentMint,
      p_max_gross_raise: a.maxGrossRaise.toString(), p_min_price_per_unit: a.minPricePerUnit.toString(),
      p_max_price_per_unit: a.maxPricePerUnit.toString(), p_raise_type: raiseTypeName(a.raiseType),
      p_cliff_months: a.cliffMonths, p_vesting_months: a.vestingMonths,
      p_expires_at: new Date(Number(a.expiresAt) * 1000).toISOString(), p_application_hash: hexOf(a.applicationHash),
      p_approved_by: a.approvedBy, p_source: source,
    }, signal);
  } catch (err) {
    if (isCapacityCode(err, "FX_RATE_MISSING")) {
      await raisePaymentMintAlarm(sb, {
        network: detectNetwork(), key: approvalPda, paymentMint: a.paymentMint, approvedBy: a.approvedBy, reason: "fx_rate_missing",
      }, signal);
    }
    throw err;
  }
  await alarmIfNotAllowlisted(sb, approvalPda, a.paymentMint, a.approvedBy, signal);
  return adopted;
}

const adoptionMessage = (what: string, adopted: Adopted) =>
  `${what}: counted at the on-chain terms (${adopted.action})${adopted.over_cap ? " — the subject is now OVER its raise cap" : ""}. Revoke the approval if it is not intended.`;

/** Alert statuses that still need a decision (as /api/compliance/open-wallets). */
const UNRESOLVED_ALERT_STATUSES = ["open", "escalated"] as const;

export type PaymentMintAlarm = {
  network: string;
  /** The approval (or sale) PDA the alarm is about; with `reason`, the dedup key. */
  key: string;
  paymentMint: string;
  approvedBy: string | null;
  /** fx_rate_missing: no EUR rate, so the chain's approval cannot be counted;
   *  not_allowlisted: counted, but with a mint mainnet does not allow. */
  reason: "fx_rate_missing" | "not_allowlisted";
};

/**
 * A compliance alert (source "sale-capacity", severity high) for an on-chain
 * approval or sale whose payment mint the ledger cannot, or should not,
 * count (Talas 4.2 §3.5). One unresolved (open or escalated) alert per key
 * and reason: a later run skips the insert while one is unresolved (the
 * retry-worker lease serializes runs), and an open "fx_rate_missing" alert
 * never hides the "not_allowlisted" one raised once a hand-inserted rate
 * lets the approval be counted. The alert has no subject wallet: it is about
 * an approval, not a person, so the approving admin never becomes an AML
 * subject (passport gate, client export); the approver is in the evidence.
 * Never throws; returns whether a row was written.
 */
export async function raisePaymentMintAlarm(sb: SupabaseClient, input: PaymentMintAlarm, signal?: AbortSignal): Promise<boolean> {
  try {
    let existing = sb.from("compliance_alerts").select("id")
      .eq("network", input.network).eq("source", "sale-capacity").in("status", [...UNRESOLVED_ALERT_STATUSES])
      .eq("evidence->>key", input.key).eq("evidence->>reason", input.reason).limit(1);
    if (signal) existing = existing.abortSignal(signal);
    const { data, error } = await existing;
    if (error) {
      console.error("[sale-capacity] payment-mint alarm: could not read open alerts");
      return false;
    }
    if (Array.isArray(data) && data.length > 0) return false;
    const what = input.reason === "fx_rate_missing"
      ? "has no EUR rate, so it is not counted against the raise cap"
      : "is not an allowed mainnet payment token";
    const approvedBy = input.approvedBy && isAddress(input.approvedBy) ? input.approvedBy : null;
    const { error: insertError } = await sb.from("compliance_alerts").insert({
      network: input.network,
      source: "sale-capacity",
      severity: "high",
      wallet: null,
      evidence: { kind: "unknown_payment_mint", key: input.key, payment_mint: input.paymentMint, reason: input.reason, approved_by: approvedBy },
      summary: `On-chain sale approval or sale ${input.key}${approvedBy ? ` (approved by ${approvedBy})` : ""}: payment mint ${input.paymentMint} ${what}. Revoke it, or add the payment token's EUR rate if it is intended.`,
    });
    if (insertError) {
      console.error("[sale-capacity] payment-mint alarm: insert failed");
      return false;
    }
    console.error(`[sale-capacity] payment-mint alarm (${input.reason}) for ${input.key}`);
    return true;
  } catch {
    console.error("[sale-capacity] payment-mint alarm failed");
    return false;
  }
}

/** Mainnet: an adopted approval or sale whose mint is not allowlisted (e.g. a hand-inserted FX row). */
async function alarmIfNotAllowlisted(sb: SupabaseClient, key: string, paymentMint: string, approvedBy: string | null, signal?: AbortSignal) {
  const network = detectNetwork();
  if (network === "mainnet" && !isAllowedPaymentMint(network, paymentMint)) {
    await raisePaymentMintAlarm(sb, { network, key, paymentMint, approvedBy, reason: "not_allowlisted" }, signal);
  }
}

/** Orphan approvals that may fail in one run; the rest are tried next run. */
export const MAX_FAILED_ORPHAN_APPROVALS = 5;

/** The keys among `keys` with an unresolved sale-capacity alert; empty when unknown (ordering only). */
async function alertedKeys(sb: SupabaseClient, keys: string[], signal: AbortSignal): Promise<Set<string>> {
  try {
    const { data, error } = await sb.from("compliance_alerts").select("evidence")
      .eq("network", detectNetwork()).eq("source", "sale-capacity").in("status", [...UNRESOLVED_ALERT_STATUSES])
      .in("evidence->>key", keys).abortSignal(signal);
    if (error || !Array.isArray(data)) return new Set();
    return new Set(data.map((row) => (row as { evidence?: { key?: unknown } }).evidence?.key)
      .filter((key): key is string => typeof key === "string"));
  } catch {
    return new Set();
  }
}

/**
 * `list` in address order (getProgramAccounts has no stable order), rotated
 * to start at `minute * step`: a start that moves on by `step` each minute.
 * A group that gets at least `step` failed tries every run therefore has
 * every member tried within ceil(length / step) runs, whichever of them keep
 * failing and for whatever reason.
 */
export function orphanTurn<T extends { address: string }>(list: readonly T[], minute: number, step: number): T[] {
  if (!list.length) return [];
  const sorted = [...list].sort((x, y) => (x.address < y.address ? -1 : x.address > y.address ? 1 : 0));
  const turn = (minute * step) % sorted.length;
  return [...sorted.slice(turn), ...sorted.slice(0, turn)];
}

/** The discriminator of an ADOPTED alert: what the chain made the ledger count. */
function adoptionDisc(adopted: Adopted) {
  return {
    action: adopted.action, payment_mint: adopted.payment_mint, max_gross_raise: String(adopted.max_gross_raise ?? ""),
    min_price_per_unit: String(adopted.min_price_per_unit ?? ""), max_price_per_unit: String(adopted.max_price_per_unit ?? ""),
    expires_at: adopted.expires_at, application_hash: adopted.application_hash, approved_by: adopted.reserved_by,
  };
}

/** Raises the ADOPTED ledger alert (critical when the subject is now over its cap). */
export async function adoptedAlert(sb: SupabaseClient, adopted: Adopted, what: string, signal?: AbortSignal) {
  await ledgerAlert(sb, adopted, "ADOPTED", adopted.over_cap ? "critical" : "high", adoptionMessage(what, adopted),
    adoptionDisc(adopted), { action: adopted.action, over_cap: adopted.over_cap }, signal);
}

/** The subject an approval counts against, from the chain (share class → asset) and the SPV registry. */
async function approvalSubject(sb: SupabaseClient, a: SaleApproval, signal?: AbortSignal): Promise<string | null> {
  try {
    const sc = await fetchMaybeShareClass(getServerRpc(), a.shareClass, { commitment: "confirmed", abortSignal: chainSignal(signal) });
    if (!sc.exists || sc.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) return null;
    const spv = await resolveSubjectSpv(sb, sc.data.asset, a.issuer, false, signal);
    return spv ? `spv:${spv}` : `issuer:${a.issuer}`;
  } catch {
    return null;
  }
}

/**
 * Orphan scan: every on-chain SaleApproval must have a live reservation. An
 * Admin can call approve_sale on the program directly, and a reservation can
 * be released while its transaction is still in flight; the program does not
 * know the off-chain cap, so this is its safety net. Each approval is tried
 * on its own: one that cannot be counted (no EUR rate for its payment mint:
 * a compliance alert, raised by adoptApproval, plus a capacity hold on its
 * subject and the fx-missing incident) never blocks the ones behind it; a
 * ledger refusal raises ADOPTION_FAILED. A run stops after
 * MAX_FAILED_ORPHAN_APPROVALS failures, which keeps the stage budget of the
 * stages after this one, and no orphan is starved:
 * - Approvals nobody has been alerted about go first. That is every new
 *   orphan, but also one that keeps failing for another reason (share class
 *   missing, RPC or ledger errors: logged, not alerted), so this group is
 *   rotated too, MAX_FAILED_ORPHAN_APPROVALS - 1 further each minute.
 * - The alerted ones follow, rotated one further each minute. While any
 *   exist, the first group may use only MAX_FAILED_ORPHAN_APPROVALS - 1
 *   failures, so at least one alerted approval is tried every run (e.g. one
 *   whose rate has since been added).
 */
async function adoptOrphanApprovals(sb: SupabaseClient, signal: AbortSignal, counts: { complete: number; pending: number; invalid: number }) {
  const approvals: LiveApproval[] = await listLiveApprovals(signal);
  if (!approvals.length) return;
  const { data, error } = await sb.from("sale_capacity_reservations").select("approval_pda")
    .eq("network", detectNetwork()).eq("kind", "sale").in("status", ["reserved", "consumed"])
    .in("approval_pda", approvals.map((a) => a.address)).abortSignal(signal);
  if (error) throw new SiwsError(503, "Sale capacity ledger unavailable");
  const live = new Set((data ?? []).map((row) => row.approval_pda as string));
  const orphans = approvals.filter((a) => !live.has(a.address));
  if (!orphans.length || signal.aborted) return;
  const alerted = await alertedKeys(sb, orphans.map((a) => a.address), signal);
  const known = orphans.filter((a) => alerted.has(a.address));
  const minute = Math.floor(Date.now() / 60_000);
  const freshStep = MAX_FAILED_ORPHAN_APPROVALS - 1;
  const groups = [
    { list: orphanTurn(orphans.filter((a) => !alerted.has(a.address)), minute, freshStep), failures: known.length ? freshStep : MAX_FAILED_ORPHAN_APPROVALS },
    { list: orphanTurn(known, minute, 1), failures: MAX_FAILED_ORPHAN_APPROVALS },
  ];
  let failed = 0;
  for (const group of groups) {
    for (const a of group.list) {
      if (signal.aborted) return;
      if (failed >= group.failures) break;
      try {
        const adopted = await adoptApproval(sb, a, a.address, null, "orphan-scan", signal);
        await adoptedAlert(sb, adopted, "An on-chain sale approval had no live reservation", signal);
        if (adopted.action !== "none") await holdIfStaleAdoption(sb, adopted, signal);
        await clearHold(sb, adopted.subject, a.address, signal);
        counts.pending++;
      } catch (err) {
        if (signal.aborted) return;
        counts.pending++;
        failed++;
        if (isCapacityCode(err, "FX_RATE_MISSING")) {
          const subject = await approvalSubject(sb, a, signal);
          if (subject) await holdForMissingFx(sb, subject, a.address, a.paymentMint, signal);
        } else if (err instanceof CapacityError) {
          await ledgerAlert(sb, { approval_pda: a.address, network: detectNetwork() }, "ADOPTION_FAILED", "high",
            `An on-chain sale approval could not be counted (${err.code})`, { pda: a.address, code: err.code }, {}, signal);
        } else {
          console.error("[sale-capacity] orphan approval adoption failed", a.address, err instanceof Error ? err.message : err);
        }
      }
    }
  }
}

/**
 * Orphan sales: an indexed Sale v2 whose consumed approval no reservation
 * covers (the shared saleCoverage predicate: a closed-unsold sale IS
 * covered) — opened from an approval made straight on the program and
 * consumed before the approval scan saw it, or from one whose reservation was
 * released while it was still usable. Counted at the sale's own terms (price
 * x total, at the current rate even past the cap), consumed, booked once
 * closed, and alerted. No EUR rate: the subject is put on hold. A few per
 * run; the rest are found again next run. The ledger jobs (0073) handle every
 * closed sale; this scan also covers open ones.
 */
async function adoptOrphanSales(sb: SupabaseClient, signal: AbortSignal, counts: { complete: number; pending: number; invalid: number }) {
  const { data, error } = await sb.from("sales").select("pda,sale_approval")
    .eq("network", detectNetwork()).not("sale_approval", "is", null)
    .order("updated_at", { ascending: false }).limit(200).abortSignal(signal);
  if (error) throw new SiwsError(503, "Sale mirror unavailable");
  const sales = ((data ?? []) as Array<{ pda: unknown; sale_approval: unknown }>)
    .filter((row): row is { pda: string; sale_approval: string } => typeof row.pda === "string" && typeof row.sale_approval === "string");
  if (!sales.length) return;
  const covered = await saleCoverage(sb, sales.map((row) => row.pda), signal);
  let tried = 0;
  for (const row of sales) {
    if (covered.has(row.pda)) continue;
    if (signal.aborted || tried >= 3) return;
    // One orphan that keeps failing (no FX rate, missing SPV…) must not block
    // the ones behind it, and a not-yet-finalized or stale mirror row must not
    // use up this run's adoption attempts.
    let paymentMint: string | null = null;
    let subject: string | null = null;
    try {
      const sale = await fetchSale(row.pda, "finalized", signal);
      // Not finalized yet, or a stale mirror row: the chain decides.
      if (!sale || (await findSalePda(sale.shareClass, sale.saleId)) !== row.pda) continue;
      tried++;
      paymentMint = sale.paymentMint;
      const resolved = await resolveSaleSubject(sb, sale, signal);
      subject = resolved.subject;
      const adopted = await adoptSale(sb, row.pda, sale, signal, resolved);
      await adoptedAlert(sb, adopted, `Sale ${row.pda} was opened from an approval with no live reservation`, signal);
      await alarmIfNotAllowlisted(sb, row.pda, sale.paymentMint, null, signal);
      if (adopted.action !== "none") await holdIfStaleAdoption(sb, adopted, signal);
      await clearSaleHolds(sb, adopted.subject, row.pda, sale.saleApproval, signal);
      await applySale(sb, adopted, sale, signal);
      counts.pending++;
    } catch (error) {
      if (signal.aborted) return;
      if (paymentMint && isCapacityCode(error, "FX_RATE_MISSING")) {
        await raisePaymentMintAlarm(sb, {
          network: detectNetwork(), key: row.pda, paymentMint, approvedBy: null, reason: "fx_rate_missing",
        }, signal);
        if (subject) await holdForMissingFx(sb, subject, row.pda, paymentMint, signal);
      } else if (error instanceof CapacityError) {
        await ledgerAlert(sb, { sale_pda: row.pda, network: detectNetwork() }, "ADOPTION_FAILED", "high",
          `An on-chain sale could not be counted (${error.code})`, { pda: row.pda, code: error.code }, {}, signal);
      } else {
        console.error("[sale-capacity] orphan sale adoption failed", row.pda, error instanceof Error ? error.message : error);
      }
    }
  }
}

export type SaleSubject = { asset: string; issuer: string; spvId: string | null; subject: string };

/** The subject a sale counts against: its share class's asset and issuer at finalized, and the SPV registry (non-strict). */
export async function resolveSaleSubject(sb: SupabaseClient, sale: Pick<Sale, "shareClass">, signal?: AbortSignal): Promise<SaleSubject> {
  const config = { commitment: "finalized" as const, abortSignal: chainSignal(signal) };
  const sc = await fetchMaybeShareClass(getServerRpc(), sale.shareClass, config);
  if (!sc.exists || sc.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Sale share class not found");
  const asset = await fetchMaybeAsset(getServerRpc(), sc.data.asset, config);
  if (!asset.exists || asset.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Sale asset not found");
  const spvId = await resolveSubjectSpv(sb, sc.data.asset, asset.data.issuer, false, signal);
  return { asset: sc.data.asset, issuer: asset.data.issuer, spvId, subject: spvId ? `spv:${spvId}` : `issuer:${asset.data.issuer}` };
}

/** A sale's own terms as an adopted reservation (0066 adopt_sale_approval; the approval is closed). */
export async function adoptSale(
  sb: SupabaseClient, salePda: string, sale: Sale, signal?: AbortSignal, resolved?: SaleSubject,
): Promise<Adopted> {
  const s = resolved ?? await resolveSaleSubject(sb, sale, signal);
  return rpcCall<Adopted>(sb, "adopt_sale_approval", {
    p_network: detectNetwork(), p_share_class_pda: sale.shareClass, p_sale_id: sale.saleId.toString(),
    p_approval_pda: sale.saleApproval, p_sale_pda: salePda, p_asset_pda: s.asset, p_issuer_pda: s.issuer,
    p_spv_id: s.spvId, p_payment_mint: sale.paymentMint, p_max_gross_raise: (sale.pricePerUnit * sale.totalForSale).toString(),
    p_min_price_per_unit: sale.pricePerUnit.toString(), p_max_price_per_unit: sale.pricePerUnit.toString(),
    p_raise_type: raiseTypeName(sale.raiseType), p_cliff_months: sale.cliffMonths, p_vesting_months: sale.vestingMonths,
    // The closed approval's expiry and approver are gone with it.
    p_expires_at: new Date().toISOString(), p_application_hash: hexOf(sale.applicationHash),
    p_approved_by: "unknown (orphan sale)", p_source: "orphan-sale-scan",
  }, signal);
}

/** Whether a mint_to_treasury ledger job of this share class is still pending (0073): its reservation must not expire. */
async function treasuryJobPending(sb: SupabaseClient, shareClass: string, signal: AbortSignal): Promise<boolean> {
  const { data, error } = await sb.from("spv_issuance_jobs").select("id")
    .eq("network", detectNetwork()).eq("kind", "treasury_mint").eq("share_class_pda", shareClass).eq("status", "pending")
    .limit(1).abortSignal(signal);
  // Unknown counts as pending: never expire a reservation on a failed read.
  if (error) return true;
  return Array.isArray(data) && data.length > 0;
}

/**
 * Treasury-mint rows. A reserved row is booked from the chain when its
 * finalized mint is found (the admin used "book with signature" or nobody
 * did), at the mint's block date, and expired once TREASURY_TTL_MS passed
 * with the share class's history fully read, no matching mint and no pending
 * treasury-mint ledger job for the share class. A released row is rechecked
 * for a day, since a mint that landed before its release would otherwise go
 * uncounted.
 */
async function reconcileTreasuryMints(sb: SupabaseClient, signal: AbortSignal, counts: { complete: number; pending: number; invalid: number }) {
  const now = Date.now();
  const touch = (id: string, fields: Record<string, unknown> = {}) =>
    sb.from("sale_capacity_reservations").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id)
      .then(() => undefined, () => undefined);
  const { data, error } = await sb.from("sale_capacity_reservations").select("*")
    .eq("network", detectNetwork()).eq("kind", "treasury_mint").eq("status", "reserved")
    .order("updated_at").limit(5).abortSignal(signal);
  if (error) throw new SiwsError(503, "Sale capacity ledger unavailable");
  for (const r of ((data ?? []) as Reservation[]).filter((x) => x.kind === "treasury_mint" && x.status === "reserved")) {
    if (signal.aborted) return;
    const age = now - Date.parse(r.created_at);
    // The admin may still book it with its signature.
    if (age < CONFIRM_GRACE_MS) continue;
    try {
      const found = await findTreasuryMint(sb, r, now, signal);
      if (found.signature) {
        const booked = await bookTreasuryMintRow(sb, r.id, found.signature, signal, utcDate(found.blockTime));
        await bookingFlags(sb, booked, signal);
        if (booked.book_error) counts.pending++;
        else counts.complete++;
      } else if (age > TREASURY_TTL_MS && found.complete && !(await treasuryJobPending(sb, r.share_class_pda, signal))) {
        // A released row is still rechecked for a day (below).
        await releaseReservation(sb, r.id, "expired", "retry-worker", signal);
        counts.complete++;
      } else {
        if (age > TREASURY_TTL_MS && !found.complete) {
          await ledgerAlert(sb, r, "TREASURY_SCAN_INCOMPLETE", "medium",
            "Treasury mint reservation: the share class's history is too long to scan; book it with its signature or release it by hand", "once", {}, signal);
        }
        counts.pending++;
        await touch(r.id);
      }
    } catch (err) {
      if (signal.aborted) return;
      counts.pending++;
      await touch(r.id, { last_error: `Worker: ${err instanceof Error ? err.message : String(err)}`.slice(0, 2000) });
    }
  }
  const { data: released, error: releasedError } = await sb.from("sale_capacity_reservations").select("*")
    .eq("network", detectNetwork()).eq("kind", "treasury_mint").eq("status", "released")
    .gte("released_at", new Date(now - TREASURY_RECHECK_MS).toISOString())
    .lte("updated_at", new Date(now - TREASURY_RECHECK_EVERY_MS).toISOString())
    .order("updated_at").limit(3).abortSignal(signal);
  if (releasedError) throw new SiwsError(503, "Sale capacity ledger unavailable");
  for (const r of ((released ?? []) as Reservation[]).filter((x) => x.kind === "treasury_mint" && x.status === "released" && x.released_at)) {
    if (signal.aborted) return;
    try {
      const found = await findTreasuryMint(sb, r, Date.parse(r.released_at!), signal);
      if (!found.signature) {
        await touch(r.id);
        continue;
      }
      const booked = await bookTreasuryMintRow(sb, r.id, found.signature, signal, utcDate(found.blockTime));
      await ledgerAlert(sb, booked, "TREASURY_LATE", "high",
        `Treasury mint ${found.signature} landed although its reservation was released (${r.release_reason}): counted again${booked.book_error ? `; booking refused: ${booked.book_error}` : ""}`,
        { mint_key: found.signature }, { mint_signature: found.signature }, signal);
      await bookingFlags(sb, { ...booked, book_error: undefined }, signal);
      counts.pending++;
    } catch (err) {
      if (signal.aborted) return;
      counts.pending++;
      await touch(r.id);
      console.error("[sale-capacity] treasury recheck failed:", err instanceof Error ? err.message : err);
    }
  }
}

/** One reservation's next step from chain state; returns "complete" once nothing is left to do. */
async function reconcileOne(sb: SupabaseClient, r: Reservation, signal: AbortSignal): Promise<"complete" | "pending"> {
  const now = Date.now();
  if (r.status === "consumed") {
    const sale = await fetchSale(r.sale_pda!, "finalized", signal);
    if (!sale) return "pending";
    // The issue date comes from the sale's ledger job (book_sale_reservation v2).
    const done = await applySale(sb, r, sale, signal);
    return done.status === "booked" || done.status === "released" ? "complete" : "pending";
  }
  // reserved
  if (!r.chain_confirmed_at && now - Date.parse(r.created_at) < CONFIRM_GRACE_MS) return "pending";
  // One slot for both accounts: never "approval closed, sale not yet seen".
  const { approval, sale } = await readApprovalAndSale(r.approval_pda!, r.sale_pda!, "confirmed", signal);
  if (approval) {
    const fields = approvalMismatches(r, approval);
    if (fields.length) {
      const adopted = await adoptApproval(sb, approval, r.approval_pda!, r, "worker", signal);
      if (adopted.action !== "none") await holdIfStaleAdoption(sb, adopted, signal);
      await ledgerAlert(sb, adopted, "TERMS_DIFFER", adopted.over_cap ? "critical" : "high",
        adoptionMessage(`On-chain approval differs from its reservation (${fields.join(", ")})`, adopted),
        [...fields].sort(), { fields, action: adopted.action, over_cap: adopted.over_cap }, signal);
      return "pending";
    }
    if (!r.chain_confirmed_at) await confirmReservation(sb, r.id, null, signal);
    // Still unused. An expired approval can no longer be consumed.
    if (Number(approval.expiresAt) + EXPIRY_GRACE_SECS < now / 1000 && !sale) {
      await releaseReservation(sb, r.id, "expired", "retry-worker", signal);
      return "complete";
    }
    return "pending";
  }
  // The approval account is gone: consumed by open_sale, revoked, or never created.
  if (sale) {
    if (sale.saleApproval !== r.approval_pda) {
      await ledgerAlert(sb, r, "OTHER_APPROVAL", "high", "A sale exists for this id but consumed a different approval",
        { approval: sale.saleApproval }, { consumed_approval: sale.saleApproval }, signal);
      return "pending";
    }
    const finalized = await fetchSale(r.sale_pda!, "finalized", signal);
    if (!finalized) return "pending";
    const done = await applySale(sb, r, finalized, signal);
    return done.status === "booked" ? "complete" : "pending";
  }
  // A late landing after this release is caught by the orphan scan (adopted back).
  await releaseReservation(sb, r.id, r.chain_confirmed_at ? "revoked" : "tx_failed", "retry-worker", signal);
  return "complete";
}

/**
 * Retry-worker stage: the orphan approval and sale scans, the treasury-mint
 * rows, then a bounded batch of live sale reservations, least recently
 * touched first.
 */
export async function reconcileSaleCapacity(limit = 10, deadlineMs = Date.now() + 20_000, parentSignal?: AbortSignal) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new SiwsError(400, "Retry limit must be between 1 and 20");
  const counts = { complete: 0, pending: 0, invalid: 0 };
  const budgetMs = Math.min(20_000, deadlineMs - Date.now());
  if (budgetMs <= 0 || parentSignal?.aborted) return counts;
  const timeout = AbortSignal.timeout(budgetMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const sb = getSupabaseAdmin();
  // Safety nets first: what the chain did that the ledger does not know.
  for (const [name, scan] of [
    ["orphan approval scan", adoptOrphanApprovals],
    ["orphan sale scan", adoptOrphanSales],
    ["treasury mint stage", reconcileTreasuryMints],
  ] as const) {
    try {
      await scan(sb, signal, counts);
    } catch (err) {
      if (signal.aborted) return counts;
      console.error(`[sale-capacity] ${name} failed:`, err instanceof Error ? err.message : err);
      counts.pending++;
    }
  }
  const { data, error } = await sb.from("sale_capacity_reservations").select("*")
    .eq("network", detectNetwork()).eq("kind", "sale").in("status", ["reserved", "consumed"])
    .order("updated_at").limit(limit).abortSignal(signal);
  if (signal.aborted) return counts;
  if (error) throw new SiwsError(503, "Sale capacity ledger unavailable");
  for (const row of ((data ?? []) as Reservation[]).filter((r) => r.kind === "sale")) {
    if (signal.aborted || Date.now() >= deadlineMs) break;
    try {
      if ((await reconcileOne(sb, row, signal)) === "complete") counts.complete++;
      else {
        counts.pending++;
        // Rotate: touch the row so the next batch starts with others.
        await sb.from("sale_capacity_reservations").update({ updated_at: new Date().toISOString() }).eq("id", row.id).abortSignal(signal);
      }
    } catch (err) {
      if (signal.aborted) break;
      if (err instanceof SiwsError && err.status < 500) counts.invalid++;
      else counts.pending++;
      // Rotate a failing row too (the touch trigger bumps updated_at), or
      // ten rows that always fail would starve every other reservation.
      const message = `Worker: ${err instanceof Error ? err.message : String(err)}`.slice(0, 2000);
      await sb.from("sale_capacity_reservations").update({ last_error: message, updated_at: new Date().toISOString() })
        .eq("id", row.id).then(() => undefined, () => undefined);
    }
  }
  return counts;
}
