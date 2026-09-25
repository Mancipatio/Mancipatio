/**
 * The offline simulator world shared by the cohort tests
 * (tests/sim-cohorts.test.ts) and the owner-actor tests
 * (tests/sim-owner.test.ts): a fake site and chain, a virtual clock, the
 * scheduler helpers, and a reload after a fake process death. `owner`
 * adds the owner actor with a generated admin key the fake site and chain
 * know as an Admin (the real CekAgg key is never loaded offline).
 */
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import type { SimCtx } from "@/scripts/sim/lib/cohorts/common";
import { createOwnerCtx, observeOwnerActivity, startOwnerActor } from "@/scripts/sim/lib/cohorts/owner";
import { SimHttp } from "@/scripts/sim/lib/http";
import { buildRoster, type UserPlan } from "@/scripts/sim/lib/identity";
import { FINDING_OUTCOMES, MemoryJournal, teeJournal } from "@/scripts/sim/lib/journal";
import { Limiter, type Clock } from "@/scripts/sim/lib/pacing";
import { schedule } from "@/scripts/sim/lib/runner";
import type { OwnerOptions } from "@/scripts/sim/lib/safety";
import { newState, newUserState, type SimState, type UserState } from "@/scripts/sim/lib/state";
import { ASSET, FAKE_MINT_A, FAKE_MINT_B, FakeChainOps, FakeSite, SALES } from "./sim-fake-site";

export const RUN = "t3st01";
export const roster = buildRoster();

/**
 * A virtual clock. The scheduler's workers run through `worker`; time moves
 * only while every one of them is asleep on the clock, straight to the
 * earliest wake-up, and one sleeper resumes per move (equal wake-ups in the
 * order they slept). A step's real awaits (WebCrypto signing and verifying,
 * PDA digests) take no simulated time and only one worker runs at a time, so
 * a world gives the same run on any machine, however loaded. (A clock that
 * jumps on every sleep let an idle worker spin simulated minutes ahead while
 * the other was still inside a step, as fast as the event loop turned.)
 */
export function fakeClock(): Clock & { t: number } {
  const sleepers: { at: number; seq: number; wake: () => void }[] = [];
  let workers = 0;
  let seq = 0;
  let queued = false;
  const tick = () => {
    queued = false;
    if (sleepers.length === 0 || sleepers.length < workers) return;
    sleepers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = sleepers.shift()!;
    clock.t = Math.max(clock.t, next.at);
    next.wake();
  };
  // A macrotask later: a worker whose step only awaited promises is asleep again (or still running) by then.
  const poke = () => {
    if (queued) return;
    queued = true;
    setImmediate(tick);
  };
  const clock = {
    t: 1_000_000,
    now: () => clock.t,
    sleep: (ms: number) =>
      new Promise<void>((wake) => {
        sleepers.push({ at: clock.t + ms, seq: seq++, wake });
        poke();
      }),
    worker: async <T>(run: () => Promise<T>): Promise<T> => {
      workers += 1;
      try {
        await clock.sleep(0); // the workers start one at a time as well
        return await run();
      } finally {
        workers -= 1;
        poke();
      }
    },
  };
  return clock;
}

export type World = {
  ctx: SimCtx;
  site: FakeSite;
  chain: FakeChainOps;
  journal: MemoryJournal;
  clock: ReturnType<typeof fakeClock>;
  state: SimState;
  users: UserState[];
  limiter: Limiter;
  locks: { taken: number; free: boolean };
  /** state.json as last persisted (with `persist`); nothing is saved after a fake process death. */
  disk: { saved: string };
  /** The owner actor's admin key (with `owner`). */
  admin?: KeyPairSigner;
};

export const OWNER_DEFAULTS: OwnerOptions = { max: null, only: null, retry: false, appReject: false, passportReject: false };

/**
 * `pace`: the fake chain's sends go through the limiter (one in flight, ≤ 3/min), as the executor's do.
 * `persist`: ctx.persist (and the fake executor's settle) save state.json to `disk`, for reload().
 */
