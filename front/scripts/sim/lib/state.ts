/**
 * `<run>/state.json` (mode 600, atomic rewrite after every step): where every
 * user stands, the transactions it signed (a signature is recorded BEFORE it
 * is sent), and the market and funding progress. A resumed run reads it and
 * continues each user from its last completed step.
 */
import fs from "node:fs";
import path from "node:path";
import type { UserPlan } from "./identity";
import { SimGateError, writePrivateFile } from "./safety";

export type TxRecord = {
  status: "inflight" | "landed" | "failed";
  sig: string | null;
  /** Last valid block height of the signed blockhash (decimal string). */
  lvbh?: string;
  at: string;
  err?: string;
};

/** A transaction owner: a user, the market setup or the funding step. */
export type TxOwner = { label: string; tx: Record<string, TxRecord> };

export type Requirement = {
  id: number;
  kind: string;
  status: string;
  /** Upload round of our last file for it (0 = never uploaded). */
  uploadedRound: number;
};

export type OfferRecord = { offerId: string; pda: string; amount: string; price: string; expiresAt: string };

/**
 * A cohort-X transfer row's pre-send snapshot (design-transfers §D.5), taken
 * at finalized and persisted BEFORE the send; never re-taken once a signature
 * for the row exists. Amounts are decimal strings.
 */
export type XferSnapshot = {
  srcOwner: string;
  srcAta: string;
  dstOwner: string;
  dstAta: string;
  amount: string;
  srcBefore: string;
  dstBefore: string;
  /** The destination token account did not exist (C1b checks the new ATA). */
  newDst?: boolean;
  /** Epoch ms of the first C1 read, and how many reads the lag window took. */
  checkAt?: number;
  reads?: number;
  /** C1 settled (ok, lag or a finding): never journalled twice. */
  checked?: boolean;
};

/** A cohort-X pair's conservation baseline (C3), taken when its units arrive. */
export type XferBase = {
  /** ISO time the baseline was read (tx records carry ISO times too). */
  at: string;
  /** Balances counted: donor (loan route only), hub, peer. */
  parts: Record<string, string>;
  sum: string;
  supply: string;
  circulating: string;
  /** commitment-aggregate of both simulator sales (C5; loan route only). */
  aggregates?: Record<string, { pledged: string; settled: string; backers: number }>;
};

/** A probe's verdict (the journal holds the detail). */
export type ProbeVerdict = "passed" | "mismatch" | "unexpected-accept" | "skipped";

// ── The owner actor (SIM_OWNER=1, design-owner-actor.md) ────────────────────

/**
 * Where one owner-actor task stands:
 * - open: the actor works it (when it holds the focus);
 * - await-user: the client owes a file or a resubmission; the user's own
 *   polls run until its state shows it sent one (never approved on a timer);
 * - decided: the actor made the planned decision;
 * - elsewhere: someone decided by hand (detected by the re-read before a write);
 * - handed-back: the actor gave up; owner-queue.txt asks the owner to decide.
 */
export type OwnerPhase = "open" | "await-user" | "decided" | "elsewhere" | "handed-back";

/** The owner actor's four kinds of task (one current task per user at a time). */
export type OwnerTaskKind = "dossier" | "app" | "otc" | "passport";

/** A non-idempotent write, saved before it is sent (a resume tells its own decision from a hand one). */
export type OwnerIntent = { op: string; value?: string; reqId?: number; docId?: number | null; kind?: string; at: string };

export type OwnerDossier = {
  verdict: "approve" | "reject" | "more_info";
  /** more_info: reject one document (the passport) or request one more (deterministic, see owner.ts). */
  pick?: "reject-doc" | "request-doc";
  phase: OwnerPhase;
  /** more_info: the round's document (the rejected requirement, or the requested kind and its row). */
  target?: { reqId?: number; docId?: number | null; kind?: string; byHand?: boolean };
  /** more_info: the replacement (or the requested file) arrived and was approved. */
  roundDone?: boolean;
  /** The final verdict (clients.status / kybDecision) is on the dossier. */
  finalDone?: boolean;
  /** The verdict this actor put on the dossier (verified | rejected). */
  finalValue?: string;
  /** reject + SIM_OWNER_PASSPORT_REJECT: the wallet's open passport request is rejected. */
  passportDone?: boolean;
  /** The passport request the actor is rejecting (saved before the write). */
  passportIntent?: string;
  intent?: OwnerIntent;
  /** await-user: the user's uploads when the actor started waiting (uploadSignature). */
  awaitSig?: string;
  decision?: string;
  decidedAt?: string;
  /** The user's stage when the decision landed (the C-O6 lag check). */
  decidedStage?: string;
  lagChecked?: boolean;
};

