"use client";
// The payment-mint entry check while a form is filled in (Talas 4.2 §3.4):
// the mint the user typed is read from chain under the plain-payment rule
// (and, on mainnet, the allowlist), so the form can show its label and what
// a base-unit amount means before anything is signed. Convenience only: the
// send re-checks with inspectPaymentMint and the server routes are
// authoritative.
import { useEffect, useState } from "react";
import { isAddress, type Address } from "@solana/kit";
import type { Network } from "@/lib/network";
import { paymentMintLabel } from "@/lib/payment-mints";
import { inspectPaymentMint } from "@/lib/transaction-builders";
import { formatTokenAmount } from "@/lib/vesting-amounts";

type Rpc = Parameters<typeof inspectPaymentMint>[0];

export type PaymentMintCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok"; mint: Address; owner: Address; decimals: number; label: string }
  | { status: "error"; mint: string; message: string };

/** Inspects `mint` (when it is an address) with the entry rule; re-runs when it changes. */
export function usePaymentMintCheck(rpc: Rpc, network: Network, mint: string): PaymentMintCheck {
  const value = mint.trim();
  const [check, setCheck] = useState<PaymentMintCheck>({ status: "idle" });
  useEffect(() => {
    let cancelled = false;
    if (!isAddress(value)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCheck({ status: "idle" });
      return;
    }
    setCheck({ status: "checking" });
    inspectPaymentMint(rpc, value, network, { commitment: "confirmed", abortSignal: AbortSignal.timeout(10_000) })
      .then(({ owner, decimals }) => {
        if (!cancelled) setCheck({ status: "ok", mint: value, owner, decimals, label: paymentMintLabel(value, network) });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setCheck({
            status: "error",
            mint: value,
            message: err instanceof Error ? err.message : "This payment token could not be checked.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, network, value]);
  return check;
}

/** "= 1.5 USDC" for a base-unit amount once the mint is known; null otherwise. */
export function paymentAmountHint(baseUnits: string, check: PaymentMintCheck): string | null {
  if (check.status !== "ok" || !/^\d{1,20}$/.test(baseUnits.trim())) return null;
  try {
    return `= ${formatTokenAmount(BigInt(baseUnits.trim()), check.decimals)} ${check.label}`;
  } catch {
    return null;
  }
}
