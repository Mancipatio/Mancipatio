import { getProgramDerivedAddress, getAddressEncoder, getU64Encoder, type Address } from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
/** Current v2 votes are immutable and seeded by their 1-based round. */
export async function vaultVotePda(vault: Address, round: bigint): Promise<Address> {
  if (round < BigInt(1) || round > BigInt("18446744073709551615")) throw new Error("Invalid vault vote round");
  return (await getProgramDerivedAddress({ programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    seeds: [new TextEncoder().encode("vaultvote"), getAddressEncoder().encode(vault), getU64Encoder().encode(round)] }))[0];
}
/** Original v1 vote identity has no round seed. It is only used for verified
 * terminal refunds; it cannot be reopened as a current voting round. */
export async function legacyVaultVotePda(vault: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    seeds: [new TextEncoder().encode("vaultvote"), getAddressEncoder().encode(vault)] }))[0];
}
