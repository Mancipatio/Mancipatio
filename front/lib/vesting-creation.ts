import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase58Encoder,
  getTransactionEncoder,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findCreateVestingSeriesEscrowPda,
  findPositionPda,
  findSeriesPda,
  getAddVestingPositionInstruction,
  getCreateVestingSeriesInstructionAsync,
  getFinalizeVestingSeriesInstruction,
  VestingDeliveryMode,
  VestingSeriesStatus,
  VestingTimingMode,
  type VestingPosition,
  type VestingSeries,
} from "@/lib/generated/asset_registry";
import {
  assertSupportedVestingTerms,
  type VestingTerms,
} from "@/lib/vesting-terms";
import type { ChainTransaction } from "@/lib/chain-evidence";
import {
  setComputeUnitLimitInstruction,
  setComputeUnitPriceInstruction,
} from "@/lib/compute-budget";

export const VESTING_TRANSACTION_LIMIT = 1232;
export const VESTING_COMPUTE_UNITS = 400_000;
export type VestingCreationIntent = VestingTerms & {
  id: string;
  series_id: string | null;
  series_pda: string | null;
  escrow: string | null;
  approved_terms_hash: string | null;
  creation_terms_hash: string | null;
};
export type VestingCreationStep = {
  key: string;
  kind: "create" | "positions" | "finalize";
  from: number;
  to: number;
  instructions: Instruction[];
  bytes: number;
};
/**
 * Same compute limit/price pair as the send request: the send sets the limit
 * and the verified client adds SetComputeUnitPrice (a 9-byte instruction
 * whatever the price, so a 0 placeholder measures it). Signature slots
 * included.
 */
export function vestingTransactionBytes(
  instructions: readonly Instruction[],
  signer: TransactionSigner,
): number {
  const message = appendTransactionMessageInstructions(
    [
      setComputeUnitLimitInstruction(VESTING_COMPUTE_UNITS),
      setComputeUnitPriceInstruction(BigInt(0)),
      ...instructions,
    ],
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash("11111111111111111111111111111111"),
        lastValidBlockHeight: BigInt(1),
      },
      setTransactionMessageFeePayerSigner(
        signer,
        createTransactionMessage({ version: 0 }),
      ),
    ),
  );
  return getTransactionEncoder().encode(compileTransaction(message)).length;
}
export async function assertVestingIntent(row: VestingCreationIntent) {
  if (
    !row.series_id ||
    !row.series_pda ||
    !row.escrow ||
    !/^\d+$/.test(row.series_id)
  )
    throw new Error("Prepare the approved series before sending transactions");
  const [series] = await findSeriesPda({
    authority: address(row.client_wallet),
    seriesId: BigInt(row.series_id),
  });
  const [escrow] = await findCreateVestingSeriesEscrowPda({ series });
  if (series !== row.series_pda || escrow !== row.escrow)
    throw new Error("Prepared series addresses do not match their seeds");
  if (
    !row.approved_terms_hash ||
    row.creation_terms_hash !== row.approved_terms_hash
  )
    throw new Error("The creation intent is not bound to approved terms");
}

