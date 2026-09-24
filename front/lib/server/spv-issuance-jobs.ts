// SERVER-ONLY — the ledger stage of the retry worker (Talas 5.1, design §5.2):
// spv_issuance_jobs (migration 0073) turned into bookings.
//
//   sale_close     a closed approved sale (the sales mirror's trigger). The
//                  close date is proven once from the chain (the observed
//                  transaction, else a bounded scan of the sale's
//                  signatures, else the observation date, which is never
//                  earlier than the real close). Coverage uses the ONE
//                  predicate (saleCoverage): booked or closed-unsold is done;
//                  a live reservation is consumed and booked; an uncovered
//                  sale is adopted, then booked.
//   treasury_mint  a transaction with mint_to_treasury (the alarm worker).
//                  Every invocation, top-level or inner, is counted once by
//                  its mint key (sig, or sig:<ordinal> when the transaction
//                  holds several): matched to its reservation and booked, or
//                  adopted at the floor value.
//
// A missing EUR rate never drops a fact: the subject is put on hold (no new
// reservation or manual row) and the job waits 30 minutes, again and again,
// until a rate exists. Job rows carry fixed codes only; an exhausted deadline
// stays pending and is never written as a verdict. Effects are written before
// the job is completed, and every effect is idempotent.

import "server-only";
import { address, signature as toSignature } from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  CLOSE_SALE_DISCRIMINATOR,
  OPEN_PAYOUT_VAULT_DISCRIMINATOR,
  SaleStatus,
  getMintToTreasuryInstructionDataDecoder,
  type Sale,
} from "@/lib/generated/asset_registry";
import { detectNetwork } from "@/lib/network";
import { getServerRpc } from "@/lib/server/rpc";
import {
  CapacityError,
  adoptSale,
  adoptedAlert,
  applySale,
  bookTreasuryMintRow,
  bookingFlags,
  clearHold,
  dbU64,
  fetchSale,
  holdForMissingFx,
  isCapacityCode,
  ledgerAlert,
  placeHold,
  resolveSaleSubject,
  resolveSubjectSpv,
  saleCoverage,
  snapshotHash,
  treasuryMintEvidence,
  treasuryMintInvocations,
  utcDate,
  type BookResult,
  type Reservation,
  type TreasuryTx,
} from "@/lib/server/sale-capacity";
import { finalizedTransaction } from "@/lib/server/sale-capacity-chain";
import { intervalSeconds } from "@/lib/server/health";
import { reportIncident } from "@/lib/server/system-alerts";
import { flattenInvocations, resolveAccountKeys, type InvocationTx } from "@/lib/server/tx-invocations";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export type IssuanceJob = {
  id: string;
  network: string;
  kind: "sale_close" | "treasury_mint";
  ref: string;
  share_class_pda: string | null;
  observed_signature: string | null;
  closed_at: string | null;
  closed_signature: string | null;
  issued_at_source: "chain" | "observed" | null;
  status: string;
  attempts: number;
  created_at: string;
};
export type LedgerCounts = { complete: number; pending: number; invalid: number };

type Outcome =
  | { status: "complete"; fields?: Record<string, unknown> }
  | { status: "pending"; code: string; delayMs: number; fields?: Record<string, unknown> }
  | { status: "invalid"; code: string };

const MINUTE = 60_000;
const SALE_FINALITY_WAIT_MS = 60 * MINUTE;
const TREASURY_FINALITY_WAIT_MS = 24 * 60 * MINUTE;
const FX_BLOCKED_DELAY_MS = 30 * MINUTE;
const CLOSE_SCAN_SLACK_SECS = 120;
const CLOSE_SCAN_PAGES = 2;
const CLOSE_SCAN_TX = 6;
const TREASURY_MATCH_SLACK_SECS = 120;
const TREASURY_RELEASED_RECHECK_MS = 24 * 60 * MINUTE;
/** FX_LOCK_DRIFT above this relative rise of a fresh rate over the locked one (D20). */
const FX_DRIFT = 0.02;

