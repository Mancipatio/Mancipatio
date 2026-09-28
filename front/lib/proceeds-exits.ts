// The issuer's proceeds exits with their v1.0.0-rc (8.3) gate accounts:
// `close_sale`, `open_payout_vault`, `release_payout` and
// `claim_founder_yield`. Each now names the sale's / vault's share class and
// asset (the program reads `asset.issuer` from them) and the issuer's
// `IssuerFreeze` ["issuer_freeze", issuer] (D1: must be unset, else
// IssuerProceedsFrozen 6143); the payouts also name the hook blocklist entry
// of whoever receives the money (["blocked", wallet], else PartyBlocklisted
// 6144). All PDAs come from the generated clients (lib/pdas wrappers).
import type { Address, Instruction, ReadonlyUint8Array, TransactionSigner } from "@solana/kit";
import {
  findPlatformPda,
  getClaimFounderYieldInstruction,
  getCloseSaleInstruction,
  getOpenPayoutVaultInstructionAsync,
  getReleasePayoutInstruction,
} from "@/lib/generated/asset_registry";
import { resolveIssuerChain } from "@/lib/issuer-authority";
import { findBlockEntryPda, findIssuerFreezePda } from "@/lib/pdas";

type Rpc = Parameters<typeof resolveIssuerChain>[0];

export type IssuerProceedsGates = {
  shareClass: Address;
  asset: Address;
  issuer: Address;
  /** ["issuer_freeze", issuer]: must not exist for any proceeds exit. */
  issuerFreeze: Address;
};

/** share class → asset → issuer (read from chain) and the issuer's freeze PDA. */
export async function issuerProceedsGates(rpc: Rpc, shareClass: Address): Promise<IssuerProceedsGates> {
  const chain = await resolveIssuerChain(rpc, shareClass);
  return {
    shareClass,
    asset: chain.asset,
    issuer: chain.issuer,
    issuerFreeze: await findIssuerFreezePda(chain.issuer),
  };
}

/**
 * `close_sale` (Established / Mature raises): sweeps the proceeds to
 * `destination`, the payment account of `destinationOwner` (the issuer's own
 * ATA). Neither the signing authority nor the destination owner may be
 * blocklisted.
 */
export async function buildCloseSaleInstruction(
  rpc: Rpc,
  input: {
    authority: TransactionSigner;
    sale: { address: Address; shareClass: Address; proceeds: Address; paymentMint: Address };
    destination: Address;
    destinationOwner: Address;
    paymentTokenProgram: Address;
  },
): Promise<Instruction> {
  const [gates, [platform], authorityBlockEntry, destinationBlockEntry] = await Promise.all([
    issuerProceedsGates(rpc, input.sale.shareClass),
    findPlatformPda(),
    findBlockEntryPda(input.authority.address),
    findBlockEntryPda(input.destinationOwner),
  ]);
  return getCloseSaleInstruction({
    platform,
    authority: input.authority,
    sale: input.sale.address,
    proceeds: input.sale.proceeds,
    paymentMint: input.sale.paymentMint,
    destination: input.destination,
    paymentTokenProgram: input.paymentTokenProgram,
    shareClass: gates.shareClass,
    asset: gates.asset,
    issuerFreeze: gates.issuerFreeze,
    authorityBlockEntry,
    destinationBlockEntry,
  });
}

/** `open_payout_vault` (Startup raises): the proceeds move into the vault escrow. */
export async function buildOpenPayoutVaultInstruction(
  rpc: Rpc,
  input: {
    authority: TransactionSigner;
    sale: { address: Address; shareClass: Address; proceeds: Address; paymentMint: Address };
    paymentTokenProgram: Address;
    metadataHash: ReadonlyUint8Array;
  },
): Promise<Instruction> {
  const gates = await issuerProceedsGates(rpc, input.sale.shareClass);
  return getOpenPayoutVaultInstructionAsync({
    authority: input.authority,
    sale: input.sale.address,
    proceeds: input.sale.proceeds,
    paymentMint: input.sale.paymentMint,
    paymentTokenProgram: input.paymentTokenProgram,
    metadataHash: input.metadataHash,
    shareClass: gates.shareClass,
    asset: gates.asset,
    issuerFreeze: gates.issuerFreeze,
  });
}

type VaultExit = {
  vault: Address;
  escrow: Address;
  shareClass: Address;
  paymentMint: Address;
  /** The founder's payment account (its ATA). */
  founderAccount: Address;
  /**
   * The founder the vault names WHEN THE INSTRUCTION RUNS: the live issuer
   * key when a `sync_payout_founder` is bundled in front of it.
   */
  founder: Address;
  paymentTokenProgram: Address;
};

/** `release_payout`: the next due tranche to the founder. */
export async function buildReleasePayoutInstruction(rpc: Rpc, input: VaultExit): Promise<Instruction> {
  const [gates, [platform], founderBlockEntry] = await Promise.all([
    issuerProceedsGates(rpc, input.shareClass),
    findPlatformPda(),
    findBlockEntryPda(input.founder),
  ]);
  return getReleasePayoutInstruction({
    platform,
    vault: input.vault,
    escrow: input.escrow,
    paymentMint: input.paymentMint,
    founderAccount: input.founderAccount,
    paymentTokenProgram: input.paymentTokenProgram,
    shareClass: gates.shareClass,
    asset: gates.asset,
    issuerFreeze: gates.issuerFreeze,
    founderBlockEntry,
  });
}

/** `claim_founder_yield`: the founder's routed-yield share, signed by the founder. */
export async function buildClaimFounderYieldInstruction(
  rpc: Rpc,
  input: Omit<VaultExit, "founder"> & { founder: TransactionSigner },
): Promise<Instruction> {
  const [gates, [platform], founderBlockEntry] = await Promise.all([
    issuerProceedsGates(rpc, input.shareClass),
    findPlatformPda(),
    findBlockEntryPda(input.founder.address),
  ]);
  return getClaimFounderYieldInstruction({
    platform,
    founder: input.founder,
    vault: input.vault,
    escrow: input.escrow,
    paymentMint: input.paymentMint,
    founderAccount: input.founderAccount,
    paymentTokenProgram: input.paymentTokenProgram,
    shareClass: gates.shareClass,
    asset: gates.asset,
    issuerFreeze: gates.issuerFreeze,
    founderBlockEntry,
  });
}
