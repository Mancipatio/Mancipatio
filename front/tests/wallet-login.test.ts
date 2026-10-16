import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WalletSession } from "@solana/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn(), wallet: null as WalletSession | null }));
vi.mock("@/lib/siws-client", async (original) => ({ ...(await original<typeof import("@/lib/siws-client")>()), signedFetch: mocks.request }));
vi.mock("@solana/react-hooks", () => ({
  useWalletConnection: () => ({ connected: !!mocks.wallet, isReady: true, wallet: mocks.wallet }),
  useSolanaClient: () => ({ store: { getState: () => ({ wallet: { status: "connected", session: mocks.wallet } }) } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/account-login", () => ({
  useSignedInAccount: () => ({ status: "signed_out", account: null }), signedInAccountSnapshot: () => ({ status: "signed_out", account: null }),
  startEmailSignIn: vi.fn(), startGoogleSignIn: vi.fn(), completeEmailSignIn: vi.fn(),
}));
vi.mock("@/app/wallet-button", () => ({ WalletButton: () => createElement("button", null, "Connect wallet") }));
vi.mock("@/components/turnstile-widget", () => ({ TurnstileWidget: () => null }));

import { safeLoginNext, signInWithWallet } from "@/lib/wallet-login";
import { SignIn } from "@/components/sign-in";

const wallet = (signMessage: () => Promise<Uint8Array> = vi.fn(async () => new Uint8Array(64))) => ({
  account: { address: "11111111111111111111111111111111" }, signMessage,
}) as unknown as WalletSession;

beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", ""); mocks.request.mockReset(); mocks.wallet = null; });
afterEach(() => vi.unstubAllEnvs());

describe("explicit wallet sign-in", () => {
  it("opens the wallet account using only the read session flow", async () => {
    mocks.request.mockResolvedValue({ profile: { id: "account-1" } });
    const session = wallet();
    await signInWithWallet(session, () => true);
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ account: session.account }),
      "/api/account/me", "account.me", {}, { interactive: "session-only" });
  });

  it("does not send a signature when the actor changes during approval", async () => {
    let current = true;
    let finish!: (value: Uint8Array) => void;
    const signature = new Promise<Uint8Array>((resolve) => { finish = resolve; });
    const session = wallet(vi.fn(() => signature));
    const posted = vi.fn();
    mocks.request.mockImplementation(async (guarded: WalletSession) => {
      await guarded.signMessage!(new Uint8Array([1]));
      posted();
    });
    const attempt = signInWithWallet(session, () => current);
    current = false;
    finish(new Uint8Array(64));
    await expect(attempt).rejects.toThrow(/changed/);
    expect(posted).not.toHaveBeenCalled();
  });

  it("refuses an obsolete account read and does not retry a cancelled prompt", async () => {
    let current = true;
    mocks.request.mockImplementation(async () => { current = false; return {}; });
    await expect(signInWithWallet(wallet(), () => current)).rejects.toThrow(/changed/);
    mocks.request.mockReset().mockRejectedValue(new Error("Declined"));
    await expect(signInWithWallet(wallet(), () => true)).rejects.toThrow("Declined");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("requires a signing wallet and the current actor before starting", async () => {
    await expect(signInWithWallet({ account: {} } as WalletSession, () => true)).rejects.toThrow(/does not support/);
    await expect(signInWithWallet(wallet(), () => false)).rejects.toThrow(/changed/);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("keeps issuer verification context and rejects external redirects", () => {
    const issuer = "/issuer/verification?type=kyb&next=/apply";
    expect(safeLoginNext(issuer)).toBe(issuer);
    expect(safeLoginNext("/issuer/status")).toBe("/issuer/status");
    for (const value of [null, "https://evil.test", "//evil.test", "/issuer/../admin", "/admin"]) expect(safeLoginNext(value)).toBe("/account");
  });

  it("shows the sign-in action only after connecting, and never signs on render", () => {
    const before = renderToStaticMarkup(createElement(SignIn));
    expect(before).toContain("Connect wallet");
    expect(before).not.toContain("Sign in with wallet");
    mocks.wallet = wallet();
    const after = renderToStaticMarkup(createElement(SignIn));
    expect(after).toContain("Sign in with wallet");
    expect(after).toContain("No transaction or network fee");
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
