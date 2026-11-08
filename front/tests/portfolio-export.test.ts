// lib/portfolio-export.ts: the events of a holder's portfolio (chain
// movements given a price and a meaning by the platform's records), FIFO cost
// basis with partial lots, unknown costs and proceeds flagged, conversion
// burns as zero-proceeds disposals, exact USDC (6 decimals) and EUR
// arithmetic, and a CSV no spreadsheet can be tricked into running.
import { describe, expect, it } from "vitest";
import {
  EVENT_COLUMNS,
  EXPORT_DISCLAIMER,
  SUMMARY_COLUMNS,
  buildPortfolioExport,
  consumeFifo,
  csvCell,
  divRoundHalfUp,
  eurCentsOf,
  formatEurCents,
  formatMicroUsdc,
  parseEurRate,
  parsePortfolioExportRecords,
  portfolioExportCsv,
  portfolioExportFileName,
  type ChainHistory,
  type ChainMovement,
  type ExportConversionRecord,
  type ExportOtcRecord,
  type ExportPurchaseRecord,
  type PortfolioExportRecords,
  type ShareClassLabel,
} from "@/lib/portfolio-export";

const B = (n: number) => BigInt(n);
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const WALLET = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const MINT = "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx";
const MINT_B = "6D6TgUKrYY6dJrCUZ6LcJKt5EGGdCUgHtVeUKmRZbUJ2";
const VAULT = "Vau1t11111111111111111111111111111111111111";
const DEAL = "Dea1111111111111111111111111111111111111111";
const BUYER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const sig = (n: number) => `${String(n).padStart(2, "1")}${"5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6Ujk".slice(0, 86)}`;
const T0 = Date.parse("2026-10-01T10:00:00Z") / 1000;
const DAY = 86_400;
const labels = new Map<string, ShareClassLabel>([
  [MINT, { asset: "Mancipatio d.o.o. (MANCI-2026)", shareClass: "#0 Common" }],
  [MINT_B, { asset: "Other Co (OTHER-1)", shareClass: "#1 Preferred A" }],
]);

function purchase(n: number, units: number, usdc: number, over: Partial<ExportPurchaseRecord> = {}): ExportPurchaseRecord {
  return {
    id: `p-${n}`, created_at: new Date((T0 + n * DAY) * 1000).toISOString(), sale: "Sa1e111111111111111111111111111111111111111",
    share_class_pda: "C1ass11111111111111111111111111111111111111", mint: MINT, units: String(units),
    amount_atomic: String(Math.round(usdc * 1_000_000)), payment_mint: USDC_DEVNET, payment_decimals: 6, signature: sig(n), ...over,
  };
}
function otc(over: Partial<ExportOtcRecord>): ExportOtcRecord {
  return {
    id: "otc-deal-0001", created_at: new Date(T0 * 1000).toISOString(), updated_at: new Date((T0 + 9 * DAY) * 1000).toISOString(),
    share_class_pda: "C1ass11111111111111111111111111111111111111", mint: MINT, asset_label: "Mancipatio d.o.o. · #0 · MANCI-2026",
    side: "seller", amount: "15", price: "450000000", payment_mint: USDC_DEVNET, status: "completed", deal_pda: DEAL, ...over,
  };
}
function conversion(over: Partial<ExportConversionRecord>): ExportConversionRecord {
  return {
    id: "6f9619ff-8b86-4d11-b42d-00c04fc964ff", created_at: new Date(T0 * 1000).toISOString(),
    updated_at: new Date((T0 + 20 * DAY) * 1000).toISOString(), share_class_pda: "C1ass11111111111111111111111111111111111111",
    mint: MINT, asset_label: "Mancipatio d.o.o. · #0 · MANCI-2026", amount: "5", status: "converted", vault_pda: VAULT,
    deposit_tx: sig(70), outcome_tx: sig(71), ...over,
  };
}
function records(over: Partial<PortfolioExportRecords> = {}): PortfolioExportRecords {
  return {
    network: "devnet", wallet: WALLET, purchases: [], otc: [], conversions: [],
    fx: { payment_mint: USDC_DEVNET, rates: [], available: true }, truncated: false, ...over,
  };
}
function move(n: number, delta: number, over: Partial<ChainMovement> = {}): ChainMovement {
  return { signature: sig(n), blockTime: T0 + n * DAY, mint: MINT, delta: B(delta), owners: [], ...over };
}
function chain(movements: ChainMovement[], balances: Record<string, number> | null, extra: Record<string, number> = {}): ChainHistory {
  return {
    movements,
    blockTimes: new Map([...movements.map((m) => [m.signature, m.blockTime ?? 0] as const), ...Object.entries(extra)]),
    balances: balances ? new Map(Object.entries(balances).map(([k, v]) => [k, B(v)])) : null,
    complete: true,
    problem: null,
  };
}
const summaryOf = (data: ReturnType<typeof buildPortfolioExport>, mint = MINT) => data.summary.find((s) => s.mint === mint)!;

