// How a tokenized company is shown on the public pages
// (lib/asset-presentation.ts, lib/asset-branding.ts, components/asset-roles.tsx):
// the published name instead of the registry's codes, the country by name,
// the verification in words, an approved logo or initials, and "Who gets
// what" in sentences that restate the Terms and the landing page.
import { createElement, type ReactNode } from "react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) =>
    createElement("a", { href, className }, children),
}));

import {
  assetInitials,
  assetKindLabel,
  countryLabel,
  publicAssetName,
  publicAssetSummary,
  shareClassLabel,
  unitPercent,
  verificationLabel,
} from "@/lib/asset-presentation";
import { approvedAssetLogo } from "@/lib/asset-branding";
import { AssetRoles } from "@/components/asset-roles";

const html = (node: ReactNode) => renderToStaticMarkup(node as never);
const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const MANCI = "HzjgBogwPPMzj5m2CgGLyPUv5Qz27TmvbFy9MWbevuv6";

describe("names instead of codes (lib/asset-presentation.ts)", () => {
  it("shows the published profile's name, else the on-chain name", () => {
    expect(publicAssetName("MANCI 17.5%", { display_name: "MANCI" })).toBe("MANCI");
    expect(publicAssetName("MANCI 17.5%", { display_name: "   " })).toBe("MANCI 17.5%");
    expect(publicAssetName("MANCI 17.5%", null)).toBe("MANCI 17.5%");
    expect(publicAssetSummary({ summary: " The company token. " })).toBe("The company token.");
    expect(publicAssetSummary({ summary: "" })).toBeNull();
    expect(publicAssetSummary(undefined)).toBeNull();
  });

  it("names a country from the ISO numeric code and shows nothing for a code it does not know", () => {
    expect(countryLabel(688)).toBe("Serbia");
    expect(countryLabel("688")).toBe("Serbia");
    expect(countryLabel(40)).toBe("Austria");
    expect(countryLabel(999)).toBeNull();
    expect(countryLabel("RS")).toBeNull();
    expect(countryLabel(null)).toBeNull();
    expect(countryLabel("")).toBeNull();
  });

  it("says the verification, the asset kind and the share class in words", () => {
    expect(verificationLabel(1)).toBe("Company verified by Manci");
    expect(verificationLabel(0)).toBe("Company verification in progress");
    expect(verificationLabel(2)).toBe("Company verification refused");
    expect(verificationLabel(3)).toBe("Company verification suspended");
    expect(verificationLabel(undefined)).toBe("Company verification unavailable");
    expect(assetKindLabel(0)).toBe("Company ownership");
    expect(assetKindLabel(99)).toBe("Other asset");
    expect(shareClassLabel(0)).toBe("Common");
    expect(shareClassLabel(99)).toBe("Share class");
  });

  it("gives the share of the company one token is only from consistent figures", () => {
    expect(unitPercent("100")).toBe("0.01");
    expect(unitPercent("10")).toBe("0.001");
    expect(unitPercent("1")).toBe("0.0001");
    expect(unitPercent("0")).toBeNull();
    expect(unitPercent("0.01")).toBeNull();
    expect(unitPercent(null)).toBeNull();
  });

  it("falls back to initials for an asset without an approved logo", () => {
    expect(assetInitials("MANCI")).toBe("MA");
    expect(assetInitials("Acme Industries")).toBe("AI");
    expect(assetInitials("Mancipatio d.o.o. · 17.5 %")).toBe("MD");
    expect(assetInitials("  ")).toBe("?");
  });
});

