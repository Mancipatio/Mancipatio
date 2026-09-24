// lib/compute-budget (Talas 4.2 §2.1, §2.7): the envelope parser, the fee
// arithmetic and one byte source for every SetComputeUnit* instruction the
// app, the size placeholders and the chain CLI build.
import { describe, expect, it } from "vitest";
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionEncoder,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from "@solana/kit";
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  MAX_COMPUTE_UNIT_LIMIT,
  MAX_COMPUTE_UNIT_PRICE,
  SEND_OVERHEAD_INSTRUCTIONS,
  TRANSACTION_SIZE_LIMIT,
  formatLamportsAsSol,
  maxPriorityFeeLamports,
  parseEnvelopeComputeBudget,
  setComputeUnitLimitInstruction,
  setComputeUnitPriceInstruction,
  transactionSize,
} from "@/lib/compute-budget";
import * as issuerAuthority from "@/lib/issuer-authority";
import { VESTING_COMPUTE_UNITS, vestingTransactionBytes } from "@/lib/vesting-creation";
import { MAX_CU_PRICE } from "@/scripts/chain/lib/safety";
import { buildMessage } from "@/scripts/chain/lib/tx";

const PAYER = address("7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2");
const PROGRAM = address("FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS");
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return [...b]; };
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return [...b]; };

describe("parseEnvelopeComputeBudget", () => {
  it("accepts an integer limit 1..1.4M and a canonical price 0..2,000,000", () => {
    expect(parseEnvelopeComputeBudget({ computeUnitLimit: 1, computeUnitPriceMicroLamports: "0" })).toEqual({
      computeUnitLimit: 1,
      computeUnitPriceMicroLamports: "0",
    });
    expect(
      parseEnvelopeComputeBudget({ computeUnitLimit: MAX_COMPUTE_UNIT_LIMIT, computeUnitPriceMicroLamports: "2000000" }),
    ).toEqual({ computeUnitLimit: 1_400_000, computeUnitPriceMicroLamports: "2000000" });
  });

  it.each([
    [{ computeUnitLimit: 0, computeUnitPriceMicroLamports: "1" }, /limit/],
    [{ computeUnitLimit: 1_400_001, computeUnitPriceMicroLamports: "1" }, /limit/],
    [{ computeUnitLimit: 1.5, computeUnitPriceMicroLamports: "1" }, /limit/],
    [{ computeUnitLimit: "100", computeUnitPriceMicroLamports: "1" }, /limit/],
    [{ computeUnitPriceMicroLamports: "1" }, /limit/],
    [{ computeUnitLimit: 100, computeUnitPriceMicroLamports: "2000001" }, /price/],
    [{ computeUnitLimit: 100, computeUnitPriceMicroLamports: "01" }, /price/],
    [{ computeUnitLimit: 100, computeUnitPriceMicroLamports: "-1" }, /price/],
    [{ computeUnitLimit: 100, computeUnitPriceMicroLamports: 5 }, /price/],
    [{ computeUnitLimit: 100, computeUnitPriceMicroLamports: "1".repeat(21) }, /price/],
    [{ computeUnitLimit: 100 }, /price/],
  ])("rejects %j", (input, message) => {
    expect(() => parseEnvelopeComputeBudget(input)).toThrow(message);
  });
});

describe("priority fee arithmetic", () => {
  it("maxPriorityFeeLamports = limit × price / 1e6, rounded down", () => {
    // The hard-cap worst case: 1.4M CU at 2 lamports / CU = 0.0028 SOL.
    expect(maxPriorityFeeLamports(1_400_000, MAX_COMPUTE_UNIT_PRICE)).toBe(BigInt(2_800_000));
    expect(maxPriorityFeeLamports(200_000, BigInt(100_000))).toBe(BigInt(20_000));
    expect(maxPriorityFeeLamports(3, BigInt(1))).toBe(BigInt(0));
    expect(formatLamportsAsSol(BigInt(2_800_000))).toBe("0.0028");
    expect(formatLamportsAsSol(BigInt(0))).toBe("0");
    expect(formatLamportsAsSol(BigInt(1_500_000_001))).toBe("1.500000001");
  });

  it("the cap is 2,000,000 µL/CU and the chain CLI imports the same constant", () => {
    expect(MAX_COMPUTE_UNIT_PRICE).toBe(BigInt(2_000_000));
    expect(MAX_CU_PRICE).toBe(MAX_COMPUTE_UNIT_PRICE);
  });
});

