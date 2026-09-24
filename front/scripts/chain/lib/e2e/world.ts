/**
 * What every e2e group gets (design-6.3 §A "Roles"):
 *
 * - devnet: the CLI Admin key pays, is the Admin AND the issuer (minting needs
 *   an Admin or a Super-Admin grant, and the Super Admin is the user's
 *   wallet); the Super Admin and the BlocklistAuthority are not ours (null);
 * - localnet: every role is a separate local key; the deployer pays.
 */
import { createHash } from "node:crypto";
import type { Address, KeyPairSigner } from "@solana/kit";
import { isDefaultApprovedJurisdiction } from "@/lib/passport";
import type { ChainRpc } from "../rpc";
import type { Timing } from "../tx";
import { chainNow } from "./clock";
import type { E2eConfig } from "./config";
import type { E2eNetwork } from "./matrix";
import type { E2eRunner } from "./runner";

export type Roles = {
  /** Pays the fixtures: the devnet Admin, or the localnet deployer. */
  funder: KeyPairSigner;
  admin: KeyPairSigner;
  issuer: KeyPairSigner;
  superAdmin: KeyPairSigner | null;
  blocklistAuthority: KeyPairSigner | null;
  kycAuthority: KeyPairSigner | null;
  buyers: [KeyPairSigner, KeyPairSigner, KeyPairSigner, KeyPairSigner];
  /** Holds the payment mint's keypair (it signs only its createAccount). */
  paymentMint: KeyPairSigner;
};

export type World = {
  network: E2eNetwork;
  runId: string;
  runner: E2eRunner;
  rpc: ChainRpc;
  /** The same guards without the run's abort signal (drains an in-flight signature). */
  drainRpc: ChainRpc;
  roles: Roles;
  config: E2eConfig;
  log: (line: string) => void;
  sleep: Timing["sleep"];
  signal: AbortSignal;
};

export function sha256Bytes(text: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(text).digest());
}

/** The e2e issuer's 32-byte legal entity id: "MANCI-E2E-<run>" zero-padded. */
export function legalEntityId(runId: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(`MANCI-E2E-${runId}`).slice(0, 32));
  return out;
}

/** A jurisdiction every default KYC registry approves (passports, issuer). */
export function defaultJurisdiction(): number {
  for (const code of [688, 276, 250, 380, 724, 40, 528, 840]) {
    if (isDefaultApprovedJurisdiction(code)) return code;
  }
  throw new Error("No default-approved jurisdiction among the e2e candidates");
}

export async function accountExists(rpc: ChainRpc, address: Address): Promise<boolean> {
  const { value } = await rpc
    .getAccountInfo(address, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 0 } })
    .send();
  return value !== null;
}

export const ONE_DAY = BigInt(86_400);

/**
 * The deadline of an account a step creates only to watch it expire (2.5a,
 * 3.4a). Called from the step's build: a saved value is reused only while
 * that account may exist (the step passed or is inflight, or the chain
 * shows it); otherwise it is chain time + `seconds`, saved before the send.
 * A value saved by a run whose step never landed would already be past and
 * make every resume fail.
 */
export async function expiringDeadline(
  w: World,
  input: { key: string; step: string; seconds: bigint; exists: () => Promise<boolean> },
): Promise<bigint> {
  const saved = w.runner.state.entities[input.key];
  const status = w.runner.state.steps[input.step]?.status;
  if (saved !== undefined && (status === "passed" || status === "inflight" || (await input.exists()))) return BigInt(saved);
  const deadline = (await chainNow(w.rpc)) + input.seconds;
  w.runner.setEntity(input.key, deadline);
  return deadline;
}

/** Margin (s) so a clock guard never races the simulation that follows it. */
export const CLOCK_GUARD_S = BigInt(10);
