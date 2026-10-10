// lib/verified-solana-client (Talas 4.2 §2.4): the one place a wallet send
// gets its priority fee, and the simulation gate in front of the wallet. A
// fake SolanaClient records what reaches the SDK; maintenance, the wallet
// policy, the genesis check and the gate's one simulateTransaction are
// mocked, and the fee oracle is a mocked GET /api/priority-fee.
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
const sim = vi.hoisted(() => ({
  verdict: { err: null as unknown, logs: [] as string[], unitsConsumed: 300_000 as number | null },
  throws: null as Error | null,
  messages: [] as unknown[],
}));
vi.mock("@/lib/simulation-gate", async (original) => ({
  ...(await original<typeof import("@/lib/simulation-gate")>()),
  simulateMessage: vi.fn(async (_rpc: unknown, message: unknown) => {
    events.push("simulate");
    sim.messages.push(message);
    if (sim.throws) throw sim.throws;
    return sim.verdict;
  }),
}));

import { withVerifiedTransactions } from "@/lib/verified-solana-client";
import { TransactionWalletChangedError } from "@/lib/transaction-wallet-policy";
import { resetPriorityFeeCache } from "@/lib/priority-fee";
import { setComputeUnitLimitInstruction, setComputeUnitPriceInstruction } from "@/lib/compute-budget";
import { PROBE_LIFETIME, SimulationRefusedError, SimulationUnavailableError } from "@/lib/simulation-gate";
import { explainSendError, SALE_AUTHORITY_HINT, SALE_SYNC_SUFFIX } from "@/lib/tx-error";
import { PILOT_MODULE_ENV } from "@/lib/features";
import { ModuleDisabledFlowError, withGateFacts } from "@/lib/pause-gate";
import { getOpenCustodyVaultInstructionDataEncoder, RealizeAction, VaultType } from "@/lib/generated/asset_registry";

