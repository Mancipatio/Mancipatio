// lib/distributions.ts — pro-rata BigInt math and the weight CSV parser.
// computeProRata feeds `distribute_batch` directly, so the invariants here
// (never over-allocate, deterministic order, dust exclusion) are load-bearing.
import { describe, expect, it } from "vitest";
import { computeProRata, parseWeightCsv } from "@/lib/distributions";

const W1 = "11111111111111111111111111111111";
const W2 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const W3 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

describe("computeProRata", () => {
  it("splits an exactly-divisible amount fully", () => {
    const res = computeProRata(
      [
        { wallet: W1, weight: BigInt(1) },
        { wallet: W2, weight: BigInt(3) },
      ],
      BigInt(400),
    );
    expect(res.totalWeight).toBe(BigInt(4));
    expect(res.allocated).toBe(BigInt(400));
    expect(res.skipped).toEqual([]);
    const byWallet = Object.fromEntries(res.eligible.map((r) => [r.wallet, r.amount]));
    expect(byWallet[W1]).toBe(BigInt(100));
    expect(byWallet[W2]).toBe(BigInt(300));
  });

  it("floors and never over-allocates; the dust remainder stays unallocated", () => {
    const rows = [
      { wallet: W1, weight: BigInt(1) },
      { wallet: W2, weight: BigInt(1) },
      { wallet: W3, weight: BigInt(1) },
    ];
    const res = computeProRata(rows, BigInt(100));
    // 100/3 → 33 each, 1 unit of dust remains for close_distribution to refund.
    expect(res.eligible.every((r) => r.amount === BigInt(33))).toBe(true);
    expect(res.allocated).toBe(BigInt(99));
    expect(res.allocated <= BigInt(100)).toBe(true);
  });

  it("moves zero-amount (dust) holders into skipped — distribute_batch rejects them", () => {
    const res = computeProRata(
      [
        { wallet: W1, weight: BigInt(1) }, // 1/1001 of 1000 → floor 0
        { wallet: W2, weight: BigInt(1000) },
      ],
      BigInt(1000),
    );
    expect(res.skipped.map((r) => r.wallet)).toEqual([W1]);
    expect(res.skipped[0].amount).toBe(BigInt(0));
    expect(res.eligible.map((r) => r.wallet)).toEqual([W2]);
    expect(res.allocated).toBe(BigInt(999));
  });

  it("returns rows sorted by wallet regardless of input order (resume safety)", () => {
    const shuffled = [
      { wallet: W3, weight: BigInt(5) },
      { wallet: W1, weight: BigInt(5) },
      { wallet: W2, weight: BigInt(5) },
    ];
    const res = computeProRata(shuffled, BigInt(300));
    const wallets = res.eligible.map((r) => r.wallet);
    expect(wallets).toEqual([...wallets].sort());
    // Deterministic across input permutations.
    const res2 = computeProRata([...shuffled].reverse(), BigInt(300));
    expect(res2.eligible).toEqual(res.eligible);
  });

  it("handles zero total weight without dividing by zero", () => {
    const res = computeProRata([{ wallet: W1, weight: BigInt(0) }], BigInt(1000));
    expect(res.totalWeight).toBe(BigInt(0));
    expect(res.eligible).toEqual([]);
    expect(res.allocated).toBe(BigInt(0));
  });

  it("survives amounts beyond Number precision (pure BigInt path)", () => {
    const total = BigInt("123456789012345678901"); // > 2^64
    const res = computeProRata(
      [
        { wallet: W1, weight: BigInt(2) },
        { wallet: W2, weight: BigInt(1) },
      ],
      total,
    );
    expect(res.allocated).toBe((total * BigInt(2)) / BigInt(3) + total / BigInt(3));
    expect(res.allocated <= total).toBe(true);
  });
});

describe("parseWeightCsv", () => {
  it("parses rows, skips a header, and sums duplicate wallets", () => {
    const { rows, errors } = parseWeightCsv(
      `wallet,weight\n${W1},100\n${W2},50\n${W1},25\n`,
    );
    expect(errors).toEqual([]);
    const byWallet = Object.fromEntries(rows.map((r) => [r.wallet, r.weight]));
    expect(byWallet[W1]).toBe(BigInt(125));
    expect(byWallet[W2]).toBe(BigInt(50));
  });

  it("reports invalid addresses and non-integer weights with line numbers", () => {
    // NB: the string "wallet" must not appear in line 1 or it reads as a header.
    const { rows, errors } = parseWeightCsv(`zzz-not-base58,100\n${W1},12.5\n${W2},10`);
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain("Line 1");
    expect(errors[1]).toContain("Line 2");
    expect(rows).toEqual([{ wallet: W2, weight: BigInt(10) }]);
  });

  it("drops zero-weight rows and rejects negatives", () => {
    const { rows, errors } = parseWeightCsv(`${W1},0\n${W2},-5`);
    expect(rows).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("negative");
  });
});
