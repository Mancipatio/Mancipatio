import { isSome, type Address } from "@solana/kit";
import { fetchMaybeToken } from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeEscrowIdentity,
  findCreateVestingSeriesIdentityPda,
  type VestingSeries,
  VestingSeriesStatus,
} from "@/lib/generated/asset_registry";
import { fetchMintTokenProgram } from "@/lib/transaction-builders";
export async function loadVestingEscrow(
  rpc: Parameters<typeof fetchMintTokenProgram>[0],
  seriesPda: Address,
  series: VestingSeries,
) {
  const [identityPda] = await findCreateVestingSeriesIdentityPda({
      series: seriesPda,
    }),
    options = { commitment: "finalized" as const };
  const [identity, escrow, tokenProgram] = await Promise.all([
    fetchMaybeEscrowIdentity(rpc, identityPda, options),
    fetchMaybeToken(rpc, series.escrow, options),
    fetchMintTokenProgram(rpc, series.tokenMint, options),
  ]);
  if (
    !escrow.exists ||
    escrow.programAddress !== tokenProgram ||
    escrow.data.owner !== seriesPda ||
    escrow.data.mint !== series.tokenMint
  )
    throw new Error("Vesting escrow owner or mint could not be verified");
  if (
    identity.exists &&
    (identity.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      identity.data.refundOwner !== series.authority ||
      identity.data.ownRefunded > identity.data.ownDeposited)
  )
    throw new Error("Vesting escrow identity could not be verified");
  const reserved =
    series.status === VestingSeriesStatus.Active
      ? series.totalAllocated - series.totalReleased
      : BigInt(0);
  // Every current series is created with its EscrowIdentity and the program
  // has no attach instruction, so a missing identity is only reported
  // (`identity: null`), never repaired: balances and reserves stay readable
  // while deposits and surplus withdrawals remain disabled.
  return {
    identityPda,
    identity: identity.exists ? identity.data : null,
    balance: escrow.data.amount,
    immutableOwner:
      tokenProgram !== "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ||
      (isSome(escrow.data.extensions) &&
        escrow.data.extensions.value.some(
          (extension) => extension.__kind === "ImmutableOwner",
        )),
    reserved,
    surplus:
      series.status === VestingSeriesStatus.Active &&
      escrow.data.amount > reserved
        ? escrow.data.amount - reserved
        : BigInt(0),
  };
}
