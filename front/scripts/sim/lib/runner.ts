/**
 * `npm run sim` (design-sim §0, §4, §7): SIM_CMD=plan|pilot|wave|watch|report.
 *
 * pilot / wave / watch, in order:
 *   config gates (devnet only) → sim dir git-ignored → fetch guard (only
 *   https://www.manci.io and the RPC URL) → the site's home page reports
 *   devnet → the e2e addresses and the genesis-pinned RPC → state.json and
 *   the journals → every inflight signature resolved → (pilot/wave) market
 *   setup and funding as the CLI Admin / deployer → the scheduler.
 *
 * The scheduler runs up to 2 workers (≤ 2 HTTP in flight); each advances one
 * user by one step and saves state. Users waiting for the owner are polled
 * every 2 min while the others continue. pilot/wave return once every user
 * of the wave is finished or waiting for the owner; watch keeps polling
 * until every started user finished (or SIM_WATCH_MAX_MIN, STOP, SIGINT).
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { KeyPairSigner } from "@solana/kit";
import { networkLabel } from "@/lib/network";
import { Journal } from "@/scripts/chain/lib/journal";
import { ChainAbortError, loadHotSigner, repoRoot, type ChainEnv } from "@/scripts/chain/lib/safety";
import { SimChainOps, SimRetryLater, TxExecutor, createSimRpc, type ChainOps, type OwnerMeta } from "./chain";
import { CLI_ADMIN, DEPLOYER, PACE, SITE_ORIGIN } from "./constants";
import { advance } from "./cohorts";
import type { MarketView, SimCtx } from "./cohorts/common";
import { SimHttp } from "./http";
import { buildRoster, userSigner, type UserPlan } from "./identity";
import { FINDING_OUTCOMES, SimJournal, readSimJournal, type JournalSink } from "./journal";
import { Limiter, realClock, type Clock } from "./pacing";
import { planSummary, renderPlan } from "./plan";
import { renderOwnerQueue, writeReport } from "./report";
import {
  SimGateError,
  SimStopError,
  StopControl,
  acquireSimLock,
  assertIgnoredDir,
  ensurePrivateDir,
  installSimFetchGuard,
  readSimConfig,
  writePrivateFile,
  type SimConfig,
} from "./safety";
import { assertMarket, ensureMarket, fundUsers, readE2eState, resolveKycRegistry, type E2eAddrs } from "./setup";
import { loadState, newState, newUserState, saveState, type SimState, type TxOwner, type UserState } from "./state";

export type RunDeps = {
  root?: string;
  home?: string;
  log?: (line: string) => void;
  clock?: Clock;
  signalHandlers?: boolean;
};

export type RunResult = { status: "planned" | "reported" | "blocked" | "finished" | "stopped" | "deadline"; detail?: string };

// ── Scheduler ───────────────────────────────────────────────────────────────

export type ScheduleOptions = {
  users: UserState[];
  workers: number;
  mode: "until-blocked" | "until-finished";
  stop: () => string | null;
  paused: () => boolean;
  deadlineMs: number;
  /** Called about once per watch interval (owner queue, passport cache). */
  onTick?: () => void;
  clock: Clock;
};

/** Picks the next runnable user: not waiting, not being advanced, least recently advanced. */
function pick(users: UserState[], busy: Set<string>, now: number, lastRun: Map<string, number>): UserState | null {
  let best: UserState | null = null;
  for (const u of users) {
    if (u.terminal || busy.has(u.plan.label) || u.notBefore > now) continue;
    if (!best || (lastRun.get(u.plan.label) ?? 0) < (lastRun.get(best.plan.label) ?? 0)) best = u;
  }
  return best;
}

