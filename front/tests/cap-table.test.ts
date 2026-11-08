// The cap table's pure logic (lib/cap-table.ts, lib/register-entries.ts):
// exact percent and basis-point arithmetic, every reconciliation check in
// each of its states, the issuer and public projections (no personal data),
// the CSV export and the register-entry input narrowing. max_supply is the
// class cap in units: a percentage of the company is units × the share of
// one unit from the tokenize figures, never units ÷ max_supply (MANCI-2026,
// a class that is 17.5 % of its company, below).
import { describe, expect, it } from "vitest";
import {
  bpsConsistent,
  bpsToPercent,
  capTableCsv,
  capTableCsvFilename,
  CHECK_IDS,
  csvCell,
  formatScaled,
  formatUnits,
  issuerReconciliation,
  normalizeBps,
  parseBps,
  percentForUnits,
  percentToBps,
  publicSupplyClass,
  reconcileAsset,
  reconcileShareClass,
  unitPercentE4,
  unitShareOf,
  worstState,
  type CheckId,
  type CheckState,
  type ClassChainFacts,
  type ConversionFacts,
  type RegisterEntryFacts,
  type UnitShareFigures,
} from "@/lib/cap-table";
import { companyFiguresFrom } from "@/lib/distribution-rows";
import { CLASS_INDEX } from "@/lib/tokenize-shares";
import {
  parseRegisterEntryInput,
  parseRegisterVoidInput,
  RegisterEntryInputError,
  validDecisionDate,
} from "@/lib/register-entries";

const n = (v: number | string) => BigInt(v);
const CLASS = "C1assC1assC1assC1assC1assC1assC1assC1ass1";
const MINT = "MintMintMintMintMintMintMintMintMintMint1";
const TREASURY = "TreasuryTreasuryTreasuryTreasuryTreasury1";
const ALICE = "A1iceA1iceA1iceA1iceA1iceA1iceA1iceA1ice1";
const BOB = "BobBobBobBobBobBobBobBobBobBobBobBobBob11";
const VAULT_1 = "Vau1tOneVau1tOneVau1tOneVau1tOneVau1tOne1";
const VAULT_2 = "Vau1tTwoVau1tTwoVau1tTwoVau1tTwoVau1tTwo1";
const TX_1 = "1".repeat(87) + "A";
const TX_2 = "2".repeat(87) + "B";
const SHA = "ab".repeat(32);

/** The tokenize figures of a class of 10,000 units of 0.01 % each: the whole company. */
const WHOLE: UnitShareFigures = { classIndex: 0, tokens: n(10_000), tokenE4: n(100) };

/** A whole-company class (10,000 units, 1 unit = 0.01 % with WHOLE), 250 converted (burned) on 2026-10-10. */
function chain(over: Partial<ClassChainFacts> = {}): ClassChainFacts {
  return {
    shareClassPda: CLASS,
    classIndex: 0,
    mint: MINT,
    maxSupply: n(10_000),
    cumulativeCap: false,
    lifetimeMinted: n(10_000),
    circulatingSupply: n(9_750),
    lockedSupply: n(0),
    mintSupply: n(9_750),
    custodyVaults: [
      { pda: VAULT_1, vaultId: "1", kind: "delivery_escrow", state: "realized", escrow: "Escrow1", escrowUnits: n(0) },
    ],
    holders: [
      { owner: TREASURY, units: n(9_000), kind: "treasury" },
      { owner: ALICE, units: n(500), kind: "wallet" },
      { owner: BOB, units: n(250), kind: "wallet" },
    ],
    ...over,
  };
}

function converted(over: Partial<ConversionFacts> = {}): ConversionFacts {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    shareClassPda: CLASS,
    status: "converted",
    units: n(250),
    burned: n(250),
    realizeTx: TX_1,
    vaultPda: VAULT_1,
    holderWallet: ALICE,
    clientId: "d0000000-0000-4000-8000-000000000001",
    decidedAt: "2026-10-10T12:00:00Z",
    ...over,
  };
}

function entry(over: Partial<RegisterEntryFacts> = {}): RegisterEntryFacts {
  return {
    id: "e0000000-0000-4000-8000-000000000001",
    shareClassPda: CLASS,
    units: n(250),
    percentBps: "250.0000",
    registry: "APR",
    decisionRef: "BD 12345/2026",
    decisionDate: "2026-10-09",
    decisionDocSha256: SHA,
    conversionRequestId: "c0000000-0000-4000-8000-000000000001",
    realizeTx: TX_1,
    status: "recorded",
    createdAt: "2026-10-10T13:00:00Z",
    holderClientId: "d0000000-0000-4000-8000-000000000001",
    note: "Holder: Jane Example",
    voidReason: null,
    voidedBy: null,
    voidedAt: null,
    createdBy: "AdminAdminAdminAdminAdminAdminAdminAdmin1",
    ...over,
  };
}

// ── MANCI-2026 as on mainnet (2026-11-08) ──
// Share class E4Ws…UCz: max_supply 1,750 units = 17.5 % of Mancipatio d.o.o.,
// cumulative_cap false, 500 issued (5 %), 250 burned by the DeliveryEscrow
// realize of 2026-10-10 (the registry moved 2.5 percentage points), 250
// outstanding (2.5 %). Its profile records the figures below (a draft).
const MANCI_CLASS = "E4WsTffEbUEG4xC5qizVyCgFgHqGHRjWQVR2Cj4yMUCz";
const MANCI_TOKENIZE = { v: 1, tokens: "1750", percent: "17.5", percent_e4: "175000", granularity_percent: "0.01" };
const manciCompany = companyFiguresFrom(MANCI_TOKENIZE)!;
const MANCI: UnitShareFigures = { classIndex: CLASS_INDEX, tokens: manciCompany.tokens, tokenE4: manciCompany.tokenE4 };

