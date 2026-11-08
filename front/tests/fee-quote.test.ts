// The fee quote (lib/fees/quote.ts), the fee model (lib/fees/schedule.ts)
// and the admin input narrowing (lib/fees/validate.ts) of migration 0089.
// quoteFee prices every charge and describeFee writes the public sentence,
// so every branch of both is pinned here, with exact cents.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  centsToDecimal,
  describeFee,
  eurToCents,
  formatEur,
  formatEurCents,
  formatFeeDate,
  formatRateBps,
  lowerFirst,
  MAX_CHARGE_CENTS,
  quoteFee,
} from "@/lib/fees/quote";
import {
  FEE_KINDS,
  FEE_KIND_REF_TYPES,
  SUGGESTED_FEE_DRAFTS,
  feeServiceOffered,
  orderPublicFees,
  parsePublicFee,
  type FeeKind,
  type FeeTerms,
  type PublicFee,
} from "@/lib/fees/schedule";
import {
  FeeValidationError,
  parseEurAmount,
  parseFeeChargeCreate,
  parseFeeChargeUpdate,
  parseFeeDraft,
  parseFeeDraftSave,
  parseFeeRevision,
} from "@/lib/fees/validate";
import { KYC_ONLY_ENV, PILOT_MODULE_ENV } from "@/lib/features";

const terms = (extra: Partial<FeeTerms> = {}): FeeTerms => ({
  kind: "conversion", fixed_eur: 0, rate_bps: 0, min_eur: null, max_eur: null, ...extra,
});
const conversion = terms({ rate_bps: 100, min_eur: 150 });
const UUID = "00000000-0000-4000-8000-000000000001";
const ADDRESS = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";
const REVISION = "2026-11-08T10:00:00.123456+00:00";

afterEach(() => vi.unstubAllEnvs());

