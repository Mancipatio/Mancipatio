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
