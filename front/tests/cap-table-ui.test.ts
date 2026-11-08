// The cap table pages and the public panel, rendered to static markup:
// the shared reconciliation view shows what the table carries (an issuer's
// table has no dossier link, note or void reason to show), the public
// figures render with KYC-only mode on and carry no case number, no holder
// and no call to action, and the menus offer the new pages. The class cap is
// never "100 % of the company": MANCI-2026's 1,750 units are 17.5 %, and a
// percentage shows only with the share of one unit (else units only).
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) =>
    createElement("a", { href, className }, children),
}));

import { CapTableView } from "@/components/cap-table-view";
import { SupplyConversionsFigures } from "@/components/supply-conversions-panel";
import { issuerReconciliation, publicSupplyClass, reconcileAsset, type ClassChainFacts, type UnitShareFigures } from "@/lib/cap-table";
import { ADMIN_MENU } from "@/app/admin/admin-menu";
import { ISSUER_WORKFLOW_TABS } from "@/lib/issuer-workflow";
import { adminRouteRequirement } from "@/lib/role-resolution";
import { moduleRouteState, navHrefVisible } from "@/lib/pilot-scope";

const html = (node: ReactNode) => renderToStaticMarkup(node as never);
const n = (v: number) => BigInt(v);
const CLASS = "C1assC1assC1assC1assC1assC1assC1assC1ass1";
const CLIENT = "d0000000-0000-4000-8000-000000000001";
const TX = "1".repeat(87) + "A";
const SHA = "ab".repeat(32);

/** MANCI-2026: a 1,750-unit cap = 17.5 % of the company, 500 issued, 250 converted, 250 outstanding. */
const chain: ClassChainFacts = {
  shareClassPda: CLASS, classIndex: 0, mint: "MintMintMintMintMintMintMintMintMintMint1", maxSupply: n(1_750),
  cumulativeCap: false, lifetimeMinted: n(500), circulatingSupply: n(250), lockedSupply: n(0), mintSupply: n(250),
  custodyVaults: [], holders: [{ owner: "TreasuryTreasuryTreasuryTreasuryTreasury1", units: n(250), kind: "treasury" }],
};
/** Its tokenize figures: 1,750 units of 0.01 % each. */
const FIGURES: UnitShareFigures = { classIndex: 0, tokens: n(1_750), tokenE4: n(100) };
const table = reconcileAsset(
  { asset_pda: "AssetAssetAssetAssetAssetAssetAssetAsset1", asset_id: "MANCI-2026", name: "Mancipatio", symbol: "MANCI", issuer_pda: "Issuer1" },
  "devnet", [chain],
  [{ id: "c1", shareClassPda: CLASS, status: "converted", units: n(250), burned: n(250), realizeTx: TX, vaultPda: null, holderWallet: "Ho1der", clientId: CLIENT, decidedAt: "2026-10-10T12:00:00Z" }],
  [
    { id: "e1", shareClassPda: CLASS, units: n(250), percentBps: "250", registry: "APR", decisionRef: "BD 12345/2026", decisionDate: "2026-10-09",
      decisionDocSha256: SHA, conversionRequestId: "c1", realizeTx: TX, status: "recorded", holderClientId: CLIENT, note: "Staff note on Jane",
      voidReason: null, voidedBy: null, voidedAt: null, createdBy: "Admin1" },
    { id: "e0", shareClassPda: CLASS, units: n(25), percentBps: "25", registry: "APR", decisionRef: "BD 12345/2026", decisionDate: "2026-10-09",
      decisionDocSha256: SHA, conversionRequestId: "c1", realizeTx: TX, status: "voided", holderClientId: CLIENT, note: "",
      voidReason: "Typo for Jane", voidedBy: "Admin1", voidedAt: "2026-10-10T12:30:00Z", createdBy: "Admin1" },
  ],
  FIGURES,
  new Date("2026-11-08T10:00:00Z"),
);

afterEach(() => vi.unstubAllEnvs());

describe("the reconciliation view", () => {
  it("the admin view shows the checks, the figures, the dossier link, the note and the void reason", () => {
    const markup = html(createElement(CapTableView, { table, audience: "admin" }));
    expect(markup).toContain("Converted units equal registered units");
    expect(markup).toContain("Burned through conversions");
    expect(markup).toContain(`href="/admin/clients/${CLIENT}"`);
    expect(markup).toContain("Staff note on Jane");
    expect(markup).toContain("Typo for Jane");
    expect(markup).toContain("BD 12345/2026");
    expect(markup).toContain(`https://explorer.solana.com/tx/${TX}?cluster=devnet`);
    expect(markup).toContain("Class cap");
    expect(markup).toContain("1,750 units (17.5 % of the company)");
    expect(markup).toContain("0.01 % of the company");
    expect(markup).toContain(`500<span class="ml-1.5 text-slate-500">(5 %)</span>`);
    expect(markup).toContain("The tokenize figures match the class cap");
    expect(markup).not.toContain("100 % of the company");
  });

  it("without figures that match the class: units only, and the check says why", () => {
    const off = reconcileAsset(
      { asset_pda: "AssetAssetAssetAssetAssetAssetAssetAsset1", asset_id: "MANCI-2026", name: "Mancipatio", symbol: "MANCI", issuer_pda: "Issuer1" },
      "devnet", [chain], [], [], { ...FIGURES, tokens: n(10_000) }, new Date("2026-11-08T10:00:00Z"),
    );
    const markup = html(createElement(CapTableView, { table: off, audience: "admin" }));
    expect(markup).toContain("1,750 units</dd>");
    // No figure carries a share of the company: no "(5 %)", no "% of the company".
    expect(markup).not.toMatch(/\(\d[\d.,]* %\)/);
    expect(markup).not.toContain("% of the company");
    expect(markup).toContain("the class cap is 1,750 units: no percentages are shown until they agree");
  });

  it("the issuer view has wallets, units and decision references, nothing personal", () => {
    const markup = html(createElement(CapTableView, { table: issuerReconciliation(table), audience: "issuer" }));
    for (const secret of [CLIENT, "Staff note", "Typo for Jane", "Holder dossier", "Voided"]) expect(markup, secret).not.toContain(secret);
    expect(markup).toContain("BD 12345/2026");
    expect(markup).toContain("Issuer treasury");
  });
});