const WALLET = address("7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2");
const PROGRAM = address("FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS");
const HOOK = address("GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
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

function fixture(network: "devnet" | "mainnet" = "devnet", rpc: Record<string, unknown> = {}) {
  let current: WalletSession = session();
  const prepare = vi.fn(async (input: TransactionPrepareRequest) => {
    events.push("sdk.prepare");
    // As the SDK compiles it: [limit?, price?, ...app].
    const prefix = [
      ...(input.computeUnitLimit !== undefined ? [setComputeUnitLimitInstruction(Number(input.computeUnitLimit))] : []),
      ...(input.computeUnitPrice !== undefined ? [setComputeUnitPriceInstruction(BigInt(input.computeUnitPrice))] : []),
    ];
    const message = { feePayer: { address: WALLET }, instructions: [...prefix, ...input.instructions] };
    return { feePayer: WALLET, instructions: input.instructions, message } as unknown as TransactionPrepared;
  });
  const prepareAndSend = vi.fn(async (input: TransactionPrepareRequest) => {
    void input;
    events.push("sdk.prepareAndSend");
    return "signature";
  });
  const transaction = { prepare, prepareAndSend, sign: vi.fn(), toWire: vi.fn(), send: vi.fn() };
  const client = {
    runtime: { rpc },
    transaction,
    helpers: { transaction },
    store: { getState: () => ({ wallet: { status: "connected", session: current } }) },
  } as unknown as SolanaClient;
  return {
    guarded: withVerifiedTransactions(client, network),
    prepare,
    prepareAndSend,
    sign: transaction.sign,
    toWire: transaction.toWire,
    send: transaction.send,
    switchWallet: () => {
      current = session();
    },
  };
}

const request = (over: Partial<TransactionPrepareAndSendRequest> = {}) =>
  ({ feePayer: WALLET, instructions: [ix()], ...over }) as TransactionPrepareAndSendRequest;

beforeEach(() => {
  events.length = 0;
  sim.verdict = { err: null, logs: [], unitsConsumed: 300_000 };
  sim.throws = null;
  sim.messages.length = 0;
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
// checks the real SDK's output). Since the simulation gate, the estimate comes
// from the gate's own simulation of the placeholder and the SDK is told not
// to estimate again.
describe("prepareAndSend puts the compute unit limit first", () => {
  it("simulates the 1.4M placeholder once and sends the estimate in its place, without a second SDK estimate", async () => {
    const f = fixture();
    sim.verdict = { err: null, logs: [], unitsConsumed: 300_000 };
    await f.guarded.transaction.prepareAndSend(request());
    const probe = f.prepare.mock.calls[0][0];
    expect(probe.computeUnitLimit).toBe(1_400_000);
    const sent = f.prepareAndSend.mock.calls[0][0] as TransactionPrepareAndSendRequest;
    // ceil(300_000 × 1.1), the SDK's own formula
    expect(sent.computeUnitLimit).toBe(330_000);
    expect(sent.prepareTransaction).toEqual({ computeUnitLimitReset: false });
  });

  it("a small transaction gets the SDK's 200k floor", async () => {
    const f = fixture();
    sim.verdict = { err: null, logs: [], unitsConsumed: 10_000 };
    await f.guarded.transaction.prepareAndSend(request());
    expect((f.prepareAndSend.mock.calls[0][0] as TransactionPrepareAndSendRequest).computeUnitLimit).toBe(200_000);
  });

  it("keeps the caller's own prepareTransaction options", async () => {
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(request({ prepareTransaction: { blockhashReset: false } }));
    expect((f.prepareAndSend.mock.calls[0][0] as TransactionPrepareAndSendRequest).prepareTransaction).toEqual({
      blockhashReset: false,
      computeUnitLimitReset: false,
    });
  });

  it("leaves a caller-set limit, a limit instruction and prepareTransaction: false alone, but simulates each once", async () => {
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(request({ computeUnitLimit: 900_000, prepareTransaction: false }));
    await f.guarded.transaction.prepareAndSend(request({ instructions: [setComputeUnitLimitInstruction(300_000), ix()] }));
    await f.guarded.transaction.prepareAndSend(request({ prepareTransaction: false }));
    const [a, b, c] = f.prepareAndSend.mock.calls.map((call) => call[0] as TransactionPrepareAndSendRequest);
    expect([a.computeUnitLimit, a.prepareTransaction]).toEqual([900_000, false]);
    expect([b.computeUnitLimit, b.prepareTransaction]).toEqual([undefined, undefined]);
    expect([c.computeUnitLimit, c.prepareTransaction]).toEqual([undefined, false]);
    expect(a.computeUnitPrice).toBe(BigInt(5_000));
    expect(events.filter((e) => e === "simulate")).toHaveLength(3);
    // The probe carries the caller's limit, not the placeholder.
    expect(f.prepare.mock.calls[0][0].computeUnitLimit).toBe(900_000);
  });

  it("puts the limit first without a price too (same bytes), but not on prepare, which does not estimate", async () => {
    const f = fixture();
    sim.verdict = { err: null, logs: [], unitsConsumed: 300_000 };
    await f.guarded.transaction.prepareAndSend(request({ instructions: [ix(1_200)] }));
    await f.guarded.transaction.prepare(request());
    const tooLarge = f.prepareAndSend.mock.calls[0][0] as TransactionPrepareAndSendRequest;
    expect([tooLarge.computeUnitPrice, tooLarge.computeUnitLimit]).toEqual([undefined, 330_000]);
    expect(f.prepare.mock.calls.at(-1)![0].computeUnitLimit).toBeUndefined();
  });
});

describe("the simulation gate", () => {
  it("runs after maintenance and before the wallet-policy prompt: one simulation per send", async () => {
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(request());
    expect(events).toEqual(["network", "fee", "maintenance", "sdk.prepare", "simulate", "authorize", "sdk.prepareAndSend"]);
  });

  it("prepares the probe with a placeholder lifetime (the node replaces it), or the caller's own", async () => {
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(request());
    expect(f.prepare.mock.calls[0][0].lifetime).toEqual(PROBE_LIFETIME);
    expect(f.prepare.mock.calls[0][0]).not.toHaveProperty("prepareTransaction");
    const lifetime = { blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: BigInt(9) } as TransactionPrepareRequest["lifetime"];
    await f.guarded.transaction.prepareAndSend(request({ lifetime, prepareTransaction: { blockhashReset: false } }));
    expect(f.prepare.mock.calls[1][0].lifetime).toEqual(lifetime);
    // The caller's lifetime reaches the SDK unchanged (a reservation is released by its block height).
    const sent = f.prepareAndSend.mock.calls[1][0] as TransactionPrepareAndSendRequest;
    expect(sent.lifetime).toEqual(lifetime);
    expect(sent.prepareTransaction).toEqual({ blockhashReset: false, computeUnitLimitReset: false });
  });

  it("refuses a failing transaction before the policy prompt and the wallet, explained", async () => {
    const f = fixture();
    sim.verdict = {
      err: { InstructionError: [3, { Custom: 6005 }] },
      logs: [
        `Program ${TOKEN_2022} invoke [1]`,
        `Program ${HOOK} invoke [2]`,
        "Program log: AnchorError occurred. Error Code: ReceiverNotApproved. Error Number: 6005. Error Message: Receiver has no approved KYC entry in the registry.",
        `Program ${HOOK} failed: custom program error: 0x1775`,
        `Program ${TOKEN_2022} failed: custom program error: 0x1775`,
      ],
      unitsConsumed: 20_000,
    };
    const ata = { programAddress: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address, data: new Uint8Array([1]) };
    const transfer = { programAddress: TOKEN_2022, data: new Uint8Array([12, 1, 0, 0, 0, 0, 0, 0, 0, 0]) };
    const failure = await f.guarded.transaction
      .prepareAndSend(request({ instructions: [ata, transfer] }))
      .then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(SimulationRefusedError);
    expect(events).not.toContain("authorize");
    expect(f.prepareAndSend).not.toHaveBeenCalled();
    // [limit, price, ata, transfer]: message index 3 is the app's step 2 of 2.
    expect((failure as SimulationRefusedError).instructionIndex).toBe(1);
    expect(explainSendError(failure)).toBe(
      "This transaction would fail, so your wallet was not opened. Step 2 of 2 (token transfer) was refused by the Manci transfer hook: " +
        "The recipient has no approved investor passport in this share class's KYC registry (ReceiverNotApproved, 6005).",
    );
  });

  it("a code the table does not word is explained by the account Anchor names, with the sale sync per the issuer-rotation flag", async () => {
    sim.verdict = {
      err: { InstructionError: [2, { Custom: 6001 }] },
      logs: [
        `Program ${PROGRAM} invoke [1]`,
        "Program log: AnchorError caused by account: sale. Error Code: Unauthorized. Error Number: 6001. Error Message: Signer is not authorized for this action.",
        `Program ${PROGRAM} failed: custom program error: 0x1771`,
      ],
      unitsConsumed: 5_000,
    };
    const refused = async () =>
      explainSendError(await fixture().guarded.transaction.prepareAndSend(request()).then(() => null, (err: unknown) => err));
    const opening = "This transaction would fail, so your wallet was not opened. Step 1 of 1 (Manci registry instruction) was refused by the Manci registry program: ";
    // Devnet: issuer rotation is on.
    expect(await refused()).toBe(`${opening}${SALE_AUTHORITY_HINT}${SALE_SYNC_SUFFIX}`);
    vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "false");
    expect(await refused()).toBe(`${opening}${SALE_AUTHORITY_HINT}`);
  });

  it("fails closed when the network cannot be asked", async () => {
    const f = fixture();
    sim.throws = new Error("fetch failed");
    const failure = await f.guarded.transaction.prepareAndSend(request()).then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(SimulationUnavailableError);
    expect(explainSendError(failure)).toMatch(/^Could not test this transaction on devnet before opening your wallet, so nothing was sent \(fetch failed\)/);
    expect(events).not.toContain("authorize");
    expect(f.prepareAndSend).not.toHaveBeenCalled();
  });

  it("gates a prepared transaction before sign, toWire and send", async () => {
    const f = fixture();
    const prepared = await f.guarded.transaction.prepare(request());
    sim.verdict = { err: "InsufficientFundsForFee", logs: [], unitsConsumed: 0 };
    for (const method of ["sign", "toWire", "send"] as const) {
      await expect(f.guarded.transaction[method](prepared)).rejects.toBeInstanceOf(SimulationRefusedError);
    }
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.toWire).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(events).not.toContain("authorize");
    expect(sim.messages.at(-1)).toBe(prepared.message);
  });

  it("waits for this client's previous send to be confirmed before simulating the next (sendBatches)", async () => {
    const statuses = vi.fn()
      .mockResolvedValueOnce({ value: [null] })
      .mockResolvedValueOnce({ value: [{ confirmationStatus: "confirmed", err: null }] });
    const f = fixture("devnet", {
      getSignatureStatuses: (signatures: string[]) => ({
        send: async () => {
          events.push(`status:${signatures[0]}`);
          return statuses();
        },
      }),
    });
    await f.guarded.transaction.prepareAndSend(request());
    events.length = 0;
    await f.guarded.transaction.prepareAndSend(request());
    expect(statuses).toHaveBeenCalledTimes(2);
    expect(events.indexOf("status:signature")).toBeGreaterThan(-1);
    expect(events.lastIndexOf("status:signature")).toBeLessThan(events.indexOf("simulate"));
  });
});

describe("the pilot scope on the wallet path: a page's declared purpose reaches the gate", () => {
  // /admin/custody sends a conversion approval as tx.send({ instructions: [ix],
  // feePayer }); @solana/react-hooks' useSendTransaction copies only the
  // request ({ ...request, authority }) and calls this client's
  // prepareAndSend, which runs the pilot-scope gate on input.instructions
  // first. The declaration (withGateFacts) belongs to the instruction object,
  // so it must still be on that object when the gate reads it; if a library
  // upgrade ever copies instructions before the gate, the second case shows
  // what happens (a delivery, refused), and this test is where it shows.
  const conversionOpen = () =>
    withGateFacts(
      {
        programAddress: PROGRAM,
        data: new Uint8Array(getOpenCustodyVaultInstructionDataEncoder().encode({
          vaultId: BigInt(1), vaultType: VaultType.DeliveryEscrow, realizeAction: RealizeAction.BurnAndAttest,
          amount: BigInt(10), deadline: BigInt(0), metadataHash: new Uint8Array(32), beneficiary: WALLET,
        })),
      } as Instruction,
      { custodyPurpose: "conversion" },
    );

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    oracle.network = "mainnet";
    for (const name of Object.values(PILOT_MODULE_ENV)) vi.stubEnv(name, "");
    vi.stubEnv(PILOT_MODULE_ENV.custodyConversion, "true");
  });

  it("mainnet, conversion alone switched on: the declared conversion open passes the gate and reaches the SDK", async () => {
    const f = fixture("mainnet");
    const declared = conversionOpen();
    // As the hook passes it: a shallow copy of the request, the same instruction objects.
    const sent = { ...request({ instructions: [declared] }) };
    await expect(f.guarded.transaction.prepareAndSend(sent)).resolves.toBe("signature");
    expect(f.prepareAndSend).toHaveBeenCalledOnce();
    expect(events).toContain("simulate");
    expect(events.at(-1)).toBe("sdk.prepareAndSend");
  });

  it("a copy of the instruction carries no declaration: it is gated as a delivery and refused before the wallet", async () => {
    const f = fixture("mainnet");
    const copied = { ...conversionOpen() };
    const failure = await f.guarded.transaction.prepareAndSend(request({ instructions: [copied] })).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ModuleDisabledFlowError);
    expect((failure as ModuleDisabledFlowError).module).toBe("custodyDelivery");
    expect(explainSendError(failure)).toBe("Physical delivery: not available on Solana mainnet. Nothing was sent to your wallet.");
    expect(events).not.toContain("simulate");
    expect(events).not.toContain("authorize");
    expect(f.prepareAndSend).not.toHaveBeenCalled();
  });
});
