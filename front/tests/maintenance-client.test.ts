import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SolanaClient, TransactionPrepared, TransactionPrepareRequest, WalletSession } from "@solana/client";
import type { Address, TransactionSigner } from "@solana/kit";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import {
  assertNotInKnownMaintenance, assertSiteWritable, fetchMaintenance, MAINTENANCE_EVENT, MaintenanceModeError, MaintenanceUnknownError,
} from "@/lib/maintenance";
import { withVerifiedTransactions } from "@/lib/verified-solana-client";
import { requestTransactionWalletPolicy } from "@/lib/transaction-wallet-policy";
import { explainSendError } from "@/lib/tx-error";
import { accountErrorMessage } from "@/lib/account-client";

const remote = vi.hoisted(() => ({ signedFetch: vi.fn() }));
vi.mock("@/lib/siws-client", () => ({ signedFetch: remote.signedFetch }));
// The priority fee (its own oracle request) is covered by
// tests/verified-solana-client.test.ts; here only /api/maintenance is served.
vi.mock("@/lib/priority-fee", async (original) => ({
  ...(await original<typeof import("@/lib/priority-fee")>()),
  priceForRequest: async () => undefined,
}));
// These fake wallets return placeholder signatures for a placeholder key, so
// stub only the signing strategy (the client now refuses to send a signature
// it can prove invalid); formats and local checks: tests/siws-signing.test.ts.
vi.mock("@/lib/siws-signing", async (original) => ({
  ...(await original<typeof import("@/lib/siws-signing")>()),
  signSiwsMessage: async (walletSession: WalletSession, sign: NonNullable<WalletSession["signMessage"]>, message: string) =>
    ({ signature: await sign.call(walletSession, new TextEncoder().encode(message)), sigFormat: "raw" as const }),
}));

const WALLET = "11111111111111111111111111111111" as Address;
const ORIGIN = "https://manci.test";
let flag: { enabled: boolean; message: string | null } | "down" = { enabled: false, message: null };
const serverFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
  expect(String(input)).toMatch(/^\/api\/maintenance(\?fresh=\d+)?$/);
  expect(init?.cache).toBe("no-store");
  if (flag === "down") throw new TypeError("Failed to fetch");
  return Response.json({ ...flag, network: "devnet" });
});
const dispatchEvent = vi.fn();

function session(): WalletSession {
  return {
    account: { address: WALLET, publicKey: new Uint8Array(32) },
    connector: { id: "test-wallet", name: "Test wallet" },
    disconnect: vi.fn(async () => {}),
    signMessage: vi.fn(async () => new Uint8Array(64)),
  };
}

function fixture() {
  const current = session();
  const signer = { address: WALLET, signTransactions: vi.fn(async () => [{}]) } as unknown as TransactionSigner;
  const request = { feePayer: signer, instructions: [] } as unknown as TransactionPrepareRequest;
  const transaction = {
    prepare: vi.fn(async () => ({ feePayer: WALLET, instructions: [], message: { feePayer: { address: WALLET }, instructions: [] } } as unknown as TransactionPrepared)),
    sign: vi.fn(), toWire: vi.fn(),
    send: vi.fn(async () => "signature"),
    prepareAndSend: vi.fn(async () => "signature"),
  };
  const client = {
    runtime: { rpc: { getGenesisHash: () => ({ send: async () => CLUSTER_GENESIS_HASHES.devnet }) } },
    transaction, helpers: { transaction },
    store: { getState: () => ({ wallet: { status: "connected", session: current } }) },
  } as unknown as SolanaClient;
  return { guarded: withVerifiedTransactions(client, "devnet"), request, transaction, session: current };
}

