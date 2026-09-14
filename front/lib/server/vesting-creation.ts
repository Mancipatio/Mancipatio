import "server-only";
import {
  address,
  createNoopSigner,
  isSome,
  signature as toSignature,
  type Instruction,
} from "@solana/kit";
import { fetchMaybeToken } from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeVestingSeries,
  fetchMaybeEscrowIdentity,
  findCreateVestingSeriesIdentityPda,
  fetchAllMaybeVestingPosition,
  getCancelVestingSeriesInstruction,
  findPositionPda,
  type VestingSeries,
} from "@/lib/generated/asset_registry";
import {
  assertVestingIntent,
  assertVestingPosition,
  assertVestingSeriesTerms,
  assertVestingStepTransaction,
  buildVestingCreationSteps,
  type VestingCreationIntent,
} from "@/lib/vesting-creation";
import { hashVestingTerms } from "@/lib/vesting-terms";
import {
  fetchVestingMintTokenProgram,
  TOKEN_2022,
} from "@/lib/transaction-builders";
import { getServerRpc } from "@/lib/server/rpc";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { SiwsError } from "@/lib/server/siws";
import { detectNetwork } from "@/lib/network";
import type { VestingSeriesRow } from "@/lib/vesting-series";
import type { ChainTransaction } from "@/lib/chain-evidence";

