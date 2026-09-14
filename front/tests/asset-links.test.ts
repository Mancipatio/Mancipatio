// e2e §6 (P1/P2): links and React keys must identify an asset by its PDA and
// a sale by the full shareClass+saleId pair — the program allows the same
// assetId under different issuers and the same saleId under different classes.
import { describe, expect, it } from "vitest";
import { address } from "@solana/kit";
import {
  assetHref,
  isAddressLike,
  resolveAssetParam,
  saleHref,
  saleKey,
  shareClassKey,
  withAssetAddresses,
} from "@/lib/asset-links";
import { findAssetPda } from "@/lib/generated/asset_registry";

const ISSUER_A = address("11111111111111111111111111111111");
const ISSUER_B = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const CLASS_X = address("So11111111111111111111111111111111111111112");
const CLASS_Y = address("ComputeBudget111111111111111111111111111111");

const bondA = { issuer: ISSUER_A, assetId: "BOND-2026", name: "Bond A" };
const bondB = { issuer: ISSUER_B, assetId: "BOND-2026", name: "Bond B" };
const noteA = { issuer: ISSUER_A, assetId: "NOTE-1", name: "Note A" };

describe("asset public identity (PDA)", () => {
  it("pairs each asset with its own PDA even when assetIds collide", async () => {
    const rows = await withAssetAddresses([bondA, bondB]);
    const [pdaA] = await findAssetPda({ issuer: ISSUER_A, assetId: "BOND-2026" });
    const [pdaB] = await findAssetPda({ issuer: ISSUER_B, assetId: "BOND-2026" });
    expect(rows.map((r) => r.address)).toEqual([pdaA.toString(), pdaB.toString()]);
    expect(rows[0].address).not.toBe(rows[1].address);
    expect(isAddressLike(rows[0].address)).toBe(true);
    expect(isAddressLike("BOND-2026")).toBe(false);
  });

  it("builds links and keys from the PDA, not the bare assetId", async () => {
    const rows = await withAssetAddresses([bondA, bondB]);
    const hrefs = rows.map((r) => assetHref(r.address));
    expect(new Set(hrefs).size).toBe(2);
    expect(hrefs[0]).toBe(`/marketplace/assets/${rows[0].address}`);
    expect(hrefs[0]).not.toContain("BOND-2026");
  });

  it("resolves a PDA param to exactly that issuer's asset", async () => {
    const rows = await withAssetAddresses([bondA, bondB, noteA]);
    const hit = resolveAssetParam(rows, rows[1].address);
    expect(hit).toMatchObject({ kind: "found", legacy: false, address: rows[1].address });
    if (hit.kind === "found") expect(hit.asset.issuer).toBe(ISSUER_B);
  });

  it("refuses to pick the first match for an ambiguous legacy assetId link", async () => {
    const rows = await withAssetAddresses([bondA, bondB, noteA]);
    const hit = resolveAssetParam(rows, "BOND-2026");
    expect(hit.kind).toBe("ambiguous");
    if (hit.kind === "ambiguous") {
      expect(hit.candidates.map((c) => c.asset.name).sort()).toEqual(["Bond A", "Bond B"]);
    }
  });

  it("still honours a unique legacy assetId link and reports missing ids", async () => {
    const rows = await withAssetAddresses([bondA, bondB, noteA]);
    expect(resolveAssetParam(rows, "NOTE-1")).toMatchObject({ kind: "found", legacy: true, address: rows[2].address });
    expect(resolveAssetParam(rows, "NOPE")).toEqual({ kind: "missing" });
  });
});

describe("sale and share-class keys", () => {
  it("keeps two sale #1 records of different classes apart", () => {
    const map = new Map<string, string>();
    map.set(saleKey(CLASS_X, BigInt(1)), "salePdaX");
    map.set(saleKey(CLASS_Y, BigInt(1)), "salePdaY");
    expect(map.size).toBe(2);
    expect(map.get(saleKey(CLASS_X, 1))).toBe("salePdaX");
    expect(map.get(saleKey(CLASS_Y, BigInt(1)))).toBe("salePdaY");
    expect(saleKey(CLASS_X, BigInt(1))).not.toBe(saleKey(CLASS_Y, BigInt(1)));
  });

  it("keeps class #0 of two assets apart", () => {
    expect(shareClassKey(CLASS_X, 0)).not.toBe(shareClassKey(CLASS_Y, 0));
    expect(shareClassKey(CLASS_X, 0)).toBe(`${CLASS_X}:0`);
  });

  it("deep-links a sale by PDA and falls back to the launchpad index", () => {
    expect(saleHref("salePdaX")).toBe("/marketplace/launchpad/salePdaX");
    expect(saleHref(undefined)).toBe("/marketplace/launchpad");
    expect(saleHref(null)).toBe("/marketplace/launchpad");
  });
});

describe("saleHref encoding", () => {
  it("URL-encodes the sale identity so a malformed value cannot escape the segment", () => {
    expect(saleHref("a/b?c=d&e")).toBe("/marketplace/launchpad/a%2Fb%3Fc%3Dd%26e");
    expect(saleHref(CLASS_X)).toBe(`/marketplace/launchpad/${CLASS_X}`);
  });
});
