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
// the server RPC, whose 30 s cache is cold at a 60-120 s interval). First, in
// parallel:
//   tip       getSlot('confirmed') (P4: is the node's tip live).
//   sample    getMultipleAccounts at 'finalized' (minContextSlot = the
//             floor) of the mirrored accounts the plan picked plus the Clock
//             sysvar: its context slot F caps the watermarks, and the Clock
//             (checked to be F's) gives F's block time, the time the proof
//             covers. The SQL compares the accounts with the stored raw data.
//   probes    at most 2 finalized getTransaction of the missing signatures
//             the previous confirm named. One whose complete status meta
//             shows it invokes no watched program (it only lists a program
//             ID, or loads it through a lookup table, so it cannot change a
//             program account) is sent as exempt; without that meta a CPI
//             could be hidden, so it exempts nothing.
// Then:
//   listings  per program, getSignaturesForAddress at 'confirmed' with
//             minContextSlot = max(F, tip − 75): every transaction confirmed
//             before F's block time is in the listing, however far behind the
//             answering node is (a lagging node only makes F, and so the
//             covered time, older; the SQL declines past 60 s). Newest
//             first, 20 then 100 rows per page, at most 3 pages, down to the
//             plan's floor; or from the plan's cursor when an earlier listing
//             did not reach the floor. Failed rows are sent too (they move
//             the watermark, never block it). A short page stops paging but
//             proves nothing: the SQL requires the OLDEST row to be at or
//             below the floor.
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

/** The Clock sysvar, read with the sample (its 100th key at most: 0075 caps sample_size at 99). */
export const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111";
const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";

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
  /** NOT_INSTALLED: the plan function is not there (0075 not applied, or the schema cache not reloaded). */
  | { status: "skipped"; reason: "OFF" | "NOT_DUE" | "INDEXER_STAGE" | "NOT_INSTALLED" };

/**
 * Declines that normal operation produces (activity, catch-up, a busy stage,
 * a second run): logged at info. The rest (RPC, database, evidence, mirror)
 * at error.
 */
const ROUTINE = new Set([
  "PENDING_JOBS", "NO_BUDGET", "TIP_BASELINE", "TIP_TOO_SOON", "CATCHING_UP", "LISTING_INCOMPLETE",
  "UNDECODED_SIGNATURE", "PLAN_SUPERSEDED", "PLAN_EXPIRED", "OPEN_INCIDENT", "NOT_READY", "OFF",
]);
/** PostgREST / Postgres: the function (or its table) does not exist. */
const NOT_INSTALLED = new Set(["PGRST202", "42883", "42P01"]);

type ClientReason = "RPC_ERROR" | "RPC_TIMEOUT" | "NO_BUDGET";
type Row = { signature: string; slot: number; ok: boolean };
type Listing = { program: string; before: string | null; rows: Row[] };
type SampleAccount = { pda: string; owner: string | null; data: string | null };
type Sample = { context_slot: number; block_time: number; accounts: SampleAccount[] };
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
  if (!Array.isArray(d.sample) || d.sample.length > 99 || !d.sample.every((p) => typeof p === "string" && ADDRESS.test(p))) return null;
  if (!Array.isArray(d.probe) || d.probe.length > HEARTBEAT.maxProbes || !d.probe.every((s) => typeof s === "string" && SIGNATURE.test(s))) return null;
  plan.sample = d.sample as string[];
  plan.probe = d.probe as string[];
  return { mode: d.mode, due: true, ...plan };
}

/**
 * One program's listing, newest first, from the tip (or from `resume`) down
 * to `floor`, from a node that has confirmed `minContext`. Stops at the
 * floor, at a short page or after maxPages; the SQL decides whether it is
 * complete. No floor: one page (nothing can be proven).
 */
