/** Original v1 Borsh prefixes. Ignore unused allocation after version/bump;
 * stale Option padding is not a v2 ledger or a vote round. */
import { fixDecoderSize, getBytesDecoder, getAddressDecoder, getU8Decoder, getU16Decoder, getU32Decoder, getU64Decoder, getI64Decoder, getOptionDecoder, getBooleanDecoder, getStructDecoder } from "@solana/kit";
import { getShareClassTypeDecoder, getRaiseTypeDecoder, getPayoutVaultStateDecoder, getVaultVoteOutcomeDecoder } from "@/lib/generated/asset_registry";

export function getLegacyShareClassPrefixDecoder() {
  return getStructDecoder([
    ["discriminator", fixDecoderSize(getBytesDecoder(), 8)],
    ["asset", getAddressDecoder()],
    ["mint", getAddressDecoder()],
    ["classIndex", getU8Decoder()],
    ["classType", getShareClassTypeDecoder()],
    ["rightsBitfield", getU8Decoder()],
    ["liqPrefMultiplierBps", getU16Decoder()],
    ["liqSeniority", getU8Decoder()],
    ["votingWeight", getU32Decoder()],
    ["convertibleTo", getOptionDecoder(getAddressDecoder())],
    ["maxSupply", getOptionDecoder(getU64Decoder())],
    ["circulatingSupply", getU64Decoder()],
    ["lockedSupply", getU64Decoder()],
    ["mintablePostLaunch", getBooleanDecoder()],
    ["mintInitialized", getBooleanDecoder()],
    ["supplyLocked", getBooleanDecoder()],
    ["version", getU8Decoder()],
    ["bump", getU8Decoder()],
  ]);
}

export function getLegacyPayoutVaultPrefixDecoder() {
  return getStructDecoder([
    ["discriminator", fixDecoderSize(getBytesDecoder(), 8)],
    ["sale", getAddressDecoder()],
    ["shareClass", getAddressDecoder()],
    ["paymentMint", getAddressDecoder()],
    ["escrow", getAddressDecoder()],
    ["founder", getAddressDecoder()],
    ["raiseType", getRaiseTypeDecoder()],
    ["totalAmount", getU64Decoder()],
    ["released", getU64Decoder()],
    ["startTs", getI64Decoder()],
    ["cliffMonths", getU8Decoder()],
    ["vestingMonths", getU8Decoder()],
    ["numTranches", getU8Decoder()],
    ["trancheAmount", getU64Decoder()],
    ["tranchesReleased", getU8Decoder()],
    ["updatesPosted", getU32Decoder()],
    ["lastUpdateTs", getI64Decoder()],
    ["founderYieldClaimable", getU64Decoder()],
    ["investorYieldPool", getU64Decoder()],
    ["investorYieldRoot", fixDecoderSize(getBytesDecoder(), 32)],
    ["totalWeight", getU64Decoder()],
    ["state", getPayoutVaultStateDecoder()],
    ["metadataHash", fixDecoderSize(getBytesDecoder(), 32)],
    ["version", getU8Decoder()],
    ["bump", getU8Decoder()],
  ]);
}

export function getLegacyVaultVotePrefixDecoder() {
  return getStructDecoder([
    ["discriminator", fixDecoderSize(getBytesDecoder(), 8)],
    ["payoutVault", getAddressDecoder()],
    ["snapshotRoot", fixDecoderSize(getBytesDecoder(), 32)],
    ["startTs", getI64Decoder()],
    ["endTs", getI64Decoder()],
    ["returnWeight", getU64Decoder()],
    ["extendWeight", getU64Decoder()],
    ["outcome", getVaultVoteOutcomeDecoder()],
    ["version", getU8Decoder()],
    ["bump", getU8Decoder()],
  ]);
}
