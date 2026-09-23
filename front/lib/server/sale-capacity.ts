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
  getBase58Encoder,
  signature as toSignature,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  MINT_TO_TREASURY_DISCRIMINATOR,
  RaiseType,
  SaleStatus,
  fetchMaybeSale,
  fetchMaybeSaleApproval,
  fetchMaybeShareClass,
  getMintToTreasuryInstructionDataDecoder,
  type Sale,
  type SaleApproval,
} from "@/lib/generated/asset_registry";
import { detectNetwork } from "@/lib/network";
import { findSalePda } from "@/lib/pdas";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { listLiveApprovals, readApprovalAndSale, type LiveApproval } from "@/lib/server/sale-capacity-chain";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const U64_MAX = BigInt("18446744073709551615");
/** Mirrors SALE_APPROVAL_MAX_TTL_SECS in the program. */
export const SALE_APPROVAL_MAX_TTL_SECS = 7_776_000;
/** Unconfirmed reservations younger than this are left to the admin's browser. */
const CONFIRM_GRACE_MS = 5 * 60_000;
/** Chain clock drift allowance before an expired approval's reservation is released. */
const EXPIRY_GRACE_SECS = 3_600;

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

/** Maps the 0066 functions' P0001 messages onto readable route errors. */
export function capacityError(error: { code?: string; message?: string } | null | undefined): SiwsError {
  const message = error?.message ?? "";
  if (error?.code === "P0001") {
    const cap = /SALE_CAP_EXCEEDED remaining=([\d.]+) cap=([\d.]+) window_start=(\S+)/.exec(message);
    if (cap) {
      return new SiwsError(409, `This approval would exceed the ${eur(cap[2])} limit over the last 12 months: only ${eur(cap[1])} remains.`);
    }
    const amount = /APPLICATION_AMOUNT_EXCEEDED amount=([\d.]+) raise_amount=([\d.]+)/.exec(message);
    if (amount) {
      return new SiwsError(409, `The approved maximum (${eur(amount[1])}) is above the application's raise amount (${eur(amount[2])}). Adjust the application's terms first.`);
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
      APPLICATION_ALREADY_APPROVED: [409, "This application already backs a sale approval or a sale. One application backs one sale: revoke the live approval first, or ask for a new application."],
    };
    for (const [code, [status, text]] of Object.entries(known)) {
      if (message.startsWith(code)) return new SiwsError(status, text);
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
export const bookReservation = (sb: SupabaseClient, id: string, gross: bigint, signal?: AbortSignal) =>
  rpcCall<Reservation & { book_error?: string }>(sb, "book_sale_reservation", { p_id: id, p_gross_base_units: gross.toString(), p_issued_at: null }, signal);
export const releaseReservation = (sb: SupabaseClient, id: string, reason: string, by: string | null, signal?: AbortSignal) =>
  rpcCall<Reservation>(sb, "release_sale_reservation", { p_id: id, p_reason: reason, p_by: by }, signal);

export async function saleCapacity(sb: SupabaseClient, subject: string) {
  return rpcCall<Record<string, unknown>>(sb, "sale_capacity", { p_network: detectNetwork(), p_subject: subject });
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
async function applySale(sb: SupabaseClient, r: Reservation, sale: Sale, signal?: AbortSignal): Promise<Reservation & { book_error?: string }> {
  let current: Reservation & { book_error?: string; grew?: boolean } = r;
  if (current.status === "reserved") {
    current = await consumeReservation(sb, r.id, r.sale_pda!, sale.pricePerUnit * sale.totalForSale, signal);
    // The chain allowed more than was reserved: counted at the sale's size.
    if (current.grew) await alert(sb, r, current.last_error ?? "The sale is larger than its reservation");
  }
  if (current.status === "consumed" && sale.status === SaleStatus.Closed) {
    current = await bookReservation(sb, r.id, sale.sold * sale.pricePerUnit, signal);
  }
  return current;
}

/**
 * Settles one sale from its FINALIZED on-chain state: finds the reservation
 * by the approval the sale consumed, marks it consumed and, once the sale is
 * Closed, books what was sold. Idempotent.
 */
export async function settleSale(sb: SupabaseClient, salePda: string, signal?: AbortSignal) {
  const sale = await fetchSale(salePda, "finalized", signal);
  if (!sale) throw new SiwsError(409, "The sale is not finalized on-chain yet; try again shortly");
  const r = await findReservationByApproval(sb, sale.saleApproval, signal);
  if (!r) throw new SiwsError(409, "No reservation matches this sale's approval");
  if (r.sale_pda !== salePda) throw new SiwsError(409, "The reservation belongs to another sale");
  return { sale, reservation: await applySale(sb, r, sale, signal) };
}

// ── Treasury-mint evidence ─────────────────────────────────────────────────

type CompiledIx = { programIdIndex: number | bigint; accounts: readonly (number | bigint)[]; data: string };
type TokenBalance = { accountIndex: number | bigint; mint: string; owner?: string };
export type TreasuryTx = {
  transaction: { signatures: readonly string[]; message: { accountKeys: readonly string[]; header: { numRequiredSignatures: number | bigint }; instructions: readonly CompiledIx[] } };
  meta: null | { err: unknown; postTokenBalances?: readonly TokenBalance[] | null; loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } };
};

/**
 * Proves a finalized transaction ran exactly one top-level `mint_to_treasury`
 * of `amount` units of `shareClass` signed by `authority` into a token account
 * OWNED by that authority (the treasury path).
 */
export function treasuryMintEvidence(tx: TreasuryTx, sig: string, expected: { shareClass: string; authority: string; amount: bigint }) {
  if (!tx.meta || tx.meta.err !== null) throw new SiwsError(400, "Transaction did not complete successfully");
  if (tx.transaction.signatures[0] !== sig) throw new SiwsError(400, "Transaction signature does not match");
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const signers = new Set(tx.transaction.message.accountKeys.slice(0, Number(tx.transaction.message.header.numRequiredSignatures)));
  const matches = tx.transaction.message.instructions.filter((ix) => {
    if (keys[Number(ix.programIdIndex)] !== ASSET_REGISTRY_PROGRAM_ADDRESS) return false;
    const data = getBase58Encoder().encode(ix.data);
    return MINT_TO_TREASURY_DISCRIMINATOR.every((b, i) => data[i] === b);
  });
  if (matches.length !== 1) throw new SiwsError(400, "The transaction must contain exactly one treasury mint");
  const ix = matches[0];
  const account = (i: number) => keys[Number(ix.accounts[i])];
  // MintToTreasury accounts: 0 authority, 1 admin_record, 2 issuer, 3 asset,
  // 4 share_class, 5 mint, 6 destination, 7 token_program, 8 platform.
  const { amount } = getMintToTreasuryInstructionDataDecoder().decode(getBase58Encoder().encode(ix.data));
  if (account(0) !== expected.authority || !signers.has(expected.authority)) throw new SiwsError(400, "The treasury mint was signed by another key");
  if (account(4) !== expected.shareClass) throw new SiwsError(400, "The treasury mint is for another share class");
  if (amount !== expected.amount) throw new SiwsError(400, "The minted amount does not match the reservation");
  const destinationIndex = keys.indexOf(account(6));
  const balance = (tx.meta.postTokenBalances ?? []).find((b) => Number(b.accountIndex) === destinationIndex);
  if (!balance || balance.owner !== expected.authority) throw new SiwsError(400, "The destination is not the issuer treasury");
  return { destination: account(6), mint: account(5) };
}

export async function finalizedTreasuryTx(sig: string, signal?: AbortSignal): Promise<TreasuryTx> {
  let tx;
  try {
    tx = await getServerRpc().getTransaction(toSignature(sig), {
      commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0,
    }).send({ abortSignal: chainSignal(signal) });
  } catch {
    throw new SiwsError(503, "Transaction verification unavailable; try again");
  }
  if (!tx) throw new SiwsError(409, "The transaction is not finalized yet; try again shortly");
  return tx as unknown as TreasuryTx;
}

// ── Retry-worker stage ─────────────────────────────────────────────────────

/** Compliance alert, raised once per distinct message (not on every worker run). */
async function alert(sb: SupabaseClient, r: Pick<Reservation, "id" | "network" | "approval_pda" | "subject" | "last_error">, message: string) {
  console.error(`[sale-capacity] reservation ${r.id}: ${message}`);
  if (r.last_error === message.slice(0, 2000)) return;
  await sb.from("sale_capacity_reservations").update({ last_error: message.slice(0, 2000) }).eq("id", r.id);
  await sb.from("audit_events").insert({
    network: r.network, ix_name: "sale_capacity_alert", category: "launchpad", actor_wallet: "server",
    target_label: r.approval_pda ?? r.id, reason: message.slice(0, 1000), status: "failed",
    metadata: { reservation_id: r.id, subject: r.subject, actor_verified: false, actor_source: "retry-worker" },
  });
}

type Adopted = Reservation & { action: "none" | "adopted_terms" | "reactivated" | "inserted"; over_cap: boolean };

/**
 * Counts an on-chain approval at its ON-CHAIN terms (0066
 * adopt_sale_approval): a live reservation with other terms takes them, a
 * released one is reactivated, and an approval nobody reserved gets a row.
 * The chain is the truth; the cap is only reported (over_cap), never refused.
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
    let query = sb.from("asset_profiles").select("spv_id").eq("network", detectNetwork()).eq("asset_pda", asset);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    if (error) throw capacityError(error);
    spvId = (data?.spv_id as string | null | undefined) ?? null;
    salePda = await findSalePda(a.shareClass, a.saleId);
  }
  return rpcCall<Adopted>(sb, "adopt_sale_approval", {
    p_network: detectNetwork(), p_share_class_pda: a.shareClass, p_sale_id: a.saleId.toString(), p_approval_pda: approvalPda,
    p_sale_pda: salePda, p_asset_pda: asset, p_issuer_pda: a.issuer, p_spv_id: spvId, p_payment_mint: a.paymentMint,
    p_max_gross_raise: a.maxGrossRaise.toString(), p_min_price_per_unit: a.minPricePerUnit.toString(),
    p_max_price_per_unit: a.maxPricePerUnit.toString(), p_raise_type: raiseTypeName(a.raiseType),
    p_cliff_months: a.cliffMonths, p_vesting_months: a.vestingMonths,
    p_expires_at: new Date(Number(a.expiresAt) * 1000).toISOString(), p_application_hash: hexOf(a.applicationHash),
    p_approved_by: a.approvedBy, p_source: source,
  }, signal);
}

const adoptionMessage = (what: string, adopted: Adopted) =>
  `${what}: counted at the on-chain terms (${adopted.action})${adopted.over_cap ? " — the subject is now OVER its raise cap" : ""}. Revoke the approval if it is not intended.`;

/**
 * Orphan scan: every on-chain SaleApproval must have a live reservation. An
 * Admin can call approve_sale on the program directly, and a reservation can
 * be released while its transaction is still in flight; the program does not
 * know the off-chain cap, so this is its safety net.
 */
async function adoptOrphanApprovals(sb: SupabaseClient, signal: AbortSignal, counts: { complete: number; pending: number; invalid: number }) {
  const approvals: LiveApproval[] = await listLiveApprovals(signal);
  if (!approvals.length) return;
  const { data, error } = await sb.from("sale_capacity_reservations").select("approval_pda")
    .eq("network", detectNetwork()).eq("kind", "sale").in("status", ["reserved", "consumed"])
    .in("approval_pda", approvals.map((a) => a.address)).abortSignal(signal);
  if (error) throw new SiwsError(503, "Sale capacity ledger unavailable");
  const live = new Set((data ?? []).map((row) => row.approval_pda as string));
  for (const a of approvals) {
    if (live.has(a.address) || signal.aborted) continue;
    const adopted = await adoptApproval(sb, a, a.address, null, "orphan-scan", signal);
    await alert(sb, adopted, adoptionMessage("An on-chain sale approval had no live reservation", adopted));
    counts.pending++;
  }
}

/** One reservation's next step from chain state; returns "complete" once nothing is left to do. */
async function reconcileOne(sb: SupabaseClient, r: Reservation, signal: AbortSignal): Promise<"complete" | "pending"> {
  const now = Date.now();
  if (r.status === "consumed") {
    const sale = await fetchSale(r.sale_pda!, "finalized", signal);
    if (!sale) return "pending";
    const done = await applySale(sb, r, sale, signal);
    if (done.book_error) await alert(sb, r, `Booking refused: ${done.book_error}`);
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
      await alert(sb, adopted, adoptionMessage(`On-chain approval differs from its reservation (${fields.join(", ")})`, adopted));
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
      await alert(sb, r, "A sale exists for this id but consumed a different approval");
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

/** Retry-worker stage: the orphan scan, then a bounded batch of live sale reservations, least recently touched first. */
export async function reconcileSaleCapacity(limit = 10, deadlineMs = Date.now() + 20_000, parentSignal?: AbortSignal) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new SiwsError(400, "Retry limit must be between 1 and 20");
  const counts = { complete: 0, pending: 0, invalid: 0 };
  const budgetMs = Math.min(20_000, deadlineMs - Date.now());
  if (budgetMs <= 0 || parentSignal?.aborted) return counts;
  const timeout = AbortSignal.timeout(budgetMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const sb = getSupabaseAdmin();
  try {
    await adoptOrphanApprovals(sb, signal, counts);
  } catch (err) {
    if (signal.aborted) return counts;
    console.error("[sale-capacity] orphan scan failed:", err instanceof Error ? err.message : err);
    counts.pending++;
  }
  const { data, error } = await sb.from("sale_capacity_reservations").select("*")
    .eq("network", detectNetwork()).eq("kind", "sale").in("status", ["reserved", "consumed"])
    .order("updated_at").limit(limit).abortSignal(signal);
  if (signal.aborted) return counts;
  if (error) throw new SiwsError(503, "Sale capacity ledger unavailable");
  for (const row of (data ?? []) as Reservation[]) {
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
