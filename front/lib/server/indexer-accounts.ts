import "server-only";
import { address, getProgramDerivedAddress, getAddressEncoder, getU64Encoder, getU16Encoder, isSome, type Decoder, type ReadonlyUint8Array } from "@solana/kit";
import { decodeReadableShareClass, isLegacyShareClass } from "@/lib/legacy-accounts";
import * as accounts from "@/lib/generated/asset_registry";

/** One generated-codec projection shared by live jobs and complete reconciliation. */
export const INDEXER_LAYOUT_VERSION = 2;
export const INDEXER_PROGRAM = accounts.ASSET_REGISTRY_PROGRAM_ADDRESS;
type Row = Record<string, unknown>;
/**
 * `address` is the snapshot address of the account being decoded, or null when
 * the caller has none. Seed-derived entities ignore it (their row `pda` is
 * re-derived and compared by decodeIndexerAccount); `kyc_registries` REQUIRES
 * it, because a rotated registry's address is not derivable from its fields.
 */
type Entry = { table: string; discriminator: ReadonlyUint8Array; decode: (data: Uint8Array, address: string | null) => Promise<Row> };
const text = (s: string) => new TextEncoder().encode(s);
const key = (s: string) => getAddressEncoder().encode(address(s));
const u64 = (n: number | bigint) => getU64Encoder().encode(n);
const u16 = (n: number) => getU16Encoder().encode(n);
const hex = (bytes: ReadonlyUint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const numberString = (n: bigint | number) => n.toString();
const utf8 = (bytes: ReadonlyUint8Array) => new TextDecoder().decode(new Uint8Array(bytes)).replace(/\0+$/, "");
async function pda(seeds: readonly ReadonlyUint8Array[]) {
  return (await getProgramDerivedAddress({ programAddress: INDEXER_PROGRAM, seeds: [...seeds] }))[0];
}
function spec<T>(
  table: string, discriminator: ReadonlyUint8Array, decoder: Decoder<T>,
  project: (value: T) => Row, derive: (value: T, address: string | null) => Promise<string>, expectedVersion: number | readonly number[] = 1,
): Entry {
  return { table, discriminator, decode: async (bytes, address) => {
    const value = decoder.decode(bytes);
    const version = (value as { version?: number }).version;
    if (version !== undefined && !(Array.isArray(expectedVersion) ? expectedVersion.includes(version) : version === expectedVersion)) {
      throw new Error(`${table} account version ${version} requires an explicit migration; expected ${expectedVersion}`);
    }
    return { ...project(value), pda: await derive(value, address), account_version: version ?? 0 };
  } };
}

export const INDEXER_ENTITIES: readonly Entry[] = [
  spec("platforms", accounts.getPlatformDiscriminatorBytes(), accounts.getPlatformDecoder(), (a) => ({
    admin: a.admin, protocol_treasury: a.protocolTreasury, protocol_fee_bps: a.protocolFeeBps,
    // Byte 74 is the emergency-pause bitmask (formerly `paused: bool`).
    // `paused` stays as "any bit set" until the contract migration drops it.
    pause_flags: a.pauseFlags, paused: a.pauseFlags !== 0,
    issuers_count: numberString(a.issuersCount), version: a.version,
  }), () => pda([text("platform")])),
  spec("issuers", accounts.getIssuerDiscriminatorBytes(), accounts.getIssuerDecoder(), (a) => ({
    authority: a.authority, legal_entity_id: utf8(a.legalEntityId), jurisdiction: a.jurisdiction,
    kyb_status: a.kybStatus, kyb_doc_hash: hex(a.kybDocHash), assets_count: numberString(a.assetsCount), version: a.version,
  }), (a) => pda([text("issuer"), a.legalEntityId])),
  spec("assets", accounts.getAssetDiscriminatorBytes(), accounts.getAssetDecoder(), (a) => ({
    issuer_pda: a.issuer, asset_id: a.assetId, asset_type: a.assetType, name: a.name,
    symbol_prefix: a.symbolPrefix, legal_doc_hash: hex(a.legalDocHash), status: a.status,
    share_classes_count: a.shareClassesCount, extra_kyc_registry: isSome(a.extraKycRegistry) ? a.extraKycRegistry.value : null,
    jurisdiction_rules: { allowed_countries: hex(a.jurisdictionRules.allowedCountries), max_holders: a.jurisdictionRules.maxHolders, restricted_period_end: numberString(a.jurisdictionRules.restrictedPeriodEnd), allow_p2p: a.jurisdictionRules.allowP2p },
  }), (a) => pda([text("asset"), key(a.issuer), text(a.assetId)])),
  spec("share_classes", accounts.getShareClassDiscriminatorBytes(), { decode: decodeReadableShareClass } as Decoder<ReturnType<typeof decodeReadableShareClass>>, (a) => {
    const legacy = isLegacyShareClass(a);
    return { asset_pda: a.asset, mint: a.mint, class_index: a.classIndex, class_type: a.classType,
      rights_bitfield: a.rightsBitfield, liq_pref_multi_bps: a.liqPrefMultiplierBps, liq_seniority: a.liqSeniority,
      voting_weight: a.votingWeight, convertible_to: isSome(a.convertibleTo) ? a.convertibleTo.value : null,
      max_supply: isSome(a.maxSupply) ? numberString(a.maxSupply.value) : null,
      circulating_supply: numberString(a.circulatingSupply), locked_supply: numberString(a.lockedSupply),
      mintable_post_launch: a.mintablePostLaunch, mint_initialized: a.mintInitialized, supply_locked: a.supplyLocked,
      lifetime_minted: legacy ? null : numberString(a.lifetimeMinted), cumulative_cap: legacy ? null : a.cumulativeCap, readonly_legacy: legacy };
  }, (a) => pda([text("share_class"), key(a.asset), new Uint8Array([a.classIndex])]), [1, 2]),
  spec("sales", accounts.getSaleDiscriminatorBytes(), accounts.getSaleDecoder(), (a) => ({
    share_class_pda: a.shareClass, mint: a.mint, payment_mint: a.paymentMint, proceeds: a.proceeds,
    authority: a.authority, sale_id: numberString(a.saleId), price_per_unit: numberString(a.pricePerUnit),
    total_for_sale: numberString(a.totalForSale), sold: numberString(a.sold), start_ts: numberString(a.startTs),
    end_ts: numberString(a.endTs), status: a.status, raise_type: a.raiseType, cliff_months: a.cliffMonths, vesting_months: a.vestingMonths,
    // Sale v2 (program 2B): the SaleApproval open_sale consumed and its application commitment.
    sale_approval: a.saleApproval, application_hash: hex(a.applicationHash),
  }), (a) => pda([text("sale"), key(a.shareClass), u64(a.saleId)]), 2),
  spec("custody_vaults", accounts.getCustodyVaultDiscriminatorBytes(), accounts.getCustodyVaultDecoder(), (a) => ({
    share_class_pda: a.shareClass, mint: a.mint, escrow: a.escrow, vault_id: numberString(a.vaultId),
    authority: a.authority, vault_type: a.vaultType, realize_action: a.realizeAction, amount: numberString(a.amount),
    state: a.state, deadline: numberString(a.deadline), metadata_hash: hex(a.metadataHash),
    deposited: numberString(a.deposited), beneficiary: a.beneficiary,
  }), (a) => pda([text("custody"), key(a.shareClass), u64(a.vaultId)])),
  spec("offers", accounts.getOfferDiscriminatorBytes(), accounts.getOfferDecoder(), (a) => ({
    maker: a.maker, share_class_pda: a.shareClass, mint: a.mint, escrow: a.escrow, payment_mint: a.paymentMint,
    amount: numberString(a.amount), price: numberString(a.price), status: a.status, offer_id: numberString(a.offerId),
    deposited: numberString(a.deposited), expires_at: numberString(a.expiresAt),
  }), (a) => pda([text("offer"), key(a.shareClass), u64(a.offerId)])),
  spec("proposals", accounts.getProposalDiscriminatorBytes(), accounts.getProposalDecoder(), (a) => ({
    share_class_pda: a.shareClass, authority: a.authority, proposal_id: numberString(a.proposalId), metadata_hash: hex(a.metadataHash),
    snapshot_slot: numberString(a.snapshotSlot), snapshot_root: hex(a.snapshotRoot), start_ts: numberString(a.startTs),
    end_ts: numberString(a.endTs), for_weight: numberString(a.forWeight), against_weight: numberString(a.againstWeight),
    abstain_weight: numberString(a.abstainWeight), status: a.status, outcome: a.outcome,
  }), (a) => pda([text("proposal"), key(a.shareClass), u64(a.proposalId)])),
  // VoteRecord and MilestoneClaim intentionally have no version field.
  spec("vote_records", accounts.getVoteRecordDiscriminatorBytes(), accounts.getVoteRecordDecoder(), (a) => ({
    proposal_pda: a.proposal, voter: a.voter, choice: a.choice, weight: numberString(a.weight),
  }), (a) => pda([text("vote"), key(a.proposal), key(a.voter)])),
  spec("rights_issuances", accounts.getRightsIssuanceDiscriminatorBytes(), accounts.getRightsIssuanceDecoder(), (a) => ({
    share_class_pda: a.shareClass, underlying_mint: a.underlyingMint, escrow: a.escrow, authority: a.authority,
    issuance_id: numberString(a.issuanceId), total_claimed: numberString(a.totalClaimed), milestones_count: a.milestonesCount,
  }), (a) => pda([text("rights"), key(a.shareClass), u64(a.issuanceId)])),
  spec("milestones", accounts.getVestingMilestoneDiscriminatorBytes(), accounts.getVestingMilestoneDecoder(), (a) => ({
    issuance_pda: a.issuance, index: a.index, merkle_root: hex(a.merkleRoot), amount_pool: numberString(a.amountPool),
    claimed: numberString(a.claimed), unlock_ts: numberString(a.unlockTs),
  }), (a) => pda([text("rt_milestone"), key(a.issuance), u16(a.index)])),
  spec("milestone_claims", accounts.getMilestoneClaimDiscriminatorBytes(), accounts.getMilestoneClaimDecoder(), (a) => ({
    milestone_pda: a.milestone, claimer: a.claimer, amount: numberString(a.amount),
  }), (a) => pda([text("rt_claim"), key(a.milestone), key(a.claimer)])),
  spec("kyc_registries", accounts.getKycRegistryDiscriminatorBytes(), accounts.getKycRegistryDecoder(), (a) => ({
    authority: a.authority, approved_jurisdictions: hex(a.approvedJurisdictions), blocked_jurisdictions: hex(a.blockedJurisdictions),
    entries_count: numberString(a.entriesCount), version: a.version,
    // A registry's address is ["kyc_registry", CREATING authority], and its
    // `authority` rotates (2C-1). After a rotation the address cannot be
    // derived from any field. Its identity is proven instead by the owner
    // check, the discriminator, the full-length generated decode and the
    // version check, and the snapshot address is the key.
    // There is deliberately NO seed fallback: re-deriving from the current
    // authority would silently key a rotated registry at the wrong address.
  }), async (_a, address) => {
    if (address === null) throw new Error("kyc_registries rows are keyed by the snapshot address; decode needs it");
    return address;
  }),
  spec("kyc_entries", accounts.getKycEntryDiscriminatorBytes(), accounts.getKycEntryDecoder(), (a) => ({
    registry_pda: a.registry, holder: a.holder, status: a.status, jurisdiction: a.jurisdiction,
    accreditation_level: a.accreditationLevel, expiry: numberString(a.expiry), provider_id: a.providerId,
    external_ref_hash: hex(a.externalRefHash), version: a.version,
  }), (a) => pda([text("kyc"), key(a.registry), key(a.holder)])),
];

export type DecodedIndexerAccount = { table: string; row: Row };
export async function decodeIndexerAccount(pdaAddress: string, owner: string, bytes: Uint8Array): Promise<DecodedIndexerAccount | null> {
  if (owner !== INDEXER_PROGRAM) return null; // ordinary wallet/token accounts are not registry accounts
  if (bytes.length < 8) throw new Error("Incomplete registry discriminator");
  const entry = INDEXER_ENTITIES.find((e) => bytes.length >= 8 && e.discriminator.every((b, i) => bytes[i] === b));
  if (!entry) return null; // valid registry account type outside the 14 existing mirror tables
  const row = await entry.decode(bytes, pdaAddress); // generated decoder enforces complete field lengths
  if (row.pda !== pdaAddress) throw new Error(`${entry.table} derived PDA does not match the snapshot address`);
  return { table: entry.table, row };
}
