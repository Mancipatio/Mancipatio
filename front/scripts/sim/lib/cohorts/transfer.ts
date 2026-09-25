/**
 * X: direct Token-2022 transfers between holders (design-transfers.md §D.4),
 * two hub/peer pairs in wave 6 on class A (Open on devnet). The hub's units
 * come from a 3-unit loan of e2e buyer3, returned in the pair's last send, or
 * from its own buy on sale [1] (pair 2 while the terms answer 200; any hub
 * the donor cannot lend to).
 *
 *   hub   xfer.gate    loan: the donor holds ≥ 3, the chain CLI lock, the C3
 *                      and C5 baselines, then market.loan; own: buy.terms
 *                      (the buy machine) → xfer.ready (the C3 baseline)
 *         xfer.seed    S1 donor → hub, 3 (the hub pays and creates its ATA)
 *         xfer.p1      P1 (pair 1)
 *         xfer.s2      S2 hub → peer, 2, creating the peer's ATA; C4
 *         xo.create    S3 (pair 1, after the peer's probes)
 *         xo.deposit   S4: 1 P2P unit into the offer escrow; C2
 *         xo.cancel    S5 (after the peer's escrow probes): the unit back; C2
 *         xfer.r2      S7 hub → donor, 3 (after the peer's S6); C3, C5, loan cleared
 *   peer  xfer.gate    waits for S2
 *         xfer.probes  pair 1: P2–P8, B1–B4, D1, D2, L1, one per step, never sent
 *         xfer.escrow  pair 1: E1, E2 on the live offer escrow
 *         xfer.r1      S6 peer → hub, all it holds, once the hub is done with its ATA
 *
 * S3–S5 repeat chain:e2e G3 and trader pair 1's o2; they are here only to
 * give E1/E2 a live escrow holding units that arrived peer-to-peer.
 *
 * Every send: the wallet-policy read (C6), a snapshot persisted BEFORE the
 * send (transferLanded decides a resume: a lost status never re-sends), then
 * C1 — the balances /portfolio renders — re-read at +10 s and +20 s before a
 * lag becomes a finding. One user touches an ATA at a time: the gates order
 * the legs so no C1 reads a balance another leg is moving.
 *
 * Once units are out (the seed landed, or the hub bought its own) no user of
 * the pair goes terminal until they are back: a failure anywhere else jumps
 * straight to the return legs (xo.cancel when a unit sits in the offer
 * escrow, xfer.r1, xfer.r2), which retry without a limit — parked as a
 * no-action owner-queue line after MAX_ATTEMPTS, so a wave still ends
 * "blocked" and the next command continues them. A user waiting on a partner
 * that waits for the owner mirrors that wait.
 */
import type { Address } from "@solana/kit";
import { OfferStatus } from "@/lib/generated/asset_registry";
import { TOKEN_2022 } from "@/lib/transaction-builders";
import { ChainAbortError } from "@/scripts/chain/lib/safety";
import { SimRetryLater, SimTxError, type OfferView } from "../chain";
import { DEVNET_PLATFORM_KYC_REGISTRY, PACE, PAYMENT_UNIT, XFER_OFFER_UNITS, XFER_PEER_UNITS, XFER_UNITS } from "../constants";
import { prng } from "../identity";
import { SimStopError } from "../safety";
import type { UserState, XferBase, XferSnapshot } from "../state";
import { PROBES, XferDiverged, probeDef, type ProbePair } from "../transfers";
import { MAX_ATTEMPTS, RETRY_MS, actor, check, finish, go, later, note, retry, walletPolicy, type SimCtx } from "./common";

/** The tx label of each sent row (S3–S5 are the offer instructions' own labels). */
export const XFER_LABELS = { S1: "xfer.s1", S2: "xfer.s2", S4: "xo.deposit", S5: "xo.cancel", S6: "xfer.r1", S7: "xfer.r2" } as const;
type Row = keyof typeof XFER_LABELS;

const HUB_STAGES = ["xfer.gate", "xfer.seed", "xfer.ready", "xfer.p1", "xfer.s2", "xo.create", "xo.deposit", "xo.cancel", "xfer.r2"];
const PEER_STAGES = ["xfer.gate", "xfer.probes", "xfer.escrow", "xfer.r1"];
/** The legs that bring units back: they never give up. */
const RETURN_STAGES = new Set(["xo.cancel", "xfer.r1", "xfer.r2"]);
export const PEER_PROBES = PROBES.filter((p) => p.stage === "xfer.probes").map((p) => p.id);
export const ESCROW_PROBES = PROBES.filter((p) => p.stage === "xfer.escrow").map((p) => p.id);
/** C1 reads: at once, +10 s, +20 s. */
const C1_READS = 3;
const C1_REREAD_MS = 10_000;
const WAIT_MS = 30_000;
const MIRROR = "no action of its own:";
const ZERO = BigInt(0);
/** The account setup (cohorts/common.ts) every user runs first. */
const SETUP_STAGES = new Set(["session", "me", "name", "tos"]);