const backoff = (attempts: number) => Math.min(MINUTE * 2 ** Math.min(attempts, 10), 60 * MINUTE);
const codeOf = (err: unknown, fallback: string) => {
  const code = err instanceof CapacityError ? err.code : fallback;
  return /^[A-Z_]{1,40}$/.test(code) ? code : fallback;
};
function dbSignal(signal: AbortSignal) {
  return AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
}
const startsWith = (data: Uint8Array, d: ArrayLike<number>) => data.length >= d.length && Array.from(d).every((b, i) => data[i] === b);

// ── sale_close ─────────────────────────────────────────────────────────────

/** Whether `tx` closed `salePda` (close_sale or open_payout_vault, top-level or inner; the sale is account 1). */
export function closesSale(tx: InvocationTx, salePda: string): boolean {
  if (!tx.meta || tx.meta.err !== null) return false;
  let invocations;
  try {
    invocations = flattenInvocations(tx);
  } catch {
    return false;
  }
  return invocations.some((inv) => inv.programId === ASSET_REGISTRY_PROGRAM_ADDRESS && inv.accounts[1] === salePda
    && (startsWith(inv.data, CLOSE_SALE_DISCRIMINATOR) || startsWith(inv.data, OPEN_PAYOUT_VAULT_DISCRIMINATOR)));
}

/** The close date, proven once (design §5.2 step 2). */
export async function proveCloseDate(job: IssuanceJob, signal: AbortSignal): Promise<{ closedAt: string; signature: string | null; source: "chain" | "observed" }> {
  const blockDate = (tx: InvocationTx) => (tx.blockTime == null ? null : new Date(Number(tx.blockTime) * 1000).toISOString());
  if (job.observed_signature) {
    const tx = (await finalizedTransaction(job.observed_signature, signal)) as InvocationTx | null;
    const at = tx && closesSale(tx, job.ref) ? blockDate(tx) : null;
    if (at) return { closedAt: at, signature: job.observed_signature, source: "chain" };
  }
  const limit = Math.floor(Date.parse(job.created_at) / 1000) + CLOSE_SCAN_SLACK_SECS;
  let before: string | undefined;
  let fetched = 0;
  for (let page = 0; page < CLOSE_SCAN_PAGES; page++) {
    const rows = await getServerRpc().getSignaturesForAddress(address(job.ref), {
      commitment: "finalized", limit: 100, ...(before ? { before: toSignature(before) } : {}),
    }).send({ abortSignal: signal });
    for (const row of rows) {
      if (row.err !== null || row.blockTime === null || Number(row.blockTime) > limit || row.signature === job.observed_signature) continue;
      if (fetched >= CLOSE_SCAN_TX) break;
      fetched++;
      const tx = (await finalizedTransaction(row.signature, signal)) as InvocationTx | null;
      if (tx && closesSale(tx, job.ref)) {
        return { closedAt: blockDate(tx) ?? new Date(Number(row.blockTime) * 1000).toISOString(), signature: row.signature, source: "chain" };
      }
    }
    if (rows.length < 100 || fetched >= CLOSE_SCAN_TX) break;
    before = rows[rows.length - 1]?.signature;
  }
  // Never earlier than the real close: conservative for the rolling window.
  return { closedAt: job.created_at, signature: null, source: "observed" };
}

type FxRow = { kind: string; eur_per_token: string | number; as_of: string; max_age: string };

async function fxRow(sb: SupabaseClient, mint: string, signal: AbortSignal): Promise<FxRow | null> {
  const { data, error } = await sb.from("fx_rates").select("kind,eur_per_token,as_of,max_age")
    .eq("network", detectNetwork()).eq("payment_mint", mint).abortSignal(dbSignal(signal)).maybeSingle();
  if (error) return null;
  return (data as FxRow | null) ?? null;
}

export function fxStale(row: FxRow | null, now = Date.now()): boolean {
  if (!row || row.kind !== "rate") return false;
  const maxAge = intervalSeconds(row.max_age);
  return maxAge === null || now - Date.parse(row.as_of) >= maxAge * 1000;
}

