// Opening an OTC escrow deal for a request (business-doc §9: "one submits a
// request for smart-contract creation; the platform creates the contract").
//
// Shared by /admin/otc (createContract) and the devnet simulator's owner
// actor (scripts/sim/lib/cohorts/owner.ts), so both build the same
// create_otc_deal instruction from the same request row: the deal id, the
// expiry rule and the argument mapping live here once. Pure apart from the
// PDA derivations inside the generated builder; the clock is a parameter so
// a caller (and a test) can pin it.

import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { getCreateOtcDealInstructionAsync } from "@/lib/generated/asset_registry";

/** Share-class mints are Token-2022 transfer-hook mints. */
export const OTC_SHARE_TOKEN_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

/** Default deal lifetime when a request carries no usable expiry. */
export const DEFAULT_DEAL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Timestamp-based unique u64 (ms since epoch) for deal ids — the deal PDA is
 * seeded by (share_class, deal_id), so collisions across share classes are
 * fine and same-class collisions need two creations within one millisecond.
 */
export function newDealId(nowMs: number = Date.now()): bigint {
  return BigInt(nowMs);
}

/** Default deal expiry: 7 days from now (unix seconds). */
export function defaultDealExpiry(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000) + DEFAULT_DEAL_SECONDS);
}

/**
 * Deal expiry for a request: its own expiry when still in the future,
 * otherwise the default window. A stale request row could carry an
 * already-past expires_at, which would create a deal that is expired the
 * moment it exists (unfundable, only refundable).
 */
export function resolveDealExpiry(reqExpiresAt: string | null, nowMs: number = Date.now()): bigint {
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  const requested = reqExpiresAt
    ? BigInt(Math.floor(new Date(reqExpiresAt).getTime() / 1000))
    : defaultDealExpiry(nowMs);
  return requested > nowSec ? requested : defaultDealExpiry(nowMs);
}

/** The request-row fields the escrow is opened from (an otc_requests row). */
export type OtcDealRequestFields = {
  share_class_pda: string;
  mint: string;
  payment_mint: string;
  buyer_wallet: string;
  seller_wallet: string;
  /** Integer share units. */
  amount: number;
  /** Integer payment-token base units. */
  price: number;
};

/**
 * create_otc_deal for a request: the admin `authority` signs and pays the
 * rent; `paymentTokenProgram` is the payment mint's owner as the entry check
 * (inspectPaymentMint) resolved it.
 */
export function createOtcDealInstruction(input: {
  authority: TransactionSigner;
  request: OtcDealRequestFields;
  dealId: bigint;
  expiresAt: bigint;
  paymentTokenProgram: Address;
}): Promise<Instruction> {
  const req = input.request;
  return getCreateOtcDealInstructionAsync({
    authority: input.authority,
    shareClass: req.share_class_pda as Address,
    mint: req.mint as Address,
    paymentMint: req.payment_mint as Address,
    tokenProgram: OTC_SHARE_TOKEN_PROGRAM,
    paymentTokenProgram: input.paymentTokenProgram,
    dealId: input.dealId,
    buyer: req.buyer_wallet as Address,
    seller: req.seller_wallet as Address,
    amount: BigInt(Math.trunc(req.amount)),
    price: BigInt(Math.trunc(req.price)),
    paymentMintArg: req.payment_mint as Address,
    expiresAt: input.expiresAt,
  });
}