const isHub = (u: UserState) => u.plan.variant !== "xfer-peer";
const landed = (u: UserState | undefined, label: string) => u?.tx[label]?.status === "landed";
const flag = (u: UserState, name: string) => Boolean(u.data.flags?.[name]);
const setFlag = (u: UserState, name: string) => void (u.data.flags = { ...(u.data.flags ?? {}), [name]: true });
const n = (v: bigint | null | undefined) => v ?? ZERO;
/** The outstanding loan, read fresh (another worker may set it during an await). */
const loanOf = (ctx: SimCtx) => ctx.state.market.loan;

/** The other user of this pair (hub ↔ peer). */
export function xferPartner(ctx: SimCtx, u: UserState): UserState | undefined {
  return Object.values(ctx.state.users).find((o) => o.plan.cohort === "X" && o.plan.xpair === u.plan.xpair && isHub(o) !== isHub(u));
}

/** A readable name for an owner in a check's detail. */
function nameOf(ctx: SimCtx, owner: string): string {
  const user = Object.values(ctx.state.users).find((o) => o.wallet === owner);
  if (user) return user.plan.label;
  if (owner === ctx.state.market.loan?.donor) return "donor";
  return `${owner.slice(0, 4)}…`;
}

// ── Waiting, leaving and failing ────────────────────────────────────────────

/** Waits for `other`; mirrors its owner wait so a wave can end "blocked" while `watch` polls on. */
function waitOn(ctx: SimCtx, u: UserState, other: UserState | undefined, ms = WAIT_MS): void {
  if (other?.awaitingOwner) {
    u.awaitingOwner = true;
    u.ownerTask = other.ownerTask?.startsWith(MIRROR) ? other.ownerTask : `${MIRROR} waits for ${other.plan.label} (${other.ownerTask ?? other.stage})`;
    u.notBefore = ctx.now() + PACE.watchIntervalMs;
    return;
  }
  u.awaitingOwner = false;
  u.ownerTask = undefined;
  later(ctx, u, ms);
}

/** Parks the user with a no-action owner-queue line and re-checks every 2 min. */
function park(ctx: SimCtx, u: UserState, task: string): void {
  u.awaitingOwner = true;
  u.ownerTask = `no action unless it persists: ${task}`;
  u.notBefore = ctx.now() + PACE.watchIntervalMs;
}

/** The partner ended before any unit reached this user: nothing to return. */
function leave(ctx: SimCtx, u: UserState, reason: string): void {
  note(ctx, u, "xfer.leave", reason);
  finish(u, "stopped", reason);
}

/** The pair's units are out: the seed landed, or the hub bought its own. */
function unitsOut(ctx: SimCtx, u: UserState): boolean {
  const hub = isHub(u) ? u : xferPartner(ctx, u);
  if (!hub) return false;
  return landed(hub, XFER_LABELS.S1) || (hub.data.xferSource === "own" && landed(hub, "buy"));
}

/**
 * What a failure does to a cohort-X user (a thrown error, an HTTP refusal,
 * the wallet-policy read): a return leg retries without a limit; with units
 * out any other stage unwinds the pair; before that the ordinary backoff.
 */
function fail(ctx: SimCtx, u: UserState, reason: string): void {
  if (RETURN_STAGES.has(u.stage)) return keepReturning(ctx, u, reason);
  if (u.stage === "xfer.seed" && !landed(u, XFER_LABELS.S1)) return seedFailed(ctx, u, reason);
  if (unitsOut(ctx, u)) return unwind(ctx, u, reason);
  retry(ctx, u, reason);
}

/** Return legs are exempt from MAX_ATTEMPTS: backoff, then parked and retried every 2 min. */
function keepReturning(ctx: SimCtx, u: UserState, reason: string): void {
  u.attempts += 1;
  if (u.attempts < MAX_ATTEMPTS) {
    u.awaitingOwner = false;
    u.ownerTask = undefined;
    return later(ctx, u, RETRY_MS * u.attempts);
  }
  park(ctx, u, `${u.stage} keeps failing (${reason.slice(0, 160)}); the units stay out until it lands, retried every ${PACE.watchIntervalMs / 60_000} min`);
}

/** Straight to the return legs: a unit in the offer escrow first, then the peer, then the hub. */
function unwind(ctx: SimCtx, u: UserState, reason: string): void {
  note(ctx, u, `${u.stage}.unwind`, `${reason.slice(0, 200)} — units are out, so the pair returns them now`);
  setFlag(u, "xferAbort");
  if (isHub(u)) {
    go(u, landed(u, XFER_LABELS.S4) && !landed(u, XFER_LABELS.S5) ? "xo.cancel" : "xfer.r2");
  } else {
    setFlag(u, "probesDone");
    setFlag(u, "escrowProbesDone");
    go(u, "xfer.r1");
  }
  later(ctx, u, RETRY_MS);
}

/** The seed has not landed, so nothing moved: the ordinary backoff, then the loan is given up in its stage. */
function seedFailed(ctx: SimCtx, u: UserState, reason: string): void {
  u.attempts += 1;
  if (u.attempts < MAX_ATTEMPTS) return later(ctx, u, RETRY_MS * u.attempts);
  note(ctx, u, "xfer.seed.give-up", reason.slice(0, 200));
  setFlag(u, "seedGiveUp");
  later(ctx, u, RETRY_MS);
}