describe("money arithmetic", () => {
  it("formats micro-USDC with 6 decimals and EUR cents with 2, signs kept", () => {
    expect(formatMicroUsdc(B(1_234_500_000))).toBe("1234.500000");
    expect(formatMicroUsdc(B(5))).toBe("0.000005");
    expect(formatMicroUsdc(B(-12_500_000))).toBe("-12.500000");
    expect(formatMicroUsdc(B(0))).toBe("0.000000");
    expect(formatEurCents(B(106321))).toBe("1063.21");
    expect(formatEurCents(B(-5))).toBe("-0.05");
  });

  it("rounds half up", () => {
    expect(divRoundHalfUp(B(10_000_000), B(3))).toBe(B(3_333_333));
    expect(divRoundHalfUp(B(20_000_000), B(3))).toBe(B(6_666_667));
    expect(divRoundHalfUp(B(5), B(2))).toBe(B(3));
    expect(divRoundHalfUp(B(4), B(2))).toBe(B(2));
  });

  it("converts USDC to EUR at a 10-decimal rate, rounded half up to cents", () => {
    expect(parseEurRate("0.8612")).toBe(B(8_612_000_000));
    expect(parseEurRate("0.86123456789")).toBe(B(8_612_345_678));
    expect(parseEurRate("1")).toBe(B(10_000_000_000));
    for (const bad of ["", "abc", "-0.8", "0", "1e-3", "0.8.1"]) expect(parseEurRate(bad), bad).toBeNull();
    // 1234.567890 USDC × 0.8612 = 1063.2098668 EUR.
    expect(formatEurCents(eurCentsOf(B(1_234_567_890), parseEurRate("0.8612")!))).toBe("1063.21");
    // 0.005 EUR rounds up to a cent.
    expect(eurCentsOf(B(5_000), parseEurRate("1")!)).toBe(B(1));
    expect(eurCentsOf(B(4_999), parseEurRate("1")!)).toBe(B(0));
  });
});

