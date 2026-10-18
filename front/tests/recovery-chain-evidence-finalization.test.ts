// F072 (server): a record sent moments after the transaction is answered
// "awaiting finalization" (409, code awaiting_finalization) — never "terms
// do not match" or a bare 503 — after the finalized read was repeated for a
// few seconds. tests/custody-evidence-server.test.ts keeps the rest.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  liveVault: vi.fn(),
  query: vi.fn(),
  vault: vi.fn(),
  updates: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
vi.mock("@/lib/server/rpc", () => ({
  getServerRpc: () => ({
    getTransaction: (...args: unknown[]) => ({
      send: () => mocks.transaction(...args),
    }),
  }),
}));
vi.mock("@/lib/closed-account", async (original) => ({
  ...(await original<typeof import("@/lib/closed-account")>()),
  fetchMaybeLiveCustodyVault: mocks.liveVault,
}));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      let mutation = false;
      const q = {
        select: () => q,
        update: (patch: Record<string, unknown>) => {
          mutation = true;
          mocks.updates.push(patch);
          return q;
        },
        eq: () => q,
        maybeSingle: () => mocks.query(table, mutation),
      };
      return q;
    },
  }),
}));
import { getAddressDecoder, getBase58Decoder } from "@solana/kit";
import { VaultState } from "@/lib/generated/asset_registry";
import {
  AWAITING_FINALIZATION_CODE,
  AWAITING_FINALIZATION_MESSAGE,
  AwaitingFinalizationError,
  FINALIZED_READ_RETRIES,
  FINALIZED_READ_RETRY_DELAY_MS,
  readFinalizedTransaction,
  requireRequestVault,
} from "@/lib/server/chain-evidence";
import { validateCustodyUpdate } from "@/lib/server/custody-evidence";
import {
  AWAITING_FINALIZATION_RE,
  isAwaitingFinalizationError,
} from "@/lib/chain-record-recovery";

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const holder = key(1), vault = key(3), shareClass = key(4), mint = key(5), escrow = key(6);
const signature = getBase58Decoder().decode(new Uint8Array(64).fill(9));
const row = { holder_wallet: holder, share_class_pda: shareClass, mint, vault_pda: vault, vault_id: 7, amount: 3 };

