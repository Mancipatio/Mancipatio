// The simulator's cohort machines (scripts/sim/lib/cohorts) and scheduler
// over a fake site and a fake chain (tests/helpers/sim-fake-site.ts): every
// user's flow to its owner wait, the owner's decisions, replacements after a
// rejected document, the buy/record/aggregate path, the trader pairs, the
// issuer path, the edge cases, the circuit breakers, and the transfer pairs
// of wave 6 (the loan, probes, checks, resume and unwinding). Offline.
import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { OfferStatus } from "@/lib/generated/asset_registry";
import type { SimCtx } from "@/scripts/sim/lib/cohorts/common";
import { EDGE_GROUPS } from "@/scripts/sim/lib/cohorts/edge";
import { SimHttp } from "@/scripts/sim/lib/http";
import { buildRoster, type UserPlan } from "@/scripts/sim/lib/identity";
import { FINDING_OUTCOMES, MemoryJournal } from "@/scripts/sim/lib/journal";
import { Limiter, type Clock } from "@/scripts/sim/lib/pacing";
import { renderOwnerQueue } from "@/scripts/sim/lib/report";
import { schedule } from "@/scripts/sim/lib/runner";
import { newState, newUserState, type SimState, type UserState } from "@/scripts/sim/lib/state";
import { ASSET, DONOR, FAKE_MINT_A, FAKE_MINT_B, FakeChainOps, FakeProcessDeath, FakeSite, SALES } from "./helpers/sim-fake-site";

const RUN = "t3st01";
const roster = buildRoster();