describe("the public supply figures", () => {
  const realized = [{ status: "converted" as const, vaultPda: null, units: n(250), realizeTx: TX }];
  const recorded = [
    { units: n(250), percentBps: "250", registry: "APR", decisionDate: "2026-10-09", decisionDocSha256: SHA, realizeTx: TX, status: "recorded" as const },
  ];
  const supplyOf = (cls: ReturnType<typeof publicSupplyClass>) => ({
    network: "mainnet",
    asset_pda: "AssetAssetAssetAssetAssetAssetAssetAsset1",
    generated_at: "2026-11-08T10:00:00.000Z",
    classes: [cls],
  });

  it("render with KYC-only mode on: the class cap, issued, outstanding, in conversion, converted and the record", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_KYC_ONLY", "");
    const markup = html(createElement(SupplyConversionsFigures, { supply: supplyOf(publicSupplyClass(chain, realized, recorded, FIGURES)) }));
    expect(markup).toContain("Class cap");
    expect(markup).toContain("1,750 units (17.5 % of the company)");
    expect(markup).toContain("1 unit = 0.01 % of the company");
    expect(markup).toContain("Issued");
    expect(markup).toContain("500 units (5 %)");
    expect(markup).toContain("250 units (2.5 %)");
    expect(markup).toContain("In conversion");
    expect(markup).toContain("1 conversion · 250 units · 2.5 % of the company");
    expect(markup).not.toContain("100 % of the company");
    expect(markup).not.toContain("pending");
    expect(markup).toContain(SHA);
    expect(markup).toContain(`https://explorer.solana.com/tx/${TX}"`);
    expect(markup).not.toMatch(/BD 12345|<button|href="\/portfolio|request/i);
    expect(markup).not.toMatch(/\baudit(ed)?\b/i);
  });

  it("a draft profile (no published figures): units only, and the realized conversion with its register entry pending", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    const markup = html(createElement(SupplyConversionsFigures, { supply: supplyOf(publicSupplyClass(chain, realized, [], null)) }));
    expect(markup).toContain("1,750 units");
    expect(markup).toContain("500 units");
    expect(markup).not.toMatch(/\d %/);
    expect(markup).not.toContain("None yet");
    expect(markup).toContain("1 conversion realized on chain · 250 units · register entry pending");
    expect(markup).toContain("Register entry pending");
    expect(markup).toContain(`https://explorer.solana.com/tx/${TX}"`);
    expect(markup).not.toMatch(/BD 12345|Jane|Ho1der|<button/);
  });

  it("nothing converted yet: none yet, and no record table", () => {
    const markup = html(createElement(SupplyConversionsFigures, { supply: supplyOf(publicSupplyClass(chain, [], [], FIGURES)) }));
    expect(markup).toContain("None yet");
    expect(markup).not.toContain("Conversion record");
  });
});

describe("navigation", () => {
  it("the admin menu offers the cap table to admins only (the default rule)", () => {
    const items = ADMIN_MENU.flatMap((g) => g.items);
    const entry = items.find((i) => i.href === "/admin/cap-table");
    expect(entry?.label).toBe("Cap table");
    expect(adminRouteRequirement("/admin/cap-table")).toEqual(["admin"]);
    expect(entry?.roles).toEqual(["admin"]);
  });

  it("the issuer tab: shown with KYC-only mode off; with it on the page stays under the notice", () => {
    expect(ISSUER_WORKFLOW_TABS.map(([href]) => href)).toContain("/issuer/cap-table");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_KYC_ONLY", "off");
    expect(navHrefVisible("/issuer/cap-table", "mainnet")).toBe(true);
    expect(moduleRouteState("/issuer/cap-table", "mainnet")).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_FEATURE_KYC_ONLY", "");
    expect(navHrefVisible("/issuer/cap-table", "mainnet")).toBe(false);
    expect(moduleRouteState("/issuer/cap-table", "mainnet")).toMatchObject({ disabled: true, route: { mode: "notice" } });
    // The public asset page is browsing: no notice, never hidden.
    expect(moduleRouteState("/marketplace/assets/x", "mainnet")).toBeNull();
    expect(navHrefVisible("/admin/cap-table", "mainnet")).toBe(true);
  });
});
