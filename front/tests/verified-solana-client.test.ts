// lib/verified-solana-client (Talas 4.2 §2.4): the one place a wallet send
// gets its priority fee. A fake SolanaClient records what reaches the SDK;
// maintenance, the wallet policy and the genesis check are mocked, and the
// fee oracle is a mocked GET /api/priority-fee.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SolanaClient,
  TransactionPrepareAndSendRequest,
  TransactionPrepared,
  TransactionPrepareRequest,
  WalletSession,
} from "@solana/client";
import { address, type Address, type Instruction } from "@solana/kit";

const events = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/maintenance", async (original) => ({
  ...(await original<typeof import("@/lib/maintenance")>()),
  assertSiteWritable: vi.fn(async () => {
    events.push("maintenance");
  }),
}));
vi.mock("@/lib/transaction-wallet-policy", async (original) => ({
  ...(await original<typeof import("@/lib/transaction-wallet-policy")>()),
  requestTransactionWalletPolicy: vi.fn(async () => {
    events.push("authorize");
  }),
}));
vi.mock("@/lib/network-identity", async (original) => ({
  ...(await original<typeof import("@/lib/network-identity")>()),
  createNetworkVerifier: () => async () => {
    events.push("network");
  },
}));

import { withVerifiedTransactions } from "@/lib/verified-solana-client";
import { TransactionWalletChangedError } from "@/lib/transaction-wallet-policy";
import { resetPriorityFeeCache } from "@/lib/priority-fee";
import { setComputeUnitLimitInstruction, setComputeUnitPriceInstruction } from "@/lib/compute-budget";

const WALLET = address("7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2");
const PROGRAM = address("FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS");
const ix = (bytes = 8): Instruction => ({ programAddress: PROGRAM, data: new Uint8Array(bytes) });

const oracle = { network: "devnet", microLamports: "5000", beforeReply: null as (() => void) | null };
const fetchMock = vi.fn(async (url: unknown) => {
  expect(String(url)).toBe("/api/priority-fee");
  events.push("fee");
  oracle.beforeReply?.();
  return Response.json({ ok: true, network: oracle.network, microLamports: oracle.microLamports, source: "helius", level: "High" });
});

function session(wallet: Address = WALLET): WalletSession {
  return {
    account: { address: wallet, publicKey: new Uint8Array(32) },
    connector: { id: "test-wallet", name: "Test wallet" },
    disconnect: vi.fn(async () => {}),
    signMessage: vi.fn(async () => new Uint8Array(64)),
  };
}

function fixture(network: "devnet" | "mainnet" = "devnet") {
  let current: WalletSession = session();
  const prepare = vi.fn(async (input: TransactionPrepareRequest) => {
    events.push("sdk.prepare");
    return { feePayer: WALLET, instructions: input.instructions, message: { feePayer: { address: WALLET }, instructions: input.instructions } } as unknown as TransactionPrepared;
  });
  const prepareAndSend = vi.fn(async (input: TransactionPrepareRequest) => {
    void input;
    events.push("sdk.prepareAndSend");
    return "signature";
  });
  const transaction = { prepare, prepareAndSend, sign: vi.fn(), toWire: vi.fn(), send: vi.fn() };
  const client = {
    runtime: { rpc: {} },
    transaction,
    helpers: { transaction },
    store: { getState: () => ({ wallet: { status: "connected", session: current } }) },
  } as unknown as SolanaClient;
  return {
    guarded: withVerifiedTransactions(client, network),
    prepare,
    prepareAndSend,
    switchWallet: () => {
      current = session();
    },
  };
}

const request = (over: Partial<TransactionPrepareAndSendRequest> = {}) =>
  ({ feePayer: WALLET, instructions: [ix()], ...over }) as TransactionPrepareAndSendRequest;