describe("quoteFee", () => {
  it("applies the formula when it is above the minimum (1 % of EUR 50,000 = EUR 500)", () => {
    expect(quoteFee(conversion, 50_000)).toEqual({ cents: 50_000, eur: 500, basis: "formula", formulaCents: 50_000 });
  });

  it("applies the minimum when the formula is below it (1 % of EUR 10,000 = EUR 100 < EUR 150)", () => {
    expect(quoteFee(conversion, 10_000)).toEqual({ cents: 15_000, eur: 150, basis: "minimum", formulaCents: 10_000 });
    // A zero base still pays the minimum.
    expect(quoteFee(conversion, 0)).toMatchObject({ cents: 15_000, basis: "minimum", formulaCents: 0 });
    // Exactly at the minimum: the formula itself.
    expect(quoteFee(conversion, 15_000)).toMatchObject({ cents: 15_000, basis: "formula" });
  });

  it("caps at the maximum", () => {
    const capped = terms({ rate_bps: 100, min_eur: 150, max_eur: 1_000 });
    expect(quoteFee(capped, 250_000)).toEqual({ cents: 100_000, eur: 1_000, basis: "maximum", formulaCents: 250_000 });
    expect(quoteFee(capped, 100_000)).toMatchObject({ cents: 100_000, basis: "formula" });
  });

  it("adds a fixed part to the rate part", () => {
    expect(quoteFee(terms({ fixed_eur: 500, rate_bps: 250 }), "1000.00")).toMatchObject({ cents: 52_500, basis: "formula" });
    expect(quoteFee(terms({ kind: "tokenization_setup", fixed_eur: 2_500 }), 0)).toMatchObject({ cents: 250_000, eur: 2_500 });
  });

  it("rounds the rate part half up to the cent, once", () => {
    // 1 % of EUR 0.50 = 0.5 cent -> 1 cent; of EUR 0.49 = 0.49 cent -> 0.
    expect(quoteFee(terms({ rate_bps: 100 }), "0.50").cents).toBe(1);
    expect(quoteFee(terms({ rate_bps: 100 }), "0.49").cents).toBe(0);
    // 0.33 % of EUR 1,234.56 = 407.4048 cents -> 407.
    expect(quoteFee(terms({ rate_bps: 33 }), "1234.56").cents).toBe(407);
    // 1.25 % of EUR 0.02 = 0.025 cent -> 0; of EUR 0.04 = 0.05 -> 0; of EUR 40 = 50 cents.
    expect(quoteFee(terms({ rate_bps: 125 }), "0.04").cents).toBe(0);
    expect(quoteFee(terms({ rate_bps: 125 }), "40").cents).toBe(50);
  });

  it("stays exact on the largest base a charge can record (numeric(14,2))", () => {
    // 99,999,999,999,999 cents x 3 bps = 29,999,999,999.9997 cents -> 30,000,000,000 (EUR 300,000,000).
    expect(quoteFee(terms({ rate_bps: 3 }), "999999999999.99")).toMatchObject({ cents: 30_000_000_000, eur: 300_000_000 });
    // x 1 bps = 9,999,999,999.9999 cents -> 10,000,000,000.
    expect(quoteFee(terms({ rate_bps: 1 }), "999999999999.99").cents).toBe(10_000_000_000);
  });

  it("refuses an amount larger than a charge can record", () => {
    expect(MAX_CHARGE_CENTS).toBe(BigInt("999999999999"));
    expect(() => quoteFee(terms({ kind: "migration_per_holder", fixed_eur: "9999999999.99" }), 0, 2)).toThrow(/largest amount/);
    // ...unless the maximum caps it below.
    expect(quoteFee(terms({ kind: "migration_per_holder", fixed_eur: "9999999.99", max_eur: 100 }), 0, 1_000_000)).toMatchObject({ cents: 10_000, basis: "maximum" });
  });

  it("multiplies the fixed part by the quantity of a per-unit fee only", () => {
    const perHolder = terms({ kind: "migration_per_holder", fixed_eur: 2 });
    expect(quoteFee(perHolder, 0, 180)).toMatchObject({ cents: 36_000, eur: 360, basis: "formula" });
    expect(quoteFee(terms({ kind: "migration_per_holder", fixed_eur: 2, min_eur: 500 }), 0, 180)).toMatchObject({ cents: 50_000, basis: "minimum" });
    expect(() => quoteFee(conversion, 1_000, 2)).toThrow(/per-unit/);
    expect(() => quoteFee(perHolder, 0, 0)).toThrow(/positive integer/);
    expect(() => quoteFee(perHolder, 0, 1.5)).toThrow(/positive integer/);
  });

  it("refuses malformed terms and inputs instead of rounding them", () => {
    expect(() => quoteFee(terms({ rate_bps: 10_001 }), 1)).toThrow(/rate_bps/);
    expect(() => quoteFee(terms({ rate_bps: 1.5 }), 1)).toThrow(/rate_bps/);
    expect(() => quoteFee(terms({ rate_bps: -1 }), 1)).toThrow(/rate_bps/);
    expect(() => quoteFee(terms({ min_eur: 200, max_eur: 100 }), 1)).toThrow(/minimum exceeds the maximum/);
    expect(() => quoteFee(conversion, 10.005)).toThrow(/two decimals/);
    expect(() => quoteFee(conversion, "10.005")).toThrow(/Not a EUR amount/);
    expect(() => quoteFee(conversion, -1)).toThrow(/Not a EUR amount/);
    expect(() => quoteFee(conversion, Number.NaN)).toThrow(/Not a EUR amount/);
    expect(() => quoteFee(conversion, "1e3")).toThrow(/Not a EUR amount/);
    expect(() => quoteFee(terms({ fixed_eur: "abc" }), 0)).toThrow(/Not a EUR amount/);
  });
});