export type OwnerApp = {
  phase: OwnerPhase;
  /** Persisted sub-step; reads before a write are always redone after a restart. */
  step?: "list" | "listAll" | "events" | "review" | "audit" | "refresh" | "refreshEvents" | "badges";
  rounds: { decision: string; at: string }[];
  intent?: { decision: string; at: string };
  /** await-user: u.data.resubmits when the actor asked for changes. */
  awaitResubmits?: number;
  decision?: string;
  decidedAt?: string;
  decidedStage?: string;
  lagChecked?: boolean;
};

export type OwnerOtc = {
  requestId: string;
  phase: OwnerPhase;
  step?: "list" | "listAll" | "mint" | "screen" | "eligibility" | "deals" | "reread" | "tx" | "check" | "reflip" | "reflipAll" | "flip" | "audit" | "refresh" | "badges";
  /** Saved before signing (ms since epoch as a decimal string, as the admin page's newDealId). */
  dealId?: string;
  expiresAt?: string;
  dealPda?: string;
  payProgram?: string;
  sig?: string | null;
  intent?: OwnerIntent;
  flippedAt?: string;
};

export type OwnerPassport = { requestId?: string; phase: "open" | "in-review" | "none" | "elsewhere" | "handed-back" };

/** Per-user record of the owner actor (additive: the schema stays manci-sim-state-v1). */
export type OwnerRecord = {
  dossier?: OwnerDossier;
  app?: OwnerApp;
  otc?: OwnerOtc;
  passport?: OwnerPassport;
  /** What CekAgg cannot sign (the super admin / the KYC provider): owner-queue.txt lists these. */
  manual?: { kind: "passport" | "verify_issuer_kyb"; line: string; at: string }[];
  /**
   * The last task handed back (its own phase says "handed-back"; the user's
   * other tasks go on). `kind` is absent in a record written before it existed.
   */
  handedBack?: { task: string; reason: string; at: string; attempts: number; kind?: OwnerTaskKind };
  /** The decisions, in order (report.md). */
  log?: string[];
  /** C-O6 on an escrow: this party saw the flip (or the lag was reported). */
  otcLagChecked?: boolean;
  /** Transient failures of the task `attemptsFor` (another task starts again from 0). */
  attempts: number;
  attemptsFor?: OwnerTaskKind;
  /** Epoch ms before which the task is not taken again (a transient failure's backoff). */
  retryAt?: number;
};

/** The stages in which a user still waits for the task that was handed back (dossier, application, passport). */
const HANDED_BACK_STAGES: Record<Exclude<OwnerTaskKind, "otc">, (stage: string) => boolean> = {
  dossier: (stage) => stage === "await.dossier" || stage.startsWith("dossier."),
  app: (stage) => stage === "await.app" || stage.startsWith("app."),
  passport: (stage) => stage === "await.passport",
};

/**
 * The hand-back owner-queue.txt still shows: the user waits at that task
 * (once the owner decided it by hand the user moves on and the line goes).
 * An escrow hand-back stays while the user runs: it can name an open deal to
 * cancel.
 */
export function liveHandBack(u: UserState): OwnerRecord["handedBack"] | undefined {
  const h = u.data.owner?.handedBack;
  if (!h || u.terminal) return undefined;
  return !h.kind || h.kind === "otc" || HANDED_BACK_STAGES[h.kind](u.stage) ? h : undefined;
}

export type UserData = {
  accountId?: string;
  clientId?: string;
  /** Onboarding magic-link token (a credential: state.json is 600 in a git-ignored dir). */
  token?: string;
  requirements?: Requirement[];
  round?: number;
  kycStatus?: string;
  sale?: string;
  terms?: Record<string, string>;
  buyUnits?: number;
  buySig?: string;
  recordAttempts?: number;
  offers?: Record<string, OfferRecord>;
  dealRequestId?: string;
  dealPda?: string;
  issuerPda?: string;
  applicationId?: string;
  applicationStatus?: string;
  /** Resubmissions this user sent (app.resubmit): the owner actor's cue that a needs_changes round came back. */
  resubmits?: number;
  /** Flags of one-time variant steps (invalid-first, over-cap, …). */
  flags?: Record<string, boolean>;
  edgeDone?: string[];
  pollCount?: number;
  /** Cohort X: snapshots per transfer row (S1, S2, S4–S7). */
  xfer?: Record<string, XferSnapshot>;
  /** Cohort X hub: where its units came from (a donor loan or its own buy). */
  xferSource?: "donor" | "own";
  xferBase?: XferBase;
  probes?: Record<string, ProbeVerdict>;
  /** The owner actor's record for this user (SIM_OWNER=1). */
  owner?: OwnerRecord;
};

