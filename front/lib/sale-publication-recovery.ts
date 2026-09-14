"use client";
import { address, isAddress, isSignature } from "@solana/kit";
import type { Network } from "@/lib/network";
export const SALE_PUBLICATION_EVENT = "mancipatio:sale-publication";
export type PendingSalePublication = {
  version: 1;
  network: Network;
  wallet: string;
  salePda: string;
  signature: string | null;
  lastValidBlockHeight: string;
  listing: {
    sale_pubkey: string;
    application_id: string | null;
    logo_letter: string;
    is_published: true;
  };
};
const prefix = (network: Network, wallet: string) =>
  `mancipatio:sale-publication:v1:${network}:${wallet}:`;
export function listSalePublications(
  network: Network,
  wallet: string,
): PendingSalePublication[] {
  const result: PendingSalePublication[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key?.startsWith(prefix(network, wallet))) continue;
    const raw = window.localStorage.getItem(key);
    if (!raw) continue;
    const p = JSON.parse(raw) as PendingSalePublication;
    if (
      p.version !== 1 ||
      p.network !== network ||
      p.wallet !== wallet ||
      !isAddress(p.salePda) ||
      p.listing?.sale_pubkey !== p.salePda ||
      !/^\d+$/.test(p.lastValidBlockHeight) ||
      (p.signature !== null && !isSignature(p.signature))
    )
      throw new Error(
        "A saved sale intent is unreadable. Preserve browser storage and reconcile existing sales before opening another.",
      );
    result.push(p);
  }
  return result;
}
export function saveSalePublication(value: PendingSalePublication) {
  if (
    !isAddress(value.wallet) ||
    !isAddress(value.salePda) ||
    value.listing.sale_pubkey !== value.salePda
  )
    throw new Error("Invalid sale publication intent");
  window.localStorage.setItem(
    prefix(value.network, value.wallet) + value.salePda,
    JSON.stringify(value),
  );
  window.dispatchEvent(new Event(SALE_PUBLICATION_EVENT));
}
export function clearSalePublication(value: PendingSalePublication) {
  window.localStorage.removeItem(
    prefix(value.network, value.wallet) + value.salePda,
  );
  window.dispatchEvent(new Event(SALE_PUBLICATION_EVENT));
}

/** Prove absence in the same finalized bank whose height is past expiry. */
export async function assertSaleIntentUnsent(
  rpc: Parameters<
    typeof import("@/lib/transaction-builders").fetchMintTokenProgram
  >[0],
  item: PendingSalePublication,
) {
  const info = await rpc
    .getAccountInfo(address(item.salePda), {
      encoding: "base64",
      commitment: "finalized",
    })
    .send({ abortSignal: AbortSignal.timeout(10_000) });
  if (info.value)
    throw new Error(
      "This sale exists on-chain. Publish the existing sale instead of opening another.",
    );
  const block = await rpc
    .getBlock(info.context.slot, {
      commitment: "finalized",
      transactionDetails: "none",
      rewards: false,
      maxSupportedTransactionVersion: 0,
    })
    .send({ abortSignal: AbortSignal.timeout(10_000) });
  if (
    block?.blockHeight == null ||
    block.blockHeight <= BigInt(item.lastValidBlockHeight)
  )
    throw new Error(
      "The opening transaction can still land, or expiry could not be proven. Wait for its blockhash to expire, then check again.",
    );
}