function fakeClock(): Clock & { t: number } {
  const clock = {
    t: 1_000_000,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return clock;
}

type World = {
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
};

/**
 * `pace`: the fake chain's sends go through the limiter (one in flight, ≤ 3/min), as the executor's do.
 * `persist`: ctx.persist (and the fake executor's settle) save state.json to `disk`, for reload().
 */
async function world(plans: UserPlan[], options: { pace?: boolean; persist?: boolean } = {}): Promise<World> {
  const site = new FakeSite();
  const chain = new FakeChainOps(site);
  const journal = new MemoryJournal();
  const clock = fakeClock();
  const limiter = new Limiter({ clock });
  chain.journal = journal;
  if (options.pace) {
    chain.limiter = limiter;
    chain.now_ = clock.now;
  }
  const locks = { taken: 0, free: true };
  const disk = { saved: "" };
  let dead = false;
  const http = new SimHttp({ fetch: site.fetch, limiter, journal, now: clock.now });
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
  return { ctx, site, chain, journal, clock, state, users: plans.map((p) => state.users[p.label]), limiter, locks, disk };
}

/** A new process after a fake death: state.json as last persisted, in place (the chain keeps what landed). */
function reload(w: World): void {
  const saved = JSON.parse(w.disk.saved) as SimState;
  for (const u of w.users) {
    const label = u.plan.label;
    for (const key of Object.keys(u)) delete (u as Record<string, unknown>)[key];
    Object.assign(u, saved.users[label]);
  }
  w.state.market = saved.market;
  w.state.funding = saved.funding;
  w.chain.onRevive?.();
}

const runUntilBlocked = (w: World) =>
  schedule(w.ctx, { users: w.users, workers: 2, mode: "until-blocked", stop: () => w.limiter.stopReason, paused: () => false, deadlineMs: w.clock.t + 6 * 3_600_000, clock: w.clock });
const runFor = (w: World, minutes: number) =>
  schedule(w.ctx, { users: w.users, workers: 1, mode: "until-finished", stop: () => w.limiter.stopReason, paused: () => false, deadlineMs: w.clock.t + minutes * 60_000, clock: w.clock });

const findings = (w: World) => w.journal.entries.filter((e) => FINDING_OUTCOMES.has(e.outcome));
const plan = (f: (p: UserPlan) => boolean) => roster.find(f)!;

describe("KYC dossiers", () => {
  it("sets up the account, submits, uploads three files and finishes when the owner verifies", async () => {
    const w = await world([plan((p) => p.label === "u001")]);
    const [u] = w.users;
    expect(await runUntilBlocked(w)).toBe("blocked");
    expect(u.stage).toBe("await.dossier");
    expect(u.awaitingOwner).toBe(true);
    expect(u.ownerTask).toMatch(/\/admin\/clients\/.+approve every document/);
    const steps = w.journal.entries.filter((e) => e.kind === "http").map((e) => e.step);
    expect(steps.slice(0, 4)).toEqual(["auth.session", "account.me", "account.update", "tos.accept"]);
    const d = w.site.dossierOf(u.wallet);
    expect(d.uploads.map((x) => `${x.kind}:${x.type}`)).toEqual(["passport:image/png", "proof_of_address:application/pdf", "selfie:image/png"]);
    expect(d.kyc_status).toBe("pending");
    w.site.verify(u.wallet);
    expect(await runFor(w, 10)).toBe("finished");
    expect(u.terminal).toBe("done");
    expect(findings(w)).toEqual([]);
  });

  it("uploads a replacement (round 2) when the owner rejects one document", async () => {
    const w = await world([plan((p) => p.variant === "kyc" && p.review === "more_info")]);
    const [u] = w.users;
    await runUntilBlocked(w);
    w.site.rejectDocument(u.wallet, "proof_of_address");
    await runFor(w, 5);
    const d = w.site.dossierOf(u.wallet);
    expect(d.uploads).toHaveLength(4);
    expect(d.uploads[3].name).toMatch(/proof_of_address-v2/);
    expect(u.stage).toBe("await.dossier");
    w.site.verify(u.wallet);
    await runFor(w, 5);
    expect(u.terminal).toBe("done");
    expect(findings(w)).toEqual([]);
  });

  it("sends invalid fields first (an expected 400), stops after one file, stamps PLEASE REJECT", async () => {
    const w = await world([
      plan((p) => p.variant === "kyc-invalid-first"),
      plan((p) => p.variant === "kyc-stop-after-one"),
      plan((p) => p.variant === "kyc-reject-doc"),
    ]);
    const [invalid, stopper, rejecter] = w.users;
    await runUntilBlocked(w);
    const invalidSteps = w.journal.entries.filter((e) => e.user === invalid.plan.label && e.route?.includes("verification"));
    expect(invalidSteps.map((e) => [e.httpStatus, e.outcome])).toEqual([[400, "expected-error"], [200, "ok"]]);
    expect(stopper.terminal).toBe("stopped");
    expect(w.site.dossierOf(stopper.wallet).uploads).toHaveLength(1);
    expect(w.site.dossierOf(rejecter.wallet).uploads.every((x) => x.name.includes("-v1"))).toBe(true);
    w.site.reject(rejecter.wallet);
    w.site.verify(invalid.wallet);
    await runFor(w, 5);
    expect(rejecter.terminal).toBe("rejected");
    expect(invalid.terminal).toBe("done");
    expect(findings(w)).toEqual([]);
  });
});

describe("buyers", () => {
  it("a KYC buyer waits for the passport, buys, re-polls a 202 and checks the progress bar", async () => {
    const w = await world([plan((p) => p.label === "u002")]);
    const [u] = w.users;
    await runUntilBlocked(w);
    w.site.verify(u.wallet);
    await runFor(w, 6);
    expect(u.stage).toBe("await.passport");
    expect(u.ownerTask).toMatch(/\/admin\/kyc/);
    w.chain.issued.add(u.wallet);
    w.site.issuePassport(u.wallet);
    await runFor(w, 10);
    expect(u.terminal).toBe("done");
    expect(w.journal.entries.some((e) => e.step === "await.passport" && e.kind === "note")).toBe(false);
    const buy = w.chain.calls.find((c) => c.op === "buy")!;
    expect(buy.detail).toMatchObject({ sale: SALES[0], terms: "10000000-0000-4000-8000-000000000001" });
    const records = w.journal.entries.filter((e) => e.step === "launchpad.recordPurchase").map((e) => e.httpStatus);
    expect(records).toEqual([202, 200]);
    const policy = w.journal.entries.filter((e) => e.step === "buy.policy");
    expect(policy.length).toBeGreaterThanOrEqual(1);
    expect(findings(w)).toEqual([]);
  });

  it("falls back to the decided passport request when the registry shows no KycEntry", async () => {
    const w = await world([plan((p) => p.label === "u002")]);
    const [u] = w.users;
    await runUntilBlocked(w);
    w.site.verify(u.wallet);
    await runFor(w, 6);
    expect(u.stage).toBe("await.passport");
    w.site.issuePassport(u.wallet);
    await runFor(w, 10);
    expect(u.terminal).toBe("done");
    expect(w.journal.entries.some((e) => e.step === "await.passport" && e.kind === "note")).toBe(true);
    expect(findings(w)).toEqual([]);
  });

  it("a no-KYC buyer waits while the terms answer 409, then buys on the second sale", async () => {
    const w = await world([plan((p) => p.label === "u003")]);
    const [u] = w.users;
    w.site.termsPublished = false;
    expect(await runUntilBlocked(w)).toBe("blocked");
    expect(u.stage).toBe("await.market");
    expect(u.ownerTask).toMatch(/whitepaper/);
    w.site.termsPublished = true;
    await runFor(w, 10);
    expect(u.terminal).toBe("done");
    expect(w.chain.calls.find((c) => c.op === "buy")!.detail).toMatchObject({ sale: SALES[1] });
    expect(findings(w)).toEqual([]);
  });

  it("an RPC read that fails before the buy is signed is infrastructure while the step retries", async () => {
    const w = await world([plan((p) => p.label === "u003")]);
    const [u] = w.users;
    w.chain.buyFaults.set("u003", 1);
    await runFor(w, 10);
    expect(u.terminal).toBe("done");
    const notes = w.journal.entries.filter((e) => e.step === "buy.send" && e.kind === "note");
    expect(notes.map((e) => e.outcome)).toEqual(["info"]);
    expect(notes[0].err).toMatch(/RPC getAccountInfo failed/);
    expect(findings(w)).toEqual([]);
  });

  it("the same RPC failure on the last attempt is a finding and the buyer fails", async () => {
    const w = await world([plan((p) => p.label === "u003")]);
    const [u] = w.users;
    w.chain.buyFaults.set("u003", 3);
    await runFor(w, 10);
    expect(u.terminal).toBe("failed");
    expect(w.journal.entries.filter((e) => e.step === "buy.send" && e.kind === "note").map((e) => e.outcome)).toEqual(["info", "info", "tx-error"]);
    expect(findings(w).map((e) => e.outcome)).toEqual(["tx-error"]);
  });
});

describe("traders", () => {
  it("pair 1: both buy, the taker takes offer o1, the maker cancels o2", async () => {
    const w = await world(roster.filter((p) => p.pair === 1));
    await runFor(w, 60);
    const [maker, taker] = w.users[0].plan.variant === "maker" ? w.users : [w.users[1], w.users[0]];
    expect(maker.terminal).toBe("done");
    expect(taker.terminal).toBe("done");
    expect(w.chain.calls.filter((c) => c.user === maker.plan.label).map((c) => c.op)).toEqual(["buy", "o1.create", "o1.deposit", "o2.create", "o2.deposit", "o2.cancel"]);
    expect(w.chain.calls.filter((c) => c.user === taker.plan.label).map((c) => c.op)).toEqual(["buy", "o1.take"]);
    expect(findings(w)).toEqual([]);
  });

  it("pair 2: the taker expires the maker's short offer once chain time passed it", async () => {
    const w = await world(roster.filter((p) => p.pair === 2));
    const taker = w.users.find((u) => u.plan.variant === "taker")!;
    await runFor(w, 20);
    expect(taker.stage).toBe("offer.expire.wait");
    w.chain.chainTime += BigInt(600);
    await runFor(w, 20);
    expect(taker.terminal).toBe("done");
    expect(w.chain.calls.filter((c) => c.user === taker.plan.label).map((c) => c.op)).toEqual(["buy", "o1.take", "o2.expire"]);
    expect(findings(w)).toEqual([]);
  });

  it("pair 3: the seller requests an escrow, the owner opens it, both deposit and it settles", async () => {
    const w = await world(roster.filter((p) => p.pair === 3));
    const maker = w.users.find((u) => u.plan.variant === "maker")!;
    const taker = w.users.find((u) => u.plan.variant === "taker")!;
    expect(await runUntilBlocked(w)).toBe("blocked");
    expect(w.site.otc).toHaveLength(1);
    expect(w.site.otc[0]).toMatchObject({ seller_wallet: maker.wallet, buyer_wallet: taker.wallet, requested_by: maker.wallet });
    expect(maker.ownerTask).toMatch(/\/admin\/otc/);
    w.site.openDeal(w.site.otc[0].id, "deal-pda-3");
    await runFor(w, 30);
    expect(maker.terminal).toBe("done");
    expect(taker.terminal).toBe("done");
    expect(w.chain.deals.get("deal-pda-3")!.assetDeposited && w.chain.deals.get("deal-pda-3")!.paymentDeposited).toBe(true);
    expect(findings(w)).toEqual([]);
  });

  it("pair 4: the buyer requests; a resumed requester does not file it twice", async () => {
    const w = await world(roster.filter((p) => p.pair === 4));
    const taker = w.users.find((u) => u.plan.variant === "taker")!;
    await runUntilBlocked(w);
    expect(w.site.otc).toHaveLength(1);
    expect(w.site.otc[0].requested_by).toBe(taker.wallet);
    // A crash between otc.create and the state save: the step runs again.
    taker.stage = "deal.request";
    taker.awaitingOwner = false;
    taker.notBefore = 0;
    await runUntilBlocked(w);
    expect(w.site.otc).toHaveLength(1);
  });
});

describe("issuers", () => {
  it("a company: KYB with 4 files, register_issuer + profile, the over-cap 4xx, needs_changes → resubmit → approved", async () => {
    const base = plan((p) => p.variant === "company-over-cap");
    const w = await world([base]);
    const [u] = w.users;
    await runUntilBlocked(w);
    expect(u.stage).toBe("await.dossier");
    expect(w.site.dossierOf(u.wallet).uploads.map((x) => x.kind)).toEqual(["incorporation", "board_resolution", "passport", "proof_of_address"]);
    expect(w.chain.calls.map((c) => c.op)).toEqual(["issuer.register"]);
    expect(w.chain.calls[0].detail).toBe(`MANCI-SIM-${RUN}-${String(base.n).padStart(3, "0")}`);
    expect(w.journal.entries.some((e) => e.step === "issuer-profiles.upsert" && e.outcome === "ok")).toBe(true);
    w.site.kybVerify(u.wallet);
    await runFor(w, 5);
    expect(u.stage).toBe("await.app");
    const overCap = w.journal.entries.find((e) => e.step === "applications.submit.over-cap")!;
    expect([overCap.httpStatus, overCap.outcome]).toEqual([400, "expected-error"]);
    w.site.review(u.wallet, "needs_changes");
    await runFor(w, 5);
    expect(w.journal.entries.some((e) => e.step === "applications.resubmit" && e.outcome === "ok")).toBe(true);
    w.site.review(u.wallet, "approved");
    await runFor(w, 5);
    expect(u.terminal).toBe("done");
    expect(findings(w)).toEqual([]);
  });

  it("a founder applies with company_formation_requested after KYC", async () => {
    const w = await world([plan((p) => p.variant === "founder" && p.review === "approve")]);
    const [u] = w.users;
    await runUntilBlocked(w);
    w.site.verify(u.wallet);
    await runFor(w, 5);
    expect(u.stage).toBe("await.app");
    expect(w.site.applications).toHaveLength(1);
    w.site.review(u.wallet, "rejected");
    await runFor(w, 5);
    expect(u.terminal).toBe("done");
    expect(findings(w)).toEqual([]);
  });
});

describe("edge cohort", () => {
  it("every edge case gets the status it expects from a strict site", async () => {
    const edges = roster.filter((p) => p.cohort === "E");
    const buyer = plan((p) => p.label === "u003");
    const w = await world([...edges, buyer]);
    await runFor(w, 90);
    for (const u of w.users.filter((x) => x.plan.cohort === "E")) {
      expect(u.terminal, u.plan.label).toBe("done");
      expect(u.data.edgeDone).toEqual(EDGE_GROUPS[u.plan.edgeGroup!]);
    }
    const byStep = (step: string) => w.journal.entries.find((e) => e.step === step)!;
    expect(byStep("edge.nonce-replay.replay").httpStatus).toBe(401);
    expect(byStep("edge.upload-5mb").httpStatus).toBe(413);
    expect(byStep("edge.oversize-8k").httpStatus).toBe(413);
    expect(byStep("edge.record-foreign-tx").httpStatus).toBe(400);
    expect(byStep("edge.session-write").httpStatus).toBe(401);
    expect(findings(w)).toEqual([]);
  });

  it("an accepted bad request is a finding (unexpected-2xx)", async () => {
    const w = await world([plan((p) => p.edgeGroup === 4)]);
    // A site that forgets to check the ToS version.
    const original = w.site.fetch;
    w.site.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/tos/accept") && String(init?.body).includes("1999-01-01")) return new Response('{"ok":true}', { status: 200 });
      return original(input, init);
    }) as typeof fetch;
    (w.ctx.http as unknown as { deps: { fetch: typeof fetch } }).deps.fetch = w.site.fetch;
    await runFor(w, 30);
    expect(findings(w).map((e) => [e.step, e.outcome])).toEqual([["edge.tos-wrong-version", "unexpected-2xx"]]);
  });
});

