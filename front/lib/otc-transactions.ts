// Wallet transactions of the secondary-market flows: the seller's
// `deposit_otc_asset` (two hook tails), the buyer's `deposit_otc_payment`,
// the permissionless `expire_otc_deal` and `take_offer` (three ATA
// creations). Built here, not inline in the pages, so
// tests/otc-transaction-size.test.ts measures exactly what the pages (and the
// e2e / sim harnesses) send against the 1232-byte packet limit.
//
// v1.0.0-rc: every one of them passes both parties' hook blocklist entries
// (["blocked", wallet], appended after the named accounts and before the hook
// tails); a blocked party refuses the instruction (PartyBlocklisted, 6144).
// An expired deal whose deposited leg belongs to a blocked party therefore
// cannot be expired: its refund waits for an Admin's `cancel_otc_deal`.
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import {
  getDepositOtcAssetInstructionAsync,
  getDepositOtcPaymentInstructionAsync,
  getExpireOtcDealInstructionAsync,
  getTakeOfferInstructionAsync,
  type Offer,
  type OtcDeal,
} from "@/lib/generated/asset_registry";
import { hookTransferMetas } from "@/lib/hook-metas";
import { findBlockEntryPda } from "@/lib/pdas";

type Rpc = Parameters<typeof hookTransferMetas>[0];

const TOKEN_2022 =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

/**
 * Seller deposits the share units. remaining_accounts, per
 * deposit_otc_asset.rs: the deposit leg's hook tail (source authority =
 * seller), then the settle leg's hook tail (source authority = deal PDA).
 * Both legs move the same share mint, so the tails are equal length (3
 * accounts each in Open mode, 9 each in KycGated — built mode-aware by
 * hookTransferMetas) and the handler splits at len/2 when this deposit
 * completes the pair; when it doesn't, Token-2022 hook resolution ignores
 * the unreferenced second tail, so passing both is always safe.
 *
 * The Rust account structs require the settlement destination accounts to
 * exist even when this deposit doesn't settle, so both are created
 * idempotently first.
 */
export async function buildDepositOtcAssetInstructions(
  rpc: Rpc,
  input: {
    seller: TransactionSigner;
    dealPda: Address;
    deal: Pick<
      OtcDeal,
      "mint" | "buyer" | "paymentMint" | "assetEscrow" | "paymentEscrow"
    >;
    paymentTokenProgram: Address;
  },
): Promise<Instruction[]> {
  const { seller, dealPda, deal, paymentTokenProgram } = input;
  const wallet = seller.address;
  const [sellerShareAta] = await findAssociatedTokenPda({
    owner: wallet,
    tokenProgram: TOKEN_2022,
    mint: deal.mint,
  });
  const [buyerShareAta] = await findAssociatedTokenPda({
    owner: deal.buyer,
    tokenProgram: TOKEN_2022,
    mint: deal.mint,
  });
  const [sellerPaymentAta] = await findAssociatedTokenPda({
    owner: wallet,
    tokenProgram: paymentTokenProgram,
    mint: deal.paymentMint,
  });
  const createBuyerShareAtaIx =
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: seller,
      owner: deal.buyer,
      mint: deal.mint,
      tokenProgram: TOKEN_2022,
    });
  const createSellerPaymentAtaIx =
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: seller,
      owner: wallet,
      mint: deal.paymentMint,
      tokenProgram: paymentTokenProgram,
    });
  // escrowMarker (["escrow_marker", deal PDA]) and the Platform pause gate
  // are auto-derived by the async builder; both parties' hook blocklist
  // entries (v1, appended before the tails) must be unset (6144).
  const [buyerBlockEntry, sellerBlockEntry] = await Promise.all([
    findBlockEntryPda(deal.buyer),
    findBlockEntryPda(wallet),
  ]);
  const baseIx = await getDepositOtcAssetInstructionAsync({
    seller,
    deal: dealPda,
    mint: deal.mint,
    sellerShareAccount: sellerShareAta,
    assetEscrow: deal.assetEscrow,
    paymentMint: deal.paymentMint,
    paymentEscrow: deal.paymentEscrow,
    buyerShareAccount: buyerShareAta,
    sellerPaymentAccount: sellerPaymentAta,
    shareTokenProgram: TOKEN_2022,
    paymentTokenProgram,
    buyerBlockEntry,
    sellerBlockEntry,
  });
  const depositIx = {
    ...baseIx,
    accounts: [
      ...baseIx.accounts,
      // Deposit leg: seller wallet → asset escrow (owned by the deal PDA).
      ...(await hookTransferMetas(rpc, deal.mint, {
        sourceTokenAccount: sellerShareAta,
        destTokenAccount: deal.assetEscrow,
        transferAuthority: wallet,
        sourceOwner: wallet,
        destOwner: dealPda,
      })),
      // Settle leg: asset escrow (deal PDA) → buyer share account.
      ...(await hookTransferMetas(rpc, deal.mint, {
        sourceTokenAccount: deal.assetEscrow,
        destTokenAccount: buyerShareAta,
        transferAuthority: dealPda,
        sourceOwner: dealPda,
        destOwner: deal.buyer,
      })),
    ],
  };
  return [createBuyerShareAtaIx, createSellerPaymentAtaIx, depositIx];
}