export async function schedule(ctx: SimCtx, o: ScheduleOptions): Promise<RunResult["status"]> {
  const busy = new Set<string>();
  const lastRun = new Map<string, number>();
  let result: RunResult["status"] | null = null;
  let lastTick = 0;
  const worker = async (): Promise<void> => {
    while (result === null) {
      const reason = o.stop();
      if (reason) return void (result ??= "stopped");
      const now = o.clock.now();
      if (now >= o.deadlineMs) return void (result ??= "deadline");
      if (o.onTick && now - lastTick >= PACE.watchIntervalMs) {
        lastTick = now;
        o.onTick();
      }
      if (o.paused()) {
        await o.clock.sleep(10_000);
        continue;
      }
      const next = pick(o.users, busy, now, lastRun);
      if (!next) {
        const active = o.users.filter((u) => !u.terminal);
        if (active.length === 0) return void (result ??= "finished");
        if (o.mode === "until-blocked" && busy.size === 0 && active.every((u) => u.awaitingOwner)) return void (result ??= "blocked");
        const soonest = Math.min(...active.filter((u) => !busy.has(u.plan.label)).map((u) => u.notBefore), now + 5_000);
        await o.clock.sleep(Math.max(250, Math.min(soonest - now, 5_000)));
        continue;
      }
      busy.add(next.plan.label);
      lastRun.set(next.plan.label, now);
      try {
        await advance(ctx, next);
      } catch (error) {
        // A stop (or a bug) ends every worker after its current step.
        result ??= "stopped";
        throw error;
      } finally {
        busy.delete(next.plan.label);
        ctx.persist();
      }
    }
  };
  // allSettled: no worker may still be writing when the caller closes the journals.
  const settled = await Promise.allSettled(Array.from({ length: Math.max(1, o.workers) }, () => worker()));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
  return result ?? "finished";
}

// ── Orchestration ───────────────────────────────────────────────────────────

function latestRunFile(simRoot: string): string {
  return path.join(simRoot, "latest-run");
}