beforeEach(async () => {
  flag = { enabled: false, message: null };
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubGlobal("window", { location: { origin: ORIGIN }, dispatchEvent });
  vi.stubGlobal("fetch", serverFetch);
  // Every test starts from a page that last saw maintenance off.
  await fetchMaintenance();
  serverFetch.mockClear();
  dispatchEvent.mockClear();
  remote.signedFetch.mockReset().mockResolvedValue({ wallet: WALLET, network: "devnet", account_id: "10000000-0000-4000-8000-000000000001", primary_wallet: WALLET });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("browser maintenance check", () => {
  it("reads the flag uncached and announces it to the banner", async () => {
    flag = { enabled: true, message: "Program upgrade" };
    await expect(fetchMaintenance()).resolves.toEqual({ enabled: true, message: "Program upgrade", network: "devnet" });
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(MAINTENANCE_EVENT);
    expect(event.detail).toMatchObject({ enabled: true, message: "Program upgrade" });
  });

  it("refuses while enabled with a user-facing message", async () => {
    flag = { enabled: true, message: "Program upgrade" };
    const error = await assertSiteWritable().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MaintenanceModeError);
    expect((error as Error).message).toBe("Manci is in maintenance: Program upgrade");
  });

  it.each([
    ["off", () => { flag = { enabled: false, message: "stale" }; }],
    ["unreachable", () => { flag = "down"; }],
    ["an error page", () => { serverFetch.mockResolvedValueOnce(new Response("<html>", { status: 502 })); }],
  ])("lets transactions continue when the flag is %s (the server still enforces)", async (_label, setup) => {
    setup();
    await expect(assertSiteWritable()).resolves.toBeUndefined();
  });

  it("keeps a known maintenance through a failed read", async () => {
    flag = { enabled: true, message: "Program upgrade" };
    await fetchMaintenance();
    flag = "down";
    await expect(assertSiteWritable()).rejects.toBeInstanceOf(MaintenanceModeError);
    serverFetch.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(assertSiteWritable()).rejects.toThrow("Manci is in maintenance: Program upgrade");
    flag = { enabled: false, message: null };
    await expect(assertSiteWritable()).resolves.toBeUndefined();
  });

  it("fails closed when asked to, reading past the CDN", async () => {
    await expect(assertSiteWritable({ failClosed: true })).resolves.toBeUndefined();
    expect(String(serverFetch.mock.calls[0][0])).toMatch(/^\/api\/maintenance\?fresh=\d+$/);
    flag = "down";
    await expect(assertSiteWritable({ failClosed: true })).rejects.toBeInstanceOf(MaintenanceUnknownError);
    serverFetch.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(assertSiteWritable({ failClosed: true })).rejects.toBeInstanceOf(MaintenanceUnknownError);
    flag = { enabled: true, message: "Program upgrade" };
    await expect(assertSiteWritable({ failClosed: true })).rejects.toBeInstanceOf(MaintenanceModeError);
  });

  it("still reads the flag in browsers without AbortSignal.timeout", async () => {
    const timeout = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true });
    try {
      flag = { enabled: true, message: "Program upgrade" };
      await expect(fetchMaintenance()).resolves.toMatchObject({ enabled: true });
      expect(serverFetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      Object.defineProperty(AbortSignal, "timeout", { value: timeout, configurable: true });
    }
  });

  it("never fetches outside the browser", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", serverFetch);
    await expect(assertSiteWritable()).resolves.toBeUndefined();
    expect(serverFetch).not.toHaveBeenCalled();
  });
});

