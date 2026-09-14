import { describe, it, expect } from "vitest";
import { address, createNoopSigner, getBase58Decoder } from "@solana/kit";
import {
  findSeriesPda,
  findCreateVestingSeriesEscrowPda,
  findPositionPda,
  VestingSeriesStatus,
  VestingTimingMode,
  VestingDeliveryMode,
  type VestingSeries,
  type VestingPosition,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
} from "@/lib/generated/asset_registry";
import {
  assertVestingPosition,
  assertVestingSeriesTerms,
  assertVestingStepTransaction,
  buildVestingCreationSteps,
  vestingTransactionBytes,
  type VestingCreationIntent,
} from "@/lib/vesting-creation";
import {
  hashVestingTerms,
  assertSupportedVestingTerms,
} from "@/lib/vesting-terms";
import { TOKEN_CLASSIC, TOKEN_2022 } from "@/lib/transaction-builders";
import type { ChainTransaction } from "@/lib/chain-evidence";
const key = (n: number) =>
  address(getBase58Decoder().decode(new Uint8Array(32).fill(n)));
async function intent(
  count = 10,
  tranches = 2,
): Promise<VestingCreationIntent> {
  const authority = key(1);
  const seriesId = "18446744073709551615";
  const [series] = await findSeriesPda({
    authority,
    seriesId: BigInt(seriesId),
  });
  const [escrow] = await findCreateVestingSeriesEscrowPda({ series });
  const row: VestingCreationIntent = {
    id: "10000000-0000-4000-8000-000000000001",
    network: "devnet",
    client_wallet: authority,
    token_mint: key(2),
    token_label: "Token",
    timing_mode: "auto",
    delivery_mode: "claim",
    approval_window_secs: 0,
    recovery_enabled: true,
    cancellation_enabled: true,
    pre_cliff_bps: 500,
    schedule: Array.from({ length: tranches }, (_, i) => ({
      unlock_ts: 2000000000 + i,
      amount: String(count),
    })),
    recipients: Array.from({ length: count }, (_, i) => ({
      wallet: key(i + 3),
      allocation: String(tranches),
    })),
    series_id: seriesId,
    series_pda: series,
    escrow,
    approved_terms_hash: null,
    creation_terms_hash: null,
  };
  row.approved_terms_hash = await hashVestingTerms(row);
  row.creation_terms_hash = row.approved_terms_hash;
  return row;
}
function series(
  row: VestingCreationIntent,
  count = row.recipients.length,
  status = VestingSeriesStatus.Draft,
): VestingSeries {
  return {
    discriminator: new Uint8Array(8),
    authority: address(row.client_wallet),
    tokenMint: address(row.token_mint),
    escrow: address(row.escrow!),
    seriesId: BigInt(row.series_id!),
    totalAllocated: row.recipients
      .slice(0, count)
      .reduce((n, r) => n + BigInt(r.allocation), BigInt(0)),
    deposited: BigInt(0),
    totalReleased: BigInt(0),
    timingMode: VestingTimingMode.Auto,
    deliveryMode: VestingDeliveryMode.Claim,
    status,
    approvalWindowSecs: BigInt(0),
    recoveryEnabled: true,
    cancellationEnabled: true,
    preCliffBps: 500,
    approvedMask: BigInt(0),
    cancelledAt: BigInt(0),
    finalCumulative: BigInt(0),
    positionsCount: count,
    createdAt: BigInt(100),
    version: 2,
    bump: 1,
    tranches: row.schedule.map((t) => ({
      unlockTs: BigInt(t.unlock_ts),
      amount: BigInt(t.amount),
    })),
  };
}
describe("approved vesting terms", () => {
  it("hashes normalized amounts but binds all economic fields, authority, network and recipient order", async () => {
    const row = await intent();
    const baseline = await hashVestingTerms(row);
    expect(
      await hashVestingTerms({
        ...row,
        schedule: row.schedule.map((t) => ({ ...t, amount: `0${t.amount}` })),
      }),
    ).toBe(baseline);
    for (const changed of [
      { network: "mainnet" },
      { client_wallet: key(9) },
      { pre_cliff_bps: 501 },
      { recovery_enabled: false },
      { cancellation_enabled: false },
      { approval_window_secs: 3600 },
      { delivery_mode: "push" as const },
      { timing_mode: "approval" as const },
      { recipients: [...row.recipients].reverse() },
      {
        schedule: row.schedule.map((t, i) => ({
          ...t,
          unlock_ts: t.unlock_ts + (i === 1 ? 1 : 0),
        })),
      },
    ])
      expect(await hashVestingTerms({ ...row, ...changed })).not.toBe(baseline);
  });
  it("rejects unsupported schedules, elapsed starts and aggregate u64 overflow", async () => {
    const row = await intent();
    expect(() => assertSupportedVestingTerms(row, 2000000000)).toThrow(
      /first unlock/,
    );
    const huge = {
      ...row,
      schedule: [
        { unlock_ts: 2000000000, amount: "18446744073709551615" },
        { unlock_ts: 2000000001, amount: "1" },
      ],
      recipients: [
        { wallet: key(3), allocation: "18446744073709551615" },
        { wallet: key(4), allocation: "1" },
      ],
    };
    expect(() => assertSupportedVestingTerms(huge)).toThrow(/u64/);
    const tooMany = await intent(1, 64);
    expect(() => assertSupportedVestingTerms(tooMany)).toThrow(/48/);
  });
  it("rejects draft completion, altered terms and incomplete/mutated positions", async () => {
    const row = await intent();
    expect(() => assertVestingSeriesTerms(row, series(row), true)).toThrow(
      /finalized/,
    );
    const active = series(row, 10, VestingSeriesStatus.Active);
    expect(() => assertVestingSeriesTerms(row, active, true)).not.toThrow();
    for (const change of [
      { approvalWindowSecs: BigInt(1) },
      { recoveryEnabled: false },
      { cancellationEnabled: false },
      { preCliffBps: 0 },
      { escrow: key(20) },
      { tokenMint: key(20) },
      { totalAllocated: BigInt(999) },
      { positionsCount: 11 },
      { version: 1 },
    ])
      expect(() =>
        assertVestingSeriesTerms(row, { ...active, ...change }, true),
      ).toThrow();
    const p = {
      series: address(row.series_pda!),
      index: 0,
      wallet: address(row.recipients[0].wallet),
      allocation: BigInt(row.recipients[0].allocation),
      released: BigInt(0),
      version: 2,
      bump: 1,
      discriminator: new Uint8Array(8),
    } satisfies VestingPosition;
    expect(() => assertVestingPosition(row, p, 0)).not.toThrow();
    expect(() =>
      assertVestingPosition(row, { ...p, wallet: key(99) }, 0),
    ).toThrow();
    expect(() => assertVestingPosition(row, p, 1)).toThrow();
  });
});
describe("actual generated vesting transaction batches", () => {
  it.each([TOKEN_CLASSIC, TOKEN_2022])(
    "sizes 48-tranche creation and all 200 recipients below 1232 bytes (%s)",
    async (tokenProgram) => {
      const row = await intent(200, 48),
        signer = createNoopSigner(address(row.client_wallet));
      const steps = await buildVestingCreationSteps(row, tokenProgram, signer);
      expect(steps[0].kind).toBe("create");
      expect(steps[0].instructions).toHaveLength(1);
      expect(steps[0].instructions[0].accounts![4].address).toBe(tokenProgram);
      expect(steps.at(-1)!.kind).toBe("finalize");
      for (const step of steps) {
        expect(step.bytes).toBe(
          vestingTransactionBytes(step.instructions, signer),
        );
        expect(step.bytes).toBeLessThanOrEqual(1232);
      }
      expect(
        steps.flatMap((s) => (s.kind === "positions" ? s.instructions : [])),
      ).toHaveLength(200);
    },
  );
  it("resumes each completed prefix using identical position PDAs and finalizes exactly once", async () => {
    const row = await intent(19),
      all = await buildVestingCreationSteps(row, TOKEN_2022);
    for (const start of [0, 3, 8, 16, 19]) {
      const resumed = await buildVestingCreationSteps(
        row,
        TOKEN_2022,
        undefined,
        series(row, start),
      );
      expect(resumed.some((s) => s.kind === "create")).toBe(false);
      const adds = resumed
        .filter((s) => s.kind === "positions")
        .flatMap((s) => s.instructions);
      expect(adds).toHaveLength(19 - start);
      if (adds.length)
        expect(adds[0].accounts![2].address).toBe(
          (
            await findPositionPda({
              series: address(row.series_pda!),
              positionIndex: start,
            })
          )[0],
        );
      expect(resumed.at(-1)!.kind).toBe("finalize");
    }
    expect(all[0].kind).toBe("create");
    expect(
      await buildVestingCreationSteps(
        row,
        TOKEN_2022,
        undefined,
        series(row, 19, VestingSeriesStatus.Active),
      ),
    ).toEqual([]);
  });
  it("validates the exact finalization instruction and signer, not mere account presence", async () => {
    const row = await intent(),
      steps = await buildVestingCreationSteps(row, TOKEN_2022);
    const expected = steps.at(-1)!.instructions;
    const keys = [
      row.client_wallet,
      row.series_pda!,
      ASSET_REGISTRY_PROGRAM_ADDRESS,
    ];
    const sig = "1".repeat(64);
    const tx: ChainTransaction = {
      slot: 1,
      transaction: {
        signatures: [sig],
        message: {
          header: { numRequiredSignatures: 1 },
          accountKeys: keys,
          instructions: [
            {
              programIdIndex: 2,
              accounts: [0, 1],
              data: getBase58Decoder().decode(expected[0].data!),
            },
          ],
        },
      },
      meta: { err: null },
    };
    expect(() =>
      assertVestingStepTransaction(tx, sig, row.client_wallet, expected),
    ).not.toThrow();
    expect(() =>
      assertVestingStepTransaction(
        tx,
        "2".repeat(64),
        row.client_wallet,
        expected,
      ),
    ).toThrow();
    const copy = structuredClone(tx);
    copy.transaction.message.instructions[0].accounts = [1, 0];
    expect(() =>
      assertVestingStepTransaction(copy, sig, row.client_wallet, expected),
    ).toThrow();
    copy.transaction.message.instructions = [];
    expect(() =>
      assertVestingStepTransaction(copy, sig, row.client_wallet, expected),
    ).toThrow();
    expect(() =>
      assertVestingStepTransaction(tx, sig, key(99), expected),
    ).toThrow();
  });
});