describe("FIFO", () => {
  it("allocates a partly disposed lot's cost in proportion and never loses a micro-USDC to rounding", () => {
    const lots = [{ units: B(3), cost: B(10_000_000) as bigint | null }];
    const takes = [consumeFifo(lots, B(1)), consumeFifo(lots, B(1)), consumeFifo(lots, B(1))];
    expect(takes.map((t) => t.cost)).toEqual([B(3_333_333), B(3_333_334), B(3_333_333)]);
    expect(takes.reduce((sum, t) => sum + t.cost, B(0))).toBe(B(10_000_000));
    expect(lots).toEqual([]);
  });

  it("consumes the oldest lots first across a partial lot, and keeps the rest's cost", () => {
    const data = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 10, 100), purchase(2, 10, 300)], otc: [otc({})] }),
      chain: chain([move(1, 10), move(2, 10), move(3, -15, { owners: [DEAL] })], { [MINT]: 5 }),
      labels,
    });
    const sale = data.events.find((e) => e.type === "otc_sell")!;
    expect(sale.totalMicro).toBe(B(450_000_000));
    expect(sale.fifoCostMicro).toBe(B(250_000_000)); // 10 × 10 + 5 × 30
    expect(sale.resultMicro).toBe(B(200_000_000));
    const s = summaryOf(data);
    expect(s).toMatchObject({ unitsHeld: B(5), unitsKnownCost: B(5), costBasisMicro: B(150_000_000), averageCostMicro: B(30_000_000) });
    expect(s).toMatchObject({ unitsDisposed: B(15), proceedsMicro: B(450_000_000), disposedCostMicro: B(250_000_000), realizedMicro: B(200_000_000) });
    expect(s).toMatchObject({ walletBalance: B(5), escrowUnits: B(0), difference: B(0) });
    expect(s.flags).toEqual([]);
  });

  it("gives a transfer in an unknown cost, carried into a later disposal and the summary", () => {
    const data = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 5, 50)], otc: [otc({ amount: "7", price: "140000000" })] }),
      chain: chain([move(1, 5), move(2, 5), move(3, -7, { owners: [DEAL] })], { [MINT]: 3 }),
      labels,
    });
    expect(data.events.map((e) => e.type)).toEqual(["purchase", "transfer_in", "otc_sell"]);
    const transfer = data.events[1];
    expect(transfer.totalMicro).toBeNull();
    expect(transfer.notes.join(" ")).toMatch(/cost unknown/);
    const sale = data.events[2];
    expect(sale.fifoCostMicro).toBeNull();
    expect(sale.resultMicro).toBeNull();
    expect(sale.notes.join(" ")).toContain("Cost unknown for 2 of these units (received without a known price).");
    const s = summaryOf(data);
    expect(s).toMatchObject({ unitsHeld: B(3), unitsKnownCost: B(0), unitsUnknownCost: B(3), averageCostMicro: null, realizedMicro: null });
    expect(s.disposedCostMicro).toBe(B(50_000_000));
    expect(s.disposedCostUnknownUnits).toBe(B(2));
    expect(s.flags).toEqual(["Cost unknown for 3 units held", "FIFO cost unknown for 2 units disposed"]);
  });

  it("treats a conversion burn as a disposal at zero proceeds, the escrow legs as custody", () => {
    const data = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 10, 100)], conversions: [conversion({})] }),
      chain: chain(
        [move(1, 10), { ...move(70, -5), owners: [VAULT] }],
        { [MINT]: 5 },
        { [sig(71)]: T0 + 80 * DAY },
      ),
      labels,
    });
    expect(data.events.map((e) => [e.type, e.unitsIn, e.unitsOut])).toEqual([
      ["purchase", B(10), B(0)],
      ["escrow_deposit_conversion", B(0), B(5)],
      ["conversion_burn", B(0), B(5)],
    ]);
    const burn = data.events[2];
    expect(burn.atSec).toBe(T0 + 80 * DAY); // the outcome transaction's block time
    expect(burn.signature).toBe(sig(71));
    expect(burn.totalMicro).toBe(B(0));
    expect(burn.fifoCostMicro).toBe(B(50_000_000));
    expect(burn.resultMicro).toBe(B(-50_000_000));
    expect(burn.notes[0]).toMatch(/no proceeds on-chain; the registered shares replace these units/);
    const s = summaryOf(data);
    expect(s).toMatchObject({ unitsHeld: B(5), costBasisMicro: B(50_000_000), escrowUnits: B(0), difference: B(0) });
    expect(s.flags).toContain("Includes units burned on conversion (zero proceeds)");
  });

  it("keeps escrowed units held until the conversion ends, and a return changes nothing", () => {
    const deposited = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 10, 100)], conversions: [conversion({ status: "deposited", outcome_tx: null })] }),
      chain: chain([move(1, 10), move(70, -4)], { [MINT]: 6 }),
      labels,
    });
    expect(summaryOf(deposited)).toMatchObject({ unitsHeld: B(10), escrowUnits: B(4), difference: B(0) });
    const returned = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 10, 100)], conversions: [conversion({ status: "returned", outcome_tx: sig(71) })] }),
      chain: chain([move(1, 10), move(70, -4), move(71, 4)], { [MINT]: 10 }),
      labels,
    });
    expect(returned.events.map((e) => e.type)).toEqual(["purchase", "escrow_deposit_conversion", "escrow_return_conversion"]);
    expect(summaryOf(returned)).toMatchObject({ unitsHeld: B(10), escrowUnits: B(0), unitsDisposed: B(0), difference: B(0) });
  });

  it("flags a disposal larger than the acquisitions the history shows", () => {
    const data = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 2, 20)] }),
      chain: chain([move(1, 2), move(2, -5)], { [MINT]: 0 }),
      labels,
    });
    const out = data.events[1];
    expect(out.type).toBe("transfer_out");
    expect(out.notes.join(" ")).toContain("Cost unknown for 3 of these units (3 more than the history shows as acquired).");
    expect(summaryOf(data).unitsHeld).toBe(B(0));
  });
});