/** The node's answers at finalized (in order, null = nothing yet) and at confirmed. */
function node(finalized: unknown[], confirmed: unknown) {
  const queue = [...finalized];
  mocks.transaction.mockImplementation(async (_sig: unknown, opts: { commitment: string }) =>
    opts.commitment === "finalized" ? (queue.length > 1 ? queue.shift() : queue[0]) : confirmed,
  );
}
async function settled<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const result = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  // Each empty finalized read waits FINALIZED_READ_RETRY_DELAY_MS before the next.
  for (let i = 0; i <= FINALIZED_READ_RETRIES; i++) await vi.advanceTimersByTimeAsync(FINALIZED_READ_RETRY_DELAY_MS);
  return result;
}
const finalizedReads = () => mocks.transaction.mock.calls.filter((c) => (c[1] as { commitment: string }).commitment === "finalized").length;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updates.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("readFinalizedTransaction", () => {
  it("reads again while the node has nothing at finalized, then returns the transaction", async () => {
    const tx = { slot: 5, meta: { err: null } };
    node([null, null, tx], null);
    const { value } = await settled(readFinalizedTransaction(signature));
    expect(value).toBe(tx);
    expect(finalizedReads()).toBe(3);
    expect(mocks.transaction).toHaveBeenCalledTimes(3);
  });
  it("after the retries, a transaction the node does not know is 'awaiting finalization' (409, typed, no 503)", async () => {
    node([null], null);
    const { error } = await settled(readFinalizedTransaction(signature));
    expect(error).toBeInstanceOf(AwaitingFinalizationError);
    expect(error).toMatchObject({ status: 409, code: AWAITING_FINALIZATION_CODE });
    expect((error as Error).message.startsWith(`${AWAITING_FINALIZATION_MESSAGE}:`)).toBe(true);
    expect((error as Error).message).toMatch(/do not send it again/);
    expect(finalizedReads()).toBe(1 + FINALIZED_READ_RETRIES);
    expect(mocks.transaction).toHaveBeenCalledTimes(2 + FINALIZED_READ_RETRIES);
  });
  it("says so when the node already shows the transaction as confirmed", async () => {
    node([null], { slot: 5, meta: { err: null } });
    const { error } = await settled(readFinalizedTransaction(signature));
    expect(error).toBeInstanceOf(AwaitingFinalizationError);
    expect((error as Error).message).toMatch(/confirmed but not finalized yet/);
  });
  it("a node that cannot be read is a 503 at once, without retries", async () => {
    mocks.transaction.mockRejectedValue(new Error("rpc down"));
    const { error } = await settled(readFinalizedTransaction(signature));
    expect(error).toMatchObject({ status: 503 });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
  it("with retries 0 (the purchase path) one finalized read decides", async () => {
    node([null], null);
    const { error } = await settled(readFinalizedTransaction(signature, { retries: 0 }));
    expect(error).toBeInstanceOf(AwaitingFinalizationError);
    expect(finalizedReads()).toBe(1);
  });
  it("an aborted signal ends the wait between two reads at once (503), with no further read", async () => {
    node([null], null);
    const controller = new AbortController();
    const result = readFinalizedTransaction(signature, { signal: controller.signal }).then(
      (value) => ({ value, error: undefined as unknown }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await vi.advanceTimersByTimeAsync(FINALIZED_READ_RETRY_DELAY_MS / 2);
    expect(finalizedReads()).toBe(1);
    controller.abort();
    const { error } = await result;
    expect(error).toMatchObject({ status: 503 });
    expect(finalizedReads()).toBe(1);
  });

  it("the client recognizes the message and the code", () => {
    const error = new AwaitingFinalizationError("later");
    expect(AWAITING_FINALIZATION_RE.test(error.message)).toBe(true);
    expect(isAwaitingFinalizationError(new Error(error.message))).toBe(true);
    expect(isAwaitingFinalizationError({ code: error.code })).toBe(true);
  });
});

describe("requireRequestVault: a vault not finalized yet is not a terms mismatch", () => {
  const absent = { exists: false, closed: false };
  it("reads the vault again while absent at finalized, then answers 'awaiting finalization' naming confirmed", async () => {
    mocks.liveVault.mockImplementation(async (_rpc: unknown, _addr: unknown, config: { commitment: string }) =>
      config.commitment === "finalized" ? absent : { exists: true, closed: false, data: {} },
    );
    const { error } = await settled(requireRequestVault(row));
    expect(error).toBeInstanceOf(AwaitingFinalizationError);
    expect((error as Error).message).toMatch(/confirmed but not finalized yet/);
    expect((error as Error).message).toMatch(/do not open another vault/);
    const commitments = mocks.liveVault.mock.calls.map((c) => (c[2] as { commitment: string }).commitment);
    expect(commitments).toEqual([...Array(1 + FINALIZED_READ_RETRIES).fill("finalized"), "confirmed"]);
  });
  it("a vault seen nowhere is 'awaiting finalization' too (the client retries; it never opens another vault)", async () => {
    mocks.liveVault.mockResolvedValue(absent);
    const { error } = await settled(requireRequestVault(row));
    expect(error).toBeInstanceOf(AwaitingFinalizationError);
    expect((error as Error).message).toMatch(/not on the network yet/);
  });
  it("a read bound to a context slot is decided at once: no retry", async () => {
    mocks.liveVault.mockResolvedValue(absent);
    const { error } = await settled(requireRequestVault(row, BigInt(5)));
    expect(error).toBeInstanceOf(AwaitingFinalizationError);
    expect(mocks.liveVault.mock.calls.map((c) => (c[2] as { commitment: string }).commitment)).toEqual(["finalized", "confirmed"]);
    expect(mocks.liveVault.mock.calls[0][2]).toMatchObject({ minContextSlot: BigInt(5) });
  });
  it("a tombstone still answers 'closed after settlement'", async () => {
    mocks.liveVault.mockResolvedValue({ exists: false, closed: true });
    const { error } = await settled(requireRequestVault(row));
    expect(error).toMatchObject({ status: 409, message: "Custody vault was closed after settlement" });
    expect(mocks.liveVault).toHaveBeenCalledTimes(1);
  });
});

describe("validateCustodyUpdate: a burn realized at confirmed but not at finalized", () => {
  const request = { id: "request-id", network: "devnet", holder_wallet: holder, share_class_pda: shareClass, mint, vault_pda: vault, amount: 3, status: "deposited", deposit_tx: "original", deposit_evidence: { signature: "original", vault }, outcome_evidence: null };
  beforeEach(() => {
    mocks.query.mockImplementation(async () => ({ data: { ...request }, error: null }));
    mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(3), state: VaultState.Active }, escrow: { amount: BigInt(3) } });
  });
  it.each([
    ["Realized at confirmed", VaultState.Realized, AwaitingFinalizationError, /realization is confirmed but not finalized yet/],
    ["still Active at confirmed", VaultState.Active, Error, /^On-chain realization is not finalized$/],
  ])("%s", async (_label, confirmedState, type, message) => {
    const chain = await import("@/lib/server/chain-evidence");
    const spy = vi.spyOn(chain, "requireRequestVault").mockImplementation(mocks.vault);
    mocks.liveVault.mockResolvedValue({ exists: true, closed: false, data: { state: confirmedState } });
    const { error } = await settled(validateCustodyUpdate("conversion_requests", "request-id", { status: "converted", outcome_tx: signature }));
    spy.mockRestore();
    expect(error).toBeInstanceOf(type);
    expect((error as Error).message).toMatch(message);
    expect(error).toMatchObject({ status: 409 });
    expect(mocks.liveVault.mock.calls.at(-1)?.[2]).toMatchObject({ commitment: "confirmed" });
    expect(mocks.updates).toEqual([]);
  });
});
