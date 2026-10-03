"use client";

// open_sale on an approval, then the listing published — one copy for the
// issuer launchpad's "Open sale" and Distribute → Public sale.
//
// The intended Sale address is saved in this browser BEFORE the wallet
// prompt (lib/sale-publication-recovery), so a lost response never advances
// to another sale id and the listing can be published later from
// /issuer/launchpad ("Publish existing sale") without a second opening
// transaction. The program consumes the approval (open_sale closes it) and
// refuses an end past 365 days, a price outside the approval's band or a
// raise above its max_gross; the room is the caller's to check (the program
// does not, and buys would fail late with MaxSupplyExceeded).
import type { WalletSession, TransactionPrepareAndSendRequest } from "@solana/client";
import type { Address } from "@solana/kit";
import { getOpenSaleInstructionAsync, RaiseType } from "@/lib/generated/asset_registry";
import { assertChainRecordStorageAvailable } from "@/lib/chain-record-recovery";
import { clearSalePublication, listSalePublications, saveSalePublication, type PendingSalePublication } from "@/lib/sale-publication-recovery";
import { saleEndError } from "@/lib/deadline-bounds";
import { detectNetwork } from "@/lib/network";
import { findSalePda } from "@/lib/pdas";
import { upsertListing } from "@/lib/launchpad";
import { fetchPlainPaymentMintTokenProgram } from "@/lib/transaction-builders";
import { walletSigner } from "@/lib/wallet-signer";
import type { Rpc } from "@/lib/tokenize-shares-chain";
import type { SaleApprovalAccount } from "@/lib/sale-approvals";

export type OpenSaleStage = "before" | "intent-saved" | "submitted";

/** open_sale failed or was not confirmed; `stage` says what may already exist. */
export class OpenSaleError extends Error {
  readonly stage: OpenSaleStage;
  readonly signature: string | null;
  readonly salePda: Address | null;
  constructor(cause: unknown, stage: OpenSaleStage, signature: string | null, salePda: Address | null) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "OpenSaleError";
    this.stage = stage;
    this.signature = signature;
    this.salePda = salePda;
  }
}

export type OpenSaleResult = {
  signature: string;
  salePda: Address;
  /** The listing was published; false: publish it from /issuer/launchpad (the intent is saved). */
  published: boolean;
  publishError: string | null;
};

export async function openApprovedSale(input: {
  rpc: Rpc;
  session: WalletSession;
  send: (request: TransactionPrepareAndSendRequest) => Promise<string>;
  issuerPda: Address;
  assetPda: Address;
  approval: SaleApprovalAccount;
  mint: Address;
  pricePerUnit: bigint;
  totalForSale: bigint;
  /** Unix seconds; the sale starts now (start_ts 0). */
  endTs: bigint;
  /** A Startup approval's schedule; Mature: 0 / 0. */
  cliffMonths?: number;
  vestingMonths?: number;
  listing: { application_id: string | null; logo_letter: string };
}): Promise<OpenSaleResult> {
  const wallet = input.session.account.address;
  let stage: OpenSaleStage = "before";
  let signature: string | null = null;
  let salePda: Address | null = null;
  try {
    assertChainRecordStorageAvailable();
    if (listSalePublications(detectNetwork(), wallet).length) {
      throw new Error(
        "A sale opening is already pending publication. Use Publish existing sale on My sales, or verify that its unsent intent expired.",
      );
    }
    const endError = saleEndError(BigInt(0), input.endTs);
    if (endError) throw new Error(endError);
    if (input.totalForSale <= BigInt(0)) throw new Error("Offer at least 1 token.");
    const signer = walletSigner(input.session);
    // The payment mint comes from the approval (classic SPL or Token-2022).
    const paymentTokenProgram = await fetchPlainPaymentMintTokenProgram(input.rpc, input.approval.paymentMint);
    // The approval's PDA is derived from (share class, sale id); its rent returns to the approving admin.
    const ix = await getOpenSaleInstructionAsync({
      authority: signer,
      issuer: input.issuerPda,
      asset: input.assetPda,
      shareClass: input.approval.shareClass,
      mint: input.mint,
      paymentMint: input.approval.paymentMint,
      paymentTokenProgram,
      saleId: input.approval.saleId,
      pricePerUnit: input.pricePerUnit,
      totalForSale: input.totalForSale,
      startTs: BigInt(0),
      endTs: input.endTs,
      raiseType: input.approval.raiseType ?? RaiseType.Mature,
      cliffMonths: input.cliffMonths ?? 0,
      vestingMonths: input.vestingMonths ?? 0,
      approvedBy: input.approval.approvedBy,
    });
    salePda = await findSalePda(input.approval.shareClass, input.approval.saleId);
    const lifetime = (await input.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
    let publication: PendingSalePublication = {
      version: 1,
      network: detectNetwork(),
      wallet: wallet.toString(),
      salePda,
      signature: null,
      lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
      listing: { sale_pubkey: salePda, application_id: input.listing.application_id, logo_letter: input.listing.logo_letter, is_published: true },
    };
    // Persist the intended PDA before the wallet prompt.
    saveSalePublication(publication);
    stage = "intent-saved";
    signature = await input.send({ instructions: [ix], feePayer: signer, lifetime, prepareTransaction: { blockhashReset: false } });
    stage = "submitted";
    publication = { ...publication, signature };
    try {
      saveSalePublication(publication);
    } catch {
      /* the receipt is returned; the recovery list still holds the intent */
    }
    try {
      await upsertListing(input.session, publication.listing);
      clearSalePublication(publication);
      return { signature, salePda, published: true, publishError: null };
    } catch (err) {
      return { signature, salePda, published: false, publishError: err instanceof Error ? err.message : String(err) };
    }
  } catch (err) {
    throw new OpenSaleError(err, stage, signature, salePda);
  }
}