/**
 * transferLanded saw neither the pre- nor the post-state. A row never signed
 * cannot have moved anything, so its snapshot is re-taken; otherwise one
 * consistency finding, no send, and a re-check every 2 min.
 */
function diverged(ctx: SimCtx, u: UserState, error: XferDiverged): void {
  const row = (Object.keys(XFER_LABELS) as Row[]).find((r) => XFER_LABELS[r] === error.label);
  if (row && !ctx.chain.everSigned(u, error.label)) {
    note(ctx, u, `xfer.${row}.snapshot`, `${error.detail}; never signed, so the snapshot is taken again`);
    delete u.data.xfer?.[row];
    return later(ctx, u, C1_REREAD_MS);
  }
  if (!flag(u, `diverged:${error.label}`)) {
    check(ctx, u, `xfer.${row ?? error.label}.state`, false, error.detail);
    setFlag(u, `diverged:${error.label}`);
  }
  park(ctx, u, `${error.label} saw balances it did not expect (${error.detail}); nothing is sent until they match`);
}

/** C6 on a return leg is evidence, not a gate: the units go back even while the site refuses. */
async function returnPolicy(ctx: SimCtx, u: UserState, step: string): Promise<void> {
  await walletPolicy(ctx, u, step, (c, user, reason) => {
    if (reason.startsWith("account.wallets")) check(c, user, `${step}.policy`, false, `${reason}; the return is sent anyway`);
  });
}

// ── Snapshots and checks ────────────────────────────────────────────────────

/** A row's pre-send snapshot (finalized balances), persisted before the send and kept from then on. */
async function snapshot(
  ctx: SimCtx,
  u: UserState,
  row: Row,
  s: { srcOwner: string; src?: string; dstOwner: string; dst?: string; amount: bigint | "all" },
): Promise<XferSnapshot> {
  const map = (u.data.xfer ??= {});
  if (map[row]) return map[row];
  const srcAta = s.src ?? (await ctx.chain.ata(s.srcOwner as Address));
  const dstAta = s.dst ?? (await ctx.chain.ata(s.dstOwner as Address));
  const [src, dst] = await ctx.chain.balances([srcAta as Address, dstAta as Address]);
  map[row] = {
    srcOwner: s.srcOwner,
    srcAta,
    dstOwner: s.dstOwner,
    dstAta,
    amount: (s.amount === "all" ? n(src) : s.amount).toString(),
    srcBefore: n(src).toString(),
    dstBefore: n(dst).toString(),
    ...(dst === null ? { newDst: true } : {}),
  };
  ctx.persist();
  return map[row];
}

/** C1b: a destination the transfer created is the receiver's Token-2022 ATA with ImmutableOwner. */
async function ataProblem(ctx: SimCtx, snap: XferSnapshot): Promise<string | null> {
  const view = await ctx.chain.tokenAccount(snap.dstAta as Address);
  if (!view) return `the new ATA ${snap.dstAta} does not exist`;
  const wrong: string[] = [];
  if (view.program !== TOKEN_2022) wrong.push(`owned by ${view.program}`);
  if (view.mint !== ctx.market.mintA) wrong.push(`mint ${view.mint}`);
  if (view.owner !== snap.dstOwner) wrong.push(`owner ${view.owner}`);
  // Later hook legs out of this account need it (the hook refuses a destination without it).
  if (!view.immutableOwner) wrong.push("no ImmutableOwner extension");
  return wrong.length ? `new ATA ${snap.dstAta}: ${wrong.join(", ")}` : null;
}

/**
 * C1 after a send landed (plus C1b for a new ATA and `extra`, C2's offer
 * view): the balances /portfolio renders at finalized. Right on the first
 * read: ok; within the +10 s / +20 s re-reads: ok with "lag Ns"; still wrong:
 * a consistency finding. False while a re-read is due.
 */
async function c1(ctx: SimCtx, u: UserState, row: Row, extra?: () => Promise<string | null>): Promise<boolean> {
  const snap = u.data.xfer![row];
  if (snap.checked) return true;
  const [src, dst] = await ctx.chain.balances([snap.srcAta as Address, snap.dstAta as Address]);
  const wantSrc = BigInt(snap.srcBefore) - BigInt(snap.amount);
  const wantDst = BigInt(snap.dstBefore) + BigInt(snap.amount);
  const problems = new Map<string, string>();
  if (n(src) !== wantSrc || n(dst) !== wantDst) {
    problems.set("balance", `expected ${nameOf(ctx, snap.srcOwner)}=${wantSrc} ${nameOf(ctx, snap.dstOwner)}=${wantDst}, saw ${n(src)} and ${n(dst)}`);
  }
  const ata = snap.newDst ? await ataProblem(ctx, snap) : null;
  if (ata) problems.set("ata", ata);
  const offer = extra ? await extra() : null;
  if (offer) problems.set("offer", offer);
  const now = ctx.now();
  snap.checkAt ??= now;
  snap.reads = (snap.reads ?? 0) + 1;
  const lag = Math.round((now - snap.checkAt) / 1_000);
  if (problems.size && snap.reads < C1_READS) {
    ctx.persist();
    return false;
  }
  for (const what of ["balance", ...(snap.newDst ? ["ata"] : []), ...(extra ? ["offer"] : [])]) {
    const problem = problems.get(what);
    check(ctx, u, `xfer.${row}.${what}`, !problem, problem ? `${problem} (still after ${snap.reads} reads over ${lag} s)` : snap.reads > 1 ? `lag ${lag}s` : "first read");
  }
  snap.checked = true;
  ctx.persist();
  return true;
}

