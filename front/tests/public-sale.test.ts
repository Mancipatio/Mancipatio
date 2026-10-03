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
  freezeUnreadWarning,
  isSaleDuration,
  maxGrossRaise,
  mintRepausesPrimary,
  parseSaleRequest,
  paymentAmountLabel,
  preClearCheck,
  primaryCloseRefusal,
  publicSaleReason,
  publicSaleStage,
  repauseMask,
  repausePlan,
  saleEndTs,
  saleReferencePriceE6,
  tokenizePricePerTokenE6,
  tokensToOffer,
  treasuryValueE6,
  usdcDecimalsOf,
  usdcToBaseUnits,
  type SaleRequest,
} from "@/lib/public-sale";
import { freezeUnread, isLiveSale, liveSales, saleBuyState } from "@/lib/sale-liveness";

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

describe("whether an Open sale can still take a buy (lib/sale-liveness, buy.rs)", () => {
  const sale = (over: Partial<{ endTs: bigint; sold: bigint; totalForSale: bigint }> = {}) => ({
    endTs: n(NOW + DAY),
    sold: n(10),
    totalForSale: n(100),
    ...over,
  });

  it("live until its end (judged a chain-clock margin late), while tokens are left and the issuer is not frozen", () => {
    expect(saleBuyState(sale(), NOW)).toBe("live");
    // No end (legacy devnet sales): live.
    expect(saleBuyState(sale({ endTs: n(0) }), NOW)).toBe("live");
    // Just past its end on our clock: the chain's may lag, so still live within the margin.
    expect(saleBuyState(sale({ endTs: n(NOW - 60) }), NOW)).toBe("live");
    expect(saleBuyState(sale({ endTs: n(NOW - CHAIN_CLOCK_MARGIN_SECONDS - 1) }), NOW)).toBe("ended");
    expect(saleBuyState(sale({ sold: n(100) }), NOW)).toBe("sold-out");
    expect(saleBuyState(sale(), NOW, true)).toBe("frozen");
    expect(saleBuyState(sale(), NOW, null)).toBe("live");
    // Ended and sold out are final; they win over a freeze.
    expect(saleBuyState(sale({ endTs: n(NOW - DAY) }), NOW, true)).toBe("ended");
  });

  it("liveSales: a frozen issuer's sale never counts; an unread freeze counts by the rule's side of safety", () => {
    const sales = [
      { ...sale(), frozen: false },
      { ...sale({ sold: n(100) }), frozen: false },
      { ...sale({ endTs: n(NOW - DAY) }), frozen: false },
      { ...sale(), frozen: true },
      { ...sale(), frozen: null },
      // Ended and unread: idle either way.
      { ...sale({ endTs: n(NOW - DAY) }), frozen: null },
    ];
    // The pre-clear check never passes on an unknown: the unread one counts as live.
    expect(liveSales(sales, NOW, "pre-clear")).toEqual([sales[0], sales[4]]);
    // A re-pause offer is never hidden by an unknown: the unread one does not count.
    expect(liveSales(sales, NOW, "re-pause")).toEqual([sales[0]]);
    expect(isLiveSale(sales[3], NOW, "pre-clear")).toBe(false);
    expect(isLiveSale(sales[3], NOW, "re-pause")).toBe(false);
    // The unread ones that would otherwise take a buy (said next to a re-pause offer).
    expect(freezeUnread(sales, NOW)).toEqual([sales[4]]);
  });
});