describe("classification", () => {
  it("prices a purchase from its record once, at the chain's time, and adds unexplained units as a transfer", () => {
    const data = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 10, 25)] }),
      chain: chain([move(1, 12)], { [MINT]: 12 }),
      labels,
    });
    expect(data.events.map((e) => [e.type, e.source, e.unitsIn])).toEqual([["purchase", "chain", B(10)], ["transfer_in", "chain", B(2)]]);
    expect(data.events[0].atSec).toBe(T0 + DAY);
    expect(data.events[0].totalMicro).toBe(B(25_000_000));
  });

  it("recognizes both sides of an OTC deal by the deal PDA, and escrow legs of a deal that did not complete", () => {
    const buyer = buildPortfolioExport({
      records: records({ otc: [otc({ side: "buyer" })] }),
      chain: chain([move(4, 15, { owners: [DEAL, BUYER] })], { [MINT]: 15 }),
      labels,
    });
    expect(buyer.events.map((e) => [e.type, e.totalMicro])).toEqual([["otc_buy", B(450_000_000)]]);
    const cancelled = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 15, 150)], otc: [otc({ status: "expired" })] }),
      chain: chain([move(1, 15), move(3, -15, { owners: [DEAL] }), move(5, 15, { owners: [DEAL] })], { [MINT]: 15 }),
      labels,
    });
    expect(cancelled.events.map((e) => e.type)).toEqual(["purchase", "escrow_deposit_otc", "escrow_refund_otc"]);
    expect(summaryOf(cancelled)).toMatchObject({ unitsHeld: B(15), escrowUnits: B(0), unitsDisposed: B(0) });
  });

  it("calls any other movement a transfer with an unknown price", () => {
    const data = buildPortfolioExport({ records: records(), chain: chain([move(1, 3), move(2, -1)], { [MINT]: 2 }), labels });
    expect(data.events.map((e) => [e.type, e.totalMicro])).toEqual([["transfer_in", null], ["transfer_out", null]]);
    expect(data.events[1].notes.join(" ")).toMatch(/proceeds unknown/);
    expect(summaryOf(data).flags).toContain("Proceeds unknown for 1 units disposed");
  });

  it("falls back to the records, dated by Manci and flagged, when the chain could not be read", () => {
    const data = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 10, 100)], otc: [otc({ amount: "4", price: "60000000" })], conversions: [conversion({ amount: "2" })] }),
      chain: null,
      labels,
    });
    expect(data.events.map((e) => [e.type, e.source])).toEqual([
      ["purchase", "record"], ["otc_sell", "record"], ["conversion_burn", "record"],
    ]);
    expect(data.events[0].atSec).toBe(Date.parse(purchase(1, 10, 100).created_at) / 1000);
    expect(data.events[0].notes.join(" ")).toMatch(/could not be read in full/);
    expect(data.events[1].notes.join(" ")).toMatch(/date recorded by Manci/);
    expect(data.events[1].signature).toBeNull();
    // The burn's deposit was never seen: the escrow stays at zero, never negative.
    expect(summaryOf(data)).toMatchObject({ unitsHeld: B(4), walletBalance: null, difference: null, escrowUnits: B(0) });
    expect(summaryOf(data).flags).toContain("Wallet balance not read");
    expect(data.notes[0]).toMatch(/could not be read: transfers outside Manci are missing/);
  });

  it("releases from an escrow only what was seen going in, and reports the unseen deposit as a difference", () => {
    const data = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 10, 100)], conversions: [conversion({ amount: "3", deposit_tx: null })] }),
      chain: chain([move(1, 10)], { [MINT]: 7 }),
      labels,
    });
    expect(data.events.map((e) => e.type)).toEqual(["purchase", "conversion_burn"]);
    expect(summaryOf(data)).toMatchObject({ unitsHeld: B(7), walletBalance: B(7), escrowUnits: B(0), difference: B(0) });
    const partly = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 10, 100)], conversions: [conversion({ amount: "3", status: "returned", deposit_tx: null, outcome_tx: sig(71) })] }),
      chain: chain([move(1, 10), move(71, 3)], { [MINT]: 10 }),
      labels,
    });
    // A return whose deposit the history lacks: the escrow stays at zero instead of going negative.
    expect(summaryOf(partly)).toMatchObject({ unitsHeld: B(10), escrowUnits: B(0), difference: B(0) });
  });

  it("recognizes a conversion escrow by its vault when no transaction is recorded on the request", () => {
    const data = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 10, 100)], conversions: [conversion({ status: "deposited", deposit_tx: null, outcome_tx: null })] }),
      chain: chain([move(1, 10), move(72, -4, { owners: [VAULT] })], { [MINT]: 6 }),
      labels,
    });
    expect(data.events.map((e) => e.type)).toEqual(["purchase", "escrow_deposit_conversion"]);
    expect(data.events[1].signature).toBe(sig(72));
    expect(summaryOf(data)).toMatchObject({ unitsHeld: B(10), escrowUnits: B(4), difference: B(0) });
  });

  it("counts a purchase whose sale has no mint on record once, only into units nothing else explains", () => {
    const resolved = purchase(1, 10, 100);
    const unresolved = purchase(1, 5, 50, { id: "p-unresolved", mint: null, share_class_pda: null });
    const data = buildPortfolioExport({
      records: records({ purchases: [resolved, unresolved] }),
      chain: chain([move(1, 10), move(1, 5, { mint: MINT_B })], { [MINT]: 10, [MINT_B]: 5 }),
      labels,
    });
    expect(data.events.map((e) => [e.type, e.mint, e.unitsIn])).toEqual([
      ["purchase", MINT, B(10)], ["purchase", MINT_B, B(5)],
    ]);
    expect(summaryOf(data, MINT)).toMatchObject({ unitsHeld: B(10), costBasisMicro: B(100_000_000), difference: B(0) });
    expect(summaryOf(data, MINT_B)).toMatchObject({ unitsHeld: B(5), costBasisMicro: B(50_000_000), difference: B(0) });
    // One that fits no movement is not booked anywhere, and the file says so.
    const misfit = buildPortfolioExport({
      records: records({ purchases: [resolved, { ...unresolved, units: "7" }] }),
      chain: chain([move(1, 10), move(1, 5, { mint: MINT_B })], { [MINT]: 10, [MINT_B]: 5 }),
      labels,
    });
    expect(misfit.events.map((e) => [e.type, e.mint])).toEqual([["purchase", MINT], ["transfer_in", MINT_B]]);
    expect(misfit.notes.join(" ")).toMatch(/1 recorded purchase\(s\) could not be matched to a share class/);
  });

  it("leaves a purchase in another token unpriced and says so", () => {
    const data = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 10, 100, { payment_mint: MINT_B })] }),
      chain: chain([move(1, 10)], { [MINT]: 10 }),
      labels,
    });
    expect(data.events[0].totalMicro).toBeNull();
    expect(data.events[0].notes.join(" ")).toMatch(/Paid in another token/);
    expect(summaryOf(data).flags).toContain("Some prices are in another token than USDC");
  });

  it("flags records that do not add up to the wallet's balance, and a balance with no history", () => {
    const data = buildPortfolioExport({
      records: records({ purchases: [purchase(1, 10, 100)] }),
      chain: { ...chain([move(1, 10)], { [MINT]: 7, [MINT_B]: 3 }), complete: false, problem: "only the newest 500 transactions were read" },
      labels,
    });
    expect(summaryOf(data).difference).toBe(B(3));
    expect(summaryOf(data).flags.join(" ")).toMatch(/differ from the wallet balance plus escrow by 3 units/);
    expect(summaryOf(data, MINT_B)).toMatchObject({ unitsHeld: B(0), walletBalance: B(3), difference: B(-3) });
    expect(data.notes).toContain("The on-chain history of this wallet is incomplete: only the newest 500 transactions were read.");
  });

  it("orders events oldest first and an acquisition before a disposal of the same instant", () => {
    const data = buildPortfolioExport({
      records: records(),
      chain: chain([move(2, -1, { signature: sig(9) }), move(2, 1, { signature: sig(8), mint: MINT_B }), move(1, 4)], { [MINT]: 3, [MINT_B]: 1 }),
      labels,
    });
    expect(data.events.map((e) => e.type)).toEqual(["transfer_in", "transfer_in", "transfer_out"]);
  });
});