function describeOffer(view: OfferView | null): string {
  return view ? `status ${OfferStatus[view.status]}, deposited ${view.deposited}` : "no offer account";
}

type Aggregate = { pledged?: string; settled?: string; backers?: number };

/** commitment-aggregate of both simulator sales (C5): a P2P transfer is never counted as a purchase. */
async function readAggregates(ctx: SimCtx, u: UserState, onFail: (reason: string) => void): Promise<NonNullable<XferBase["aggregates"]> | null> {
  const out: NonNullable<XferBase["aggregates"]> = {};
  for (const sale of ctx.market.sales) {
    const r = await ctx.http.post<Aggregate>(actor(ctx, u), { step: "xfer.aggregate", route: "/api/launchpad/commitment-aggregate", body: { sale_pubkey: sale } });
    if (r.outcome !== "ok") {
      onFail(`commitment-aggregate ${r.status}`);
      return null;
    }
    out[sale] = { pledged: String(r.data?.pledged ?? "0"), settled: String(r.data?.settled ?? "0"), backers: r.data?.backers ?? 0 };
  }
  return out;
}

const BUY_STAGES = new Set(["buy.send", "buy.record", "buy.aggregate"]);

/** Units of simulator buys that landed since `since` (ISO); `busy`: a buy is still being sent or recorded. */
function simulatorBuys(ctx: SimCtx, since: string): { units: number; busy: boolean } {
  let units = 0;
  let busy = false;
  for (const o of Object.values(ctx.state.users)) {
    if (o.tx.buy?.status === "landed" && o.tx.buy.at >= since) units += o.data.buyUnits ?? 0;
    if (BUY_STAGES.has(o.stage)) busy = true;
  }
  return { units, busy };
}

/**
 * C3 at the end (once): the loan is back (the donor at its gate value) and
 * donor + hub + peer (+ the offer escrow) equals the gate total. Supply moves
 * with every buyer, so a change is information, set against the
 * simulator's own buys in the window.
 */
async function conservation(ctx: SimCtx, hub: UserState, peer: UserState): Promise<void> {
  const base = hub.data.xferBase;
  if (!base || flag(hub, "c3")) return;
  const loan = ctx.state.market.loan;
  const donor = base.parts.donor !== undefined ? loan?.donor : undefined;
  const escrow = hub.data.xfer?.S5?.srcAta ?? hub.data.xfer?.S4?.dstAta;
  const owners = [...(donor ? [donor] : []), hub.wallet, peer.wallet];
  const accounts = [...(await Promise.all(owners.map((o) => ctx.chain.ata(o as Address)))), ...(escrow ? [escrow as Address] : [])];
  const values = await ctx.chain.balances(accounts);
  const sum = values.reduce((s: bigint, v) => s + n(v), ZERO);
  if (donor) check(ctx, hub, "xfer.loan", n(values[0]) === BigInt(base.parts.donor), `the donor holds ${n(values[0])}, ${base.parts.donor} before the loan`);
  const counted = `${donor ? "donor + " : ""}hub + peer${escrow ? " + offer escrow" : ""}`;
  check(ctx, hub, "xfer.conservation", sum === BigInt(base.sum), `${counted} = ${sum}, ${base.sum} at the gate (a transfer never mints or burns)`);
  const now = await ctx.chain.supply();
  const bought = simulatorBuys(ctx, base.at).units;
  note(
    ctx,
    hub,
    "xfer.supply",
    `class A supply Δ${now.supply - BigInt(base.supply)}, circulating Δ${now.circulating - BigInt(base.circulating)}; simulator buys landed in the window: ${bought} units`,
  );
  setFlag(hub, "c3");
}

/** C5 at the end (once, loan route): the aggregates did not move, unless a buy landed in the window. */
async function aggregatesUnchanged(ctx: SimCtx, hub: UserState): Promise<boolean> {
  const base = hub.data.xferBase;
  if (!base?.aggregates || flag(hub, "c5")) return true;
  const buys = simulatorBuys(ctx, base.at);
  if (buys.units > 0 || buys.busy) {
    note(ctx, hub, "xfer.aggregate", "C5 skipped: a simulator buy landed or was being recorded in the window");
  } else {
    const now = await readAggregates(ctx, hub, (reason) => keepReturning(ctx, hub, reason));
    if (!now) return false;
    for (const [sale, before] of Object.entries(base.aggregates)) {
      const after = now[sale];
      const same = after && after.pledged === before.pledged && after.settled === before.settled && after.backers === before.backers;
      check(ctx, hub, "xfer.aggregate", Boolean(same), `sale ${sale}: ${JSON.stringify(before)} at the gate, ${JSON.stringify(after)} now`);
    }
  }
  setFlag(hub, "c5");
  return true;
}

