// Manual PDA derivations for seeds Codama leaves to the caller
// (instruction-arg-seeded PDAs), plus positional wrappers over the GENERATED
// helpers for the PDAs the 8.3 (v1.0.0-rc) program added. The seeds of those
// come from the IDL only: every wrapper below that names a program PDA calls
// the Codama helper, never a hand-written seed.

import {
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findAcceptPlatformAdminRecoveryPda,
  findAcceptPlatformAdminTransferPda,
  findIssuerFreezePda as findIssuerFreezePdaGenerated,
  findPendingAdminPda as findPendingAdminPdaGenerated,
  findPlatformPda,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  findBlockEntryPda as findBlockEntryPdaGenerated,
  findRecoveryPda as findBlocklistRecoveryPdaGenerated,
  findTransferPda as findBlocklistAuthorityProposalPdaGenerated,
} from "@/lib/generated/transfer_hook";

const addr = getAddressEncoder();
const seed = (s: string) => new TextEncoder().encode(s);

/** The Manci transfer_hook program. */
export const TRANSFER_HOOK_PROGRAM: Address = TRANSFER_HOOK_PROGRAM_ADDRESS;

/** BPF Loader Upgradeable (loader-v3): owner of every ProgramData account. */
export const BPF_LOADER_UPGRADEABLE =
  "BPFLoaderUpgradeab1e11111111111111111111111" as Address;

/** transfer_hook `["blocked", wallet]` — the blocklist entry (generated helper). */
export async function findBlockEntryPda(wallet: Address): Promise<Address> {
  const [pda] = await findBlockEntryPdaGenerated({ wallet });
  return pda;
}

/** transfer_hook `["extra-account-metas", mint]` — the hook's ExtraAccountMetaList. */
export async function findExtraMetasPda(mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: TRANSFER_HOOK_PROGRAM,
    seeds: [seed("extra-account-metas"), addr.encode(mint)],
  });
  return pda;
}

/**
 * asset_registry `["authority_proposal", target]` — the staged rotation of a
 * rotatable target (Platform, Issuer, KycRegistry, CustodyVault), type
 * `AuthorityProposal` (v1.0.0-rc; it replaced rc.x's
 * `["authority_transfer", target]` `AuthorityTransfer`). Codama emits one
 * helper per instruction for this seed because the account name `transfer`
 * collides across targets (`findAcceptPlatformAdminTransferPda`,
 * `findAcceptIssuerAuthorityTransferPda`,
 * `findAcceptKycRegistryAuthorityTransferPda`, `findTransferPda`); they all
 * derive the same address (tests/pdas.test.ts pins that), so this positional
 * wrapper delegates to one of them.
 */
export async function findAuthorityProposalPda(target: Address): Promise<Address> {
  const [pda] = await findAcceptPlatformAdminTransferPda({ platform: target });
  return pda;
}

/** asset_registry `["pending_admin", newAdmin]` — a staged Admin grant (D3). */
export async function findPendingAdminPda(newAdmin: Address): Promise<Address> {
  const [pda] = await findPendingAdminPdaGenerated({ newAdmin });
  return pda;
}

/** asset_registry `["platform_recovery", platform]` — the UA's super-admin recovery (D4). */
export async function findPlatformRecoveryPda(): Promise<Address> {
  const [platform] = await findPlatformPda();
  const [pda] = await findAcceptPlatformAdminRecoveryPda({ platform });
  return pda;
}

/** asset_registry `["issuer_freeze", issuer]` — the issuer's proceeds freeze (D1). */
export async function findIssuerFreezePda(issuer: Address): Promise<Address> {
  const [pda] = await findIssuerFreezePdaGenerated({ issuer });
  return pda;
}

/** transfer_hook `["blocklist_authority_proposal"]` — the staged BA rotation. */
export async function findBlocklistAuthorityProposalPda(): Promise<Address> {
  const [pda] = await findBlocklistAuthorityProposalPdaGenerated();
  return pda;
}

/** transfer_hook `["blocklist_recovery"]` — the UA's blocklist-authority recovery (D4). */
export async function findBlocklistRecoveryPda(): Promise<Address> {
  const [pda] = await findBlocklistRecoveryPdaGenerated();
  return pda;
}

/**
 * The loader-v3 ProgramData account of `program` (`[program]` under the
 * upgradeable loader). Not a program PDA, so not in the IDL: the cancel and
 * recovery instructions take it to recognise the upgrade authority.
 */
export async function findProgramDataPda(
  program: Address = ASSET_REGISTRY_PROGRAM_ADDRESS,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE,
    seeds: [addr.encode(program)],
  });
  return pda;
}

function u64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

/** `["share_class", asset, classIndex]` */
export async function findShareClassPda(
  asset: Address,
  classIndex: number,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    seeds: [seed("share_class"), addr.encode(asset), new Uint8Array([classIndex])],
  });
  return pda;
}

/** `["sale", share_class, saleId]` */
export async function findSalePda(
  shareClass: Address,
  saleId: bigint,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    seeds: [seed("sale"), addr.encode(shareClass), u64le(saleId)],
  });
  return pda;
}

/** `["proposal", share_class, proposalId]` */
export async function findProposalPda(
  shareClass: Address,
  proposalId: bigint,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    seeds: [seed("proposal"), addr.encode(shareClass), u64le(proposalId)],
  });
  return pda;
}

/** `["custody", share_class, vaultId]` */
export async function findCustodyVaultPda(
  shareClass: Address,
  vaultId: bigint,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    seeds: [seed("custody"), addr.encode(shareClass), u64le(vaultId)],
  });
  return pda;
}

/** `["rights", share_class, issuanceId]` */
export async function findRightsIssuancePda(
  shareClass: Address,
  issuanceId: bigint,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    seeds: [seed("rights"), addr.encode(shareClass), u64le(issuanceId)],
  });
  return pda;
}

/** `["rt_milestone", rights_issuance, index]` (index is a u16) */
export async function findMilestonePda(
  rightsIssuance: Address,
  index: number,
): Promise<Address> {
  const idx = new Uint8Array(2);
  new DataView(idx.buffer).setUint16(0, index, true);
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    seeds: [seed("rt_milestone"), addr.encode(rightsIssuance), idx],
  });
  return pda;
}

/** `["rt_claim", milestone, claimer]` */
export async function findClaimPda(
  milestone: Address,
  claimer: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    seeds: [seed("rt_claim"), addr.encode(milestone), addr.encode(claimer)],
  });
  return pda;
}

/** `["offer", share_class, offerId]` */
export async function findOfferPda(
  shareClass: Address,
  offerId: bigint,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    seeds: [seed("offer"), addr.encode(shareClass), u64le(offerId)],
  });
  return pda;
}