describe("one byte source", () => {
  it("encodes [2, u32 LE] and [3, u64 LE] for the Compute Budget program", () => {
    const limit = setComputeUnitLimitInstruction(VESTING_COMPUTE_UNITS);
    const price = setComputeUnitPriceInstruction(BigInt(123_456));
    expect(limit.programAddress).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
    expect([...limit.data!]).toEqual([2, ...u32(400_000)]);
    expect([...price.data!]).toEqual([3, ...u64(BigInt(123_456))]);
  });

  it("the send-path placeholders and size helpers are the ones issuer-authority re-exports", () => {
    expect(issuerAuthority.SEND_OVERHEAD_INSTRUCTIONS).toBe(SEND_OVERHEAD_INSTRUCTIONS);
    expect(issuerAuthority.TRANSACTION_SIZE_LIMIT).toBe(TRANSACTION_SIZE_LIMIT);
    expect(issuerAuthority.transactionSize).toBe(transactionSize);
    expect(SEND_OVERHEAD_INSTRUCTIONS.map((i) => [...i.data!])).toEqual([[2, 0, 0, 0, 0], [3, 0, 0, 0, 0, 0, 0, 0, 0]]);
  });

  it("vestingTransactionBytes is byte-identical to the former hand-built placeholder", () => {
    const signer = createNoopSigner(PAYER);
    const legacyBytes = (instructions: readonly Instruction[]) => {
      const limit = new Uint8Array(5);
      limit[0] = 2;
      new DataView(limit.buffer).setUint32(1, VESTING_COMPUTE_UNITS, true);
      const price = new Uint8Array(9);
      price[0] = 3;
      const message = appendTransactionMessageInstructions(
        [{ programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: limit }, { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: price }, ...instructions],
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: BigInt(1) },
          setTransactionMessageFeePayerSigner(signer, createTransactionMessage({ version: 0 })),
        ),
      );
      return getTransactionEncoder().encode(compileTransaction(message));
    };
    for (const size of [0, 100, 900]) {
      const ixs = [{ programAddress: PROGRAM, data: new Uint8Array(size) }];
      expect(vestingTransactionBytes(ixs, signer)).toBe(legacyBytes(ixs).length);
    }
  });

  it("the chain CLI prepends the same limit/price bytes (digest-neutral), and no price at 0", async () => {
    const payer = createNoopSigner(PAYER);
    const lifetime = { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: BigInt(9) };
    const ixs = [{ programAddress: PROGRAM, data: new Uint8Array([7]) }];
    const decode = (m: ReturnType<typeof buildMessage>) =>
      getCompiledTransactionMessageDecoder().decode(compileTransaction(m).messageBytes);
    const withBudget = decode(buildMessage({ feePayer: payer, ixs, blockhash: lifetime, cuLimit: 60_000, cuPrice: BigInt(2_000_000) }));
    expect(withBudget.instructions.map((i) => [...(i.data ?? [])])).toEqual([
      [2, ...u32(60_000)],
      [3, ...u64(BigInt(2_000_000))],
      [7],
    ]);
    expect(withBudget.staticAccounts[withBudget.instructions[0].programAddressIndex]).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
    const noPrice = decode(buildMessage({ feePayer: payer, ixs, blockhash: lifetime, cuLimit: 60_000, cuPrice: BigInt(0) }));
    expect(noPrice.instructions).toHaveLength(2);
  });
});