export async function world(plans: UserPlan[], options: { pace?: boolean; persist?: boolean; owner?: Partial<OwnerOptions> } = {}): Promise<World> {
  const site = new FakeSite();
  const chain = new FakeChainOps(site);
  const journal = new MemoryJournal();
  const clock = fakeClock();
  const limiter = new Limiter({ clock });
  chain.journal = journal;
  chain.now_ = clock.now;
  if (options.pace) chain.limiter = limiter;
  const locks = { taken: 0, free: true };
  const disk = { saved: "" };
  let dead = false;
  const admin = options.owner ? await generateKeyPairSigner() : undefined;
  let ctxRef: SimCtx | null = null;
  const httpJournal = admin ? teeJournal(journal, (e) => observeOwnerActivity(ctxRef?.owner, e)) : journal;
  const http = new SimHttp({ fetch: site.fetch, limiter, journal: httpJournal, now: clock.now });
  const state = newState(RUN, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  const signers = new Map<string, KeyPairSigner>();
  for (const p of plans) {
    const signer = await generateKeyPairSigner();
    signers.set(p.label, signer);
    state.users[p.label] = newUserState(p, signer.address);
  }
  const ctx: SimCtx = {
    runId: RUN,
    state,
    http,
    chain,
    journal,
    market: { sales: SALES, asset: ASSET, classA: SALES[1] as never, mintA: FAKE_MINT_A, paymentMint: ASSET, termsOk: true, mintB: FAKE_MINT_B, kycRegistry: null },
    signer: (label) => signers.get(label)!,
    now: clock.now,
    persist: () => {
      if (options.persist && !dead) disk.saved = JSON.stringify(state);
    },
    log: () => {},
    passport: async (wallet) => (await chain.passports([wallet])).get(wallet) ?? false,
    chainLock: () => {
      if (locks.free) locks.taken += 1;
      return locks.free;
    },
  };
  chain.persist = () => ctx.persist();
  chain.onDeath = () => void (dead = true);
  chain.onRevive = () => void (dead = false);
  ctxRef = ctx;
  if (admin) {
    site.admins.add(admin.address);
    chain.admins.add(admin.address);
    ctx.owner = createOwnerCtx(admin, { ...OWNER_DEFAULTS, ...options.owner });
  }
  return { ctx, site, chain, journal, clock, state, users: plans.map((p) => state.users[p.label]), limiter, locks, disk, admin };
}

/** The owner actor's preflight, as `watch` runs it before the scheduler. */
export async function startOwner(w: World): Promise<void> {
  await startOwnerActor(w.ctx, w.ctx.owner!);
}

/** A new process: a fresh owner actor (its focus and in-memory reads are gone), started again. */
export async function restartOwner(w: World, options: Partial<OwnerOptions> = {}): Promise<void> {
  w.ctx.owner = createOwnerCtx(w.admin!, { ...OWNER_DEFAULTS, ...w.ctx.owner?.options, ...options });
  await startOwner(w);
}

/** A new process after a fake death: state.json as last persisted, in place (the chain keeps what landed). */
export function reload(w: World): void {
  const saved = JSON.parse(w.disk.saved) as SimState;
  for (const u of w.users) {
    const label = u.plan.label;
    for (const key of Object.keys(u)) delete (u as Record<string, unknown>)[key];
    Object.assign(u, saved.users[label]);
  }
  w.state.market = saved.market;
  w.state.funding = saved.funding;
  w.state.owner = saved.owner;
  w.chain.onRevive?.();
}

export const runUntilBlocked = (w: World) =>
  schedule(w.ctx, { users: w.users, workers: 2, mode: "until-blocked", stop: () => w.limiter.stopReason, paused: () => false, deadlineMs: w.clock.t + 6 * 3_600_000, clock: w.clock });
export const runFor = (w: World, minutes: number) =>
  schedule(w.ctx, { users: w.users, workers: 1, mode: "until-finished", stop: () => w.limiter.stopReason, paused: () => false, deadlineMs: w.clock.t + minutes * 60_000, clock: w.clock });

export const findings = (w: World) => w.journal.entries.filter((e) => FINDING_OUTCOMES.has(e.outcome));
export const plan = (f: (p: UserPlan) => boolean) => roster.find(f)!;
