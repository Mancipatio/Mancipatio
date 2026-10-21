// The public introduction must describe the network and offered scope of the
// build, and send visitors into the existing application at /app.
import { createElement, type AnchorHTMLAttributes, type ImgHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({ Montserrat: () => ({ variable: "brand-font" }) }));
vi.mock("next/link", () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement("a", props),
}));
vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => createElement("img", props),
}));

import HomePage from "@/app/page";
import { ASSET_TYPES } from "@/lib/asset-types";
import { KYC_ONLY_ENV, KYC_ONLY_MESSAGE, PILOT_MODULE_ENV } from "@/lib/features";
import { operatorFor, operatorFooterLine } from "@/lib/legal/operator";

const render = () => renderToStaticMarkup(createElement(HomePage));
const visibleText = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
const anchors = (markup: string) => [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => ({
  attrs: match[1],
  href: /href="([^"]+)"/.exec(match[1])?.[1],
  text: visibleText(match[2]).trim(),
}));
const assetBand = (markup: string) => {
  const start = markup.indexOf("UNDERSTAND THE ASSET");
  return markup.slice(start, markup.indexOf("<section", start));
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv("NEXT_PUBLIC_ASSET_CLASSES", "");
  vi.stubEnv(KYC_ONLY_ENV, "");
  vi.stubEnv(PILOT_MODULE_ENV.secondaryTrading, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("the public landing page", () => {
  it("explains conversion in order without equating a held token with a registered share", () => {
    const markup = render();
    const steps = /<ol[^>]*aria-label="From token to registered owner: four steps"[^>]*>([\s\S]*?)<\/ol>/.exec(markup)?.[1] ?? "";
    const headings = [...steps.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((match) => match[1]);
    expect(headings).toEqual(["Token", "Convert", "Register", "Burn"]);
    expect(visibleText(steps)).toContain("Complete KYC");
    expect(visibleText(steps)).toContain("official register");
    expect(visibleText(steps)).toContain("After registration is confirmed");
    expect(visibleText(markup)).toContain("Holding a token alone does not make you a registered shareholder.");
    expect(anchors(markup).map((link) => link.href)).toContain("#ownership-path");
  });

  it("shows OTC as paused until both the public scope and its module are enabled", () => {
    expect(visibleText(render())).toContain("OTC trading is currently paused.");
    vi.stubEnv(PILOT_MODULE_ENV.secondaryTrading, "true");
    expect(visibleText(render())).toContain("OTC trading is currently paused.");
    vi.stubEnv(KYC_ONLY_ENV, "false");
    expect(visibleText(render())).not.toContain("OTC trading is currently paused.");
    vi.stubEnv(PILOT_MODULE_ENV.secondaryTrading, "false");
    expect(visibleText(render())).toContain("OTC trading is currently paused.");
  });

  it("mainnet default: truthful network, shared KYC-only notice and only the equity guide", () => {
    const markup = render();
    expect(visibleText(markup)).toContain("Built on Solana mainnet");
    expect(visibleText(markup)).toContain(KYC_ONLY_MESSAGE);
    expect(visibleText(markup)).not.toMatch(/devnet|Test environment/);

    const band = assetBand(markup);
    expect(band).toContain("Company ownership");
    expect(anchors(band).map((link) => link.href)).toEqual(["/markets/types/equity"]);
    for (const asset of ASSET_TYPES.filter((asset) => asset.slug !== "equity")) {
      expect(band).not.toContain(asset.title);
    }

    const links = anchors(markup);
    const appEntries = links.filter((link) => link.text === "Open app" || link.text === "Explore the app");
    expect(appEntries).toHaveLength(3);
    expect(appEntries.every((link) => link.href === "/app")).toBe(true);
    expect(links.map((link) => link.href)).toContain("/verify");
    for (const href of ["/apply", "/issuer", "/issuer/onboarding", "/marketplace/launchpad", "/marketplace/otc", "/markets/resell", "/portfolio/conversion"]) {
      expect(links.map((link) => link.href), href).not.toContain(href);
    }

    const socialLinks = links.filter((link) => link.href?.startsWith("https://x.com/"));
    expect(socialLinks).toHaveLength(2);
    for (const link of socialLinks) {
      expect(link.href?.toLowerCase()).toBe("https://x.com/manci_rwa");
      expect(link.attrs).toContain('target="_blank"');
      expect(link.attrs).toContain('rel="noopener noreferrer"');
    }
  });

  it("devnet stays labelled as a test environment and lists its offered asset classes", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    const markup = render();
    expect(visibleText(markup)).toContain("Explore on Solana devnet · Test environment");
    expect(visibleText(markup)).not.toContain("Built on Solana mainnet");
    expect(visibleText(markup)).not.toContain(KYC_ONLY_MESSAGE);
    const band = assetBand(markup);
    for (const asset of ASSET_TYPES) expect(band).toContain(asset.title);
    expect(anchors(band).map((link) => link.href)).toEqual(["/markets/types"]);
  });

  it("preserves the mainnet operator disclosure and company information link", () => {
    const markup = render();
    const operator = operatorFor("mainnet");
    const expectedLine = operatorFooterLine(operator, new Date().getFullYear());
    expect(operator.legalName).toBeTruthy();
    expect(expectedLine).not.toBeNull();
    expect(visibleText(markup)).toContain(operator.legalName!);
    expect(visibleText(markup)).toContain(expectedLine!);
    expect(anchors(markup).filter((link) => link.href === "/legal/company").map((link) => link.text))
      .toEqual(["Company & licence"]);
  });

  it("uses the configured offered classes without promoting the other classes", () => {
    vi.stubEnv("NEXT_PUBLIC_ASSET_CLASSES", "debt,real_estate");
    const band = assetBand(render());
    for (const asset of ASSET_TYPES) {
      if (["debt", "real_estate"].includes(asset.slug)) expect(band).toContain(asset.title);
      else expect(band).not.toContain(asset.title);
    }
    expect(anchors(band).map((link) => link.href)).toEqual(["/markets/types"]);
  });

  it("a single non-equity class links to its own guide with an accurate accessible name", () => {
    vi.stubEnv("NEXT_PUBLIC_ASSET_CLASSES", "debt");
    const band = assetBand(render());
    expect(band).toContain("Debt instruments");
    expect(band).not.toContain("Company ownership");
    const links = anchors(band);
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe("/markets/types/debt");
    expect(links[0].attrs).not.toContain("equity");
    expect(links[0].attrs).toMatch(/aria-label="Read the (?:debt instruments|asset) guide"/);
  });

  it("does not claim KYC-only restrictions once that mode is explicitly off", () => {
    vi.stubEnv(KYC_ONLY_ENV, "false");
    const text = visibleText(render());
    expect(text).toContain("Built on Solana mainnet");
    expect(text).not.toContain(KYC_ONLY_MESSAGE);
  });
});
