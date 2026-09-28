// Playwright UI smoke (ops-qa-5, plan 6.5): every page of a PRODUCTION build
// (`next build` + `next start` on 127.0.0.1:3310) with a mocked chain, a mock
// Wallet Standard wallet and no external network. How to run it: README.md
// ("UI smoke"). The build is not made here: run `npm run ui-smoke:build`
// (localnet) or scripts/ci/mainnet-build.sh with CI=1 (mainnet) first.
//
// The default build is a localnet build with placeholder settings
// (ui-smoke/env.json). UI_SMOKE_NETWORK=mainnet runs the suite against the
// mainnet build instead: tests tagged @localnet-only are skipped there, the
// ones tagged @mainnet-only run only there.
import { defineConfig, devices } from "@playwright/test";
import env from "./ui-smoke/env.json";

export const UI_SMOKE_PORT = 3310;
const network = process.env.UI_SMOKE_NETWORK === "mainnet" ? "mainnet" : "localnet";

export default defineConfig({
  testDir: "./ui-smoke",
  testMatch: "**/*.spec.ts",
  outputDir: "./ui-smoke/.results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "./ui-smoke/.report", open: "never" }]]
    : [["list"]],
  grepInvert: network === "mainnet" ? /@localnet-only/ : /@mainnet-only/,
  use: {
    baseURL: `http://127.0.0.1:${UI_SMOKE_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
  },
  projects: [{ name: `chromium-${network}`, use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -H 127.0.0.1 -p ${UI_SMOKE_PORT}`,
    url: `http://127.0.0.1:${UI_SMOKE_PORT}/robots.txt`,
    env: { ...(env[network] as Record<string, string>) },
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
