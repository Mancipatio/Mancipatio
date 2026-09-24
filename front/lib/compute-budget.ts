// Compute Budget program instructions, hand-encoded (Talas 3.1 K5, 4.2).
//
// Manci sets the priority fee itself; wallets do not. The verified client
// (lib/verified-solana-client) asks lib/priority-fee for the price and the
// SDK prepends one SetComputeUnitPrice; co-signed envelopes (issuer
// recovery, KYC registry creation) fix the price when the document is
// prepared. Every price is clamped to MAX_COMPUTE_UNIT_PRICE.
//
// Only the two instructions Manci sets itself, byte-for-byte what the
// Compute Budget program expects (and what the send path measures as its
// overhead):
//   SetComputeUnitLimit  [2, u32 LE units]
//   SetComputeUnitPrice  [3, u64 LE micro-lamports per compute unit]
// The co-signed envelopes, the vesting size placeholder and the 3.3 chain
// CLI all build these exact bytes from here.
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getTransactionMessageSize,
  pipe,
  setTransactionMessageFeePayer,
  type Address,
  type Instruction,
} from "@solana/kit";

export const COMPUTE_BUDGET_PROGRAM_ADDRESS =
  "ComputeBudget111111111111111111111111111111" as Address<"ComputeBudget111111111111111111111111111111">;

/** The runtime's per-transaction compute ceiling. */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
/**
 * The highest priority fee Manci ever sets, in micro-lamports per compute
 * unit: 2 lamports / CU, i.e. at most 0.0028 SOL at the 1.4M ceiling. No
 * environment variable can raise it; the chain CLI imports it as its cap.
 */
export const MAX_COMPUTE_UNIT_PRICE = BigInt(2_000_000);
const U64_MAX = BigInt("18446744073709551615");
const MICRO_LAMPORTS_PER_LAMPORT = BigInt(1_000_000);

const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;

/** `SetComputeUnitLimit(units)`; `units` is an integer in 0..1_400_000. */
export function setComputeUnitLimitInstruction(units: number): Instruction {
  if (!Number.isInteger(units) || units < 0 || units > MAX_COMPUTE_UNIT_LIMIT) {
    throw new Error(`Compute unit limit must be an integer between 0 and ${MAX_COMPUTE_UNIT_LIMIT}`);
  }
  const data = new Uint8Array(5);
  data[0] = SET_COMPUTE_UNIT_LIMIT;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data };
}

/** `SetComputeUnitPrice(microLamports)`; a u64 (micro-lamports per compute unit). */
export function setComputeUnitPriceInstruction(microLamports: bigint): Instruction {
  if (typeof microLamports !== "bigint" || microLamports < BigInt(0) || microLamports > U64_MAX) {
    throw new Error("Compute unit price must be a u64");
  }
  const data = new Uint8Array(9);
  data[0] = SET_COMPUTE_UNIT_PRICE;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data };
}

export type DecodedComputeBudget =
  | { kind: "limit"; units: number }
  | { kind: "price"; microLamports: bigint };

/** Decodes one of the two instructions above, or null for anything else. */
export function decodeComputeBudgetInstruction(ix: {
  programAddress: string;
  data?: ArrayLike<number>;
}): DecodedComputeBudget | null {
  if (ix.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS || !ix.data) return null;
  const data = Uint8Array.from(Array.from({ length: ix.data.length }, (_, i) => ix.data![i]));
  const view = new DataView(data.buffer);
  if (data[0] === SET_COMPUTE_UNIT_LIMIT && data.length === 5) {
    return { kind: "limit", units: view.getUint32(1, true) };
  }
  if (data[0] === SET_COMPUTE_UNIT_PRICE && data.length === 9) {
    return { kind: "price", microLamports: view.getBigUint64(1, true) };
  }
  return null;
}

/** The most a transaction can pay in priority fees: `limit × price`, in lamports (rounded down). */
export function maxPriorityFeeLamports(limit: number, price: bigint): bigint {
  return (BigInt(limit) * price) / MICRO_LAMPORTS_PER_LAMPORT;
}

/** Lamports as a SOL figure without trailing zeros ("0.0002", "0"). */
export function formatLamportsAsSol(lamports: bigint): string {
  const whole = lamports / BigInt(1_000_000_000);
  const fraction = (lamports % BigInt(1_000_000_000)).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Validates the compute budget a co-signed document carries: an integer
 * limit in 1..1_400_000 and a price given as a canonical decimal string in
 * 0..MAX_COMPUTE_UNIT_PRICE. Throws a plain message for the caller to wrap.
 */
export function parseEnvelopeComputeBudget(e: {
  computeUnitLimit?: unknown;
  computeUnitPriceMicroLamports?: unknown;
}): { computeUnitLimit: number; computeUnitPriceMicroLamports: string } {
  const limit = e.computeUnitLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_COMPUTE_UNIT_LIMIT) {
    throw new Error(`the compute unit limit must be 1..${MAX_COMPUTE_UNIT_LIMIT}`);
  }
  const price = e.computeUnitPriceMicroLamports;
  if (typeof price !== "string" || !/^(0|[1-9]\d{0,19})$/.test(price) || BigInt(price) > MAX_COMPUTE_UNIT_PRICE) {
    throw new Error(`the compute unit price must be a whole number of micro-lamports, 0..${MAX_COMPUTE_UNIT_PRICE}`);
  }
  return { computeUnitLimit: limit, computeUnitPriceMicroLamports: price };
}

// ── Transaction size ─────────────────────────────────────────────────────────

/** Solana's packet limit for one transaction. */
export const TRANSACTION_SIZE_LIMIT = 1232;

/**
 * What the send path adds to a transaction after the app built it: the
 * verified client sets SetComputeUnitPrice (lib/priority-fee) and a
 * SetComputeUnitLimit that `@solana/client` re-estimates by simulation, both
 * in front of the app's instructions (about 40 B with the Compute Budget
 * program key). Callers that pack instructions
 * measure every candidate with these placeholders included, so the prepared
 * transaction still fits.
 */
export const SEND_OVERHEAD_INSTRUCTIONS: readonly Instruction[] = [
  setComputeUnitLimitInstruction(0),
  setComputeUnitPriceInstruction(BigInt(0)),
];

/** Serialized size of one transaction carrying `instructions` (all signatures included). */
export function transactionSize(feePayer: Address, instructions: readonly Instruction[]): number {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getTransactionMessageSize(message);
}
