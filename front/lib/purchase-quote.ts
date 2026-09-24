import type { Network } from "@/lib/network";
import { paymentMintLabel } from "@/lib/payment-mints";
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
/** Labels only; a token symbol never determines payment authorization
 * (the addresses and labels live in lib/payment-mints). */
export function paymentTokenLabel(mint:string,network:Network) {
  return paymentMintLabel(mint,network);
}
