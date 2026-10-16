// /admin/assets mapped assets to their PDA by the bare assetId. The program
// seeds the asset PDA by issuer + assetId (lib/asset-links), so two issuers'
// assets under one ID ("SERIES-A", "<SYM>-5PCT") shared a single PDA in the
// map: Manage opened, Archive hid and Activate activated the OTHER issuer's
// asset, and the post-activation patch flipped both rows to Active. The map
// is now keyed by issuer + assetId (the page's assetKey) and every PDA comes
// from withAssetAddresses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { address } from "@solana/kit";
import { withAssetAddresses } from "@/lib/asset-links";
import { findAssetPda } from "@/lib/generated/asset_registry";

const ISSUER_A = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ISSUER_B = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const bondA = { issuer: ISSUER_A, assetId: "BOND-2026" };
const bondB = { issuer: ISSUER_B, assetId: "BOND-2026" };

/** The page's own assetKey (module-private there): issuer PDA + assetId, the asset PDA's seeds. */
const assetKey = (a: { issuer: { toString(): string }; assetId: string }) => `${a.issuer}:${a.assetId}`;

const page = readFileSync(join(process.cwd(), "app/admin/assets/page.tsx"), "utf8");

describe("admin asset map (issuer + assetId → PDA)", () => {
  it("keeps two issuers' same assetId apart, where the bare ID merged them", async () => {
    const rows = await withAssetAddresses([bondA, bondB]);
    const byKey = new Map(rows.map((r) => [assetKey(r.asset), r.address]));
    expect(byKey.size).toBe(2);
    const [pdaA] = await findAssetPda({ issuer: ISSUER_A, assetId: "BOND-2026" });
    const [pdaB] = await findAssetPda({ issuer: ISSUER_B, assetId: "BOND-2026" });
    expect(byKey.get(assetKey(bondA))).toBe(pdaA.toString());
    expect(byKey.get(assetKey(bondB))).toBe(pdaB.toString());
    expect(pdaA.toString()).not.toBe(pdaB.toString());
    // The old map: one entry, the second issuer's PDA overwriting the first's.
    const byId = new Map(rows.map((r) => [r.asset.assetId, r.address]));
    expect(byId.size).toBe(1);
    expect(byId.get("BOND-2026")).toBe(pdaB.toString());
  });

  it("the page derives every PDA with withAssetAddresses and keys by assetKey, never by the bare ID", () => {
    expect(page).toContain('function assetKey(a: Pick<Asset, "issuer" | "assetId">): string {');
    expect(page).toContain("return `${a.issuer}:${a.assetId}`;");
    expect(page).toContain("withAssetAddresses(network.assets)");
    expect(page).toContain("pm.set(assetKey(a), address)");
    expect(page).not.toContain("findAssetPda(");
    // Rows, the archived count and the category counts all look up by the key.
    expect(page.match(/pdaMap\.get\(assetKey\((asset|a)\)\)/g)).toHaveLength(3);
    expect(page).not.toMatch(/pdaMap\.get\((asset|a)\.assetId\)/);
    expect(page).not.toMatch(/pm\.set\(a\.assetId/);
  });

  it("the local post-activation patch matches the issuer too, so the other issuer's draft keeps its Activate", () => {
    expect(page).toMatch(/a\.issuer === asset\.issuer && a\.assetId === asset\.assetId/);
    expect(page).not.toMatch(/\n\s*a\.assetId === asset\.assetId\n/);
  });
});
