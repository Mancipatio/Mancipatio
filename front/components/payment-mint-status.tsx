"use client";

import { TOKEN_2022 } from "@/lib/payment-mints";
import type { PaymentMintCheck } from "@/lib/use-payment-mint";

/** One line under a payment-mint field: what the typed mint is, or why it is refused. */
export function PaymentMintStatus({ check }: { check: PaymentMintCheck }) {
  if (check.status === "idle") return null;
  if (check.status === "checking") {
    return <span className="mt-1 block text-[11px] text-slate-400">Checking the payment token on-chain…</span>;
  }
  if (check.status === "error") {
    return (
      <span className="mt-1 block text-[11px] text-red-700" role="alert">
        {check.message}
      </span>
    );
  }
  return (
    <span className="mt-1 block text-[11px] text-slate-500">
      {check.label} · {check.decimals} decimals ·{" "}
      {check.owner === TOKEN_2022 ? "Token-2022" : "SPL Token"}
    </span>
  );
}
