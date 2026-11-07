// Read SPL Token-2022 holdings of a wallet via getTokenAccountsByOwner.
// We restrict to Manci share-class mints (everything else is dropped).

"use client";

import type { SolanaClient } from "@solana/client";
import type { Address } from "@solana/kit";

type Rpc = SolanaClient["runtime"]["rpc"];

const TOKEN_2022_PROGRAM =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

export type Holding = {
  mint: string;
  balance: bigint;
  account: string;
};

/**
 * Returns every non-zero Token-2022 balance the owner holds.
 * RPC/decoding failures throw so callers never mistake unavailable balances for zero.
 *
 * Filter by mint in the caller — typical use:
 *   const all = await loadHoldings(rpc, wallet)
 *   const ours = all.filter(h => myShareClassMints.has(h.mint))
 */
export async function loadHoldings(
  rpc: Rpc,
  owner: Address,
): Promise<Holding[]> {
  const res = await rpc
    .getTokenAccountsByOwner(
      owner,
      { programId: TOKEN_2022_PROGRAM },
      { encoding: "jsonParsed" },
    )
    .send({ abortSignal: AbortSignal.timeout(12_000) });
  if (!Array.isArray(res.value)) throw new Error("Token balances are unavailable. Please retry.");
  const out: Holding[] = [];
  for (const item of res.value) {
    // jsonParsed shape: account.data.parsed.info.{ mint, tokenAmount: { amount } }
    const data = item.account?.data as unknown;
    if (!data || typeof data !== "object" || !("parsed" in data)) {
      throw new Error("Token balances could not be decoded. Please retry.");
    }
    const parsed = (data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } }).parsed;
    const info = parsed?.info;
    if (!info?.mint || !info?.tokenAmount?.amount || !/^\d+$/.test(info.tokenAmount.amount)) {
      throw new Error("Token balances could not be decoded. Please retry.");
    }
    const amount = BigInt(info.tokenAmount.amount);
    if (amount === BigInt(0)) continue;
    out.push({
      mint: info.mint,
      balance: amount,
      account: item.pubkey.toString(),
    });
  }
  return out;
}
