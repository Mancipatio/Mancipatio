/**
 * lib/escrow-ledger.ts — the deposit-ledger arithmetic the UI shares with the
 * asset_registry program.
 *
 * Background. Every Mancipatio escrow (offer escrow, OTC deal escrows, custody
 * vault escrow) is an ordinary Token-2022 account: anyone holding the mint can
 * `transfer_checked` into it and nothing on-chain records who did. So the
 * program keeps its OWN ledger of what each counterparty actually deposited
 * through a program instruction — `Offer.deposited`,
 * `OtcDeal.asset_deposited_amount` / `payment_deposited_amount`,
 * `CustodyVault.deposited` — and every payout decision is made against the
 * ledger, never against the token balance:
 *
 *   * a refund of at most the ledger is the depositor's OWN property and goes
 *     out with no receiver-KYC check (a lapsed passport must never strand it);
 *   * anything ABOVE the ledger is a delivery of units the depositor never put
 *     in, so it only leaves the escrow if the receiver's `KycEntry` passes;
 *   * `take_offer` refuses to sell units the maker never deposited.
 *
 * These helpers mirror that arithmetic so the UI shows the same numbers the
 * chain will act on. They are pure — no RPC, no wallet.
 */

/**
 * Units still outstanding before an offer becomes takeable.
 *
 * `deposit_to_offer_escrow` is additive while the offer is `Open` and the
 * program caps the running total at `offer.amount` — over-funding would
 * strand the excess, because a fill drains exactly `amount` and then no
 * instruction accepts a `Filled` offer again. A deposit form must therefore
 * never offer more than this.
 *
 * Saturating at zero: `deposited` can equal `amount` but never exceed it, and
 * a negative "remaining" is meaningless in a u64 world.
 */
export function remainingDeposit(amount: bigint, deposited: bigint): bigint {
  return amount > deposited ? amount - deposited : BigInt(0);
}

/**
 * True when an offer's recorded deposit covers its full amount — exactly the
 * `deposited >= amount` condition `take_offer` enforces on-chain.
 *
 * Deliberately NOT a token-balance read: an escrow funded with a raw transfer
 * shows a healthy balance and is still untakeable.
 */
export function isOfferFunded(amount: bigint, deposited: bigint): boolean {
  return deposited >= amount;
}

export type EscrowReleasePreview = {
  /** Released unconditionally — the depositor's own recorded property. */
  fromLedger: bigint;
  /**
   * Units in the escrow that the ledger does not back. Released only to a
   * receiver whose `KycEntry` passes; withheld otherwise, in which case the
   * vault/offer deliberately stays OPEN so the remainder keeps an exit.
   */
  surplus: bigint;
};

/**
 * Client-side mirror of the program's `util::split_escrow_release`: split a
 * live escrow balance against the deposit ledger.
 *
 * The program pays `fromLedger` with no checks, then attempts `surplus` under
 * a receiver-KYC check and withholds it on failure. A release is terminal
 * (closing the vault and its `EscrowMarker`) only when nothing is withheld —
 * so `surplus > 0` is the UI's cue that an exit may not close the account.
 */
export function previewEscrowRelease(
  balance: bigint,
  deposited: bigint,
): EscrowReleasePreview {
  const fromLedger = balance < deposited ? balance : deposited;
  return { fromLedger, surplus: balance - fromLedger };
}