describe("verified transaction client in maintenance", () => {
  it("refuses prepareAndSend before any policy signature or wallet prompt", async () => {
    flag = { enabled: true, message: "Program upgrade" };
    const f = fixture();
    await expect(f.guarded.transaction.prepareAndSend(f.request)).rejects.toThrow("Manci is in maintenance: Program upgrade");
    expect(remote.signedFetch).not.toHaveBeenCalled();
    expect(f.session.signMessage).not.toHaveBeenCalled();
    expect(f.transaction.prepareAndSend).not.toHaveBeenCalled();
  });

  it("refuses preparation, and a transaction prepared before maintenance began", async () => {
    const f = fixture();
    const prepared = await f.guarded.transaction.prepare(f.request);
    flag = { enabled: true, message: null };
    await expect(f.guarded.transaction.send(prepared)).rejects.toBeInstanceOf(MaintenanceModeError);
    await expect(f.guarded.transaction.prepare(f.request)).rejects.toThrow(/upgrade in progress/);
    expect(f.transaction.prepare).toHaveBeenCalledOnce();
    expect(f.transaction.send).not.toHaveBeenCalled();
    expect(remote.signedFetch).not.toHaveBeenCalled();
  });

  it("sends normally when maintenance is off, checking the flag fresh each time", async () => {
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(f.request);
    await f.guarded.transaction.prepareAndSend(f.request);
    expect(f.transaction.prepareAndSend).toHaveBeenCalledTimes(2);
    expect(serverFetch).toHaveBeenCalledTimes(2);
  });

  it("passes a server-side maintenance refusal of the policy check through unchanged", async () => {
    remote.signedFetch.mockRejectedValue(new MaintenanceModeError("Program upgrade"));
    await expect(requestTransactionWalletPolicy(session(), "devnet", () => {}))
      .rejects.toThrow("Manci is in maintenance: Program upgrade");
  });
});

describe("maintenance refusals from signed and account requests", () => {
  const refused = { ok: false, error: "Manci is in maintenance: Program upgrade", code: "maintenance", message: "Program upgrade" };

  it("signedFetch throws MaintenanceModeError and shows the banner", async () => {
    const { signedFetch } = await vi.importActual<typeof import("@/lib/siws-client")>("@/lib/siws-client");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(refused, { status: 503 })));
    const error = await signedFetch(session(), "/api/clients/create", "clients.create", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MaintenanceModeError);
    expect((error as Error).message).toBe(refused.error);
    expect((dispatchEvent.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ enabled: true, message: "Program upgrade" });
  });

  it("does not prompt the wallet for a refused write once the page knows maintenance is on", async () => {
    const { signedFetch, createSignedRequest } = await vi.importActual<typeof import("@/lib/siws-client")>("@/lib/siws-client");
    flag = { enabled: true, message: "Program upgrade" };
    await fetchMaintenance();
    const refusedFetch = vi.fn(async () => Response.json(refused, { status: 503 }));
    vi.stubGlobal("fetch", refusedFetch);
    const s = session();
    await expect(signedFetch(s, "/api/clients/create", "clients.create", {})).rejects.toBeInstanceOf(MaintenanceModeError);
    await expect(createSignedRequest(s, "clients.upload", {})).rejects.toThrow("Manci is in maintenance: Program upgrade");
    expect(s.signMessage).not.toHaveBeenCalled();
    expect(refusedFetch).not.toHaveBeenCalled();
    expect(() => assertNotInKnownMaintenance()).toThrow(MaintenanceModeError);
    // Signing in and receipts of landed transactions still reach the wallet.
    await createSignedRequest(s, "auth.session", {});
    await createSignedRequest(s, "launchpad.recordPurchase", {});
    expect(s.signMessage).toHaveBeenCalledTimes(2);
  });

  it("prompts normally when the page last saw maintenance off (no extra request)", async () => {
    const { createSignedRequest } = await vi.importActual<typeof import("@/lib/siws-client")>("@/lib/siws-client");
    const s = session();
    await createSignedRequest(s, "clients.create", {});
    expect(s.signMessage).toHaveBeenCalledOnce();
    expect(serverFetch).not.toHaveBeenCalled();
  });

  it("account-session requests throw the same error and keep its wording", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(refused, { status: 503 })));
    const { accountFetch } = await import("@/lib/account-login");
    const error = await accountFetch("/api/account/update", "account.update", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MaintenanceModeError);
    expect(accountErrorMessage(error, "Your account is temporarily unavailable.")).toBe(refused.error);
  });

  it("explainSendError shows the maintenance sentence, even when wrapped", () => {
    const error = new MaintenanceModeError("Program upgrade");
    expect(explainSendError(error)).toBe("Manci is in maintenance: Program upgrade");
    expect(explainSendError(new Error("Transaction failed (expired)", { cause: error }))).toBe("Manci is in maintenance: Program upgrade");
  });
});
