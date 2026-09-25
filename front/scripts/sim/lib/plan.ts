/**
 * `SIM_CMD=plan`: the roster, the owner's workload and the request budget,
 * offline (no network, no keys). The budget is an estimate: fixed steps are
 * exact, owner-wait polls assume the owner answers within ~10 minutes.
 */
import { DEFAULT_RULES } from "./pacing";
import { BUYER_PAYMENT, PACE, PAYMENT_UNIT, SITE_ORIGIN, SOL_BUYER, SOL_ISSUER } from "./constants";
import { docTargetSize } from "./docs";
import { buildRoster, hasDossier, type UserPlan } from "./identity";
import { EDGE_GROUPS } from "./cohorts/edge";

export type Cost = { writes: number; reads: number; uploads: number; verify: number; tx: number; rpc: number; bytes: number };

const ZERO: Cost = { writes: 0, reads: 0, uploads: 0, verify: 0, tx: 0, rpc: 0, bytes: 0 };
/** RPC calls per transaction: blockhash, 2 simulations, send, ~8 status polls, ~2 block heights, builder reads. */
export const RPC_PER_TX = 16;
/** Owner-wait polls assumed per wait (one every 2 min). */
export const POLLS_PER_WAIT = 5;

function add(a: Cost, b: Partial<Cost>): Cost {
  return {
    writes: a.writes + (b.writes ?? 0),
    reads: a.reads + (b.reads ?? 0),
    uploads: a.uploads + (b.uploads ?? 0),
    verify: a.verify + (b.verify ?? 0),
    tx: a.tx + (b.tx ?? 0),
    rpc: a.rpc + (b.rpc ?? 0) + (b.tx ?? 0) * RPC_PER_TX,
    bytes: a.bytes + (b.bytes ?? 0),
  };
}

const EDGE_COST: Record<string, Partial<Cost>> = {
  "nonce-replay": { writes: 2 },
  "nonce-replay-write": { writes: 2 },
  "oversize-8k": { writes: 1, verify: 1 },
  "age-17": { writes: 1, verify: 1 },
  "country-outside": { writes: 1, verify: 1 },
  "unknown-field": { writes: 1, verify: 1 },
  "session-write": { writes: 1 },
  "upload-txt": { uploads: 1 },
  "upload-heic": { uploads: 1 },
  "upload-empty": { uploads: 1 },
  "upload-5mb": { uploads: 1, bytes: 5 * 1024 * 1024 },
  "upload-bad-token": { uploads: 1 },
};

function docsBytes(runId: string, n: number, kinds: string[], rounds = 1): number {
  let total = 0;
  for (let round = 1; round <= rounds; round++) {
    for (const kind of kinds) total += docTargetSize({ runId, n, kind, round, reject: false });
  }
  return total;
}

const KYC_KINDS = ["passport", "proof_of_address", "selfie"];
const KYB_KINDS = ["incorporation", "board_resolution", "passport", "proof_of_address"];