/**
 * Buyer deposits the payment leg (`deposit_otc_payment`). Both settlement
 * destinations (the buyer's share ATA, the seller's payment ATA) are created
 * idempotently first: the account structs require them even when this
 * deposit does not settle. remaining_accounts: the settle leg's hook tail
 * (asset escrow, owned by the deal PDA → the buyer). The payment account is
 * the buyer's own ATA.
 */
export async function buildDepositOtcPaymentInstructions(
  rpc: Rpc,
  input: {
    buyer: TransactionSigner;
    dealPda: Address;
    deal: Pick<OtcDeal, "mint" | "seller" | "paymentMint" | "assetEscrow" | "paymentEscrow">;
    paymentTokenProgram: Address;
  },
): Promise<Instruction[]> {
  const { buyer, dealPda, deal, paymentTokenProgram } = input;
  const wallet = buyer.address;
  const [[buyerPaymentAta], [buyerShareAta], [sellerPaymentAta], buyerBlockEntry, sellerBlockEntry] =
    await Promise.all([
      findAssociatedTokenPda({ owner: wallet, tokenProgram: paymentTokenProgram, mint: deal.paymentMint }),
      findAssociatedTokenPda({ owner: wallet, tokenProgram: TOKEN_2022, mint: deal.mint }),
      findAssociatedTokenPda({ owner: deal.seller, tokenProgram: paymentTokenProgram, mint: deal.paymentMint }),
      findBlockEntryPda(wallet),
      findBlockEntryPda(deal.seller),
    ]);
  const createBuyerShareAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: buyer,
    owner: wallet,
    mint: deal.mint,
    tokenProgram: TOKEN_2022,
  });
  const createSellerPaymentAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: buyer,
    owner: deal.seller,
    mint: deal.paymentMint,
    tokenProgram: paymentTokenProgram,
  });
  // escrowMarker (["escrow_marker", deal PDA]) and the Platform pause gate
  // are auto-derived by the async builder — the marker is closed on-chain
  // when this deposit settles the deal.
  const baseIx = await getDepositOtcPaymentInstructionAsync({
    buyer,
    deal: dealPda,
    mint: deal.mint,
    paymentMint: deal.paymentMint,
    buyerPaymentAccount: buyerPaymentAta,
    paymentEscrow: deal.paymentEscrow,
    assetEscrow: deal.assetEscrow,
    buyerShareAccount: buyerShareAta,
    sellerPaymentAccount: sellerPaymentAta,
    shareTokenProgram: TOKEN_2022,
    paymentTokenProgram,
    buyerBlockEntry,
    sellerBlockEntry,
  });
  const depositIx = {
    ...baseIx,
    accounts: [
      ...baseIx.accounts,
      // Settle leg: asset escrow (deal PDA) → buyer.
      ...(await hookTransferMetas(rpc, deal.mint, {
        sourceTokenAccount: deal.assetEscrow,
        destTokenAccount: buyerShareAta,
        transferAuthority: dealPda,
        sourceOwner: dealPda,
        destOwner: wallet,
      })),
    ],
  };
  return [createBuyerShareAtaIx, createSellerPaymentAtaIx, depositIx];
}

/**
 * Permissionless refund of an expired open deal (`expire_otc_deal`): each
 * deposited leg returns to its depositor. Both refund destinations are
 * created idempotently first. remaining_accounts: the asset refund leg's hook
 * tail (asset escrow, owned by the deal PDA → the seller), used only if the
 * asset leg is refunded. Refused with 6144 when a deposited leg's owner is
 * blocklisted: that refund is an Admin decision (`cancel_otc_deal`).
 */
export async function buildExpireOtcDealInstructions(
  rpc: Rpc,
  input: {
    payer: TransactionSigner;
    dealPda: Address;
    deal: Pick<OtcDeal, "mint" | "buyer" | "seller" | "paymentMint" | "assetEscrow" | "paymentEscrow">;
    paymentTokenProgram: Address;
  },
): Promise<Instruction[]> {
  const { payer, dealPda, deal, paymentTokenProgram } = input;
  const [[sellerShareAta], [buyerPaymentAta], buyerBlockEntry, sellerBlockEntry] = await Promise.all([
    findAssociatedTokenPda({ owner: deal.seller, tokenProgram: TOKEN_2022, mint: deal.mint }),
    findAssociatedTokenPda({ owner: deal.buyer, tokenProgram: paymentTokenProgram, mint: deal.paymentMint }),
    findBlockEntryPda(deal.buyer),
    findBlockEntryPda(deal.seller),
  ]);
  const createSellerShareAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer,
    owner: deal.seller,
    mint: deal.mint,
    tokenProgram: TOKEN_2022,
  });
  const createBuyerPaymentAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer,
    owner: deal.buyer,
    mint: deal.paymentMint,
    tokenProgram: paymentTokenProgram,
  });
  // escrowMarker (["escrow_marker", deal PDA]) is auto-derived by the async
  // builder — closed on-chain by this terminal path.
  const baseIx = await getExpireOtcDealInstructionAsync({
    payer,
    deal: dealPda,
    mint: deal.mint,
    assetEscrow: deal.assetEscrow,
    sellerShareAccount: sellerShareAta,
    paymentMint: deal.paymentMint,
    paymentEscrow: deal.paymentEscrow,
    buyerPaymentAccount: buyerPaymentAta,
    shareTokenProgram: TOKEN_2022,
    paymentTokenProgram,
    buyerBlockEntry,
    sellerBlockEntry,
  });
  const expireIx = {
    ...baseIx,
    accounts: [
      ...baseIx.accounts,
      ...(await hookTransferMetas(rpc, deal.mint, {
        sourceTokenAccount: deal.assetEscrow,
        destTokenAccount: sellerShareAta,
        transferAuthority: dealPda,
        sourceOwner: dealPda,
        destOwner: deal.seller,
      })),
    ],
  };
  return [createSellerShareAtaIx, createBuyerPaymentAtaIx, expireIx];
}

