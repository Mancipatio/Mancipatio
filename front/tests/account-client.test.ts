import { address } from "@solana/kit";
import type { WalletSession } from "@solana/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountResponse, AccountWalletLinkAttempt } from "@/lib/account";
import {
  AccountSessionChangedError,
  accountErrorMessage,
  cancelAccountEmail,
  cancelAccountWalletLink,
  completeAccountWalletLink,
  openAccount,
  removeAccountWallet,
  requestAccountEmail,
  setAccountPrimaryWallet,
  startAccountGoogle,
  startAccountWalletLink,
  unlinkAccountGoogle,
  updateAccount,
  verifyAccountEmail,
  type AccountRequestContext,
} from "@/lib/account-client";
import type { SiwsRequestBody } from "@/lib/siws-client";
import { transactionWalletPolicyRevision } from "@/lib/transaction-wallet-policy";

// These tests cover the signed-envelope contract; wallet sessions have their own tests.
vi.mock("@/lib/siws-session", async (original) => ({ ...(await original<typeof import("@/lib/siws-session")>()), isSessionReadAction: () => false }));
// These fake wallets return placeholder signatures for a placeholder key, so
// stub only the signing strategy (the client now refuses to send a signature
// it can prove invalid); formats and local checks: tests/siws-signing.test.ts.
vi.mock("@/lib/siws-signing", async (original) => ({
  ...(await original<typeof import("@/lib/siws-signing")>()),
  signSiwsMessage: async (walletSession: WalletSession, sign: NonNullable<WalletSession["signMessage"]>, message: string) =>
    ({ signature: await sign.call(walletSession, new TextEncoder().encode(message)), sigFormat: "raw" as const }),
}));

const wallet = address("11111111111111111111111111111111");
const otherWallet = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const signature = new Uint8Array(64).fill(7);
const accountId = "d4f88128-1b5f-4a03-baa2-6177840d31ab";
const anotherAccountId = "fef88128-1b5f-4a03-baa2-6177840d31ab";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => { resolve = resolveValue; });
  return { promise, resolve };
}

function profileResponse(): AccountResponse {
  return {
    profile: {
      id: accountId, primary_wallet: wallet,
      wallets: [{ wallet, linked_at: "2026-09-20T10:00:00Z" }],
      wallet, network: "devnet", display_name: "A name",
      email: "contact@example.com", email_verified_at: "2026-09-20T10:00:00Z",
      pending_email: null, pending_email_expires_at: null,
      google_email: null, google_linked_at: null,
      created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-20T10:00:00Z",
    },
    features: { google: true, email: true },
  };
}

function linkAttempt(): AccountWalletLinkAttempt {
  return {
    token: "t".repeat(43), account_id: accountId, requested_by: wallet,
    target_wallet: otherWallet, expires_at: new Date(Date.now() + 9 * 60_000).toISOString(),
  };
}

function linkedProfileResponse(): AccountResponse {
  const response = profileResponse();
  response.profile.wallet = otherWallet;
  response.profile.wallets.push({ wallet: otherWallet, linked_at: "2026-09-20T11:00:00Z" });
  return response;
}

function targetContext() {
  const original = session();
  return context({ ...original, account: { ...original.account, address: address(otherWallet) } });
}

function session(signMessage: WalletSession["signMessage"] = async () => signature): WalletSession {
  return {
    account: { address: wallet, publicKey: new Uint8Array(32) },
    connector: { id: "test-wallet", name: "Test wallet" },
    disconnect: async () => {},
    signMessage,
  };
}

function context(walletSession = session(), expectedAccountId?: string) {
  let current = true;
  const request: AccountRequestContext = {
    session: walletSession, network: "devnet", isCurrent: () => current, accountId: expectedAccountId,
  };
  return { request, invalidate: () => { current = false; } };
}

const fetchMock = vi.fn<typeof fetch>();