export type Terminal = "done" | "stopped" | "rejected" | "failed";

export type UserState = TxOwner & {
  plan: UserPlan;
  wallet: string;
  stage: string;
  /** True while the user waits for the owner (the stage table shows awaiting_owner). */
  awaitingOwner: boolean;
  /** What the owner is expected to do (owner-queue.txt). */
  ownerTask?: string;
  terminal?: Terminal;
  reason?: string;
  /** Epoch ms before which the user is not advanced (backoff, poll interval). */
  notBefore: number;
  attempts: number;
  data: UserData;
};

export type MarketState = TxOwner & {
  saleIds: number[];
  /** Sale PDAs: [0] for KYC'd investors, [1] for no-KYC buyers and traders. */
  sales: string[];
  listed: Record<string, boolean>;
  termsOk: boolean;
  /** The e2e payment mint's FX row on /admin/limits: eur_peg | rate | missing | unknown. */
  fxKind?: string;
  approvalExpiresAt?: string;
  saleStart?: string;
  /**
   * The one outstanding cohort-X loan of e2e buyer3's class A units: set
   * before the seed leg, cleared after the return leg and its checks.
   */
  loan?: { pair: number; hub: string; donor: string; units: string; donorBefore: string; at: string };
};

export type SimState = {
  schema: "manci-sim-state-v1";
  runId: string;
  createdUtc: string;
  network: "devnet";
  genesis: string;
  started: number[];
  market: MarketState;
  funding: TxOwner & { sol: Record<string, boolean>; tokens: Record<string, boolean>; batches: number };
  users: Record<string, UserState>;
  stops: { at: string; reason: string }[];
  /** The owner actor across restarts (SIM_OWNER=1); absent until it first runs. */
  owner?: OwnerRunState;
};

export type OwnerRunState = {
  /** Final decisions the owner actor made in this run (SIM_OWNER_MAX counts these). */
  decisions: number;
  /** The passport registry the investors' KycEntry poll read when the owner actor first ran. */
  kycRegistry?: string | null;
  firstUtc?: string;
};

export function statePath(runDir: string): string {
  return path.join(runDir, "state.json");
}

export function newState(runId: string, genesis: string): SimState {
  return {
    schema: "manci-sim-state-v1",
    runId,
    createdUtc: new Date().toISOString(),
    network: "devnet",
    genesis,
    started: [],
    market: { label: "market", tx: {}, saleIds: [], sales: [], listed: {}, termsOk: false },
    funding: { label: "funding", tx: {}, sol: {}, tokens: {}, batches: 0 },
    users: {},
    stops: [],
  };
}

export function loadState(runDir: string): SimState | null {
  const file = statePath(runDir);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SimState;
  if (parsed.schema !== "manci-sim-state-v1" || parsed.network !== "devnet") {
    throw new SimGateError("state.json is not a devnet simulator state");
  }
  return parsed;
}

export function saveState(runDir: string, state: SimState): void {
  writePrivateFile(statePath(runDir), `${JSON.stringify(state, null, 2)}\n`);
}

export function newUserState(plan: UserPlan, wallet: string): UserState {
  return { label: plan.label, tx: {}, plan, wallet, stage: "session", awaitingOwner: false, notBefore: 0, attempts: 0, data: {} };
}

/** Every signature any owner still has in flight (resume resolves these first). */
export function inflightRecords(state: SimState): { owner: TxOwner; label: string; record: TxRecord }[] {
  const owners: TxOwner[] = [state.market, state.funding, ...Object.values(state.users)];
  return owners.flatMap((owner) =>
    Object.entries(owner.tx)
      .filter(([, record]) => record.status === "inflight" && record.sig)
      .map(([label, record]) => ({ owner, label, record })),
  );
}