/** A failed expire refused because a party is blocklisted: route to an Admin cancel. */
export const EXPIRE_BLOCKED_PARTY_HINT =
  "One side of this deal is on the Manci blocklist, so its deposit cannot be refunded automatically. Ask a Manci Admin to cancel the deal (an Admin decision); nothing was changed.";

/**
 * Taker takes an OTC offer: creates the taker's share and payment ATAs and the
 * maker's payment ATA idempotently (the on-chain constraints require them),
 * then `take_offer` with the mode-aware hook tail for the escrow → taker
 * release. The release is signed by the Offer PDA, so the source-authority
 * blocklist entry is keyed on the Offer PDA (mirrors cancel_offer).
 */
export async function buildTakeOfferInstructions(
  rpc: Rpc,
  input: {
    taker: TransactionSigner;
    offerPda: Address;
    offer: Pick<Offer, "mint" | "maker" | "escrow" | "paymentMint">;
    paymentTokenProgram: Address;
  },
): Promise<Instruction[]> {
  const { taker, offerPda, offer, paymentTokenProgram } = input;
  const wallet = taker.address;
  // Taker receives share units here (Token-2022, share mint).
  const [takerShareAta] = await findAssociatedTokenPda({
    owner: wallet,
    tokenProgram: TOKEN_2022,
    mint: offer.mint,
  });
  const createTakerShareAtaIx =
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: taker,
      owner: wallet,
      mint: offer.mint,
      tokenProgram: TOKEN_2022,
    });
  // Taker pays from here (payment mint).
  const [takerPaymentAta] = await findAssociatedTokenPda({
    owner: wallet,
    tokenProgram: paymentTokenProgram,
    mint: offer.paymentMint,
  });
  const createTakerPaymentAtaIx =
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: taker,
      owner: wallet,
      mint: offer.paymentMint,
      tokenProgram: paymentTokenProgram,
    });
  // Maker receives the payment here. The on-chain constraint requires
  // owner == offer.maker, which the maker's ATA satisfies; create it
  // idempotently so settlement can't fail on a missing destination.
  const [makerPaymentAta] = await findAssociatedTokenPda({
    owner: offer.maker,
    tokenProgram: paymentTokenProgram,
    mint: offer.paymentMint,
  });
  const createMakerPaymentAtaIx =
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: taker,
      owner: offer.maker,
      mint: offer.paymentMint,
      tokenProgram: paymentTokenProgram,
    });
  // escrowMarker (["escrow_marker", offer PDA]), the Platform pause gate and
  // the taker's hook blocklist entry are auto-derived by the async builder;
  // the maker's is passed (v1: both must be unset, 6144). The taker pays
  // from its own ATA: the program refuses a payment account the taker does
  // not own (6001).
  const baseIx = await getTakeOfferInstructionAsync({
    taker,
    offer: offerPda,
    mint: offer.mint,
    escrow: offer.escrow,
    takerShareAccount: takerShareAta,
    paymentMint: offer.paymentMint,
    takerPaymentAccount: takerPaymentAta,
    makerPaymentAccount: makerPaymentAta,
    shareTokenProgram: TOKEN_2022,
    paymentTokenProgram,
    takerBlockEntry: await findBlockEntryPda(wallet),
    makerBlockEntry: await findBlockEntryPda(offer.maker),
  });
  const takeIx = {
    ...baseIx,
    accounts: [
      ...baseIx.accounts,
      ...(await hookTransferMetas(rpc, offer.mint, {
        sourceTokenAccount: offer.escrow,
        destTokenAccount: takerShareAta,
        transferAuthority: offerPda,
        sourceOwner: offerPda,
        destOwner: wallet,
      })),
    ],
  };
  return [
    createTakerShareAtaIx,
    createTakerPaymentAtaIx,
    createMakerPaymentAtaIx,
    takeIx,
  ];
}
