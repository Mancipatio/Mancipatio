import {
  address,
  AccountRole,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeDistribution,
  fetchMaybeDistributionPlan,
  fetchMaybeDistributionBatch,
  fetchAllMaybeDistributionBatch,
  fetchMaybeShareClass,
  findEscrowPda,
  getCreateDistributionInstructionAsync,
  getDistributeBatchInstructionAsync,
  DistributionStatus,
} from "@/lib/generated/asset_registry";
import {
  assertStoredDistributionPlan,
  distributionBatchPda,
  distributionPlanPda,
  distributionPlanBytes,
  distributionPlanHex,
  type PreparedDistributionPlan,
  type DistributionPlanBatch,
} from "@/lib/distribution-plans";
import { fetchPlainPaymentMintTokenProgram } from "@/lib/transaction-builders";
import { vestingTransactionBytes } from "@/lib/vesting-creation";
type Rpc = Parameters<typeof fetchPlainPaymentMintTokenProgram>[0];
const options = { commitment: "finalized" as const };
const verifiedPlans = new WeakSet<PreparedDistributionPlan>();
async function verifyAndFreezePlan(plan: PreparedDistributionPlan) {
  if (verifiedPlans.has(plan)) return;
  await assertStoredDistributionPlan(plan);
  for (const batch of plan.batches) {
    for (const entry of batch.entries) Object.freeze(entry);
    Object.freeze(batch.entries);
    Object.freeze(batch.proof);
    Object.freeze(batch);
  }
  Object.freeze(plan.batches);
  Object.freeze(plan);
  verifiedPlans.add(plan);
}
export async function readCommittedDistribution(
  rpc: Rpc,
  plan: PreparedDistributionPlan,
) {
  await verifyAndFreezePlan(plan);
  const distribution = address(plan.distribution_pda),
    planPda = await distributionPlanPda(distribution),
    [escrow] = await findEscrowPda({ distribution });
  const [d, p] = await Promise.all([
    fetchMaybeDistribution(rpc, distribution, options),
    fetchMaybeDistributionPlan(rpc, planPda, options),
  ]);
  if (!d.exists && !p.exists) return null;
  if (
    !d.exists ||
    !p.exists ||
    d.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    p.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    d.data.version !== 2 ||
    p.data.version !== 1 ||
    p.data.distribution !== distribution ||
    distributionPlanHex(Uint8Array.from(p.data.batchRoot)) !== plan.root_hex ||
    p.data.batchCount !== plan.batch_count ||
    d.data.distributionId !== BigInt(plan.distribution_id) ||
    d.data.shareClass !== plan.share_class ||
    d.data.paymentMint !== plan.payment_mint ||
    d.data.funder !== plan.funder ||
    d.data.totalAmount !== BigInt(plan.total_amount) ||
    d.data.snapshotSupply !== BigInt(plan.snapshot_supply) ||
    d.data.escrow !== escrow
  )
    throw new Error(
      "The on-chain distribution does not match its saved funded plan",
    );
  return d.data;
}
export async function isDistributionBatchPaid(
  rpc: Rpc,
  plan: PreparedDistributionPlan,
  batch: DistributionPlanBatch,
) {
  const distribution = address(plan.distribution_pda),
    pda = await distributionBatchPda(distribution, batch.batch_id),
    info = await fetchMaybeDistributionBatch(rpc, pda, options);
  return validReceipt(info, plan, batch);
}
function validReceipt(
  info: Awaited<ReturnType<typeof fetchMaybeDistributionBatch>>,
  plan: PreparedDistributionPlan,
  batch: DistributionPlanBatch,
) {
  const distribution = address(plan.distribution_pda);
  if (!info.exists) return false;
  const total = batch.entries.reduce(
    (sum, entry) => sum + BigInt(entry.amount),
    BigInt(0),
  );
  if (
    info.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    info.data.version !== 1 ||
    info.data.distribution !== distribution ||
    info.data.batchId !== batch.batch_id ||
    distributionPlanHex(Uint8Array.from(info.data.batchHash)) !==
      batch.leaf_hex ||
    info.data.totalAmount !== total ||
    info.data.paidCount !== batch.entries.length
  )
    throw new Error(
      "A distribution receipt differs from the committed batch; stop and reconcile",
    );
  return true;
}
export async function readPaidDistributionBatches(
  rpc: Rpc,
  plan: PreparedDistributionPlan,
) {
  await verifyAndFreezePlan(plan);
  const paid: number[] = [];
  for (let start = 0; start < plan.batches.length; start += 100) {
    const batches = plan.batches.slice(start, start + 100),
      pdas = await Promise.all(
        batches.map((batch) =>
          distributionBatchPda(address(plan.distribution_pda), batch.batch_id),
        ),
      );
    const infos = await fetchAllMaybeDistributionBatch(rpc, pdas, options);
    infos.forEach((info, index) => {
      if (validReceipt(info, plan, batches[index]))
        paid.push(batches[index].batch_id);
    });
  }
  return paid;
}
export async function buildDistributionFunding(
  rpc: Rpc,
  plan: PreparedDistributionPlan,
  signer: TransactionSigner,
) {
  await verifyAndFreezePlan(plan);
  if (plan.funder !== signer.address)
    throw new Error("Connect the saved plan's funder wallet");
  const tokenProgram = await fetchPlainPaymentMintTokenProgram(
    rpc,
    address(plan.payment_mint),
    options,
  );
  if (tokenProgram !== plan.payment_token_program)
    throw new Error("Payment token program differs from the prepared plan");
  const sc = await fetchMaybeShareClass(
    rpc,
    address(plan.share_class),
    options,
  );
  if (
    !sc.exists ||
    sc.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    sc.data.version !== 2 ||
    !sc.data.mintInitialized
  )
    throw new Error("A verified v2 share class is required");
  const [funderPaymentAccount] = await findAssociatedTokenPda({
      owner: signer.address,
      mint: address(plan.payment_mint),
      tokenProgram,
    }),
    distribution = address(plan.distribution_pda);
  const ix = await getCreateDistributionInstructionAsync({
    authority: signer,
    funder: signer,
    shareClass: address(plan.share_class),
    mint: sc.data.mint,
    paymentMint: address(plan.payment_mint),
    distribution,
    plan: await distributionPlanPda(distribution),
    funderPaymentAccount,
    paymentTokenProgram: tokenProgram,
    distributionId: BigInt(plan.distribution_id),
    totalAmount: BigInt(plan.total_amount),
    snapshotSupply: BigInt(plan.snapshot_supply),
    batchRoot: distributionPlanBytes(plan.root_hex),
    batchCount: plan.batch_count,
  });
  if (vestingTransactionBytes([ix], signer) > 1232)
    throw new Error(
      "Prepared funding transaction exceeds the wallet packet limit",
    );
  return ix;
}
export async function buildDistributionPayment(
  rpc: Rpc,
  plan: PreparedDistributionPlan,
  batch: DistributionPlanBatch,
  signer: TransactionSigner,
) {
  const d = await readCommittedDistribution(rpc, plan);
  if (!d || d.status !== DistributionStatus.Distributing)
    throw new Error("Distribution must be funded and distributing");
  const expected = plan.batches[batch.batch_id];
  if (!expected || JSON.stringify(expected) !== JSON.stringify(batch))
    throw new Error("Batch does not belong to the saved plan");
  const tokenProgram = await fetchPlainPaymentMintTokenProgram(
    rpc,
    address(plan.payment_mint),
    options,
  );
  if (tokenProgram !== plan.payment_token_program)
    throw new Error("Payment token program changed");
  const distribution = address(plan.distribution_pda),
    base = await getDistributeBatchInstructionAsync({
      authority: signer,
      distribution,
      paymentMint: d.paymentMint,
      escrow: d.escrow,
      paymentTokenProgram: tokenProgram,
      distributionId: d.distributionId,
      plan: await distributionPlanPda(distribution),
      batch: await distributionBatchPda(distribution, batch.batch_id),
      batchId: batch.batch_id,
      amounts: batch.entries.map((e) => BigInt(e.amount)),
      proof: batch.proof.map(distributionPlanBytes),
    });
  const payment: Instruction = {
    ...base,
    accounts: [
      ...base.accounts,
      ...batch.entries.map((e) => ({
        address: address(e.token_account),
        role: AccountRole.WRITABLE,
      })),
    ],
  };
  const prepare = await Promise.all(
    batch.entries.map((entry) =>
      getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: signer,
        owner: address(entry.token_owner),
        mint: d.paymentMint,
        tokenProgram,
      }),
    ),
  );
  const combined = [...prepare, payment];
  if (vestingTransactionBytes(combined, signer) <= 1232)
    return { preparation: [] as Instruction[][], payment: combined };
  if (
    vestingTransactionBytes([payment], signer) > 1232 ||
    vestingTransactionBytes(prepare, signer) > 1232
  )
    throw new Error(
      "Saved batch exceeds the wallet packet limit; do not alter its recipients",
    );
  return { preparation: [prepare], payment: [payment] };
}