describe("amount helpers", () => {
  it("converts euros to exact cents and back", () => {
    expect(eurToCents("150")).toBe(BigInt(15_000));
    expect(eurToCents(" 150.5 ")).toBe(BigInt(15_050));
    expect(eurToCents(0.1)).toBe(BigInt(10));
    expect(eurToCents(2_500)).toBe(BigInt(250_000));
    expect(() => eurToCents(0.1 + 0.2)).toThrow(/two decimals/);
    expect(centsToDecimal(15_050)).toBe("150.50");
    expect(centsToDecimal(BigInt(7))).toBe("0.07");
    expect(() => centsToDecimal(-1)).toThrow(/never negative/);
  });

  it("formats EUR without cents when there are none, locale-independently", () => {
    expect(formatEurCents(250_000)).toBe("EUR 2,500");
    expect(formatEurCents(250_050)).toBe("EUR 2,500.50");
    expect(formatEurCents(5)).toBe("EUR 0.05");
    expect(formatEur(1_000_000)).toBe("EUR 1,000,000");
    expect(formatEur("150.5")).toBe("EUR 150.50");
  });

  it("formats rates in the price list's style", () => {
    expect(formatRateBps(100)).toBe("1 %");
    expect(formatRateBps(150)).toBe("1.5 %");
    expect(formatRateBps(25)).toBe("0.25 %");
    expect(formatRateBps(5)).toBe("0.05 %");
    expect(formatRateBps(1_000)).toBe("10 %");
    expect(formatRateBps(10_000)).toBe("100 %");
    expect(formatRateBps(0)).toBe("0 %");
    expect(() => formatRateBps(10_001)).toThrow();
  });

  it("formats effective dates in UTC and continues sentences", () => {
    expect(formatFeeDate("2026-12-01T00:00:00Z")).toBe("1 December 2026");
    expect(formatFeeDate("2026-11-30T23:30:00-02:00")).toBe("1 December 2026");
    expect(() => formatFeeDate("soon")).toThrow();
    expect(lowerFirst("When the sale closes")).toBe("when the sale closes");
  });
});

describe("describeFee", () => {
  it("writes the brief's sentence for the conversion fee", () => {
    expect(describeFee(conversion)).toBe("1 % of the conversion value, minimum EUR 150");
  });

  it("covers every shape", () => {
    // Flat amounts, held within their bounds.
    expect(describeFee(terms({ kind: "tokenization_setup", fixed_eur: 2_500 }))).toBe("EUR 2,500");
    expect(describeFee(terms({ kind: "tokenization_setup", fixed_eur: 100, min_eur: 150 }))).toBe("EUR 150");
    expect(describeFee(terms({ kind: "tokenization_setup", fixed_eur: 900, max_eur: 500 }))).toBe("EUR 500");
    // A per-unit fee and its bounds.
    expect(describeFee(terms({ kind: "migration_per_holder", fixed_eur: 2 }))).toBe("EUR 2 per delivered holder wallet");
    expect(describeFee(terms({ kind: "migration_per_holder", fixed_eur: 2, min_eur: 500, max_eur: 5_000 })))
      .toBe("EUR 2 per delivered holder wallet, minimum EUR 500, maximum EUR 5,000");
    // Fixed plus rate; a minimum the fixed part reaches is left out.
    expect(describeFee(terms({ kind: "primary_sale", fixed_eur: 500, rate_bps: 100, max_eur: 10_000 })))
      .toBe("EUR 500 plus 1 % of the amount raised, maximum EUR 10,000");
    expect(describeFee(terms({ kind: "primary_sale", fixed_eur: 500, rate_bps: 100, min_eur: 400 })))
      .toBe("EUR 500 plus 1 % of the amount raised");
    expect(describeFee(terms({ kind: "otc", rate_bps: 50, min_eur: 25 }))).toBe("0.5 % of the trade value, minimum EUR 25");
    // Only a minimum: that is the price. Nothing at all, or a zero cap: no charge.
    expect(describeFee(terms({ min_eur: 150 }))).toBe("EUR 150");
    expect(describeFee(terms())).toBe("No charge");
    expect(describeFee(terms({ min_eur: 0 }))).toBe("No charge");
    expect(describeFee(terms({ rate_bps: 100, max_eur: 0 }))).toBe("No charge");
  });

  it("names the base of every kind", () => {
    const sentences = FEE_KINDS.map((kind) => describeFee(terms({ kind, rate_bps: 200 })));
    expect(sentences).toEqual([
      "2 % of the issuance value",
      "2 % of the amount raised",
      "2 % of the conversion value",
      "2 % of the trade value",
      "2 % of the migrated value",
      "2 % of the delivered value",
    ]);
  });
});

