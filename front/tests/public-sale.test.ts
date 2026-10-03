// Distribute → Public sale (lib/public-sale): the durations and the sale's
// end, the price in USDC base units and the maximum raise, the room, the
// request → approval prefill, the pre-clear check before 0x02 is cleared,
// and the order of "End and collect".
import { describe, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { CHAIN_CLOCK_MARGIN_SECONDS, MAX_SALE_DURATION_SECONDS, saleEndError } from "@/lib/deadline-bounds";
import { PAUSE_FLAGS_ALL, PAUSE_ISSUER_PROCEEDS, PAUSE_PRIMARY } from "@/lib/pause-flags";
import { roomToCreate, LIFETIME_COUNTER_VERSION, type SupplyFacts } from "@/lib/distribution-supply";
import {
  DEFAULT_SALE_DURATION_DAYS,
  PUBLIC_SALE_APPROVAL_DAYS,
  SALE_DURATION_DAYS,
  approvalPrefill,
  approvalUnits,
  closeFlowStep,
  docMatchesLegalHash,
  formatUsdc,
  isSaleDuration,
  maxGrossRaise,
  parseSaleRequest,
  paymentAmountLabel,
  preClearCheck,
  publicSaleReason,
  publicSaleStage,
  repauseMask,
  saleEndTs,
  saleReferencePriceE6,
  tokenizePricePerTokenE6,
  tokensToOffer,
  treasuryValueE6,
  usdcDecimalsOf,
  usdcToBaseUnits,
  type SaleRequest,
} from "@/lib/public-sale";

const n = (v: number | string) => BigInt(v);
const NOW = 1_790_000_000;
const DAY = 86_400;
const A = "Sa1e1111111111111111111111111111111111111111" as Address;
const B = "Sa1e2222222222222222222222222222222222222222" as Address;
const SC = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const request = (over: Partial<SaleRequest> = {}): SaleRequest => ({
  v: 1,
  id: "0f5e3c3a-2b6f-4c55-9f5d-1d2c3b4a5e6f",
  share_class: SC,
  price_per_unit: "2500000",
  payment_mint: USDC_MINT,
  tokens: "1000",
  duration_days: 30,
  document: { path: `whitepapers/X/devnet/${"ab".repeat(32)}/offer.pdf`, sha256: "ab".repeat(32), version_id: "v1", matches_legal_doc: true },
  status: "requested",
  requested_by: "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP",
  requested_at: "2026-10-03T10:00:00.000Z",
  ...over,
});

describe("durations and the sale's end", () => {
  it("offers 30, 90 and 365 days, 30 by default", () => {
    expect(SALE_DURATION_DAYS).toEqual([30, 90, 365]);
    expect(DEFAULT_SALE_DURATION_DAYS).toBe(30);
    expect([30, 90, 365].every(isSaleDuration)).toBe(true);
    expect([0, 31, 364, "30", null].some(isSaleDuration)).toBe(false);
  });

  it("ends now + the duration from the moment it opens", () => {
    expect(saleEndTs(30, NOW)).toBe(n(NOW + 30 * DAY));
    expect(saleEndTs(90, n(NOW))).toBe(n(NOW + 90 * DAY));
  });

  it("365 days is kept clear of the program's cap by the chain-clock margin, and open_sale accepts every choice", () => {
    const end = saleEndTs(365, NOW);
    expect(end).toBeLessThan(n(NOW + 365 * DAY));
    expect(end).toBe(n(NOW + MAX_SALE_DURATION_SECONDS - CHAIN_CLOCK_MARGIN_SECONDS - 60));
    for (const d of SALE_DURATION_DAYS) expect(saleEndError(n(0), saleEndTs(d, NOW), n(NOW))).toBeNull();
    // Unclamped, 365 days would be refused (SaleDurationInvalid).
    expect(saleEndError(n(0), n(NOW + 365 * DAY), n(NOW))).not.toBeNull();
  });
});

describe("price and amounts", () => {
  it("reads the price in USDC into base units (6 decimals), refusing 0 and more decimals", () => {
    expect(usdcToBaseUnits("2.5")).toBe(n(2_500_000));
    expect(usdcToBaseUnits("$10")).toBe(n(10_000_000));
    expect(usdcToBaseUnits("0.000001")).toBe(n(1));
    expect(usdcToBaseUnits("0")).toBeNull();
    expect(usdcToBaseUnits("1.0000001")).toBeNull();
    expect(usdcToBaseUnits("1,5")).toBeNull();
    expect(formatUsdc(n(1_234_500_000))).toBe("1,234.5");
    expect(formatUsdc(n(1))).toBe("0.000001");
  });

  it("max_gross = tokens × price; an approval's tokens = max_gross / min price", () => {
    expect(maxGrossRaise(n(1_000), n(2_500_000))).toBe(n(2_500_000_000));
    expect(approvalUnits({ maxGrossRaise: n(2_500_000_000), minPricePerUnit: n(2_500_000) })).toBe(n(1_000));
    expect(approvalUnits({ maxGrossRaise: n(10), minPricePerUnit: n(0) })).toBe(n(0));
  });

  it("the prefilled price is the tokenize price per token", () => {
    const tokenize = { percent_e4: "50000", granularity_percent: "0.001", tokens: "5000", price_total: "50000" };
    // $50,000 for 5,000 tokens = $10 per token = 10,000,000 USDC base units.
    expect(tokenizePricePerTokenE6(tokenize)).toBe(n(10_000_000));
    expect(tokenizePricePerTokenE6({ ...tokenize, price_total: "" })).toBeNull();
    expect(tokenizePricePerTokenE6(null)).toBeNull();
  });

  it("USDC amounts read in USDC, any other token in base units", () => {
    expect(usdcDecimalsOf(USDC_MINT, USDC_MINT)).toBe(6);
    expect(usdcDecimalsOf(SC, USDC_MINT)).toBeNull();
    expect(paymentAmountLabel(n(2_500_000), USDC_MINT, USDC_MINT)).toBe("2.5 USDC");
    expect(paymentAmountLabel(n(2_500_000), SC, USDC_MINT)).toBe("2500000 base units");
  });

  it("a treasury mint is never valued below the class's sale price (the ledger's floor)", () => {
    expect(treasuryValueE6(n(10_000_000), n(12_000_000))).toBe(n(12_000_000));
    expect(treasuryValueE6(n(10_000_000), null)).toBe(n(10_000_000));
    expect(treasuryValueE6(null, n(3))).toBe(n(3));
    const row = (created_at: string, min: string, decimals = 6) => ({ kind: "sale", created_at, min_price_per_unit: min, payment_decimals: decimals });
    expect(saleReferencePriceE6([row("2026-10-01T00:00:00Z", "1000000"), row("2026-10-02T00:00:00Z", "2500000")])).toBe(n(2_500_000));
    expect(saleReferencePriceE6([{ ...row("2026-10-02T00:00:00Z", "5"), kind: "treasury_mint" }])).toBeNull();
    // Another decimal count is scaled to 6, rounded up (a floor is never undershot).
    expect(saleReferencePriceE6([row("2026-10-02T00:00:00Z", "25", 1)])).toBe(n(2_500_000));
    expect(saleReferencePriceE6([row("2026-10-02T00:00:00Z", "2500001", 9)])).toBe(n(2_501));
  });
});

describe("room", () => {
  const facts = (over: Partial<SupplyFacts> = {}): SupplyFacts => ({
    maxSupply: n(5_000),
    lifetimeMinted: n(1_000),
    version: LIFETIME_COUNTER_VERSION,
    supplyLocked: false,
    mintablePostLaunch: false,
    openSaleRemaining: n(0),
    reservedUnminted: n(0),
    treasuryBalance: n(0),
    ...over,
  });

  it("offers the request's tokens, never past the approval or the room left", () => {
    expect(tokensToOffer({ requested: n(1_000), approvalMaxUnits: n(1_000), room: n(4_000) })).toBe(n(1_000));
    expect(tokensToOffer({ requested: n(1_000), approvalMaxUnits: n(800), room: n(4_000) })).toBe(n(800));
    expect(tokensToOffer({ requested: n(1_000), approvalMaxUnits: n(1_000), room: n(300) })).toBe(n(300));
    expect(tokensToOffer({ requested: n(1_000), approvalMaxUnits: n(1_000), room: null })).toBe(n(1_000));
    expect(tokensToOffer({ requested: n(1_000), approvalMaxUnits: n(1_000), room: n(0) })).toBe(n(0));
  });

  it("the room counts Open sales, reservations and other approvals; the approval being opened is not counted against itself", () => {
    // Another class's sale on its way (an approval not opened) holds its tokens.
    expect(roomToCreate(facts({ openSaleRemaining: n(500), reservedUnminted: n(100), approvedUnopened: n(1_000) }))).toBe(n(2_400));
    // Opening approval X: X's own units are not subtracted.
    expect(roomToCreate(facts({ approvedUnopened: n(0) }))).toBe(n(4_000));
    // After a conversion burn lifetime_minted never drops: no re-issue.
    expect(roomToCreate(facts({ lifetimeMinted: n(5_000) }))).toBe(n(0));
  });
});

describe("request → approval prefill", () => {
  it("parses a stored request and refuses anything half-formed", () => {
    expect(parseSaleRequest(request())).toEqual(request());
    expect(parseSaleRequest({ ...request(), duration_days: 60 })).toBeNull();
    expect(parseSaleRequest({ ...request(), tokens: "0" })).toBeNull();
    expect(parseSaleRequest({ ...request(), status: "approved" })).toBeNull();
    expect(parseSaleRequest({ ...request(), document: null })).toBeNull();
    expect(parseSaleRequest(null)).toBeNull();
  });

  it("fills the operator's modal: USDC, min = max = price, max = tokens × price, Mature 0/0, 30 days, the reason", () => {
    const prefill = approvalPrefill(request());
    expect(prefill).toEqual({
      shareClass: SC,
      paymentMint: USDC_MINT,
      maxGross: "2500",
      minPrice: "2.5",
      maxPrice: "2.5",
      raiseType: "mature",
      cliffMonths: 0,
      vestingMonths: 0,
      days: String(PUBLIC_SALE_APPROVAL_DAYS),
      reason: publicSaleReason(request()),
      requestId: request().id,
    });
    expect(PUBLIC_SALE_APPROVAL_DAYS).toBe(30);
    // The reason the reserve route requires (5–1000 characters) names the request.
    expect(prefill.reason).toBe("Public sale request 0f5e3c3a: 1,000 tokens at 2.5 USDC each, 30 days (Mature, purchases final)");
    expect(prefill.reason.length).toBeGreaterThanOrEqual(5);
    expect(prefill.reason.length).toBeLessThanOrEqual(1000);
  });

  it("a stage per class: an Open sale, then a live approval, then a request waiting", () => {
    expect(publicSaleStage({ request: null, liveApprovals: 0, openSales: 0 })).toBe("form");
    expect(publicSaleStage({ request: { status: "withdrawn" }, liveApprovals: 0, openSales: 0 })).toBe("form");
    expect(publicSaleStage({ request: { status: "requested" }, liveApprovals: 0, openSales: 0 })).toBe("requested");
    expect(publicSaleStage({ request: { status: "requested" }, liveApprovals: 1, openSales: 0 })).toBe("approved");
    expect(publicSaleStage({ request: null, liveApprovals: 1, openSales: 1 })).toBe("open");
  });

  it("the document is the token's own when its sha256 is the on-chain legal_doc_hash", () => {
    const hash = Uint8Array.from({ length: 32 }, (_, i) => i);
    const hex = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(docMatchesLegalHash(hex, hash)).toBe(true);
    expect(docMatchesLegalHash(hex.toUpperCase(), hash)).toBe(true);
    expect(docMatchesLegalHash("00".repeat(32), new Uint8Array(32))).toBe(false);
    expect(docMatchesLegalHash(hex.replace(/^00/, "ff"), hash)).toBe(false);
    expect(docMatchesLegalHash(hex, null)).toBe(false);
  });
});

describe("pre-clear check (before the super admin clears 0x02)", () => {
  const approval = (address: Address, expiresAt: number) => ({ address, shareClass: SC as Address, expiresAt: n(expiresAt) });

  it("clear: no other Open sale and no live approval but this one", () => {
    const r = preClearCheck({ openSales: [], approvals: [approval(A, NOW + DAY)], thisApproval: A, nowSec: NOW });
    expect(r).toMatchObject({ clear: true, problems: [], thisApprovalLive: true, otherOpenSales: [], strayApprovals: [] });
  });

  it("another issuer's Open sale blocks the clear (buys would resume in it)", () => {
    const r = preClearCheck({ openSales: [{ address: B, shareClass: "Other" }], approvals: [approval(A, NOW + DAY)], thisApproval: A, nowSec: NOW });
    expect(r.clear).toBe(false);
    expect(r.otherOpenSales).toHaveLength(1);
    expect(r.problems[0]).toMatch(/other sale is Open.*Freeze its issuer/);
  });

  it("a stray live approval blocks the clear; an expired one cannot be opened and does not", () => {
    const stray = preClearCheck({ openSales: [], approvals: [approval(A, NOW + DAY), approval(B, NOW + 60)], thisApproval: A, nowSec: NOW });
    expect(stray.clear).toBe(false);
    expect(stray.strayApprovals.map((a) => a.address)).toEqual([B]);
    expect(stray.problems.join(" ")).toMatch(/revoke it first/);
    const expired = preClearCheck({ openSales: [], approvals: [approval(A, NOW + DAY), approval(B, NOW - 1)], thisApproval: A, nowSec: NOW });
    expect(expired.clear).toBe(true);
  });

  it("this sale's approval must itself be live", () => {
    expect(preClearCheck({ openSales: [], approvals: [approval(A, NOW - 1)], thisApproval: A, nowSec: NOW })).toMatchObject({
      clear: false,
      thisApprovalLive: false,
    });
    expect(preClearCheck({ openSales: [], approvals: [], thisApproval: null, nowSec: NOW }).clear).toBe(false);
  });
});

describe("End and collect: order", () => {
  it("0x20 set → the super admin clears it first; then the issuer closes (re-pausing 0x20, and 0x02 with no other sale Open)", () => {
    const paused = PAUSE_FLAGS_ALL & ~PAUSE_PRIMARY; // the sale window: 0x02 clear, 0x20 set
    expect(closeFlowStep({ flags: paused, saleOpen: true, otherOpenSales: 0 })).toEqual({ step: "clear-proceeds" });
    const collecting = paused & ~PAUSE_ISSUER_PROCEEDS;
    expect(closeFlowStep({ flags: collecting, saleOpen: true, otherOpenSales: 0 })).toEqual({ step: "close", repause: PAUSE_ISSUER_PROCEEDS | PAUSE_PRIMARY });
    // Another sale still Open needs Primary issuance: only 0x20 again.
    expect(closeFlowStep({ flags: collecting, saleOpen: true, otherOpenSales: 1 })).toEqual({ step: "close", repause: PAUSE_ISSUER_PROCEEDS });
  });

  it("after the close: whatever is still clear is set again by any Admin, then done", () => {
    const collecting = PAUSE_FLAGS_ALL & ~PAUSE_PRIMARY & ~PAUSE_ISSUER_PROCEEDS;
    expect(closeFlowStep({ flags: collecting, saleOpen: false, otherOpenSales: 0 })).toEqual({ step: "repause", repause: 0x22 });
    expect(closeFlowStep({ flags: PAUSE_FLAGS_ALL, saleOpen: false, otherOpenSales: 0 })).toEqual({ step: "done" });
    expect(repauseMask(collecting, 2)).toBe(PAUSE_ISSUER_PROCEEDS);
    expect(repauseMask(PAUSE_FLAGS_ALL & ~PAUSE_PRIMARY, 0)).toBe(PAUSE_PRIMARY);
  });
});