describe("breakers and failures", () => {
  it("journals an unexpected 500, backs off, and stops after 5 consecutive 5xx", async () => {
    const w = await world(roster.filter((p) => p.cohort === "K").slice(0, 3));
    w.site.fail.set("/api/verification/submit", { status: 500 });
    // A clean stop: every worker ends after its current step, state is kept.
    expect(await runFor(w, 60)).toBe("stopped");
    expect(w.limiter.stopReason).toMatch(/5 consecutive/);
    const fives = findings(w).filter((e) => e.outcome === "5xx");
    // Other users' successes in between reset the count, so at least 5.
    expect(fives.length).toBeGreaterThanOrEqual(5);
    expect(fives.every((e) => e.route === "POST /api/verification/submit")).toBe(true);
  });

  it("stops at once on a 503 maintenance answer", async () => {
    const w = await world([plan((p) => p.label === "u001")]);
    w.site.fail.set("/api/account/update", { status: 503, code: "maintenance" });
    expect(await runFor(w, 30)).toBe("stopped");
    expect(w.limiter.stopReason).toMatch(/maintenance/);
    expect(w.site.requests.filter((r) => r.route === "/api/account/update")).toHaveLength(1);
  });

  it("paces the whole run: writes ≥ 8 s apart and never more than 2 requests in flight", async () => {
    const w = await world(roster.filter((p) => p.wave === 0));
    const times: number[] = [];
    const original = w.site.fetch;
    let inFlight = 0;
    let peak = 0;
    w.site.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await original(input, init);
      } finally {
        inFlight -= 1;
      }
    }) as typeof fetch;
    (w.ctx.http as unknown as { deps: { fetch: typeof fetch } }).deps.fetch = w.site.fetch;
    const originalAcquire = w.limiter.acquire.bind(w.limiter);
    w.limiter.acquire = async (classes, options) => {
      const release = await originalAcquire(classes, options);
      if (classes.includes("write")) times.push(w.clock.t);
      return release;
    };
    await runUntilBlocked(w);
    expect(peak).toBeLessThanOrEqual(2);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(8_000);
  });
});

