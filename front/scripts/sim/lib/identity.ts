/**
 * The 100 simulated users (design-sim §1–§3) and the 4 transfer users after
 * them (design-transfers §D.1): the roster (cohort, variant, wave, the review
 * the owner is asked to give), seeded synthetic identity data, and the
 * per-user keypairs.
 *
 * Everything is a pure function of the run id, so a resumed run regenerates
 * the same names, documents and choices. Names start with `SIM-`, e-mails are
 * `simNNN@example.com` (reserved domain; the site suppresses mail to it), and
 * every country is in the platform's default approved set.
 */
import { createHash } from "node:crypto";
import type { KeyPairSigner } from "@solana/kit";
import { DEFAULT_APPROVED_JURISDICTIONS } from "@/lib/passport";
import { loadOrCreateRoleKey } from "@/scripts/chain/lib/e2e/keys";

export type Cohort = "K" | "I" | "T" | "B" | "E" | "X";
export type Variant =
  | "kyc"
  | "kyc-reject-doc"
  | "kyc-stop-after-one"
  | "kyc-invalid-first"
  | "buyer-kyc"
  | "buyer-nokyc"
  | "maker"
  | "taker"
  | "company"
  | "company-needs-changes"
  | "company-over-cap"
  | "founder"
  | "edge"
  | "xfer-hub"
  | "xfer-peer"
  | "xfer-buyer";

/** What owner-queue.txt asks the owner to decide for this user's dossier. */
export type Review = "approve" | "reject" | "more_info" | "leave" | "none";

export type UserPlan = {
  n: number;
  /** `u017`: key file, journal and state key. */
  label: string;
  cohort: Cohort;
  variant: Variant;
  /** 0 = pilot, 1–5 = waves, 6 = the transfer pairs (cohort X). */
  wave: number;
  review: Review;
  /** Trader pair 1–6 (maker i sells to taker i). */
  pair?: number;
  /** Edge-case group 1–8. */
  edgeGroup?: number;
  /** Transfer pair 1–2: the hub (xfer-hub / xfer-buyer) sends to its peer. */
  xpair?: 1 | 2;
};

export const COHORT_SIZES = { K: 30, I: 35, T: 12, B: 15, E: 8, X: 4 } as const;
export const PILOT_SIZE = 5;
/** The wave of cohort X: after the other five, so no earlier plan moves. */
export const XFER_WAVE = 6;

export function userLabel(n: number): string {
  return `u${String(n).padStart(3, "0")}`;
}

export function nnn(n: number): string {
  return String(n).padStart(3, "0");
}

type Slot = Omit<UserPlan, "n" | "label" | "wave" | "review">;

function repeat(count: number, slot: Slot): Slot[] {
  return Array.from({ length: count }, () => ({ ...slot }));
}

/**
 * The fixed roster. Pilot (wave 0): one KYC user, one KYC buyer, one no-KYC
 * buyer, one KYB company and one edge user. The other 95 are dealt into
 * waves 1–5 round-robin (cohorts mixed); a trader pair always shares a wave.
 * Cohort X is appended after them (u101–u104, wave 6), so the first 100
 * plans, their labels, keys and reviews never change.
 */
export function buildRoster(): UserPlan[] {
  const pilot: Slot[] = [
    { cohort: "K", variant: "kyc" },
    { cohort: "I", variant: "buyer-kyc" },
    { cohort: "I", variant: "buyer-nokyc" },
    { cohort: "B", variant: "company" },
    { cohort: "E", variant: "edge", edgeGroup: 1 },
  ];
  const rest: Slot[] = [
    ...repeat(3, { cohort: "K", variant: "kyc-reject-doc" }),
    ...repeat(2, { cohort: "K", variant: "kyc-stop-after-one" }),
    ...repeat(1, { cohort: "K", variant: "kyc-invalid-first" }),
    ...repeat(23, { cohort: "K", variant: "kyc" }),
    ...repeat(19, { cohort: "I", variant: "buyer-kyc" }),
    ...repeat(14, { cohort: "I", variant: "buyer-nokyc" }),
    ...repeat(2, { cohort: "B", variant: "company-needs-changes" }),
    ...repeat(1, { cohort: "B", variant: "company-over-cap" }),
    ...repeat(6, { cohort: "B", variant: "company" }),
    ...repeat(5, { cohort: "B", variant: "founder" }),
    ...Array.from({ length: 7 }, (_, i) => ({ cohort: "E" as const, variant: "edge" as const, edgeGroup: i + 2 })),
  ];
  const waves: Slot[][] = [[], [], [], [], []];
  rest.forEach((slot, i) => waves[i % 5].push(slot));
  for (let pair = 1; pair <= 6; pair++) {
    const w = waves[(pair - 1) % 5];
    w.push({ cohort: "T", variant: "maker", pair }, { cohort: "T", variant: "taker", pair });
  }
  const plans: UserPlan[] = [];
  const push = (slot: Slot, wave: number) => {
    const n = plans.length + 1;
    plans.push({ ...slot, n, label: userLabel(n), wave, review: "none" });
  };
  pilot.forEach((slot) => push(slot, 0));
  waves.forEach((list, i) => {
    // Rotate cohorts inside a wave so every cohort advances from the start.
    const order: Cohort[] = ["K", "I", "B", "T", "E"];
    const sorted = [...list].sort((a, b) => order.indexOf(a.cohort) - order.indexOf(b.cohort));
    const byCohort = order.map((c) => sorted.filter((s) => s.cohort === c));
    for (let k = 0; byCohort.some((l) => l.length > k); k++) {
      for (const l of byCohort) if (l[k]) push(l[k], i + 1);
    }
  });
  assignReviews(plans);
  // Two transfer pairs: u101 hub → u102 peer, u103 buyer-hub → u104 peer (no dossier).
  for (const xpair of [1, 2] as const) {
    push({ cohort: "X", variant: xpair === 1 ? "xfer-hub" : "xfer-buyer", xpair }, XFER_WAVE);
    push({ cohort: "X", variant: "xfer-peer", xpair }, XFER_WAVE);
  }
  return plans;
}

