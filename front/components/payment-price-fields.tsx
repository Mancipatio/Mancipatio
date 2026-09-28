"use client";

// The price half of the OTC and resell forms (lansiranje-16, lib/payment-price.ts):
// the payment token picked from the network's allowed list, the price typed
// in that token's units (decimals read from chain), and the confirmation a
// person reads before signing: units, total, price per unit, exact base units.
import { useState } from "react";
import type { Address } from "@solana/kit";
import { PaymentMintStatus } from "@/components/payment-mint-status";
import { paymentMintLabel } from "@/lib/payment-mints";
import {
  allowsOtherPaymentMint,
  describeTrade,
  parsePaymentPrice,
  paymentMintOptions,
} from "@/lib/payment-price";
import type { Network } from "@/lib/network";
import { usePaymentMintCheck } from "@/lib/use-payment-mint";
import type { ParsedAmount } from "@/lib/vesting-amounts";

const OTHER = "other";
type Rpc = Parameters<typeof usePaymentMintCheck>[0];

export type PaymentPriceForm = {
  network: Network;
  choice: string;
  setChoice: (value: string) => void;
  otherMint: string;
  setOtherMint: (value: string) => void;
  /** The mint the form pays in ("" while none is chosen). */
  mint: string;
  check: ReturnType<typeof usePaymentMintCheck>;
  priceInput: string;
  setPriceInput: (value: string) => void;
  decimals: number | null;
  label: string;
  /** null while the field is empty. */
  parsed: ParsedAmount | null;
  /** The price in base units once it parses, else null. */
  priceBase: bigint | null;
};

export function usePaymentPriceForm(rpc: Rpc, network: Network): PaymentPriceForm {
  const options = paymentMintOptions(network);
  const [choice, setChoice] = useState<string>(options[0]?.mint ?? (allowsOtherPaymentMint(network) ? OTHER : ""));
  const [otherMint, setOtherMint] = useState("");
  const [priceInput, setPriceInput] = useState("");
  const mint = choice === OTHER ? otherMint.trim() : choice;
  const check = usePaymentMintCheck(rpc, network, mint);
  const decimals = check.status === "ok" ? check.decimals : null;
  const parsed = priceInput.trim() ? parsePaymentPrice(priceInput, decimals) : null;
  return {
    network, choice, setChoice, otherMint, setOtherMint, mint, check, priceInput, setPriceInput, decimals,
    label: check.status === "ok" ? check.label : paymentMintLabel(mint, network),
    parsed,
    priceBase: parsed?.ok ? parsed.baseUnits : null,
  };
}

const INPUT = "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none";
const CAPTION = "text-xs font-medium uppercase tracking-wide text-slate-500";

/** The payment-token select; no free address entry on mainnet. */
export function PaymentMintPicker({ form }: { form: PaymentPriceForm }) {
  const options = paymentMintOptions(form.network);
  const other = allowsOtherPaymentMint(form.network);
  return (
    <label className="block">
      <span className={CAPTION}>Payment token</span>
      <select value={form.choice} onChange={(e) => form.setChoice(e.target.value)} className={`${INPUT} bg-white`}>
        {options.map((o) => (
          <option key={o.mint} value={o.mint}>
            {o.label} · {o.mint.slice(0, 4)}…{o.mint.slice(-4)}
          </option>
        ))}
        {other && <option value={OTHER}>Other token ({form.network} only)</option>}
      </select>
      {form.choice === OTHER && (
        <input
          value={form.otherMint}
          onChange={(e) => form.setOtherMint(e.target.value)}
          placeholder="Mint address (plain SPL or Token-2022, no transfer hook)"
          className={`${INPUT} font-mono text-xs`}
        />
      )}
      <PaymentMintStatus check={form.check} />
      {options.length === 0 && !other && (
        <span className="mt-1 block text-[11px] text-red-700" role="alert">
          No payment token is configured for this network.
        </span>
      )}
    </label>
  );
}

/** The total price, typed in the payment token's own units. */
export function PaymentPriceField({ form, caption = "Total price", note }: { form: PaymentPriceForm; caption?: string; note?: string | null }) {
  return (
    <label className="block">
      <span className={CAPTION}>
        {caption} ({form.check.status === "ok" ? form.label : "payment token"})
      </span>
      <input
        value={form.priceInput}
        inputMode="decimal"
        onChange={(e) => form.setPriceInput(e.target.value)}
        placeholder={form.decimals !== null ? `e.g. 1500${form.decimals > 0 ? ".50" : ""}` : "Choose the payment token first"}
        disabled={form.decimals === null}
        className={`${INPUT} disabled:bg-slate-50`}
      />
      {note && <span className="mt-1 block text-[11px] text-amber-700">{note}</span>}
      {form.parsed && !form.parsed.ok && (
        <span className="mt-1 block text-[11px] text-red-700" role="alert">{form.parsed.error}</span>
      )}
    </label>
  );
}

/** Units, total, price per unit and the exact base units — shown before signing. */
export function TradeConfirmation({ units, priceBase, decimals, label, role }: {
  units: bigint;
  priceBase: bigint;
  decimals: number;
  label: string;
  /** Whose view: the buyer pays the total, the seller receives it. */
  role: "buyer" | "seller";
}) {
  const summary = describeTrade(units, priceBase, decimals, label);
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" data-trade-confirmation>
      <dt className="text-slate-500">Units</dt>
      <dd className="font-medium text-slate-900">{summary.units}</dd>
      <dt className="text-slate-500">{role === "buyer" ? "You pay" : "You receive"}</dt>
      <dd className="font-semibold text-slate-900">{summary.total}</dd>
      <dt className="text-slate-500">Price per unit</dt>
      <dd className="text-slate-900">{summary.perUnit}</dd>
      <dt className="text-slate-500">On-chain</dt>
      <dd className="font-mono text-xs text-slate-500">{summary.base}</dd>
    </dl>
  );
}

/** Mint address the builders take, once the form has one. */
export function formMintAddress(form: PaymentPriceForm): Address | null {
  return form.check.status === "ok" ? form.check.mint : null;
}