// ── Probes ──────────────────────────────────────────────────────────────────

/** One probe (never sent); its verdict keeps it from running twice. A mismatch is journalled, not retried. */
async function runProbe(ctx: SimCtx, u: UserState, id: string): Promise<void> {
  const probes = (u.data.probes ??= {});
  if (probes[id]) return;
  const def = probeDef(id);
  const hub = isHub(u) ? u : xferPartner(ctx, u)!;
  const peer = isHub(u) ? xferPartner(ctx, u)! : u;
  const xo = hub.data.offers?.xo;
  const view = def.stage === "xfer.escrow" && xo ? await ctx.chain.offer(xo.pda as Address) : null;
  const pair: ProbePair = {
    hub: ctx.signer(hub.plan.label),
    peer: ctx.signer(peer.plan.label),
    mint: ctx.market.mintA,
    mintB: ctx.market.mintB ?? null,
    registry: ctx.market.kycRegistry ?? DEVNET_PLATFORM_KYC_REGISTRY,
    peerBalance: async () => n((await ctx.chain.balances([await ctx.chain.ata(peer.wallet as Address)]))[0]),
    offer: xo && view ? { pda: xo.pda as Address, escrow: view.escrow as Address } : undefined,
  };
  const spec = await def.spec(pair);
  if (!spec) {
    note(ctx, u, `xfer.${id}`, `not drivable with this pair (${def.what}); skipped`);
    probes[id] = "skipped";
  } else {
    const outcome = await ctx.chain.probe(u, id, spec, def.expect);
    probes[id] = outcome === "ok" || outcome === "expected-error" ? "passed" : outcome === "unexpected-accept" ? "unexpected-accept" : "mismatch";
  }
  ctx.persist();
}

// ── The hub ─────────────────────────────────────────────────────────────────

function ownRoute(ctx: SimCtx, u: UserState, why: string): void {
  note(ctx, u, "xfer.gate", `the hub buys its own ${XFER_UNITS} units: ${why}`);
  u.data.xferSource = "own";
  go(u, "buy.terms");
}

function xoOfferId(runId: string, u: UserState): bigint {
  const rand = prng("sim-xfer-offer", runId, u.plan.n);
  return BigInt(1_000_000 + Math.floor(rand() * 2_000_000_000));
}

async function hubGate(ctx: SimCtx, u: UserState, peer: UserState): Promise<void> {
  const loan = ctx.state.market.loan;
  if (loan?.hub === u.plan.label) return go(u, "xfer.seed"); // the loan was taken before a restart
  if (peer.terminal) return leave(ctx, u, `peer ${peer.plan.label} ended ${peer.terminal} before any unit moved`);
  // Nothing is lent to a peer whose account setup could still fail.
  if (peer.stage !== "xfer.gate") return waitOn(ctx, u, peer);
  if (u.plan.xpair === 2) {
    // Pair 2 prefers bought units; read live (the command's termsOk goes stale in `watch`).
    const sale = ctx.market.sales[1];
    const r = await ctx.http.get(actor(ctx, u), { step: "xfer.terms", route: `/api/launchpad/terms?sale=${sale}`, expect: [200, 409] });
    if (r.status === 200) return ownRoute(ctx, u, "the launchpad terms answer 200");
    if (r.outcome !== "expected-error") return fail(ctx, u, `launchpad.terms ${r.status}`);
    // Pair 1 borrows first: pair 2 decides once pair 1's hub has left its gate.
    const first = Object.values(ctx.state.users).find((o) => o.plan.cohort === "X" && o.plan.xpair === 1 && isHub(o));
    if (first && !first.terminal && (first.stage === "xfer.gate" || SETUP_STAGES.has(first.stage))) return waitOn(ctx, u, first);
  }
  // One loan at a time.
  const other = loanOf(ctx);
  if (other) return waitOn(ctx, u, ctx.state.users[other.hub], PACE.watchIntervalMs);
  const donor = ctx.chain.donor;
  if (!donor) return ownRoute(ctx, u, "no donor signer (SIM_DONOR_KEYPAIR unset)");
  const atas = await Promise.all([donor, u.wallet, peer.wallet].map((w) => ctx.chain.ata(w as Address)));
  const [d, h, q] = await ctx.chain.balances(atas);
  if (n(d) < XFER_UNITS) return ownRoute(ctx, u, `the donor holds ${n(d)} class A units (fewer than ${XFER_UNITS})`);
  if (ctx.chainLock && !ctx.chainLock()) {
    return park(ctx, u, "the loan waits for the chain CLI's devnet lock (a chain:e2e devnet run holds it)");
  }
  const supply = await ctx.chain.supply();
  // C5 needs a quiet window: a buy still being sent or recorded would move the aggregate inside it.
  const quiet = !simulatorBuys(ctx, new Date().toISOString()).busy;
  const aggregates = quiet ? await readAggregates(ctx, u, (reason) => fail(ctx, u, reason)) : undefined;
  if (aggregates === null) return;
  if (!quiet) note(ctx, u, "xfer.aggregate", "C5 skipped: a simulator buy was being sent or recorded at the gate");
  // Re-checked after the reads, with no await before the loan is set: two workers never both take one.
  const taken = loanOf(ctx);
  if (taken) return waitOn(ctx, u, ctx.state.users[taken.hub], PACE.watchIntervalMs);
  const at = new Date().toISOString();
  u.data.xferSource = "donor";
  u.data.xferBase = {
    at,
    parts: { donor: n(d).toString(), hub: n(h).toString(), peer: n(q).toString() },
    sum: (n(d) + n(h) + n(q)).toString(),
    supply: supply.supply.toString(),
    circulating: supply.circulating.toString(),
    ...(aggregates ? { aggregates } : {}),
  };
  ctx.state.market.loan = { pair: u.plan.xpair!, hub: u.plan.label, donor, units: XFER_UNITS.toString(), donorBefore: n(d).toString(), at };
  go(u, "xfer.seed");
  ctx.persist();
}

