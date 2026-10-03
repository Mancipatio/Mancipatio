// "Tokenize company shares" (lib/tokenize-shares.ts, lib/tokenize-shares-chain.ts):
// exact percent math, byte-limited names for non-ASCII company names, the
// asset-ID suffixing, the resume decision table, the mainnet legal-document
// rule, the profile row and the size of the batched transaction.
//
// Round 2 (owner decision 2026-10-03): the tokens are Open bearer instruments
// — no KYC-only step, KYC only at conversion; the price stays private; no
// private website or unreviewed company name reaches the public page; create()
// re-checks its preconditions.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSigner, getBase64Encoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { AssetStatus, AssetType, ShareClassType } from "@/lib/generated/asset_registry";
import { U64_MAX } from "@/lib/vesting-terms";
import {
  ASSET_ID_CANDIDATES,
  CLASS_DEFAULTS,
  DEFAULT_GRANULARITY,
  GRANULARITIES,
  HUNDRED_PERCENT_E4,
  KYC_GATED_NOTE,
  LEGAL_DOC_MAX_BYTES,
  MARKER_DEFAULTS,
  MAX_ASSET_ID_BYTES,
  MAX_SYMBOL_PREFIX_BYTES,
  MAX_TOKEN_NAME_BYTES,
  NEXT_STEP_LINE,
  OPEN_CLASS_LINE,
  OPEN_TOKEN_NOTE,
  WEBSITE_MAX_CHARS,
  assetDefaults,
  baseAssetId,
  buildProfileRow,
  candidateAssetIds,
  canonicalProfileHashInput,
  checklistItems,
  chooseAssetId,
  classHasFlowTerms,
  closeText,
  conversionMarkerState,
  companyShortName,
  deriveSymbolPrefix,
  deriveTokenCompany,
  deriveTokenName,
  detailsSaved,
  distributeDoneText,
  distributeWaitText,
  lockAtZeroOffered,
  draftKey,
  duplicateConfirmationKey,
  formatCents,
  formatE6,
  formatPercent,
  formatTokens,
  granularityById,
  hasTokenizeFields,
  isFlowToken,
  isMarkerClass,
  isResumable,
  legalDocProblem,
  legalDocRequired,
  looksLikeTokenizeAsset,
  markerAction,
  markerLinks,
  mintNamePreview,
  mintSymbolPreview,
  namedPercentE4,
  needsDuplicateConfirmation,
  nextTokenizeStep,
  parseDraft,
  parsePercent,
  parsePrice,
  percentForTokens,
  percentFromName,
  perTokenPriceE6,
  primaryPausedNote,
  resolveCompany,
  resolveJurisdiction,
  resumePrefill,
  shareFigures,
  summaryText,
  supplyCapLine,
  toAsciiUpper,
  tokenNameFor,
  tokenizeCreateBlocker,
  tokensFor,
  truncateUtf8,
  utf8Bytes,
  validateCompanyOverride,
  validateSymbolOverride,
  validateWebsite,
  type AssetSnapshot,
  type ClassSnapshot,
  type TokenizeStep,
} from "@/lib/tokenize-shares";
import {
  TOKENIZE_TX_LIMIT,
  buildTokenizeIxs,
  simulationWire,
  tokenizeTransactionSize,
} from "@/lib/tokenize-shares-chain";