export async function ownedVestingRequest(
  id: unknown,
  wallet: string,
): Promise<VestingSeriesRow> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
    throw new SiwsError(400, "A valid series request id is required");
  const { data, error } = await getSupabaseAdmin()
    .from("vesting_series")
    .select("*")
    .eq("id", id)
    .eq("network", detectNetwork())
    .eq("client_wallet", wallet)
    .maybeSingle();
  if (error) throw new SiwsError(500, "Series lookup failed");
  if (!data) throw new SiwsError(404, "Vesting series not found");
  return data as VestingSeriesRow;
}
export async function assertApprovedVestingHash(row: VestingCreationIntent) {
  if (
    !row.approved_terms_hash ||
    (await hashVestingTerms(row)) !== row.approved_terms_hash
  )
    throw new SiwsError(
      409,
      "This request needs a fresh review of its current terms before creation",
    );
}
function options(minContextSlot?: bigint) {
  return {
    commitment: "finalized" as const,
    minContextSlot,
    abortSignal: AbortSignal.timeout(12_000),
  };
}
export async function readVestingCreationState(
  row: VestingCreationIntent,
  complete = false,
  minContextSlot?: bigint,
): Promise<VestingSeries | null> {
  try {
    await assertApprovedVestingHash(row);
    await assertVestingIntent(row);
    const rpc = getServerRpc();
    const series = await fetchMaybeVestingSeries(
      rpc,
      address(row.series_pda!),
      options(minContextSlot),
    );
    if (!series.exists) {
      if (complete)
        throw new SiwsError(
          503,
          "Finalized series is not available yet; retry recording",
        );
      return null;
    }
    if (series.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS)
      throw new SiwsError(400, "Series is not owned by the registry program");
    assertVestingSeriesTerms(row, series.data, complete);
    const pdas = await Promise.all(
      Array.from({ length: series.data.positionsCount }, (_, index) =>
        findPositionPda({
          series: address(row.series_pda!),
          positionIndex: index,
        }).then(([pda]) => pda),
      ),
    );
    for (let start = 0; start < pdas.length; start += 100) {
      const positions = await fetchAllMaybeVestingPosition(
        rpc,
        pdas.slice(start, start + 100),
        options(minContextSlot),
      );
      positions.forEach((position, index) => {
        if (
          !position.exists ||
          position.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS
        )
          throw new SiwsError(
            400,
            "An approved position is missing or has the wrong owner",
          );
        assertVestingPosition(row, position.data, start + index);
      });
    }
    const tokenProgram = await fetchVestingMintTokenProgram(
      rpc,
      address(row.token_mint),
      options(minContextSlot),
    );
    const escrow = await fetchMaybeToken(
      rpc,
      address(row.escrow!),
      options(minContextSlot),
    );
    if (
      !escrow.exists ||
      escrow.programAddress !== tokenProgram ||
      escrow.data.owner !== row.series_pda ||
      escrow.data.mint !== row.token_mint
    )
      throw new SiwsError(
        400,
        "Escrow does not match the approved series, mint and token program",
      );
    if (
      tokenProgram === TOKEN_2022 &&
      (!isSome(escrow.data.extensions) ||
        !escrow.data.extensions.value.some(
          (extension) => extension.__kind === "ImmutableOwner",
        ))
    )
      throw new SiwsError(
        400,
        "Escrow requires immutable ownership under the current program version",
      );
    const [identityPda] = await findCreateVestingSeriesIdentityPda({
      series: address(row.series_pda!),
    });
    const identity = await fetchMaybeEscrowIdentity(
      rpc,
      identityPda,
      options(minContextSlot),
    );
    if (
      !identity.exists ||
      identity.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      identity.data.refundOwner !== row.client_wallet ||
      identity.data.ownRefunded > identity.data.ownDeposited
    )
      throw new SiwsError(
        400,
        "The series escrow identity does not match its approved authority",
      );
    return series.data;
  } catch (error) {
    if (error instanceof SiwsError) throw error;
    // Structural mismatches are useful to the caller; RPC URLs and provider errors are not.
    if (
      error instanceof Error &&
      /approved|positions|allocation|series differs|creation was cancelled|prepared|seeds|finalized first/.test(
        error.message,
      )
    )
      throw new SiwsError(409, error.message);
    throw new SiwsError(
      503,
      "On-chain creation verification unavailable; retry the same request",
    );
  }
}
export async function expectedVestingStep(
  row: VestingCreationIntent,
  key: string,
): Promise<Instruction[]> {
  if (key === "cancel") {
    if (!row.series_pda)
      throw new SiwsError(409, "No prepared series address exists");
    return [
      getCancelVestingSeriesInstruction({
        authority: createNoopSigner(address(row.client_wallet)),
        series: address(row.series_pda),
      }),
    ];
  }
  const program = await fetchVestingMintTokenProgram(
    getServerRpc(),
    address(row.token_mint),
    options(),
  );
  const plan = await buildVestingCreationSteps(
    row,
    program,
    createNoopSigner(address(row.client_wallet)),
  );
  if (key === "create" || key === "finalize")
    return plan.find((step) => step.kind === key)!.instructions;
  const parsed = /^positions:(\d+):(\d+)$/.exec(key);
  if (!parsed) throw new SiwsError(400, "Unknown creation step");
  const from = Number(parsed[1]),
    to = Number(parsed[2]);
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to <= from ||
    to - from > 8 ||
    to > row.recipients.length
  )
    throw new SiwsError(400, "Invalid position range");
  return plan
    .filter((step) => step.kind === "positions")
    .flatMap((step) => step.instructions)
    .slice(from, to);
}
export async function requireVestingStepProof(
  row: VestingCreationIntent,
  key: string,
  signature: string,
) {
  let tx;
  try {
    tx = await getServerRpc()
      .getTransaction(toSignature(signature), {
        commitment: "finalized",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send({ abortSignal: AbortSignal.timeout(12_000) });
  } catch {
    throw new SiwsError(
      503,
      "Transaction verification is unavailable; retry recording the saved signature",
    );
  }
  if (!tx)
    throw new SiwsError(
      503,
      "Transaction is not finalized yet; retry recording the saved signature",
    );
  const expected = await expectedVestingStep(row, key);
  try {
    assertVestingStepTransaction(
      tx as ChainTransaction,
      signature,
      row.client_wallet,
      expected,
    );
  } catch (error) {
    throw new SiwsError(
      400,
      error instanceof Error ? error.message : "Invalid vesting transaction",
    );
  }
  return BigInt(tx.slot);
}