async function listProgram(program: string, floor: number | null, resume: Cursor | null, minContext: number, phase: AbortSignal): Promise<Listing> {
  const rpc = getServerRpc();
  const rows: Row[] = [];
  const seen = new Set<string>();
  let before = resume?.signature ?? null;
  const pages = floor === null ? 1 : HEARTBEAT.maxPages;
  for (let page = 0; page < pages; page++) {
    const limit = resume || page > 0 ? HEARTBEAT.nextPage : HEARTBEAT.firstPage;
    const answer: unknown = await rpc.getSignaturesForAddress(address(program), {
      commitment: "confirmed", limit, minContextSlot: BigInt(minContext),
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

/** The base64 data of an account answer; EvidenceError when it is not one. */
function base64Data(account: { owner?: unknown; data?: unknown }): string {
  const data = account.data;
  if (typeof account.owner !== "string" || !ADDRESS.test(account.owner) || !Array.isArray(data)
      || data[1] !== "base64" || typeof data[0] !== "string" || data[0].length > 1_400_000 || !BASE64.test(data[0])) {
    throw new EvidenceError();
  }
  return data[0];
}

/**
 * The block time of the finalized bank that answered: its Clock sysvar
 * (slot u64 at 0, unix_timestamp i64 at 32), which must be that bank's own.
 */
function clockTime(account: unknown, contextSlot: number): number {
  const clock = account as { owner?: unknown; data?: unknown } | null;
  if (!clock || clock.owner !== SYSVAR_OWNER) throw new EvidenceError();
  const bytes = Buffer.from(base64Data(clock), "base64");
  if (bytes.length !== 40 || slotOf(bytes.readBigUInt64LE(0)) !== contextSlot) throw new EvidenceError();
  const time = Number(bytes.readBigInt64LE(32));
  if (!Number.isSafeInteger(time) || time <= 0) throw new EvidenceError();
  return time;
}

/** The planned accounts at finalized, in plan order, with the block time of that finalized slot. */
async function readSample(pdas: string[], floor: number | null, phase: AbortSignal): Promise<Sample> {
  const keys = [...pdas, CLOCK_SYSVAR];
  const answer = await getServerRpc().getMultipleAccounts(keys.map((key) => address(key)), {
    encoding: "base64", commitment: "finalized", ...(floor === null ? {} : { minContextSlot: BigInt(floor) }),
  }).send({ abortSignal: callSignal(phase) });
  const a = answer as { context?: { slot?: unknown } | null; value?: unknown } | null;
  if (!a || !a.context || !Array.isArray(a.value) || a.value.length !== keys.length) throw new EvidenceError();
  const values = a.value as unknown[];
  const contextSlot = slotOf(a.context.slot);
  const accounts = pdas.map((pda, i): SampleAccount => {
    const account = values[i] as { owner?: unknown; data?: unknown } | null;
    if (account === null) return { pda, owner: null, data: null };
    if (!account || typeof account !== "object") throw new EvidenceError();
    return { pda, owner: account.owner as string, data: base64Data(account) };
  });
  return { context_slot: contextSlot, block_time: clockTime(values[pdas.length], contextSlot), accounts };
}

/**
 * The probe candidates that provably invoke no watched program. A failed
 * probe exempts nothing; neither does an answer without the status meta
 * (invokesWatchedProgram counts it as watched: its CPIs cannot be seen) or
 * one that disagrees with the listing (the row was listed as successful).
 */
async function probe(signatures: string[], phase: AbortSignal): Promise<string[]> {
  if (!signatures.length) return [];
  const pd = await programDataAddresses();
  const verdicts = await Promise.all(signatures.slice(0, HEARTBEAT.maxProbes).map(async (sig) => {
    try {
      const tx = (await finalizedTransaction(sig, callSignal(phase))) as InvocationTx | null;
      // Not finalized (yet), another transaction, no meta, failed, or a watched invocation: not exempt.
      if (!tx || tx.transaction?.signatures?.[0] !== sig || !tx.meta || tx.meta.err !== null) return null;
      return invokesWatchedProgram(tx, pd) ? null : sig;
    } catch {
      return null;
    }
  }));
  return verdicts.filter((sig): sig is string => sig !== null);
}

async function gather(plan: Plan, phase: AbortSignal) {
  const [tip, sample, exempt] = await Promise.all([
    getServerRpc().getSlot({ commitment: "confirmed" }).send({ abortSignal: callSignal(phase) }).then(slotOf),
    readSample(plan.sample, plan.floors[ASSET_REGISTRY_PROGRAM_ADDRESS], phase),
    probe(plan.probe, phase),
  ]);
  // After the sample: every listing reaches its finalized slot F, so the
  // proof covers F's block time (0075 T4).
  const minContext = Math.max(sample.context_slot, tip - HEARTBEAT.lagSlots, 0);
  const listings = await Promise.all(HEARTBEAT_PROGRAMS.map((program) =>
    listProgram(program, plan.floors[program], plan.resume[program], minContext, phase)));
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
    if (error && NOT_INSTALLED.has(String((error as { code?: unknown }).code))) return { status: "skipped", reason: "NOT_INSTALLED" };
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

let warnedNotInstalled = false;

/**
 * One heartbeat attempt before `deadlineMs` (the indexer stage's deadline).
 * Never throws; a decline is logged as its code only (routine ones at info),
 * NOT_INSTALLED once per instance (a front deployed before 0075).
 */
export async function runIndexerHeartbeat(deadlineMs: number, signal?: AbortSignal): Promise<Freshness> {
  let result: Freshness;
  try {
    result = await heartbeat(deadlineMs, signal);
  } catch {
    result = declined("INTERNAL_ERROR");
  }
  if (result.status === "declined") {
    (ROUTINE.has(result.reason) ? console.info : console.error)(`[indexer-heartbeat] declined ${result.reason}`);
  } else if (result.status === "skipped" && result.reason === "NOT_INSTALLED" && !warnedNotInstalled) {
    warnedNotInstalled = true;
    console.warn("[indexer-heartbeat] skipped NOT_INSTALLED (is 0075 applied?)");
  }
  return result;
}
