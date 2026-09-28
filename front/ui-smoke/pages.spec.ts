// (1) Every page of the app router, without a wallet: the server answers 200,
// the page renders its shell and heading (or, behind a wallet gate, the gate),
// and nothing throws or logs an error in the browser (the guard in
// support/test.ts). Admin pages must show the wallet gate and nothing of the
// console behind it. On a mainnet build no page may mention devnet.
import type { Page } from "@playwright/test";
import { smokeRoutes, type SmokeRoute } from "./routes";
import { NETWORK, expect, test } from "./support/test";

const ROUTES = smokeRoutes();

/** Pages whose first heading is not an h1 by design. */
const NO_H1: Record<string, string> = {
  // Without a sign-in token the page says why in an h2.
  "/login/email": "We could not sign you in.",
};

const walletGate = (page: Page) => page.locator("section.wallet-access-card");

async function settle(page: Page, route: SmokeRoute) {
  const ready = NO_H1[route.pattern]
    ? page.getByRole("heading", { name: NO_H1[route.pattern] })
    : page.locator("h1:visible, section.wallet-access-card").first();
  await expect(ready).toBeVisible();
  // Let the page's own effects run (chain reads, API reads) so an error they
  // cause lands inside this test.
  await page.waitForTimeout(750);
}

test("the page list covers the app router", () => {
  expect(ROUTES.length).toBeGreaterThan(90);
  expect(ROUTES.filter((r) => r.kind === "admin").length).toBeGreaterThan(30);
  for (const route of ROUTES) expect(route.path, route.file).not.toContain("[");
});

for (const route of ROUTES) {
  test(`${route.kind} ${route.path}`, async ({ page }) => {
    const response = await page.goto(route.path);
    expect(response?.status(), "HTTP status").toBe(200);
    await settle(page, route);

    await expect(page.getByRole("navigation").first(), "site or app navigation").toBeVisible();
    await expect(page.getByRole("heading", { name: /^(Something went wrong|Nothing here)$/ })).toHaveCount(0);

    if (route.kind === "admin") {
      await expect(walletGate(page)).toBeVisible();
      await expect(walletGate(page).getByRole("heading", { name: "Connect wallet" })).toBeVisible();
      await expect(page.locator(".app-admin-layout")).toHaveCount(0);
    }

    if (NETWORK === "mainnet") {
      expect(await page.locator("body").innerText(), "devnet wording on a mainnet page").not.toMatch(/devnet/i);
    }
  });
}