const accountMutations: {
  action: string;
  invoke: (request: AccountRequestContext) => Promise<unknown>;
  result: () => unknown;
}[] = [
  { action: "account.update", invoke: (request) => updateAccount(request, "A name"), result: profileResponse },
  { action: "account.email.request", invoke: (request) => requestAccountEmail(request, "new@example.com"), result: profileResponse },
  { action: "account.email.cancel", invoke: cancelAccountEmail, result: profileResponse },
  { action: "account.google.start", invoke: startAccountGoogle, result: () => ({ url: "https://accounts.google.com/o/oauth2/v2/auth" }) },
  { action: "account.google.unlink", invoke: unlinkAccountGoogle, result: profileResponse },
  { action: "account.wallets.start", invoke: (request) => startAccountWalletLink(request, otherWallet), result: linkAttempt },
  { action: "account.wallets.primary", invoke: (request) => setAccountPrimaryWallet(request, wallet), result: profileResponse },
  { action: "account.wallets.remove", invoke: (request) => removeAccountWallet(request, otherWallet), result: profileResponse },
];

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubGlobal("window", { location: { origin: "https://manci.test" } });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async () => Response.json({ ok: true, data: profileResponse() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("private account signed requests", () => {
  it.each(accountMutations)("binds the loaded account ID inside the $action signature", async ({ action, invoke, result }) => {
    const sign = vi.fn<NonNullable<WalletSession["signMessage"]>>().mockResolvedValue(signature);
    fetchMock.mockResolvedValue(Response.json({ ok: true, data: result() }));

    await invoke(context(session(sign), accountId).request);

    expect(sign).toHaveBeenCalledOnce();
    const signedMessage = new TextDecoder().decode(sign.mock.calls[0][0]);
    expect(signedMessage).toContain(`"account_id":"${accountId}"`);
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string) as SiwsRequestBody;
    expect(body.payload.action).toBe(action);
    expect(body.payload.params.account_id).toBe(accountId);
  });

  it.each(accountMutations)("blocks $action before prompting if the loaded account ID is missing or invalid", async ({ invoke }) => {
    const sign = vi.fn(async () => signature);
    for (const expectedAccountId of [undefined, "not-an-account-uuid"]) {
      await expect(invoke(context(session(sign), expectedAccountId).request)).rejects.toThrow("ACCOUNT_ID_REQUIRED");
    }
    expect(sign).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still opens accounts and verifies email proofs without a previously loaded account ID", async () => {
    const request = context().request;
    await expect(openAccount(request)).resolves.toMatchObject({ profile: { id: accountId } });
    await expect(verifyAccountEmail(request, "t".repeat(43))).resolves.toMatchObject({ profile: { id: accountId } });
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(init!.body as string) as SiwsRequestBody);
    expect(requests[0].payload.params).toEqual({});
    expect(requests[1].payload.params).toEqual({ token: "t".repeat(43) });
  });

  it("sends the authorized account update and returns only the matching wallet profile", async () => {
    const sign = vi.fn(async () => signature);
    const { request } = context(session(sign), accountId);

    await expect(updateAccount(request, "A name")).resolves.toEqual(profileResponse());

    expect(sign).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/account/update");
    expect(init?.method).toBe("POST");
    expect(init?.cache).toBe("no-store");
    const body = JSON.parse(init!.body as string) as SiwsRequestBody;
    expect(body.payload).toMatchObject({ wallet, network: "devnet", action: "account.update", params: { display_name: "A name", account_id: accountId } });
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
    const { request, invalidate } = context(session(sign), accountId);
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
    const { request } = context(session(() => signing.promise), accountId);
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
    const { request, invalidate } = context(session(), accountId);
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

  it("lets a second linked wallet open the same account without being the primary wallet", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true, data: linkedProfileResponse() }));
    await expect(openAccount(targetContext().request)).resolves.toMatchObject({ profile: {
      id: accountId, wallet: otherWallet, primary_wallet: wallet,
    } });
  });

  it.each([
    { reason: "actor missing from membership", mutate: (data: AccountResponse) => { data.profile.wallets = [{ wallet: otherWallet, linked_at: "2026-09-20T10:00:00Z" }]; } },
    { reason: "primary missing from membership", mutate: (data: AccountResponse) => { data.profile.primary_wallet = otherWallet; } },
    { reason: "invalid account ID", mutate: (data: AccountResponse) => { data.profile.id = "a-wallet-is-not-an-account-id"; } },
    { reason: "duplicated members", mutate: (data: AccountResponse) => { data.profile.wallets.push(data.profile.wallets[0]); } },
  ])("rejects shared profile with $reason", async ({ mutate }) => {
    const data = profileResponse();
    mutate(data);
    fetchMock.mockResolvedValue(Response.json({ ok: true, data }));
    await expect(openAccount(context().request)).rejects.toBeInstanceOf(AccountSessionChangedError);
  });

  it("does not apply an unrelated account response after a loaded account was removed or recreated", async () => {
    const data = profileResponse();
    data.profile.id = anotherAccountId;
    fetchMock.mockResolvedValue(Response.json({ ok: true, data }));
    await expect(updateAccount({ ...context().request, accountId }, "Edited name")).rejects.toBeInstanceOf(AccountSessionChangedError);
  });

  it.each(["target_wallet", "requested_by", "account_id"] as const)("rejects a link attempt if the server changes its frozen %s", async (field) => {
    const attempt = linkAttempt();
    attempt[field] = field === "account_id" ? anotherAccountId : field === "requested_by" ? otherWallet : wallet;
    fetchMock.mockResolvedValue(Response.json({ ok: true, data: attempt }));
    await expect(startAccountWalletLink({ ...context().request, accountId }, otherWallet)).rejects.toBeInstanceOf(AccountSessionChangedError);
  });

  it("only allows the exact target to sign completion, with both parties and the account pinned", async () => {
    const attempt = linkAttempt();
    await expect(completeAccountWalletLink(context().request, attempt)).rejects.toThrow("ACCOUNT_LINK_TARGET_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(Response.json({ ok: true, data: linkedProfileResponse() }));
    const before = transactionWalletPolicyRevision();
    await expect(completeAccountWalletLink(targetContext().request, attempt)).resolves.toMatchObject({ profile: { id: accountId, wallet: otherWallet } });
    const [path, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init!.body as string) as SiwsRequestBody;
    expect(path).toBe("/api/account/wallets/complete");
    expect(body.payload).toMatchObject({ wallet: otherWallet, action: "account.wallets.complete", params: {
      token: attempt.token, account_id: accountId, requested_by: wallet, target_wallet: otherWallet,
    } });
    expect(transactionWalletPolicyRevision()).toBe(before + 1);
  });

  it("rejects completion returning a different account even when the target is a valid member", async () => {
    const response = linkedProfileResponse();
    response.profile.id = anotherAccountId;
    fetchMock.mockResolvedValue(Response.json({ ok: true, data: response }));
    await expect(completeAccountWalletLink(targetContext().request, linkAttempt())).rejects.toBeInstanceOf(AccountSessionChangedError);
  });

  it("rejects an expired attempt before prompting the new wallet", async () => {
    const attempt = linkAttempt();
    attempt.expires_at = new Date(Date.now() - 1).toISOString();
    await expect(completeAccountWalletLink(targetContext().request, attempt)).rejects.toThrow("ACCOUNT_LINK_TARGET_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a confirmed signed cancellation and pins the entire attempt", async () => {
    const attempt = linkAttempt();
    fetchMock.mockResolvedValue(Response.json({ ok: true, data: { cancelled: true } }));
    await expect(cancelAccountWalletLink(context().request, attempt)).resolves.toEqual({ cancelled: true });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/account/wallets/cancel");
    expect((JSON.parse(init!.body as string) as SiwsRequestBody).payload.params).toEqual({
      token: attempt.token, account_id: accountId, requested_by: wallet, target_wallet: otherWallet,
    });
    fetchMock.mockResolvedValue(Response.json({ ok: true, data: { cancelled: false } }));
    await expect(cancelAccountWalletLink(context().request, attempt)).rejects.toThrow("cancellation was not confirmed");
  });

  it("invalidates pending transaction intent after confirmed primary and membership changes", async () => {
    const before = transactionWalletPolicyRevision();
    await setAccountPrimaryWallet(context(session(), accountId).request, wallet);
    await removeAccountWallet(context(session(), accountId).request, otherWallet);
    expect(transactionWalletPolicyRevision()).toBe(before + 2);
  });
});