/** The seed gave up: the loan is released only when nothing moved (a landed seed continues). */
async function abandonSeed(ctx: SimCtx, u: UserState): Promise<boolean> {
  const snap = u.data.xfer?.S1;
  const moved = snap && ctx.chain.everSigned(u, XFER_LABELS.S1) ? await ctx.chain.balances([snap.srcAta as Address, snap.dstAta as Address]) : null;
  if (snap && moved && BigInt(snap.srcBefore) - BigInt(snap.amount) === n(moved[0]) && BigInt(snap.dstBefore) + BigInt(snap.amount) === n(moved[1])) {
    u.data.flags = { ...u.data.flags, seedGiveUp: false };
    return false; // it landed after all: the stage settles it
  }
  if (snap && moved && (n(moved[0]) !== BigInt(snap.srcBefore) || n(moved[1]) !== BigInt(snap.dstBefore))) {
    throw new XferDiverged(XFER_LABELS.S1, `the seed gave up but balances moved: donor ${snap.srcBefore}→${n(moved[0])}, hub ${snap.dstBefore}→${n(moved[1])}`);
  }
  delete ctx.state.market.loan;
  ctx.persist();
  finish(u, "failed", "the loan's seed leg kept failing; nothing moved and the loan is released");
  return true;
}

async function hubStep(ctx: SimCtx, u: UserState): Promise<void> {
  const a = actor(ctx, u);
  const peer = xferPartner(ctx, u);
  if (!peer) return finish(u, "failed", "transfer peer missing from the roster");
  switch (u.stage) {
    case "xfer.gate":
      return hubGate(ctx, u, peer);
    case "xfer.seed": {
      const loan = ctx.state.market.loan;
      if (!loan || loan.hub !== u.plan.label) return go(u, "xfer.gate");
      if (flag(u, "seedGiveUp") && (await abandonSeed(ctx, u))) return;
      if (!u.tx[XFER_LABELS.S1] && !(await walletPolicy(ctx, u, XFER_LABELS.S1, fail))) return;
      const snap = await snapshot(ctx, u, "S1", { srcOwner: loan.donor, dstOwner: u.wallet, amount: BigInt(loan.units) });
      await ctx.chain.seedFromDonor(u, XFER_LABELS.S1, snap, a.signer);
      if (!(await c1(ctx, u, "S1"))) return later(ctx, u, C1_REREAD_MS);
      return go(u, u.plan.xpair === 1 ? "xfer.p1" : "xfer.s2");
    }
    case "xfer.ready": {
      // Own route: the C3 baseline once the buy is finalized.
      if (!u.data.xferBase) {
        const [h, q] = await ctx.chain.balances(await Promise.all([u.wallet, peer.wallet].map((w) => ctx.chain.ata(w as Address))));
        const supply = await ctx.chain.supply();
        u.data.xferBase = {
          at: new Date().toISOString(),
          parts: { hub: n(h).toString(), peer: n(q).toString() },
          sum: (n(h) + n(q)).toString(),
          supply: supply.supply.toString(),
          circulating: supply.circulating.toString(),
        };
        ctx.persist();
      }
      return go(u, u.plan.xpair === 1 ? "xfer.p1" : "xfer.s2");
    }
    case "xfer.p1":
      await runProbe(ctx, u, "P1");
      return go(u, "xfer.s2");
    case "xfer.s2": {
      if (!u.tx[XFER_LABELS.S2]) {
        if (peer.terminal) return unwind(ctx, u, `peer ${peer.plan.label} ended ${peer.terminal}`);
        if (!(await walletPolicy(ctx, u, XFER_LABELS.S2, fail))) return;
      }
      const snap = await snapshot(ctx, u, "S2", { srcOwner: u.wallet, dstOwner: peer.wallet, amount: XFER_PEER_UNITS });
      await ctx.chain.transfer(u, XFER_LABELS.S2, snap, { authority: a.signer, payer: a.signer, createDst: true });
      if (!(await c1(ctx, u, "S2"))) return later(ctx, u, C1_REREAD_MS);
      if (!flag(u, "c4")) {
        // C4: the site's own receiver pre-check agrees with the chain, which just accepted.
        const e = await ctx.chain.eligibility(ctx.market.mintA, peer.wallet as Address);
        check(ctx, u, "xfer.S2.eligibility", !e.gated && e.ok, `checkReceiverEligibility says gated=${e.gated} ok=${e.ok} (${e.reason}) for an Open mint the chain accepted`);
        setFlag(u, "c4");
      }
      return go(u, u.plan.xpair === 1 ? "xo.create" : "xfer.r2");
    }
    case "xo.create": {
      if (flag(peer, "xferAbort")) {
        note(ctx, u, "xo.create", `peer ${peer.plan.label} unwound; the offer steps are skipped`);
        return go(u, "xfer.r2");
      }
      // The probes read the hub's ATA: no offer leg moves it before they are done.
      if (!flag(peer, "probesDone")) return waitOn(ctx, u, peer);
      const offers = (u.data.offers ??= {});
      if (!offers.xo) {
        const id = xoOfferId(ctx.runId, u);
        offers.xo = { offerId: id.toString(), pda: await ctx.chain.offerPda(id), amount: XFER_OFFER_UNITS.toString(), price: PAYMENT_UNIT.toString(), expiresAt: "0" };
        ctx.persist();
      }
      if (!u.tx["xo.create"] && !(await walletPolicy(ctx, u, "xo.create", fail))) return;
      await ctx.chain.createOffer(u, a.signer, "xo", offers.xo);
      return go(u, "xo.deposit");
    }
    case "xo.deposit": {
      const offer = u.data.offers!.xo;
      if (!u.tx[XFER_LABELS.S4] && !(await walletPolicy(ctx, u, XFER_LABELS.S4, fail))) return;
      const escrow = u.data.xfer?.S4?.dstAta ?? (await ctx.chain.offer(offer.pda as Address))?.escrow;
      if (!escrow) throw new Error(`offer ${offer.pda} is missing after create_offer landed`);
      // The P2P units into a platform flow.
      const snap = await snapshot(ctx, u, "S4", { srcOwner: u.wallet, dstOwner: offer.pda, dst: escrow, amount: BigInt(offer.amount) });
      await ctx.chain.depositOffer(u, a.signer, "xo", offer);
      const settled = await c1(ctx, u, "S4", async () => {
        const view = await ctx.chain.offer(offer.pda as Address);
        return view?.status === OfferStatus.Open && view.deposited === BigInt(snap.amount) ? null : `expected Open with ${snap.amount} deposited, saw ${describeOffer(view)}`;
      });
      if (!settled) return later(ctx, u, C1_REREAD_MS);
      return go(u, "xo.cancel");
    }
    case "xo.cancel": {
      const offer = u.data.offers!.xo;
      // E1/E2 need the live escrow; an unwinding hub does not wait for them.
      if (!flag(peer, "escrowProbesDone") && !flag(u, "xferAbort")) return waitOn(ctx, u, peer);
      if (!u.tx[XFER_LABELS.S5]) await returnPolicy(ctx, u, XFER_LABELS.S5);
      const escrow = u.data.xfer?.S5?.srcAta ?? (await ctx.chain.offer(offer.pda as Address))?.escrow;
      if (!escrow) throw new Error(`offer ${offer.pda} is missing before cancel_offer`);
      // cancel_offer pays the whole escrow balance back to the maker.
      const snap = await snapshot(ctx, u, "S5", { srcOwner: offer.pda, src: escrow, dstOwner: u.wallet, amount: "all" });
      await ctx.chain.cancelOffer(u, a.signer, "xo", offer);
      const settled = await c1(ctx, u, "S5", async () => {
        const view = await ctx.chain.offer(offer.pda as Address);
        // Only the EscrowMarker closes: the Offer stays (Cancelled, nothing deposited) with its empty escrow.
        const marker = await ctx.chain.escrowMarker(offer.pda as Address);
        const ok = view?.status === OfferStatus.Cancelled && view.deposited === ZERO && !marker;
        return ok ? null : `expected Cancelled with 0 deposited and no EscrowMarker, saw ${describeOffer(view)}${marker ? ", marker still open" : ""} (snapshot ${snap.amount})`;
      });
      if (!settled) return later(ctx, u, C1_REREAD_MS);
      return go(u, "xfer.r2");
    }
    case "xfer.r2": {
      // The peer returns first (S6); the hub leaves its ATA alone until then.
      if (landed(u, XFER_LABELS.S2) && !peer.terminal) return waitOn(ctx, u, peer);
      const loan = ctx.state.market.loan;
      const lent = u.data.xferSource === "donor" && loan?.hub === u.plan.label;
      if (lent && landed(u, XFER_LABELS.S1)) {
        if (!u.tx[XFER_LABELS.S7]) await returnPolicy(ctx, u, XFER_LABELS.S7);
        const snap = await snapshot(ctx, u, "S7", { srcOwner: u.wallet, dstOwner: loan.donor, amount: BigInt(loan.units) });
        await ctx.chain.transfer(u, XFER_LABELS.S7, snap, { authority: a.signer, payer: a.signer });
        if (!(await c1(ctx, u, "S7"))) return later(ctx, u, C1_REREAD_MS);
      }
      await conservation(ctx, u, peer);
      if (!(await aggregatesUnchanged(ctx, u))) return;
      if (lent) {
        delete ctx.state.market.loan;
        ctx.persist();
      }
      const unwound = flag(u, "xferAbort") || flag(peer, "xferAbort");
      if (unwound) return finish(u, "failed", `unwound after a failure (see the journal); ${lent ? "the loan is returned" : "its own units are back"}`);
      return finish(u, "done", lent ? "loan returned" : "own units back at the hub");
    }
    default:
      return finish(u, "failed", `unknown transfer stage ${u.stage}`);
  }
}

