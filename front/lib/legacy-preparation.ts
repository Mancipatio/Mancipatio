import {
  fetchEncodedAccount,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getPrepareLegacyAccountInstruction,
  getShareClassDiscriminatorBytes,
  getPayoutVaultDiscriminatorBytes,
  getVaultVoteDiscriminatorBytes,
  getVaultVoteDecoder,
  findVaultPda,
} from "@/lib/generated/asset_registry";
import {
  decodeReadableShareClass,
  decodeReadablePayoutVault,
} from "@/lib/legacy-accounts";
import { findShareClassPda } from "@/lib/pdas";
type Rpc = Parameters<typeof fetchEncodedAccount>[0];

/** Preparation pays rent and preserves v1 fields; it grants no issuance or
 * voting authority and must never label unknown appended history as zero. */
export async function buildLegacyPreparation(
  rpc: Rpc,
  legacyAccount: Address,
  payer: TransactionSigner,
) {
  const account = await fetchEncodedAccount(rpc, legacyAccount, {
    commitment: "finalized",
    abortSignal: AbortSignal.timeout(10_000),
  });
  if (
    !account.exists ||
    account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS
  )
    throw new Error("Legacy account is missing or belongs to another program");
  const bytes = new Uint8Array(account.data),
    matches = (
      disc:
        | Readonly<Uint8Array>
        | ReturnType<typeof getShareClassDiscriminatorBytes>,
    ) => disc.every((b, i) => bytes[i] === b);
  let derived: Address;
  if (matches(getShareClassDiscriminatorBytes())) {
    const value = decodeReadableShareClass(bytes);
    if (value.version !== 1)
      throw new Error("Only original v1 accounts need legacy preparation");
    derived = await findShareClassPda(value.asset, value.classIndex);
  } else if (matches(getPayoutVaultDiscriminatorBytes())) {
    const value = decodeReadablePayoutVault(bytes);
    if (value.version !== 1)
      throw new Error("Only original v1 accounts need legacy preparation");
    [derived] = await findVaultPda({ sale: value.sale });
  } else if (matches(getVaultVoteDiscriminatorBytes())) {
    const decoder = getVaultVoteDecoder();
    if (bytes.length < decoder.fixedSize - 8)
      throw new Error("Incomplete original vote account");
    const padded = new Uint8Array(Math.max(bytes.length, decoder.fixedSize));
    padded.set(bytes);
    const value = decoder.decode(padded);
    if (value.version !== 1)
      throw new Error("Only original v1 accounts need legacy preparation");
    [derived] = await getProgramDerivedAddress({
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      seeds: [
        new TextEncoder().encode("vaultvote"),
        getAddressEncoder().encode(value.payoutVault),
      ],
    });
  } else
    throw new Error(
      "Only legacy ShareClass, PayoutVault and VaultVote accounts support preparation",
    );
  if (derived !== legacyAccount)
    throw new Error("Legacy account PDA does not match its original fields");
  return getPrepareLegacyAccountInstruction({ payer, legacyAccount });
}
