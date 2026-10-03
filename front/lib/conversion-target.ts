// The conversion marker (C2, lib/tokenize-shares MARKER_DEFAULTS): a share
// class that exists only as the on-chain conversion target of a sibling
// class — Common, capped at 0, no mint, not dilutable, and named by a class
// of the same asset in `convertible_to`. It can never hold a token, so the
// public lists leave it out (and count classes without it), and the admin
// and issuer views label it "Conversion target" and never offer to create
// its mint (a mint would turn it into a "foreign" class 1 and break the
// tokenize flow's resume).
//
// Only marker-shaped classes are candidates, so the PDA derivations stay few.
// Node-safe (no React, no browser API): tests/conversion-target.test.ts.
import type { Address } from "@solana/kit";
import type { ShareClass } from "@/lib/generated/asset_registry";
import { findShareClassPda } from "@/lib/pdas";
import { isMarkerClass } from "@/lib/tokenize-shares";

export const CONVERSION_TARGET_LABEL = "Conversion target";

type ClassLike = Pick<
  ShareClass,
  "asset" | "classIndex" | "classType" | "maxSupply" | "mintInitialized" | "mintablePostLaunch" | "convertibleTo"
>;

/** The key a class goes by in the sets below. */
export function classKey(sc: Pick<ShareClass, "asset" | "classIndex">): string {
  return `${sc.asset}:${sc.classIndex}`;
}

/** The marker's shape (Common, capped at 0, no mint, not dilutable), whoever points at it. */
export function hasMarkerShape(sc: Omit<ClassLike, "asset" | "classIndex" | "convertibleTo">): boolean {
  return isMarkerClass({
    classType: sc.classType,
    maxSupply: sc.maxSupply.__option === "Some" ? sc.maxSupply.value : null,
    mintInitialized: sc.mintInitialized,
    mintablePostLaunch: sc.mintablePostLaunch,
    rightsBitfield: 0,
    liqPrefMultiplierBps: 0,
    liqSeniority: 0,
    votingWeight: 0,
  });
}

/**
 * The classes (by classKey) that are conversion targets: marker-shaped AND
 * the `convertible_to` of another class of the same asset. `pdaOf` derives a
 * class's address (injected in tests).
 */
export async function conversionTargetKeys(
  classes: readonly ClassLike[],
  pdaOf: (asset: Address, classIndex: number) => Promise<Address> = findShareClassPda,
): Promise<Set<string>> {
  const out = new Set<string>();
  const candidates = classes.filter(hasMarkerShape);
  if (candidates.length === 0) return out;
  const targets = new Set<string>();
  for (const sc of classes) {
    if (sc.convertibleTo.__option === "Some") targets.add(`${sc.asset}>${sc.convertibleTo.value}`);
  }
  for (const sc of candidates) {
    const pda = await pdaOf(sc.asset, sc.classIndex);
    if (targets.has(`${sc.asset}>${pda}`)) out.add(classKey(sc));
  }
  return out;
}

/** The classes a public list shows: every class but the conversion targets. */
export function visibleClasses<T extends Pick<ShareClass, "asset" | "classIndex">>(classes: readonly T[], targets: ReadonlySet<string>): T[] {
  return classes.filter((sc) => !targets.has(classKey(sc)));
}

/** An asset's class count without its conversion targets (`total`: Asset.shareClassesCount). */
export function visibleClassCount(asset: Address | string, total: number, targets: ReadonlySet<string>): number {
  let hidden = 0;
  for (const key of targets) if (key.startsWith(`${asset}:`)) hidden++;
  return Math.max(0, total - hidden);
}
