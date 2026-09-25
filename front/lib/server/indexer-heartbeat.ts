// SERVER-ONLY — the indexer freshness heartbeat (0075; design:
// docs/mainnet-readiness/indexer-heartbeat-design.md).
//
// The mirror counts as fresh for 5 minutes after indexer_sync_state.checked_at
// (lib/indexer-freshness.ts). Jobs and the full reconcile move checked_at; on
// a quiet network nothing does, so the site falls back to RPC reads and the
// indexer-backed admin badges go muted. Once per interval the retry worker's
// indexer stage runs this after its job loop: it gathers chain evidence for
// the plan the database handed out, and confirm_indexer_quiet (SQL, under
// the sync-row lock) decides. This module never decides and never throws:
// every failure is a fixed reason code, and a run without evidence leaves
// checked_at alone, so the site keeps reading the chain.
//
// The evidence of one run (quiet network: 4 calls, plus the genesis check of
// the server RPC, whose 30 s cache is cold at a 60-180 s interval):
//   tip       getSlot('confirmed'), read first.
//   listings  per program, getSignaturesForAddress at 'confirmed' with
//             minContextSlot = tip − 75 (a lagging node cannot hide recent
//             transactions), newest first, 20 then 100 rows per page, at most
//             3 pages, down to the plan's floor; or from the plan's cursor
//             when an earlier listing did not reach the floor. Failed rows are
//             sent too (they move the watermark, never block it). A short
//             page stops paging but proves nothing: the SQL requires the
//             OLDEST row to be at or below the floor.
//   sample    getMultipleAccounts at 'finalized' (minContextSlot = the
//             floor) of the mirrored accounts the plan picked; the SQL
//             compares them with the stored raw data, and the context slot (a
//             finalized slot) caps the watermarks.
//   probes    at most 2 finalized getTransaction of the missing signatures
//             the previous confirm named. One that invokes no watched program
//             (it only lists a program ID, or loads it through a lookup table,
//             so it cannot change a program account) is sent as exempt.
// Any RPC error or timeout records RPC_ERROR / RPC_TIMEOUT: the SQL is never
// given a partial listing. Logs carry the reason code only: an RPC error can
// contain the provider URL and its key.

import "server-only";
import { address, signature as toSignature } from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import { detectNetwork, type Network } from "@/lib/network";
import { invokesWatchedProgram } from "@/lib/server/alarm-checks";
import { programDataAddresses } from "@/lib/server/onchain-alarms";
import { getServerRpc } from "@/lib/server/rpc";
import { finalizedTransaction } from "@/lib/server/sale-capacity-chain";
import type { InvocationTx } from "@/lib/server/tx-invocations";
import { getSupabaseAdmin } from "@/lib/supabase-server";

/** asset_registry first, as 0075 indexer_heartbeat_programs() (pinned by a test). */
export const HEARTBEAT_PROGRAMS = [ASSET_REGISTRY_PROGRAM_ADDRESS, TRANSFER_HOOK_PROGRAM_ADDRESS] as const;

export const HEARTBEAT = {
  firstPage: 20, nextPage: 100, maxPages: 3, lagSlots: 75, maxProbes: 2,
  /** Below this before the stage deadline: NO_BUDGET, no DB or RPC call (plan + shortest RPC phase + confirm). */
  minBudgetMs: 7_500,
  /** The RPC phase: at most rpcPhaseMs, never under rpcMinMs, each call at most rpcCallMs. */
  rpcMinMs: 3_000, rpcPhaseMs: 8_000, rpcCallMs: 3_000,
  dbCallMs: 2_000,
} as const;

/** The heartbeat's outcome in the retry worker's response. Reasons are fixed ^[A-Z_]{1,40}$ codes. */
export type Freshness =
  | { status: "bumped" | "would_bump" }
  | { status: "declined"; reason: string; expired?: boolean }
  | { status: "skipped"; reason: "OFF" | "NOT_DUE" | "INDEXER_STAGE" };

