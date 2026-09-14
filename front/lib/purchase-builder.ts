import {
  signature as toSignature,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeShareClass,
  fetchMaybeAsset,
  fetchMaybeIssuer,
  getBuyInstruction,
  KybStatus,
  type Sale,
} from "@/lib/generated/asset_registry";
import { kycReceiverMetas } from "@/lib/hook-metas";
import {
  documentTermsMemo,
  type SaleDocumentTerms,
} from "@/lib/document-terms";
import {
  fetchPlainPaymentMintTokenProgram,
  TOKEN_2022,
} from "@/lib/transaction-builders";
import {
  vestingTransactionBytes,
  VESTING_TRANSACTION_LIMIT,
} from "@/lib/vesting-creation";
import { findSalePda } from "@/lib/pdas";
type Rpc = Parameters<typeof kycReceiverMetas>[0];
/** The acceptance memo stays in the same atomic transaction as the payment and mint. */
export async function buildDocumentedPurchase(
  rpc: Rpc,
  input: {
    buyer: TransactionSigner;
    sale: Sale;
    amount: bigint;
    terms: SaleDocumentTerms;
  },
) {
  const { buyer, sale, terms, amount } = input;
  const options = {
    commitment: "finalized" as const,
    abortSignal: AbortSignal.timeout(12_000),
  };
  const salePda = await findSalePda(sale.shareClass, sale.saleId);
  const share = await fetchMaybeShareClass(rpc, sale.shareClass, options);
  if (
    !share.exists ||
    share.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    share.data.mint !== sale.mint
  )
    throw new Error("Sale share class and mint could not be verified");
  const asset = await fetchMaybeAsset(rpc, share.data.asset, options);
  if (!asset.exists || asset.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS)
    throw new Error("The sale asset could not be verified");
  const issuer = await fetchMaybeIssuer(rpc, asset.data.issuer, options);
  if (
    !issuer.exists ||
    issuer.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    issuer.data.kybStatus !== KybStatus.Verified
  )
    throw new Error("The sale issuer must have verified KYB before a purchase");
  if (terms.sale !== salePda || terms.asset !== share.data.asset)
    throw new Error(
      "The accepted document does not belong to this sale and asset",
    );
  const paymentProgram = await fetchPlainPaymentMintTokenProgram(
    rpc,
    sale.paymentMint,
    options,
  );
  const [shareAta] = await findAssociatedTokenPda({
    owner: buyer.address,
    mint: sale.mint,
    tokenProgram: TOKEN_2022,
  });
  const [paymentAta] = await findAssociatedTokenPda({
    owner: buyer.address,
    mint: sale.paymentMint,
    tokenProgram: paymentProgram,
  });
  const preparation = await Promise.all([
    getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: buyer,
      owner: buyer.address,
      mint: sale.mint,
      tokenProgram: TOKEN_2022,
    }),
    getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: buyer,
      owner: buyer.address,
      mint: sale.paymentMint,
      tokenProgram: paymentProgram,
    }),
  ]);
  const base = getBuyInstruction({
    buyer,
    sale: salePda,
    shareClass: sale.shareClass,
    mint: sale.mint,
    buyerShareAccount: shareAta,
    buyerPaymentAccount: paymentAta,
    paymentMint: sale.paymentMint,
    proceeds: sale.proceeds,
    shareTokenProgram: TOKEN_2022,
    paymentTokenProgram: paymentProgram,
    asset: share.data.asset,
    issuer: asset.data.issuer,
    amount,
  });
  const tail = await kycReceiverMetas(rpc, sale.mint, buyer.address);
  const buy = { ...base, accounts: [...base.accounts, ...tail] };
  return planDocumentedPurchase(
    preparation,
    [documentTermsMemo(terms), buy],
    buyer,
  );
}
/** Pure, tested against actual encoded v0 messages including both compute-budget instructions. */
export function planDocumentedPurchase(
  preparation: readonly Instruction[],
  purchase: readonly Instruction[],
  buyer: TransactionSigner,
) {
  const combined = [...preparation, ...purchase];
  const combinedBytes = vestingTransactionBytes(combined, buyer),
    purchaseBytes = vestingTransactionBytes(purchase, buyer);
  if (purchaseBytes > VESTING_TRANSACTION_LIMIT)
    throw new Error(
      "The documented purchase exceeds this wallet transaction's size limit. A reviewed lookup-table flow is required.",
    );
  const prepare =
    combinedBytes > VESTING_TRANSACTION_LIMIT ? [...preparation] : [];
  if (
    prepare.length &&
    vestingTransactionBytes(prepare, buyer) > VESTING_TRANSACTION_LIMIT
  )
    throw new Error(
      "Token-account preparation exceeds the transaction size limit",
    );
  return {
    preparationInstructions: prepare,
    purchaseInstructions: prepare.length ? [...purchase] : combined,
    combinedBytes,
    purchaseBytes,
  };
}

export async function waitForPurchasePreparation(rpc: Rpc, signature: string) {
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    const status = (
      await rpc
        .getSignatureStatuses([toSignature(signature)], {
          searchTransactionHistory: true,
        })
        .send({ abortSignal: AbortSignal.timeout(10_000) })
    ).value[0];
    if (status?.err)
      throw new Error(
        "Token-account preparation failed. No purchase was sent; retry after checking this receipt.",
      );
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(
    "Token-account preparation is still pending. No purchase was sent; retry after confirmation.",
  );
}
