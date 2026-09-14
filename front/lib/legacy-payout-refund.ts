import type { SolanaClient } from "@solana/client";
import { address, getAddressEncoder, getProgramDerivedAddress, type Address, type TransactionSigner } from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, findVaultPda, getPrepareLegacyAccountInstruction, getClaimRefundInstruction, PayoutVaultState, VaultVoteOutcome } from "@/lib/generated/asset_registry";
import { decodeReadablePayoutVault, decodeReadableVaultVote, isLegacyPayoutVault, isLegacyVaultVote } from "@/lib/legacy-accounts";
import { legacyVaultVotePda } from "@/lib/payout-vote-pda";
import { snapshotHex, verifyOriginalSnapshotProof } from "@/lib/payout-snapshots";
type Rpc = SolanaClient["runtime"]["rpc"];
export async function readLegacyRefundState(rpc: Rpc, vaultPda: Address) {
  const votePda = await legacyVaultVotePda(vaultPda);
  const result = await rpc.getMultipleAccounts([vaultPda, votePda], { commitment: "finalized", encoding: "base64" }).send({ abortSignal: AbortSignal.timeout(10_000) });
  if (!result?.context || !["number", "bigint"].includes(typeof result.context.slot) || !Number.isSafeInteger(Number(result.context.slot)) || Number(result.context.slot) < 0 || !Array.isArray(result.value) || result.value.length !== 2) throw new Error("Incomplete finalized legacy refund state");
  const decoded = result.value.map((account) => {
    if (!account || account.owner !== ASSET_REGISTRY_PROGRAM_ADDRESS || !Array.isArray(account.data) || account.data[1] !== "base64") throw new Error("Original legacy vault or vote is missing or has an unexpected owner");
    const raw = atob(account.data[0]); return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  });
  const vault = decodeReadablePayoutVault(decoded[0]); const vote = decodeReadableVaultVote(decoded[1]);
  if (!isLegacyPayoutVault(vault) || !isLegacyVaultVote(vote) || vault.state !== PayoutVaultState.Cancelled || vote.outcome !== VaultVoteOutcome.ReturnCapital || vote.payoutVault !== vaultPda || (await findVaultPda({ sale: vault.sale }))[0] !== vaultPda) throw new Error("Only an original cancelled v1 vault with a terminal return-capital vote supports this refund; pending legacy votes need verified migration");
  return { vaultPda, votePda, vault, vote };
}
/** Size preparation preserves version and original fields. It is idempotent
 * and occurs atomically with the original-vote refund, never as a new vote. */
export async function legacyRefundInstructions(state: Awaited<ReturnType<typeof readLegacyRefundState>>, investor: TransactionSigner, tokenProgram: Address, investorAccount: Address, weight: bigint, proof: Uint8Array[]) {
  if (state.vault.state !== PayoutVaultState.Cancelled || state.vote.outcome !== VaultVoteOutcome.ReturnCapital || state.vote.payoutVault !== state.vaultPda || state.votePda !== await legacyVaultVotePda(state.vaultPda) || !await verifyOriginalSnapshotProof(investor.address, String(weight), proof.map(snapshotHex), snapshotHex(state.vote.snapshotRoot))) throw new Error("A verified original terminal legacy refund entitlement is required");
  const claim = (await getProgramDerivedAddress({ programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode("pv_claim"), getAddressEncoder().encode(state.vaultPda), new Uint8Array([0]), getAddressEncoder().encode(address(investor.address))] }))[0];
  return [
    getPrepareLegacyAccountInstruction({ payer: investor, legacyAccount: state.vaultPda }),
    getPrepareLegacyAccountInstruction({ payer: investor, legacyAccount: state.votePda }),
    getClaimRefundInstruction({ investor, vault: state.vaultPda, vote: state.votePda, claim, escrow: state.vault.escrow,
      paymentMint: state.vault.paymentMint, investorAccount, paymentTokenProgram: tokenProgram, weight, proof }),
  ];
}