/** Immutable fields checked both for resume and final server acceptance. */
export function assertVestingSeriesTerms(
  row: VestingCreationIntent,
  series: VestingSeries,
  complete: boolean,
) {
  const match =
    series.version >= 2 &&
    series.authority === row.client_wallet &&
    series.tokenMint === row.token_mint &&
    series.seriesId.toString() === row.series_id &&
    series.escrow === row.escrow &&
    series.timingMode ===
      (row.timing_mode === "auto"
        ? VestingTimingMode.Auto
        : VestingTimingMode.Approval) &&
    series.deliveryMode ===
      (row.delivery_mode === "push"
        ? VestingDeliveryMode.Push
        : VestingDeliveryMode.Claim) &&
    series.approvalWindowSecs === BigInt(row.approval_window_secs) &&
    series.recoveryEnabled === row.recovery_enabled &&
    series.cancellationEnabled === row.cancellation_enabled &&
    series.preCliffBps === row.pre_cliff_bps &&
    series.tranches.length === row.schedule.length &&
    series.tranches.every(
      (t, i) =>
        t.unlockTs === BigInt(row.schedule[i].unlock_ts) &&
        t.amount === BigInt(row.schedule[i].amount),
    );
  if (!match)
    throw new Error("The on-chain series differs from the approved terms");
  if (series.status === VestingSeriesStatus.Cancelled)
    throw new Error(
      "This creation was cancelled; submit a new request to create another series",
    );
  if (series.positionsCount > row.recipients.length)
    throw new Error("The series has unapproved positions");
  const expected = row.recipients
    .slice(0, series.positionsCount)
    .reduce((n, r) => n + BigInt(r.allocation), BigInt(0));
  if (series.totalAllocated !== expected)
    throw new Error("On-chain allocation does not match approved positions");
  if (
    complete &&
    (series.status !== VestingSeriesStatus.Active ||
      series.positionsCount !== row.recipients.length)
  )
    throw new Error(
      "All approved positions must be added and the series finalized first",
    );
}
export function assertVestingPosition(
  row: VestingCreationIntent,
  position: VestingPosition,
  index: number,
) {
  const expected = row.recipients[index];
  if (
    !expected ||
    position.series !== row.series_pda ||
    position.index !== index ||
    position.wallet !== expected.wallet ||
    position.allocation !== BigInt(expected.allocation)
  )
    throw new Error(
      `Position ${index} differs from the approved recipient or allocation`,
    );
}
export async function buildVestingCreationSteps(
  row: VestingCreationIntent,
  tokenProgram: Address,
  signer: TransactionSigner = createNoopSigner(address(row.client_wallet)),
  existing: VestingSeries | null = null,
): Promise<VestingCreationStep[]> {
  assertSupportedVestingTerms(row);
  await assertVestingIntent(row);
  if (signer.address !== row.client_wallet)
    throw new Error("The connected wallet is not the approved authority");
  if (existing)
    assertVestingSeriesTerms(
      row,
      existing,
      existing.status === VestingSeriesStatus.Active,
    );
  if (existing?.status === VestingSeriesStatus.Active) return [];
  const steps: VestingCreationStep[] = [];
  function add(
    kind: VestingCreationStep["kind"],
    from: number,
    to: number,
    instructions: Instruction[],
  ) {
    const bytes = vestingTransactionBytes(instructions, signer);
    if (bytes > VESTING_TRANSACTION_LIMIT)
      throw new Error(
        `Vesting transaction needs ${bytes} bytes; the limit is ${VESTING_TRANSACTION_LIMIT}`,
      );
    steps.push({
      kind,
      key: kind === "positions" ? `positions:${from}:${to}` : kind,
      from,
      to,
      instructions,
      bytes,
    });
  }
  if (!existing)
    add("create", 0, 0, [
      await getCreateVestingSeriesInstructionAsync({
        authority: signer,
        tokenMint: address(row.token_mint),
        tokenProgram,
        series: address(row.series_pda!),
        escrow: address(row.escrow!),
        seriesId: BigInt(row.series_id!),
        tranches: row.schedule.map((t) => ({
          unlockTs: BigInt(t.unlock_ts),
          amount: BigInt(t.amount),
        })),
        timingMode:
          row.timing_mode === "auto"
            ? VestingTimingMode.Auto
            : VestingTimingMode.Approval,
        deliveryMode:
          row.delivery_mode === "push"
            ? VestingDeliveryMode.Push
            : VestingDeliveryMode.Claim,
        approvalWindowSecs: BigInt(row.approval_window_secs),
        recoveryEnabled: row.recovery_enabled,
        cancellationEnabled: row.cancellation_enabled,
        preCliffBps: row.pre_cliff_bps,
      }),
    ]);
  let batch: Instruction[] = [],
    from = existing?.positionsCount ?? 0;
  for (let index = from; index < row.recipients.length; index++) {
    const r = row.recipients[index];
    const [position] = await findPositionPda({
      series: address(row.series_pda!),
      positionIndex: index,
    });
    const ix = getAddVestingPositionInstruction({
      authority: signer,
      series: address(row.series_pda!),
      position,
      systemProgram: address("11111111111111111111111111111111"),
      wallet: address(r.wallet),
      allocation: BigInt(r.allocation),
    });
    if (
      batch.length &&
      (batch.length >= 8 ||
        vestingTransactionBytes([...batch, ix], signer) >
          VESTING_TRANSACTION_LIMIT)
    ) {
      add("positions", from, index, batch);
      batch = [];
      from = index;
    }
    batch.push(ix);
  }
  if (batch.length) add("positions", from, row.recipients.length, batch);
  add("finalize", 0, 0, [
    getFinalizeVestingSeriesInstruction({
      authority: signer,
      series: address(row.series_pda!),
    }),
  ]);
  return steps;
}

/** Direct wallet instructions only; reject altered args, extra registry calls and unrelated signatures. */
export function assertVestingStepTransaction(
  tx: ChainTransaction,
  signature: string,
  authority: string,
  expected: readonly Instruction[],
) {
  if (
    !tx.meta ||
    tx.meta.err !== null ||
    tx.transaction.signatures[0] !== signature
  )
    throw new Error("The transaction did not succeed with this signature");
  const message = tx.transaction.message;
  const signers = message.accountKeys.slice(
    0,
    Number(message.header.numRequiredSignatures),
  );
  if (!signers.includes(authority))
    throw new Error("The approved authority did not sign this transaction");
  const keys = [
    ...message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const actual = message.instructions.filter(
    (ix) => keys[Number(ix.programIdIndex)] === ASSET_REGISTRY_PROGRAM_ADDRESS,
  );
  if (actual.length !== expected.length)
    throw new Error(
      "Transaction does not contain exactly the expected vesting step",
    );
  actual.forEach((raw, i) => {
    const ix = expected[i],
      data = getBase58Encoder().encode(raw.data);
    if (
      data.length !== ix.data?.length ||
      !data.every((b, n) => b === ix.data![n]) ||
      raw.accounts.length !== ix.accounts?.length ||
      !raw.accounts.every(
        (idx, n) => keys[Number(idx)] === ix.accounts![n].address,
      )
    )
      throw new Error(
        "Transaction instructions differ from the approved vesting step",
      );
  });
}
