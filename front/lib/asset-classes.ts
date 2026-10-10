// Which asset classes Manci offers on this network (owner decision
// 2026-10-10: on mainnet only Equity, the class of the live asset). Every
// PUBLIC list of classes shows only these (lib/pilot-scope.ts
// offeredAssetClasses). Issuer and admin screens and the data of existing
// assets are not filtered.
//   NEXT_PUBLIC_ASSET_CLASSES=equity,debt   (slugs, any case, comma/space)
//   NEXT_PUBLIC_ASSET_CLASSES=all
// Unset: equity on mainnet, every class elsewhere. A production build
// refuses an unknown slug (next.config.ts assertBuildAssetClasses): a typo
// would otherwise silently hide or show classes. Inlined at build time.
// Pure and import-free: next.config.ts loads it by relative path.

export const ASSET_CLASSES_ENV = "NEXT_PUBLIC_ASSET_CLASSES";

/** lib/asset-types.tsx CATEGORY_SLUGS, spelled out (next.config.ts cannot import that file); a test keeps the two equal. */
export const ASSET_CLASS_SLUGS = ["equity", "debt", "real_estate", "royalty", "revenue_share", "commodity", "physical", "other"] as const;
export type AssetClassSlug = (typeof ASSET_CLASS_SLUGS)[number];
export const MAINNET_DEFAULT_ASSET_CLASSES: readonly AssetClassSlug[] = ["equity"];

export type AssetClassConfig =
  | { ok: true; set: false }
  | { ok: true; set: true; classes: readonly AssetClassSlug[] }
  | { ok: false; error: string };

export function parseAssetClassList(value: string | undefined): AssetClassConfig {
  const raw = value?.trim().toLowerCase() ?? "";
  if (!raw) return { ok: true, set: false };
  if (raw === "all") return { ok: true, set: true, classes: ASSET_CLASS_SLUGS };
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return { ok: false, error: "names no asset class" };
  const unknown = tokens.filter((t) => !(ASSET_CLASS_SLUGS as readonly string[]).includes(t));
  if (unknown.length) return { ok: false, error: `unknown asset class ${unknown.map((u) => `"${u}"`).join(", ")}` };
  return { ok: true, set: true, classes: ASSET_CLASS_SLUGS.filter((s) => tokens.includes(s)) }; // display order
}

/** The classes offered on `network` for the variable's `value` (an invalid value falls back to the network default; the build refuses it anyway). */
export function offeredAssetClassesFor(network: string, value: string | undefined): readonly AssetClassSlug[] {
  const config = parseAssetClassList(value);
  if (config.ok && config.set) return config.classes;
  return network === "mainnet" ? MAINNET_DEFAULT_ASSET_CLASSES : ASSET_CLASS_SLUGS;
}