/** Whether this user opens a KYC or KYB dossier the owner reviews. */
export function hasDossier(plan: Pick<UserPlan, "cohort" | "variant">): boolean {
  return plan.cohort === "K" || plan.variant === "buyer-kyc" || plan.cohort === "B";
}

/**
 * The owner's 70/10/10/10 split (approve / reject / more_info / leave) over
 * the 65 reviewed dossiers. Fixed choices first: "PLEASE REJECT" uploads are
 * rejects, users who stop after one document are left; the pilot is approved.
 */
function assignReviews(plans: UserPlan[]): void {
  const dossiers = plans.filter(hasDossier);
  for (const p of dossiers) p.review = "approve";
  const pick = (filter: (p: UserPlan) => boolean, count: number, review: Review) => {
    if (count <= 0) return;
    const candidates = dossiers.filter((p) => p.wave > 0 && p.review === "approve" && filter(p));
    for (const p of candidates.slice(0, count)) p.review = review;
  };
  pick((p) => p.variant === "kyc-reject-doc", 3, "reject");
  pick((p) => p.variant === "kyc-stop-after-one", 2, "leave");
  const target = (share: number) => Math.round(dossiers.length * share);
  const fill = (review: Review, total: number, sources: [(p: UserPlan) => boolean, number][]) => {
    for (const [filter, count] of sources) {
      const have = dossiers.filter((p) => p.review === review).length;
      pick(filter, Math.min(count, total - have), review);
    }
  };
  const plainKyc = (p: UserPlan) => p.variant === "kyc";
  fill("reject", target(0.1), [[plainKyc, 2], [(p) => p.variant === "buyer-kyc", 1], [(p) => p.variant === "company", 1]]);
  fill("more_info", target(0.1), [
    [plainKyc, 3],
    [(p) => p.variant === "buyer-kyc", 2],
    [(p) => p.variant === "company", 1],
    [(p) => p.variant === "founder", 1],
  ]);
  fill("leave", target(0.1), [[plainKyc, 3], [(p) => p.variant === "buyer-kyc", 1]]);
}

// ── Seeded data ─────────────────────────────────────────────────────────────

/** mulberry32 over a SHA-256 seed: deterministic per (runId, user, purpose). */
export function prng(...parts: (string | number)[]): () => number {
  let a = createHash("sha256").update(parts.join(":")).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pickFrom<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)];
}

const FIRST = ["Marko", "Jelena", "Nikola", "Ana", "Stefan", "Milica", "Luka", "Ivana", "Petar", "Maja", "Jovan", "Sara", "Filip", "Tamara", "Nemanja", "Katarina"];
const LAST = ["Petrović", "Jovanović", "Nikolić", "Marković", "Đorđević", "Stojanović", "Ilić", "Stanković", "Pavlović", "Popović", "Kostić", "Lukić"];
/** Residences the simulator uses, each with a city; all in the default approved set. */
const PLACES: readonly [number, string, string][] = [
  [688, "Beograd", "11000"],
  [688, "Novi Sad", "21000"],
  [276, "Berlin", "10115"],
  [250, "Paris", "75001"],
  [380, "Milano", "20121"],
  [724, "Madrid", "28001"],
  [40, "Wien", "1010"],
  [528, "Amsterdam", "1011"],
  [191, "Zagreb", "10000"],
  [705, "Ljubljana", "1000"],
];