type ClientReason = "RPC_ERROR" | "RPC_TIMEOUT" | "NO_BUDGET";
type Row = { signature: string; slot: number; ok: boolean };
type Listing = { program: string; before: string | null; rows: Row[] };
type SampleAccount = { pda: string; owner: string | null; data: string | null };
type Sample = { context_slot: number; accounts: SampleAccount[] };
type Cursor = { signature: string; slot: number };
type Plan = {
  planId: string;
  floors: Record<string, number | null>;
  resume: Record<string, Cursor | null>;
  sample: string[];
  probe: string[];
};
type Planned = { mode: "off" } | { mode: "observe" | "on"; due: false } | ({ mode: "observe" | "on"; due: true } & Plan);
type Db = ReturnType<typeof getSupabaseAdmin>;

const CODE = /^[A-Z_]{1,40}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An RPC answer that cannot be evidence. Never carries RPC text. */
class EvidenceError extends Error {}

const declined = (reason: string): Freshness => ({ status: "declined", reason });
const isSlot = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function slotOf(value: unknown): number {
  if (typeof value !== "bigint" && typeof value !== "number") throw new EvidenceError();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new EvidenceError();
  return n;
}

function dbSignal(deadlineMs: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(HEARTBEAT.dbCallMs, deadlineMs - Date.now())));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

const callSignal = (phase: AbortSignal) => AbortSignal.any([phase, AbortSignal.timeout(HEARTBEAT.rpcCallMs)]);

/** The plan's JSON, checked field by field; null when it is not a plan. */
export function parsePlan(data: unknown): Planned | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.mode === "off") return { mode: "off" };
  if (d.mode !== "observe" && d.mode !== "on") return null;
  if (d.due === false) return { mode: d.mode, due: false };
  if (d.due !== true || typeof d.plan_id !== "string" || !UUID.test(d.plan_id)) return null;
  const floors = d.floors as Record<string, unknown> | null;
  const resume = d.resume as Record<string, unknown> | null;
  if (!floors || typeof floors !== "object" || !resume || typeof resume !== "object") return null;
  const plan: Plan = { planId: d.plan_id, floors: {}, resume: {}, sample: [], probe: [] };
  for (const program of HEARTBEAT_PROGRAMS) {
    const floor = floors[program];
    if (floor !== null && !isSlot(floor)) return null;
    plan.floors[program] = floor;
    const cursor = resume[program] as Record<string, unknown> | null | undefined;
    if (cursor === null) plan.resume[program] = null;
    else if (cursor && typeof cursor.signature === "string" && SIGNATURE.test(cursor.signature) && isSlot(cursor.slot)) {
      plan.resume[program] = { signature: cursor.signature, slot: cursor.slot };
    } else return null;
  }
  if (!Array.isArray(d.sample) || d.sample.length > 100 || !d.sample.every((p) => typeof p === "string" && ADDRESS.test(p))) return null;
  if (!Array.isArray(d.probe) || d.probe.length > HEARTBEAT.maxProbes || !d.probe.every((s) => typeof s === "string" && SIGNATURE.test(s))) return null;
  plan.sample = d.sample as string[];
  plan.probe = d.probe as string[];
  return { mode: d.mode, due: true, ...plan };
}

/**
 * One program's listing, newest first, from the tip (or from `resume`) down
 * to `floor`. Stops at the floor, at a short page or after maxPages; the SQL
 * decides whether it is complete. No floor: one page (nothing can be proven).
 */
