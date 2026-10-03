// "Tokenize company shares" — the one-screen issuer flow (owner request
// 2026-10-03: "as simple and clear as possible, with as little input as
// possible"). The issuer types the share of the company, attaches the legal
// document and optionally a price; everything else is derived here.
//
// Pure helpers only (no React, no RPC, no storage), covered by
// tests/tokenize-shares.test.ts:
//   * exact percent → token math (BigInt, never floats);
//   * the on-chain name / symbol / asset-ID derivation and their BYTE limits:
//     the program measures UTF-8 bytes, and š, ć, č, ž, đ are two bytes each;
//   * the resume decision: which step comes next for an asset that may already
//     exist, so a failed second signature continues instead of duplicating;
//   * the off-chain profile row and the operator checklist.
// Chain side (instructions, size, simulation, reads): lib/tokenize-shares-chain.ts.
// Screen: components/tokenize-shares-flow.tsx, app/issuer/assets/tokenize.

import {
  AssetStatus,
  AssetType,
  ShareClassType,
} from "@/lib/generated/asset_registry";
import type { AssetProfile, NewAssetProfile } from "@/lib/asset-profiles";
import { countryName } from "@/lib/countries";
import { JURISDICTION_BITMAP_BYTES } from "@/lib/jurisdiction-bitmap";
import type { Network } from "@/lib/network";
import { U64_MAX } from "@/lib/vesting-terms";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

// ── Percent and token math ──────────────────────────────────────────────────
//
// A percent is held as `p4`: an integer count of 0.0001 % (so 5 % = 50 000 and
// 100 % = 1 000 000). A token size ("1 token = 0.001 %") is the same unit, so
// tokens = p4 / size, and a percent that is not a whole multiple of the token
// size is refused rather than rounded.

/** 0.0001 % steps: the finest share the flow accepts. */
export const PERCENT_DECIMALS = 4;
export const HUNDRED_PERCENT_E4 = BigInt(1_000_000);

export type GranularityId = "0.01" | "0.001" | "0.0001";
export type Granularity = { id: GranularityId; e4: bigint };

/** How much of the company one token is. The middle one is the default. */
export const GRANULARITIES: readonly Granularity[] = [
  { id: "0.01", e4: BigInt(100) },
  { id: "0.001", e4: BigInt(10) },
  { id: "0.0001", e4: BigInt(1) },
];
export const DEFAULT_GRANULARITY: GranularityId = "0.001";

export function granularityById(id: string | null | undefined): Granularity | undefined {
  return GRANULARITIES.find((g) => g.id === id);
}

export function granularityLabel(id: GranularityId): string {
  return `1 token = ${id} %`;
}

/**
 * "5", "2.5", "0.125 %" → p4. Strict: ASCII digits and one "." only (a ","
 * gets a hint), at most 4 decimals, more than 0 and at most 100.
 */
export function parsePercent(input: string): Parsed<bigint> {
  const s = input.trim().replace(/\s*%$/, "");
  if (!s) return fail("Enter the share of the company, e.g. 5.");
  if (s.includes(",")) return fail('Use "." for decimals, e.g. 2.5.');
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return fail("Enter a number, e.g. 5 or 2.5.");
  if (s.endsWith(".")) return fail('Remove the trailing "." or add digits.');
  const whole = (m[1] || "0").replace(/^0+(?=\d)/, "");
  if (whole.length > 3) return fail("The share cannot be more than 100 %.");
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > PERCENT_DECIMALS) {
    return fail("Use at most 4 decimals (the smallest step is 0.0001 %).");
  }
  const p4 = BigInt(whole + frac.padEnd(PERCENT_DECIMALS, "0"));
  if (p4 <= BigInt(0)) return fail("The share must be more than 0 %.");
  if (p4 > HUNDRED_PERCENT_E4) return fail("The share cannot be more than 100 %.");
  return ok(p4);
}

