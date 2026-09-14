import { expect, it } from "vitest";
import { address, getAddressDecoder } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { findDistributionPda } from "@/lib/generated/asset_registry";
import {
  canonicalDistributionPlan,
  distributionBatchLeaf,
  distributionPlanHex,
  assertStoredDistributionPlan,
  type DistributionPlanContext,
} from "@/lib/distribution-plans";
import { merkleRoot, merkleProof } from "@/lib/merkle";
const decoder = getAddressDecoder(),
  key = (value: number) => {
    const bytes = new Uint8Array(32);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return decoder.decode(bytes);
  };
async function fixture(count = 13) {
  const shareClass = key(10),
    mint = key(11),
    funder = key(12),
    tokenProgram = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    [distribution] = await findDistributionPda({
      shareClass,
      distributionId: BigInt(17),
    });
  const context: DistributionPlanContext = {
    distribution_pda: distribution,
    distribution_id: "17",
    share_class: shareClass,
    payment_mint: mint,
    payment_token_program: tokenProgram,
    funder,
    total_amount: String(count * 10),
    snapshot_supply: String(count),
  };
  const entries = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const owner = key(i + 100);
      const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
      return { token_owner: owner, token_account: ata, amount: "10" };
    }),
  );
  return { context, entries };
}
it("matches the independent Rust distribution leaf test vector", async () => {
  const pub = (byte: number) => decoder.decode(new Uint8Array(32).fill(byte));
  expect(
    distributionPlanHex(
      await distributionBatchLeaf(pub(1), 7, [
        { token_account: pub(2), token_owner: pub(3), amount: "123456789" },
      ]),
    ),
  ).toBe("f8d967fd84e54ba2e0624890519fbfd22f099a958aebc852dc8c572b3bcf9e8c");
});
it("commits deterministic ordered batches before funding and cached proofs match the independent Merkle helper", async () => {
  const f = await fixture(),
    plan = await canonicalDistributionPlan(f.context, f.entries);
  expect(plan.batch_count).toBe(3);
  expect(plan.batches.map((b) => b.entries.length)).toEqual([6, 6, 1]);
  expect(
    await canonicalDistributionPlan(f.context, [...f.entries].reverse()),
  ).toEqual(plan);
  const leaves = await Promise.all(
    plan.batches.map((batch) =>
      distributionBatchLeaf(
        address(plan.distribution_pda),
        batch.batch_id,
        batch.entries,
      ),
    ),
  );
  expect(plan.root_hex).toBe(distributionPlanHex(await merkleRoot(leaves)));
  for (const b of plan.batches)
    expect(b.proof).toEqual(
      (await merkleProof(leaves, b.batch_id)).map(distributionPlanHex),
    );
  await assertStoredDistributionPlan(plan);
});
it("rejects swapped amount/owner/account context, duplicate recipients and overfunding", async () => {
  const f = await fixture(),
    plan = await canonicalDistributionPlan(f.context, f.entries);
  await expect(
    canonicalDistributionPlan(f.context, [...f.entries, f.entries[0]]),
  ).rejects.toThrow("unique");
  await expect(
    canonicalDistributionPlan(f.context, [
      { ...f.entries[0], amount: "999999" },
    ]),
  ).rejects.toThrow("equal");
  await expect(
    canonicalDistributionPlan({...f.context,total_amount:"10"}, [
      { ...f.entries[0], token_account: f.entries[1].token_account },
    ]),
  ).rejects.toThrow("ATA");
  await expect(
    canonicalDistributionPlan(
      { ...f.context, distribution_id: "18" },
      f.entries,
    ),
  ).rejects.toThrow("PDA");
  await expect(
    canonicalDistributionPlan(f.context, [
      { ...f.entries[0], amount: 10 as unknown as string },
    ]),
  ).rejects.toThrow("canonical u64");
  await expect(
    assertStoredDistributionPlan({
      ...plan,
      batches: plan.batches.map((batch, i) =>
        i ? batch : { ...batch, entries: [...batch.entries].reverse() },
      ),
    }),
  ).rejects.toThrow("immutable");
});
it("supports the bounded 5000-recipient plan without quadratic proof rebuilds", async () => {
  const f = await fixture(5000),
    plan = await canonicalDistributionPlan(f.context, f.entries);
  expect(plan.batch_count).toBe(834);
  expect(Math.max(...plan.batches.map((b) => b.proof.length))).toBe(10);
  expect(plan.allocated_amount).toBe("50000");
}, 15_000);
