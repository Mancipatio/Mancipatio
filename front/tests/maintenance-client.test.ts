import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SolanaClient, TransactionPrepared, TransactionPrepareRequest, WalletSession } from "@solana/client";
import type { Address, TransactionSigner } from "@solana/kit";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import { assertSiteWritable, fetchMaintenance, MAINTENANCE_EVENT, MaintenanceModeError } from "@/lib/maintenance";
import { withVerifiedTransactions } from "@/lib/verified-solana-client";
import { requestTransactionWalletPolicy } from "@/lib/transaction-wallet-policy";
import { explainSendError } from "@/lib/tx-error";
import { accountErrorMessage } from "@/lib/account-client";

const remote = vi.hoisted(() => ({ signedFetch: vi.fn() }));
vi.mock("@/lib/siws-client", () => ({ signedFetch: remote.signedFetch }));

const WALLET = "11111111111111111111111111111111" as Address;
const ORIGIN = "https://manci.test";
let flag: { enabled: boolean; message: string | null } | "down" = { enabled: false, message: null };
const serverFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
  expect(input).toBe("/api/maintenance");
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

beforeEach(() => {
  flag = { enabled: false, message: null };
  serverFetch.mockClear();
  dispatchEvent.mockClear();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubGlobal("window", { location: { origin: ORIGIN }, dispatchEvent });
  vi.stubGlobal("fetch", serverFetch);
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