const B = (n: number | string) => BigInt(n);
const g = (id: string) => granularityById(id)!;
const percent = (s: string) => {
  const r = parsePercent(s);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("percent → tokens (exact, no floats)", () => {
  it("5 % at the default 1 token = 0.001 % is 5,000 tokens", () => {
    expect(DEFAULT_GRANULARITY).toBe("0.001");
    expect(percent("5")).toBe(B(50_000));
    expect(tokensFor(percent("5"), g("0.001"))).toEqual({ ok: true, value: B(5_000) });
    expect(formatTokens(B(5_000))).toBe("5,000");
  });

  it("covers every token size and the whole company", () => {
    expect(GRANULARITIES.map((x) => x.id)).toEqual(["0.01", "0.001", "0.0001"]);
    expect(tokensFor(percent("5"), g("0.01"))).toEqual({ ok: true, value: B(500) });
    expect(tokensFor(percent("5"), g("0.0001"))).toEqual({ ok: true, value: B(50_000) });
    expect(percent("100")).toBe(HUNDRED_PERCENT_E4);
    expect(tokensFor(percent("100"), g("0.001"))).toEqual({ ok: true, value: B(100_000) });
    expect(tokensFor(percent("2.5"), g("0.001"))).toEqual({ ok: true, value: B(2_500) });
    expect(percentForTokens(B(5_000), g("0.001"))).toBe(B(50_000));
  });

  it("refuses a share that does not give whole tokens at the chosen size", () => {
    const r = tokensFor(percent("0.0005"), g("0.001"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/does not give a whole number of tokens at 1 token = 0\.001 %/);
    expect(tokensFor(percent("0.0005"), g("0.0001"))).toEqual({ ok: true, value: B(5) });
    expect(tokensFor(percent("2.505"), g("0.01")).ok).toBe(false);
  });

  it("refuses more than 100 %, zero, commas, more than 4 decimals and junk", () => {
    expect(parsePercent("100.0001")).toEqual({ ok: false, error: "The share cannot be more than 100 %." });
    expect(parsePercent("1000").ok).toBe(false);
    expect(parsePercent("0").ok).toBe(false);
    expect(parsePercent("0.0000").ok).toBe(false);
    expect(parsePercent("").ok).toBe(false);
    const comma = parsePercent("5,5");
    expect(!comma.ok && comma.error).toMatch(/Use "\." for decimals/);
    const precise = parsePercent("1.23456");
    expect(!precise.ok && precise.error).toMatch(/at most 4 decimals/);
    expect(parsePercent("5.").ok).toBe(false);
    expect(parsePercent("abc").ok).toBe(false);
    expect(parsePercent("-5").ok).toBe(false);
    expect(parsePercent("1e2").ok).toBe(false);
  });

  it("accepts harmless forms: a trailing %, leading or trailing zeros", () => {
    expect(percent("5 %")).toBe(B(50_000));
    expect(percent("5%")).toBe(B(50_000));
    expect(percent("005")).toBe(B(50_000));
    expect(percent("5.000")).toBe(B(50_000));
    expect(percent(".5")).toBe(B(5_000));
    expect(percent("100.0000")).toBe(HUNDRED_PERCENT_E4);
  });

  it("guards u64 (synthetic share beyond any real percent)", () => {
    const huge = U64_MAX * B(10) + B(10);
    const r = tokensFor(huge, { e4: B(10) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/u64/);
    expect(tokensFor(U64_MAX * B(10), { e4: B(10) })).toEqual({ ok: true, value: U64_MAX });
  });

  it("formats percents and token counts without floats", () => {
    expect(formatPercent(B(50_000))).toBe("5");
    expect(formatPercent(B(25_000))).toBe("2.5");
    expect(formatPercent(B(5))).toBe("0.0005");
    expect(formatPercent(B(1_000_000))).toBe("100");
    expect(formatTokens(B(999))).toBe("999");
    expect(formatTokens(B(1_000_000))).toBe("1,000,000");
  });
});

describe("price (optional, USD)", () => {
  it("parses cents exactly and leaves an empty price out", () => {
    expect(parsePrice("")).toEqual({ ok: true, value: null });
    expect(parsePrice("50000")).toEqual({ ok: true, value: B(5_000_000) });
    expect(parsePrice("50000.5")).toEqual({ ok: true, value: B(5_000_050) });
    expect(parsePrice("$ 12.30")).toEqual({ ok: true, value: B(1_230) });
    expect(parsePrice("1,000").ok).toBe(false);
    expect(parsePrice("1.234").ok).toBe(false);
    expect(parsePrice("0").ok).toBe(false);
    expect(formatCents(B(5_000_050))).toBe("50000.5");
    expect(formatCents(B(1_230))).toBe("12.3");
  });

  it("rounds the per-token price half up to 6 decimals with BigInt", () => {
    expect(formatE6(perTokenPriceE6(B(5_000_000), B(5_000)))).toBe("10");
    expect(formatE6(perTokenPriceE6(B(1), B(3)))).toBe("0.003333");
    expect(formatE6(perTokenPriceE6(B(2), B(3)))).toBe("0.006667");
  });
});

describe("UTF-8 byte limits", () => {
  it("counts bytes, not characters", () => {
    for (const ch of ["š", "ć", "č", "ž", "đ", "Š", "Ć", "Č", "Ž", "Đ", "Ж", "ђ", "·"]) expect(utf8Bytes(ch)).toBe(2);
    expect(MAX_TOKEN_NAME_BYTES).toBe(21);
    expect(MAX_SYMBOL_PREFIX_BYTES).toBe(9);
    expect(utf8Bytes(" · Class 0")).toBe(11);
  });

  it("truncates like the program: never inside a character", () => {
    expect(truncateUtf8("ćao", 1)).toBe("");
    expect(truncateUtf8("aćb", 2)).toBe("a");
    expect(truncateUtf8("aćb", 3)).toBe("ać");
    expect(truncateUtf8("Đurđević", 4)).toBe("Đur");
    expect(truncateUtf8("short", 32)).toBe("short");
  });
});

describe("company → token name, symbol and asset ID", () => {
  it("strips the legal form and quotes", () => {
    expect(companyShortName("Mancipatio d.o.o.")).toBe("Mancipatio");
    expect(companyShortName("Mancipatio d.o.o. Beograd")).toBe("Mancipatio");
    expect(companyShortName('"Mancipatio" DOO')).toBe("Mancipatio");
    expect(companyShortName("„Đurđević Šećer“ d.o.o.")).toBe("Đurđević Šećer");
    expect(companyShortName("Manci International Ltd.")).toBe("Manci International");
    expect(companyShortName("Acme, Inc.")).toBe("Acme");
    expect(companyShortName("Acme Sp. z o.o.")).toBe("Acme");
    expect(companyShortName("Volvo AB")).toBe("Volvo");
    expect(companyShortName("AB Foods")).toBe("AB Foods");
    expect(companyShortName("Шећер доо")).toBe("Шећер");
    expect(companyShortName("  Plain   Name  ")).toBe("Plain Name");
  });

  it("transliterates š ć č ž đ and Serbian Cyrillic to ASCII", () => {
    expect(toAsciiUpper("Đurđević Šećer")).toBe("DJURDJEVIC SECER");
    expect(toAsciiUpper("čćžšđ")).toBe("CCZSDJ");
    expect(toAsciiUpper("Ђурђевић Шећер")).toBe("DJURDJEVIC SECER");
    expect(toAsciiUpper("Љубовија Њива Џак Жито")).toBe("LJUBOVIJA NJIVA DZAK ZITO");
  });

  it("derives the real case: Mancipatio d.o.o., 5 % → Mancipatio 5% · MANCI0 · MANCI-5PCT", () => {
    const short = companyShortName("Mancipatio d.o.o.");
    const name = deriveTokenName(short, percent("5"));
    expect(name).toBe("Mancipatio 5%");
    expect(utf8Bytes(name)).toBe(13);
    expect(mintNamePreview(name)).toBe("Mancipatio 5% · Class 0");
    const prefix = deriveSymbolPrefix(short, "MANCI-5-2026");
    expect(prefix).toBe("MANCI");
    expect(mintSymbolPreview(prefix)).toBe("MANCI0");
    expect(baseAssetId(prefix, percent("5"))).toBe("MANCI-5PCT");
  });

  it("keeps the token name within 21 bytes, cutting at a word when it can", () => {
    // "Đurđević Šećer 5%" would be 22 bytes.
    expect(utf8Bytes("Đurđević Šećer 5%")).toBe(22);
    expect(deriveTokenName("Đurđević Šećer", percent("5"))).toBe("Đurđević 5%");
    // One long word is cut inside the word, but never inside a character.
    const long = deriveTokenName("Šećeranaživotačićđura", percent("12.3456"));
    expect(utf8Bytes(long)).toBeLessThanOrEqual(21);
    expect(long.endsWith(" 12.3456%")).toBe(true);
    expect(long).not.toContain("�");
    expect(deriveTokenName("Mancipatio", percent("100"))).toBe("Mancipatio 100%");
    expect(deriveTokenName("Mancipatio", percent("0.0001"))).toBe("Mancipatio 0.0001%");
  });

  it("every derived name keeps the whole ' · Class 0' and every symbol its class digit", () => {
    const companies = [
      "Mancipatio d.o.o.", "Đurđević Šećer d.o.o.", "Čačak Žitopromet Šumadija a.d.", "Шећерана Ћуприја доо",
      "Ž", "Super Long Company Name With Many Words Ltd", "ĐĐĐĐĐĐĐĐĐĐĐĐĐĐĐĐĐĐĐĐ",
    ];
    for (const company of companies) {
      for (const p of ["5", "100", "0.0001", "12.3456", "33.3"]) {
        const short = companyShortName(company);
        const name = deriveTokenName(short, percent(p));
        expect(utf8Bytes(name), `${company} ${p}`).toBeLessThanOrEqual(MAX_TOKEN_NAME_BYTES);
        expect(name).toBe(tokenNameFor(deriveTokenCompany(short, percent(p)), percent(p)));
        expect(validateCompanyOverride(deriveTokenCompany(short, percent(p)), percent(p))).toBeNull();
        expect(namedPercentE4(name)).toBe(percent(p));
        expect(mintNamePreview(name).endsWith(" · Class 0")).toBe(true);
        expect(utf8Bytes(mintNamePreview(name))).toBeLessThanOrEqual(32);
        const prefix = deriveSymbolPrefix(short, "MANCI-5-2026");
        expect(validateSymbolOverride(prefix)).toBeNull();
        expect(mintSymbolPreview(prefix)).toBe(`${prefix}0`);
        for (const id of candidateAssetIds(baseAssetId(prefix, percent(p)))) {
          expect(utf8Bytes(id)).toBeLessThanOrEqual(MAX_ASSET_ID_BYTES);
          expect(id).toMatch(/^[A-Z0-9_-]+$/);
        }
      }
    }
  });

  it("derives the symbol from the transliterated name, else from the legal ID", () => {
    expect(deriveSymbolPrefix("Đurđević Šećer", "X")).toBe("DJURD");
    expect(deriveSymbolPrefix("Шећер", "X")).toBe("SECER");
    expect(deriveSymbolPrefix("Ž", "MANCI-5-2026")).toBe("MANCI");
    expect(deriveSymbolPrefix("--", "")).toBe("SHARE");
  });

  it("validates the Advanced overrides by bytes, live (the name counted with its percent)", () => {
    expect(validateCompanyOverride("Mancipatio", percent("5"))).toBeNull();
    expect(validateCompanyOverride("Đurđević Šećer", percent("5"))).toMatch(/“Đurđević Šećer 5%” is 22 bytes — the limit is 21/);
    // The same company part fits a shorter percent and not a longer one.
    expect(validateCompanyOverride("Mancipatio Group", percent("5"))).toBeNull();
    expect(validateCompanyOverride("Mancipatio Group", percent("12.5"))).toMatch(/22 bytes/);
    expect(validateCompanyOverride("   ", percent("5"))).toBe("Enter the company name.");
    expect(validateCompanyOverride("Bad\u0007Name", percent("5"))).toBe("Remove control characters.");
    expect(validateSymbolOverride("MANCI")).toBeNull();
    expect(validateSymbolOverride("manci")).toMatch(/capital letters/);
    expect(validateSymbolOverride("ABCDEFGHIJ")).toMatch(/At most 9/);
    expect(validateSymbolOverride("AB-C")).toMatch(/capital letters/);
    expect(validateSymbolOverride("ŠEĆ")).toMatch(/capital letters/);
  });

  it("asset IDs: deterministic, ASCII, suffixed for duplicates, ≤ 32 bytes", () => {
    expect(baseAssetId("MANCI", percent("2.5"))).toBe("MANCI-2_5PCT");
    expect(baseAssetId("MANCI", percent("0.0005"))).toBe("MANCI-0_0005PCT");
    const ids = candidateAssetIds("MANCI-5PCT");
    expect(ids).toHaveLength(ASSET_ID_CANDIDATES);
    expect(ids.slice(0, 3)).toEqual(["MANCI-5PCT", "MANCI-5PCT-2", "MANCI-5PCT-3"]);
    expect(ids[ids.length - 1]).toBe("MANCI-5PCT-10");
    const long = candidateAssetIds("A".repeat(32));
    expect(new Set(long).size).toBe(long.length);
    for (const id of long) expect(utf8Bytes(id)).toBeLessThanOrEqual(32);
    expect(percentFromName("Mancipatio 5%")).toBe("5");
    expect(percentFromName("Mancipatio 2.5%")).toBe("2.5");
    expect(percentFromName("Series A")).toBeNull();
    expect(namedPercentE4("Mancipatio 2.50%")).toBe(percent("2.5"));
    expect(namedPercentE4("Mancipatio")).toBeNull();
  });

  it("Advanced edits only the company: the name's percent always follows the share entered", () => {
    // Review: an override fixed at "Mancipatio 5%" while the share became 6 %
    // signed `name: "Mancipatio 5%"` with `maxSupply: 6000`. The percent is
    // now generated, so the same company text gives "… 6%" for 6 %.
    expect(tokenNameFor("Mancipatio", percent("5"))).toBe("Mancipatio 5%");
    expect(tokenNameFor("Mancipatio", percent("6"))).toBe("Mancipatio 6%");
    expect(tokenNameFor("  Acme   Holding ", percent("2.5"))).toBe("Acme Holding 2.5%");
    for (const p of ["5", "6", "0.0001", "12.3456", "100"]) {
      for (const company of ["Mancipatio", "Đurđević", "Acme Holding"]) {
        expect(namedPercentE4(tokenNameFor(company, percent(p))), `${company} ${p}`).toBe(percent(p));
      }
    }
    // A typed percent is refused: the share is added for the issuer.
    expect(validateCompanyOverride("Mancipatio 5%", percent("6"))).toMatch(/Leave out the percent/);
    expect(validateCompanyOverride("Mancipatio 5 %", percent("5"))).toMatch(/Leave out the percent/);
    // The automatic company part re-fits when the percent gets longer.
    expect(deriveTokenCompany("Mancipatio Group", percent("5"))).toBe("Mancipatio Group");
    expect(deriveTokenCompany("Mancipatio Group", percent("12.5"))).toBe("Mancipatio");
  });

  it("the flow signs only a name that states the entered share", () => {
    const flow = src("components/tokenize-shares-flow.tsx");
    expect(flow).not.toContain("nameOverride ?? autoName");
    expect(flow).toContain("tokenNameFor(companyPart, figures.p4)");
    const guard = flow.indexOf("namedPercentE4(intent.name) !== figures.p4");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(flow.indexOf("tx.send("));
  });
});

describe("asset ID choice (uniqueness against existing assets)", () => {
  const create: TokenizeStep = { kind: "create", initMint: true };
  const ids = candidateAssetIds("MANCI-5PCT");
  it("takes the first free ID", () => {
    expect(chooseAssetId(ids, [create])).toEqual({ assetId: "MANCI-5PCT", step: create, skipped: [] });
    expect(chooseAssetId(ids, [{ kind: "done" }, create])?.assetId).toBe("MANCI-5PCT-2");
    const third = chooseAssetId(ids, [{ kind: "conflict", reason: "x" }, { kind: "blocked", reason: "y" }, create]);
    expect(third?.assetId).toBe("MANCI-5PCT-3");
    expect(third?.skipped.map((s) => s.assetId)).toEqual(["MANCI-5PCT", "MANCI-5PCT-2"]);
  });
  it("continues an unfinished asset of the same terms instead of creating another", () => {
    expect(chooseAssetId(ids, [{ kind: "save_profile" }])).toEqual({
      assetId: "MANCI-5PCT",
      step: { kind: "save_profile" },
      skipped: [],
    });
    const later = chooseAssetId(ids, [{ kind: "done" }, { kind: "add_class", initMint: false }])!;
    expect(later.assetId).toBe("MANCI-5PCT-2");
    // Continuing never makes a new asset, so it needs no duplicate confirmation.
    expect(needsDuplicateConfirmation(later)).toBe(false);
    expect(isResumable({ kind: "wait_mint_permission" })).toBe(true);
    expect(isResumable({ kind: "done" })).toBe(false);
  });
  it("a finished, conflicting or blocked base is never suffixed past silently", () => {
    // Review: a 'done' MANCI-5PCT went straight to the wallet as MANCI-5PCT-2.
    const free = chooseAssetId(ids, [create])!;
    expect(needsDuplicateConfirmation(free)).toBe(false);
    for (const existing of [
      { kind: "done" },
      { kind: "conflict", reason: "Class 0 of this asset is capped at a different number of tokens." },
      { kind: "blocked", reason: "Contact the operator." },
    ] as TokenizeStep[]) {
      const next = chooseAssetId(ids, [existing, create])!;
      expect(next.assetId).toBe("MANCI-5PCT-2");
      expect(next.skipped).toEqual([{ assetId: "MANCI-5PCT", step: existing }]);
      expect(needsDuplicateConfirmation(next)).toBe(true);
    }
  });
  it("a confirmation holds only for the ID, name, symbol and cap it was given for", () => {
    const intent = { name: "Mancipatio 5%", symbolPrefix: "MANCI", tokens: B(5_000) };
    const key = duplicateConfirmationKey("MANCI-5PCT-2", intent);
    expect(duplicateConfirmationKey("MANCI-5PCT-2", { ...intent })).toBe(key);
    expect(duplicateConfirmationKey("MANCI-5PCT-3", intent)).not.toBe(key);
    expect(duplicateConfirmationKey("MANCI-5PCT-2", { ...intent, name: "Mancipatio 6%" })).not.toBe(key);
    expect(duplicateConfirmationKey("MANCI-5PCT-2", { ...intent, symbolPrefix: "MANC" })).not.toBe(key);
    expect(duplicateConfirmationKey("MANCI-5PCT-2", { ...intent, tokens: B(500) })).not.toBe(key);
  });
  it("the flow stops before the wallet when another token would be created next to an existing one", () => {
    const flow = src("components/tokenize-shares-flow.tsx");
    const check = flow.indexOf("needsDuplicateConfirmation(picked) && confirmedKey !== key");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(flow.indexOf("buildTokenizeIxs({"));
    expect(check).toBeLessThan(flow.indexOf("tx.send("));
    expect(flow).toContain("Create another {props.pct} % token ({prompt.assetId})");
  });
  it("gives up when every candidate is taken", () => {
    expect(chooseAssetId(ids, ids.map(() => ({ kind: "done" }) as TokenizeStep))).toBeNull();
  });
});

describe("resume decision table (R1–R9)", () => {
  const intent = { name: "Mancipatio 5%", symbolPrefix: "MANCI", tokens: B(5_000) };
  const asset = (over: Partial<AssetSnapshot> = {}): AssetSnapshot => ({
    assetType: AssetType.Equity,
    status: AssetStatus.Draft,
    name: "Mancipatio 5%",
    symbolPrefix: "MANCI",
    // Class 0 and the conversion class (C2), linked: what the flow makes.
    shareClassesCount: 2,
    ...over,
  });
  const sc = (over: Partial<ClassSnapshot> = {}): ClassSnapshot => ({
    classType: ShareClassType.Common,
    maxSupply: B(5_000),
    mintablePostLaunch: false,
    mintInitialized: true,
    rightsBitfield: CLASS_DEFAULTS.rightsBitfield,
    liqPrefMultiplierBps: CLASS_DEFAULTS.liqPrefMultiplierBps,
    liqSeniority: CLASS_DEFAULTS.liqSeniority,
    votingWeight: CLASS_DEFAULTS.votingWeight,
    ...over,
  });
  const step = (over: Partial<Parameters<typeof nextTokenizeStep>[0]>) =>
    nextTokenizeStep({ asset: asset(), sc0: sc(), profileSaved: true, canInitMint: true, intent, marker: "linked", ...over });

  it("R1: no asset → create, with the mint only when allowed", () => {
    expect(step({ asset: null, sc0: null })).toEqual({ kind: "create", initMint: true });
    expect(step({ asset: null, sc0: null, canInitMint: false })).toEqual({ kind: "create", initMint: false });
  });
  it("R2: another type, frozen / wound down, or other name / symbol → conflict", () => {
    expect(step({ asset: asset({ assetType: AssetType.Debt }) }).kind).toBe("conflict");
    expect(step({ asset: asset({ status: AssetStatus.Frozen }) }).kind).toBe("conflict");
    expect(step({ asset: asset({ status: AssetStatus.WoundDown }) }).kind).toBe("conflict");
    expect(step({ asset: asset({ name: "Mancipatio 6%" }) }).kind).toBe("conflict");
    expect(step({ asset: asset({ symbolPrefix: "MAN" }) }).kind).toBe("conflict");
  });
  it("R3: Draft without classes → add the class (and the mint when allowed)", () => {
    expect(step({ asset: asset({ shareClassesCount: 0 }), sc0: null })).toEqual({ kind: "add_class", initMint: true });
    expect(step({ asset: asset({ shareClassesCount: 0 }), sc0: null, canInitMint: false })).toEqual({
      kind: "add_class",
      initMint: false,
    });
  });
  it("R4: Active without classes → blocked (classes only go on a draft)", () => {
    expect(step({ asset: asset({ shareClassesCount: 0, status: AssetStatus.Active }), sc0: null }).kind).toBe("blocked");
  });
  it("R5: class 0 not Common, uncapped, another cap, dilutable, or extra classes → conflict", () => {
    expect(step({ sc0: sc({ classType: ShareClassType.PreferredA }) }).kind).toBe("conflict");
    expect(step({ sc0: sc({ maxSupply: null }) }).kind).toBe("conflict");
    expect(step({ sc0: sc({ maxSupply: B(500) }) }).kind).toBe("conflict");
    expect(step({ sc0: sc({ mintablePostLaunch: true }) }).kind).toBe("conflict");
    expect(step({ asset: asset({ shareClassesCount: 3 }), marker: undefined }).kind).toBe("conflict");
    expect(step({ asset: asset({ shareClassesCount: 2 }), marker: undefined }).kind).toBe("conflict");
    expect(step({ sc0: null }).kind).toBe("conflict");
  });
  it("C2: a draft without the conversion class gets it before the details, the mint wait and done — with or without Conversion", () => {
    const one = { asset: asset({ shareClassesCount: 1 }), marker: "none" as const };
    expect(step({ ...one }).kind).toBe("add_marker");
    expect(step({ ...one, profileSaved: false }).kind).toBe("add_marker");
    expect(step({ ...one, sc0: sc({ mintInitialized: false }), canInitMint: false }).kind).toBe("add_marker");
    // The mint step carries it when this key may create the mint.
    expect(step({ ...one, sc0: sc({ mintInitialized: false }) }).kind).toBe("init_mint");
    // Active: it can no longer be added.
    expect(step({ ...one, asset: asset({ shareClassesCount: 1, status: AssetStatus.Active }) }).kind).toBe("done");
  });
  it("R5: class 0 with other rights, liquidation preference, seniority or voting weight → conflict", () => {
    // Review: a generic-modal "Acme Seed 10%" (1.5x, non-voting, Common,
    // capped) was offered as an unfinished token and its profile rewritten.
    const acme = { intent: null, asset: asset({ name: "Acme Seed 10%" }), profileSaved: false };
    expect(step({ ...acme, sc0: sc({ liqPrefMultiplierBps: 15_000 }) }).kind).toBe("conflict");
    expect(step({ ...acme, sc0: sc({ rightsBitfield: 2 | 32 }) }).kind).toBe("conflict");
    expect(step({ ...acme, sc0: sc({ liqSeniority: 1 }) }).kind).toBe("conflict");
    expect(step({ ...acme, sc0: sc({ votingWeight: 0 }) }).kind).toBe("conflict");
    expect(step({ ...acme, sc0: sc() })).toEqual({ kind: "save_profile" });
    expect(classHasFlowTerms(sc())).toBe(true);
    expect(classHasFlowTerms(sc({ liqPrefMultiplierBps: 15_000 }))).toBe(false);
  });
  it("R6: class ready, no mint, permission → initialize the mint (before the profile)", () => {
    expect(step({ sc0: sc({ mintInitialized: false }) })).toEqual({ kind: "init_mint" });
    expect(step({ sc0: sc({ mintInitialized: false }), profileSaved: false })).toEqual({ kind: "init_mint" });
  });
  it("R7: class ready, no mint, no permission → wait for the Super Admin", () => {
    expect(step({ sc0: sc({ mintInitialized: false }), canInitMint: false })).toEqual({ kind: "wait_mint_permission" });
  });
  it("R8: details missing → save them (also while the mint waits)", () => {
    expect(step({ profileSaved: false })).toEqual({ kind: "save_profile" });
    expect(step({ sc0: sc({ mintInitialized: false }), canInitMint: false, profileSaved: false })).toEqual({
      kind: "save_profile",
    });
  });
  it("R9: everything present → done", () => {
    expect(step({})).toEqual({ kind: "done" });
    expect(step({ asset: asset({ status: AssetStatus.Active }) })).toEqual({ kind: "done" });
  });
  it("without an intent (resume by asset) only the structure is checked", () => {
    expect(step({ intent: null, asset: asset({ name: "Other 7%" }), sc0: sc({ maxSupply: B(7) }) })).toEqual({ kind: "done" });
    expect(looksLikeTokenizeAsset({ assetType: AssetType.Equity, name: "Mancipatio 5%" })).toBe(true);
    expect(looksLikeTokenizeAsset({ assetType: AssetType.Equity, name: "Series A" })).toBe(false);
    expect(looksLikeTokenizeAsset({ assetType: AssetType.Debt, name: "Bond 5%" })).toBe(false);
  });
  it("the flow and the checklist count 'details saved' the same way", () => {
    const flowToken = isFlowToken(asset(), sc());
    expect(flowToken).toBe(true);
    expect(isFlowToken(asset(), null)).toBe(true);
    expect(isFlowToken(asset({ name: "Series A" }), sc())).toBe(false);
    expect(isFlowToken(asset(), sc({ liqPrefMultiplierBps: 15_000 }))).toBe(false);
    expect(isFlowToken(asset(), sc({ maxSupply: null }))).toBe(false);
    // Review: a profile filled in by hand (no fields.tokenize) showed "✓ Details
    // saved" on the checklist while the flow still listed the token as unfinished.
    const handWritten = { fields: { other: 1 } };
    expect(detailsSaved(flowToken, handWritten)).toBe(false);
    expect(step({ profileSaved: detailsSaved(flowToken, handWritten) }).kind).toBe("save_profile");
    expect(detailsSaved(flowToken, { fields: { tokenize: { v: 1 } } })).toBe(true);
    expect(detailsSaved(flowToken, null)).toBe(false);
    // Any other asset: a profile row is enough.
    expect(detailsSaved(false, handWritten)).toBe(true);
    expect(detailsSaved(false, null)).toBe(false);
    const checklist = src("components/tokenize-checklist.tsx");
    expect(checklist).toContain("profileSaved: detailsSaved(tokenizeLike, profile)");
    expect(src("components/asset-detail.tsx")).toContain("profile={profile}");
    expect(src("components/tokenize-shares-flow.tsx")).toContain("profile={resume.profile}");
  });
});

describe("conversion marker (C2): class 1 capped at 0 that class 0 converts into", () => {
  const intent = { name: "Mancipatio 5%", symbolPrefix: "MANCI", tokens: B(5_000) };
  const MARKER_PDA = "Mark1111111111111111111111111111111111111111";
  const asset = (over: Partial<AssetSnapshot> = {}): AssetSnapshot => ({
    assetType: AssetType.Equity,
    status: AssetStatus.Draft,
    name: "Mancipatio 5%",
    symbolPrefix: "MANCI",
    shareClassesCount: 2,
    ...over,
  });
  const sc0 = (over: Partial<ClassSnapshot> = {}): ClassSnapshot => ({
    classType: ShareClassType.Common,
    maxSupply: B(5_000),
    mintablePostLaunch: false,
    mintInitialized: true,
    rightsBitfield: CLASS_DEFAULTS.rightsBitfield,
    liqPrefMultiplierBps: CLASS_DEFAULTS.liqPrefMultiplierBps,
    liqSeniority: CLASS_DEFAULTS.liqSeniority,
    votingWeight: CLASS_DEFAULTS.votingWeight,
    convertibleTo: MARKER_PDA,
    ...over,
  });
  const marker = (over: Partial<ClassSnapshot> = {}): ClassSnapshot => ({
    classType: MARKER_DEFAULTS.classType,
    maxSupply: MARKER_DEFAULTS.maxSupply,
    mintablePostLaunch: false,
    mintInitialized: false,
    rightsBitfield: 0,
    liqPrefMultiplierBps: 10_000,
    liqSeniority: 0,
    votingWeight: 0,
    convertibleTo: null,
    ...over,
  });
  const state = (count: number, c0: ClassSnapshot | null, c1: ClassSnapshot | null) =>
    conversionMarkerState({ shareClassesCount: count, sc0: c0, sc1: c1, sc1Pda: MARKER_PDA });

  it("reads the marker's shape and link", () => {
    expect(isMarkerClass(marker())).toBe(true);
    expect(isMarkerClass(marker({ maxSupply: B(1) }))).toBe(false);
    expect(isMarkerClass(marker({ mintInitialized: true }))).toBe(false);
    expect(isMarkerClass(marker({ maxSupply: null }))).toBe(false);
    expect(state(1, sc0({ convertibleTo: null }), null)).toBe("none");
    expect(state(2, sc0(), marker())).toBe("linked");
    expect(state(2, sc0({ convertibleTo: null }), marker())).toBe("unlinked");
    expect(state(2, sc0({ convertibleTo: "Other111111111111111111111111111111111111111" }), marker())).toBe("foreign");
    expect(state(2, sc0(), marker({ maxSupply: B(100) }))).toBe("foreign");
    expect(state(3, sc0(), marker())).toBe("foreign");
  });

  it("nextTokenizeStep accepts the marker instead of 'conflict' (the review's C2 blocker)", () => {
    const step = (over: Partial<Parameters<typeof nextTokenizeStep>[0]>) =>
      nextTokenizeStep({ asset: asset(), sc0: sc0(), profileSaved: true, canInitMint: true, intent, ...over });
    // Before: shareClassesCount > 1 was always a conflict; it still is without the marker state.
    expect(step({}).kind).toBe("conflict");
    expect(step({ marker: "linked" }).kind).toBe("done");
    expect(step({ marker: "linked", profileSaved: false }).kind).toBe("save_profile");
    expect(step({ marker: "linked", sc0: sc0({ mintInitialized: false }) }).kind).toBe("init_mint");
    expect(step({ marker: "foreign" }).kind).toBe("conflict");
    // Unlinked: linked by whoever may (set_convertible_to has no status check), Draft or Active.
    expect(step({ marker: "unlinked", canConvert: true }).kind).toBe("add_marker");
    expect(step({ marker: "unlinked", canConvert: true, asset: asset({ status: AssetStatus.Active }) }).kind).toBe("add_marker");
    expect(step({ marker: "unlinked", canConvert: false }).kind).toBe("done");
    // A Draft without the marker: offered as one separate transaction (existing Draft assets) —
    // also without Conversion: add_share_class needs only the issuer key, and only a Draft takes it.
    const one = asset({ shareClassesCount: 1 });
    expect(step({ asset: one, marker: "none", canConvert: true }).kind).toBe("add_marker");
    expect(step({ asset: one, marker: "none", canConvert: false }).kind).toBe("add_marker");
    expect(step({ asset: one, marker: "none", canConvert: false, profileSaved: false }).kind).toBe("add_marker");
    // Active: class 1 can no longer be added; nothing to offer.
    expect(step({ asset: asset({ shareClassesCount: 1, status: AssetStatus.Active }), marker: "none", canConvert: true }).kind).toBe("done");
    expect(isResumable({ kind: "add_marker" })).toBe(true);
  });

  it("markerAction: class 1 always rides along while the asset is a draft; the link only with the Conversion permission", () => {
    expect(markerAction({ step: { kind: "create", initMint: true }, marker: "none", draft: true, canConvert: true })).toBe("add_and_link");
    expect(markerAction({ step: { kind: "add_class", initMint: false }, marker: "none", draft: true, canConvert: true })).toBe("add_and_link");
    // Without Conversion, class 1 is still added: once the asset is active it never could be.
    expect(markerAction({ step: { kind: "create", initMint: true }, marker: "none", draft: true, canConvert: false })).toBe("add");
    expect(markerAction({ step: { kind: "add_class", initMint: false }, marker: "none", draft: true, canConvert: false })).toBe("add");
    expect(markerAction({ step: { kind: "init_mint" }, marker: "none", draft: true, canConvert: false })).toBe("add");
    expect(markerAction({ step: { kind: "add_marker" }, marker: "none", draft: true, canConvert: false })).toBe("add");
    expect(markerAction({ step: { kind: "init_mint" }, marker: "none", draft: true, canConvert: true })).toBe("add_and_link");
    expect(markerAction({ step: { kind: "init_mint" }, marker: "linked", draft: true, canConvert: true })).toBeNull();
    expect(markerAction({ step: { kind: "add_marker" }, marker: "unlinked", draft: false, canConvert: true })).toBe("link");
    expect(markerAction({ step: { kind: "add_marker" }, marker: "unlinked", draft: true, canConvert: false })).toBeNull();
    expect(markerAction({ step: { kind: "add_marker" }, marker: "none", draft: false, canConvert: true })).toBeNull();
    expect(markerAction({ step: { kind: "save_profile" }, marker: "none", draft: true, canConvert: true })).toBeNull();
    expect([markerLinks("add_and_link"), markerLinks("link"), markerLinks("add"), markerLinks(null)]).toEqual([true, true, false, false]);
  });

  async function build(kind: "create" | "add_class" | "init_mint" | "add_marker", name = "Mancipatio 5%", assetId = "MANCI-5PCT", symbol = "MANCI", markerAct: "add_and_link" | "add" | "link" | null = "add_and_link", initMint = true, withAdminRecord = true) {
    const signer = await generateKeyPairSigner();
    const issuer = (await generateKeyPairSigner()).address as Address;
    const adminRecord = withAdminRecord ? ((await generateKeyPairSigner()).address as Address) : null;
    const ixs = await buildTokenizeIxs({
      kind, initMint, signer, issuer, assetId, name, symbolPrefix: symbol,
      legalDocHash: new Uint8Array(32).fill(7), tokens: B(5_000), adminRecord, marker: markerAct,
    });
    return { signer, ixs, issuer };
  }

  it("without Conversion (and without Mint), the create transaction still adds class 1 — and needs no permission proof", async () => {
    const bare = await build("create", undefined, undefined, undefined, "add", false, false);
    // create_asset, add_share_class(0), add_share_class(1): no set_convertible_to, no mint.
    expect(bare.ixs).toHaveLength(3);
    expect(bare.ixs[2].data![8]).toBe(1);
    expect(tokenizeTransactionSize(bare.signer.address, bare.ixs)).toBeLessThanOrEqual(TOKENIZE_TX_LIMIT);
    // With Mint: the mint follows class 1, still no link.
    const withMint = await build("create", undefined, undefined, undefined, "add", true);
    expect(withMint.ixs).toHaveLength(4);
    expect(tokenizeTransactionSize(withMint.signer.address, withMint.ixs)).toBeLessThan(949);
    // An existing Draft: class 1 alone, one instruction, no proof needed.
    expect((await build("add_marker", undefined, undefined, undefined, "add", false, false)).ixs).toHaveLength(1);
    // Linking without the proof is refused before anything is signed.
    await expect(build("add_marker", undefined, undefined, undefined, "link", false, false)).rejects.toThrow(/Conversion permission/);
  });

  it("fits in the existing create transaction: 949 B real case, 983 B at the flow's longest name, 1027 B at the program's maxima (≤ 1200 B)", async () => {
    const real = await build("create");
    expect(real.ixs).toHaveLength(5);
    const size = tokenizeTransactionSize(real.signer.address, real.ixs);
    expect(size).toBe(949);
    const longest = await build("create", "Đurđević Šeće 5%", "A".repeat(32), "ABCDEFGHI");
    expect(tokenizeTransactionSize(longest.signer.address, longest.ixs)).toBe(983);
    const max = await build("create", "N".repeat(64), "A".repeat(32), "ABCDEFGHIJ");
    expect(tokenizeTransactionSize(max.signer.address, max.ixs)).toBe(1027);
    // Without the marker it is the 863 B transaction of before.
    const plain = await build("create", "Mancipatio 5%", "MANCI-5PCT", "MANCI", null);
    expect(tokenizeTransactionSize(plain.signer.address, plain.ixs)).toBe(863);
  });

  it("orders the instructions as the program needs them and targets class 1", async () => {
    const { ixs } = await build("create");
    // create_asset, add_share_class(0), add_share_class(1), initialize_share_class_mint, set_convertible_to.
    const [, add0, add1, init, link] = ixs;
    expect(Array.from(add0.data!.slice(0, 8))).toEqual(Array.from(add1.data!.slice(0, 8)));
    expect(add0.data![8]).toBe(0);
    expect(add1.data![8]).toBe(1);
    // set_convertible_to: [authority, admin record, issuer, asset, share_class (class 0, writable), target (class 1)].
    // add_share_class: [authority, platform, issuer, asset, share_class, system].
    expect(link.accounts![4].address).toBe(add0.accounts![4].address);
    expect(link.accounts![5].address).toBe(add1.accounts![4].address);
    expect(init.accounts!.some((a) => a.address === add0.accounts![4].address)).toBe(true);
  });

  it("an existing Draft gets the pair as one separate transaction; a link alone is one instruction", async () => {
    const pair = await build("add_marker");
    expect(pair.ixs).toHaveLength(2);
    expect(tokenizeTransactionSize(pair.signer.address, pair.ixs)).toBeLessThanOrEqual(TOKENIZE_TX_LIMIT);
    expect((await build("add_marker", undefined, undefined, undefined, "link")).ixs).toHaveLength(1);
    await expect(build("add_marker", undefined, undefined, undefined, null)).rejects.toThrow(/No conversion marker/);
    // The mint step carries the pair when the marker is still missing.
    expect((await build("init_mint")).ixs).toHaveLength(3);
  });

  it("the conversion route's requirement is what the marker sets: an on-chain convertible_to", () => {
    const route = src("app/api/conversion/create/route.ts");
    expect(route).toContain("if (!facts.convertibleTo) {");
    expect(src("lib/server/token-holdings.ts")).toContain('shareClass.data.convertibleTo.__option === "Some"');
    const flow = src("components/tokenize-shares-flow.tsx");
    expect(flow).toContain('markerAction({ step: picked.step, marker: "none", draft: true, canConvert })');
    expect(flow).toContain("canConvert: ctx.canConvert");
    expect(flow).toContain("marker: resume.chain.marker");
  });
});

describe("legal document", () => {
  const pdf = { name: "statut.pdf", type: "application/pdf", size: 1000 };
  it("is required on mainnet only", () => {
    expect(legalDocRequired("mainnet")).toBe(true);
    for (const n of ["devnet", "testnet", "localnet"] as const) {
      expect(legalDocRequired(n)).toBe(false);
      expect(legalDocProblem(null, n)).toBeNull();
    }
    expect(legalDocProblem(null, "mainnet")).toMatch(/required on mainnet/);
    expect(legalDocProblem(pdf, "mainnet")).toBeNull();
  });
  it("must be a non-empty PDF of at most 25 MB", () => {
    expect(legalDocProblem({ ...pdf, type: "" }, "mainnet")).toBeNull();
    expect(legalDocProblem({ name: "x.docx", type: "application/msword", size: 10 }, "devnet")).toBe("Choose a PDF file.");
    expect(legalDocProblem({ ...pdf, size: 0 }, "devnet")).toBe("The file is empty.");
    expect(legalDocProblem({ ...pdf, size: LEGAL_DOC_MAX_BYTES + 1 }, "mainnet")).toMatch(/25 MB/);
    expect(LEGAL_DOC_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("company and jurisdiction sources", () => {
  it("prefers the reviewed KYB name, then the issuer profile, then the client record, then the legal ID", () => {
    // Round 2: compliance reviewed the client record's name of an approved
    // KYB; the issuer edits its own profile name freely.
    expect(
      resolveCompany({ profileName: "Edited Name Ltd", clientName: "Mancipatio d.o.o.", clientKybVerified: true, legalId: "L" }),
    ).toEqual({ name: "Mancipatio d.o.o.", source: "kyb" });
    // A KYB still under review does not outrank the profile.
    expect(
      resolveCompany({ profileName: "Mancipatio d.o.o.", clientName: "X", clientKybVerified: false, legalId: "MANCI-5-2026" }),
    ).toEqual({ name: "Mancipatio d.o.o.", source: "issuer_profile" });
    expect(resolveCompany({ profileName: "Mancipatio d.o.o.", clientName: "X", legalId: "MANCI-5-2026" })).toEqual({
      name: "Mancipatio d.o.o.",
      source: "issuer_profile",
    });
    // A verified KYB without a name falls back as before.
    expect(resolveCompany({ profileName: "P", clientName: "  ", clientKybVerified: true, legalId: "L" })).toEqual({
      name: "P",
      source: "issuer_profile",
    });
    expect(resolveCompany({ profileName: " ", clientName: "Client d.o.o.", legalId: "L" })).toEqual({
      name: "Client d.o.o.",
      source: "client",
    });
    expect(resolveCompany({ legalId: "MANCI-5-2026" })).toEqual({ name: "MANCI-5-2026", source: "legal_id" });
  });

  it("the flow reads the KYB decision before it names the company", () => {
    const flow = src("components/tokenize-shares-flow.tsx");
    expect(flow).toContain('clientKybVerified = eligibility?.kybStatus === "verified"');
    expect(flow).toContain("resolveCompany({ profileName, clientName, clientKybVerified, legalId })");
  });
  it("formats the on-chain ISO numeric code, else takes the client's", () => {
    expect(resolveJurisdiction(688)).toBe("688");
    expect(resolveJurisdiction(40)).toBe("040");
    expect(resolveJurisdiction(0, "688")).toBe("688");
    expect(resolveJurisdiction(0, "RS")).toBeNull();
  });
});

describe("profile row (no migration: figures in fields.tokenize)", () => {
  const figures = { p4: B(50_000), granularity: "0.001" as const, tokens: B(5_000), priceCents: B(5_000_000) };
  const base = {
    assetPda: "11111111111111111111111111111111",
    issuerPda: "11111111111111111111111111111112",
    companyName: "Mancipatio d.o.o.",
    companySource: "issuer_profile" as const,
    jurisdiction: "688",
    website: "https://manci.io",
    description: null,
    figures,
    legalDocHex: "ab".repeat(32),
    legalDocSource: "file" as const,
  };

  it("writes plain words, the equity columns and the exact figures", () => {
    const row = buildProfileRow(base);
    expect(row.display_name).toBe("Mancipatio d.o.o. · 5 %");
    expect(row.summary).toBe(
      "5,000 tokens = 5 % of Mancipatio d.o.o. (Serbia). Anyone can hold and transfer them. KYC is needed only to convert them into company shares.",
    );
    expect(row.summary).not.toMatch(/Only verified|KYC\) wallets/);
    expect(row.status).toBe("draft");
    // Round 2: the price is private — never the public share_price column.
    expect(row).not.toHaveProperty("share_price");
    expect(row.has_voting).toBe(true);
    expect(row.convertible).toBe(false);
    expect(row.liquidation_pref_bps).toBe(10_000);
    expect(row.fields).toEqual({
      tokenize: {
        v: 1,
        percent: "5",
        percent_e4: "50000",
        granularity_percent: "0.001",
        tokens: "5000",
        price_total: "50000",
        price_currency: "USD",
        company_name: "Mancipatio d.o.o.",
        company_source: "issuer_profile",
        legal_doc_source: "file",
      },
    });
    expect(hasTokenizeFields(row as never)).toBe(true);
  });

  it("only uses existing asset_profiles columns and sends a plain JSON object as fields", () => {
    const row = buildProfileRow(base);
    const sql = src("supabase/migrations/0014_asset_profiles.sql");
    for (const key of Object.keys(row)) expect(sql, key).toMatch(new RegExp(`\\b${key}\\b`));
    expect(Object.getPrototypeOf(row.fields)).toBe(Object.prototype);
    expect(() => JSON.stringify(row)).not.toThrow();
    expect(JSON.stringify(row).length).toBeLessThan(50_000);
  });

  it("the price is kept as entered (whole stake + currency) in fields.tokenize only", () => {
    for (const priceCents of [B(5_000_000), B(1), null]) {
      const row = buildProfileRow({ ...base, figures: { ...figures, priceCents } });
      expect(row).not.toHaveProperty("share_price");
      expect(row.fields).toMatchObject({
        tokenize: {
          price_total: priceCents === null ? null : formatCents(priceCents),
          price_currency: priceCents === null ? null : "USD",
        },
      });
      expect((row.fields as { tokenize: object }).tokenize).not.toHaveProperty("price_per_token");
    }
    // Nothing in the flow writes it either.
    expect(src("lib/tokenize-shares.ts")).not.toMatch(/generated\.share_price|share_price\s*=/);
    expect(src("components/tokenize-shares-flow.tsx")).not.toContain("share_price");
  });

  it("the website is only what the issuer typed: the private issuer profile's is never copied", () => {
    expect(buildProfileRow({ ...base, website: null }).website).toBeNull();
    expect(buildProfileRow({ ...base, website: "  " }).website).toBeNull();
    expect(buildProfileRow({ ...base, website: "https://manci.io" }).website).toBe("https://manci.io");
    const flow = src("components/tokenize-shares-flow.tsx");
    expect(flow).not.toContain("ctx.website");
    expect(flow).not.toMatch(/p\?\.website/);
    expect(flow).toContain("website: website.trim() || null");
    expect(validateWebsite("")).toBeNull();
    expect(validateWebsite("  ")).toBeNull();
    expect(validateWebsite("https://manci.io")).toBeNull();
    expect(validateWebsite("http://example.com/x")).toBeNull();
    expect(validateWebsite("manci.io")).toMatch(/full address/);
    expect(validateWebsite("javascript:alert(1)")).toMatch(/full address/);
    expect(validateWebsite(`https://a.io/${"x".repeat(WEBSITE_MAX_CHARS)}`)).toMatch(/At most/);
  });

  it("keeps an existing row's status and other fields; no price → no share_price", () => {
    const row = buildProfileRow({
      ...base,
      figures: { ...figures, priceCents: null },
      existing: { fields: { other: 1 } },
    });
    expect("status" in row).toBe(false);
    expect("share_price" in row).toBe(false);
    expect(row.fields).toMatchObject({ other: 1, tokenize: { price_total: null, price_currency: null } });
  });

  it("an existing profile without tokenize keeps website, summary and every other filled column", () => {
    // Review: resume "Save details" replaced a hand-written website with the
    // issuer profile's (or null), and the summary and display name with generated text.
    const existing = {
      category: "equity" as const,
      display_name: "Mancipatio — seed round",
      summary: "Our own summary.",
      description: "Our own description.",
      website: "https://mancipatio.example",
      jurisdiction: "040",
      legal_doc_sha256: "cd".repeat(32),
      has_voting: false,
      convertible: null,
      liquidation_pref_bps: null,
      share_price: 12,
      fields: { other: 1 },
    };
    const row = buildProfileRow({ ...base, website: null, description: "typed", existing });
    expect(row).not.toHaveProperty("display_name");
    expect(row).not.toHaveProperty("summary");
    expect(row).not.toHaveProperty("description");
    expect(row).not.toHaveProperty("website");
    expect(row).not.toHaveProperty("jurisdiction");
    expect(row).not.toHaveProperty("legal_doc_sha256");
    expect(row).not.toHaveProperty("has_voting");
    expect(row).not.toHaveProperty("share_price");
    expect(row).not.toHaveProperty("status");
    // Only the empty columns are filled, and the figures are added.
    expect(row.convertible).toBe(false);
    expect(row.liquidation_pref_bps).toBe(10_000);
    expect(row.fields).toMatchObject({ other: 1, tokenize: { percent: "5", tokens: "5000" } });
    // A blank existing column counts as empty; a blank generated value never clears one.
    const blank = buildProfileRow({ ...base, website: null, existing: { ...existing, website: " ", summary: null } });
    expect(blank).not.toHaveProperty("website");
    expect(blank.summary).toMatch(/^5,000 tokens = 5 % of Mancipatio d\.o\.o\./);
    // The category of an existing row is kept.
    expect(buildProfileRow({ ...base, existing: { ...existing, category: "startup" as never } }).category).toBe("startup");
  });

  it("the equity columns follow class 0 on chain, not the flow's defaults", () => {
    const row = buildProfileRow({ ...base, classTerms: { rightsBitfield: 2 | 4 | 8, liqPrefMultiplierBps: 15_000 } });
    expect(row.has_voting).toBe(false);
    expect(row.convertible).toBe(true);
    expect(row.liquidation_pref_bps).toBe(15_000);
    const defaults = buildProfileRow(base);
    expect(defaults.has_voting).toBe(true);
    expect(defaults.convertible).toBe(false);
    const flow = src("components/tokenize-shares-flow.tsx");
    expect(flow).toContain("classTerms: resume.chain.sc0 ?? CLASS_DEFAULTS");
    expect(flow).not.toContain("resume.profile?.description || null");
  });

  it("summary leaves an unknown country out", () => {
    expect(summaryText({ companyName: "X", jurisdiction: null, p4: B(10), tokens: B(1) })).toBe(
      "1 tokens = 0.001 % of X. Anyone can hold and transfer them. KYC is needed only to convert them into company shares.",
    );
  });

  it("the Preview says what the stored summary says: Open, KYC only at conversion", () => {
    expect(OPEN_TOKEN_NOTE).toBe("Anyone can hold and transfer it. KYC is needed only to convert it into company shares.");
    const flow = src("components/tokenize-shares-flow.tsx");
    expect(flow).toContain("<li>{OPEN_TOKEN_NOTE}</li>");
    // Nothing is minted up front: tokens are created when they are sent or sold (design §1).
    expect(supplyCapLine(B(5_000))).toBe("Supply capped at 5,000 — tokens are created only when you send or sell them");
    expect(flow).toContain("<li>{supplyCapLine(figures.tokens)}</li>");
    expect(flow).not.toContain("locked for good after minting");
    expect(NEXT_STEP_LINE).toBe("Next: the operator activates the asset → then choose how to distribute the tokens.");
    expect(flow).toContain("{NEXT_STEP_LINE}");
    for (const file of ["components/tokenize-shares-flow.tsx", "components/tokenize-checklist.tsx", "lib/tokenize-shares.ts"]) {
      const text = src(file);
      expect(text, file).not.toContain("Only verified (KYC)");
      expect(text, file).not.toContain("turns on KYC-only");
      expect(text, file).not.toContain("Set KYC-only");
    }
    expect(src("components/treasury-mint-panel.tsx")).not.toContain("receiver-KYC gated");
  });

  it("the canonical hash input matches the Create-asset modal's field set and order", () => {
    const keys = Object.keys(
      JSON.parse(
        canonicalProfileHashInput({
          assetId: "A",
          name: "n",
          symbolPrefix: "S",
          displayName: "d",
          summary: "s",
          description: "",
          website: "",
          jurisdiction: null,
          fields: {},
        }),
      ),
    );
    expect(keys).toEqual([
      "assetId", "category", "name", "symbolPrefix", "displayName", "summary", "description", "website", "jurisdiction", "fields",
    ]);
    const modal = src("components/asset-create-modal.tsx");
    const block = modal.slice(modal.indexOf("const canonical = JSON.stringify({"), modal.indexOf("legalDocHash = await sha256Bytes(new TextEncoder()"));
    const order = keys.map((k) => block.indexOf(`${k}:`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("checklist after creation: created → details → activate → distribute → close", () => {
  const fresh: Parameters<typeof checklistItems>[0] = {
    classExists: true,
    mintInitialized: true,
    profileSaved: true,
    active: false,
    issuerVerified: true,
    hookMode: "open",
    maxSupply: B(5_000),
    lifetimeMinted: B(0),
    treasuryBalance: B(0),
    supplyLocked: false,
    openSalesOfClass: 0,
  };
  const states = (over: Partial<typeof fresh> = {}) =>
    Object.fromEntries(checklistItems({ ...fresh, ...over }).map((i) => [i.id, i.state]));

  it("right after creation: activation open, distribution waits; there is no KYC-only or mint step", () => {
    expect(states()).toEqual({ created: "done", details: "done", activate: "todo", distribute: "blocked", close: "blocked" });
    expect(checklistItems(fresh).map((i) => i.id)).toEqual(["created", "details", "activate", "distribute", "close"]);
  });
  it("Distribute opens with activation, the issuer's KYB and a readable hook — not with pause bit 0x02", () => {
    expect(states({ active: true }).distribute).toBe("todo");
    expect(states({ active: true, hookMode: "kyc-gated" }).distribute).toBe("todo");
    expect(states({ active: true, hookMode: "none" }).distribute).toBe("blocked");
    expect(states({ active: true, issuerVerified: false }).distribute).toBe("blocked");
    expect(states({ active: true, mintInitialized: false }).distribute).toBe("blocked");
    expect(Object.keys(fresh)).not.toContain("primaryPaused");
  });
  it("Distribute is done only when everything that can exist was created and left the treasury", () => {
    const all = { active: true, lifetimeMinted: B(5_000) };
    expect(states({ ...all, treasuryBalance: B(0) }).distribute).toBe("done");
    expect(states({ ...all, treasuryBalance: B(1) }).distribute).toBe("todo");
    expect(states({ ...all, treasuryBalance: null }).distribute).toBe("todo");
    // Part created, the rest still possible: still to do.
    expect(states({ active: true, lifetimeMinted: B(3_000), treasuryBalance: B(0) }).distribute).toBe("todo");
    // A sold-out sale still Open is not done: its proceeds are collected from Distribute.
    expect(states({ ...all, treasuryBalance: B(0), openSalesOfClass: 1 }).distribute).toBe("todo");
    // Locked after a partial distribution with an empty treasury: done.
    expect(states({ active: true, lifetimeMinted: B(3_000), treasuryBalance: B(0), supplyLocked: true }).distribute).toBe("done");
    expect(distributeDoneText({ lifetimeMinted: B(5_000), supplyLocked: false })).toBe("All 5,000 tokens are created and sent.");
    expect(distributeDoneText({ lifetimeMinted: B(3_000), supplyLocked: true })).toBe("3,000 tokens created and sent; supply locked.");
  });
  it("Close is the optional one-way lock: after a distribution, never while a sale of the class is open or on its way", () => {
    const sent = { active: true, lifetimeMinted: B(100) };
    expect(states(sent).close).toBe("todo");
    expect(states({ ...sent, openSalesOfClass: 1 }).close).toBe("blocked");
    expect(states({ ...sent, openSalesOfClass: null }).close).toBe("blocked");
    expect(states({ ...sent, pendingSaleOfClass: true }).close).toBe("blocked");
    expect(states({ ...sent, supplyLocked: true }).close).toBe("done");
    expect(closeText({ ...fresh, ...sent }, true)).toMatch(/^Optional, after the last distribution: locks the supply for good/);
    expect(closeText({ ...fresh, ...sent }, false)).toMatch(/after the last distribution: the operator can lock/);
    expect(closeText({ ...fresh, ...sent, openSalesOfClass: 2 }, true)).toBe("Not while a sale of this class is open.");
    expect(closeText({ ...fresh, ...sent, pendingSaleOfClass: true }, true)).toMatch(/approved or requested and not opened yet/);
    expect(closeText({ ...fresh, ...sent, openSalesOfClass: null }, true)).toMatch(/Could not check this class's sales/);
    expect(closeText(fresh, true)).toBe("After the asset is active.");
  });
  it("Close waits for the first distribution; a lock at 0 is only offered apart (explicit confirmation)", () => {
    const nothing = { ...fresh, active: true };
    expect(states({ active: true }).close).toBe("blocked");
    expect(lockAtZeroOffered(nothing)).toBe(true);
    expect(closeText(nothing, true)).toMatch(/^After the first distribution\. Locking now would fix the supply at 0/);
    expect(closeText(nothing, false)).toMatch(/^After the first distribution: the operator can then lock/);
    // Not offered once something was created, while a sale is open or on its way, or before activation.
    expect(lockAtZeroOffered({ ...nothing, lifetimeMinted: B(1) })).toBe(false);
    expect(lockAtZeroOffered({ ...nothing, openSalesOfClass: 1 })).toBe(false);
    expect(lockAtZeroOffered({ ...nothing, pendingSaleOfClass: true })).toBe(false);
    expect(lockAtZeroOffered(fresh)).toBe(false);
    expect(lockAtZeroOffered({ ...nothing, supplyLocked: true })).toBe(false);
  });
  it("without a mint creation is still to do", () => {
    expect(states({ mintInitialized: false })).toMatchObject({ created: "todo", activate: "todo", distribute: "blocked" });
    expect(states({ classExists: false, mintInitialized: false })).toMatchObject({ activate: "blocked", distribute: "blocked" });
  });
  it("says what Distribute waits for; the 0x02 note belongs to the panel and names who must act", () => {
    expect(distributeWaitText(fresh)).toBe("After the operator activates the asset.");
    expect(distributeWaitText({ ...fresh, active: true, mintInitialized: false })).toBe("After the token mint exists.");
    expect(distributeWaitText({ ...fresh, issuerVerified: false })).toBe(
      "After the operator activates the asset and your company's KYB is verified.",
    );
    expect(distributeWaitText({ ...fresh, active: true, hookMode: "none" })).toMatch(/no transfer-hook config/);
    expect(distributeWaitText({ ...fresh, active: true })).toBeNull();
    for (const over of [{}, { active: true }]) expect(distributeWaitText({ ...fresh, ...over }) ?? "").not.toMatch(/KYC-only|0x02/);
    expect(primaryPausedNote("8TEmAbCdEfGhIjKlMnOpQrStUvWxYz1234567890abc")).toMatch(
      /^Creating tokens is paused platform-wide \(Primary issuance, bit 0x02\)\. Only the super admin \(8TEm…0abc\) can reopen it;/,
    );
    expect(primaryPausedNote(null)).toContain("Only the super admin can reopen it");
  });
  it("the checklist counts from lifetime_minted, hosts Distribute and Close, and says Open or KYC-only", () => {
    expect(KYC_GATED_NOTE).toMatch(/^KYC-only: holders need a KYC passport/);
    expect(OPEN_CLASS_LINE).toBe("Open to any wallet ✓");
    const checklist = src("components/tokenize-checklist.tsx");
    expect(checklist).toContain('hook === "kyc-gated" && <p');
    expect(checklist).toContain('hook === "open" && <p');
    expect(checklist).not.toContain("Operator: KYC-only");
    expect(checklist).not.toMatch(/kycGated:/);
    expect(checklist).toContain("distributeWaitText(facts)");
    expect(checklist).toContain("<DistributeCard");
    expect(checklist).toContain("<LockSupplyButton");
    // Review: remaining used to be maxSupply − circulating, which a conversion burn reopens.
    expect(checklist).toContain("remainingFromLifetime(maxSupply, lifetimeMinted)");
    expect(checklist).not.toMatch(/maxSupply\s*-\s*circulating/);
    expect(checklist).not.toContain("defaultUnits");
    expect(checklist).not.toContain("<TreasuryMintPanel");
  });
});

describe("create() re-checks its preconditions before building the transaction", () => {
  const pdf = { name: "statut.pdf", type: "application/pdf", size: 1000 };
  const ok = { network: "mainnet" as const, file: pdf, kybVerified: true, onboardingPaused: null };
  it("refuses an unverified KYB, the onboarding pause and a missing mainnet legal document", () => {
    expect(tokenizeCreateBlocker(ok)).toBeNull();
    expect(tokenizeCreateBlocker({ ...ok, kybVerified: false })).toBe("Your company's KYB must be verified first.");
    expect(tokenizeCreateBlocker({ ...ok, onboardingPaused: "Onboarding is paused." })).toBe("Onboarding is paused.");
    expect(tokenizeCreateBlocker({ ...ok, file: null })).toMatch(/required on mainnet/);
    expect(tokenizeCreateBlocker({ ...ok, file: { ...pdf, name: "x.docx", type: "application/msword" } })).toBe(
      "Choose a PDF file.",
    );
    // Off mainnet the document stays optional.
    expect(tokenizeCreateBlocker({ ...ok, network: "devnet", file: null })).toBeNull();
    // KYB first, then the pause, then the document.
    expect(tokenizeCreateBlocker({ network: "mainnet", file: null, kybVerified: false, onboardingPaused: "P" })).toMatch(/KYB/);
    expect(tokenizeCreateBlocker({ network: "mainnet", file: null, kybVerified: true, onboardingPaused: "P" })).toBe("P");
  });
  it("create() reads the KYB and the pause flags fresh and refuses before any build or send", () => {
    const flow = src("components/tokenize-shares-flow.tsx");
    const body = flow.slice(flow.indexOf("async function create("), flow.indexOf("// ── Continue an unfinished token ──"));
    const guard = body.indexOf("if (blocker) throw new Error(blocker);");
    expect(guard).toBeGreaterThan(-1);
    expect(body.indexOf("issuerKybVerified(rpc, ctx.issuerPda)")).toBeLessThan(guard);
    expect(body.indexOf("readPauseFlags(rpc)")).toBeLessThan(guard);
    expect(body).toContain("pausedFlowFor(flagsNow, AssetRegistryInstruction.CreateAsset)");
    for (const later of ["pickTokenizeAssetId(", "buildTokenizeIxs({", "simulateTokenize(", "tx.send("]) {
      expect(body.indexOf(later), later).toBeGreaterThan(guard);
    }
  });
});

describe("resume prefill", () => {
  const draft = { v: 1 as const, percent: "2.5", granularity: "0.01" as const, price: "100", description: "d", legalDocSource: "file" as const, savedAt: "x" };
  it("prefers this browser's draft, then the saved figures", () => {
    expect(resumePrefill({ assetName: "Mancipatio 5%", cap: B(5_000), tokenize: null, draft })).toEqual({
      percent: "2.5", granularity: "0.01", price: "100", description: "d",
    });
    expect(
      resumePrefill({ assetName: "Mancipatio 5%", cap: B(500), tokenize: { percent: "5", granularity_percent: "0.01", price_total: "9" }, draft: null }),
    ).toEqual({ percent: "5", granularity: "0.01", price: "9" });
  });
  it("without either, reads the percent from the name and picks the token size that matches the cap", () => {
    expect(resumePrefill({ assetName: "Mancipatio 5%", cap: B(5_000), tokenize: null, draft: null })).toEqual({ percent: "5", granularity: "0.001" });
    expect(resumePrefill({ assetName: "Mancipatio 5%", cap: B(500), tokenize: null, draft: null })).toEqual({ percent: "5", granularity: "0.01" });
    expect(resumePrefill({ assetName: "Mancipatio 5%", cap: null, tokenize: null, draft: null })).toEqual({ percent: "5", granularity: undefined });
    expect(resumePrefill({ assetName: "Series A", cap: B(7), tokenize: null, draft: null })).toEqual({});
  });
});

describe("share figures (new and resumed tokens)", () => {
  const fig = (over: Partial<Parameters<typeof shareFigures>[0]>) =>
    shareFigures({ cap: null, namedP4: null, granularity: g(DEFAULT_GRANULARITY), percentInput: "", ...over });

  it("a new token: the typed percent at the chosen size", () => {
    expect(fig({ percentInput: "5" })).toEqual({ ok: true, p4: percent("5"), tokens: B(5_000), warning: null });
    expect(fig({ percentInput: "0.0005" }).ok).toBe(false);
    expect(fig({ percentInput: "" }).ok).toBe(false);
  });

  it("a resumed class whose name fits the cap: the matching token size is enforced", () => {
    const named = { cap: B(5_000), namedP4: percent("5") };
    expect(fig({ ...named, granularity: g("0.001") })).toEqual({ ok: true, p4: percent("5"), tokens: B(5_000), warning: null });
    const wrong = fig({ ...named, granularity: g("0.01") });
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.error).toMatch(/named for 5 %\. Choose the matching token size/);
    expect(wrong.warning).toBeNull();
  });

  it("a name that fits the cap at no token size warns and falls back to the cap (never blocked for good)", () => {
    // Review: "Mancipatio 5%" with maxSupply 6000 is 60 / 6 / 0.6 %, never 5 %,
    // so 'Save details' stayed disabled at every token size.
    const stuck = { cap: B(6_000), namedP4: percent("5") };
    const expected = { "0.01": "60", "0.001": "6", "0.0001": "0.6" } as const;
    for (const size of GRANULARITIES) {
      const r = fig({ ...stuck, granularity: size });
      expect(r.ok, size.id).toBe(true);
      expect(r.ok && formatPercent(r.p4)).toBe(expected[size.id]);
      expect(r.ok && r.tokens).toBe(B(6_000));
      expect(r.warning).toMatch(/name says 5 %, but its 6,000 tokens are not 5 % at any token size/);
    }
    // Nothing recorded the size, so it is not defaulted (resumePrefill finds no match).
    expect(resumePrefill({ assetName: "Mancipatio 5%", cap: B(6_000), tokenize: null, draft: null }).granularity).toBeUndefined();
    const unchosen = fig({ ...stuck, granularity: null });
    expect(unchosen.ok).toBe(false);
    expect(!unchosen.ok && unchosen.error).toMatch(/Choose the token size these 6,000 tokens were created with/);
    expect(unchosen.warning).not.toBeNull();
  });

  it("a name without a percent and no draft: the token size must be chosen, not defaulted to 0.001 %", () => {
    // Review: resumed in another browser, the default size could save a wrong percent.
    expect(resumePrefill({ assetName: "Mancipatio Seed", cap: B(5_000), tokenize: null, draft: null })).toEqual({});
    const r = fig({ cap: B(5_000), namedP4: null, granularity: null });
    expect(r.ok).toBe(false);
    expect(fig({ cap: B(5_000), namedP4: null, granularity: g("0.01") })).toMatchObject({ ok: true, p4: percent("50") });
    const flow = src("components/tokenize-shares-flow.tsx");
    expect(flow).toContain("(resumeAssetPda && fixedTokens !== null ? null : DEFAULT_GRANULARITY)");
  });

  it("a resumed asset without a class: the typed percent must be the one in the name", () => {
    expect(fig({ namedP4: percent("5"), percentInput: "6" }).ok).toBe(false);
    expect(fig({ namedP4: percent("5"), percentInput: "5" })).toMatchObject({ ok: true, tokens: B(5_000) });
  });

  it("more than 100 % at a size is refused", () => {
    const r = fig({ cap: B(20_000), granularity: g("0.01") });
    expect(!r.ok && r.error).toMatch(/more than 100 %/);
  });
});

describe("local draft", () => {
  it("round-trips and refuses malformed input", () => {
    const d = { v: 1, percent: "5", granularity: "0.001", price: "", description: "", legalDocSource: "file", savedAt: "x" };
    expect(parseDraft(JSON.stringify(d))).toEqual(d);
    expect(parseDraft(JSON.stringify({ ...d, granularity: "0.5" }))).toBeNull();
    // Advanced → Website rides along; drafts saved before it still parse.
    expect(parseDraft(JSON.stringify({ ...d, website: "https://manci.io" }))).toEqual({ ...d, website: "https://manci.io" });
    expect(parseDraft(JSON.stringify({ ...d, website: 5 }))).toBeNull();
    const withWebsite = parseDraft(JSON.stringify({ ...d, website: "https://manci.io" }));
    expect(resumePrefill({ assetName: "Mancipatio 5%", cap: B(5_000), tokenize: null, draft: withWebsite })).toMatchObject({
      website: "https://manci.io",
    });
    expect(resumePrefill({ assetName: "Mancipatio 5%", cap: B(5_000), tokenize: null, draft: parseDraft(JSON.stringify(d)) })).not.toHaveProperty("website");
    expect(parseDraft("{")).toBeNull();
    expect(parseDraft(null)).toBeNull();
    expect(draftKey("mainnet", "Abc")).toBe("mancipatio:tokenize:v1:mainnet:Abc");
  });
});

describe("batched transaction (create_asset + add_share_class + initialize_share_class_mint)", () => {
  async function ixsFor(assetId: string, name: string, symbolPrefix: string, kind: "create" | "add_class" | "init_mint" = "create", initMint = true) {
    const signer = await generateKeyPairSigner();
    const issuer = (await generateKeyPairSigner()).address as Address;
    const adminRecord = (await generateKeyPairSigner()).address as Address;
    const ixs = await buildTokenizeIxs({
      kind,
      initMint,
      signer,
      issuer,
      assetId,
      name,
      symbolPrefix,
      legalDocHash: new Uint8Array(32).fill(7),
      tokens: B(5_000),
      adminRecord,
    });
    return { signer, ixs };
  }

  it("the real case fits in one transaction with room to spare", async () => {
    const { signer, ixs } = await ixsFor("MANCI-5PCT", "Mancipatio 5%", "MANCI");
    expect(ixs).toHaveLength(3);
    const size = tokenizeTransactionSize(signer.address, ixs);
    expect(TOKENIZE_TX_LIMIT).toBe(1200);
    expect(size).toBeLessThan(900);
  });

  it("the flow's longest asset ID, name and symbol still fit (≤ 1200 B, so ≤ 1232 B once sent)", async () => {
    const name = "Đurđević Šeće 5%";
    expect(utf8Bytes(name)).toBe(MAX_TOKEN_NAME_BYTES);
    const { signer, ixs } = await ixsFor("A".repeat(32), name, "ABCDEFGHI");
    expect(tokenizeTransactionSize(signer.address, ixs)).toBeLessThanOrEqual(TOKENIZE_TX_LIMIT);
    // Even the program's own maxima (64-byte name, 10-byte prefix) fit.
    const max = await ixsFor("A".repeat(32), "N".repeat(64), "ABCDEFGHIJ");
    expect(tokenizeTransactionSize(max.signer.address, max.ixs)).toBeLessThanOrEqual(TOKENIZE_TX_LIMIT);
  });

  it("builds the right instructions per step and needs the permission proof for the mint", async () => {
    expect((await ixsFor("X", "X 5%", "X", "create", false)).ixs).toHaveLength(2);
    expect((await ixsFor("X", "X 5%", "X", "add_class", true)).ixs).toHaveLength(2);
    expect((await ixsFor("X", "X 5%", "X", "add_class", false)).ixs).toHaveLength(1);
    expect((await ixsFor("X", "X 5%", "X", "init_mint", false)).ixs).toHaveLength(1);
    const signer = await generateKeyPairSigner();
    await expect(
      buildTokenizeIxs({
        kind: "init_mint",
        initMint: false,
        signer,
        issuer: signer.address,
        assetId: "X",
        name: "X",
        symbolPrefix: "X",
        legalDocHash: new Uint8Array(32),
        tokens: B(1),
        adminRecord: null,
      }),
    ).rejects.toThrow(/Mint permission/);
  });

  it("uses the program defaults: Equity, Common, capped, not dilutable, P2P on", async () => {
    expect(assetDefaults()).toMatchObject({ assetType: AssetType.Equity, jurisdictionRules: { maxHolders: 0, allowP2p: true } });
    expect(assetDefaults().jurisdictionRules.allowedCountries).toHaveLength(128);
    expect(CLASS_DEFAULTS).toMatchObject({
      classIndex: 0,
      classType: ShareClassType.Common,
      liqPrefMultiplierBps: 10_000,
      votingWeight: 1,
      mintablePostLaunch: false,
    });
  });

  it("compiles the unsigned simulation transaction from the same instructions", async () => {
    const { signer, ixs } = await ixsFor("MANCI-5PCT", "Mancipatio 5%", "MANCI");
    const wire = simulationWire(signer.address, ixs);
    expect(getBase64Encoder().encode(wire).length).toBeLessThanOrEqual(1232);
  });
});

describe("surfaces", () => {
  it("/issuer/share-classes: accurate minting guidance and an explicit uncapped confirmation", () => {
    const page = src("app/issuer/share-classes/page.tsx");
    expect(page).not.toContain("Manci team mints");
    expect(page).toContain("Admin issuers mint on");
    expect(page).toContain("pause bit 0x02");
    expect(page).toMatch(/Lock supply after minting — it\s+is one-way/);
    expect(page).toContain("const [confirmUncapped, setConfirmUncapped] = useState(false);");
    expect(page).toContain("No cap: more units can be minted later (unlimited supply)");
    expect(page).toContain("(uncappedNeedsConfirm && !confirmUncapped)");
    // Round 2: the "Mint permission required" branch no longer promises that
    // the issuer mints its own class; treasury minting needs an Admin key.
    const required = page.slice(page.indexOf("Mint permission required"), page.indexOf("Mint ready"));
    expect(required).not.toContain("mints its own class");
    expect(required).not.toContain("no global admin role is required");
    expect(required).toContain("Manci Admin issuer");
    expect(required).toContain("approved sale");
    expect(page).not.toMatch(/KYC-only|KycGated/);
  });

  it("one copy of the treasury mint: the admin panel and Send to wallets both run lib/treasury-mint", () => {
    const page = src("app/admin/share-classes/page.tsx");
    expect(page).toContain("<TreasuryMintPanel");
    expect(page).not.toContain("reserveTreasuryMint(");
    const lib = src("lib/treasury-mint.ts");
    expect(lib.indexOf("reserveTreasuryMint(")).toBeGreaterThan(-1);
    expect(lib.indexOf("reserveTreasuryMint(")).toBeLessThan(lib.indexOf("buildTreasuryMintIxs({"));
    expect(lib).toContain("releaseWhenExpired(");
    expect(lib).toContain("TREASURY_MINT_REASON_MIN = 5");
    for (const file of ["components/treasury-mint-panel.tsx", "components/send-to-wallets-panel.tsx"]) {
      const text = src(file);
      expect(text, file).toContain("runTreasuryMint({");
      expect(text, file).not.toContain("reserveTreasuryMint(");
      expect(text, file).not.toContain("getMintToTreasuryInstructionAsync(");
    }
    expect(src("components/treasury-mint-panel.tsx")).toContain("reasonMinLength={TREASURY_MINT_REASON_MIN}");
  });

  it("issuer entry points lead to the one-screen flow; the generic modal stays as 'Other asset types'", () => {
    const home = src("app/issuer/page.tsx");
    expect(home).toContain('href="/issuer/assets/tokenize"');
    expect(home).toContain("Tokenize company shares");
    expect(home).toContain("Other asset types");
    const assets = src("app/issuer/assets/page.tsx");
    expect(assets).toContain('href="/issuer/assets/tokenize"');
    expect(assets).toContain("<AssetCreateModal");
    expect(src("app/issuer/assets/tokenize/page.tsx")).toContain("<TokenizeSharesFlow");
  });

  it("the flow simulates and waits for finality before it writes the profile", () => {
    const flow = src("components/tokenize-shares-flow.tsx");
    expect(flow.indexOf("simulateTokenize(")).toBeGreaterThan(-1);
    expect(flow.indexOf("assertTokenizeFits(")).toBeLessThan(flow.indexOf("tx.send("));
    expect(flow.indexOf("simulateTokenize(")).toBeLessThan(flow.indexOf("tx.send("));
    expect(flow).toContain("waitForFinalizedAsset(");
    expect(flow).toContain("pickTokenizeAssetId(");
  });
});