/** After a booking at a locked `rate`: a fresh current rate more than 2% above it (D20). */
async function lockDrift(sb: SupabaseClient, booked: BookResult, signal: AbortSignal) {
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

/** A stale current rate was used to adopt: hold for revaluation and raise fx-stale (high). */
async function holdIfStaleAdoption(sb: SupabaseClient, adopted: Reservation, signal: AbortSignal) {
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

async function processSaleClose(sb: SupabaseClient, job: IssuanceJob, signal: AbortSignal): Promise<Outcome> {
  const sale = await fetchSale(job.ref, "finalized", signal);
  const age = Date.now() - Date.parse(job.created_at);
  if (!sale) {
    if (age < SALE_FINALITY_WAIT_MS) return { status: "pending", code: "NOT_FINALIZED", delayMs: MINUTE };
    await ledgerAlert(sb, { sale_pda: job.ref, network: job.network }, "SALE_MISSING", "high",
      `Closed sale ${job.ref} is not on the finalized chain (sales are never closed on-chain)`, "once", {}, signal);
    return { status: "invalid", code: "SALE_MISSING" };
  }
  if (sale.status !== SaleStatus.Closed) return { status: "pending", code: "NOT_CLOSED", delayMs: 5 * MINUTE };

  const fields: Record<string, unknown> = {};
  let closedAt = job.closed_at;
  if (!closedAt) {
    const proof = await proveCloseDate(job, signal);
    closedAt = proof.closedAt;
    Object.assign(fields, { closed_at: proof.closedAt, closed_signature: proof.signature, issued_at_source: proof.source });
    // Persist the proof at once: the booking reads it (book_sale_reservation v2).
    const { error } = await sb.from("spv_issuance_jobs").update(fields).eq("id", job.id).abortSignal(dbSignal(signal));
    if (error) return { status: "pending", code: "DB_UNAVAILABLE", delayMs: backoff(job.attempts) };
  }
  const issuedAt = new Date(closedAt).toISOString().slice(0, 10);

  let row = (await saleCoverage(sb, [job.ref], signal)).get(job.ref) ?? null;
  if (row && (row.status === "booked" || row.status === "released")) {
    await clearHold(sb, row.subject, job.ref, signal);
    return { status: "complete", fields: { ...fields, spv_id: row.spv_id, subject: row.subject, reservation_id: row.id } };
  }
  if (row && row.approval_pda !== sale.saleApproval) {
    await ledgerAlert(sb, row, "OTHER_APPROVAL", "high", "A closed sale consumed another approval than its reservation's",
      { approval: sale.saleApproval }, { consumed_approval: sale.saleApproval }, signal);
    return { status: "pending", code: "OTHER_APPROVAL", delayMs: FX_BLOCKED_DELAY_MS, fields };
  }
  if (!row) {
    const resolved = await resolveSaleSubject(sb, sale, signal);
    let adopted;
    try {
      adopted = await adoptSale(sb, job.ref, sale, signal, resolved);
    } catch (err) {
      if (isCapacityCode(err, "FX_RATE_MISSING")) {
        await holdForMissingFx(sb, resolved.subject, job.ref, sale.paymentMint, signal);
        return { status: "pending", code: "FX_RATE_MISSING", delayMs: FX_BLOCKED_DELAY_MS,
          fields: { ...fields, spv_id: resolved.spvId, subject: resolved.subject } };
      }
      throw err;
    }
    await adoptedAlert(sb, adopted, `Closed sale ${job.ref} had no reservation`, signal);
    await holdIfStaleAdoption(sb, adopted, signal);
    await clearHold(sb, adopted.subject, job.ref, signal);
    row = adopted;
  }
  const booked = await applySale(sb, row, sale as Sale, signal, issuedAt);
  await lockDrift(sb, booked, signal);
  const done = booked.status === "booked" || (booked.status === "released" && booked.release_reason === "closed_unsold");
  const linked = { spv_id: booked.spv_id, subject: booked.subject, reservation_id: booked.id };
  if (!done) return { status: "pending", code: booked.book_error ? "BOOK_REFUSED" : "NOT_BOOKED", delayMs: backoff(job.attempts), fields: { ...fields, ...linked } };
  await clearHold(sb, booked.subject, job.ref, signal);
  return { status: "complete", fields: { ...fields, ...linked } };
}

// ── treasury_mint ──────────────────────────────────────────────────────────

async function processTreasuryMint(sb: SupabaseClient, job: IssuanceJob, signal: AbortSignal): Promise<Outcome> {
  const tx = (await finalizedTransaction(job.ref, signal)) as TreasuryTx | null;
  const age = Date.now() - Date.parse(job.created_at);
  if (!tx) {
    // It was seen finalized: the node is behind.
    return age < TREASURY_FINALITY_WAIT_MS
      ? { status: "pending", code: "RPC_UNAVAILABLE", delayMs: backoff(job.attempts) }
      : { status: "invalid", code: "NOT_FINALIZED" };
  }
  if (!tx.meta || tx.meta.err !== null) return { status: "complete" };
  if (tx.transaction.signatures[0] !== job.ref) return { status: "invalid", code: "SIGNATURE_MISMATCH" };
  const mints = treasuryMintInvocations(tx);
  const keys = resolveAccountKeys(tx);
  const blockTime = tx.blockTime == null ? null : Number(tx.blockTime);
  const issuedAt = utcDate(blockTime) ?? new Date(job.created_at).toISOString().slice(0, 10);
  let pending: Outcome | null = null;
  let last: { reservation: string | null; subject: string | null; spv: string | null } = { reservation: null, subject: null, spv: null };
  for (const inv of mints) {
    let amount: bigint;
    try {
      amount = getMintToTreasuryInstructionDataDecoder().decode(inv.data).amount;
    } catch {
      return { status: "invalid", code: "MALFORMED_TRANSACTION" };
    }
    const [authority, , issuer, asset, shareClass, , destination] = inv.accounts;
    const owner = (tx.meta.postTokenBalances ?? []).find((b) => Number(b.accountIndex) === keys.indexOf(destination))?.owner;
    // Into an escrow (not the authority's own account): not a treasury issuance.
    if (!owner || owner !== authority) continue;
    const mintKey = mints.length === 1 ? job.ref : `${job.ref}:${inv.ordinal}`;
    const { data: existing, error } = await sb.from("sale_capacity_reservations").select("id,subject,spv_id")
      .eq("network", detectNetwork()).eq("mint_signature", mintKey).abortSignal(dbSignal(signal)).maybeSingle();
    if (error) return { status: "pending", code: "DB_UNAVAILABLE", delayMs: backoff(job.attempts) };
    if (existing) {
      last = { reservation: existing.id as string, subject: existing.subject as string, spv: (existing.spv_id as string | null) ?? null };
      continue;
    }
    if (mints.length === 1 && blockTime !== null) {
      const matched = await matchReservation(sb, tx, job.ref, { shareClass, authority, amount, blockTime }, signal);
      if (matched) {
        const booked = await bookTreasuryMintRow(sb, matched.id, job.ref, signal, issuedAt);
        await bookingFlags(sb, booked, signal);
        last = { reservation: booked.id, subject: booked.subject, spv: booked.spv_id };
        if (booked.status !== "booked") pending = { status: "pending", code: "BOOK_REFUSED", delayMs: backoff(job.attempts) };
        continue;
      }
    }
    const spvId = await resolveSubjectSpv(sb, asset, issuer, false, signal);
    const subject = spvId ? `spv:${spvId}` : `issuer:${issuer}`;
    const snapshot = {
      v: 1, kind: "adopted_treasury_mint", network: detectNetwork(), share_class: shareClass, asset, issuer, authority,
      amount_units: amount.toString(), mint_key: mintKey, block_time: blockTime === null ? null : String(blockTime),
    };
    const { data: adoptedData, error: adoptError } = await sb.rpc("adopt_treasury_mint", {
      p_network: detectNetwork(), p_share_class_pda: shareClass, p_asset_pda: asset, p_issuer_pda: issuer, p_spv_id: spvId,
      p_amount_units: amount.toString(), p_mint_key: mintKey, p_authority: authority, p_issued_at: issuedAt,
      p_snapshot: snapshot, p_hash: snapshotHash(snapshot).hex,
    }).abortSignal(dbSignal(signal));
    if (adoptError) {
      if ((adoptError.message ?? "").startsWith("FX_RATE_MISSING")) {
        const { data: floor } = await sb.rpc("treasury_mint_floor", {
          p_network: detectNetwork(), p_share_class_pda: shareClass, p_amount_units: amount.toString(),
        }).abortSignal(dbSignal(signal));
        const mint = typeof (floor as { payment_mint?: unknown } | null)?.payment_mint === "string"
          ? (floor as { payment_mint: string }).payment_mint : null;
        await holdForMissingFx(sb, subject, mintKey, mint, signal);
        pending = { status: "pending", code: "FX_RATE_MISSING", delayMs: FX_BLOCKED_DELAY_MS };
        continue;
      }
      return { status: "pending", code: "LEDGER_UNAVAILABLE", delayMs: backoff(job.attempts) };
    }
    const adopted = adoptedData as Reservation & { action: string; basis: string; fx_stale: boolean; over_cap: boolean; payment_mint?: string };
    last = { reservation: adopted.id, subject: adopted.subject, spv: adopted.spv_id };
    if (adopted.action === "adopted") {
      await ledgerAlert(sb, adopted, "UNRESERVED_MINT", adopted.over_cap || adopted.basis === "minimum" ? "critical" : "high",
        `A treasury mint nobody reserved was counted at its floor value (basis ${adopted.basis})${adopted.over_cap ? " — the subject is now OVER its raise cap" : ""}. The super admin can re-value it on the Raise limits page.`,
        { mint_key: mintKey }, { mint_key: mintKey, basis: adopted.basis, over_cap: adopted.over_cap, fx_stale: adopted.fx_stale }, signal);
      if (adopted.fx_stale) await placeHold(sb, adopted.subject, adopted.id, "FX_REVALUE", adopted.payment_mint ?? null, signal);
    }
    await clearHold(sb, subject, mintKey, signal);
  }
  if (pending) return pending;
  return { status: "complete", fields: { reservation_id: last.reservation, subject: last.subject, spv_id: last.spv } };
}

/** The reservation a single-mint transaction stands for (design §5.2 treasury step 4). */
async function matchReservation(
  sb: SupabaseClient, tx: TreasuryTx, sig: string,
  expected: { shareClass: string; authority: string; amount: bigint; blockTime: number }, signal: AbortSignal,
): Promise<Reservation | null> {
  const { data, error } = await sb.from("sale_capacity_reservations").select("*")
    .eq("network", detectNetwork()).eq("kind", "treasury_mint").eq("share_class_pda", expected.shareClass)
    .eq("reserved_by", expected.authority).in("status", ["reserved", "released"])
    .lte("created_at", new Date((expected.blockTime + TREASURY_MATCH_SLACK_SECS) * 1000).toISOString())
    .order("created_at", { ascending: false }).limit(10).abortSignal(dbSignal(signal));
  if (error) throw new CapacityError("LEDGER_UNAVAILABLE", 503, "Ledger unavailable");
  const now = Date.now();
  for (const r of (data ?? []) as Reservation[]) {
    if (r.mint_signature) continue;
    if (r.status === "released" && (!r.released_at || now - Date.parse(r.released_at) > TREASURY_RELEASED_RECHECK_MS)) continue;
    try {
      if (dbU64(r.amount_units) !== expected.amount) continue;
      treasuryMintEvidence(tx, sig, { shareClass: expected.shareClass, authority: expected.authority, amount: expected.amount });
      return r;
    } catch {
      continue;
    }
  }
  return null;
}

// ── Queue ──────────────────────────────────────────────────────────────────

async function finish(sb: SupabaseClient, job: IssuanceJob, outcome: Outcome, signal: AbortSignal) {
  const base = { attempts: job.attempts + 1 };
  const update = outcome.status === "complete"
    ? { ...base, ...outcome.fields, status: "complete", last_error: null }
    : outcome.status === "invalid"
      ? { ...base, status: "invalid", last_error: outcome.code }
      : { ...base, ...outcome.fields, last_error: outcome.code, next_attempt_at: new Date(Date.now() + outcome.delayMs).toISOString() };
  const { error } = await sb.from("spv_issuance_jobs").update(update).eq("id", job.id).neq("status", "complete")
    .abortSignal(dbSignal(signal));
  if (error) throw new Error("Ledger queue unavailable");
}

export async function processIssuanceJob(
  sb: SupabaseClient, job: IssuanceJob, signal: AbortSignal, deadlineMs: number,
): Promise<"complete" | "pending" | "invalid"> {
  if (job.network !== detectNetwork()) throw new Error("Ledger job belongs to another network");
  if (signal.aborted || Date.now() >= deadlineMs) return "pending";
  let outcome: Outcome;
  try {
    outcome = job.kind === "sale_close" ? await processSaleClose(sb, job, signal) : await processTreasuryMint(sb, job, signal);
  } catch (err) {
    if (signal.aborted || Date.now() >= deadlineMs) return "pending";
    outcome = { status: "pending", code: codeOf(err, "RPC_UNAVAILABLE"), delayMs: backoff(job.attempts) };
  }
  if (signal.aborted || Date.now() >= deadlineMs) return "pending";
  await finish(sb, job, outcome, signal);
  return outcome.status;
}

/** Due jobs of this network, oldest due first (limit 1–20), until the deadline. */
export async function reconcileIssuanceJobs(limit: number, deadlineMs: number, signal: AbortSignal): Promise<LedgerCounts> {
  const counts: LedgerCounts = { complete: 0, pending: 0, invalid: 0 };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Ledger limit must be between 1 and 20");
  if (signal.aborted || Date.now() >= deadlineMs) return counts;
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("spv_issuance_jobs").select("*")
    .eq("network", detectNetwork()).eq("status", "pending").lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at").limit(limit).abortSignal(dbSignal(signal));
  if (signal.aborted) return counts;
  if (error) throw new Error("Ledger queue unavailable");
  for (const job of (data ?? []) as IssuanceJob[]) {
    if (signal.aborted || Date.now() >= deadlineMs) break;
    try {
      counts[await processIssuanceJob(sb, job, signal, deadlineMs)]++;
    } catch {
      if (signal.aborted) break;
      counts.pending++;
    }
  }
  return counts;
}

/** At most `max` FX revaluations of held rows (revalue_capacity_fx never lowers a value). */
export async function revalueHeldRows(max: number, signal: AbortSignal): Promise<number> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("sale_capacity_holds").select("ref")
    .eq("network", detectNetwork()).eq("code", "FX_REVALUE").order("created_at").limit(max).abortSignal(dbSignal(signal));
  if (error) throw new Error("Capacity holds unavailable");
  let revalued = 0;
  for (const { ref } of (data ?? []) as { ref: string }[]) {
    if (signal.aborted) break;
    if (!/^[0-9a-f-]{36}$/i.test(ref)) continue;
    const { error: revalueError } = await sb.rpc("revalue_capacity_fx", { p_id: ref }).abortSignal(dbSignal(signal));
    // FX_RATE_STALE / FX_RATE_MISSING: the rate is not fresh yet; the hold stays.
    if (!revalueError) revalued++;
  }
  return revalued;
}

/** The retry worker's third stage: the jobs, then up to 5 FX revaluations. */
export async function reconcileLedger(limit = 10, deadlineMs = Date.now() + 10_000, parentSignal?: AbortSignal): Promise<LedgerCounts> {
  const budget = deadlineMs - Date.now();
  if (budget <= 0 || parentSignal?.aborted) return { complete: 0, pending: 0, invalid: 0 };
  const timeout = AbortSignal.timeout(budget);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const counts = await reconcileIssuanceJobs(limit, deadlineMs, signal);
  if (!signal.aborted && Date.now() < deadlineMs) {
    try {
      counts.complete += await revalueHeldRows(5, signal);
    } catch {
      counts.pending++;
    }
  }
  return counts;
}
