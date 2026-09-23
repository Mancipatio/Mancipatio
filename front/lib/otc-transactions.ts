// Wallet transactions for the two largest secondary-market flows: the seller's
// `deposit_otc_asset` (two hook tails) and `take_offer` (three ATA creations).
// Built here, not inline in the pages, so tests/otc-transaction-size.test.ts
// measures exactly what the pages send against the 1232-byte packet limit.
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import {
  getDepositOtcAssetInstructionAsync,
  getTakeOfferInstructionAsync,
  type Offer,
  type OtcDeal,
} from "@/lib/generated/asset_registry";
import { hookTransferMetas } from "@/lib/hook-metas";

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
  // are auto-derived by the async builder.
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
  // escrowMarker (["escrow_marker", offer PDA]) and the Platform pause gate
  // are auto-derived by the async builder.
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