beforeEach(() => {
  events.length = 0;
  resetPriorityFeeCache();
  oracle.network = "devnet";
  oracle.microLamports = "5000";
  oracle.beforeReply = null;
  fetchMock.mockClear();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubGlobal("window", { dispatchEvent: () => true });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the verified client sets the priority fee", () => {
  it("prepare passes the oracle's price to the SDK", async () => {
    const f = fixture();
    await f.guarded.transaction.prepare(request());
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.prepare.mock.calls[0][0].computeUnitPrice).toBe(BigInt(5_000));
    expect(events).toEqual(["maintenance", "network", "fee", "sdk.prepare"]);
  });

  it("prepareAndSend settles the fee before the wallet-policy prompt", async () => {
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(request());
    expect(f.prepareAndSend.mock.calls[0][0].computeUnitPrice).toBe(BigInt(5_000));
    expect(events.indexOf("fee")).toBeGreaterThan(-1);
    expect(events.indexOf("fee")).toBeLessThan(events.indexOf("authorize"));
    expect(events.at(-1)).toBe("sdk.prepareAndSend");
  });

  it("the helpers.transaction alias is the same guarded helper", async () => {
    const f = fixture();
    await f.guarded.helpers.transaction.prepareAndSend(request());
    expect(f.prepareAndSend.mock.calls[0][0].computeUnitPrice).toBe(BigInt(5_000));
  });

  it("the mainnet cap applies even when the server answers more", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    oracle.network = "mainnet";
    oracle.microLamports = "50000000";
    const f = fixture("mainnet");
    await f.guarded.transaction.prepareAndSend(request());
    expect(f.prepareAndSend.mock.calls[0][0].computeUnitPrice).toBe(BigInt(2_000_000));
  });

  it("the devnet cap and floor apply too", async () => {
    oracle.microLamports = "99999999";
    const f = fixture();
    await f.guarded.transaction.prepare(request());
    expect(f.prepare.mock.calls[0][0].computeUnitPrice).toBe(BigInt(100_000));
  });

  it("a wallet change while the fee is fetched stops the send", async () => {
    const f = fixture();
    oracle.beforeReply = f.switchWallet;
    await expect(f.guarded.transaction.prepareAndSend(request())).rejects.toBeInstanceOf(TransactionWalletChangedError);
    expect(f.prepareAndSend).not.toHaveBeenCalled();
    expect(events).not.toContain("authorize");
    resetPriorityFeeCache();
    const g = fixture();
    oracle.beforeReply = g.switchWallet;
    await expect(g.guarded.transaction.prepare(request())).rejects.toBeInstanceOf(TransactionWalletChangedError);
    expect(g.prepare).not.toHaveBeenCalled();
  });

  it("refuses a caller-set price or SetComputeUnitPrice before any prompt", async () => {
    const f = fixture();
    await expect(f.guarded.transaction.prepareAndSend(request({ computeUnitPrice: BigInt(0) }))).rejects.toThrow(/set by the app/);
    await expect(
      f.guarded.transaction.prepare(request({ instructions: [setComputeUnitPriceInstruction(BigInt(7)), ix()] })),
    ).rejects.toThrow(/set by the app/);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.prepareAndSend).not.toHaveBeenCalled();
    expect(events).not.toContain("authorize");
  });

  it("a transaction that would no longer fit is sent without a price, as before", async () => {
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(request({ instructions: [ix(1_200)] }));
    expect(f.prepareAndSend.mock.calls[0][0].computeUnitPrice).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unavailable oracle never blocks the send: the floor is used", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(request());
    expect(f.prepareAndSend.mock.calls[0][0].computeUnitPrice).toBe(BigInt(1_000));
    warn.mockRestore();
  });
});

// 24.9. regression: the SDK appended its estimated SetComputeUnitLimit at the
// END; the wallet must see the compute budget first (tests/wallet-send-order
// checks the real SDK's output).
describe("prepareAndSend puts the compute unit limit first", () => {
  it("asks for a placeholder limit that the SDK re-estimates in place", async () => {
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(request());
    const sent = f.prepareAndSend.mock.calls[0][0] as TransactionPrepareAndSendRequest;
    expect(sent.computeUnitLimit).toBe(1_400_000);
    expect(sent.prepareTransaction).toEqual({ computeUnitLimitReset: true });
  });

  it("keeps the caller's own prepareTransaction options", async () => {
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(request({ prepareTransaction: { blockhashReset: false } }));
    expect((f.prepareAndSend.mock.calls[0][0] as TransactionPrepareAndSendRequest).prepareTransaction).toEqual({
      blockhashReset: false,
      computeUnitLimitReset: true,
    });
  });

  it("leaves a caller-set limit, a limit instruction and prepareTransaction: false alone", async () => {
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(request({ computeUnitLimit: 900_000, prepareTransaction: false }));
    await f.guarded.transaction.prepareAndSend(request({ instructions: [setComputeUnitLimitInstruction(300_000), ix()] }));
    await f.guarded.transaction.prepareAndSend(request({ prepareTransaction: false }));
    const [a, b, c] = f.prepareAndSend.mock.calls.map((call) => call[0] as TransactionPrepareAndSendRequest);
    expect([a.computeUnitLimit, a.prepareTransaction]).toEqual([900_000, false]);
    expect([b.computeUnitLimit, b.prepareTransaction]).toEqual([undefined, undefined]);
    expect([c.computeUnitLimit, c.prepareTransaction]).toEqual([undefined, false]);
    expect(a.computeUnitPrice).toBe(BigInt(5_000));
  });

  it("puts the limit first without a price too (same bytes), but not on prepare, which does not estimate", async () => {
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(request({ instructions: [ix(1_200)] }));
    await f.guarded.transaction.prepare(request());
    const tooLarge = f.prepareAndSend.mock.calls[0][0] as TransactionPrepareAndSendRequest;
    expect([tooLarge.computeUnitPrice, tooLarge.computeUnitLimit]).toEqual([undefined, 1_400_000]);
    expect(f.prepare.mock.calls[0][0].computeUnitLimit).toBeUndefined();
  });
});