describe("approved logos (lib/asset-branding.ts)", () => {
  it("has MANCI's logo on mainnet, as a file this site serves, and none elsewhere", () => {
    const logo = approvedAssetLogo(MANCI, "mainnet");
    expect(logo).toEqual({ src: "/tokens/manci0.png" });
    expect(existsSync(join(process.cwd(), "public", logo!.src))).toBe(true);
    expect(approvedAssetLogo(MANCI, "devnet")).toBeNull();
    expect(approvedAssetLogo("toString", "mainnet")).toBeNull();
    expect(approvedAssetLogo(null, "mainnet")).toBeNull();
  });

  it("never takes a logo from a profile field or a remote address", () => {
    const text = source("lib/asset-branding.ts") + source("components/asset-logo.tsx");
    expect(text).not.toMatch(/cover_image_path|logo_gradient|https?:\/\//);
  });
});

describe("Who gets what (components/asset-roles.tsx)", () => {
  const equity = { name: "MANCI", companyShares: true, oneTokenPercent: "0.01", conversionHref: "/portfolio/conversion", verified: true };

  it("says what the holder has, what the company does and what Manci does", () => {
    const markup = html(createElement(AssetRoles, equity));
    for (const heading of ["Who gets what", "You, the token holder", "The company", "Manci"]) expect(markup).toContain(heading);
    expect(markup).toContain("<strong>0.01 % of the company per token</strong>");
    expect(markup).toContain("Tokens are bearer instruments: whoever controls the wallet can transfer them.");
    expect(markup).toContain("Holding a token alone does not make you a registered shareholder.");
    expect(markup).toContain("Where the issuer offers conversion and it is available");
    expect(markup).toContain('href="/portfolio/conversion"');
    expect(markup).toContain("Is responsible for the token, its documents and its disclosures.");
    expect(markup).toContain("Pays Manci what its engagement agreement provides.");
    expect(markup).toContain("Has verified the company that issued this token.");
    expect(markup).toContain("Is not the issuer and is not a party to the token between you and the issuer.");
    for (const href of ["/legal/terms", "/risks", "/pricing"]) expect(markup).toContain(`href="${href}"`);
  });

  it("states no figure it was not given and no conversion that is not open", () => {
    const markup = html(createElement(AssetRoles, { ...equity, oneTokenPercent: null, conversionHref: null, verified: false }));
    expect(markup).not.toContain("% of the company per token");
    expect(markup).toContain("The size of that share per token is set in the token&#x27;s documents.");
    expect(markup).toContain("Conversion is not open on this network at present.");
    expect(markup).not.toContain('href="/portfolio/conversion"');
    expect(markup).toContain("That verification is not complete.");
  });

  it("makes no share or register claim for an asset that is not company ownership", () => {
    const markup = html(createElement(AssetRoles, { ...equity, companyShares: false }));
    expect(markup).not.toMatch(/registered shareholder|official register|share in the company/);
    expect(markup).toContain("The rights set out in the token&#x27;s documents, and nothing beyond them.");
  });

  it("promises nothing: no fee figure, no return, no price", () => {
    const markup = html(createElement(AssetRoles, equity));
    expect(markup).not.toMatch(/no fee|free|guarantee|return on|profit|€|\$/i);
  });
});

describe("the public pages print names, not registry codes", () => {
  it("the overview, the marketplace cards and the issuer page read the published name", () => {
    for (const page of ["components/market-overview.tsx", "app/marketplace/page.tsx", "app/marketplace/issuers/[id]/page.tsx", "app/marketplace/assets/[id]/page.tsx"]) {
      expect(source(page), page).toContain("publicAssetName(");
      expect(source(page), page).toContain("<AssetLogo");
      // The KYB status and the jurisdiction are shown in words (lib/asset-presentation.ts).
      expect(source(page), page).not.toMatch(/KYB_LABEL|ISO-3166|>\s*Jurisdiction\s*</);
    }
  });

  it("the cards carry no asset id, symbol prefix or issuer legal id", () => {
    const cards = source("app/marketplace/page.tsx");
    const card = cards.slice(cards.indexOf("{filteredAssets.map("), cards.indexOf("</Grid>"));
    // Printed text only: the asset id still builds the link's key and its fallback address.
    expect(card).not.toMatch(/\{a\.assetId\} ·|\{a\.symbolPrefix\}|\{issuerLegal \?\?|font-mono/);
    const row = source("components/market-overview.tsx");
    expect(row).not.toMatch(/\{row\.asset\.symbolPrefix\}|\$\{row\.issuerLegalId\}/);
  });

  it("the asset page keeps the identifiers in one labelled block, after everything else", () => {
    const page = source("app/marketplace/assets/[id]/page.tsx");
    const details = page.indexOf("On-chain details");
    expect(details).toBeGreaterThan(page.indexOf("<AssetRoles"));
    expect(details).toBeGreaterThan(page.indexOf("<SupplyConversionsPanel"));
    // The header no longer prints "asset id · symbol · issuer id".
    expect(page).not.toContain("{asset.assetId} ·");
    expect(page.indexOf("value={asset.assetId}")).toBeGreaterThan(details);
    expect(page.indexOf("value={asset.symbolPrefix}")).toBeGreaterThan(details);
    expect(page.indexOf('label="Asset ID"')).toBeGreaterThan(details);
  });
});