/** Estimated requests of one user over the whole run. */
export function userCost(p: UserPlan, runId: string): Cost {
  let c = add(ZERO, { writes: 3, reads: 1, rpc: 2 }); // setup + funding balance reads
  const poll = (readsPerPoll: number) => ({ reads: POLLS_PER_WAIT * readsPerPoll });
  const kyc = () => {
    const kinds = p.variant === "kyc-stop-after-one" ? KYC_KINDS.slice(0, 1) : KYC_KINDS;
    c = add(c, { writes: 1, verify: 1, reads: 1, uploads: kinds.length, bytes: docsBytes(runId, p.n, kinds) });
    if (p.variant === "kyc-invalid-first") c = add(c, { writes: 1, verify: 1 });
    if (p.variant !== "kyc-stop-after-one") c = add(c, poll(2)); // clients.me + requirements
    if (p.review === "more_info") c = add(c, { reads: 3, uploads: 1, bytes: docsBytes(runId, p.n, ["passport"], 1) });
  };
  const buy = () => (c = add(c, { reads: 3, writes: 1.5, tx: 1.2 }));
  const application = () => {
    c = add(c, { writes: 1, reads: 1 + POLLS_PER_WAIT });
    if (p.variant === "company-needs-changes") c = add(c, { writes: 1, reads: 3 });
    if (p.variant === "company-over-cap") c = add(c, { writes: 1 });
  };
  switch (p.cohort) {
    case "K":
      kyc();
      break;
    case "I":
      if (p.variant === "buyer-kyc") {
        kyc();
        c = add(c, { rpc: POLLS_PER_WAIT, reads: POLLS_PER_WAIT }); // passport: batched KycEntry read + /api/passport/status
      }
      buy();
      break;
    case "T":
      buy();
      if (p.variant === "maker") c = add(c, { tx: 2, reads: 2, rpc: 2 });
      if (p.variant === "taker") c = add(c, { tx: 1, reads: 1, rpc: 1 });
      if (p.pair === 1 && p.variant === "maker") c = add(c, { tx: 3, reads: 3, rpc: 3 });
      if (p.pair === 2) c = add(c, p.variant === "maker" ? { tx: 2, reads: 2, rpc: 2 } : { tx: 1, reads: 1, rpc: 4 });
      if (p.pair === 3 || p.pair === 4) {
        const requester = (p.pair === 3) === (p.variant === "maker");
        c = add(c, { reads: POLLS_PER_WAIT + 1 + (requester ? 1 : 0), writes: requester ? 1 : 0, tx: 1, rpc: 4 });
      }
      break;
    case "B":
      if (p.variant === "founder") kyc();
      else c = add(c, { writes: 2, verify: 1, reads: 3 + POLLS_PER_WAIT * 3, uploads: 4, tx: 1, bytes: docsBytes(runId, p.n, KYB_KINDS) });
      if (p.review !== "reject" && p.review !== "leave") application();
      break;
    case "E": {
      const cases = EDGE_GROUPS[p.edgeGroup ?? 1] ?? [];
      if (cases.some((x) => x.startsWith("upload-"))) c = add(c, { writes: 1, verify: 1 });
      for (const x of cases) c = add(c, EDGE_COST[x] ?? { writes: 1 });
      break;
    }
  }
  return c;
}

export type PlanSummary = {
  runId: string;
  roster: UserPlan[];
  cohorts: Record<string, number>;
  waves: { wave: number; users: number; cost: Cost }[];
  reviews: Record<string, number>;
  total: Cost;
  solLamports: bigint;
  tokenOwners: number;
  documents: number;
};

export function planSummary(runId: string, roster = buildRoster()): PlanSummary {
  const cohorts: Record<string, number> = {};
  const reviews: Record<string, number> = {};
  const waves = new Map<number, { wave: number; users: number; cost: Cost }>();
  let total = add(ZERO, { rpc: 20, tx: 4, writes: 2, reads: 1 }); // market setup: 2 approvals, 2 sales, 2 listings, terms
  let sol = BigInt(0);
  let tokenOwners = 0;
  let documents = 0;
  for (const p of roster) {
    cohorts[p.cohort] = (cohorts[p.cohort] ?? 0) + 1;
    if (hasDossier(p)) reviews[p.review] = (reviews[p.review] ?? 0) + 1;
    const cost = userCost(p, runId);
    total = add(total, { ...cost, rpc: cost.rpc - cost.tx * RPC_PER_TX });
    const w = waves.get(p.wave) ?? { wave: p.wave, users: 0, cost: ZERO };
    w.users += 1;
    w.cost = add(w.cost, { ...cost, rpc: cost.rpc - cost.tx * RPC_PER_TX });
    waves.set(p.wave, w);
    if (p.cohort === "I" || p.cohort === "T") {
      sol += SOL_BUYER;
      tokenOwners += 1;
    }
    if (p.cohort === "B" && p.variant.startsWith("company")) sol += SOL_ISSUER;
    if (hasDossier(p)) documents += p.variant.startsWith("company") ? 4 : p.variant === "kyc-stop-after-one" ? 1 : 3;
  }
  // Funding transactions: SOL (16 per tx) and payment tokens (4 per tx), per wave.
  const fundTx = [...waves.values()].reduce((s, w) => {
    const members = roster.filter((p) => p.wave === w.wave);
    const solUsers = members.filter((p) => p.cohort === "I" || p.cohort === "T" || (p.cohort === "B" && p.variant.startsWith("company"))).length;
    const tokenUsers = members.filter((p) => p.cohort === "I" || p.cohort === "T").length;
    return s + Math.ceil(solUsers / 16) + Math.ceil(tokenUsers / 4);
  }, 0);
  total = add(total, { tx: fundTx });
  return {
    runId,
    roster,
    cohorts,
    waves: [...waves.values()].sort((a, b) => a.wave - b.wave),
    reviews,
    total,
    solLamports: sol,
    tokenOwners,
    documents,
  };
}