function readLatestRun(simRoot: string): string | null {
  try {
    const id = fs.readFileSync(latestRunFile(simRoot), "utf8").trim();
    return /^[a-z0-9]{6}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The run of this command: SIM_RUN_ID, else the latest, else (pilot only) a new one. */
function resolveRunId(cfg: SimConfig): string {
  const id = cfg.runId ?? readLatestRun(cfg.simRoot);
  if (id) return id;
  if (cfg.cmd !== "pilot") throw new SimGateError("No simulator run yet: start with SIM_CMD=pilot (or pass SIM_RUN_ID)");
  return randomBytes(3).toString("hex");
}

/** The site must answer and name devnet, as scripts/ops/deployment-smoke.test.ts checks. */
export async function assertDevnetSite(fetchImpl: typeof fetch): Promise<void> {
  let page: string;
  try {
    const response = await fetchImpl(SITE_ORIGIN, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (response.status !== 200) throw new SimGateError(`${SITE_ORIGIN} answered ${response.status}`);
    page = await response.text();
    // SIWS allows ±300 s: a skewed local clock would turn every request into a 401.
    const served = Date.parse(response.headers.get("date") ?? "");
    if (Number.isFinite(served) && Math.abs(Date.now() - served) > 120_000) {
      throw new SimGateError(`The local clock is ${Math.round((Date.now() - served) / 1000)} s off the site's; sync it first`);
    }
  } catch (error) {
    if (error instanceof SimGateError) throw error;
    throw new SimGateError(`${SITE_ORIGIN} is unreachable`);
  }
  if (!page.includes(`title="Connected to Solana ${networkLabel("devnet")}"`)) {
    throw new SimGateError(`${SITE_ORIGIN} does not report Solana ${networkLabel("devnet")}; refusing to run`);
  }
}

function scopeOf(cfg: SimConfig, roster: UserPlan[], state: SimState | null): UserPlan[] {
  if (cfg.cmd === "pilot") return roster.filter((p) => p.wave === 0);
  if (cfg.cmd === "wave") return roster.filter((p) => p.wave === cfg.wave);
  const started = new Set(state?.started ?? []);
  return roster.filter((p) => started.has(p.wave));
}

/** A wave starts only after the pilot finished with 0 unexpected results (design §4). */
function assertPilotClean(state: SimState, runDir: string, env: ChainEnv): void {
  if (!state.started.includes(0)) throw new SimGateError("Run the pilot first (SIM_CMD=pilot)");
  const pilot = new Set(Object.values(state.users).filter((u) => u.plan.wave === 0).map((u) => u.plan.label));
  const findings = readSimJournal(path.join(runDir, "journal.ndjson")).filter((e) => pilot.has(e.user) && FINDING_OUTCOMES.has(e.outcome));
  if (findings.length && env.SIM_ACCEPT_PILOT_FINDINGS?.trim() !== "1") {
    throw new SimGateError(`The pilot has ${findings.length} unexpected results (see report.md); fix them or set SIM_ACCEPT_PILOT_FINDINGS=1`);
  }
}

export async function runSim(env: ChainEnv, deps: RunDeps = {}): Promise<RunResult> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const root = deps.root ?? repoRoot();
  const cfg = readSimConfig(env, { root, home: deps.home });
  if (cfg.cmd === "plan") {
    log(renderPlan(planSummary(cfg.runId ?? readLatestRun(cfg.simRoot) ?? "preview")));
    return { status: "planned" };
  }
  assertIgnoredDir(cfg.simRoot, root);
  ensurePrivateDir(cfg.simRoot);
  const runId = resolveRunId(cfg);
  const runDir = path.join(cfg.simRoot, runId);
  if (cfg.cmd === "report") {
    const state = loadState(runDir);
    const { reportPath, findings } = writeReport(cfg.simRoot, runDir, state, readSimJournal(path.join(runDir, "journal.ndjson")));
    log(`report: ${reportPath} (${findings} unexpected results)`);
    return { status: "reported", detail: `${findings}` };
  }
  return runNetworked(cfg, env, runId, runDir, log, deps);
}

async function runNetworked(cfg: SimConfig, env: ChainEnv, runId: string, runDir: string, log: (l: string) => void, deps: RunDeps): Promise<RunResult> {
  const clock = deps.clock ?? realClock;
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  if (deps.signalHandlers) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  const stop = new StopControl(cfg.simRoot, controller.signal);
  if (stop.stopReason()) throw new SimGateError(`${stop.stopFile} exists; remove it to run`);
  const releaseLock = acquireSimLock(cfg.simRoot);
  ensurePrivateDir(runDir);
  writePrivateFile(latestRunFile(cfg.simRoot), `${runId}\n`);
  const restoreFetch = installSimFetchGuard(cfg.rpcUrl);
  let journal: SimJournal | null = null;
  let txJournal: Journal | null = null;
  let state: SimState | null = null;
  const persist = () => state && saveState(runDir, state);
  try {
    await assertDevnetSite(globalThis.fetch);
    const e2e = readE2eState(cfg.e2eStatePath);
    const limiter = new Limiter({ clock, isStopped: () => stop.stopReason() });
    journal = new SimJournal(runDir);
    txJournal = new Journal(path.join(runDir, "tx-journal.jsonl"));
    const http = new SimHttp({ fetch: globalThis.fetch, limiter, journal });
    const { rpc, drainRpc, assertNetwork } = createSimRpc({ url: cfg.rpcUrl!, expectedGenesis: cfg.expectedGenesis, rps: cfg.rps, limiter, signal: controller.signal });
    await assertNetwork();
    state = loadState(runDir) ?? newState(runId, cfg.expectedGenesis);
    if (state.genesis !== cfg.expectedGenesis) throw new SimGateError("state.json belongs to another cluster");
    persist();
    const exec = new TxExecutor({ rpc, drainRpc, txJournal, journal, limiter, persist, signal: controller.signal, timing: { pollMs: 3_000 } });
    const metaOf = (owner: TxOwner): OwnerMeta =>
      "plan" in owner ? { cohort: (owner as UserState).plan.cohort, wave: (owner as UserState).plan.wave } : { cohort: "setup", wave: null };
    const resolved = await exec.resolveAll(state, metaOf);
    if (resolved.pending) log(`resume: ${resolved.pending} signature(s) still unresolved; their steps wait`);

    await assertMarket(rpc, e2e);
    const market: E2eAddrs = { ...e2e, kycRegistry: await resolveKycRegistry(rpc, cfg.kycRegistry, e2e.kycAuthority) };
    if (!market.kycRegistry) log("passports: no KYC registry found (SIM_KYC_REGISTRY); investors fall back to /api/passport/status");

    const roster = buildRoster();
    if (cfg.cmd === "wave") assertPilotClean(state, runDir, env);
    const scope = scopeOf(cfg, roster, state);
    const signers = new Map<string, KeyPairSigner>();
    for (const p of scope) {
      const signer = await userSigner(runDir, p.label);
      signers.set(p.label, signer);
      state.users[p.label] ??= newUserState(p, signer.address);
      if (state.users[p.label].wallet !== signer.address) throw new SimGateError(`${p.label}: key file does not match state.json`);
    }
    persist();
    const users = scope.map((p) => state!.users[p.label]);

    const setupDeps = { state, exec, rpc, http, journal, persist, log };
    if (cfg.cmd === "pilot" || cfg.cmd === "wave") {
      const admin = await loadHotSigner(cfg.adminKeypair, CLI_ADMIN, "CLI Admin");
      const deployer = await loadHotSigner(cfg.deployerKeypair, DEPLOYER, "deployer");
      await ensureMarket(setupDeps, admin, market);
      await fundUsers(setupDeps, { deployer, admin }, market, users);
      const wave = cfg.cmd === "pilot" ? 0 : cfg.wave!;
      if (!state.started.includes(wave)) state.started.push(wave);
      persist();
    }
    if (state.market.sales.length < 2) throw new SimGateError("The market setup has not run yet (SIM_CMD=pilot)");

    const view: MarketView = {
      sales: state.market.sales,
      asset: market.asset,
      classA: market.classA,
      mintA: market.mintA,
      paymentMint: market.paymentMint,
      termsOk: state.market.termsOk,
    };
    const ops: ChainOps = new SimChainOps(exec, market);
    const passportCache = { at: 0, map: new Map<string, boolean>() };
    const ctx: SimCtx = {
      runId,
      state,
      http,
      chain: ops,
      journal: journal as JournalSink,
      market: view,
      signer: (label) => {
        const s = signers.get(label);
        if (!s) throw new SimGateError(`${label} is not in this command's scope`);
        return s;
      },
      now: () => clock.now(),
      persist,
      log,
      passport: async (wallet) => {
        if (!market.kycRegistry) return null;
        if (clock.now() - passportCache.at > PACE.watchIntervalMs - 10_000) {
          // One batched read for every investor currently waiting for a passport.
          const waiting = users.filter((u) => u.stage === "await.passport").map((u) => u.wallet);
          passportCache.map = await ops.passports(waiting.includes(wallet) ? waiting : [...waiting, wallet]);
          passportCache.at = clock.now();
        }
        return passportCache.map.get(wallet) ?? false;
      },
    };
    const writeQueue = () => writePrivateFile(path.join(runDir, "owner-queue.txt"), renderOwnerQueue(state!));
    writeQueue();
    const status = await schedule(ctx, {
      users,
      workers: cfg.workers,
      mode: cfg.cmd === "watch" ? "until-finished" : "until-blocked",
      stop: () => stop.stopReason() ?? limiter.stopReason,
      paused: () => stop.paused(),
      deadlineMs: clock.now() + (cfg.cmd === "watch" && cfg.watchOnce ? PACE.watchIntervalMs + 60_000 : cfg.watchMaxMin * 60_000),
      onTick: writeQueue,
      clock,
    });
    writeQueue();
    if (status === "stopped") state.stops.push({ at: new Date().toISOString(), reason: stop.stopReason() ?? limiter.stopReason ?? "stopped" });
    const waiting = users.filter((u) => u.awaitingOwner && !u.terminal).length;
    const finished = users.filter((u) => u.terminal).length;
    log(`${cfg.cmd}: ${status} — ${finished}/${users.length} finished, ${waiting} waiting for the owner (owner-queue.txt)`);
    return { status, detail: `${finished}/${users.length}` };
  } catch (error) {
    // A clean stop, or a setup/funding signature that is still unresolved: state
    // and journals are kept; the next run resolves the signature before anything else.
    if (error instanceof SimStopError || error instanceof ChainAbortError || error instanceof SimRetryLater) {
      state?.stops.push({ at: new Date().toISOString(), reason: error.message });
      log(error.message);
      return { status: "stopped", detail: error.message };
    }
    throw error;
  } finally {
    persist();
    journal?.close();
    txJournal?.close();
    restoreFetch();
    releaseLock();
    if (deps.signalHandlers) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
}
