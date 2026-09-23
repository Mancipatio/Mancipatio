// `reclaim_rent` (2D) builders. One instruction, four arms selected on-chain by
// the target's discriminator. Absent optional accounts go out as the program
// id (Codama's "programId" strategy, which is how Anchor encodes `None`).
//
// Never bundle a reclaim with the step that settles the account: a withheld
// surplus would make the reclaim fail (EscrowNotEmpty) and revert the whole
// transaction, and the custody evidence parsers need the escrow's post balance
// from the realize / return transaction itself.
import type { Address, TransactionSigner } from "@solana/kit";
import {
  getReclaimRentInstruction,
  type CustodyVault,
  type Offer,
  type OtcDeal,
} from "@/lib/generated/asset_registry";

/**
 * A random default u64 id (decimal) for a new offer: a tombstoned id can never
 * be reused, so sequential defaults like "1" would collide. UX only; the
 * program still refuses any occupied PDA.
 */
export function randomAccountId(): string {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  // 53 bits keep the id exact in a JS number input as well.
  return ((BigInt(words[0] & 0x1fffff) << BigInt(32)) | BigInt(words[1])).toString();
}

export type ReclaimState = "reclaimable" | "live" | "escrow-not-empty" | "unknown";

/**
 * Whether a reclaim button may be offered for a parent with this terminal
 * flag and live escrow balance (`null` = could not be read). Mirrors the
 * on-chain gates (AccountNotClosable / EscrowNotEmpty) so the wallet is never
 * asked to sign a transaction that must fail.
 */
export function reclaimState(
  terminal: boolean,
  escrowBalance: bigint | null | undefined,
): ReclaimState {
  if (!terminal) return "live";
  if (escrowBalance === null || escrowBalance === undefined) return "unknown";
  return escrowBalance === BigInt(0) ? "reclaimable" : "escrow-not-empty";
}

const SETTLED_WITH_OUTCOME = new Set(["delivered", "converted", "returned"]);

/** The fields of a linked delivery / conversion request the gate reads. */
export type LinkedCustodyRequest = {
  status: string;
  outcome_evidence?: unknown;
  deposit_evidence?: unknown;
};

/**
 * The requests of the delivery / conversion admin lists (already filtered by
 * `vault_pda` on the server) that are linked to `vaultPda`, reduced to the
 * gate's fields. Re-filtered here so an unfiltered list can never widen it.
 */
export function linkedCustodyRequests(
  vaultPda: string,
  ...queues: readonly (readonly { vault_pda: string | null; status: string }[])[]
): LinkedCustodyRequest[] {
  return queues
    .flat()
    .filter((request) => request.vault_pda === vaultPda)
    .map((request) => {
      const row = request as unknown as Record<string, unknown>;
      return {
        status: request.status,
        outcome_evidence: row.outcome_evidence ?? null,
        deposit_evidence: row.deposit_evidence ?? null,
      };
    });
}

/**
 * Why a custody vault's rent may NOT be reclaimed yet (null = it may). The
 * reclaim tombstones the vault, after which request evidence can only be
 * verified from the realize / return transaction, so every linked request
 * must already be settled: delivered / converted / returned WITH its verified
 * outcome evidence, or cancelled with no recorded deposit (never funded).
 * `linked: null` means the linked requests are not loaded (yet), which
 * blocks: the gate never assumes there are none.
 */
export function custodyReclaimBlocker(input: {
  wallet: string | null | undefined;
  authority: string;
  terminal: boolean;
  escrowBalance: bigint | null;
  linked: readonly LinkedCustodyRequest[] | null;
}): string | null {
  if (!input.terminal)
    return "Only a realized, reverted or returned vault can be closed.";
  if (!input.wallet || input.wallet !== input.authority)
    return "Only the vault's current authority can reclaim its rent.";
  if (input.escrowBalance === null)
    return "The escrow balance could not be read. Reload and try again.";
  if (input.escrowBalance !== BigInt(0))
    return "The escrow still holds tokens (a withheld surplus or dust), so the vault cannot be closed.";
  if (input.linked === null)
    return "The linked delivery / conversion requests are not loaded. Reload and try again.";
  for (const request of input.linked) {
    if (request.status === "cancelled") {
      // Defensive: the 0045 status guard never lets a request with a
      // recorded deposit be cancelled, but a funded one must end returned.
      if (request.deposit_evidence)
        return "A cancelled linked request recorded a deposit; record its verified return before closing the vault.";
      continue;
    }
    if (!SETTLED_WITH_OUTCOME.has(request.status))
      return "A linked request is still in progress. Settle it first.";
    if (!request.outcome_evidence)
      return "Record the linked request's verified outcome before closing the vault.";
  }
  return null;
}

/** Share-class escrows (offers, custody) are always Token-2022 accounts. */
export const SHARE_TOKEN_PROGRAM =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

/**
 * Offer arm, a permissionless crank: any `caller` signs, and the rent always
 * goes to `offer.maker`, who does not need to sign. Closable once the offer is
 * Filled, Cancelled or Expired and its escrow is empty.
 */
export function reclaimOffer(input: {
  caller: TransactionSigner;
  offer: Address;
  data: Pick<Offer, "maker" | "escrow">;
}) {
  return getReclaimRentInstruction({
    caller: input.caller,
    owner: input.data.maker,
    target: input.offer,
    linked: input.data.escrow,
    tokenProgram: SHARE_TOKEN_PROGRAM,
  });
}

/**
 * OtcDeal arm: only `deal.admin` may sign, and receives the rent of both
 * escrows and the deal. `paymentTokenProgram` owns the payment escrow (SPL
 * Token or Token-2022, whichever the payment mint uses).
 */
export function reclaimOtcDeal(input: {
  admin: TransactionSigner;
  deal: Address;
  data: Pick<OtcDeal, "admin" | "assetEscrow" | "paymentEscrow">;
  paymentTokenProgram: Address;
}) {
  if (input.admin.address !== input.data.admin)
    throw new Error("Only the deal's admin can reclaim its rent");
  return getReclaimRentInstruction({
    caller: input.admin,
    owner: input.data.admin,
    target: input.deal,
    linked: input.data.assetEscrow,
    linkedB: input.data.paymentEscrow,
    tokenProgram: SHARE_TOKEN_PROGRAM,
    tokenProgramB: input.paymentTokenProgram,
  });
}

/**
 * CustodyVault arm: only the current `vault.authority` may sign and receives
 * the rent. Closable once Realized, Reverted or Returned with an empty escrow.
 */
export function reclaimCustodyVault(input: {
  authority: TransactionSigner;
  vault: Address;
  data: Pick<CustodyVault, "authority" | "escrow">;
}) {
  if (input.authority.address !== input.data.authority)
    throw new Error("Only the vault's current authority can reclaim its rent");
  return getReclaimRentInstruction({
    caller: input.authority,
    owner: input.data.authority,
    target: input.vault,
    linked: input.data.escrow,
    tokenProgram: SHARE_TOKEN_PROGRAM,
  });
}
