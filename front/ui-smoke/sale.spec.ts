// (2) The sale page's gates, read before the user starts: the emergency pause
// (lib/pause-gate.ts), the issuer's proceeds freeze (lib/proceeds-gate.ts,
// D1) and the geoblock (proxy.ts, lib/geoblock.ts). The sale is one Mature
// raise on the mock chain (support/chain-fixtures.ts), with a connected mock
// wallet so the page reaches its purchase panel.
import type { Page } from "@playwright/test";
import { AssetRegistryInstruction, RaiseType } from "@/lib/generated/asset_registry";
import { GEOBLOCKED_MESSAGE } from "@/lib/geoblock";
import { pausedFlowFor } from "@/lib/pause-gate";
import { PAUSE_PRIMARY } from "@/lib/pause-flags";
import { findPlatformPda } from "@/lib/generated/asset_registry";
import { findIssuerFreezePda } from "@/lib/pdas";
import {
  SMOKE_SALE,
  issuerFreezeAccount,
  platformAccount,
  saleChainAccounts,
  smokeAddress,
  smokeSaleAddress,
} from "./support/chain-fixtures";
import { installMockWallet, testWallet } from "./support/mock-wallet";
import { expect, test } from "./support/test";

const wallet = testWallet("buyer");
const FROZEN = /Manci has frozen this issuer.s proceeds: this sale takes no purchases/;
const PAUSED = pausedFlowFor(PAUSE_PRIMARY, AssetRegistryInstruction.Buy, { raiseType: RaiseType.Mature });

const SALE_HEADING = /^Sale [1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}$/;

async function openSale(page: Page) {
  await page.goto(`/marketplace/launchpad/${await smokeSaleAddress()}`);
  // The page found the sale on the chain and reached its purchase panel.
  await expect(page.getByRole("heading", { level: 1, name: SALE_HEADING })).toBeVisible();
  await expect(page.getByText("Buy shares")).toBeVisible();
}

test.describe("the sale page", () => {
  test.beforeEach(async ({ page, chain }) => {
    await installMockWallet(page, wallet);
    chain.set(...(await saleChainAccounts()));
  });

  test("an open sale with nothing paused or frozen shows neither notice", async ({ page, chain }) => {
    chain.set(await platformAccount({ admin: smokeAddress("super-admin") }));
    await openSale(page);
    await page.getByRole("button", { name: "Connect wallet" }).filter({ visible: true }).first().click();
    await expect(page.getByText(`${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}`).filter({ visible: true }).first()).toBeVisible();
    // Both gates were read (the Platform's pause flags, the issuer's freeze
    // record) before their absence counts.
    const [platform] = await findPlatformPda();
    const freeze = await findIssuerFreezePda(SMOKE_SALE.issuer);
    await expect.poll(() => chain.reads.has(platform) && chain.reads.has(freeze)).toBe(true);
    await page.waitForTimeout(500);
    expect(PAUSED).toBeTruthy();
    await expect(page.getByText(PAUSED!)).toHaveCount(0);
    await expect(page.getByText(FROZEN)).toHaveCount(0);
  });

  test("the emergency pause of primary sales is shown before a buy", async ({ page, chain }) => {
    chain.set(await platformAccount({ admin: smokeAddress("super-admin"), pauseFlags: PAUSE_PRIMARY }));
    await openSale(page);
    await expect(page.getByRole("status").filter({ hasText: PAUSED! })).toBeVisible();
  });

  test("the issuer's proceeds freeze closes the sale to purchases", async ({ page, chain }) => {
    chain.set(await platformAccount({ admin: smokeAddress("super-admin") }), await issuerFreezeAccount());
    await openSale(page);
    await expect(page.getByRole("status").filter({ hasText: FROZEN })).toBeVisible();
    await expect(page.getByText(PAUSED!)).toHaveCount(0);
  });
});

test.describe("the geoblock @localnet-only", () => {
  // Outside Vercel only a test network trusts the country header (a mainnet
  // deployment ignores a client-sent one); the smoke server's list is AA,ZZ.
  test("a listed country gets the not-available page in place of the sale", async ({ page, chain, guard }) => {
    // KNOWN DEFECT (reported with ops-qa-5): the rewrite serves the statically
    // prerendered /not-available page under the sale's URL, and the shared
    // shell reads usePathname(), so hydration fails (React #418) and the tree
    // is rendered again on the client. /not-available opened directly
    // hydrates cleanly (pages.spec.ts). Remove once proxy.ts / the page is fixed.
    guard.allowKnownPageError(/Minified React error #418/);
    chain.set(await platformAccount({ admin: smokeAddress("super-admin") }), ...(await saleChainAccounts()));
    await page.setExtraHTTPHeaders({ "x-vercel-ip-country": "ZZ" });
    const saleUrl = `/marketplace/launchpad/${await smokeSaleAddress()}`;
    await page.goto(saleUrl);
    await expect(page.getByRole("heading", { name: "Not available in your country" })).toBeVisible();
    expect(new URL(page.url()).pathname, "shown in place, not redirected").toBe(saleUrl);
    await expect(page.getByRole("heading", { level: 1, name: SALE_HEADING })).toHaveCount(0);
  });

  test("a country off the list gets the sale", async ({ page, chain }) => {
    chain.set(await platformAccount({ admin: smokeAddress("super-admin") }), ...(await saleChainAccounts()));
    await page.setExtraHTTPHeaders({ "x-vercel-ip-country": "DE" });
    await openSale(page);
    await expect(page.getByRole("heading", { name: "Not available in your country" })).toHaveCount(0);
  });

  test("the transactional API refuses a listed country with 451", async ({ request }) => {
    const response = await request.post("/api/launchpad/commit", {
      headers: { "x-vercel-ip-country": "ZZ", "content-type": "application/json" },
      data: {},
    });
    expect(response.status()).toBe(451);
    expect(await response.json()).toEqual({ ok: false, error: GEOBLOCKED_MESSAGE, code: "GEOBLOCKED" });
  });
});
