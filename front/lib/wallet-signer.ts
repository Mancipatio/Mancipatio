"use client";

import { createWalletTransactionSigner } from "@solana/client";
import type { WalletSession } from "@solana/client";
import type { TransactionSigner } from "@solana/kit";

/**
 * Build a real `TransactionSigner` from the current wallet session.
 *
 * Use this everywhere a privileged instruction expects a signer; pass the
 * same `signer` instance to the Codama instruction (as `admin`/`authority`/
 * `payer`/…) AND to `feePayer` of `tx.send`. That keeps kit happy — it
 * matches signer entries by reference, not by address.
 */
export function walletSigner(
  session: WalletSession | undefined | null,
): TransactionSigner {
  if (!session) {
    throw new Error("Wallet not connected");
  }
  return createWalletTransactionSigner(session).signer;
}