describe("transfers (cohort X, wave 6)", () => {
  const x = roster.filter((p) => p.cohort === "X");
  const xWorld = async () => {
    const w = await world(x, { pace: true });
    w.site.termsPublished = false; // buys are blocked, as on devnet today
    const [hub1, peer1, hub2, peer2] = w.users;
    return { w, hub1, peer1, hub2, peer2 };
  };
  /** Sends and probes in order, as `user:op`. */
  const timeline = (w: World) => w.chain.calls.filter((c) => c.op !== "passports").map((c) => `${c.user}:${c.op}`);
  const sends = (w: World, u: UserState) => w.chain.calls.filter((c) => c.user === u.plan.label && !c.op.startsWith("probe") && c.op !== "passports").map((c) => c.op);
  const checks = (w: World, step: string) => w.journal.entries.filter((e) => e.kind === "check" && e.step === step);

  it("runs both pairs on the donor loan while buys are blocked, in order, paced, with the loan back and nothing found", async () => {
    const { w, hub1, peer1, hub2, peer2 } = await xWorld();
    expect(await runUntilBlocked(w)).toBe("finished");
    expect(findings(w)).toEqual([]);
    for (const u of w.users) expect([u.plan.label, u.terminal]).toEqual([u.plan.label, "done"]);
    expect(sends(w, hub1)).toEqual(["xfer.s1", "xfer.s2", "xo.create", "xo.deposit", "xo.cancel", "xfer.r2"]);
    expect(sends(w, peer1)).toEqual(["xfer.r1"]);
    expect(sends(w, hub2)).toEqual(["xfer.s1", "xfer.s2", "xfer.r2"]);
    expect(sends(w, peer2)).toEqual(["xfer.r1"]);
    const t = timeline(w);
    const at = (entry: string) => {
      const i = t.indexOf(entry);
      expect(i, entry).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      "u101:xfer.s1",
      "u101:probe P1",
      "u101:xfer.s2",
      ...["P2", "P3", "P4", "P5", "P6", "P7", "P8", "B1", "B2", "B3", "B4", "D1", "D2", "L1"].map((id) => `u102:probe ${id}`),
      "u101:xo.create",
      "u101:xo.deposit",
      "u102:probe E1",
      "u102:probe E2",
      "u101:xo.cancel",
      "u102:xfer.r1",
      "u101:xfer.r2",
      "u103:xfer.s1",
      "u103:xfer.s2",
      "u104:xfer.r1",
      "u103:xfer.r2",
    ];
    for (let i = 1; i < order.length; i++) expect(at(order[i]), `${order[i - 1]} before ${order[i]}`).toBeGreaterThan(at(order[i - 1]));
    // 17 probes, all as expected, none sent.
    expect(Object.values(hub1.data.probes ?? {})).toEqual(["passed"]);
    expect(Object.values(peer1.data.probes ?? {})).toHaveLength(16);
    expect(Object.values(peer1.data.probes ?? {}).every((v) => v === "passed")).toBe(true);
    expect(w.journal.entries.filter((e) => e.kind === "probe")).toHaveLength(17);
    // The loan is back, the pairs hold nothing, conservation held, the loan is cleared.
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
    for (const u of w.users) expect(w.chain.balanceOf(u.wallet)).toBe(BigInt(0));
    expect(checks(w, "xfer.loan").map((e) => e.outcome)).toEqual(["ok", "ok"]);
    expect(checks(w, "xfer.conservation").map((e) => e.outcome)).toEqual(["ok", "ok"]);
    expect(checks(w, "xfer.S1.ata").map((e) => e.outcome)).toEqual(["ok", "ok"]);
    expect(checks(w, "xfer.S2.eligibility").map((e) => e.outcome)).toEqual(["ok", "ok"]);
    expect(checks(w, "xfer.S5.offer").map((e) => e.outcome)).toEqual(["ok"]);
    expect(checks(w, "xfer.aggregate").every((e) => e.outcome === "ok")).toBe(true);
    expect(w.state.market.loan).toBeUndefined();
    expect(w.users.some((u) => u.awaitingOwner)).toBe(false);
    expect(w.locks.taken).toBe(2);
    // Paced like the executor: never two in flight, at most 3 per minute.
    expect(w.chain.txPeak).toBe(1);
    const times = w.chain.txTimes;
    for (let i = 3; i < times.length; i++) expect(times[i] - times[i - 3]).toBeGreaterThanOrEqual(60_000);
    void peer2;
  });

  it("buys open: pair 2 takes the own-buy route (buy 3 → S2 → S6, no S7) while pair 1 borrows", async () => {
    const { w, hub1, hub2, peer2 } = await xWorld();
    w.site.termsPublished = true;
    expect(await runUntilBlocked(w)).toBe("finished");
    expect(findings(w).map((e) => [e.user, e.step, e.outcome, e.err])).toEqual([]);
    expect(hub1.data.xferSource).toBe("donor");
    expect(hub2.data.xferSource).toBe("own");
    expect(sends(w, hub2)).toEqual(["buy", "xfer.s2"]);
    expect(w.chain.calls.find((c) => c.user === hub2.plan.label && c.op === "buy")!.detail).toMatchObject({ sale: SALES[1], amount: BigInt(3) });
    expect(sends(w, peer2)).toEqual(["xfer.r1"]);
    expect(w.chain.balanceOf(hub2.wallet)).toBe(BigInt(3));
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
    expect(checks(w, "xfer.conservation").map((e) => [e.user, e.outcome])).toEqual(expect.arrayContaining([["u103", "ok"]]));
    expect(hub2.reason).toBe("own units back at the hub");
  });

  it("a donor with 2 units: pair 1 falls back to its own buy, parks on the whitepaper task, and the peers mirror it", async () => {
    const { w, hub1, peer1, hub2, peer2 } = await xWorld();
    w.chain.tokens.get(w.chain.ataKey(DONOR))!.amount = BigInt(2);
    expect(await runUntilBlocked(w)).toBe("blocked");
    for (const hub of [hub1, hub2]) {
      expect(hub.stage).toBe("await.market");
      expect(hub.ownerTask).toMatch(/whitepaper/);
    }
    for (const [peer, hub] of [[peer1, hub1], [peer2, hub2]] as const) {
      expect(peer.stage).toBe("xfer.gate");
      expect(peer.awaitingOwner).toBe(true);
      expect(peer.ownerTask).toMatch(new RegExp(`^no action of its own: waits for ${hub.plan.label} \\(publish a verified whitepaper`));
    }
    expect(w.state.market.loan).toBeUndefined();
    w.site.termsPublished = true;
    expect(await runFor(w, 90)).toBe("finished");
    expect(findings(w)).toEqual([]);
    expect(sends(w, hub1)).toEqual(["buy", "xfer.s2", "xo.create", "xo.deposit", "xo.cancel"]);
    expect(w.chain.balanceOf(hub1.wallet)).toBe(BigInt(3));
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(2));
  });

  it("a crash between the inflight record and the send resumes into exactly one send per label", async () => {
    const { w, hub1 } = await xWorld();
    w.chain.faults.set("xfer.s2", "crash-before-send");
    w.chain.faults.set("xfer.r1", "crash-before-send");
    expect(await runUntilBlocked(w)).toBe("finished");
    expect(findings(w)).toEqual([]);
    const count = (label: string) => w.chain.calls.filter((c) => c.op === label).length;
    expect([count("xfer.s1"), count("xfer.s2"), count("xfer.r1"), count("xfer.r2")]).toEqual([2, 2, 2, 2]); // one per pair
    // Wires that reached the chain, not only landings: the crashed signature was never sent.
    const wires = (label: string) => w.chain.sentWires.filter((x) => x.endsWith(`:${label}`)).length;
    expect([wires("xfer.s1"), wires("xfer.s2"), wires("xfer.r1"), wires("xfer.r2")]).toEqual([2, 2, 2, 2]);
    expect(hub1.data.xfer!.S2).toMatchObject({ srcBefore: "3", dstBefore: "0", amount: "2" });
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
  });

  it("a landed transfer whose status was lost is settled from its snapshot, never sent twice", async () => {
    const { w, hub1 } = await xWorld();
    w.chain.faults.set("xfer.r2", "landed-status-lost");
    expect(await runUntilBlocked(w)).toBe("finished");
    expect(findings(w)).toEqual([]);
    expect(w.chain.calls.filter((c) => c.user === hub1.plan.label && c.op === "xfer.r2")).toHaveLength(1);
    expect(hub1.tx["xfer.r2"]).toMatchObject({ status: "landed", sig: null });
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
  });

  it("a probe mismatch and an unexpected accept are journalled once, not retried, and the pair carries on", async () => {
    const { w, peer1 } = await xWorld();
    w.chain.probeResults.set("B3", { ok: false, failure: { program: "transfer_hook", code: 6013, name: "InvalidBlockEntry" }, hookInvoked: true });
    w.chain.probeResults.set("P4", { ok: true, failure: null, hookInvoked: true });
    expect(await runUntilBlocked(w)).toBe("finished");
    expect(findings(w).map((e) => [e.step, e.outcome])).toEqual([
      ["xfer.P4", "unexpected-accept"],
      ["xfer.B3", "tx-error"],
    ]);
    expect(w.chain.calls.filter((c) => c.op === "probe B3")).toHaveLength(1);
    expect(peer1.data.probes).toMatchObject({ B3: "mismatch", P4: "unexpected-accept", P5: "passed" });
    expect(w.users.every((u) => u.terminal === "done")).toBe(true);
  });

  it("C1: a stale first read is ok with its lag; a balance still wrong after the re-reads is a consistency finding", async () => {
    const lagged = await xWorld();
    const hubAta = (w: World) => w.chain.ataKey(w.users[0].wallet);
    lagged.w.chain.staleAfter.set("xfer.s2", { account: hubAta(lagged.w), values: [BigInt(3)] });
    await runUntilBlocked(lagged.w);
    const s2 = checks(lagged.w, "xfer.S2.balance").find((e) => e.user === "u101")!;
    // The lag is the scheduler's (≥ the 10 s re-read); its exact second depends on the other worker.
    expect(s2.outcome).toBe("ok");
    expect(s2.body).toMatch(/^lag 1\ds$/);
    expect(findings(lagged.w)).toEqual([]);

    const wrong = await xWorld();
    wrong.w.chain.staleAfter.set("xfer.s2", { account: hubAta(wrong.w), values: [BigInt(3), BigInt(3), BigInt(3)] });
    await runUntilBlocked(wrong.w);
    const bad = findings(wrong.w);
    expect(bad.map((e) => [e.step, e.outcome])).toEqual([["xfer.S2.balance", "consistency"]]);
    expect(bad[0].err).toMatch(/expected u101=1 u102=2, saw 3 and 2 \(still after 3 reads over 2\d s\)/);
    // A finding, not a failure: the pair finished and the loan is back.
    expect(wrong.w.chain.balanceOf(DONOR)).toBe(BigInt(5));
  });

  it("a failure after the units are out (S3 refused) unwinds straight to the returns: the loan comes back", async () => {
    const { w, hub1, peer1 } = await xWorld();
    w.chain.faults.set("xo.create", "sim-error");
    expect(await runUntilBlocked(w)).toBe("finished");
    expect(findings(w).map((e) => [e.step, e.outcome])).toEqual([["xo.create", "tx-error"]]);
    expect(sends(w, hub1)).toEqual(["xfer.s1", "xfer.s2", "xfer.r2"]);
    expect(sends(w, peer1)).toEqual(["xfer.r1"]);
    expect([hub1.terminal, peer1.terminal]).toEqual(["failed", "failed"]);
    expect(hub1.reason).toMatch(/unwound after a failure.*the loan is returned/);
    expect(w.journal.entries.some((e) => e.step === "xo.create.unwind" && e.kind === "note")).toBe(true);
    // Pair 2 still ran on the returned loan.
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
    expect(w.users[2].terminal).toBe("done");
  });

  it("a return leg that keeps failing never goes terminal: parked (no action), the wave ends blocked, the next run finishes it", async () => {
    const { w, hub1, hub2, peer2 } = await xWorld();
    w.chain.failAlways.add("xfer.r2");
    expect(await runUntilBlocked(w)).toBe("blocked");
    expect(hub1.terminal).toBeUndefined();
    expect(hub1.stage).toBe("xfer.r2");
    expect(hub1.ownerTask).toMatch(/^no action unless it persists: xfer\.r2 keeps failing/);
    expect(w.state.market.loan).toMatchObject({ hub: "u101", units: "3" });
    // Pair 2 waits for the loan and mirrors the parked hub.
    expect(hub2.ownerTask).toMatch(/^no action of its own: waits for u101 \(no action unless it persists: xfer\.r2 keeps failing/);
    expect(peer2.awaitingOwner).toBe(true);
    const queue = renderOwnerQueue(w.state);
    expect(queue).toMatch(/donor loan: outstanding: 3 class A units of e2e buyer3 lent to pair 1 \(hub u101\)/);
    w.chain.failAlways.delete("xfer.r2");
    expect(await runFor(w, 90)).toBe("finished");
    expect(w.users.every((u) => u.terminal === "done")).toBe(true);
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
    expect(renderOwnerQueue(w.state)).toMatch(/donor loan: returned \(u101, u103\)/);
  });

  it("a seed leg that never lands gives the loan up (nothing moved): the hubs fail, the peers leave, no one waits", async () => {
    const { w, hub1, peer1, hub2, peer2 } = await xWorld();
    w.chain.failAlways.add("xfer.s1");
    expect(await runUntilBlocked(w)).toBe("finished");
    expect([hub1.terminal, hub2.terminal]).toEqual(["failed", "failed"]);
    expect(hub1.reason).toMatch(/seed leg kept failing; nothing moved and the loan is released/);
    expect([peer1.terminal, peer2.terminal]).toEqual(["stopped", "stopped"]);
    expect(w.state.market.loan).toBeUndefined();
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
    expect(findings(w).every((e) => e.step === "xfer.s1" && e.outcome === "tx-error")).toBe(true);
    expect(renderOwnerQueue(w.state)).toMatch(/- u102 \[X\/xfer-peer\] ended stopped: hub u101 ended failed before sending anything/);
  });

  it("balances moved outside the simulator after a signed return: one finding, nothing sent until they match", async () => {
    const { w, hub1 } = await xWorld();
    w.chain.faults.set("xfer.r2", "crash-before-send");
    // Someone else sends the donor a unit while the signature is unresolved.
    w.chain.onFault = (label) => {
      if (label === "xfer.r2") w.chain.tokens.get(w.chain.ataKey(DONOR))!.amount += BigInt(1);
    };
    expect(await runUntilBlocked(w)).toBe("blocked");
    expect(findings(w).map((e) => [e.step, e.outcome])).toEqual([["xfer.S7.state", "consistency"]]);
    expect(hub1.ownerTask).toMatch(/saw balances it did not expect/);
    expect(hub1.terminal).toBeUndefined();
    expect(w.chain.calls.filter((c) => c.op === "xfer.r2")).toHaveLength(0);
    await runFor(w, 10);
    expect(findings(w)).toHaveLength(1); // journalled once
    expect(w.chain.calls.filter((c) => c.op === "xfer.r2")).toHaveLength(0);
    w.chain.tokens.get(w.chain.ataKey(DONOR))!.amount -= BigInt(1);
    expect(await runFor(w, 90)).toBe("finished");
    expect(w.chain.calls.filter((c) => c.user === "u101" && c.op === "xfer.r2")).toHaveLength(1);
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
  });

  const policy = "/api/account/wallets/transaction";
  const unwinds = (w: World) => w.journal.entries.filter((e) => e.step.endsWith(".unwind"));
  /** One worker, stopped by `stop` (a command that ends at that point). */
  const oneWorker = (w: World, stop: () => string | null, mode: "until-blocked" | "until-finished" = "until-blocked") =>
    schedule(w.ctx, { users: w.users, workers: 1, mode, stop, paused: () => false, deadlineMs: w.clock.t + 6 * 3_600_000, clock: w.clock });

  it("an RPC failure while S2 is still unresolved never unwinds: it waits (parked), then goes on once S2 resolves", async () => {
    const { w, hub1, peer1 } = await xWorld();
    // S2 lands but does not finalize in time; each later status lookup fails (ChainRpcError) four times.
    w.chain.faults.set("xfer.s2", "unresolved");
    w.chain.inflightAnswers.set("xfer.s2", ["rpc-error", "rpc-error", "rpc-error", "rpc-error"]);
    expect(await runUntilBlocked(w)).toBe("blocked");
    expect(hub1.stage).toBe("xfer.s2");
    expect(hub1.tx["xfer.s2"]?.status).toBe("inflight");
    expect(hub1.ownerTask).toMatch(/^no action unless it persists: xfer\.s2 is still unresolved/);
    // The peer holds the 2 units S2 moved: it waits for the hub instead of leaving.
    expect([peer1.stage, peer1.terminal]).toEqual(["xfer.gate", undefined]);
    expect(w.chain.balanceOf(peer1.wallet)).toBe(BigInt(2));
    expect(await runFor(w, 90)).toBe("finished");
    expect(findings(w)).toEqual([]);
    expect(unwinds(w)).toEqual([]);
    expect(w.users.map((u) => u.terminal)).toEqual(["done", "done", "done", "done"]);
    expect(w.chain.sentWires.filter((x) => x === "u101:xfer.s2")).toHaveLength(1);
    // The RPC failures are information, not findings.
    expect(w.journal.entries.filter((e) => e.user === "u101" && e.step === "xfer.s2" && e.kind === "note").map((e) => e.outcome)).toEqual(["info", "info", "info", "info"]);
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
  });

  it("an RPC failure in a probe and a 502 on a wallet-policy read are retried, never unwound; a failed return-leg read is one 5xx, not two findings", async () => {
    const { w, hub1, peer1 } = await xWorld();
    w.chain.probeFaults.set("P5", 1);
    w.chain.onLand = (u, label) => {
      // After S1: the hub's S2 policy read answers 502 once. After S5: the peer's S6 policy read.
      if (u === hub1 && (label === "xfer.s1" || label === "xo.cancel")) w.site.failNext.set(policy, { status: 502, times: 1 });
    };
    expect(await runUntilBlocked(w)).toBe("finished");
    expect(findings(w).map((e) => [e.user, e.step, e.outcome])).toEqual([
      ["u101", "xfer.s2.policy", "5xx"],
      ["u102", "xfer.r1.policy", "5xx"],
    ]);
    expect(unwinds(w)).toEqual([]);
    expect(w.users.map((u) => u.terminal)).toEqual(["done", "done", "done", "done"]);
    expect(peer1.data.probes?.P5).toBe("passed");
    expect(w.journal.entries.find((e) => e.user === "u102" && e.step === "xfer.probes" && e.kind === "note")).toMatchObject({ outcome: "info" });
    expect(w.journal.entries.find((e) => e.user === "u102" && e.step === "xfer.r1.policy" && e.kind === "note")?.body).toMatch(/502; the return is sent anyway/);
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
  });

  it("a resume without SIM_DONOR_KEYPAIR after S1 landed finishes the seed's C1; a pair yet to borrow waits for the key, never switching to its own buy", async () => {
    const { w, hub1, peer1, hub2, peer2 } = await xWorld();
    // C1 of S1 reads stale once, so the stage is still xfer.seed when the command ends.
    w.chain.staleAfter.set("xfer.s1", { account: w.chain.ataKey(hub1.wallet), values: [BigInt(0)] });
    const seedLanded = () => (hub1.tx["xfer.s1"]?.status === "landed" && hub1.stage === "xfer.seed" ? "the command ended" : null);
    expect(await oneWorker(w, seedLanded)).toBe("stopped");
    w.chain.donor = null; // the next command runs without the donor key
    expect(await runUntilBlocked(w)).toBe("blocked");
    expect([hub1.terminal, peer1.terminal]).toEqual(["done", "done"]);
    expect(w.state.market.loan).toBeUndefined();
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
    const s1 = checks(w, "xfer.S1.balance");
    expect(s1.map((e) => e.outcome)).toEqual(["ok"]);
    expect(s1[0].body).toMatch(/^lag \d+s$/);
    expect(hub2.stage).toBe("xfer.gate");
    expect(hub2.data.xferSource).toBeUndefined();
    expect(hub2.ownerTask).toMatch(/^run the simulator with SIM_DONOR_KEYPAIR/);
    expect(peer2.ownerTask).toMatch(/^no action of its own: waits for u103 \(run the simulator with SIM_DONOR_KEYPAIR/);
    w.chain.donor = DONOR;
    expect(await runFor(w, 90)).toBe("finished");
    expect(findings(w)).toEqual([]);
    expect(hub2.data.xferSource).toBe("donor");
    expect(w.users.map((u) => u.terminal)).toEqual(["done", "done", "done", "done"]);
  });

  it("a lost S2 status whose effect cannot be read unwinds; the peer returns what S2 moved instead of leaving", async () => {
    const { w, hub1, peer1 } = await xWorld();
    // S2 lands but the node loses its status (resolved as dropped); every read of its effect then fails.
    w.chain.faults.set("xfer.s2", "landed-status-lost");
    w.chain.onLand = (u, label) => {
      if (u === hub1 && label === "xfer.s2") w.chain.doneFaults.set("xfer.s2", 3);
    };
    expect(await runUntilBlocked(w)).toBe("finished");
    // Two failed reads are retried as information; the third unwinds the pair and is the one finding.
    expect(findings(w).map((e) => [e.user, e.step, e.outcome])).toEqual([["u101", "xfer.s2", "tx-error"]]);
    expect(unwinds(w).map((e) => [e.user, e.step])).toEqual([["u101", "xfer.s2.unwind"]]);
    expect(hub1.tx["xfer.s2"]).toBeUndefined();
    expect(w.journal.entries.find((e) => e.user === "u102" && e.step === "xfer.gate" && e.kind === "note")?.body).toMatch(/unwound after signing S2/);
    expect(sends(w, peer1)).toEqual(["xfer.r1"]);
    expect(sends(w, hub1)).toEqual(["xfer.s1", "xfer.s2", "xfer.r2"]);
    expect(w.chain.sentWires.filter((x) => x === "u101:xfer.s2")).toHaveLength(1);
    expect([hub1.terminal, peer1.terminal]).toEqual(["failed", "failed"]);
    expect(peer1.reason).toMatch(/its units are back at the hub/);
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
    expect(w.users[2].terminal).toBe("done");
  });

  it("a refused deposit after the offer landed unwinds through xo.cancel: the undeposited offer is cancelled, none left Open", async () => {
    const { w, hub1, peer1 } = await xWorld();
    w.chain.faults.set("xo.deposit", "sim-error");
    expect(await runUntilBlocked(w)).toBe("finished");
    expect(findings(w).map((e) => [e.step, e.outcome])).toEqual([["xo.deposit", "tx-error"]]);
    expect(sends(w, hub1)).toEqual(["xfer.s1", "xfer.s2", "xo.create", "xo.cancel", "xfer.r2"]);
    const pda = hub1.data.offers!.xo.pda;
    expect(w.chain.offers.get(pda)).toMatchObject({ status: OfferStatus.Cancelled, deposited: BigInt(0) });
    expect(w.chain.markers.has(pda)).toBe(false);
    expect(checks(w, "xfer.S5.offer").map((e) => e.outcome)).toEqual(["ok"]);
    // E1/E2 are not run against an offer the unwinding hub cancels.
    expect(w.chain.calls.filter((c) => c.op === "probe E1" || c.op === "probe E2")).toEqual([]);
    expect([hub1.terminal, peer1.terminal]).toEqual(["failed", "failed"]);
    expect(checks(w, "xfer.conservation").map((e) => e.outcome)).toEqual(["ok", "ok"]);
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
    expect(w.users[2].terminal).toBe("done");
  });

  it("a process death after S2 was sent resumes from the snapshot persisted before the send: one wire, no finding", async () => {
    const w = await world(x, { pace: true, persist: true });
    w.site.termsPublished = false;
    const [hub1] = w.users;
    w.chain.faults.set("xfer.s2", "process-death");
    await expect(oneWorker(w, () => null)).rejects.toBeInstanceOf(FakeProcessDeath);
    reload(w);
    // What the new process finds: the snapshot and the inflight record, both persisted before the send.
    expect(hub1.stage).toBe("xfer.s2");
    expect(hub1.tx["xfer.s2"]).toMatchObject({ status: "inflight", sig: "sig-u101-xfer.s2" });
    expect(hub1.data.xfer?.S2).toMatchObject({ srcBefore: "3", dstBefore: "0", amount: "2" });
    expect(await runUntilBlocked(w)).toBe("finished");
    expect(findings(w)).toEqual([]);
    expect(w.chain.sentWires.filter((x) => x === "u101:xfer.s2")).toHaveLength(1);
    expect(w.users.map((u) => u.terminal)).toEqual(["done", "done", "done", "done"]);
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
  });

  it("a parked return leg that then lands is no longer an owner wait during its C1 re-reads: the wave finishes, not blocked", async () => {
    const { w, hub1 } = await xWorld();
    w.chain.failAlways.add("xfer.r2");
    expect(await runUntilBlocked(w)).toBe("blocked");
    expect(hub1.awaitingOwner).toBe(true);
    w.chain.failAlways.delete("xfer.r2");
    // The first finalized read of the donor lags once after S7.
    w.chain.staleAfter.set("xfer.r2", { account: w.chain.ataKey(DONOR), values: [BigInt(2)] });
    const s7Landed = () => (hub1.tx["xfer.r2"]?.status === "landed" ? "S7 landed" : null);
    expect(await oneWorker(w, s7Landed, "until-finished")).toBe("stopped");
    expect([hub1.stage, hub1.awaitingOwner, hub1.ownerTask]).toEqual(["xfer.r2", false, undefined]);
    // Pair 2 mirrored it: released in the same step, not 2 min later.
    expect(w.users.slice(2).map((u) => [u.awaitingOwner, u.ownerTask])).toEqual([[false, undefined], [false, undefined]]);
    expect(renderOwnerQueue(w.state)).not.toMatch(/keeps failing/);
    expect(await runUntilBlocked(w)).toBe("finished");
    expect(checks(w, "xfer.S7.balance").find((e) => e.user === "u101")).toMatchObject({ outcome: "ok", body: expect.stringMatching(/^lag 1\ds$/) });
    expect(w.users.map((u) => u.terminal)).toEqual(["done", "done", "done", "done"]);
  });

  it("a hub that holds less than the loan never snapshots S7: one finding, parked, and S7 once the units are back", async () => {
    const { w, hub1 } = await xWorld();
    // A unit leaves the hub outside the simulator right after S5 brought the escrow's unit back.
    w.chain.onLand = (u, label) => {
      if (u === hub1 && label === "xo.cancel") w.chain.tokens.get(w.chain.ataKey(hub1.wallet))!.amount -= BigInt(1);
    };
    expect(await runUntilBlocked(w)).toBe("blocked");
    // The unit vanished right after S5, so S5's C1 sees it too; then S7 is held.
    expect(findings(w).map((e) => [e.step, e.outcome])).toEqual([
      ["xfer.S5.balance", "consistency"],
      ["xfer.S7.held", "consistency"],
    ]);
    expect(hub1.ownerTask).toMatch(/holds 2 of the 3 lent units; S7 waits/);
    expect(hub1.data.xfer?.S7).toBeUndefined();
    expect(w.chain.calls.filter((c) => c.op === "xfer.r2")).toHaveLength(0);
    w.chain.tokens.get(w.chain.ataKey(hub1.wallet))!.amount += BigInt(1);
    expect(await runFor(w, 90)).toBe("finished");
    expect(findings(w).filter((e) => e.step === "xfer.S7.held")).toHaveLength(1);
    expect(w.chain.balanceOf(DONOR)).toBe(BigInt(5));
  });
});
