// Manual PDA derivations for seeds Codama leaves to the caller
// (instruction-arg-seeded PDAs).

import {
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";

const addr = getAddressEncoder();
const seed = (s: string) => new TextEncoder().encode(s);

/** The Mancipatio transfer_hook program. */
export const TRANSFER_HOOK_PROGRAM =
  "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy" as Address;

/** transfer_hook `["blocked", wallet]` — the source-owner blocklist entry. */
export async function findBlockEntryPda(wallet: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: TRANSFER_HOOK_PROGRAM,
    seeds: [seed("blocked"), addr.encode(wallet)],
  });
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