function manciChain(over: Partial<ClassChainFacts> = {}): ClassChainFacts {
  return chain({
    shareClassPda: MANCI_CLASS,
    maxSupply: n(1_750),
    lifetimeMinted: n(500),
    circulatingSupply: n(250),
    mintSupply: n(250),
    holders: [
      { owner: TREASURY, units: n(150), kind: "treasury" },
      { owner: BOB, units: n(100), kind: "wallet" },
    ],
    ...over,
  });
}
const manciConversion = (over: Partial<ConversionFacts> = {}) => converted({ shareClassPda: MANCI_CLASS, ...over });
/** The entry the owner records after the registry decision: 250 units, 2.5 % (250 bps). */
const manciEntry = (over: Partial<RegisterEntryFacts> = {}) => entry({ shareClassPda: MANCI_CLASS, percentBps: "250", ...over });

const states = (checks: { id: CheckId; state: CheckState }[]) =>
  Object.fromEntries(checks.map((c) => [c.id, c.state])) as Record<CheckId, CheckState>;
const detail = (checks: { id: CheckId; detail: string }[], id: CheckId) => checks.find((c) => c.id === id)!.detail;

describe("exact percent and basis-point arithmetic", () => {
  it("formats scaled integers without floating point", () => {
    expect(formatScaled(n(25_000), 4)).toBe("2.5");
    expect(formatScaled(n(2_500_000), 4)).toBe("250");
    expect(formatScaled(n(1), 4)).toBe("0.0001");
    expect(formatScaled(n(0), 6)).toBe("0");
    expect(formatUnits("10000")).toBe("10,000");
    expect(formatUnits(n(1_000_000))).toBe("1,000,000");
  });

  it("a share of the company is units × the share of one unit, exactly; nothing without that share", () => {
    expect(percentForUnits(n(250), "0.01")).toBe("2.5");
    expect(percentForUnits("500", "0.01")).toBe("5");
    expect(percentForUnits(n(1_750), "0.01")).toBe("17.5");
    expect(percentForUnits(n(1), "0.0001")).toBe("0.0001");
    expect(percentForUnits(n(37), "0.0001")).toBe("0.0037");
    expect(percentForUnits(n(0), "0.01")).toBe("0");
    expect(percentForUnits(n(1), null)).toBeNull();
    expect(percentForUnits(null, "0.01")).toBeNull();
    expect(percentForUnits("1.5", "0.01")).toBeNull();
    expect(unitPercentE4("0.01")).toBe(n(100));
    expect(unitPercentE4("0.001")).toBe(n(10));
    expect(unitPercentE4("0.0001")).toBe(n(1));
    expect(unitPercentE4("17.5")).toBe(n(175_000));
    expect(unitPercentE4("100")).toBe(n(1_000_000));
    for (const bad of [null, undefined, "", "0", "0.0000", "0.00001", "100.0001", "1e-2", "-0.01", ".01", "01"]) {
      expect(unitPercentE4(bad), String(bad)).toBeNull();
    }
  });

  it("parses basis points with up to four decimals, as written (trailing zeros dropped)", () => {
    expect(parseBps("250")).toEqual({ scaled: n(2_500_000), decimals: 0 });
    expect(parseBps("250.0000")).toEqual({ scaled: n(2_500_000), decimals: 0 });
    expect(parseBps("12.34")).toEqual({ scaled: n(123_400), decimals: 2 });
    expect(parseBps(" 0.01 ")).toEqual({ scaled: n(100), decimals: 2 });
    expect(parseBps("10000")).toEqual({ scaled: n(100_000_000), decimals: 0 });
    for (const bad of ["0", "0.0000", "10000.0001", "1.23456", "-5", "abc", "", "01", "1e3"]) expect(parseBps(bad), bad).toBeNull();
    expect(normalizeBps("250.00")).toBe("250");
    expect(normalizeBps("0")).toBeNull();
  });

  it("converts the percent written in a decision to basis points and back", () => {
    expect(percentToBps("2.5")).toBe("250");
    expect(percentToBps("2,5")).toBe("250");
    expect(percentToBps("2.5 %")).toBe("250");
    expect(percentToBps("0.0037")).toBe("0.37");
    expect(percentToBps("33.333333")).toBe("3333.3333");
    expect(percentToBps("100")).toBe("10000");
    for (const bad of ["0", "100.0001", "0.0000001", "", "x", "-1"]) expect(percentToBps(bad), bad).toBeNull();
    expect(bpsToPercent("250")).toBe("2.5");
    expect(bpsToPercent("0.37")).toBe("0.0037");
    expect(bpsToPercent("nope")).toBe("");
  });

  it("a percentage is consistent when it equals units × the share of one unit, rounded up or down at the precision written", () => {
    // 0.01 % a unit (100 in 1/10,000 of a percent): 250 units are 250 bps.
    expect(bpsConsistent("250", n(250), n(100))).toBe(true);
    expect(bpsConsistent("250.0000", n(250), n(100))).toBe(true);
    expect(bpsConsistent("251", n(250), n(100))).toBe(false);
    // MANCI-2026: 250 of its 1,750 units are 2.5 %, never 250 ÷ 1,750 = 14.285714 %.
    expect(bpsConsistent("1428.5714", n(250), n(100))).toBe(false);
    // 0.0001 % a unit: 1,234 units are 12.34 bps; fewer decimals may round either way.
    for (const ok of ["12.34", "12.3400", "12.3", "12.4", "12", "13"]) expect(bpsConsistent(ok, n(1_234), n(1)), ok).toBe(true);
    for (const off of ["12.35", "12.33", "12.5", "11", "14", "12.3401"]) expect(bpsConsistent(off, n(1_234), n(1)), off).toBe(false);
    // 0.001 % a unit: one unit is 0.1 bps.
    expect(bpsConsistent("0.1", n(1), n(10))).toBe(true);
    expect(bpsConsistent("bad", n(1), n(100))).toBe(false);
    expect(bpsConsistent("1", n(1), n(0))).toBe(false);
  });

  it("the worst state wins", () => {
    expect(worstState([])).toBe("pass");
    expect(worstState(["pass", "warn"])).toBe("warn");
    expect(worstState(["warn", "fail", "pass"])).toBe("fail");
  });
});