describe("CSV", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("cr\rhere")).toBe('"cr\rhere"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(B(42))).toBe("42");
  });

  it("neutralizes formulas starting with = + - @ tab or CR, never a plain number", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("-1+2")).toBe("'-1+2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tcmd")).toBe("'\tcmd");
    expect(csvCell("\r=1")).toBe("\"'\r=1\"");
    expect(csvCell("=cmd|' /C calc'!A0, x")).toBe("\"'=cmd|' /C calc'!A0, x\"");
    expect(csvCell("-12.500000")).toBe("-12.500000");
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell("A-1")).toBe("A-1");
  });

  const data = () => buildPortfolioExport({
    records: records({ purchases: [purchase(1, 10, 1234.56789)] }),
    chain: chain([move(1, 10)], { [MINT]: 10 }),
    labels: new Map([[MINT, { asset: '=Evil, "Co"\nLtd', shareClass: "+#0" }]]),
  });

  it("writes the disclaimer first, both sections, CRLF and a BOM", () => {
    const csv = portfolioExportCsv(data(), {
      wallet: WALLET, network: "devnet", generatedAt: new Date("2026-11-08T12:00:00Z"),
      fx: [{ day: new Date((T0 + DAY) * 1000).toISOString().slice(0, 10), eur_per_token: "0.8612", source: "auto" }],
      labels: new Map([[MINT, { asset: '=Evil, "Co"\nLtd', shareClass: "+#0" }]]),
    });
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(csvCell(EXPORT_DISCLAIMER));
    expect(lines[0]).toMatch(/records for your own bookkeeping, not tax advice/);
    expect(lines).toContain(`Wallet,${WALLET}`);
    expect(lines).toContain("Generated (UTC),2026-11-08 12:00:00");
    expect(lines).toContain(EVENT_COLUMNS.map((c) => csvCell(c)).join(","));
    expect(lines).toContain(SUMMARY_COLUMNS.map((c) => csvCell(c)).join(","));
    expect(csv).toContain("\"'=Evil, \"\"Co\"\"\nLtd\",'+#0,Purchase (primary sale),acquisition,10,,123.456789,1234.567890,0.8612,1063.21,,,");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("leaves the EUR cells empty without a rate for the day", () => {
    const csv = portfolioExportCsv(data(), {
      wallet: WALLET, network: "devnet", generatedAt: new Date("2026-11-08T12:00:00Z"), fx: [], labels: new Map(),
    });
    expect(csv).toContain(",acquisition,10,,123.456789,1234.567890,,,,,");
  });

  it("names the file after the network, the wallet and the day", () => {
    expect(portfolioExportFileName("mainnet", WALLET, new Date("2026-11-08T23:59:00Z"))).toBe("manci-portfolio-mainnet-DAWS-2026-11-08.csv");
  });
});

describe("parsePortfolioExportRecords", () => {
  it("accepts the route's answer and refuses one malformed row", () => {
    const good = records({ purchases: [purchase(1, 10, 100)], otc: [otc({})], conversions: [conversion({})] });
    expect(parsePortfolioExportRecords(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(parsePortfolioExportRecords({ ...good, purchases: [{ ...purchase(1, 10, 100), units: 10 }] })).toBeNull();
    expect(parsePortfolioExportRecords({ ...good, otc: [{ ...otc({}), side: "both" }] })).toBeNull();
    expect(parsePortfolioExportRecords({ ...good, network: "prod" })).toBeNull();
    expect(parsePortfolioExportRecords({ ...good, fx: { rates: [], available: true } })).toBeNull();
    expect(parsePortfolioExportRecords(null)).toBeNull();
  });
});
