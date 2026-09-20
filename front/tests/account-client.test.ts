import { address } from "@solana/kit";
import type { WalletSession } from "@solana/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountResponse } from "@/lib/account";
import {
  AccountSessionChangedError,
  accountErrorMessage,
  openAccount,
  startAccountGoogle,
  updateAccount,
  type AccountRequestContext,
} from "@/lib/account-client";
import type { SiwsRequestBody } from "@/lib/siws-client";

const wallet = address("11111111111111111111111111111111");
const otherWallet = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const signature = new Uint8Array(64).fill(7);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => { resolve = resolveValue; });
  return { promise, resolve };
}

function profileResponse(): AccountResponse {
  return {
    profile: {
      wallet, network: "devnet", display_name: "A name",
      email: "contact@example.com", email_verified_at: "2026-09-20T10:00:00Z",
      pending_email: null, pending_email_expires_at: null,
      google_email: null, google_linked_at: null,
      created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-20T10:00:00Z",
    },
    features: { google: true, email: true },
  };
}

function session(signMessage: WalletSession["signMessage"] = async () => signature): WalletSession {
  return {
    account: { address: wallet, publicKey: new Uint8Array(32) },
    connector: { id: "test-wallet", name: "Test wallet" },
    disconnect: async () => {},
    signMessage,
  };
}

function context(walletSession = session()) {
  let current = true;
  const request: AccountRequestContext = {
    session: walletSession, network: "devnet", isCurrent: () => current,
  };
  return { request, invalidate: () => { current = false; } };
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubGlobal("window", { location: { origin: "https://manci.test" } });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(Response.json({ ok: true, data: profileResponse() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("private account signed requests", () => {
  it("sends the authorized account update and returns only the matching wallet profile", async () => {
    const sign = vi.fn(async () => signature);
    const { request } = context(session(sign));

    await expect(updateAccount(request, "A name")).resolves.toEqual(profileResponse());

    expect(sign).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/account/update");
    expect(init?.method).toBe("POST");
    expect(init?.cache).toBe("no-store");
    const body = JSON.parse(init!.body as string) as SiwsRequestBody;
    expect(body.payload).toMatchObject({ wallet, network: "devnet", action: "account.update", params: { display_name: "A name" } });
    expect(body.publicKey).toBe(wallet);
  });

  it("never prompts or POSTs when the wallet is already stale", async () => {
    const sign = vi.fn(async () => signature);
    const { request, invalidate } = context(session(sign));
    invalidate();

    await expect(openAccount(request)).rejects.toBeInstanceOf(AccountSessionChangedError);

    expect(sign).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prevents POST when the wallet changes while a signature prompt is open", async () => {
    const signing = deferred<Uint8Array>();
    const sign = vi.fn(() => signing.promise);
    const { request, invalidate } = context(session(sign));
    const pending = updateAccount(request, "Old wallet name");
    const rejection = expect(pending).rejects.toBeInstanceOf(AccountSessionChangedError);
    expect(sign).toHaveBeenCalledOnce();

    invalidate();
    signing.resolve(signature);

    await rejection;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prevents POST when the network changes during signing even if the session callback remains current", async () => {
    const signing = deferred<Uint8Array>();
    const { request } = context(session(() => signing.promise));
    const pending = updateAccount(request, "New name");
    const rejection = expect(pending).rejects.toBeInstanceOf(AccountSessionChangedError);

    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    signing.resolve(signature);

    await rejection;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discards an old wallet response that arrives after a wallet switch", async () => {
    const sent = deferred<void>();
    const response = deferred<Response>();
    fetchMock.mockImplementation(() => { sent.resolve(); return response.promise; });
    const { request, invalidate } = context();
    const pending = openAccount(request);
    const rejection = expect(pending).rejects.toBeInstanceOf(AccountSessionChangedError);
    await sent.promise;

    invalidate();
    response.resolve(Response.json({ ok: true, data: profileResponse() }));

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("checks the wallet again after response JSON finishes loading", async () => {
    const reading = deferred<void>();
    const body = deferred<{ ok: boolean; data: AccountResponse }>();
    const response = Response.json({});
    vi.spyOn(response, "json").mockImplementation(() => { reading.resolve(); return body.promise; });
    fetchMock.mockResolvedValue(response);
    const { request, invalidate } = context();
    const pending = openAccount(request);
    const rejection = expect(pending).rejects.toBeInstanceOf(AccountSessionChangedError);
    await reading.promise;

    invalidate();
    body.resolve({ ok: true, data: profileResponse() });

    await rejection;
  });

  it.each([
    { reason: "wallet", patch: { wallet: otherWallet } },
    { reason: "network", patch: { network: "mainnet" as const } },
  ])("rejects a successful API response with a mismatched $reason", async ({ patch }) => {
    const data = profileResponse();
    Object.assign(data.profile, patch);
    fetchMock.mockResolvedValue(Response.json({ ok: true, data }));

    await expect(openAccount(context().request)).rejects.toBeInstanceOf(AccountSessionChangedError);
  });

  it("does not release a Google redirect URL to a session that became stale", async () => {
    const sent = deferred<void>();
    const response = deferred<Response>();
    fetchMock.mockImplementation(() => { sent.resolve(); return response.promise; });
    const { request, invalidate } = context();
    const pending = startAccountGoogle(request);
    const rejection = expect(pending).rejects.toBeInstanceOf(AccountSessionChangedError);
    await sent.promise;

    invalidate();
    response.resolve(Response.json({ ok: true, data: { url: "https://accounts.google.com/o/oauth2/v2/auth" } }));

    await rejection;
  });

  it("preserves the original receiver for wallet methods that use this", async () => {
    const walletSession = session(async function (this: WalletSession) {
      expect(this.account.address).toBe(wallet);
      return signature;
    });

    await expect(openAccount(context(walletSession).request)).resolves.toEqual(profileResponse());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never submits an unsigned request for a wallet without message signing", async () => {
    const walletSession = { ...session(), signMessage: undefined };

    await expect(openAccount(context(walletSession).request)).rejects.toThrow("ACCOUNT_MESSAGE_SIGNING_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps arbitrary provider details out of the human error message", () => {
    const fallback = "Google connection could not be started. Please try again later.";
    expect(accountErrorMessage(new Error("OAuth error: sensitive provider payload"), fallback)).toBe(fallback);
  });
});