async function listProgram(program: string, floor: number | null, resume: Cursor | null, tip: number, phase: AbortSignal): Promise<Listing> {
  const rpc = getServerRpc();
  const rows: Row[] = [];
  const seen = new Set<string>();
  let before = resume?.signature ?? null;
  const pages = floor === null ? 1 : HEARTBEAT.maxPages;
  for (let page = 0; page < pages; page++) {
    const limit = resume || page > 0 ? HEARTBEAT.nextPage : HEARTBEAT.firstPage;
    const answer: unknown = await rpc.getSignaturesForAddress(address(program), {
      commitment: "confirmed", limit, minContextSlot: BigInt(Math.max(0, tip - HEARTBEAT.lagSlots)),
      ...(before ? { before: toSignature(before) } : {}),
    }).send({ abortSignal: callSignal(phase) });
    if (!Array.isArray(answer) || answer.length > limit) throw new EvidenceError();
    for (const entry of answer as unknown[]) {
      const r = entry as { signature?: unknown; slot?: unknown; err?: unknown } | null;
      if (!r || typeof r.signature !== "string" || !SIGNATURE.test(r.signature) || r.err === undefined || seen.has(r.signature)) {
        throw new EvidenceError();
      }
      const slot = slotOf(r.slot);
      // Newest first: a slot that goes up is not one continuous listing.
      if (rows.length && slot > rows[rows.length - 1].slot) throw new EvidenceError();
      seen.add(r.signature);
      rows.push({ signature: r.signature, slot, ok: r.err === null });
    }
    if (answer.length < limit) break;
    const last = rows[rows.length - 1];
    if (floor !== null && last.slot <= floor) break;
    before = last.signature;
  }
  return { program, before: resume?.signature ?? null, rows };
}

/** The planned accounts at finalized, in plan order (the program account alone when none is planned, for the slot). */
async function readSample(pdas: string[], floor: number | null, phase: AbortSignal): Promise<Sample> {
  const keys = pdas.length ? pdas : [ASSET_REGISTRY_PROGRAM_ADDRESS];
  const answer = await getServerRpc().getMultipleAccounts(keys.map((key) => address(key)), {
    encoding: "base64", commitment: "finalized", ...(floor === null ? {} : { minContextSlot: BigInt(floor) }),
  }).send({ abortSignal: callSignal(phase) });
  const a = answer as { context?: { slot?: unknown } | null; value?: unknown } | null;
  if (!a || !a.context || !Array.isArray(a.value) || a.value.length !== keys.length) throw new EvidenceError();
  const values = a.value as unknown[];
  const accounts = pdas.map((pda, i): SampleAccount => {
    const account = values[i] as { owner?: unknown; data?: unknown } | null;
    if (account === null) return { pda, owner: null, data: null };
    const data = account?.data;
    if (!account || typeof account.owner !== "string" || !ADDRESS.test(account.owner) || !Array.isArray(data)
        || data[1] !== "base64" || typeof data[0] !== "string" || data[0].length > 1_400_000 || !BASE64.test(data[0])) {
      throw new EvidenceError();
    }
    return { pda, owner: account.owner, data: data[0] };
  });
  return { context_slot: slotOf(a.context.slot), accounts };
}

/** The probe candidates that invoke no watched program. A failed probe exempts nothing. */
async function probe(signatures: string[], phase: AbortSignal): Promise<string[]> {
  if (!signatures.length) return [];
  const pd = await programDataAddresses();
  const verdicts = await Promise.all(signatures.slice(0, HEARTBEAT.maxProbes).map(async (sig) => {
    try {
      const tx = (await finalizedTransaction(sig, callSignal(phase))) as InvocationTx | null;
      // Not finalized (yet), another transaction, or a watched invocation: not exempt.
      if (!tx || tx.transaction?.signatures?.[0] !== sig) return null;
      return invokesWatchedProgram(tx, pd) ? null : sig;
    } catch {
      return null;
    }
  }));
  return verdicts.filter((sig): sig is string => sig !== null);
}

async function gather(plan: Plan, phase: AbortSignal) {
  const tip = slotOf(await getServerRpc().getSlot({ commitment: "confirmed" }).send({ abortSignal: callSignal(phase) }));
  const [listings, sample, exempt] = await Promise.all([
    Promise.all(HEARTBEAT_PROGRAMS.map((program) => listProgram(program, plan.floors[program], plan.resume[program], tip, phase))),
    readSample(plan.sample, plan.floors[ASSET_REGISTRY_PROGRAM_ADDRESS], phase),
    probe(plan.probe, phase),
  ]);
  return { tip, listings, sample, exempt };
}