describe("the owner's suggested defaults (shared brief §3)", () => {
  it("are drafts of exactly the suggested prices, with no primary-sale or OTC row", () => {
    const byKind = new Map(SUGGESTED_FEE_DRAFTS.map((fee) => [fee.kind, fee]));
    expect([...byKind.keys()]).toEqual(["tokenization_setup", "conversion", "migration_setup", "migration_per_holder"]);
    expect(byKind.get("tokenization_setup")).toMatchObject({ payer: "issuer", fixed_eur: "2500.00", rate_bps: 0, min_eur: null });
    expect(byKind.get("conversion")).toMatchObject({ payer: "holder", fixed_eur: "0.00", rate_bps: 100, min_eur: "150.00", max_eur: null });
    expect(byKind.get("migration_setup")).toMatchObject({ payer: "issuer", fixed_eur: "5000.00", rate_bps: 0 });
    expect(byKind.get("migration_per_holder")).toMatchObject({ payer: "issuer", fixed_eur: "2.00", rate_bps: 0 });
    expect(SUGGESTED_FEE_DRAFTS.map(describeFee)).toEqual([
      "EUR 2,500",
      "1 % of the conversion value, minimum EUR 150",
      "EUR 5,000",
      "EUR 2 per delivered holder wallet",
    ]);
    // Third-party costs at cost, and the free holder swap, are stated where they apply.
    expect(byKind.get("tokenization_setup")!.public_note).toMatch(/passed through at cost/);
    expect(byKind.get("conversion")!.public_note).toMatch(/Notary and business-register costs are passed through at cost/);
    expect(byKind.get("migration_per_holder")!.public_note).toMatch(/free of charge/);
    // Every suggestion passes the routes' own validation.
    for (const fee of SUGGESTED_FEE_DRAFTS) expect(parseFeeDraft(fee).kind).toBe(fee.kind);
  });
});

describe("the public projection", () => {
  const published: PublicFee = {
    kind: "conversion", payer: "holder", fixed_eur: 0, rate_bps: 100, min_eur: 150, max_eur: null, collection: "invoice",
    public_label: "Conversion", public_note: "", effective_from: "2026-11-08T10:00:00+00:00",
  };

  it("keeps a well-formed row and drops anything malformed", () => {
    expect(parsePublicFee(published)).toEqual(published);
    expect(parsePublicFee({ ...published, fixed_eur: "2500.00" })).toMatchObject({ fixed_eur: "2500.00" });
    for (const broken of [
      null, [], "fee", { ...published, kind: "custody" }, { ...published, payer: "anyone" }, { ...published, collection: "card" },
      { ...published, rate_bps: 10_001 }, { ...published, rate_bps: "100" }, { ...published, fixed_eur: -1 },
      { ...published, min_eur: "1e3" }, { ...published, public_label: " " }, { ...published, public_note: null },
      { ...published, effective_from: "tomorrow" }, { ...published, effective_from: null },
    ]) expect(parsePublicFee(broken), JSON.stringify(broken)).toBeNull();
  });

  it("orders by kind and keeps one row per kind", () => {
    const setup: PublicFee = { ...published, kind: "tokenization_setup", payer: "issuer", rate_bps: 0, min_eur: null, fixed_eur: 2_500 };
    const ordered = orderPublicFees([published, setup, { ...published, public_label: "Duplicate" }]);
    expect(ordered.map((fee) => [fee.kind, fee.public_label])).toEqual([["tokenization_setup", "Conversion"], ["conversion", "Conversion"]]);
  });

  it("labels a fee 'where offered' unless its service is on (KYC-only mainnet: none is)", () => {
    vi.stubEnv(KYC_ONLY_ENV, "");
    for (const variable of Object.values(PILOT_MODULE_ENV)) vi.stubEnv(variable, "");
    for (const kind of FEE_KINDS) expect(feeServiceOffered(kind, "mainnet"), kind).toBe(false);
    vi.stubEnv(KYC_ONLY_ENV, "off");
    expect(feeServiceOffered("tokenization_setup", "mainnet")).toBe(true);
    expect(feeServiceOffered("primary_sale", "mainnet")).toBe(true);
    expect(feeServiceOffered("conversion", "mainnet")).toBe(false);
    vi.stubEnv(PILOT_MODULE_ENV.custodyConversion, "true");
    expect(feeServiceOffered("conversion", "mainnet")).toBe(true);
    // Token migration has no module yet: always "where offered".
    expect(feeServiceOffered("migration_setup", "devnet")).toBe(false);
    expect(feeServiceOffered("conversion", "devnet")).toBe(true);
  });
});

