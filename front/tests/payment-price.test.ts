// lansiranje-16: OTC and resell prices are typed and shown in the payment
// token's own units, never as raw base units; the payment token is picked
// from the network's allowed list (mainnet: USDC only, no free address).
import { describe, expect, it } from "vitest";
import { USDC } from "@/lib/payment-mints";
import {
  allowsOtherPaymentMint,
  describeTrade,
  formatPaymentForDisplay,
  knownPaymentToken,
  parsePaymentPrice,
  paymentMintOptions,
} from "@/lib/payment-price";

describe("the payment token comes from the allowed list", () => {
  it("mainnet offers USDC only and never a free address", () => {
    expect(paymentMintOptions("mainnet")).toEqual([{ mint: USDC.mainnet!.mint, label: "USDC" }]);
    expect(allowsOtherPaymentMint("mainnet")).toBe(false);
  });

  it("devnet lists its test USDC; other networks may name a token on purpose", () => {
    expect(paymentMintOptions("devnet")).toEqual([{ mint: USDC.devnet!.mint, label: "test USDC" }]);
    expect(paymentMintOptions("testnet")).toEqual([]);
    expect(allowsOtherPaymentMint("devnet")).toBe(true);
    expect(allowsOtherPaymentMint("localnet")).toBe(true);
  });
});

describe("prices in human units", () => {
  it("'1500' is 1 500 USDC, not 1 500 base units (the 10^6 mistake)", () => {
    expect(parsePaymentPrice("1500", 6)).toEqual({ ok: true, baseUnits: BigInt(1_500_000_000) });
    expect(parsePaymentPrice("0.0015", 6)).toEqual({ ok: true, baseUnits: BigInt(1500) });
    expect(parsePaymentPrice("12.50", 6)).toEqual({ ok: true, baseUnits: BigInt(12_500_000) });
  });

  it("refuses what cannot be represented exactly, and waits for the decimals", () => {
    expect(parsePaymentPrice("1.0000001", 6).ok).toBe(false);
    expect(parsePaymentPrice("1,5", 6).ok).toBe(false);
    expect(parsePaymentPrice("0", 6).ok).toBe(false);
    expect(parsePaymentPrice("-1", 6).ok).toBe(false);
    const pending = parsePaymentPrice("10", null);
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect(pending.error).toMatch(/decimals are read from chain/);
  });

  it("the confirmation shows units, total, price per unit and the exact base units", () => {
    expect(describeTrade(BigInt(10), BigInt(12_500_000), 6, "USDC")).toEqual({
      units: "10 units",
      total: "12.5 USDC",
      perUnit: "1.25 USDC",
      base: "12 500 000 base units of the payment token",
    });
    // A total that does not divide by the units says so.
    expect(describeTrade(BigInt(3), BigInt(10_000_000), 6, "USDC").perUnit).toBe("≈ 3.333333 USDC");
    expect(describeTrade(BigInt(1), BigInt(1), 6, "USDC")).toMatchObject({ units: "1 unit", total: "0.000001 USDC" });
    expect(() => describeTrade(BigInt(0), BigInt(1), 6, "USDC")).toThrow();
  });

  it("tables show the network's USDC in USDC and any other mint in exact base units", () => {
    expect(knownPaymentToken("mainnet", USDC.mainnet!.mint)).toEqual({ decimals: 6, label: "USDC" });
    expect(formatPaymentForDisplay(BigInt(1_500_000), USDC.mainnet!.mint, "mainnet")).toBe("1.5 USDC");
    expect(formatPaymentForDisplay(BigInt(1_500_000), USDC.devnet!.mint, "devnet")).toBe("1.5 test USDC");
    expect(formatPaymentForDisplay(BigInt(1_500_000), "So11111111111111111111111111111111111111112", "devnet")).toBe("1 500 000 base units");
    // Mainnet's USDC is not devnet's.
    expect(knownPaymentToken("devnet", USDC.mainnet!.mint)).toBeNull();
  });
});
