import { describe, expect, it, vi, beforeEach } from "vitest";
import { address, createNoopSigner, getAddressDecoder } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
const mocks = vi.hoisted(() => ({
  distribution: vi.fn(),
  plan: vi.fn(),
  batch: vi.fn(),
  allBatches: vi.fn(),
  share: vi.fn(),
  inspect: vi.fn(),
  network: "devnet" as "devnet" | "mainnet",
}));
vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => mocks.network,
}));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMaybeDistribution: mocks.distribution,
  fetchMaybeDistributionPlan: mocks.plan,
  fetchMaybeDistributionBatch: mocks.batch,
  fetchAllMaybeDistributionBatch: mocks.allBatches,
  fetchMaybeShareClass: mocks.share,
}));
vi.mock("@/lib/transaction-builders", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchPlainPaymentMintTokenProgram: async () =>
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  inspectPaymentMint: mocks.inspect,
}));
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findDistributionPda,
  findEscrowPda,
  findPlatformPda,
  getDistributeBatchInstructionDataDecoder,
  DistributionStatus,
} from "@/lib/generated/asset_registry";
import {
  canonicalDistributionPlan,
  distributionPlanBytes,
  type PreparedDistributionPlan,
} from "@/lib/distribution-plans";
import {
  readCommittedDistribution,
  buildDistributionFunding,
  buildDistributionClose,
  buildDistributionPayment,
  isDistributionBatchPaid,
  readPaidDistributionBatches,
} from "@/lib/distribution-transactions";
import { vestingTransactionBytes } from "@/lib/vesting-creation";
import { computeDistributionAllocation } from "@/lib/distributions";
const key = (n: number) => {
    const bytes = new Uint8Array(32);
    new DataView(bytes.buffer).setUint32(0, n, true);
    return getAddressDecoder().decode(bytes);
  },
  program = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  rpc = {} as Parameters<typeof readCommittedDistribution>[0];