export type Person = {
  n: number;
  displayName: string;
  legalName: string;
  dateOfBirth: string;
  nationality: number;
  residence: number;
  addressLine: string;
  city: string;
  postalCode: string;
  phone: string;
  email: string;
  company: {
    name: string;
    regNumber: string;
    country: number;
    address: string;
    website: string;
    role: string;
  };
};

export function person(runId: string, n: number): Person {
  const rand = prng("sim-person", runId, n);
  const name = `${pickFrom(rand, FIRST)} ${pickFrom(rand, LAST)}`;
  const [residence, city, postalCode] = pickFrom(rand, PLACES);
  const nationality = pickFrom(rand, [residence, residence, 688, 276, 380]);
  const year = 1960 + Math.floor(rand() * 45); // 1960–2004
  const month = 1 + Math.floor(rand() * 12);
  const day = 1 + Math.floor(rand() * 28);
  const id = nnn(n);
  return {
    n,
    displayName: `SIM-${id} ${name}`,
    legalName: `SIM-${id} ${name}`,
    dateOfBirth: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    nationality,
    residence,
    addressLine: `Test ulica ${n}`,
    city,
    postalCode,
    phone: `+381 60 000 ${String(n).padStart(4, "0")}`,
    email: `sim${id}@example.com`,
    company: {
      name: `SIM Test d.o.o. ${id}`,
      regNumber: `SIM-TEST-${id}`,
      country: residence,
      address: `Test ulica ${n}, ${city}`,
      website: `https://example.com/sim-${id}`,
      role: "Director",
    },
  };
}

/** Params of `verification.submit` for an individual (kind "kyc"). */
export function kycParams(p: Person): Record<string, unknown> {
  return {
    kind: "kyc",
    legal_name: p.legalName,
    date_of_birth: p.dateOfBirth,
    nationality: p.nationality,
    residence_country: p.residence,
    address_line: p.addressLine,
    city: p.city,
    postal_code: p.postalCode,
    phone: p.phone,
    email: p.email,
  };
}

/** Params of `verification.submit` for a company (kind "kyb"). */
export function kybParams(p: Person): Record<string, unknown> {
  return {
    kind: "kyb",
    legal_name: p.legalName,
    residence_country: p.residence,
    address_line: p.addressLine,
    city: p.city,
    postal_code: p.postalCode,
    phone: p.phone,
    email: p.email,
    company_name: p.company.name,
    company_reg_number: p.company.regNumber,
    company_country: p.company.country,
    company_address: p.company.address,
    company_website: p.company.website,
    representative_role: p.company.role,
  };
}

/** A launch application (`applications.submit` `application`), narrowApplication-valid. */
export function applicationContent(runId: string, p: Person, raiseAmount?: number): Record<string, unknown> {
  const rand = prng("sim-application", runId, p.n);
  return {
    raise_type: "mature",
    company_name: p.company.name,
    one_liner: `SIM-${nnn(p.n)} devnet simulation raise — not a real offering`,
    website: p.company.website,
    category: pickFrom(rand, ["Technology", "Real estate", "Energy", "Food"]),
    stage: "Seed",
    valuation: String(1_000_000 + Math.floor(rand() * 9) * 250_000),
    problem_or_why: "Simulated application created by the Manci devnet simulator (docs/mainnet-readiness/sim). Not a real company.",
    raise_amount: raiseAmount ?? 100_000 + Math.floor(rand() * 8) * 50_000,
    equity_offered: 5 + Math.floor(rand() * 16),
    raise_structure: "Equity",
    cliff_months: 0,
    vesting_months: 0,
    founder_name: p.legalName,
    founder_email: p.email,
    founder_why: "Simulator founder statement for review-path testing.",
  };
}

/** The 32-byte legal id of a simulated issuer: `MANCI-SIM-<run>-<nnn>` (20 bytes). */
export function simLegalId(runId: string, n: number): string {
  return `MANCI-SIM-${runId}-${nnn(n)}`;
}

/** The user's keypair: `<run>/keys/<label>.json` (64 bytes, dir 700, file 600, written with `wx`). */
export async function userSigner(runDir: string, label: string): Promise<KeyPairSigner> {
  return loadOrCreateRoleKey(runDir, label);
}

/** Every jurisdiction used is in the default approved set (asserted by the tests). */
export const SIM_JURISDICTIONS = [...new Set(PLACES.map(([code]) => code).concat([688, 276, 380]))].filter((c) =>
  DEFAULT_APPROVED_JURISDICTIONS.includes(c),
);
