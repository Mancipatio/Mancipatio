// How a tokenized company is named on the public pages: words, never the
// registry's codes.
//
// The chain stores an immutable asset name, an asset id, a symbol prefix, an
// issuer legal id and an ISO numeric jurisdiction. Those identify a record;
// they do not tell a visitor what they are looking at. The public pages show
// the published profile's name and summary, the country by name and the
// verification in a sentence, and keep the identifiers in one labelled
// "On-chain details" block for whoever wants to check them on Solana.

import { countryName } from "@/lib/countries";
import { ASSET_TYPES, SHARE_CLASS_TYPE_LABELS } from "@/lib/asset-types";
import { formatPercent } from "@/lib/tokenize-shares";

type NamedProfile = { display_name?: string | null; summary?: string | null } | null | undefined;

/** The name shown for an asset: the published profile's, else the on-chain name. */
export function publicAssetName(onChainName: string, profile?: NamedProfile): string {
  const published = profile?.display_name?.trim();
  return published || onChainName;
}

/** The published one-line summary, or null. */
export function publicAssetSummary(profile?: NamedProfile): string | null {
  return profile?.summary?.trim() || null;
}

/**
 * A country by name from an ISO-3166-1 numeric code (the issuer's u16 or a
 * profile's text). null for a missing or unknown code: a page shows nothing
 * rather than a number.
 */
export function countryLabel(code: number | string | null | undefined): string | null {
  if (code === null || code === undefined || code === "") return null;
  const numeric = typeof code === "number" ? String(code) : code.trim();
  if (!/^\d{1,3}$/.test(numeric)) return null;
  const padded = numeric.padStart(3, "0");
  const name = countryName(padded);
  return name === padded ? null : name;
}

/** What the asset is, in the words of the asset-class guides ("Company ownership"). */
export function assetKindLabel(assetType: number): string {
  return ASSET_TYPES.find((type) => type.enumValue === assetType)?.title ?? "Other asset";
}

/** The issuer's verification (the on-chain KYB status) as a sentence. */
export function verificationLabel(kybStatus: number | null | undefined): string {
  switch (kybStatus) {
    case 1: return "Company verified by Manci";
    case 0: return "Company verification in progress";
    case 2: return "Company verification refused";
    case 3: return "Company verification suspended";
    default: return "Company verification unavailable";
  }
}

/** A share class by what it is ("Common"), never by its index. */
export function shareClassLabel(classType: number): string {
  return SHARE_CLASS_TYPE_LABELS[classType] ?? "Share class";
}

/**
 * "0.01" from the public profile's `token_percent_e4` (1/10,000 of a percent
 * per token), or null without consistent figures.
 */
export function unitPercent(tokenPercentE4: string | null | undefined): string | null {
  if (!tokenPercentE4 || !/^\d+$/.test(tokenPercentE4)) return null;
  const e4 = BigInt(tokenPercentE4);
  return e4 > BigInt(0) ? formatPercent(e4) : null;
}

/** Up to two initials for an asset without an approved logo. */
export function assetInitials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  // Letters before figures: "HERC 10%" is "HE", not "H1".
  const lettered = words.filter((word) => /^\p{L}/u.test(word));
  const letters = lettered.length >= 2 ? lettered[0][0] + lettered[1][0] : (lettered[0] ?? words[0]).slice(0, 2);
  return letters.toUpperCase();
}
