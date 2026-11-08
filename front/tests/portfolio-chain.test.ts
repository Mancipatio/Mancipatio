// lib/portfolio-chain.ts: the wallet's balance change per share-class mint
// from a transaction's token balances (own accounts summed, escrow owners
// kept, failed transactions ignored), and the history loader over a fake
// RPC: closed associated accounts read, the cap and failed reads reported as
// an incomplete history, never as a wrong one.
import { getAddressDecoder, type Address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { describe, expect, it, vi } from "vitest";
import { loadShareHistory, movementsFromTransaction, type RawHistoryTransaction, type ShareHistoryRpc } from "@/lib/portfolio-chain";

const addr = (seed: number) => getAddressDecoder().decode(new Uint8Array(32).fill(seed)).toString();
const OWNER = addr(21);
const OTHER = addr(22);
const VAULT = addr(23);
const MINT = addr(24);
const MINT_B = addr(25);
const USDC = addr(26);
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const B = (n: number) => BigInt(n);
const sig = (n: number) => `${"4".repeat(20)}${String(n).replace(/0/g, "z").padStart(4, "A")}${"5".repeat(64)}`;

type Balance = { accountIndex: number; mint: string; owner: string; uiTokenAmount: { amount: string } };
const bal = (accountIndex: number, mint: string, owner: string, amount: number): Balance =>
  ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(amount) } });
const tx = (pre: Balance[], post: Balance[], over: Partial<RawHistoryTransaction> = {}): RawHistoryTransaction =>
  ({ blockTime: 1_800_000_000, meta: { err: null, preTokenBalances: pre, postTokenBalances: post }, ...over });
const SHARE = new Set([MINT, MINT_B]);

describe("movementsFromTransaction", () => {
  it("reads a deposit into an escrow: the wallet's loss and the vault as the counter-owner", () => {
    const read = movementsFromTransaction(
      tx([bal(1, MINT, OWNER, 10), bal(2, MINT, VAULT, 0)], [bal(1, MINT, OWNER, 6), bal(2, MINT, VAULT, 4)]),
      sig(1), OWNER, SHARE,
    );
    expect(read).toEqual({
      blockTime: 1_800_000_000,
      movements: [{ signature: sig(1), blockTime: 1_800_000_000, mint: MINT, delta: B(-4), owners: [VAULT] }],
    });
  });

  it("sums the wallet's accounts of a mint: a move between its own accounts is no movement", () => {
    const own = movementsFromTransaction(
      tx([bal(1, MINT, OWNER, 10), bal(2, MINT, OWNER, 0)], [bal(1, MINT, OWNER, 3), bal(2, MINT, OWNER, 7)]),
      sig(2), OWNER, SHARE,
    );
    expect(own.movements).toEqual([]);
  });

  it("counts an account created (no pre balance) or closed (no post balance) in the transaction", () => {
    const created = movementsFromTransaction(tx([bal(1, MINT, OTHER, 5)], [bal(1, MINT, OTHER, 0), bal(2, MINT, OWNER, 5)]), sig(3), OWNER, SHARE);
    expect(created.movements.map((m) => [m.delta, m.owners])).toEqual([[B(5), [OTHER]]]);
    const closed = movementsFromTransaction(tx([bal(2, MINT, OWNER, 5)], [bal(1, MINT, OTHER, 5)]), sig(4), OWNER, SHARE);
    expect(closed.movements.map((m) => m.delta)).toEqual([B(-5)]);
  });

  it("ignores other mints (USDC) and failed transactions", () => {
    const usdc = movementsFromTransaction(tx([bal(1, USDC, OWNER, 100)], [bal(1, USDC, OWNER, 0)]), sig(5), OWNER, SHARE);
    expect(usdc.movements).toEqual([]);
    const failed = movementsFromTransaction(
      tx([bal(1, MINT, OWNER, 10)], [bal(1, MINT, OWNER, 0)], { meta: { err: { InstructionError: [0, "Custom"] }, preTokenBalances: [], postTokenBalances: [] } }),
      sig(6), OWNER, SHARE,
    );
    expect(failed.movements).toEqual([]);
    expect(movementsFromTransaction({ blockTime: null, meta: null }, sig(7), OWNER, SHARE)).toEqual({ blockTime: null, movements: [] });
  });

  it("reports two mints of one transaction separately", () => {
    const read = movementsFromTransaction(
      tx([bal(1, MINT, OWNER, 1), bal(2, MINT_B, OWNER, 0)], [bal(1, MINT, OWNER, 0), bal(2, MINT_B, OWNER, 2)]),
      sig(8), OWNER, SHARE,
    );
    expect(read.movements.map((m) => [m.mint, m.delta])).toEqual([[MINT, B(-1)], [MINT_B, B(2)]]);
  });

  it("refuses an unreadable balance instead of guessing zero", () => {
    expect(() => movementsFromTransaction(
      tx([{ accountIndex: 1, mint: MINT, owner: OWNER, uiTokenAmount: { amount: "1.5" } }], []), sig(9), OWNER, SHARE,
    )).toThrow(/Unreadable token balance/);
  });
});

