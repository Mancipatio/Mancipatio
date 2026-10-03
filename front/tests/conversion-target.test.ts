// The conversion marker (C2) in lists (lib/conversion-target): a class capped
// at 0 with no mint that a sibling converts into is a "Conversion target" —
// hidden from public lists and counts, labelled in admin and issuer views.
import { describe, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { ShareClassType, type ShareClass } from "@/lib/generated/asset_registry";
import { findShareClassPda } from "@/lib/pdas";
import {
  CONVERSION_TARGET_LABEL,
  classKey,
  conversionTargetKeys,
  hasMarkerShape,
  visibleClassCount,
  visibleClasses,
} from "@/lib/conversion-target";

const ASSET = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC" as Address;
const OTHER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2" as Address;
const none = { __option: "None" as const };
const some = <T,>(value: T) => ({ __option: "Some" as const, value });

type Cls = Pick<ShareClass, "asset" | "classIndex" | "classType" | "maxSupply" | "mintInitialized" | "mintablePostLaunch" | "convertibleTo">;

function cls(over: Partial<Cls> & Pick<Cls, "asset" | "classIndex">): Cls {
  return {
    classType: ShareClassType.Common,
    maxSupply: some(BigInt(5_000)),
    mintInitialized: true,
    mintablePostLaunch: false,
    convertibleTo: none,
    ...over,
  };
}

const marker = (asset: Address, classIndex = 1) => cls({ asset, classIndex, maxSupply: some(BigInt(0)), mintInitialized: false });

describe("conversion targets", () => {
  it("is the marker shape AND the convertible_to of a sibling class", async () => {
    const target = await findShareClassPda(ASSET, 1);
    const classes = [cls({ asset: ASSET, classIndex: 0, convertibleTo: some(target) }), marker(ASSET)];
    const keys = await conversionTargetKeys(classes);
    expect([...keys]).toEqual([classKey(marker(ASSET))]);
    expect(CONVERSION_TARGET_LABEL).toBe("Conversion target");
  });

  it("an unlinked marker, a foreign target, a minted or capped class are not targets", async () => {
    // Marker shape but nothing converts into it (unlinked): a plain class, shown.
    expect(await conversionTargetKeys([cls({ asset: ASSET, classIndex: 0 }), marker(ASSET)])).toEqual(new Set());
    // Class 0 of ANOTHER asset converting to this asset's class-1 PDA does not count.
    const target = await findShareClassPda(ASSET, 1);
    expect(await conversionTargetKeys([cls({ asset: OTHER, classIndex: 0, convertibleTo: some(target) }), marker(ASSET)])).toEqual(new Set());
    // Not the shape: a mint, a cap above 0, uncapped or dilutable.
    expect(hasMarkerShape(cls({ asset: ASSET, classIndex: 1, maxSupply: some(BigInt(0)) }))).toBe(false);
    expect(hasMarkerShape(cls({ asset: ASSET, classIndex: 1, mintInitialized: false }))).toBe(false);
    expect(hasMarkerShape(cls({ asset: ASSET, classIndex: 1, mintInitialized: false, maxSupply: none }))).toBe(false);
    expect(hasMarkerShape(cls({ asset: ASSET, classIndex: 1, mintInitialized: false, maxSupply: some(BigInt(0)), mintablePostLaunch: true }))).toBe(false);
    expect(hasMarkerShape(marker(ASSET))).toBe(true);
  });

  it("derives a PDA only for marker-shaped candidates", async () => {
    const calls: string[] = [];
    const pdaOf = async (asset: Address, index: number) => {
      calls.push(`${asset}:${index}`);
      return findShareClassPda(asset, index);
    };
    await conversionTargetKeys([cls({ asset: ASSET, classIndex: 0 }), cls({ asset: OTHER, classIndex: 0 })], pdaOf);
    expect(calls).toEqual([]);
    await conversionTargetKeys([cls({ asset: ASSET, classIndex: 0 }), marker(ASSET)], pdaOf);
    expect(calls).toEqual([`${ASSET}:1`]);
  });

  it("public lists drop the targets and count classes without them", async () => {
    const target = await findShareClassPda(ASSET, 1);
    const classes = [cls({ asset: ASSET, classIndex: 0, convertibleTo: some(target) }), marker(ASSET), cls({ asset: OTHER, classIndex: 0 })];
    const keys = await conversionTargetKeys(classes);
    expect(visibleClasses(classes, keys).map(classKey)).toEqual([`${ASSET}:0`, `${OTHER}:0`]);
    expect(visibleClassCount(ASSET, 2, keys)).toBe(1);
    expect(visibleClassCount(OTHER, 1, keys)).toBe(1);
    expect(visibleClassCount(ASSET, 2, new Set())).toBe(2);
  });
});