describe("the share of one unit", () => {
  it("only from tokenize figures that match the class: its index, a cap, max_supply = their tokens", () => {
    expect(unitShareOf(manciChain(), MANCI)).toEqual({
      e4: n(100), state: "pass",
      detail: "1 unit = 0.01 % of the company: the tokenize figures (1,750 units = 17.5 %) match the class cap.",
    });
    expect(unitShareOf(manciChain(), null)).toMatchObject({ e4: null, state: "pass", detail: expect.stringMatching(/No tokenize figures/) });
    // Figures written for 10,000 units (as if the cap were the whole company) do not fit a 1,750-unit cap.
    expect(unitShareOf(manciChain(), WHOLE)).toEqual({
      e4: null, state: "warn",
      detail: "The tokenize figures are for 10,000 units of 0.01 % each, but the class cap is 1,750 units: no percentages are shown until they agree.",
    });
    expect(unitShareOf(manciChain({ maxSupply: null }), MANCI)).toMatchObject({ e4: null, state: "warn", detail: expect.stringMatching(/no max supply/) });
    expect(unitShareOf(manciChain({ classIndex: 2 }), MANCI)).toMatchObject({ e4: null, state: "pass", detail: expect.stringMatching(/share class #0: this class shows units only/) });
    expect(unitShareOf(chain({ maxSupply: n(20_000) }), { classIndex: 0, tokens: n(20_000), tokenE4: n(100) }))
      .toMatchObject({ e4: null, state: "warn", detail: expect.stringMatching(/more than 100 %/) });
  });
});

describe("MANCI-2026: a class that is 17.5 % of its company", () => {
  it("1 unit = 0.01 %: the cap is 17.5 %, 500 issued are 5 %, 250 outstanding are 2.5 %", () => {
    const r = reconcileShareClass(manciChain(), [manciConversion()], [], MANCI);
    expect(r.chain).toMatchObject({ max_supply: "1750", unit_percent: "0.01", lifetime_minted: "500", circulating: "250", burned: "250", burned_by_conversions: "250" });
    const pct = (units: string | null) => percentForUnits(units, r.chain.unit_percent);
    expect([pct(r.chain.max_supply), pct(r.chain.lifetime_minted), pct(r.chain.circulating), pct(r.chain.burned_by_conversions)])
      .toEqual(["17.5", "5", "2.5", "2.5"]);
    expect(r.holders!.map((h) => [h.owner, h.units, h.percent])).toEqual([[TREASURY, "150", "1.5"], [BOB, "100", "1"]]);
    expect(states(r.checks)).toMatchObject({
      units_balance: "warn", entries_for_conversions: "warn", entries_match_chain: "pass", supply_identity: "pass",
      mint_supply: "pass", within_cap: "pass", unit_share: "pass", entry_percentages: "pass",
    });
    expect(detail(r.checks, "supply_identity")).toBe("500 issued − 250 burned through conversions = 250 outstanding.");
    // The converted units count against the cap while their register entry is still to record.
    expect(detail(r.checks, "within_cap")).toBe("250 outstanding + 250 converted into registered ownership = 500 of the 1,750-unit class cap (5 % of the company).");
  });

  it("the register entry the owner records (250 units at 250 bps = 2.5 %) passes every check", () => {
    const r = reconcileShareClass(manciChain(), [manciConversion()], [manciEntry()], MANCI);
    expect(r.checks.every((c) => c.state === "pass"), JSON.stringify(r.checks)).toBe(true);
    expect(detail(r.checks, "entry_percentages")).toBe("Every recorded percentage matches units × 0.01 %.");
    expect(r.register).toMatchObject({ entries: 1, units: "250", percent_bps: "250", percent: "2.5" });
    // What the max_supply = 100 % reading would have recorded (250 ÷ 1,750) is flagged.
    const wrong = reconcileShareClass(manciChain(), [manciConversion()], [manciEntry({ percentBps: "1428.5714" })], MANCI);
    expect(states(wrong.checks).entry_percentages).toBe("warn");
    expect(detail(wrong.checks, "entry_percentages")).toMatch(/14\.285714 % recorded, 250 units are 2\.5 %\./);
  });

  it("figures that do not match the class give no percentage anywhere, and a warn", () => {
    for (const figures of [WHOLE, { ...MANCI, tokens: n(1_749) }]) {
      const r = reconcileShareClass(manciChain(), [manciConversion()], [manciEntry()], figures);
      expect(r.chain.unit_percent).toBeNull();
      expect(r.holders!.every((h) => h.percent === null)).toBe(true);
      expect(states(r.checks)).toMatchObject({ unit_share: "warn", entry_percentages: "warn", within_cap: "pass", units_balance: "pass" });
      expect(detail(r.checks, "entry_percentages")).toMatch(/cannot be checked/);
      expect(detail(r.checks, "within_cap")).not.toMatch(/%/);
      expect(r.state).toBe("warn");
    }
    // Without any figures: units only; the unit_share check has nothing to compare.
    const none = reconcileShareClass(manciChain(), [manciConversion()], [], null);
    expect(none.chain.unit_percent).toBeNull();
    expect(states(none.checks).unit_share).toBe("pass");
    expect(capTableCsv(reconcileAsset(
      { asset_pda: "AssetAssetAssetAssetAssetAssetAssetAsset1", asset_id: "MANCI-2026", name: "Mancipatio", symbol: "MANCI", issuer_pda: "Issuer11" },
      "mainnet", [manciChain()], [manciConversion()], [], null, new Date("2026-11-08T10:00:00Z"),
    ))).toContain(`chain,${MANCI_CLASS},0,${MINT},max_supply,1750,,`);
  });

  it("minting the converted units again goes over the class cap (fail), counted in units", () => {
    // Without a cumulative cap the program allows circulating back up to 1,750.
    const reminted = reconcileShareClass(manciChain({ lifetimeMinted: n(2_000), circulatingSupply: n(1_750), mintSupply: n(1_750), holders: null }),
      [manciConversion()], [manciEntry()], MANCI);
    expect(states(reminted.checks).within_cap).toBe("fail");
    expect(detail(reminted.checks, "within_cap")).toBe(
      "1,750 outstanding + 250 converted into registered ownership = 2,000 of the 1,750-unit class cap: 250 over the cap. " +
      "Without a cumulative cap the program lets burned units be minted again: check for a mint into the room a conversion left.");
    // With one the program cannot, so only entries beyond the conversions take it over.
    const doubled = reconcileShareClass(manciChain({ cumulativeCap: true, lifetimeMinted: n(1_750), circulatingSupply: n(1_500), mintSupply: n(1_500), holders: null }),
      [manciConversion()], [manciEntry(), manciEntry({ id: "e0000000-0000-4000-8000-000000000002", conversionRequestId: null })], MANCI);
    expect(states(doubled.checks).within_cap).toBe("fail");
    expect(detail(doubled.checks, "within_cap")).toMatch(/= 2,000 of the 1,750-unit class cap: 250 over the cap\. Check the register entries against the conversions\.$/);
  });

  it("the public view: the published figures give percentages; the realized conversion shows with its register entry pending", () => {
    const realized = [{ status: "converted" as const, vaultPda: VAULT_1, units: n(250), realizeTx: TX_1 }];
    const published = publicSupplyClass(manciChain(), realized, [], MANCI);
    expect(published).toEqual({
      share_class_pda: MANCI_CLASS, class_index: 0, mint: MINT, max_supply: "1750", unit_percent: "0.01",
      issued: "500", outstanding: "250", in_conversion: "0",
      converted: { count: 0, units: "0", percent: "0" },
      records: [],
      pending: { count: 1, units: "250", conversions: [{ units: "250", realize_tx: TX_1 }] },
    });
    // A draft profile gives the public no figures: units only, no percentage at all.
    const draft = publicSupplyClass(manciChain(), realized, [], null);
    expect(draft.unit_percent).toBeNull();
    expect(draft.pending.count).toBe(1);
    // Once the entry is recorded (it carries the realize signature), the conversion is registered, no longer pending.
    const recorded = publicSupplyClass(manciChain(), realized, [manciEntry()], MANCI);
    expect(recorded.converted).toEqual({ count: 1, units: "250", percent: "2.5" });
    expect(recorded.pending).toEqual({ count: 0, units: "0", conversions: [] });
    expect(JSON.stringify([published, recorded])).not.toMatch(/BD 12345|Jane|d0000000|c0000000|e0000000|A1ice/);
  });
});

describe("reconciliation checks", () => {
  it("a whole-company class after a conversion: every check passes, and the figures add up", () => {
    const r = reconcileShareClass(chain(), [converted()], [entry()], WHOLE);
    expect(r.checks.map((c) => c.id)).toEqual([...CHECK_IDS]);
    expect(r.checks.every((c) => c.state === "pass"), JSON.stringify(r.checks)).toBe(true);
    expect(r.state).toBe("pass");
    expect(r.chain).toMatchObject({
      max_supply: "10000", unit_percent: "0.01", lifetime_minted: "10000", circulating: "9750", locked: "0",
      burned: "250", burned_by_conversions: "250", mint_supply: "9750", in_conversion: "0", custody_escrow: "0",
      treasury: "9000", other_wallets: "750", program_escrows: "0", holder_count: 3, holders_total: "9750",
    });
    expect(r.register).toEqual({ entries: 1, units: "250", percent_bps: "250", percent: "2.5", decision_refs: ["BD 12345/2026"] });
    expect(r.holders!.map((h) => [h.owner, h.units, h.percent, h.kind])).toEqual([
      [TREASURY, "9000", "90", "treasury"], [ALICE, "500", "5", "wallet"], [BOB, "250", "2.5", "wallet"],
    ]);
    expect(r.conversions[0]).toMatchObject({ status: "converted", units: "250", register_entry_id: entry().id, escrow_units: null });
    expect(detail(r.checks, "supply_identity")).toBe("10,000 issued − 250 burned through conversions = 9,750 outstanding.");
    expect(detail(r.checks, "within_cap")).toBe("9,750 outstanding + 250 converted into registered ownership = 10,000 of the 10,000-unit class cap (100 % of the company).");
  });

  it("no conversions yet: everything passes without register entries", () => {
    const r = reconcileShareClass(chain({
      circulatingSupply: n(10_000), mintSupply: n(10_000), custodyVaults: [],
      holders: [{ owner: TREASURY, units: n(10_000), kind: "treasury" }],
    }), [], []);
    expect(r.state).toBe("pass");
    expect(detail(r.checks, "units_balance")).toBe("No conversions and no register entries yet.");
    expect(detail(r.checks, "entries_for_conversions")).toBe("No converted requests yet.");
    expect(detail(r.checks, "entry_percentages")).toBe("No register entries yet.");
    expect(r.register).toEqual({ entries: 0, units: "0", percent_bps: "0", percent: "0" });
  });

  it("a converted request without an entry is a to-do (warn), explained in the units balance", () => {
    const r = reconcileShareClass(chain(), [converted()], [], WHOLE);
    expect(states(r.checks)).toMatchObject({
      units_balance: "warn", entries_for_conversions: "warn", entries_match_chain: "pass",
      supply_identity: "pass", within_cap: "pass",
    });
    expect(detail(r.checks, "entries_for_conversions")).toMatch(/record the entry after the registry decision/);
    expect(r.state).toBe("warn");
    expect(r.conversions[0].register_entry_id).toBeNull();
  });

  it("voided entries count for nothing; the corrected entry does", () => {
    const voided = entry({ id: "e0000000-0000-4000-8000-0000000000aa", percentBps: "25", status: "voided", voidReason: "Wrong percent" });
    const onlyVoided = reconcileShareClass(chain(), [converted()], [voided], WHOLE);
    expect(states(onlyVoided.checks)).toMatchObject({ units_balance: "warn", entries_for_conversions: "warn", entries_match_chain: "pass", entry_percentages: "pass" });
    expect(onlyVoided.register.entries).toBe(0);
    const corrected = reconcileShareClass(chain(), [converted()], [voided, entry()], WHOLE);
    expect(corrected.state).toBe("pass");
    expect(corrected.entries.map((e) => e.status)).toEqual(["voided", "recorded"]);
    expect(corrected.conversions[0].register_entry_id).toBe(entry().id);
  });

  it("an entry whose units differ from its conversion fails, and so does the balance", () => {
    const r = reconcileShareClass(chain(), [converted()], [entry({ units: n(240), percentBps: "240" })], WHOLE);
    expect(states(r.checks)).toMatchObject({ units_balance: "fail", entries_match_chain: "fail", entries_for_conversions: "pass", entry_percentages: "pass" });
    expect(detail(r.checks, "entries_match_chain")).toMatch(/registers 240 units; its conversion moved 250/);
  });

  it("an entry naming an unknown realize transaction fails; an unlinked entry without one warns", () => {
    const unknown = reconcileShareClass(chain(), [converted()], [entry({ conversionRequestId: null, realizeTx: TX_2 })], WHOLE);
    expect(states(unknown.checks)).toMatchObject({ entries_match_chain: "fail", entries_for_conversions: "warn" });
    const byTx = reconcileShareClass(chain(), [converted()], [entry({ conversionRequestId: null })], WHOLE);
    expect(byTx.state).toBe("pass");
    expect(byTx.conversions[0].register_entry_id).toBe(entry().id);
    const loose = reconcileShareClass(chain(), [converted()], [entry({ conversionRequestId: null, realizeTx: null })], WHOLE);
    // The totals still agree; the missing link is what the two checks report.
    expect(states(loose.checks)).toMatchObject({ entries_match_chain: "warn", entries_for_conversions: "warn", units_balance: "pass" });
    expect(detail(loose.checks, "entries_match_chain")).toMatch(/not linked to a conversion/);
  });

  it("an entry linked to a request that is not converted (or of another class) fails", () => {
    const open = converted({ status: "deposited", realizeTx: null, burned: null, vaultPda: VAULT_2 });
    const r = reconcileShareClass(chain(), [open], [entry()], WHOLE);
    expect(states(r.checks)).toMatchObject({ entries_match_chain: "fail", units_balance: "fail" });
    expect(detail(r.checks, "entries_match_chain")).toMatch(/not a converted request of this class/);
  });

  it("two entries registering the same conversion fail", () => {
    const second = entry({ id: "e0000000-0000-4000-8000-000000000002", conversionRequestId: null });
    const r = reconcileShareClass(chain(), [converted()], [entry(), second], WHOLE);
    expect(states(r.checks)).toMatchObject({ entries_match_chain: "fail", units_balance: "fail", within_cap: "fail" });
    expect(detail(r.checks, "entries_match_chain")).toMatch(/2 entries register request/);
  });

  it("units burned outside recorded conversions warn; more recorded burns than the chain shows fail", () => {
    const quarantine = reconcileShareClass(chain({ circulatingSupply: n(9_700), mintSupply: n(9_700), holders: null }), [converted()], [entry()], WHOLE);
    expect(states(quarantine.checks).supply_identity).toBe("warn");
    expect(detail(quarantine.checks, "supply_identity")).toMatch(/50 of the 300 burned units/);
    const short = reconcileShareClass(chain({ circulatingSupply: n(9_800), mintSupply: n(9_800), holders: null }), [converted()], [entry()], WHOLE);
    expect(states(short.checks).supply_identity).toBe("fail");
    const impossible = reconcileShareClass(chain({ circulatingSupply: n(10_001), mintSupply: n(10_001), holders: null }), [], [], WHOLE);
    expect(states(impossible.checks).supply_identity).toBe("fail");
    expect(impossible.chain.burned).toBe("0");
  });

  it("a proven burn larger than the request counts as burned, while the balance compares requested units", () => {
    const surplus = reconcileShareClass(chain({ circulatingSupply: n(9_740), mintSupply: n(9_740), holders: null }), [converted({ burned: n(260) })], [entry()], WHOLE);
    expect(surplus.chain.burned_by_conversions).toBe("260");
    expect(states(surplus.checks)).toMatchObject({ supply_identity: "pass", units_balance: "pass" });
  });

  it("the mint supply against the counters and the holder accounts", () => {
    const direct = reconcileShareClass(chain({ mintSupply: n(9_700), holders: null }), [converted()], [entry()], WHOLE);
    expect(states(direct.checks).mint_supply).toBe("warn");
    expect(detail(direct.checks, "mint_supply")).toMatch(/burned with the token program directly/);
    const over = reconcileShareClass(chain({ mintSupply: n(9_800), holders: null }), [converted()], [entry()], WHOLE);
    expect(states(over.checks).mint_supply).toBe("fail");
    const partial = reconcileShareClass(chain({ holders: [{ owner: TREASURY, units: n(9_000), kind: "treasury" }] }), [converted()], [entry()], WHOLE);
    expect(states(partial.checks).mint_supply).toBe("warn");
    expect(detail(partial.checks, "mint_supply")).toMatch(/add up to 9,000, not 9,750/);
    // Without a holder scan (the public read) only the counters are compared.
    const noScan = reconcileShareClass(chain({ holders: null }), [converted()], [entry()], WHOLE);
    expect(states(noScan.checks).mint_supply).toBe("pass");
    expect(noScan.chain).toMatchObject({ treasury: null, other_wallets: null, holder_count: null, holders_total: null });
    expect(noScan.holders).toBeNull();
  });

  it("units minted again into the room a conversion left go over the class cap (fail)", () => {
    const reminted = reconcileShareClass(chain({ lifetimeMinted: n(10_250), circulatingSupply: n(10_000), mintSupply: n(10_000), holders: null }), [converted()], [entry()], WHOLE);
    expect(states(reminted.checks).within_cap).toBe("fail");
    expect(detail(reminted.checks, "within_cap")).toMatch(/= 10,250 of the 10,000-unit class cap: 250 over the cap\. Without a cumulative cap/);
  });

  it("an uncapped class: no cap to hold the units against, and no figures can match it (warn)", () => {
    const r = reconcileShareClass(chain({ maxSupply: null }), [converted()], [entry()], WHOLE);
    expect(states(r.checks)).toMatchObject({ within_cap: "warn", unit_share: "warn", entry_percentages: "warn", units_balance: "pass" });
    expect(detail(r.checks, "within_cap")).toMatch(/no max supply/);
    expect(r.chain.unit_percent).toBeNull();
    expect(r.holders!.every((h) => h.percent === null)).toBe(true);
  });

  it("a percentage off units × the share of one unit warns; its rounding at the precision written passes", () => {
    // 1,000,000 units of 0.0001 % each: 1,234 units are 0.1234 % = 12.34 bps.
    const fine = chain({ maxSupply: n(1_000_000), lifetimeMinted: n(1_000_000), circulatingSupply: n(998_766), mintSupply: n(998_766), holders: null, custodyVaults: [] });
    const figures: UnitShareFigures = { classIndex: 0, tokens: n(1_000_000), tokenE4: n(1) };
    const request = converted({ units: n(1_234), burned: n(1_234) });
    const at = (percentBps: string) => reconcileShareClass(fine, [request], [entry({ units: n(1_234), percentBps })], figures);
    for (const ok of ["12.34", "12.3", "12.4", "12"]) expect(states(at(ok).checks).entry_percentages, ok).toBe("pass");
    const off = at("12.5");
    expect(states(off.checks).entry_percentages).toBe("warn");
    expect(detail(off.checks, "entry_percentages")).toMatch(/0\.125 % recorded, 1,234 units are 0\.1234 %/);
    expect(states(reconcileShareClass(chain(), [converted()], [entry({ percentBps: "2500" })], WHOLE).checks).entry_percentages).toBe("warn");
  });

  it("units in conversion: the escrows of open requests whose vaults are still live", () => {
    const vaults = [
      ...chain().custodyVaults,
      { pda: VAULT_2, vaultId: "2", kind: "delivery_escrow" as const, state: "active" as const, escrow: "Escrow2", escrowUnits: n(100) },
      { pda: "Vau1tGoneVau1tGoneVau1tGoneVau1tGoneVau1t", vaultId: "3", kind: "delivery_escrow" as const, state: "returned" as const, escrow: "Escrow3", escrowUnits: n(0) },
    ];
    const open = converted({ id: "c0000000-0000-4000-8000-000000000002", status: "deposited", units: n(100), burned: null, realizeTx: null, vaultPda: VAULT_2 });
    const returned = converted({ id: "c0000000-0000-4000-8000-000000000003", status: "vault_opened", units: n(5), burned: null, realizeTx: null, vaultPda: "Vau1tGoneVau1tGoneVau1tGoneVau1tGoneVau1t" });
    const holders = [...chain().holders!.map((h) => (h.owner === ALICE ? { ...h, units: n(400) } : h)), { owner: VAULT_2, units: n(100), kind: "custody" as const }];
    const r = reconcileShareClass(chain({ custodyVaults: vaults, holders }), [converted(), open, returned], [entry()], WHOLE);
    expect(r.chain).toMatchObject({ in_conversion: "100", custody_escrow: "100", program_escrows: "0", other_wallets: "650" });
    expect(r.conversions.map((c) => [c.status, c.escrow_units])).toEqual([["converted", null], ["deposited", "100"], ["vault_opened", null]]);
    expect(r.state).toBe("pass");
  });

  it("an asset reconciles each class with its own rows only, and its figures fit only the class they describe", () => {
    const other = { ...chain({ shareClassPda: "C2assC2assC2assC2assC2assC2assC2assC2ass2", classIndex: 2, circulatingSupply: n(10_000), mintSupply: n(10_000), holders: null, custodyVaults: [] }) };
    const asset = reconcileAsset(
      { asset_pda: "AssetAssetAssetAssetAssetAssetAssetAsset1", asset_id: "MANCI-2026", name: "Mancipatio", symbol: "MANCI", issuer_pda: "Issuer11" },
      "devnet", [chain(), other], [converted()], [entry()], WHOLE, new Date("2026-11-08T10:00:00Z"),
    );
    expect(asset.classes.map((c) => [c.class_index, c.register.entries, c.conversions.length, c.state])).toEqual([[0, 1, 1, "pass"], [2, 0, 0, "pass"]]);
    expect(asset.classes.map((c) => c.chain.unit_percent)).toEqual(["0.01", null]);
    expect(asset).toMatchObject({ network: "devnet", generated_at: "2026-11-08T10:00:00.000Z", state: "pass" });
  });
});

describe("projections", () => {
  const admin = reconcileAsset(
    { asset_pda: "AssetAssetAssetAssetAssetAssetAssetAsset1", asset_id: "MANCI-2026", name: "Mancipatio", symbol: "MANCI", issuer_pda: "Issuer11" },
    "devnet", [chain()], [converted()],
    [entry({ id: "e0000000-0000-4000-8000-0000000000aa", status: "voided", voidReason: "Typo: Jane Example", voidedBy: "Admin1", voidedAt: "2026-10-10T12:30:00Z" }), entry()],
    WHOLE, new Date("2026-11-08T10:00:00Z"),
  );

  it("the issuer view keeps wallets, units and decision references, nothing personal or internal", () => {
    const issuer = issuerReconciliation(admin);
    const text = JSON.stringify(issuer);
    for (const secret of ["d0000000-0000-4000-8000-000000000001", "Jane Example", "Typo", "AdminAdminAdmin", "holder_client_id", "client_id", "void_reason", "voided_by", "created_by", "note"]) {
      expect(text, secret).not.toContain(secret);
    }
    const c = issuer.classes[0];
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0]).toMatchObject({ status: "recorded", decision_ref: "BD 12345/2026", units: "250", realize_tx: TX_1 });
    expect(c.conversions[0]).toMatchObject({ holder_wallet: ALICE, units: "250" });
    expect(c.holders!.map((h) => h.owner)).toEqual([TREASURY, ALICE, BOB]);
    expect(c.checks).toEqual(admin.classes[0].checks);
  });

  it("the public view: supply figures and conversion records, no case number, request or wallet", () => {
    const vaults = [{ pda: VAULT_2, vaultId: "2", kind: "delivery_escrow" as const, state: "triggered" as const, escrow: "Escrow2", escrowUnits: n(100) }];
    const later = { ...entry({ id: "e2", decisionDate: "2026-11-01", units: n(100), percentBps: "100", realizeTx: TX_2 }) };
    const p = publicSupplyClass(chain({ custodyVaults: vaults }), [
      { status: "deposited", vaultPda: VAULT_2, units: n(100), realizeTx: null },
      { status: "converted", vaultPda: VAULT_1, units: n(250), realizeTx: TX_1 },
    ], [later, entry(), entry({ status: "voided", units: n(999) })], WHOLE);
    expect(p).toEqual({
      share_class_pda: CLASS, class_index: 0, mint: MINT, max_supply: "10000", unit_percent: "0.01",
      issued: "10000", outstanding: "9750", in_conversion: "100",
      converted: { count: 2, units: "350", percent: "3.5" },
      records: [
        { decision_date: "2026-10-09", units: "250", percent: "2.5", registry: "APR", decision_doc_sha256: SHA, realize_tx: TX_1 },
        { decision_date: "2026-11-01", units: "100", percent: "1", registry: "APR", decision_doc_sha256: SHA, realize_tx: TX_2 },
      ],
      pending: { count: 0, units: "0", conversions: [] },
    });
    expect(JSON.stringify(p)).not.toMatch(/BD 12345|Jane|d0000000|c0000000|e0000000/);
  });
});

describe("CSV export", () => {
  const table = reconcileAsset(
    { asset_pda: "AssetAssetAssetAssetAssetAssetAssetAsset1", asset_id: "MANCI-2026", name: "Mancipatio, d.o.o.", symbol: "MANCI", issuer_pda: "Issuer11" },
    "devnet", [chain()], [converted()],
    [entry({ id: "e0000000-0000-4000-8000-0000000000aa", status: "voided", voidReason: "Typo for Jane Example", voidedBy: "Admin1", voidedAt: "2026-10-10T12:30:00Z" }), entry()],
    WHOLE, new Date("2026-11-08T10:00:00Z"),
  );

  it("escapes cells and never lets a spreadsheet evaluate exported text", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("+381 11 123")).toBe("'+381 11 123");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell(null)).toBe("");
    expect(csvCell(250)).toBe("250");
  });

  it("the plain export holds no personal data", () => {
    const csv = capTableCsv(table);
    expect(csv.startsWith("﻿section,share_class,class_index,mint,item,units,percent,wallet,kind,state,detail,decision_ref,")).toBe(true);
    expect(csv.split("\r\n")[0]).not.toMatch(/holder_client_id|holder_name|note/);
    for (const secret of ["d0000000-0000-4000-8000-000000000001", "Jane Example", "Typo"]) expect(csv, secret).not.toContain(secret);
    expect(csv).toContain(`chain,${CLASS},0,${MINT},burned_by_conversions,250,2.5`);
    expect(csv).toContain(`holder,${CLASS},0,${MINT},,9000,90,${TREASURY},treasury`);
    expect(csv).toContain("BD 12345/2026");
    expect(csv).toContain('asset,,,,name,,,,,,"Mancipatio, d.o.o."');
    expect(csv).toContain(`check,${CLASS},0,${MINT},units_balance,,,,,pass,`);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("percentages are units × the share of one unit: MANCI-2026's cap is 17.5 % of the company", () => {
    const manci = capTableCsv(reconcileAsset(
      { asset_pda: "AssetAssetAssetAssetAssetAssetAssetAsset1", asset_id: "MANCI-2026", name: "Mancipatio", symbol: "MANCI", issuer_pda: "Issuer11" },
      "mainnet", [manciChain()], [manciConversion()], [manciEntry()], MANCI, new Date("2026-11-08T10:00:00Z"),
    ));
    expect(manci).toContain(`chain,${MANCI_CLASS},0,${MINT},max_supply,1750,17.5,`);
    expect(manci).toContain(`chain,${MANCI_CLASS},0,${MINT},lifetime_minted,500,5,`);
    expect(manci).toContain(`chain,${MANCI_CLASS},0,${MINT},circulating,250,2.5,`);
    expect(manci).toContain(`chain,${MANCI_CLASS},0,${MINT},unit_percent,,0.01,`);
    expect(manci).toContain(`conversion,${MANCI_CLASS},0,${MINT},,250,2.5,`);
  });

  it("the personal-data variant adds the holders' client ids, names and staff notes", () => {
    const csv = capTableCsv(table, { names: new Map([["d0000000-0000-4000-8000-000000000001", "Jane Example"]]) });
    expect(csv.split("\r\n")[0].endsWith(",holder_client_id,holder_name,note")).toBe(true);
    expect(csv).toContain("d0000000-0000-4000-8000-000000000001,Jane Example");
    expect(csv).toContain("Typo for Jane Example");
  });

  it("names the file after the asset and the date", () => {
    expect(capTableCsvFilename(table, false)).toBe("manci-cap-table-MANCI-2026-2026-11-08.csv");
    expect(capTableCsvFilename({ ...table, asset_id: "../x y" }, true)).toBe("manci-cap-table-x-y-2026-11-08-personal-data.csv");
  });
});