async function fixture(count = 13) {
  const signer = createNoopSigner(key(1)),
    share = key(2),
    payment = key(3),
    [distribution] = await findDistributionPda({
      shareClass: share,
      distributionId: BigInt(7),
    }),
    [escrow] = await findEscrowPda({ distribution });
  const entries = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const owner = key(i + 100),
        [ata] = await findAssociatedTokenPda({
          owner,
          mint: payment,
          tokenProgram: program,
        });
      return { token_account: ata, token_owner: owner, amount: "100" };
    }),
  );
  const canonical = await canonicalDistributionPlan(
    {
      distribution_pda: distribution,
      distribution_id: "7",
      share_class: share,
      payment_mint: payment,
      payment_token_program: program,
      funder: signer.address,
      total_amount: String(count * 100),
      snapshot_supply: String(count),
    },
    entries,
  );
  const plan: PreparedDistributionPlan = {
    ...canonical,
    id: "id",
    network: "devnet",
    status: "bound",
    bound_slot: "10",
  };
  const d = {
    version: 2,
    distributionId: BigInt(7),
    shareClass: share,
    mint: key(4),
    paymentMint: payment,
    funder: signer.address,
    totalAmount: BigInt(count * 100),
    snapshotSupply: BigInt(count),
    escrow,
    status: DistributionStatus.Distributing,
  };
  mocks.distribution.mockResolvedValue({
    exists: true,
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: d,
  });
  mocks.plan.mockResolvedValue({
    exists: true,
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: {
      version: 1,
      distribution,
      batchRoot: distributionPlanBytes(plan.root_hex),
      batchCount: plan.batch_count,
    },
  });
  mocks.share.mockResolvedValue({
    exists: true,
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: { version: 2, mintInitialized: true, mint: key(4) },
  });
  mocks.batch.mockResolvedValue({ exists: false });
  mocks.allBatches.mockImplementation(async (_rpc, addresses) =>
    addresses.map(() => ({ exists: false })),
  );
  return { plan, signer, d };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.network = "devnet";
  mocks.inspect.mockResolvedValue({ owner: program, decimals: 6 });
});
describe("distribution v2 real builders and receipts", () => {
  it("keeps the full 5000-recipient plan's longest proof payment within1232bytes, with separate idempotent ATA preparation", async () => {
    const f = await fixture(5000),
      batch = f.plan.batches.find((b) => b.proof.length === 10)!;
    const built = await buildDistributionPayment(rpc, f.plan, batch, f.signer);
    expect(built.preparation.length).toBe(1);
    expect(
      vestingTransactionBytes(built.payment, f.signer),
    ).toBeLessThanOrEqual(1232);
    expect(
      vestingTransactionBytes(built.preparation[0], f.signer),
    ).toBeLessThanOrEqual(1232);
    const ix = built.payment[0],
      decoded = getDistributeBatchInstructionDataDecoder().decode(ix.data!);
    expect(decoded.batchId).toBe(batch.batch_id);
    expect(decoded.amounts.map(String)).toEqual(
      batch.entries.map((e) => e.amount),
    );
    // 9 named accounts + the Platform pause gate, then the recipients.
    expect(ix.accounts?.[9].address).toBe((await findPlatformPda())[0]);
    expect(ix.accounts?.slice(10).map((a) => a.address)).toEqual(
      batch.entries.map((e) => e.token_account),
    );
    const funding = await buildDistributionFunding(rpc, f.plan, f.signer);
    expect(vestingTransactionBytes([funding], f.signer)).toBeLessThanOrEqual(
      1232,
    );
    // Building 5000 recipients takes 8–15 s on shared CI runners; 60 s keeps
    // the size assertion from timing out without masking a real regression.
  }, 60_000);
  it("resumes only exact receipt identities, never paid-count offsets or newly scanned holders", async () => {
    const f = await fixture(),
      batch = f.plan.batches[1];
    expect(await isDistributionBatchPaid(rpc, f.plan, batch)).toBe(false);
    const receipt = {
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: {
        version: 1,
        distribution: address(f.plan.distribution_pda),
        batchId: batch.batch_id,
        batchHash: distributionPlanBytes(batch.leaf_hex),
        paidCount: batch.entries.length,
        totalAmount: BigInt(batch.entries.length * 100),
      },
    };
    mocks.batch.mockResolvedValue(receipt);
    expect(await isDistributionBatchPaid(rpc, f.plan, batch)).toBe(true);
    mocks.batch.mockResolvedValue({
      ...receipt,
      data: { ...receipt.data, batchId: 0 },
    });
    await expect(isDistributionBatchPaid(rpc, f.plan, batch)).rejects.toThrow(
      "differs",
    );
    mocks.allBatches.mockResolvedValue([
      { exists: false },
      receipt,
      { exists: false },
    ]);
    expect(await readPaidDistributionBatches(rpc, f.plan)).toEqual([1]);
  });
  it("rejects substituted commitment and another funding wallet before building a payment", async () => {
    const f = await fixture();
    mocks.plan.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: {
        version: 1,
        distribution: address(f.plan.distribution_pda),
        batchRoot: new Uint8Array(32),
        batchCount: f.plan.batch_count,
      },
    });
    await expect(readCommittedDistribution(rpc, f.plan)).rejects.toThrow(
      "does not match",
    );
    await expect(
      buildDistributionFunding(rpc, f.plan, createNoopSigner(key(77))),
    ).rejects.toThrow("funder wallet");
  });
  it("funding is an entry path: the payment mint passes the entry check for this network", async () => {
    const f = await fixture();
    await buildDistributionFunding(rpc, f.plan, f.signer);
    expect(mocks.inspect).toHaveBeenCalledWith(
      rpc,
      f.plan.payment_mint,
      "devnet",
      expect.objectContaining({ commitment: "finalized" }),
    );
    // On mainnet the real entry check refuses a non-allowlisted mint before
    // any RPC read, and nothing is built.
    mocks.network = "mainnet";
    const real = (await vi.importActual<typeof import("@/lib/transaction-builders")>(
      "@/lib/transaction-builders",
    )).inspectPaymentMint;
    mocks.inspect.mockImplementationOnce(real);
    await expect(
      buildDistributionFunding(rpc, f.plan, f.signer),
    ).rejects.toThrow(/not an allowed payment token on mainnet/);
    // A token program other than the one the plan saved is refused.
    mocks.inspect.mockResolvedValueOnce({
      owner: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
      decimals: 6,
    });
    await expect(
      buildDistributionFunding(rpc, f.plan, f.signer),
    ).rejects.toThrow(/differs from the prepared plan/);
  });
  it("allocates every base unit by largest remainder with deterministic wallet tie breaks", () => {
    const rows = [
      { wallet: "c", weight: BigInt(1) },
      { wallet: "a", weight: BigInt(1) },
      { wallet: "b", weight: BigInt(1) },
    ];
    const result = computeDistributionAllocation(rows, BigInt(5));
    expect(result.eligible.map((r) => [r.wallet, String(r.amount)])).toEqual([
      ["a", "2"],
      ["b", "2"],
      ["c", "1"],
    ]);
    expect(result.allocated).toBe(BigInt(5));
    expect(
      computeDistributionAllocation(rows, BigInt(1)).eligible.map(
        (r) => r.wallet,
      ),
    ).toEqual(["a"]);
  });
});

describe("close_distribution (2D rent recipient)", () => {
  it("refunds the remainder to the funder's ATA and sends all rent to distribution.admin", async () => {
    const closer = createNoopSigner(key(40)),
      admin = key(41),
      funder = key(42),
      paymentMint = key(43),
      escrow = key(44),
      distribution = key(45);
    const [create, close] = await buildDistributionClose({
      authority: closer,
      distribution,
      data: { admin, funder, paymentMint, escrow },
      tokenProgram: program,
    });
    const [refund] = await findAssociatedTokenPda({
      owner: funder,
      mint: paymentMint,
      tokenProgram: program,
    });
    expect(create.accounts?.find((a) => a.address === refund)).toBeDefined();
    // authority, admin_record, distribution, payment_mint, escrow,
    // refund_account, escrow_rent_recipient, escrow_marker, payment_token_program
    const accounts = close.accounts!;
    expect(accounts[0].address).toBe(closer.address);
    expect(accounts[5].address).toBe(refund);
    expect(accounts[6].address).toBe(admin);
    expect(accounts.some((a) => a.address === funder)).toBe(false);
  });
});