describe("admin input narrowing", () => {
  const draft = { kind: "conversion", payer: "holder", fixed_eur: "0", rate_bps: 100, min_eur: "150", max_eur: "", public_label: " Conversion ", public_note: "", effective_from: null };

  it("canonicalises a draft", () => {
    expect(parseFeeDraft(draft)).toEqual({
      kind: "conversion", payer: "holder", fixed_eur: "0.00", rate_bps: 100, min_eur: "150.00", max_eur: null,
      collection: "invoice", public_label: "Conversion", public_note: "", effective_from: null,
    });
    expect(parseFeeDraft({ ...draft, effective_from: "2026-12-01" }).effective_from).toBe("2026-12-01T00:00:00.000Z");
  });

  it.each([
    [{ kind: "custody" }, /Unknown fee kind/],
    [{ payer: "platform" }, /Unknown payer/],
    [{ collection: "card" }, /invoice/],
    [{ rate_bps: 10_001 }, /rate_bps/],
    [{ rate_bps: "100" }, /rate_bps/],
    [{ fixed_eur: "-5" }, /fixed_eur/],
    [{ fixed_eur: "1.234" }, /two decimals/],
    [{ fixed_eur: 10_000_000.01 }, /at most EUR 10,000,000/],
    [{ min_eur: "200", max_eur: "100" }, /minimum must not exceed/],
    [{ public_label: "  " }, /public_label is required/],
    [{ public_label: "x".repeat(121) }, /at most 120/],
    [{ public_label: "Bad\u0007label" }, /control characters/],
    [{ public_note: "x".repeat(501) }, /at most 500/],
    [{ effective_from: "2026-02-30" }, /effective_from/],
    [{ effective_from: "01/12/2026" }, /effective_from/],
  ])("refuses %j", (patch, message) => {
    expect(() => parseFeeDraft({ ...draft, ...patch })).toThrow(message);
    expect(() => parseFeeDraft({ ...draft, ...patch })).toThrow(FeeValidationError);
  });

  it("requires an explicit concurrency token", () => {
    expect(() => parseFeeDraftSave({ fee: draft })).toThrow(/expected_updated_at is required/);
    expect(parseFeeDraftSave({ fee: draft, expected_updated_at: null })).toMatchObject({ id: null, expected_updated_at: null });
    expect(() => parseFeeDraftSave({ fee: draft, expected_updated_at: REVISION })).toThrow(/new draft has no revision/);
    expect(parseFeeDraftSave({ fee: draft, id: UUID.toUpperCase(), expected_updated_at: REVISION })).toMatchObject({ id: UUID, expected_updated_at: REVISION });
    expect(() => parseFeeDraftSave({ fee: draft, id: UUID, expected_updated_at: null })).toThrow(/revision/);
    expect(() => parseFeeRevision({ id: "x", expected_updated_at: REVISION })).toThrow(/UUID/);
    expect(() => parseFeeRevision({ id: UUID, expected_updated_at: "never" })).toThrow(/revision/);
  });

  it("narrows a charge by its reference type", () => {
    expect(parseFeeChargeCreate({ kind: "conversion", ref_type: "conversion_request", ref_id: UUID, base_amount_eur: 10_000 }))
      .toEqual({ kind: "conversion", ref_type: "conversion_request", ref_id: UUID, base_amount_eur: "10000.00", quantity: 1, payer_client_id: null, issuer_pda: null, note: "" });
    expect(parseFeeChargeCreate({ kind: "otc", ref_type: "asset", ref_id: ADDRESS, issuer_pda: ADDRESS }).issuer_pda).toBe(ADDRESS);
    expect(parseFeeChargeCreate({ kind: "migration_per_holder", ref_type: "migration", ref_id: "PILOT-1", quantity: 180 }).quantity).toBe(180);
    for (const kind of FEE_KINDS) {
      for (const refType of ["conversion_request", "application", "asset", "migration", "other"] as const) {
        const allowed = FEE_KIND_REF_TYPES[kind as FeeKind].includes(refType);
        const refId = refType === "asset" ? ADDRESS : refType === "conversion_request" || refType === "application" ? UUID : "REF-1";
        const run = () => parseFeeChargeCreate({ kind, ref_type: refType, ref_id: refId });
        if (allowed) expect(run, `${kind}/${refType}`).not.toThrow();
        else expect(run, `${kind}/${refType}`).toThrow(/is not billed against/);
      }
    }
  });

  it.each([
    [{ kind: "conversion", ref_type: "conversion_request", ref_id: "not-a-uuid" }, /UUID/],
    [{ kind: "tokenization_setup", ref_type: "asset", ref_id: "0OIl" }, /asset address/],
    [{ kind: "conversion", ref_type: "other", ref_id: " " }, /ref_id is required/],
    [{ kind: "conversion", ref_type: "conversion_request", ref_id: UUID, payer_client_id: UUID }, /billed to the requesting holder/],
    [{ kind: "tokenization_setup", ref_type: "application", ref_id: UUID, payer_client_id: "client-1" }, /client id/],
    [{ kind: "conversion", ref_type: "other", ref_id: "R", quantity: 2 }, /per-unit/],
    [{ kind: "migration_per_holder", ref_type: "migration", ref_id: "M", quantity: 1_000_001 }, /quantity/],
    [{ kind: "conversion", ref_type: "other", ref_id: "R", base_amount_eur: "1000000000.01" }, /at most EUR 1,000,000,000/],
    [{ kind: "conversion", ref_type: "other", ref_id: "R", issuer_pda: "issuer" }, /issuer address/],
    [{ kind: "conversion", ref_type: "elsewhere", ref_id: "R" }, /Unknown reference type/],
    [{ kind: "conversion", ref_type: "other", ref_id: "R", note: "x".repeat(1_001) }, /at most 1000/],
  ])("refuses the charge %j", (params, message) => {
    expect(() => parseFeeChargeCreate(params)).toThrow(message);
  });

  it("narrows a charge move", () => {
    expect(parseFeeChargeUpdate({ id: UUID, expected_updated_at: REVISION, status: "invoiced", invoice_ref: " INV-1 " }))
      .toEqual({ id: UUID, expected_updated_at: REVISION, status: "invoiced", invoice_ref: "INV-1" });
    expect(parseFeeChargeUpdate({ id: UUID, expected_updated_at: REVISION, status: "paid" })).toMatchObject({ status: "paid" });
    expect(() => parseFeeChargeUpdate({ id: UUID, expected_updated_at: REVISION, status: "invoiced" })).toThrow(/invoice_ref is required/);
    expect(() => parseFeeChargeUpdate({ id: UUID, expected_updated_at: REVISION, status: "waived", waived_reason: "no" })).toThrow(/at least 4/);
    expect(() => parseFeeChargeUpdate({ id: UUID, expected_updated_at: REVISION, status: "due" })).toThrow(/invoiced, paid or waived/);
  });

  it("canonicalises amounts", () => {
    expect(parseEurAmount(2_500, "x", 10_000)).toBe("2500.00");
    expect(parseEurAmount("0.5", "x", 10_000)).toBe("0.50");
    expect(() => parseEurAmount(true, "x", 10)).toThrow(/amount in EUR/);
  });
});