/** p4 → "5", "2.5", "0.0005" (no float, no trailing zeros). */
export function formatPercent(p4: bigint): string {
  if (p4 < BigInt(0)) throw new Error("Negative percent");
  const padded = p4.toString().padStart(PERCENT_DECIMALS + 1, "0");
  const whole = padded.slice(0, -PERCENT_DECIMALS);
  const frac = padded.slice(-PERCENT_DECIMALS).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Whole tokens for `p4` at token size `g`; refuses a remainder and u64 overflow. */
export function tokensFor(p4: bigint, g: Pick<Granularity, "e4">): Parsed<bigint> {
  if (g.e4 <= BigInt(0)) throw new Error("Token size must be positive");
  if (p4 <= BigInt(0)) return fail("The share must be more than 0 %.");
  if (p4 % g.e4 !== BigInt(0)) {
    const size = formatPercent(g.e4);
    return fail(
      `${formatPercent(p4)} % does not give a whole number of tokens at 1 token = ${size} %. Use a multiple of ${size} % or choose a smaller token.`,
    );
  }
  const tokens = p4 / g.e4;
  if (tokens > U64_MAX) return fail("Too many tokens for the token program (u64).");
  return ok(tokens);
}

/** The percent `tokens` represent at token size `g` (the inverse of tokensFor). */
export function percentForTokens(tokens: bigint, g: Pick<Granularity, "e4">): bigint {
  return tokens * g.e4;
}

/** 5000n → "5,000" (display only). */
export function formatTokens(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ── Price (optional) ────────────────────────────────────────────────────────
//
// The equity profile's money columns are USD (lib/asset-types.tsx "Share
// price (USD)"), so the optional price is asked in USD and labelled so. Held
// in cents; the per-token figure is rounded half-up to 6 decimals with BigInt.

export const PRICE_CURRENCY = "USD";
/** $1 trillion: far above any real stake, low enough to stay exact as a JSON number. */
const MAX_PRICE_CENTS = BigInt(100_000_000_000_000);

/** "" → null (no price); "50000" / "50000.5" → cents. */
export function parsePrice(input: string): Parsed<bigint | null> {
  const s = input.trim().replace(/^\$\s*/, "");
  if (!s) return ok(null);
  if (s.includes(",")) return fail('Use "." for cents and no thousands separators, e.g. 50000.50.');
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[1] && !m[2]) || s.endsWith(".")) return fail("Enter an amount in USD, e.g. 50000.");
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > 2) return fail("Use at most 2 decimals (cents).");
  const cents = BigInt((m[1] || "0") + frac.padEnd(2, "0"));
  if (cents <= BigInt(0)) return fail("The price must be more than 0, or leave it empty.");
  if (cents > MAX_PRICE_CENTS) return fail("The price is too large.");
  return ok(cents);
}

