// Compute Budget program instructions, hand-encoded (Talas 3.1 K5).
//
// Only the two instructions Manci sets itself, byte-for-byte what the
// Compute Budget program expects (and what lib/issuer-authority measures as
// the send path's overhead):
//   SetComputeUnitLimit  [2, u32 LE units]
//   SetComputeUnitPrice  [3, u64 LE micro-lamports per compute unit]
// Dependency-free apart from @solana/kit types, so the co-signed envelopes
// (lib/kyc-registry-creation) and the 3.3 CLI rebuild the exact same bytes.
import type { Address, Instruction } from "@solana/kit";

export const COMPUTE_BUDGET_PROGRAM_ADDRESS =
  "ComputeBudget111111111111111111111111111111" as Address<"ComputeBudget111111111111111111111111111111">;

/** The runtime's per-transaction compute ceiling. */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
const U64_MAX = BigInt("18446744073709551615");

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