function hm(seconds: number): string {
  const m = Math.ceil(seconds / 60);
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

export function renderPlan(s: PlanSummary): string {
  const t = s.total;
  const r = (n: number) => Math.round(n);
  const writeFloor = t.writes * (DEFAULT_RULES.minIntervalMs.write ?? 8_000) / 1_000;
  const readFloor = (t.reads / PACE.readsPerMin) * 60;
  const uploadFloor = (t.uploads / PACE.uploadsPerMin) * 60;
  const verifyFloor = (t.verify / PACE.verificationPerMin) * 60;
  const txFloor = (t.tx / PACE.txPerMin) * 60;
  const rpcFloor = t.rpc / PACE.chainRps;
  const pilotUsers = s.roster.filter((p) => p.wave === 0).map((p) => `${p.label} ${p.cohort}/${p.variant}`);
  const lines = [
    `SIM plan — devnet ${SITE_ORIGIN} (plan sends nothing)`,
    `run id: ${s.runId} (preview; the pilot creates the run, resume with SIM_RUN_ID)`,
    `users ${s.roster.length}: K ${s.cohorts.K} · I ${s.cohorts.I} (${s.roster.filter((p) => p.variant === "buyer-kyc").length} KYC + ${s.roster.filter((p) => p.variant === "buyer-nokyc").length} no-KYC) · T ${s.cohorts.T} (6 pairs) · B ${s.cohorts.B} (${s.roster.filter((p) => p.variant.startsWith("company")).length} KYB + ${s.roster.filter((p) => p.variant === "founder").length} founders) · E ${s.cohorts.E}`,
    `waves: ${s.waves.map((w) => `${w.wave === 0 ? "pilot" : `w${w.wave}`} ${w.users}`).join(" · ")}`,
    `pilot: ${pilotUsers.join(", ")}`,
    `owner reviews ${Object.values(s.reviews).reduce((a, b) => a + b, 0)} dossiers: approve ${s.reviews.approve ?? 0} · reject ${s.reviews.reject ?? 0} · more_info ${s.reviews.more_info ?? 0} · leave ${s.reviews.leave ?? 0} (edge dossiers: leave)`,
    `owner workload: ~${s.documents} document decisions, ${s.roster.filter((p) => p.variant === "buyer-kyc").length} passports, ${s.roster.filter((p) => p.variant.startsWith("company")).length} KYB verdicts, ~${s.roster.filter((p) => p.cohort === "B").length} applications, 2 OTC escrows`,
    `budget (estimate incl. owner-wait polls): signed writes ${r(t.writes)} · reads ${r(t.reads)} · uploads ${r(t.uploads)} (${(t.bytes / 1024 / 1024).toFixed(1)} MB) · verification.submit ${r(t.verify)} · transactions ${r(t.tx)} · RPC ≈ ${r(t.rpc)}`,
    `pacing floor: writes ${hm(writeFloor)} (1/8 s) · reads ${hm(readFloor)} (15/min) · uploads ${hm(uploadFloor)} (10/min) · verification ${hm(verifyFloor)} (5/min) · tx ${hm(txFloor)} (3/min, one in flight) · RPC ${hm(rpcFloor)} (CHAIN_RPS=1); ≤ ${PACE.httpConcurrency} HTTP in flight`,
    `funding: ${(Number(s.solLamports) / 1e9).toFixed(2)} SOL from the deployer 3E8ZZ… · ${s.tokenOwners} × ${Number(BUYER_PAYMENT / PAYMENT_UNIT)}.000000 e2e payment tokens from the CLI Admin CekAgg…`,
    "",
    "wave  users  writes  reads  uploads  verify  tx",
    ...s.waves.map(
      (w) =>
        `${(w.wave === 0 ? "pilot" : `w${w.wave}`).padEnd(6)}${String(w.users).padStart(5)}${String(r(w.cost.writes)).padStart(8)}${String(r(w.cost.reads)).padStart(7)}${String(r(w.cost.uploads)).padStart(9)}${String(r(w.cost.verify)).padStart(8)}${String(r(w.cost.tx)).padStart(4)}`,
    ),
    "",
    "pilot (from front/):",
    "  SIM_CMD=pilot SIM_SEND=1 CHAIN_NETWORK=devnet CHAIN_RPC_URL=<devnet RPC> CHAIN_RPS=1 npm run sim",
    "then review in the admin UI, `SIM_CMD=watch …` until the pilot users finish, `SIM_CMD=report npm run sim` (0 unexpected), then SIM_CMD=wave SIM_WAVE=1…5.",
  ];
  return lines.join("\n");
}