function verdict(data: unknown): Freshness {
  const v = data as { outcome?: unknown; reason?: unknown; expired?: unknown } | null;
  if (v?.outcome === "bumped" || v?.outcome === "would_bump") return { status: v.outcome };
  if (v?.outcome === "declined" && typeof v.reason === "string" && CODE.test(v.reason)) {
    return { status: "declined", reason: v.reason, expired: v.expired === true };
  }
  return declined("DB_ERROR");
}

/** A run without evidence: recorded (it never bumps) while there is time to. */
async function recordReason(sb: Db, network: Network, planId: string, code: ClientReason, deadlineMs: number, signal?: AbortSignal) {
  if (deadlineMs - Date.now() >= 500) {
    try {
      await sb.rpc("confirm_indexer_quiet", {
        p_network: network, p_plan_id: planId, p_client_reason: code,
        p_tip_slot: null, p_listings: null, p_sample: null, p_exempt: null,
      }).abortSignal(dbSignal(deadlineMs, signal));
    } catch {
      // Unrecorded: the plan expires and the next due run tries again.
    }
  }
  return declined(code);
}

function timedOut(error: unknown, phase: AbortSignal) {
  return phase.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
}

async function heartbeat(deadlineMs: number, signal?: AbortSignal): Promise<Freshness> {
  if (signal?.aborted || deadlineMs - Date.now() < HEARTBEAT.minBudgetMs) return declined("NO_BUDGET");
  const network = detectNetwork();
  const sb = getSupabaseAdmin();
  let planned: Planned | null = null;
  try {
    const { data, error } = await sb.rpc("indexer_heartbeat_plan", { p_network: network }).abortSignal(dbSignal(deadlineMs, signal));
    if (!error) planned = parsePlan(data);
  } catch {
    planned = null;
  }
  if (!planned) return declined("DB_ERROR");
  if (planned.mode === "off") return { status: "skipped", reason: "OFF" };
  if (!planned.due) return { status: "skipped", reason: "NOT_DUE" };

  const phaseEnd = Math.min(Date.now() + HEARTBEAT.rpcPhaseMs, deadlineMs - HEARTBEAT.dbCallMs - 500);
  if (phaseEnd - Date.now() < HEARTBEAT.rpcMinMs) return recordReason(sb, network, planned.planId, "NO_BUDGET", deadlineMs, signal);
  // `stop` ends the sibling calls once one fails: no read outlives the phase.
  const stop = new AbortController();
  const phase = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(phaseEnd - Date.now()), stop.signal]);
  let evidence: Awaited<ReturnType<typeof gather>>;
  try {
    evidence = await gather(planned, phase);
  } catch (error) {
    const code = timedOut(error, phase) ? "RPC_TIMEOUT" : "RPC_ERROR";
    stop.abort();
    return recordReason(sb, network, planned.planId, code, deadlineMs, signal);
  }
  try {
    const { data, error } = await sb.rpc("confirm_indexer_quiet", {
      p_network: network, p_plan_id: planned.planId, p_client_reason: null, p_tip_slot: evidence.tip,
      p_listings: evidence.listings, p_sample: evidence.sample, p_exempt: evidence.exempt,
    }).abortSignal(dbSignal(deadlineMs, signal));
    return error ? declined("DB_ERROR") : verdict(data);
  } catch {
    return declined("DB_ERROR");
  }
}

/**
 * One heartbeat attempt before `deadlineMs` (the indexer stage's deadline).
 * Never throws; a decline is logged as its code only.
 */
export async function runIndexerHeartbeat(deadlineMs: number, signal?: AbortSignal): Promise<Freshness> {
  let result: Freshness;
  try {
    result = await heartbeat(deadlineMs, signal);
  } catch {
    result = declined("INTERNAL_ERROR");
  }
  if (result.status === "declined") console.error(`[indexer-heartbeat] declined ${result.reason}`);
  return result;
}
