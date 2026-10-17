// The conversion marker (C2) in lists (lib/conversion-target): a class capped
// at 0 with no mint that a sibling converts into is a "Conversion target" —
// hidden from public lists and counts, labelled in admin and issuer views.
// A marker made without the Conversion permission (class 0 not linked yet)
// is one too: it used to show as "Pending mint" with an "Initialize mint"
// button, and one click turned it into a foreign class 1 the resume could
// never link.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { ShareClassType, type ShareClass } from "@/lib/generated/asset_registry";
import { findShareClassPda } from "@/lib/pdas";
import {
  CONVERSION_TARGET_LABEL,
  UNLINKED_TARGET_LABEL,
  classKey,
  conversionTargetKeys,
  hasMarkerShape,
  unlinkedMarkerKeys,
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
    expect(UNLINKED_TARGET_LABEL).toBe("Conversion target (not linked yet)");
  });

  it("an unlinked marker (class 0 has no target yet) is a target too; a foreign target is not", async () => {
    // Marker shape, class 0 of the same asset points nowhere: the marker a key
    // without the Conversion permission leaves behind. Hidden and never minted.
    expect(await conversionTargetKeys([cls({ asset: ASSET, classIndex: 0 }), marker(ASSET)])).toEqual(new Set([`${ASSET}:1`]));
    // Class 0 of ANOTHER asset converting to this asset's class-1 PDA does not count.
    const target = await findShareClassPda(ASSET, 1);
    expect(await conversionTargetKeys([cls({ asset: OTHER, classIndex: 0, convertibleTo: some(target) }), marker(ASSET)])).toEqual(new Set());
  });

  it("a minted, capped, uncapped or dilutable class never has the marker shape", () => {
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
    // The unlinked marker is dropped and uncounted the same way (no phantom "#1 Common · Pending mint").
    const unlinked = [cls({ asset: ASSET, classIndex: 0 }), marker(ASSET), cls({ asset: OTHER, classIndex: 0 })];
    const unlinkedKeys = await conversionTargetKeys(unlinked);
    expect(visibleClasses(unlinked, unlinkedKeys).map(classKey)).toEqual([`${ASSET}:0`, `${OTHER}:0`]);
    expect(visibleClassCount(ASSET, 2, unlinkedKeys)).toBe(1);
  });
});

describe("unlinked markers (made without the Conversion permission)", () => {
  it("class 0 unlinked + class 1 marker → the marker, synchronously", () => {
    expect(unlinkedMarkerKeys([cls({ asset: ASSET, classIndex: 0 }), marker(ASSET)])).toEqual(new Set([`${ASSET}:1`]));
  });

  it("a linked marker is not in the unlinked set, but still a target", async () => {
    const target = await findShareClassPda(ASSET, 1);
    const classes = [cls({ asset: ASSET, classIndex: 0, convertibleTo: some(target) }), marker(ASSET)];
    expect(unlinkedMarkerKeys(classes)).toEqual(new Set());
    expect(await conversionTargetKeys(classes)).toEqual(new Set([`${ASSET}:1`]));
  });

  it("class 0 pointing at a foreign PDA, a marker shape at index 2, or class 0 missing from the list → none", async () => {
    const foreign = [cls({ asset: ASSET, classIndex: 0, convertibleTo: some(OTHER) }), marker(ASSET)];
    expect(unlinkedMarkerKeys(foreign)).toEqual(new Set());
    expect(await conversionTargetKeys(foreign)).toEqual(new Set());
    const atTwo = [cls({ asset: ASSET, classIndex: 0 }), marker(ASSET, 2)];
    expect(unlinkedMarkerKeys(atTwo)).toEqual(new Set());
    expect(await conversionTargetKeys(atTwo)).toEqual(new Set());
    expect(unlinkedMarkerKeys([marker(ASSET)])).toEqual(new Set());
    expect(await conversionTargetKeys([marker(ASSET)])).toEqual(new Set());
  });

  it("another asset's unlinked class 0 does not count for this asset's marker", () => {
    expect(unlinkedMarkerKeys([cls({ asset: OTHER, classIndex: 0 }), marker(ASSET)])).toEqual(new Set());
    // Each asset is judged by its own class 0.
    expect(unlinkedMarkerKeys([cls({ asset: OTHER, classIndex: 0 }), marker(OTHER), cls({ asset: ASSET, classIndex: 0 }), marker(ASSET)])).toEqual(
      new Set([`${OTHER}:1`, `${ASSET}:1`]),
    );
  });

  it("needs no PDA: conversionTargetKeys finds it even when pdaOf fails", async () => {
    const pdaOf = async () => {
      throw new Error("no PDA for the unlinked check");
    };
    // Nothing links to anything, so the linked pass has no target to compare against the PDA.
    const classes = [cls({ asset: ASSET, classIndex: 0 }), marker(ASSET)];
    expect(unlinkedMarkerKeys(classes)).toEqual(new Set([`${ASSET}:1`]));
    await expect(conversionTargetKeys(classes, pdaOf)).rejects.toThrow(/no PDA/);
    expect(await conversionTargetKeys(classes)).toEqual(new Set([`${ASSET}:1`]));
  });
});

describe("views never offer the marker's mint (read from the sources)", () => {
  const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("the hook derives the set whenever a marker-shaped class exists, linked or not", () => {
    const hook = src("lib/use-conversion-targets.ts");
    expect(hook).toContain("classes.filter(hasMarkerShape).map(classKey)");
    expect(hook).toContain("void conversionTargetKeys(classes)");
  });

  it.each(["app/issuer/share-classes/page.tsx", "app/admin/share-classes/page.tsx"])(
    "%s gates 'Initialize Token-2022 mint' on the conversion-target set, which now holds unlinked markers",
    (rel) => {
      const page = src(rel);
      expect(page).toContain("conversionTargets.has(classKey(");
      const mint = page.indexOf("Initialize Token-2022 mint");
      expect(mint).toBeGreaterThan(-1);
      // The nearest condition above the button excludes a conversion target.
      const guard = page.lastIndexOf("!conversionTarget", mint);
      expect(guard).toBeGreaterThan(-1);
      expect(mint - guard).toBeLessThan(600);
      expect(page).toContain("CONVERSION_TARGET_LABEL");
    },
  );
});