describe("loadShareHistory", () => {
  const parsed = (pubkey: string, mint: string, amount: number) => ({
    pubkey, account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(amount) } } } } },
  });

  function fakeRpc(input: {
    accounts: unknown[];
    signatures: Record<string, { signature: string; blockTime: number; err?: unknown }[]>;
    transactions: Record<string, RawHistoryTransaction | null | "throw">;
  }) {
    const calls = { signatures: [] as string[], transactions: [] as string[] };
    const rpc = {
      getTokenAccountsByOwner: vi.fn((owner: string, filter: { programId: string }) => ({
        send: async () => {
          expect(owner).toBe(OWNER);
          expect(filter.programId).toBe(TOKEN_2022);
          return { value: input.accounts };
        },
      })),
      getSignaturesForAddress: vi.fn((address: string, config: { limit: number; before?: string }) => ({
        send: async () => {
          calls.signatures.push(address);
          const all = input.signatures[address] ?? [];
          const start = config.before ? all.findIndex((s) => s.signature === config.before) + 1 : 0;
          return all.slice(start, start + config.limit).map((s) => ({ err: null, ...s }));
        },
      })),
      getTransaction: vi.fn((signature: string) => ({
        send: async () => {
          calls.transactions.push(signature);
          const answer = input.transactions[signature];
          if (answer === "throw") throw new Error("decode failed");
          return answer ?? null;
        },
      })),
    };
    return { rpc: rpc as unknown as ShareHistoryRpc, calls };
  }

  it("reads the wallet's accounts and a closed associated account, with balances, block times and progress", async () => {
    const current = addr(31);
    const [closedAta] = await findAssociatedTokenPda({ owner: OWNER as Address, mint: MINT_B as Address, tokenProgram: TOKEN_2022 });
    const { rpc, calls } = fakeRpc({
      accounts: [parsed(current, MINT, 6), parsed(addr(32), USDC, 99)],
      signatures: {
        [current]: [{ signature: sig(2), blockTime: 200 }, { signature: sig(1), blockTime: 100 }, { signature: sig(9), blockTime: 50, err: { x: 1 } }],
        [closedAta.toString()]: [{ signature: sig(3), blockTime: 150 }],
      },
      transactions: {
        [sig(1)]: tx([bal(1, MINT, OTHER, 10)], [bal(1, MINT, OTHER, 0), bal(2, MINT, OWNER, 10)], { blockTime: 100 }),
        [sig(2)]: tx([bal(2, MINT, OWNER, 10), bal(3, MINT, VAULT, 0)], [bal(2, MINT, OWNER, 6), bal(3, MINT, VAULT, 4)], { blockTime: 200 }),
        [sig(3)]: tx([bal(4, MINT_B, OWNER, 2)], [bal(5, MINT_B, OTHER, 2)], { blockTime: 150 }),
        [sig(4)]: tx([], [], { blockTime: 300 }),
      },
    });
    const progress: Array<[number, number]> = [];
    const history = await loadShareHistory(rpc, OWNER as Address, {
      shareMints: SHARE, recordMints: new Set([MINT_B]), recordSignatures: new Set([sig(4)]),
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(history.complete).toBe(true);
    expect(history.problem).toBeNull();
    expect([...(history.balances ?? new Map())]).toEqual([[MINT, B(6)]]);
    expect(history.movements.map((m) => [m.signature, m.mint, m.delta]).sort()).toEqual([
      [sig(1), MINT, B(10)], [sig(2), MINT, B(-4)], [sig(3), MINT_B, B(-2)],
    ].sort());
    expect(history.blockTimes.get(sig(4))).toBe(300);
    // The failed transaction is never read; the USDC account is not crawled.
    expect(calls.transactions).not.toContain(sig(9));
    expect(calls.signatures.sort()).toEqual([current, closedAta.toString()].sort());
    expect(progress[0]).toEqual([0, 4]);
    expect(progress[progress.length - 1]).toEqual([4, 4]);
  });

  it("keeps the newest transactions when the history is longer than the cap, and says so", async () => {
    const account = addr(33);
    const list = Array.from({ length: 7 }, (_, i) => ({ signature: sig(i + 10), blockTime: 1_000 - i }));
    const { rpc, calls } = fakeRpc({
      accounts: [parsed(account, MINT, 0)],
      signatures: { [account]: list },
      transactions: Object.fromEntries(list.map((s) => [s.signature, tx([], [], { blockTime: s.blockTime })])),
    });
    const history = await loadShareHistory(rpc, OWNER as Address, {
      shareMints: SHARE, recordMints: new Set(), recordSignatures: new Set(), maxSignatures: 3,
    });
    expect(history.complete).toBe(false);
    expect(history.problem).toBe("only the newest 3 transactions were read");
    expect(calls.transactions).toEqual([sig(10), sig(11), sig(12)]);
  });

  it("reports transactions it could not read as an incomplete history", async () => {
    const account = addr(34);
    const { rpc } = fakeRpc({
      accounts: [parsed(account, MINT, 1)],
      signatures: { [account]: [{ signature: sig(1), blockTime: 10 }, { signature: sig(2), blockTime: 20 }] },
      transactions: { [sig(1)]: "throw", [sig(2)]: null },
    });
    const history = await loadShareHistory(rpc, OWNER as Address, { shareMints: SHARE, recordMints: new Set(), recordSignatures: new Set() });
    expect(history.complete).toBe(false);
    expect(history.problem).toBe("2 transactions could not be read");
    expect(history.movements).toEqual([]);
  });

  it("fails when the wallet's token accounts cannot be decoded (never an empty portfolio)", async () => {
    const { rpc } = fakeRpc({ accounts: [{ pubkey: addr(35), account: { data: "base64" } }], signatures: {}, transactions: {} });
    await expect(loadShareHistory(rpc, OWNER as Address, { shareMints: SHARE, recordMints: new Set(), recordSignatures: new Set() }))
      .rejects.toThrow(/could not be decoded/);
  });
});