describe("pre-clear check (before the super admin clears 0x02)", () => {
  const approval = (address: Address, expiresAt: number) => ({ address, shareClass: SC as Address, expiresAt: n(expiresAt) });
  const open = (over: Partial<{ endTs: bigint; sold: bigint; totalForSale: bigint; frozen: boolean | null }> = {}) => ({
    address: B,
    shareClass: "Other",
    endTs: n(NOW + 30 * DAY),
    sold: n(10),
    totalForSale: n(100),
    frozen: false as boolean | null,
    ...over,
  });

  it("clear: no other Open sale and no live approval but this one", () => {
    const r = preClearCheck({ openSales: [], approvals: [approval(A, NOW + DAY)], thisApproval: A, nowSec: NOW });
    expect(r).toMatchObject({ clear: true, problems: [], thisApprovalLive: true, otherOpenSales: [], idleOpenSales: [], strayApprovals: [] });
  });

  it("another issuer's Open sale that can still take a buy blocks the clear (buys would resume in it)", () => {
    const r = preClearCheck({ openSales: [open()], approvals: [approval(A, NOW + DAY)], thisApproval: A, nowSec: NOW });
    expect(r.clear).toBe(false);
    expect(r.otherOpenSales).toHaveLength(1);
    expect(r.problems[0]).toMatch(/other sale is Open and can still take buys.*Freeze its issuer/);
    // A freeze that could not be read does not count as one.
    expect(preClearCheck({ openSales: [open({ frozen: null })], approvals: [approval(A, NOW + DAY)], thisApproval: A, nowSec: NOW }).clear).toBe(false);
  });

  it("freezing the other issuer clears the way: a frozen issuer's sale takes no buy (IssuerProceedsFrozen)", () => {
    const r = preClearCheck({ openSales: [open({ frozen: true })], approvals: [approval(A, NOW + DAY)], thisApproval: A, nowSec: NOW });
    expect(r).toMatchObject({ clear: true, otherOpenSales: [], idleOpenSales: [{ address: B, state: "frozen" }] });
  });

  it("an Open sale that ended or sold out (not closed yet) is listed but does not block", () => {
    const ended = preClearCheck({ openSales: [open({ endTs: n(NOW - DAY) })], approvals: [approval(A, NOW + DAY)], thisApproval: A, nowSec: NOW });
    expect(ended).toMatchObject({ clear: true, idleOpenSales: [{ address: B, state: "ended" }] });
    const soldOut = preClearCheck({ openSales: [open({ sold: n(100) })], approvals: [approval(A, NOW + DAY)], thisApproval: A, nowSec: NOW });
    expect(soldOut).toMatchObject({ clear: true, idleOpenSales: [{ address: B, state: "sold-out" }] });
    // Ended only by our clock, inside the chain-clock margin: it may still take a buy.
    const edge = preClearCheck({ openSales: [open({ endTs: n(NOW - 60) })], approvals: [approval(A, NOW + DAY)], thisApproval: A, nowSec: NOW });
    expect(edge.clear).toBe(false);
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
  type Other = { endTs: bigint; sold: bigint; totalForSale: bigint; frozen: boolean | null };
  const other = (over: Partial<Other> = {}): Other => ({ endTs: n(NOW + DAY), sold: n(10), totalForSale: n(100), frozen: false, ...over });
  const step = (flags: number, saleOpen: boolean, otherSales: Other[] = []) => closeFlowStep({ flags, saleOpen, otherSales, nowSec: NOW });

  it("0x20 set → the super admin clears it first; then the issuer closes (re-pausing 0x20, and 0x02 with no other sale Open)", () => {
    const paused = PAUSE_FLAGS_ALL & ~PAUSE_PRIMARY; // the sale window: 0x02 clear, 0x20 set
    expect(step(paused, true)).toEqual({ step: "clear-proceeds" });
    const collecting = paused & ~PAUSE_ISSUER_PROCEEDS;
    expect(step(collecting, true)).toEqual({ step: "close", repause: PAUSE_ISSUER_PROCEEDS | PAUSE_PRIMARY });
    // Another sale that can still take a buy needs Primary issuance: only 0x20 again.
    expect(step(collecting, true, [other()])).toEqual({ step: "close", repause: PAUSE_ISSUER_PROCEEDS });
    // Another that ended or sold out does not.
    expect(step(collecting, true, [other({ endTs: n(NOW - DAY) }), other({ sold: n(100) })])).toEqual({ step: "close", repause: 0x22 });
  });

  it("a frozen issuer's Open sale takes no buy: closing sale A sets 0x02 again in the same transaction", () => {
    // The super admin froze issuer B to reopen 0x02 for A; A now ends while B's sale is still marked Open.
    const collecting = PAUSE_FLAGS_ALL & ~PAUSE_PRIMARY & ~PAUSE_ISSUER_PROCEEDS;
    expect(step(collecting, true, [other({ frozen: true })])).toEqual({ step: "close", repause: PAUSE_ISSUER_PROCEEDS | PAUSE_PRIMARY });
    expect(step(collecting, false, [other({ frozen: true })])).toEqual({ step: "repause", repause: 0x22 });
    // A freeze that could not be read never keeps 0x02 open (closing it is always safe).
    expect(step(collecting, true, [other({ frozen: null })])).toEqual({ step: "close", repause: PAUSE_ISSUER_PROCEEDS | PAUSE_PRIMARY });
    // A live sale beside the frozen one still needs it.
    expect(step(collecting, true, [other({ frozen: true }), other()])).toEqual({ step: "close", repause: PAUSE_ISSUER_PROCEEDS });
  });

  it("after the close: whatever is still clear is set again by any Admin, then done", () => {
    const collecting = PAUSE_FLAGS_ALL & ~PAUSE_PRIMARY & ~PAUSE_ISSUER_PROCEEDS;
    expect(step(collecting, false)).toEqual({ step: "repause", repause: 0x22 });
    expect(step(PAUSE_FLAGS_ALL, false)).toEqual({ step: "done" });
    expect(repauseMask(collecting, 2)).toBe(PAUSE_ISSUER_PROCEEDS);
    expect(repauseMask(PAUSE_FLAGS_ALL & ~PAUSE_PRIMARY, 0)).toBe(PAUSE_PRIMARY);
  });

  it("/admin/launchpad: 0x02 again once no Open sale can take a buy, live approvals or not; 0x20 only once none is Open", () => {
    const collecting = PAUSE_FLAGS_ALL & ~PAUSE_PRIMARY & ~PAUSE_ISSUER_PROCEEDS;
    const plan = (flags: number, sales: Other[], liveApprovals: number) => repausePlan({ flags, sales, nowSec: NOW, liveApprovals });
    // Nothing Open: both bits, and no warning without approvals.
    expect(plan(collecting, [], 0)).toEqual({ mask: 0x22, warning: null });
    // Live approvals waiting: 0x02 is still offered (the super admin reopens it after the pre-clear check), with a warning.
    const waiting = plan(collecting, [], 2);
    expect(waiting.mask).toBe(0x22);
    expect(waiting.warning).toMatch(/2 live approvals wait to be opened.*pre-clear check/);
    expect(plan(PAUSE_FLAGS_ALL & ~PAUSE_PRIMARY, [], 1).mask).toBe(PAUSE_PRIMARY);
    // Only Open sales that ended or sold out: 0x02 (they take no buy), but 0x20 stays clear for their close.
    expect(plan(collecting, [other({ endTs: n(NOW - DAY) })], 1).mask).toBe(PAUSE_PRIMARY);
    // A sale that can still take a buy needs both open.
    expect(plan(collecting, [other(), other({ sold: n(100) })], 0)).toEqual({ mask: 0, warning: null });
    // Nothing clear: nothing to set, no warning.
    expect(plan(PAUSE_FLAGS_ALL, [], 3)).toEqual({ mask: 0, warning: null });
  });

  it("/admin/launchpad with a frozen issuer: its Open sale never hides the 0x02 offer (0x20 stays clear for its close)", () => {
    const collecting = PAUSE_FLAGS_ALL & ~PAUSE_PRIMARY & ~PAUSE_ISSUER_PROCEEDS;
    const plan = (sales: Other[], liveApprovals = 0) => repausePlan({ flags: collecting, sales, nowSec: NOW, liveApprovals });
    // Sale A closed, issuer B frozen with its sale still Open: 0x02 is offered.
    expect(plan([other({ frozen: true })])).toEqual({ mask: PAUSE_PRIMARY, warning: null });
    // An unread freeze does not hide the offer either; the warning says so.
    const unread = plan([other({ frozen: null })], 1);
    expect(unread.mask).toBe(PAUSE_PRIMARY);
    expect(unread.warning).toMatch(/1 live approval waits.*The freeze of the issuer of 1 Open sale could not be read: it may still take buys/);
    expect(plan([other({ frozen: null }), other({ frozen: null })]).warning).toMatch(/^The freeze of the issuers of 2 Open sales could not be read/);
    // A live sale beside the frozen one keeps both bits clear.
    expect(plan([other({ frozen: true }), other()])).toEqual({ mask: 0, warning: null });
    expect(freezeUnreadWarning(0)).toBeNull();
  });

  it("the re-pause guard (/admin/launchpad and the pre-clear panel's Close again), read right before signing", () => {
    expect(primaryCloseRefusal([], NOW)).toBeNull();
    expect(primaryCloseRefusal([other()], NOW)).toMatch(/^1 Open sale can still take buys and needs Primary issuance/);
    expect(primaryCloseRefusal([other(), other()], NOW)).toMatch(/^2 Open sales can still take buys and need/);
    // Frozen, ended, sold out or unread: nothing refuses closing 0x02.
    expect(primaryCloseRefusal([other({ frozen: true }), other({ endTs: n(NOW - DAY) }), other({ sold: n(100) }), other({ frozen: null })], NOW)).toBeNull();
  });

  it("Send to wallets: the treasury mint closes 0x02 again unless a sale can take a buy or the class has an approval waiting", () => {
    const repause = (sales: Other[], classLiveApprovals = 0) => mintRepausesPrimary({ sales, nowSec: NOW, classLiveApprovals });
    expect(repause([])).toBe(true);
    expect(repause([other()])).toBe(false);
    // A frozen issuer's Open sale takes no buy; an unread freeze never keeps 0x02 open.
    expect(repause([other({ frozen: true })])).toBe(true);
    expect(repause([other({ frozen: null })])).toBe(true);
    // "Both": this class's approved sale opens after the sends.
    expect(repause([other({ frozen: true })], 1)).toBe(false);
  });
});
