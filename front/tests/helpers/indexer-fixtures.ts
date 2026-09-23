import { address, type Encoder } from "@solana/kit";
import * as a from "@/lib/generated/asset_registry";
const key = address("11111111111111111111111111111111");
const hash = new Uint8Array(32).fill(7);
const bits = new Uint8Array(128).fill(1);
const base = { version: 1, bump: 255 };
function fixture<T>(table: string, codec: Encoder<T>, data: T) { return { table, bytes: new Uint8Array(codec.encode(data)) }; }
/** Actual generated encoders, non-zero ledgers and every currently mirrored type. */
export function indexerFixtures() {
  return [
    fixture("platforms", a.getPlatformEncoder(), { ...base, admin: key, protocolTreasury: key, protocolFeeBps: 25, pauseFlags: 0x0c, issuersCount: BigInt(2) }),
    fixture("issuers", a.getIssuerEncoder(), { ...base, authority: key, legalEntityId: hash, jurisdiction: 688, kybStatus: 1, kybDocHash: hash, assetsCount: BigInt(3) }),
    fixture("assets", a.getAssetEncoder(), { ...base, issuer: key, assetId: "asset-42", assetType: 0, name: "Real asset", symbolPrefix: "RWA", legalDocHash: hash, jurisdictionRules: { allowedCountries: bits, maxHolders: 100, restrictedPeriodEnd: BigInt(1), allowP2p: false }, status: 1, shareClassesCount: 2, extraKycRegistry: null }),
    fixture("share_classes", a.getShareClassEncoder(), { ...base, version: 2, asset: key, mint: key, classIndex: 2, classType: 0, rightsBitfield: 3, liqPrefMultiplierBps: 15000, liqSeniority: 1, votingWeight: 2, convertibleTo: key, maxSupply: BigInt(99), circulatingSupply: BigInt(9), lockedSupply: BigInt(4), mintablePostLaunch: false, mintInitialized: true, supplyLocked: true, lifetimeMinted: BigInt(44), cumulativeCap: true }),
    fixture("sales", a.getSaleEncoder(), { ...base, shareClass: key, mint: key, paymentMint: key, proceeds: key, authority: key, saleId: BigInt(3), pricePerUnit: BigInt(50), totalForSale: BigInt(100), sold: BigInt(7), startTs: BigInt(1), endTs: BigInt(2), status: 1, raiseType: 0, cliffMonths: 0, vestingMonths: 0 }),
    fixture("custody_vaults", a.getCustodyVaultEncoder(), { ...base, shareClass: key, mint: key, escrow: key, vaultId: BigInt(4), authority: key, vaultType: 0, realizeAction: 0, amount: BigInt(55), state: 0, deadline: BigInt(77), metadataHash: hash, beneficiary: key, deposited: BigInt(33) }),
    fixture("offers", a.getOfferEncoder(), { ...base, maker: key, shareClass: key, mint: key, escrow: key, paymentMint: key, amount: BigInt(8), price: BigInt(90), status: 0, offerId: BigInt(8), expiresAt: BigInt(100), deposited: BigInt(8) }),
    fixture("proposals", a.getProposalEncoder(), { ...base, shareClass: key, authority: key, proposalId: BigInt(9), metadataHash: hash, snapshotSlot: BigInt(22), snapshotRoot: hash, startTs: BigInt(1), endTs: BigInt(8), forWeight: BigInt(3), againstWeight: BigInt(1), abstainWeight: BigInt(2), status: 0, outcome: 0 }),
    fixture("vote_records", a.getVoteRecordEncoder(), { bump: 255, proposal: key, voter: key, choice: 1, weight: BigInt(19) }),
    fixture("rights_issuances", a.getRightsIssuanceEncoder(), { ...base, shareClass: key, underlyingMint: key, escrow: key, authority: key, issuanceId: BigInt(11), totalClaimed: BigInt(2), milestonesCount: 4 }),
    fixture("milestones", a.getVestingMilestoneEncoder(), { ...base, issuance: key, index: 3, merkleRoot: hash, amountPool: BigInt(100), claimed: BigInt(2), unlockTs: BigInt(77) }),
    fixture("milestone_claims", a.getMilestoneClaimEncoder(), { bump: 255, milestone: key, claimer: key, amount: BigInt(12) }),
    fixture("kyc_registries", a.getKycRegistryEncoder(), { ...base, authority: key, approvedJurisdictions: bits, blockedJurisdictions: new Uint8Array(128), entriesCount: BigInt(4) }),
    fixture("kyc_entries", a.getKycEntryEncoder(), { ...base, registry: key, holder: key, status: 1, jurisdiction: 688, accreditationLevel: 2, expiry: BigInt(100), providerId: 1, externalRefHash: hash }),
  ];
}