// ── The peer ────────────────────────────────────────────────────────────────

async function peerStep(ctx: SimCtx, u: UserState): Promise<void> {
  const a = actor(ctx, u);
  const hub = xferPartner(ctx, u);
  if (!hub) return finish(u, "failed", "transfer hub missing from the roster");
  switch (u.stage) {
    case "xfer.gate":
      if (landed(hub, XFER_LABELS.S2)) return go(u, u.plan.xpair === 1 && !flag(hub, "xferAbort") ? "xfer.probes" : "xfer.r1");
      if (hub.terminal) return leave(ctx, u, `hub ${hub.plan.label} ended ${hub.terminal} before sending anything`);
      if (hub.stage === "xfer.r2") return leave(ctx, u, `hub ${hub.plan.label} unwound before S2; nothing to return`);
      return waitOn(ctx, u, hub);
    case "xfer.probes": {
      if (flag(hub, "xferAbort")) return unwind(ctx, u, `hub ${hub.plan.label} unwound`);
      const next = PEER_PROBES.find((id) => !u.data.probes?.[id]);
      if (next) return runProbe(ctx, u, next); // one probe per step
      setFlag(u, "probesDone");
      return go(u, "xfer.escrow");
    }
    case "xfer.escrow": {
      const live = landed(hub, XFER_LABELS.S4) && !landed(hub, XFER_LABELS.S5);
      if (!live) {
        if (!flag(hub, "xferAbort")) return waitOn(ctx, u, hub);
        note(ctx, u, "xfer.escrow", `hub ${hub.plan.label} unwound without a live escrow; E1/E2 skipped`);
        setFlag(u, "escrowProbesDone");
        return go(u, "xfer.r1");
      }
      const next = ESCROW_PROBES.find((id) => !u.data.probes?.[id]);
      if (next) return runProbe(ctx, u, next);
      setFlag(u, "escrowProbesDone");
      return go(u, "xfer.r1");
    }
    case "xfer.r1": {
      // The hub is done with its ATA (S5 landed, or pair 2's S2) before this leg moves it.
      if (hub.stage !== "xfer.r2" && !hub.terminal) return waitOn(ctx, u, hub);
      // Drains to zero: the amount is the snapshot's, never a later balance.
      const snap = await snapshot(ctx, u, "S6", { srcOwner: u.wallet, dstOwner: hub.wallet, amount: "all" });
      if (BigInt(snap.amount) === ZERO) return finish(u, "done", "held nothing to return");
      if (!u.tx[XFER_LABELS.S6]) await returnPolicy(ctx, u, XFER_LABELS.S6);
      await ctx.chain.transfer(u, XFER_LABELS.S6, snap, { authority: a.signer, payer: a.signer });
      if (!(await c1(ctx, u, "S6"))) return later(ctx, u, C1_REREAD_MS);
      if (flag(u, "xferAbort") || flag(hub, "xferAbort")) return finish(u, "failed", "unwound after a failure (see the journal); its units are back at the hub");
      return finish(u, "done", "returned its units to the hub");
    }
    default:
      return finish(u, "failed", `unknown transfer stage ${u.stage}`);
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

const STAGES = new Set([...HUB_STAGES, ...PEER_STAGES]);

/** The cohort-X machine: it handles its own failures, so lent units are never left behind. */
export async function transferStep(ctx: SimCtx, u: UserState): Promise<boolean> {
  if (u.plan.cohort !== "X" || !STAGES.has(u.stage)) return false;
  try {
    if (isHub(u)) await hubStep(ctx, u);
    else await peerStep(ctx, u);
  } catch (error) {
    if (error instanceof SimStopError || error instanceof ChainAbortError || error instanceof SimRetryLater) throw error;
    if (error instanceof XferDiverged) {
      diverged(ctx, u, error);
      return true;
    }
    const message = error instanceof Error ? error.message : "unexpected error";
    // The executor journals its own SimTxError; anything else here, as advance() does.
    if (!(error instanceof SimTxError)) {
      ctx.journal.append({ wave: u.plan.wave, user: u.plan.label, cohort: u.plan.cohort, step: u.stage, kind: "note", outcome: "tx-error", err: message.slice(0, 500) });
    }
    fail(ctx, u, message.slice(0, 200));
  }
  return true;
}
