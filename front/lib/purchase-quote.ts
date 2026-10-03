import type { Network } from "@/lib/network";
import { paymentMintLabel } from "@/lib/payment-mints";
import { formatPercent, HUNDRED_PERCENT_E4 } from "@/lib/tokenize-shares";
const MAX_U64=BigInt("18446744073709551615");
/** Exact token-budget quote. No floating-point multiplication or rounding up. */
export function purchaseQuote(input:string,decimals:number,pricePerUnit:bigint) {
  if(!Number.isInteger(decimals) || decimals<0 || decimals>18 || pricePerUnit<=BigInt(0) || pricePerUnit>MAX_U64) return null;
  if(input.length>80 || !/^\d+(\.\d*)?$/.test(input)) return null;
  const [whole,fraction=""]=input.split(".");
  if(fraction.length>decimals) return null;
  const budget=BigInt(whole+fraction.padEnd(decimals,"0"));
  if(budget<=BigInt(0) || budget>MAX_U64)return null;
  const units=budget/pricePerUnit;
  return {budget,units,cost:units*pricePerUnit};
}

/**
 * The buyer types a number of TOKENS (share-class mints have 0 decimals):
 * the exact cost in payment base units (tokens × price), whether it is more
 * than the sale has left, and — with the tokenize figures (one token's
 * share in 1/10,000 %, lib/profile-public token_percent_e4) — the share of
 * the company those tokens are ("0.1"; "> 100" never shown as a figure).
 * null for anything but a whole number ≥ 1 (no separators, no decimals).
 */
export function tokenCountQuote(
  input: string,
  pricePerUnit: bigint,
  remaining: bigint,
  tokenPercentE4: bigint | null = null,
): { units: bigint; cost: bigint; overRemaining: boolean; percent: string | null } | null {
  const text = input.trim();
  if (!/^\d{1,19}$/.test(text) || pricePerUnit <= BigInt(0)) return null;
  const units = BigInt(text);
  if (units <= BigInt(0) || units > MAX_U64) return null;
  const cost = units * pricePerUnit;
  if (cost > MAX_U64) return null;
  let percent: string | null = null;
  if (tokenPercentE4 !== null && tokenPercentE4 > BigInt(0)) {
    const p4 = units * tokenPercentE4;
    percent = p4 > HUNDRED_PERCENT_E4 ? "> 100" : formatPercent(p4);
  }
  return { units, cost, overRemaining: units > remaining, percent };
}

/** Labels only; a token symbol never determines payment authorization
 * (the addresses and labels live in lib/payment-mints). */
export function paymentTokenLabel(mint:string,network:Network) {
  return paymentMintLabel(mint,network);
}
