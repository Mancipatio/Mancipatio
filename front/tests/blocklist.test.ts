// lib/blocklist (Talas 3.1 K6/K8): the passport issue gate reads the
// receiver's ["blocked", wallet] PDA directly — the hook checks the sender
// only — so the batch read must validate exactly like fetchBlockEntry and
// throw (never "not blocked") on an RPC error. The admin table's scan is
// filtered by the BlockEntry discriminator on the RPC side.
import { describe, expect, it } from "vitest";
import {
  getAddressEncoder,
  getBase58Decoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  getBlockEntryDiscriminatorBytes,
  getBlockEntryEncoder,
} from "@/lib/generated/transfer_hook";
import { BLOCK_ENTRY_CHUNK, fetchBlockEntries, listBlockEntries } from "@/lib/blocklist";

const BA = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const FOREIGN = "Stake11111111111111111111111111111111111111" as Address;

async function blockPda(wallet: Address): Promise<Address> {
  return (
    await getProgramDerivedAddress({
      programAddress: TRANSFER_HOOK_PROGRAM_ADDRESS,
      seeds: [new TextEncoder().encode("blocked"), getAddressEncoder().encode(wallet)],
    })
  )[0];
}

const entry = (wallet: Address) =>
  new Uint8Array(getBlockEntryEncoder().encode({ wallet, addedBy: BA, bump: 254 }));

type Stored = { owner: Address; data: Uint8Array };

function rpcAccount(a: Stored) {
  return {
    data: [Buffer.from(a.data).toString("base64"), "base64"],
    owner: a.owner,
    executable: false,
    lamports: BigInt(1),
    space: BigInt(a.data.length),
    rentEpoch: BigInt(0),
  };
}

function batchRpc(accounts: Map<string, Stored>, calls: number[]) {
  return {
    getMultipleAccounts: (addresses: Address[]) => ({
      send: async () => {
        calls.push(addresses.length);
        return { value: addresses.map((a) => (accounts.has(a) ? rpcAccount(accounts.get(a)!) : null)) };
      },
    }),
  } as unknown as Parameters<typeof fetchBlockEntries>[0];
}

/** Deterministic distinct wallet addresses (a valid 32-byte key each). */
function wallets(n: number): Address[] {
  const b58 = getBase58Decoder();
  return Array.from({ length: n }, (_, i) => {
    const bytes = new Uint8Array(32);
    bytes[0] = 1 + (i % 250);
    bytes[1] = Math.floor(i / 250) + 1;
    return b58.decode(bytes) as Address;
  });
}

describe("fetchBlockEntries", () => {
  it("reads the PDAs in chunks of 100 and returns only live entries", async () => {
    const ws = wallets(250);
    const accounts = new Map<string, Stored>();
    accounts.set(await blockPda(ws[3]), { owner: TRANSFER_HOOK_PROGRAM_ADDRESS, data: entry(ws[3]) });
    accounts.set(await blockPda(ws[240]), { owner: TRANSFER_HOOK_PROGRAM_ADDRESS, data: entry(ws[240]) });
    const calls: number[] = [];
    const hits = await fetchBlockEntries(batchRpc(accounts, calls), ws);
    expect(BLOCK_ENTRY_CHUNK).toBe(100);
    expect(calls).toEqual([100, 100, 50]);
    expect([...hits.keys()].sort()).toEqual([ws[3], ws[240]].sort());
    expect(hits.get(ws[3])).toEqual({ pda: await blockPda(ws[3]), addedBy: BA });
  });

  it("deduplicates and makes no call for an empty list", async () => {
    const [w] = wallets(1);
    const calls: number[] = [];
    await fetchBlockEntries(batchRpc(new Map(), calls), [w, w, w]);
    expect(calls).toEqual([1]);
    const none: number[] = [];
    expect((await fetchBlockEntries(batchRpc(new Map(), none), [])).size).toBe(0);
    expect(none).toEqual([]);
  });

  it("applies fetchBlockEntry's checks: foreign owner, wrong discriminator, other wallet → not blocked", async () => {
    const [a, b, c, other] = wallets(4);
    const bad = entry(b);
    bad[0] ^= 0xff;
    const accounts = new Map<string, Stored>([
      [await blockPda(a), { owner: FOREIGN, data: entry(a) }],
      [await blockPda(b), { owner: TRANSFER_HOOK_PROGRAM_ADDRESS, data: bad }],
      [await blockPda(c), { owner: TRANSFER_HOOK_PROGRAM_ADDRESS, data: entry(other) }],
    ]);
    const hits = await fetchBlockEntries(batchRpc(accounts, []), [a, b, c]);
    expect(hits.size).toBe(0);
  });

  it("throws on an RPC error (the caller must treat the status as unknown)", async () => {
    const rpc = {
      getMultipleAccounts: () => ({
        send: async () => {
          throw new Error("429 Too Many Requests");
        },
      }),
    } as unknown as Parameters<typeof fetchBlockEntries>[0];
    await expect(fetchBlockEntries(rpc, wallets(3))).rejects.toThrow("429");
  });
});

describe("listBlockEntries", () => {
  it("asks the RPC for BlockEntry accounts only (discriminator memcmp at offset 0)", async () => {
    const [w] = wallets(1);
    let config: { filters?: Array<{ memcmp: { offset: bigint; bytes: string; encoding: string } }> } = {};
    const rpc = {
      getProgramAccounts: (program: Address, c: typeof config) => {
        expect(program).toBe(TRANSFER_HOOK_PROGRAM_ADDRESS);
        config = c;
        return {
          send: async () => [
            { pubkey: await blockPda(w), account: rpcAccount({ owner: TRANSFER_HOOK_PROGRAM_ADDRESS, data: entry(w) }) },
          ],
        };
      },
    } as unknown as Parameters<typeof listBlockEntries>[0];
    const rows = await listBlockEntries(rpc);
    expect(config.filters).toEqual([
      {
        memcmp: {
          offset: BigInt(0),
          encoding: "base58",
          bytes: getBase58Decoder().decode(getBlockEntryDiscriminatorBytes()),
        },
      },
    ]);
    expect(rows.map((r) => r.entry.wallet)).toEqual([w]);
  });
});