/** cents → "50000" / "50000.5". */
export function formatCents(cents: bigint): string {
  const whole = cents / BigInt(100);
  const frac = (cents % BigInt(100)).toString().padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Price of one token, in millionths of a USD, rounded half up. */
export function perTokenPriceE6(cents: bigint, tokens: bigint): bigint {
  if (tokens <= BigInt(0)) throw new Error("No tokens");
  const e6 = cents * BigInt(10_000);
  return (e6 * BigInt(2) + tokens) / (tokens * BigInt(2));
}

/** millionths → "0.4", "12.345678". */
export function formatE6(v: bigint): string {
  const whole = v / BigInt(1_000_000);
  const frac = (v % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

// ── Bytes ───────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

export function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

/**
 * At most `maxBytes` UTF-8 bytes without splitting a character — the same
 * cut as the program's `truncate_utf8` (initialize_share_class_mint.rs).
 */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (utf8Bytes(s) <= maxBytes) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = utf8Bytes(ch);
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

// ── On-chain names ──────────────────────────────────────────────────────────
//
// initialize_share_class_mint names the mint "<Asset.name> · Class <idx>"
// (≤ 32 B) and gives it the symbol "<Asset.symbol_prefix><idx>" (≤ 10 B).
// " · Class 0" is 11 bytes (the middle dot is two), so a token name of at most
// 21 bytes and a prefix of at most 9 keep both whole for class 0.

export const CLASS_INDEX = 0;
export const MINT_NAME_MAX_BYTES = 32;
export const MINT_SYMBOL_MAX_BYTES = 10;
export const MAX_TOKEN_NAME_BYTES = MINT_NAME_MAX_BYTES - utf8Bytes(` · Class ${CLASS_INDEX}`);
export const MAX_SYMBOL_PREFIX_BYTES = MINT_SYMBOL_MAX_BYTES - utf8Bytes(String(CLASS_INDEX));
/** create_asset: the asset ID is a PDA seed, at most 32 bytes. */
export const MAX_ASSET_ID_BYTES = 32;
/** How many "-2", "-3"… IDs the flow tries before giving up. */
export const ASSET_ID_CANDIDATES = 10;

/** The metadata name the program will write for class 0. */
export function mintNamePreview(tokenName: string): string {
  return truncateUtf8(`${tokenName} · Class ${CLASS_INDEX}`, MINT_NAME_MAX_BYTES);
}

/** The metadata symbol the program will write for class 0. */
export function mintSymbolPreview(prefix: string): string {
  return truncateUtf8(`${prefix}${CLASS_INDEX}`, MINT_SYMBOL_MAX_BYTES);
}

// Legal forms, compared lower-case without dots or commas. Only a word AFTER
// the first one counts ("AB Foods" keeps its name), and the short name is
// everything before it ("Mancipatio d.o.o. Beograd" → "Mancipatio").
const LEGAL_FORMS = new Set([
  "doo", "dd", "ad", "jsc", "pjsc", "ooo", "zao", "oao",
  "доо", "ад", "дд", "ооо",
  "ltd", "limited", "llc", "llp", "plc", "inc", "incorporated", "corp", "corporation", "co",
  "gmbh", "ag", "kg", "ohg", "sa", "sas", "sarl", "srl", "spa", "sro", "a/s", "aps", "ab",
  "oy", "oyj", "bv", "nv", "sp", "pty", "kft", "zrt", "nyrt",
]);
const QUOTES = /["“”„‟«»‚‘’'`]/g;

function legalFormKey(word: string): string {
  return word.toLowerCase().replace(/[.,;:]/g, "");
}

/** "Mancipatio d.o.o." → "Mancipatio"; quotes and extra spaces dropped. */
export function companyShortName(full: string): string {
  const cleaned = full.normalize("NFC").replace(QUOTES, "").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ");
  for (let i = 1; i < words.length; i++) {
    if (LEGAL_FORMS.has(legalFormKey(words[i]))) {
      const short = words.slice(0, i).join(" ").replace(/[\s,;:&–—-]+$/, "");
      if (short) return short;
    }
  }
  return cleaned.replace(/[\s,;:]+$/, "");
}

// Serbian Cyrillic → the same Latin letters the Latin script would give, so
// "Шећер" and "Šećer" derive the same symbol.
const CYRILLIC: Record<string, string> = {
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Ђ: "DJ", Е: "E", Ж: "Z", З: "Z", И: "I", Ј: "J",
  К: "K", Л: "L", Љ: "LJ", М: "M", Н: "N", Њ: "NJ", О: "O", П: "P", Р: "R", С: "S", Т: "T",
  Ћ: "C", У: "U", Ф: "F", Х: "H", Ц: "C", Ч: "C", Џ: "DZ", Ш: "S",
};
// Letters that do not decompose into a base letter plus a mark.
const SPECIAL: Record<string, string> = {
  Đ: "DJ", Ł: "L", Ø: "O", Æ: "AE", Œ: "OE", ß: "SS", Þ: "TH", Ð: "D", Ħ: "H", Ŧ: "T",
};

/** Upper-case ASCII transliteration: š ć č ž → S C C Z, đ → DJ, Cyrillic → Latin. */
export function toAsciiUpper(s: string): string {
  let out = "";
  for (const ch of s.toUpperCase()) out += CYRILLIC[ch] ?? SPECIAL[ch] ?? ch;
  return out.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function cleanCompanyPart(company: string): string {
  return company.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * The token name: "<company> <pct>%". The percent is always generated from
 * the share entered, so the on-chain name (which becomes the mint name and
 * cannot change once the asset is active) states the same share as the cap.
 */
export function tokenNameFor(company: string, p4: bigint): string {
  const c = cleanCompanyPart(company);
  const suffix = `${formatPercent(p4)}%`;
  return c ? `${c} ${suffix}` : suffix;
}

/** The company part of the automatic name: whole words, shortened so the name stays within 21 bytes. */
export function deriveTokenCompany(shortName: string, p4: bigint): string {
  const budget = MAX_TOKEN_NAME_BYTES - utf8Bytes(`${formatPercent(p4)}%`) - 1;
  const company = cleanCompanyPart(shortName);
  if (utf8Bytes(company) <= budget) return company;
  const cut = truncateUtf8(company, Math.max(budget, 0));
  const atWordEnd = /\s/.test(company.charAt(cut.length));
  const lastSpace = cut.lastIndexOf(" ");
  return (atWordEnd || lastSpace <= 0 ? cut : cut.slice(0, lastSpace)).trimEnd();
}

/** The automatic token name: "<Company short> <pct>%", at most 21 bytes. */
export function deriveTokenName(shortName: string, p4: bigint): string {
  return tokenNameFor(deriveTokenCompany(shortName, p4), p4);
}

/** The symbol prefix: the first 5 ASCII letters/digits of the company (≥ 2), else of the legal ID. */
export function deriveSymbolPrefix(shortName: string, legalId: string): string {
  const fromName = toAsciiUpper(shortName).replace(/[^A-Z0-9]/g, "");
  if (fromName.length >= 2) return fromName.slice(0, 5);
  const fromId = toAsciiUpper(legalId).replace(/[^A-Z0-9]/g, "");
  if (fromId.length >= 2) return fromId.slice(0, 5);
  return "SHARE";
}

/**
 * Advanced: the company part of the token name (the "<pct>%" after it is
 * generated, never typed). Null when valid.
 */
export function validateCompanyOverride(company: string, p4: bigint): string | null {
  const s = cleanCompanyPart(company);
  if (!s) return "Enter the company name.";
  if (/[\u0000-\u001f\u007f]/.test(company)) return "Remove control characters.";
  if (s.includes("%")) return "Leave out the percent — it is added from the share you entered.";
  const name = tokenNameFor(s, p4);
  const bytes = utf8Bytes(name);
  if (bytes > MAX_TOKEN_NAME_BYTES) {
    return `“${name}” is ${bytes} bytes — the limit is ${MAX_TOKEN_NAME_BYTES} (letters like š, ć or đ count as 2). Shorten the company name.`;
  }
  return null;
}

/** Advanced: a typed symbol prefix (A–Z, 0–9, 1–9 characters). Null when valid. */
export function validateSymbolOverride(symbol: string): string | null {
  const s = symbol.trim();
  if (!s) return "Enter a symbol.";
  if (!/^[A-Z0-9]+$/.test(s)) return "Use capital letters A–Z and digits only.";
  if (s.length > MAX_SYMBOL_PREFIX_BYTES) return `At most ${MAX_SYMBOL_PREFIX_BYTES} characters.`;
  return null;
}

/** "MANCI" + 5 % → "MANCI-5PCT"; 2.5 % → "MANCI-2_5PCT". ASCII, room left for "-10". */
export function baseAssetId(prefix: string, p4: bigint): string {
  const tail = `-${formatPercent(p4).replace(".", "_")}PCT`;
  const head = prefix.replace(/[^A-Z0-9]/g, "") || "SHARE";
  return `${head}${tail}`.slice(0, MAX_ASSET_ID_BYTES - 3);
}

/** base, base-2, … base-N: every one ≤ 32 bytes. */
export function candidateAssetIds(base: string, count = ASSET_ID_CANDIDATES): string[] {
  const out = [base.slice(0, MAX_ASSET_ID_BYTES)];
  for (let i = 2; i <= count; i++) {
    const suffix = `-${i}`;
    out.push(`${base.slice(0, MAX_ASSET_ID_BYTES - suffix.length)}${suffix}`);
  }
  return out;
}

/** The share a tokenize-flow name ends with ("Mancipatio 5%" → "5"), or null. */
export function percentFromName(name: string): string | null {
  const m = /(?:^|\s)(\d{1,3}(?:\.\d{1,4})?)%$/.exec(name);
  return m ? m[1] : null;
}

/** The share a name states, as p4 ("Mancipatio 2.50%" → 25 000), or null. */
export function namedPercentE4(name: string): bigint | null {
  const pct = percentFromName(name);
  const parsed = pct ? parsePercent(pct) : null;
  return parsed?.ok ? parsed.value : null;
}

// ── Company and jurisdiction ────────────────────────────────────────────────

export type CompanySource = "issuer_profile" | "client" | "legal_id";

/** Company name: the issuer's profile, then its client record, then the on-chain legal ID. */
export function resolveCompany(input: {
  profileName?: string | null;
  clientName?: string | null;
  legalId: string;
}): { name: string; source: CompanySource } {
  const profile = input.profileName?.trim();
  if (profile) return { name: profile, source: "issuer_profile" };
  const client = input.clientName?.trim();
  if (client) return { name: client, source: "client" };
  return { name: input.legalId.trim(), source: "legal_id" };
}

/** ISO-3166 numeric code: the on-chain Issuer.jurisdiction, then the client record. */
export function resolveJurisdiction(onChain: number, client?: string | null): string | null {
  if (Number.isInteger(onChain) && onChain > 0 && onChain < 1000) return String(onChain).padStart(3, "0");
  const c = client?.trim();
  return c && /^\d{3}$/.test(c) ? c : null;
}

// ── Defaults the program accepts ────────────────────────────────────────────

/** Class 0 of a tokenized stake: Common with Vote | Dividend | Transferable, 1×, never diluted. */
export const CLASS_DEFAULTS = {
  classIndex: CLASS_INDEX,
  classType: ShareClassType.Common,
  rightsBitfield: 1 | 2 | 32,
  liqPrefMultiplierBps: 10_000,
  liqSeniority: 0,
  votingWeight: 1,
  mintablePostLaunch: false,
} as const;

export function assetDefaults() {
  return {
    assetType: AssetType.Equity,
    jurisdictionRules: {
      allowedCountries: new Uint8Array(JURISDICTION_BITMAP_BYTES),
      maxHolders: 0,
      restrictedPeriodEnd: BigInt(0),
      allowP2p: true,
    },
  };
}

// ── Legal document ──────────────────────────────────────────────────────────

/** Same cap as signed uploads (lib/storage-client MAX_UPLOAD_BYTES). */
export const LEGAL_DOC_MAX_BYTES = 25 * 1024 * 1024;

/** Mainnet anchors a real document; other networks may fall back to the profile hash. */
export function legalDocRequired(network: Network): boolean {
  return network === "mainnet";
}

export function legalDocProblem(
  file: { name: string; type: string; size: number } | null,
  network: Network,
): string | null {
  if (!file) return legalDocRequired(network) ? "Attach the legal document (PDF) — required on mainnet." : null;
  const pdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!pdf) return "Choose a PDF file.";
  if (file.size <= 0) return "The file is empty.";
  if (file.size > LEGAL_DOC_MAX_BYTES) return "The PDF is larger than 25 MB.";
  return null;
}

// ── Off-chain profile ───────────────────────────────────────────────────────

export type LegalDocSource = "file" | "canonical" | "chain";

export type TokenizeFigures = {
  p4: bigint;
  granularity: GranularityId;
  tokens: bigint;
  priceCents: bigint | null;
};

/** What `fields.tokenize` records (strings: exact, never floats). */
export function tokenizeFields(input: {
  figures: TokenizeFigures;
  companyName: string;
  companySource: CompanySource;
  legalDocSource: LegalDocSource;
}) {
  const { figures } = input;
  return {
    v: 1,
    percent: formatPercent(figures.p4),
    percent_e4: figures.p4.toString(),
    granularity_percent: figures.granularity,
    tokens: figures.tokens.toString(),
    price_total: figures.priceCents === null ? null : formatCents(figures.priceCents),
    price_per_token:
      figures.priceCents === null ? null : formatE6(perTokenPriceE6(figures.priceCents, figures.tokens)),
    price_currency: figures.priceCents === null ? null : PRICE_CURRENCY,
    company_name: input.companyName,
    company_source: input.companySource,
    legal_doc_source: input.legalDocSource,
  };
}

export function displayNameFor(companyName: string, p4: bigint): string {
  return `${companyName} · ${formatPercent(p4)} %`;
}

/** The plain-words listing line. */
export function summaryText(input: {
  companyName: string;
  jurisdiction: string | null;
  p4: bigint;
  tokens: bigint;
}): string {
  const country = input.jurisdiction ? countryName(input.jurisdiction) : null;
  const where = country && country !== "—" ? ` (${country})` : "";
  return `${formatTokens(input.tokens)} tokens = ${formatPercent(input.p4)} % of ${input.companyName}${where}. Only verified (KYC) wallets can hold them.`;
}

/**
 * The string hashed into create_asset's legal_doc_hash when no document is
 * attached (off mainnet only): the same field set and order as the generic
 * Create-asset modal's canonical profile.
 */
export function canonicalProfileHashInput(input: {
  assetId: string;
  name: string;
  symbolPrefix: string;
  displayName: string;
  summary: string;
  description: string;
  website: string;
  jurisdiction: string | null;
  fields: Record<string, unknown>;
}): string {
  return JSON.stringify({
    assetId: input.assetId,
    category: "equity",
    name: input.name,
    symbolPrefix: input.symbolPrefix,
    displayName: input.displayName,
    summary: input.summary,
    description: input.description,
    website: input.website,
    jurisdiction: input.jurisdiction,
    fields: input.fields,
  });
}

/** RIGHT_VOTE / RIGHT_CONVERTIBLE (program constants.rs). */
const RIGHT_VOTE = 1 << 0;
const RIGHT_CONVERTIBLE = 1 << 3;

/** The class terms the equity profile columns describe (read from class 0 on chain). */
export type ClassTerms = { rightsBitfield: number; liqPrefMultiplierBps: number };

/** A profile row that is already stored (only the columns this flow writes matter). */
export type ExistingProfile = Partial<
  Pick<
    AssetProfile,
    | "category"
    | "display_name"
    | "summary"
    | "description"
    | "website"
    | "jurisdiction"
    | "legal_doc_sha256"
    | "has_voting"
    | "convertible"
    | "liquidation_pref_bps"
    | "share_price"
  >
> & { fields?: Record<string, unknown> | null };

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * The asset_profiles row this flow writes (POST /api/profiles/upsert). The
 * percent figures go in `fields.tokenize` (jsonb, private — never in the
 * public projection), so no migration is needed. The equity columns describe
 * class 0 as it is on chain (`classTerms`), not the flow's defaults.
 *
 * An existing row is never overwritten: it keeps its category, its status,
 * its other `fields` keys and every column that already has a value (the
 * issuer may have written the asset page by hand); only `fields.tokenize` is
 * added and empty columns are filled. The upsert route leaves columns the
 * row does not name untouched.
 */
export function buildProfileRow(input: {
  assetPda: string;
  issuerPda: string;
  companyName: string;
  companySource: CompanySource;
  jurisdiction: string | null;
  website: string | null;
  description: string | null;
  figures: TokenizeFigures;
  legalDocHex: string;
  legalDocSource: LegalDocSource;
  classTerms?: ClassTerms;
  existing?: ExistingProfile | null;
}): NewAssetProfile {
  const { figures, existing } = input;
  const terms = input.classTerms ?? CLASS_DEFAULTS;
  const generated: Partial<NewAssetProfile> = {
    display_name: displayNameFor(input.companyName, figures.p4),
    summary: summaryText({
      companyName: input.companyName,
      jurisdiction: input.jurisdiction,
      p4: figures.p4,
      tokens: figures.tokens,
    }),
    description: input.description?.trim() || null,
    website: input.website?.trim() || null,
    jurisdiction: input.jurisdiction,
    legal_doc_sha256: input.legalDocHex,
    has_voting: (terms.rightsBitfield & RIGHT_VOTE) !== 0,
    convertible: (terms.rightsBitfield & RIGHT_CONVERTIBLE) !== 0,
    liquidation_pref_bps: terms.liqPrefMultiplierBps,
  };
  if (figures.priceCents !== null) {
    // "Share price (USD)" of the equity profile: the price of one token.
    generated.share_price = Number(formatE6(perTokenPriceE6(figures.priceCents, figures.tokens)));
  }
  const row: NewAssetProfile = {
    asset_pda: input.assetPda,
    category: existing?.category ?? "equity",
    issuer_pda: input.issuerPda,
    fields: { ...(existing?.fields ?? {}), tokenize: tokenizeFields(input) },
  };
  for (const [key, value] of Object.entries(generated) as [keyof ExistingProfile, unknown][]) {
    if (existing && !isBlank(existing[key])) continue;
    if (existing && isBlank(value)) continue;
    (row as Record<string, unknown>)[key] = value;
  }
  if (!existing) row.status = "draft";
  return row;
}

/** Whether a stored profile was written by this flow. */
export function hasTokenizeFields(profile: { fields?: Record<string, unknown> | null } | null | undefined): boolean {
  const t = profile?.fields?.tokenize;
  return typeof t === "object" && t !== null && !Array.isArray(t);
}

// ── Resume decision ─────────────────────────────────────────────────────────

export type AssetSnapshot = {
  assetType: AssetType;
  status: AssetStatus;
  name: string;
  symbolPrefix: string;
  shareClassesCount: number;
};

export type ClassSnapshot = {
  classType: ShareClassType;
  /** null = uncapped. */
  maxSupply: bigint | null;
  mintablePostLaunch: boolean;
  mintInitialized: boolean;
  rightsBitfield: number;
  liqPrefMultiplierBps: number;
  liqSeniority: number;
  votingWeight: number;
};

/** Whether class 0 carries the economic terms this flow creates (rights, 1× preference, seniority, voting weight). */
export function classHasFlowTerms(sc: ClassSnapshot): boolean {
  return (
    sc.rightsBitfield === CLASS_DEFAULTS.rightsBitfield &&
    sc.liqPrefMultiplierBps === CLASS_DEFAULTS.liqPrefMultiplierBps &&
    sc.liqSeniority === CLASS_DEFAULTS.liqSeniority &&
    sc.votingWeight === CLASS_DEFAULTS.votingWeight
  );
}

/** What the person asked for; null when resuming an asset without the form. */
export type TokenizeIntent = { name: string; symbolPrefix: string; tokens: bigint };

export type TokenizeStep =
  /** R1: nothing on chain — create_asset + add_share_class (+ initialize_share_class_mint). */
  | { kind: "create"; initMint: boolean }
  /** R3: a Draft asset without classes — add_share_class (+ initialize_share_class_mint). */
  | { kind: "add_class"; initMint: boolean }
  /** R6: class ready, mint missing, this wallet may create it. */
  | { kind: "init_mint" }
  /** R8: on chain is complete as far as this wallet can go; the details are not saved. */
  | { kind: "save_profile" }
  /** R7: the mint needs the Mint permission the Super Admin grants. */
  | { kind: "wait_mint_permission" }
  /** R9: nothing left for the flow — the checklist takes over. */
  | { kind: "done" }
  /** R2 / R5: an asset under this ID that the flow did not make (or made for other terms). */
  | { kind: "conflict"; reason: string }
  /** R4: an Active asset without classes — only the operator can sort it out. */
  | { kind: "blocked"; reason: string };

/**
 * The next step for one asset ID (the R1–R9 decision table). Chain steps come
 * before the profile, except that a mint waiting for the Super Admin does not
 * hold the profile back.
 */
export function nextTokenizeStep(input: {
  asset: AssetSnapshot | null;
  sc0: ClassSnapshot | null;
  profileSaved: boolean;
  canInitMint: boolean;
  intent: TokenizeIntent | null;
}): TokenizeStep {
  const { asset, sc0, intent } = input;
  if (!asset) return { kind: "create", initMint: input.canInitMint };
  if (asset.assetType !== AssetType.Equity) {
    return { kind: "conflict", reason: "An asset of another type already uses this ID." };
  }
  if (asset.status === AssetStatus.Frozen || asset.status === AssetStatus.WoundDown) {
    return { kind: "conflict", reason: "The asset under this ID is frozen or wound down." };
  }
  if (intent && (asset.name !== intent.name || asset.symbolPrefix !== intent.symbolPrefix)) {
    return { kind: "conflict", reason: "An asset with another name or symbol already uses this ID." };
  }
  if (asset.shareClassesCount === 0) {
    if (asset.status === AssetStatus.Draft) return { kind: "add_class", initMint: input.canInitMint };
    return {
      kind: "blocked",
      reason: "This asset is already active but has no share class, and classes can only be added to a draft. Contact the operator.",
    };
  }
  if (asset.shareClassesCount > 1 || !sc0) {
    return { kind: "conflict", reason: "This asset has share classes the flow did not create." };
  }
  if (sc0.classType !== ShareClassType.Common || sc0.mintablePostLaunch || sc0.maxSupply === null) {
    return { kind: "conflict", reason: "Class 0 of this asset is not a capped Common class." };
  }
  if (!classHasFlowTerms(sc0)) {
    return {
      kind: "conflict",
      reason:
        "Class 0 of this asset has other rights, liquidation preference or voting weight than this screen creates. Manage it on its asset page.",
    };
  }
  if (intent && sc0.maxSupply !== intent.tokens) {
    return { kind: "conflict", reason: "Class 0 of this asset is capped at a different number of tokens." };
  }
  if (!sc0.mintInitialized && input.canInitMint) return { kind: "init_mint" };
  if (!input.profileSaved) return { kind: "save_profile" };
  if (!sc0.mintInitialized) return { kind: "wait_mint_permission" };
  return { kind: "done" };
}

/** Steps the flow continues on the same asset instead of creating another one. */
export function isResumable(step: TokenizeStep): boolean {
  return (
    step.kind === "add_class" ||
    step.kind === "init_mint" ||
    step.kind === "save_profile" ||
    step.kind === "wait_mint_permission"
  );
}

export type AssetIdChoice = {
  assetId: string;
  step: TokenizeStep;
  /** Existing assets under the earlier IDs (finished, other terms or blocked), in order. */
  skipped: { assetId: string; step: TokenizeStep }[];
};

/**
 * The asset ID to use: candidates in order, `steps[i]` the nextTokenizeStep
 * decision for candidates[i] ("create" when no asset exists there). The first
 * free ID is created, unless an earlier existing one can be resumed; a
 * finished, conflicting or blocked asset is passed over and reported in
 * `skipped`, so the issuer confirms before a second token is made
 * (needsDuplicateConfirmation). Null when every candidate is taken.
 */
export function chooseAssetId(
  candidates: readonly string[],
  steps: readonly TokenizeStep[],
): AssetIdChoice | null {
  const skipped: AssetIdChoice["skipped"] = [];
  for (let i = 0; i < candidates.length && i < steps.length; i++) {
    const step = steps[i];
    if (step.kind === "create" || isResumable(step)) return { assetId: candidates[i], step, skipped };
    skipped.push({ assetId: candidates[i], step });
  }
  return null;
}

/**
 * A new asset under a suffixed ID ("-2", "-3"…) while the issuer already has
 * an asset under the base ID: asset accounts cannot be closed, so the flow
 * stops and asks before the wallet opens.
 */
export function needsDuplicateConfirmation(choice: Pick<AssetIdChoice, "step" | "skipped">): boolean {
  return choice.step.kind === "create" && choice.skipped.length > 0;
}

/** What a duplicate confirmation is bound to: the same ID and the same name, symbol and cap. */
export function duplicateConfirmationKey(assetId: string, intent: TokenizeIntent): string {
  return JSON.stringify([assetId, intent.name, intent.symbolPrefix, intent.tokens.toString()]);
}

/** A name the flow derives ("<company> <pct>%") — used to offer "Continue". */
export function looksLikeTokenizeAsset(asset: Pick<AssetSnapshot, "assetType" | "name">): boolean {
  return asset.assetType === AssetType.Equity && percentFromName(asset.name) !== null;
}

/**
 * A token the flow can continue: a "<company> <pct>%" equity asset whose
 * class 0 (when it exists) has the flow's terms. Others are managed on the
 * share-class screen and the asset page's own profile form.
 */
export function isFlowToken(
  asset: Pick<AssetSnapshot, "assetType" | "name">,
  sc0: ClassSnapshot | null,
): boolean {
  return (
    looksLikeTokenizeAsset(asset) &&
    (sc0 === null ||
      (sc0.classType === ShareClassType.Common &&
        sc0.maxSupply !== null &&
        !sc0.mintablePostLaunch &&
        classHasFlowTerms(sc0)))
  );
}

/**
 * "Details saved", counted the same way by the flow and the checklist: a flow
 * token needs the figures this flow writes (`fields.tokenize`); any other
 * asset just a profile row.
 */
export function detailsSaved(
  flowToken: boolean,
  profile: { fields?: Record<string, unknown> | null } | null | undefined,
): boolean {
  return flowToken ? hasTokenizeFields(profile) : !!profile;
}

// ── Checklist after creation ────────────────────────────────────────────────

export type ChecklistId = "created" | "details" | "kyc" | "activate" | "mint" | "lock";
export type ChecklistState = "done" | "todo" | "blocked";
export type ChecklistItem = { id: ChecklistId; state: ChecklistState };

export function checklistItems(input: {
  classExists: boolean;
  mintInitialized: boolean;
  profileSaved: boolean;
  /** null while there is no mint (and so no hook config). */
  kycGated: boolean | null;
  active: boolean;
  circulating: bigint;
  maxSupply: bigint | null;
  supplyLocked: boolean;
  primaryPaused: boolean;
}): ChecklistItem[] {
  const created = input.classExists && input.mintInitialized;
  const kyc = input.kycGated === true;
  const minted =
    input.supplyLocked || (input.maxSupply !== null && input.circulating >= input.maxSupply);
  return [
    { id: "created", state: created ? "done" : "todo" },
    { id: "details", state: input.profileSaved ? "done" : "todo" },
    { id: "kyc", state: kyc ? "done" : input.mintInitialized ? "todo" : "blocked" },
    { id: "activate", state: input.active ? "done" : input.classExists ? "todo" : "blocked" },
    {
      id: "mint",
      state: minted ? "done" : created && kyc && input.active && !input.primaryPaused ? "todo" : "blocked",
    },
    { id: "lock", state: input.supplyLocked ? "done" : minted ? "todo" : "blocked" },
  ];
}

// ── Local draft (resume after a failed second signature) ────────────────────

export type TokenizeDraft = {
  v: 1;
  percent: string;
  granularity: GranularityId;
  price: string;
  description: string;
  legalDocSource: LegalDocSource;
  savedAt: string;
};

/**
 * What a resumed form starts with: this browser's draft, else the saved
 * `fields.tokenize`, else what the chain implies (the percent in the token's
 * name and the token size that makes the class cap match it).
 */
export function resumePrefill(input: {
  assetName: string | null;
  cap: bigint | null;
  tokenize: Record<string, unknown> | null;
  draft: TokenizeDraft | null;
}): { percent?: string; granularity?: GranularityId; price?: string; description?: string } {
  const { draft, tokenize } = input;
  if (draft) {
    return { percent: draft.percent, granularity: draft.granularity, price: draft.price, description: draft.description };
  }
  if (tokenize) {
    const g = granularityById(String(tokenize.granularity_percent));
    return {
      percent: typeof tokenize.percent === "string" ? tokenize.percent : undefined,
      granularity: g?.id,
      price: typeof tokenize.price_total === "string" ? tokenize.price_total : undefined,
    };
  }
  const fromName = input.assetName ? percentFromName(input.assetName) : null;
  if (!fromName) return {};
  const named = parsePercent(fromName);
  const cap = input.cap;
  const match =
    named.ok && cap !== null ? GRANULARITIES.find((g) => percentForTokens(cap, g) === named.value) : undefined;
  return { percent: fromName, granularity: match?.id };
}

export type ShareFigures = (
  | { ok: true; p4: bigint; tokens: bigint }
  | { ok: false; error: string }
) & { warning: string | null };

/**
 * The share and token count the screen works with — of a new token (no cap,
 * no name yet) or of a resumed one.
 *
 * With class 0 on chain (`cap`), the cap is the truth and the token size
 * decides the percent. The token size must be chosen explicitly when nothing
 * recorded it (no draft, no saved figures, no name that fits the cap), so a
 * default never puts a wrong percent on the asset page. The percent in the
 * name is enforced only when some token size reconciles it with the cap;
 * when none does, the name is ignored with a warning instead of blocking the
 * save for good.
 *
 * Without a class yet, the typed percent becomes the cap, and on a resumed
 * asset it must be the one the name states.
 */
export function shareFigures(input: {
  cap: bigint | null;
  namedP4: bigint | null;
  granularity: Granularity | null;
  percentInput: string;
}): ShareFigures {
  const { cap, namedP4, granularity } = input;
  if (cap !== null) {
    const nameFits = namedP4 !== null && GRANULARITIES.some((g) => percentForTokens(cap, g) === namedP4);
    const warning =
      namedP4 !== null && !nameFits
        ? `The token's name says ${formatPercent(namedP4)} %, but its ${formatTokens(cap)} tokens are not ${formatPercent(namedP4)} % at any token size. The figures below come from the token count — check them before saving.`
        : null;
    if (!granularity) {
      return { ok: false, error: `Choose the token size these ${formatTokens(cap)} tokens were created with.`, warning };
    }
    const p4 = percentForTokens(cap, granularity);
    if (p4 > HUNDRED_PERCENT_E4) {
      return {
        ok: false,
        error: `${formatTokens(cap)} tokens at ${granularityLabel(granularity.id)} would be more than 100 %. Choose a smaller token.`,
        warning,
      };
    }
    if (nameFits && p4 !== namedP4) {
      return {
        ok: false,
        error: `At ${granularityLabel(granularity.id)} these ${formatTokens(cap)} tokens are ${formatPercent(p4)} %, but the token is named for ${formatPercent(namedP4)} %. Choose the matching token size.`,
        warning,
      };
    }
    return { ok: true, p4, tokens: cap, warning };
  }
  const p = parsePercent(input.percentInput);
  if (!p.ok) return { ok: false, error: p.error, warning: null };
  if (namedP4 !== null && p.value !== namedP4) {
    return {
      ok: false,
      error: `The token is named for ${formatPercent(namedP4)} %; enter ${formatPercent(namedP4)}.`,
      warning: null,
    };
  }
  if (!granularity) return { ok: false, error: "Choose the token size.", warning: null };
  const t = tokensFor(p.value, granularity);
  if (!t.ok) return { ok: false, error: t.error, warning: null };
  return { ok: true, p4: p.value, tokens: t.value, warning: null };
}

export function draftKey(network: string, assetPda: string): string {
  return `mancipatio:tokenize:v1:${network}:${assetPda}`;
}

/** A stored draft, or null when missing or malformed. */
export function parseDraft(raw: string | null): TokenizeDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<TokenizeDraft>;
    if (
      d?.v !== 1 ||
      typeof d.percent !== "string" ||
      !granularityById(d.granularity) ||
      typeof d.price !== "string" ||
      typeof d.description !== "string" ||
      (d.legalDocSource !== "file" && d.legalDocSource !== "canonical" && d.legalDocSource !== "chain")
    ) {
      return null;
    }
    return d as TokenizeDraft;
  } catch {
    return null;
  }
}