describe("register entry input", () => {
  const TODAY = new Date("2026-11-08T10:00:00Z");
  const valid = {
    share_class_pda: CLASS, units: "250", percent_bps: "250.00", decision_ref: " BD 12345/2026 ",
    decision_date: "2026-10-09", decision_doc_sha256: SHA.toUpperCase(),
  };
  const refused = (params: Record<string, unknown>) => {
    try {
      parseRegisterEntryInput(params, TODAY);
    } catch (err) {
      expect(err).toBeInstanceOf(RegisterEntryInputError);
      return (err as Error).message;
    }
    return null;
  };

  it("normalizes a valid entry: trimmed text, APR by default, lower-case hash, normalized basis points", () => {
    expect(parseRegisterEntryInput(valid, TODAY)).toEqual({
      share_class_pda: CLASS, units: "250", percent_bps: "250", registry: "APR", decision_ref: "BD 12345/2026",
      decision_date: "2026-10-09", decision_doc_sha256: SHA, conversion_request_id: null, realize_tx: null,
      holder_client_id: null, note: "",
    });
    expect(parseRegisterEntryInput({
      ...valid, registry: "APR (Business Registers Agency)", conversion_request_id: "C0000000-0000-4000-8000-000000000001",
      realize_tx: TX_1, holder_client_id: "d0000000-0000-4000-8000-000000000001", note: "Two lines\nof note",
    }, TODAY)).toMatchObject({
      registry: "APR (Business Registers Agency)", conversion_request_id: "c0000000-0000-4000-8000-000000000001",
      realize_tx: TX_1, holder_client_id: "d0000000-0000-4000-8000-000000000001", note: "Two lines\nof note",
    });
  });

  it("refuses each malformed field with its own message", () => {
    expect(refused({ ...valid, share_class_pda: "x" })).toMatch(/share_class_pda/);
    for (const units of ["0", "01", "1.5", "-1", "18446744073709551616", 250]) expect(refused({ ...valid, units }), String(units)).toMatch(/units/);
    for (const bps of ["0", "10001", "1.23456", 250]) expect(refused({ ...valid, percent_bps: bps }), String(bps)).toMatch(/percent_bps/);
    expect(refused({ ...valid, decision_ref: "  " })).toMatch(/decision_ref is required/);
    expect(refused({ ...valid, decision_ref: "x".repeat(121) })).toMatch(/at most 120/);
    expect(refused({ ...valid, decision_ref: "BD\n1" })).toMatch(/single lines/);
    expect(refused({ ...valid, registry: 5 })).toMatch(/registry must be text/);
    for (const date of ["2026-02-30", "2026-11-10", "1999-12-31", "09.10.2026"]) expect(refused({ ...valid, decision_date: date }), date).toMatch(/decision_date/);
    for (const sha of ["0".repeat(64), "ab".repeat(31), "zz".repeat(32)]) expect(refused({ ...valid, decision_doc_sha256: sha }), sha).toMatch(/decision_doc_sha256/);
    expect(refused({ ...valid, conversion_request_id: "nope" })).toMatch(/conversion_request_id/);
    expect(refused({ ...valid, realize_tx: "short" })).toMatch(/realize_tx/);
    expect(refused({ ...valid, holder_client_id: "nope" })).toMatch(/holder_client_id/);
    expect(refused({ ...valid, note: "x".repeat(2001) })).toMatch(/at most 2000/);
    expect(refused({ ...valid, note: "bell\u0007" })).toMatch(/control characters/);
  });

  it("dates: a real calendar date from 2000 to tomorrow (UTC)", () => {
    expect(validDecisionDate("2026-11-09", TODAY)).toBe(true);
    expect(validDecisionDate("2026-11-10", TODAY)).toBe(false);
    expect(validDecisionDate("2000-01-01", TODAY)).toBe(true);
    expect(validDecisionDate("2024-02-29", TODAY)).toBe(true);
    expect(validDecisionDate("2025-02-29", TODAY)).toBe(false);
  });

  it("a void needs the entry id and a one-line reason", () => {
    expect(parseRegisterVoidInput({ id: "E0000000-0000-4000-8000-000000000001", reason: " Wrong percent " }))
      .toEqual({ id: "e0000000-0000-4000-8000-000000000001", reason: "Wrong percent" });
    expect(() => parseRegisterVoidInput({ id: "x", reason: "r" })).toThrow(/id/);
    expect(() => parseRegisterVoidInput({ id: entry().id, reason: " " })).toThrow(/reason is required/);
    expect(() => parseRegisterVoidInput({ id: entry().id, reason: "x".repeat(501) })).toThrow(/at most 500/);
    expect(() => parseRegisterVoidInput({ id: entry().id, reason: "a\nb" })).toThrow(/single line/);
  });
});
