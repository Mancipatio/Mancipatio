// (2) The wallet flows with the mock Wallet Standard wallet
// (support/mock-wallet.ts): connecting, the SIWS session sign-in, and the
// admin console's role gate read from the (mock) chain.
import type { Page, Request } from "@playwright/test";
import { siwsMessage, type SiwsPayload } from "@/lib/siws-client";
import { siwsSignedBytes, type SiwsSignatureFormat } from "@/lib/siws-offchain";
import { ApiMock } from "./support/api-mocks";
import { platformAccount, smokeAddress } from "./support/chain-fixtures";
import { installMockWallet, signedMessages, testWallet, verifiesFor } from "./support/mock-wallet";
import { NETWORK, expect, test } from "./support/test";

const wallet = testWallet();
const short = `${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}`;
const gate = (page: Page) => page.locator("section.wallet-access-card");

async function connect(page: Page) {
  // The mock is the only wallet, so the control connects without a picker.
  await gate(page).getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByText(short).filter({ visible: true }).first()).toBeVisible();
}

type SignedBody = { payload: SiwsPayload; signature: string; publicKey: string; sigFormat?: SiwsSignatureFormat };

/**
 * The server half of the session sign-in is app/api/auth/session; it needs
 * the shared nonce store, which the smoke server does not have. The stand-in
 * answers as the route does once the signature, key and payload check out,
 * and verifies the signature here, against the test key. The admin menu
 * counts (app/api/admin/badges) answer "nothing waiting".
 */
function serveAdminSession(api: ApiMock) {
  const sessions: SignedBody[] = [];
  const badgeReads: Request[] = [];
  api.on("/api/auth/session", (request) => {
    const body = request.postDataJSON() as SignedBody;
    sessions.push(body);
    const format = body.sigFormat ?? "raw";
    const bytes = siwsSignedBytes(siwsMessage(body.payload), body.payload.wallet, format);
    const valid = body.publicKey === wallet.address && verifiesFor(wallet, bytes, Buffer.from(body.signature, "base64"));
    if (!valid) return { status: 401, json: { ok: false, error: "Invalid signature" } };
    return ApiMock.ok({ wallet: wallet.address, network: NETWORK, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  });
  api.on("/api/admin/badges", (request) => {
    badgeReads.push(request);
    return ApiMock.ok({ network: NETWORK, checkedAt: new Date().toISOString(), badges: {} });
  });
  return { sessions, badgeReads };
}

test.beforeEach(async ({ page }) => {
  await installMockWallet(page, wallet);
});

test("a super admin signs in with one SIWS message and the admin console opens @localnet-only", async ({ page, chain, api }) => {
  chain.set(await platformAccount({ admin: wallet.address }));
  const { sessions, badgeReads } = serveAdminSession(api);

  await page.goto("/admin");
  await expect(gate(page)).toBeVisible();
  await connect(page);

  await expect(page.locator(".app-admin-layout")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Administration pages" })).toBeVisible();
  await expect.poll(() => badgeReads.length).toBeGreaterThan(0);

  // Exactly one signature: the auth.session message, for this origin and
  // network, verified here against the test key.
  expect(sessions).toHaveLength(1);
  const [session] = sessions;
  expect(session.payload).toMatchObject({
    v: 2,
    action: "auth.session",
    wallet: wallet.address,
    origin: "http://127.0.0.1:3310",
    network: NETWORK,
    params: {},
  });
  const signed = await signedMessages(page);
  expect(signed).toHaveLength(1);
  const expectedBytes = siwsSignedBytes(siwsMessage(session.payload), wallet.address, session.sigFormat ?? "raw");
  expect(Buffer.from(signed[0].message).equals(Buffer.from(expectedBytes))).toBe(true);
  expect(verifiesFor(wallet, signed[0].message, signed[0].signature)).toBe(true);
  expect(new TextDecoder().decode(signed[0].message)).toContain("auth.session");

  // The menu counts ride on the session cookie: no signature of their own.
  expect(badgeReads[0].postDataJSON()).toMatchObject({ session: true, payload: { action: "admin.badges", wallet: wallet.address } });
});

test("a super admin opens an admin-only page", async ({ page, chain, api }) => {
  chain.set(await platformAccount({ admin: wallet.address }));
  serveAdminSession(api);
  await page.goto("/admin/platform");
  await connect(page);
  await expect(page.locator(".app-admin-layout")).toBeVisible();
  await expect(page.getByText("Access denied")).toHaveCount(0);
});

test("a connected wallet without a role gets Access denied on the admin pages", async ({ page, chain }) => {
  chain.set(await platformAccount({ admin: smokeAddress("someone-else") }));
  await page.goto("/admin/platform");
  await connect(page);
  await expect(page.getByText("Access denied")).toBeVisible();
  await expect(page.getByText("This page requires the Admin role.")).toBeVisible();
  await expect(page.getByText("Connected as: Public")).toBeVisible();
  await expect(page.locator(".app-admin-layout")).toHaveCount(0);
  // A refused page never asks the wallet to sign. The wallet's record lives in
  // the page, so each page is checked before the next navigation.
  expect(await signedMessages(page)).toHaveLength(0);

  // The KYC pages name their other role.
  await page.goto("/admin/kyc");
  await expect(page.getByText("Access denied")).toBeVisible();
  await expect(page.getByText(/This page requires one of these roles:/)).toBeVisible();
  expect(await signedMessages(page)).toHaveLength(0);
});
