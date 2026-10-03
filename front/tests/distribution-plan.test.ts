// "Send to wallets" packing (lib/distribution-plan): rows packed whole into
// transactions of at most 1200 B with the send path's compute-budget
// instructions, an index table per transaction so a refused instruction
// names its row, and the drop-and-repack loop over the simulation gate.
import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { RestrictionMode } from "@/lib/generated/transfer_hook";
import {
  DISTRIBUTION_TX_LIMIT,
  MAX_TRANSACTIONS_PER_PROMPT,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  lamportsNeeded,
  packRows,
  planWithSimulation,
  promptGroups,
  rowForInstruction,
  rowInstructions,
  sentSize,
  type RowInstructions,
} from "@/lib/distribution-plan";

const MINT = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC" as Address;
const REGISTRY = "5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku" as Address;
const OPEN = null;
const KYC = { restrictionMode: RestrictionMode.KycGated, kycRegistry: { __option: "Some" as const, value: REGISTRY } };

let sender: TransactionSigner;

async function rows(count: number, opts: { create: boolean; hook?: typeof KYC | null } = { create: true }): Promise<RowInstructions[]> {
  sender ??= await generateKeyPairSigner();
  return Promise.all(
    Array.from({ length: count }, async () =>
      rowInstructions({
        mint: MINT,
        sender,
        wallet: (await generateKeyPairSigner()).address,
        amount: BigInt(10),
        decimals: 0,
        hookConfig: opts.hook ?? OPEN,
        accountExists: !opts.create,
      }),
    ),
  );
}

const shape = (txs: ReturnType<typeof packRows>) => txs.map((t) => t.index.length);

describe("rowInstructions", () => {
  it("creates the recipient's token account only when it is missing", async () => {
    const [withCreate] = await rows(1, { create: true });
    const [transferOnly] = await rows(1, { create: false });
    expect(withCreate.instructions).toHaveLength(2);
    expect(withCreate.createsAccount).toBe(true);
    expect(transferOnly.instructions).toHaveLength(1);
    expect(transferOnly.instructions[0].data![0]).toBe(12); // TransferChecked
  });
});

describe("packing (measured, 1200 B working limit with the compute-budget instructions)", () => {
  it("rows with account creation: 1 → 538 B, 8 fit (1196 B), 9 do not", async () => {
    sender = await generateKeyPairSigner();
    expect(DISTRIBUTION_TX_LIMIT).toBe(1200);
    const one = packRows(await rows(1), { feePayer: sender.address });
    expect(one[0].size).toBe(538);
    const eight = packRows(await rows(8), { feePayer: sender.address });
    expect(shape(eight)).toEqual([8]);
    expect(eight[0].size).toBe(1196);
    expect(shape(packRows(await rows(9), { feePayer: sender.address }))).toEqual([8, 1]);
  });

  it("transfer-only rows: 1 → 432 B, 15 fit (1160 B), 16 do not", async () => {
    const one = packRows(await rows(1, { create: false }), { feePayer: sender.address });
    expect(one[0].size).toBe(432);
    const fifteen = packRows(await rows(15, { create: false }), { feePayer: sender.address });
    expect(shape(fifteen)).toEqual([15]);
    expect(fifteen[0].size).toBe(1160);
    expect(shape(packRows(await rows(16, { create: false }), { feePayer: sender.address }))).toEqual([15, 1]);
  });

  it("mixed: 4 new + 7 existing fit (1184 B), 4 new + 8 existing do not", async () => {
    const fits = [...(await rows(4)), ...(await rows(7, { create: false }))];
    const packed = packRows(fits, { feePayer: sender.address });
    expect(shape(packed)).toEqual([11]);
    expect(packed[0].size).toBe(1184);
    const over = [...(await rows(4)), ...(await rows(8, { create: false }))];
    expect(shape(packRows(over, { feePayer: sender.address }))).toEqual([11, 1]);
  });

  it("a KycGated class: 3 rows with account creation fit (1064 B), 4 do not", async () => {
    const three = packRows(await rows(3, { create: true, hook: KYC }), { feePayer: sender.address });
    expect(shape(three)).toEqual([3]);
    expect(three[0].size).toBe(1064);
    expect(shape(packRows(await rows(4, { create: true, hook: KYC }), { feePayer: sender.address }))).toEqual([3, 1]);
  });

  it("every packed transaction stays within the limit and keeps each row whole", async () => {
    const mixed = [...(await rows(13)), ...(await rows(20, { create: false })), ...(await rows(5))];
    const packed = packRows(mixed, { feePayer: sender.address });
    for (const t of packed) {
      expect(t.size).toBeLessThanOrEqual(DISTRIBUTION_TX_LIMIT);
      expect(sentSize(sender.address, t.instructions)).toBe(t.size);
      expect(t.index.reduce((n, e) => n + e.count, 0)).toBe(t.instructions.length);
    }
    expect(packed.flatMap((t) => t.index.map((e) => e.row))).toEqual(mixed.map((r) => r.row));
  });

  it("refuses a row that alone is over the limit", () => {
    const huge: RowInstructions = {
      row: "x",
      createsAccount: false,
      instructions: [{ programAddress: MINT, data: new Uint8Array(1300) } as Instruction],
    };
    expect(() => packRows([huge], { feePayer: sender.address })).toThrow(/over the 1200-byte limit/);
  });
});

