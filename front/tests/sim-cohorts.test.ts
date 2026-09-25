// The simulator's cohort machines (scripts/sim/lib/cohorts) and scheduler
// over a fake site and a fake chain (tests/helpers/sim-fake-site.ts): every
// user's flow to its owner wait, the owner's decisions, replacements after a
// rejected document, the buy/record/aggregate path, the trader pairs, the
// issuer path, the edge cases and the circuit breakers. Offline.
import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import type { SimCtx } from "@/scripts/sim/lib/cohorts/common";
import { EDGE_GROUPS } from "@/scripts/sim/lib/cohorts/edge";
import { SimHttp } from "@/scripts/sim/lib/http";
import { buildRoster, type UserPlan } from "@/scripts/sim/lib/identity";
import { FINDING_OUTCOMES, MemoryJournal } from "@/scripts/sim/lib/journal";
import { Limiter, type Clock } from "@/scripts/sim/lib/pacing";
import { schedule } from "@/scripts/sim/lib/runner";
import { newState, newUserState, type SimState, type UserState } from "@/scripts/sim/lib/state";
import { ASSET, FakeChainOps, FakeSite, SALES } from "./helpers/sim-fake-site";

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

type World = { ctx: SimCtx; site: FakeSite; chain: FakeChainOps; journal: MemoryJournal; clock: ReturnType<typeof fakeClock>; state: SimState; users: UserState[]; limiter: Limiter };

async function world(plans: UserPlan[]): Promise<World> {
  const site = new FakeSite();
  const chain = new FakeChainOps(site);
  const journal = new MemoryJournal();
  const clock = fakeClock();
  const limiter = new Limiter({ clock });
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
    market: { sales: SALES, asset: ASSET, classA: SALES[1] as never, mintA: SALES[0] as never, paymentMint: ASSET, termsOk: true },
    signer: (label) => signers.get(label)!,
    now: clock.now,
    persist: () => {},
    log: () => {},
    passport: async (wallet) => (await chain.passports([wallet])).get(wallet) ?? false,
  };
  return { ctx, site, chain, journal, clock, state, users: plans.map((p) => state.users[p.label]), limiter };
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
