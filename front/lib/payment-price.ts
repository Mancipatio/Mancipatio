// Prices in human units (lansiranje-16). OTC offers, OTC deals and resell
// requests carry the price as integer BASE units of the payment mint (the
// program's u64); people think in USDC. Every form here takes the price as a
// decimal in the mint's own decimals, read from chain, converts it exactly
// (lib/vesting-amounts.ts parseTokenAmount: no float, no rounding), and
// shows it back as "12.5 USDC" before anything is signed. Base units stay
// internal: the payload, the builder and a small secondary line.
//
// The payment mint is picked from the network's allowed list, never typed:
// on mainnet that is the allowlist (lib/payment-mints.ts, USDC today). Off
// mainnet the network's test USDC is listed, and another plain mint can
// still be entered on purpose ("Other token"), for devnet rehearsals only.
// Pure and isomorphic; the server re-checks every mint (assertAllowedPaymentMint).
import type { Address } from "@solana/kit";
import { KNOWN_MINT_LAYOUT, MAINNET_PAYMENT_MINTS, USDC } from "@/lib/payment-mints";
import type { Network } from "@/lib/network";
import { formatTokenAmount, groupDigits, parseTokenAmount, type ParsedAmount } from "@/lib/vesting-amounts";

export type PaymentMintOption = { mint: Address; label: string };

/** The payment mints a form offers on `network`, in order. */
export function paymentMintOptions(network: Network): PaymentMintOption[] {
  if (network === "mainnet") {
    return Object.entries(MAINNET_PAYMENT_MINTS).map(([mint, { label }]) => ({ mint: mint as Address, label }));
  }
  const usdc = USDC[network];
  return usdc ? [{ mint: usdc.mint, label: usdc.label }] : [];
}

/** The currencies a resell listing may ask in off mainnet (a free label; the request is priced in the payment token). */
const RESELL_TEST_CURRENCIES = ["USDC", "USDT", "SOL", "EUR"] as const;

/**
 * The currencies a resell listing may ask in on `network`: on mainnet only
 * the allowed payment tokens (USDC today), so an ask is in the unit the
 * request and the escrow are priced in (lansiranje-16); elsewhere the test
 * labels as before. api/resell/create enforces the same list.
 */
export function resellAskCurrencies(network: Network): readonly string[] {
  if (network === "mainnet") return [...new Set(paymentMintOptions(network).map((o) => o.label))];
  return RESELL_TEST_CURRENCIES;
}

/**
 * The line a request form shows under its price for the listing's ask: the
 * ask, and, when the ask is not in a payment token of this network, that
 * the request is priced in the token picked below (no conversion is made).
 */
export function resellAskNote(askPrice: number | null, askCurrency: string, network: Network): string | null {
  if (askPrice === null) return null;
  const tokens = paymentMintOptions(network).map((o) => o.label);
  const inToken = tokens.includes(askCurrency) || tokens.some((label) => label.endsWith(` ${askCurrency}`));
  return inToken
    ? `Listing asks ${askPrice} ${askCurrency}.`
    : `Listing asks ${askPrice} ${askCurrency}, which is not the payment token: this request is priced in the token below, with no conversion.`;
}

/** Whether a form may take a mint that is not in the list (never on mainnet). */
export function allowsOtherPaymentMint(network: Network): boolean {
  return network !== "mainnet";
}

/** The price typed in the mint's units → exact base units (or the reason it is not a price). */
export function parsePaymentPrice(input: string, decimals: number | null): ParsedAmount {
  if (decimals === null) {
    return { ok: false, error: "The payment token is still loading — its decimals are read from chain." };
  }
  return parseTokenAmount(input, decimals);
}

/** "12.5 USDC" from base units. */
export function formatPaymentAmount(baseUnits: bigint, decimals: number, label: string): string {
  return `${formatTokenAmount(baseUnits, decimals)} ${label}`;
}

/**
 * The network's USDC for tables and cards, without a chain read: its layout
 * (SPL Token, 6 decimals: KNOWN_MINT_LAYOUT) is verified on chain at every
 * entry, so a listing can show it in USDC. Any other mint: null.
 */
export function knownPaymentToken(network: Network, mint: string): { decimals: number; label: string } | null {
  const usdc = USDC[network];
  return usdc && usdc.mint === mint ? { decimals: KNOWN_MINT_LAYOUT.decimals, label: usdc.label } : null;
}

/** A price for display: "12.5 USDC" for the network's USDC, else the exact base units. */
export function formatPaymentForDisplay(baseUnits: bigint, mint: string, network: Network): string {
  const known = knownPaymentToken(network, mint);
  return known ? formatPaymentAmount(baseUnits, known.decimals, known.label) : `${groupDigits(baseUnits)} base units`;
}

export type TradeSummary = {
  /** "10 units" */
  units: string;
  /** "12.5 USDC" */
  total: string;
  /** "1.25 USDC", prefixed "≈ " when the total does not divide exactly. */
  perUnit: string;
  /** "12 500 000 base units of the payment token" — the exact on-chain figure. */
  base: string;
};

/**
 * What a confirmation shows before a signature: the share units, the total
 * price and the price per unit in the payment token, and the exact base
 * units the transaction carries.
 */
export function describeTrade(units: bigint, priceBaseUnits: bigint, decimals: number, label: string): TradeSummary {
  if (units <= BigInt(0)) throw new Error("units must be positive");
  const per = priceBaseUnits / units;
  const exact = per * units === priceBaseUnits;
  return {
    units: `${groupDigits(units)} unit${units === BigInt(1) ? "" : "s"}`,
    total: formatPaymentAmount(priceBaseUnits, decimals, label),
    perUnit: `${exact ? "" : "≈ "}${formatPaymentAmount(per, decimals, label)}`,
    base: `${groupDigits(priceBaseUnits)} base units of the payment token`,
  };
}
