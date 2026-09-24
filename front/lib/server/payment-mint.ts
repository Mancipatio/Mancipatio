// SERVER-ONLY — payment-mint checks for the signed routes that let a payment
// mint in (Talas 4.2, design-4.2-4.3 §3.3): sale-approval reserve, the FX
// rates the raise cap counts with, and OTC requests. The rules are the pure
// ones in lib/payment-mints; this reads the mint from the server RPC and maps
// failures onto route errors (400 for a refused mint, 503 when the chain
// cannot be read — never "accepted" on RPC trouble).

import "server-only";

import { fetchEncodedAccount, type Address } from "@solana/kit";
import type { Network } from "@/lib/network";
import {
  NOT_ALLOWED_ON_MAINNET,
  assertKnownMintLayout,
  classifyMintAccount,
  isAllowedPaymentMint,
} from "@/lib/payment-mints";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws-error";

/**
 * A payment mint's token program and decimals, read from chain at
 * `confirmed`, under the plain-payment rule and the known USDC layout.
 */
export async function paymentMintInfo(mint: Address, network: Network): Promise<{ owner: Address; decimals: number }> {
  let account: Awaited<ReturnType<typeof fetchEncodedAccount>>;
  try {
    account = await fetchEncodedAccount(getServerRpc(), mint, {
      commitment: "confirmed",
      abortSignal: AbortSignal.timeout(12_000),
    });
  } catch {
    // No error detail: an RPC error can carry the provider URL and its key.
    console.error("[payment-mint] RPC failure reading the payment mint");
    throw new SiwsError(503, "On-chain check unavailable — try again");
  }
  if (!account.exists) throw new SiwsError(400, "payment_mint is not an initialized token mint");
  try {
    const { owner, decimals } = classifyMintAccount(account, { plainPayment: true });
    assertKnownMintLayout(network, mint, { owner, decimals });
    return { owner, decimals };
  } catch (err) {
    throw new SiwsError(400, `payment_mint: ${err instanceof Error ? err.message : "not a supported payment token"}`);
  }
}

/** Mainnet: only allowlisted payment mints (lib/payment-mints MAINNET_PAYMENT_MINTS). */
export function assertAllowedPaymentMint(network: Network, mint: string): void {
  if (!isAllowedPaymentMint(network, mint)) throw new SiwsError(400, NOT_ALLOWED_ON_MAINNET);
}