describe("index → row", () => {
  it("maps an instruction index to its row in 8-row, 15-row and mixed packs (never ÷ 2)", async () => {
    const eight = packRows(await rows(8), { feePayer: sender.address })[0];
    expect(rowForInstruction(eight, 0)).toBe(eight.index[0].row);
    expect(rowForInstruction(eight, 1)).toBe(eight.index[0].row);
    expect(rowForInstruction(eight, 15)).toBe(eight.index[7].row);
    const fifteen = packRows(await rows(15, { create: false }), { feePayer: sender.address })[0];
    expect(rowForInstruction(fifteen, 9)).toBe(fifteen.index[9].row);
    const mixed = packRows([...(await rows(2, { create: false })), ...(await rows(2))], { feePayer: sender.address })[0];
    // [t0][t1][c2 t2][c3 t3]: index 3 is row 2's transfer, 4 is row 3's creation.
    expect(rowForInstruction(mixed, 3)).toBe(mixed.index[2].row);
    expect(rowForInstruction(mixed, 4)).toBe(mixed.index[3].row);
    expect(rowForInstruction(mixed, 6)).toBeNull();
    expect(rowForInstruction(mixed, null)).toBeNull();
    expect(rowForInstruction(mixed, -1)).toBeNull();
  });
});

describe("planWithSimulation", () => {
  it("drops each refused row with its reason and repacks the rest", async () => {
    const list = await rows(10);
    const bad = new Set([list[2].row, list[9].row]);
    let calls = 0;
    const plan = await planWithSimulation(list, {
      feePayer: sender.address,
      simulate: async (instructions) => {
        calls += 1;
        // Refuse at the first instruction that pays a bad row (the simulation stops there).
        for (const r of list) {
          if (!bad.has(r.row)) continue;
          const at = instructions.indexOf(r.instructions[r.instructions.length - 1]);
          if (at >= 0) return { instructionIndex: at, detail: `Step ${at + 1} refused`, message: "refused" };
        }
        return null;
      },
    });
    expect(plan.dropped.map((d) => d.row).sort()).toEqual([...bad].sort());
    expect(plan.dropped.every((d) => /^Step \d+ refused$/.test(d.reason))).toBe(true);
    expect(plan.transactions.flatMap((t) => t.index.map((e) => e.row))).toEqual(list.filter((r) => !bad.has(r.row)).map((r) => r.row));
    expect(shape(plan.transactions)).toEqual([8]);
    // Round 1: [8, 2] rows, both refused; round 2: the 8 rows left, in one transaction that passes.
    expect(calls).toBe(3);
  });

  it("a refusal no row explains (the fee payer cannot pay) fails the whole plan", async () => {
    await expect(
      planWithSimulation(await rows(2), {
        feePayer: sender.address,
        simulate: async () => ({ instructionIndex: null, detail: "x", message: "The network refused it before running it (InsufficientFundsForFee)." }),
      }),
    ).rejects.toThrow(/InsufficientFundsForFee/);
  });

  it("stops after a bounded number of rounds", async () => {
    const list = await rows(3);
    await expect(
      planWithSimulation(list, {
        feePayer: sender.address,
        maxRounds: 2,
        simulate: async () => ({ instructionIndex: 0, detail: "refused", message: "refused" }),
      }),
    ).rejects.toThrow(/kept refusing/);
    expect((await planWithSimulation([], { feePayer: sender.address, simulate: async () => null })).transactions).toEqual([]);
  });
});

describe("prompts and SOL", () => {
  it(`groups up to ${MAX_TRANSACTIONS_PER_PROMPT} transactions per wallet approval`, () => {
    expect(promptGroups([1, 2, 3]).map((g) => g.length)).toEqual([3]);
    expect(promptGroups(Array.from({ length: 17 }, (_, i) => i)).map((g) => g.length)).toEqual([8, 8, 1]);
  });

  it("needs the rent of every new token account plus each transaction's fees", () => {
    expect(TOKEN_ACCOUNT_RENT_LAMPORTS).toBe(BigInt(2_108_880));
    expect(lamportsNeeded({ newAccounts: 8, transactions: 1 })).toBe(BigInt(8 * 2_108_880 + 5_000));
    expect(lamportsNeeded({ newAccounts: 0, transactions: 2, computeUnitLimit: 400_000, microLamportsPerUnit: BigInt(100_000) })).toBe(
      BigInt(2 * (5_000 + 40_000)),
    );
  });
});
