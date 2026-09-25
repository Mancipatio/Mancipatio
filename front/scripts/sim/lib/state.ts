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
