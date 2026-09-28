import "server-only";
import { address, getProgramDerivedAddress, getAddressEncoder, getU64Encoder, getU16Encoder, isSome, type Decoder, type ReadonlyUint8Array } from "@solana/kit";
import * as accounts from "@/lib/generated/asset_registry";
import * as hook from "@/lib/generated/transfer_hook";
import { legacyAccountType } from "@/lib/legacy-accounts";
import {
  findAuthorityProposalPda,
  findBlocklistAuthorityProposalPda,
  findBlocklistRecoveryPda,
  findIssuerFreezePda,
  findPendingAdminPda,
} from "@/lib/pdas";

/** One generated-codec projection shared by live jobs and complete reconciliation. */
export const INDEXER_LAYOUT_VERSION = 2;
export const INDEXER_PROGRAM = accounts.ASSET_REGISTRY_PROGRAM_ADDRESS;
/** v1.0.0-rc (8.3): two transfer_hook account types are mirrored too (ROLE_STATE_ENTITIES). */
export const INDEXER_HOOK_PROGRAM = hook.TRANSFER_HOOK_PROGRAM_ADDRESS;
type Row = Record<string, unknown>;
/**
 * `address` is the snapshot address of the account being decoded, or null when
 * the caller has none. Seed-derived entities ignore it (their row `pda` is
 * re-derived and compared by decodeIndexerAccount); `kyc_registries` REQUIRES
 * it, because a rotated registry's address is not derivable from its fields.
 * `program` is the owner the account must have; `size`, when set, is the
 * exact account size (fixed layouts only: any other size is IDL drift).
 */
type Entry = {
  table: string;
  program: string;
  discriminator: ReadonlyUint8Array;
  size?: number;
  decode: (data: Uint8Array, address: string | null) => Promise<Row>;
};
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
  owner: { program: string; size?: number } = { program: INDEXER_PROGRAM },
): Entry {
  return { table, program: owner.program, discriminator, size: owner.size, decode: async (bytes, address) => {
    if (owner.size !== undefined && bytes.length !== owner.size) {
      throw new Error(`${table} account is ${bytes.length} bytes; the layout is exactly ${owner.size}`);
    }
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
  // ShareClass v2 only (the program has no v1 path). `readonly_legacy: false`
  // stays until the contract migration: apply_indexer_snapshot (0047) requires it.
  spec("share_classes", accounts.getShareClassDiscriminatorBytes(), accounts.getShareClassDecoder(), (a) => ({
    asset_pda: a.asset, mint: a.mint, class_index: a.classIndex, class_type: a.classType,
    rights_bitfield: a.rightsBitfield, liq_pref_multi_bps: a.liqPrefMultiplierBps, liq_seniority: a.liqSeniority,
    voting_weight: a.votingWeight, convertible_to: isSome(a.convertibleTo) ? a.convertibleTo.value : null,
    max_supply: isSome(a.maxSupply) ? numberString(a.maxSupply.value) : null,
    circulating_supply: numberString(a.circulatingSupply), locked_supply: numberString(a.lockedSupply),
    mintable_post_launch: a.mintablePostLaunch, mint_initialized: a.mintInitialized, supply_locked: a.supplyLocked,
    lifetime_minted: numberString(a.lifetimeMinted), cumulative_cap: a.cumulativeCap, readonly_legacy: false,
  }), (a) => pda([text("share_class"), key(a.asset), new Uint8Array([a.classIndex])]), 2),
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
    // CustodyVault v2 (program 2C-3): the KYC registry a DeliveryEscrow pinned
    // at open (its realize checks the beneficiary there); null when unpinned.
    kyc_registry: a.kycRegistry === "11111111111111111111111111111111" ? null : a.kycRegistry,
  }), (a) => pda([text("custody"), key(a.shareClass), u64(a.vaultId)]), 2),
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

const i64 = (n: bigint) => n.toString();
const hookOwner = (size: number) => ({ program: INDEXER_HOOK_PROGRAM, size });
const registryOwner = (size: number) => ({ program: INDEXER_PROGRAM, size });

/**
 * v1.0.0-rc (8.3): the pending role changes and the issuer proceeds freezes,
 * mirrored into the service-role-only tables of 0079 (never read by the
 * browser). They feed the admin menu badges and the "timelock running"
 * incident (lib/server/alarm-checks.ts); the pages still read the chain.
 * Every address is re-derived through the generated PDA helpers (lib/pdas.ts)
 * and every layout is fixed, so the size is exact. Kept apart from
 * INDEXER_ENTITIES: those 14 are the public market mirror.
 *
 * Timestamps are i64 unix seconds (bigint columns); `kind` of an
 * AuthorityProposal is 0 platform, 1 custody, 2 issuer, 3 KYC registry.
 */
export const ROLE_STATE_ENTITIES: readonly Entry[] = [
  spec("issuer_freezes", accounts.getIssuerFreezeDiscriminatorBytes(), accounts.getIssuerFreezeDecoder(), (a) => ({
    issuer_pda: a.issuer, frozen_by: a.frozenBy, frozen_at: i64(a.frozenAt), reason_hash: hex(a.reasonHash),
  }), (a) => findIssuerFreezePda(a.issuer), 1, registryOwner(accounts.getIssuerFreezeSize())),
  spec("pending_admins", accounts.getPendingAdminDiscriminatorBytes(), accounts.getPendingAdminDecoder(), (a) => ({
    new_admin: a.newAdmin, proposed_by: a.proposedBy, proposed_at: i64(a.proposedAt), eta: i64(a.eta), expires_at: i64(a.expiresAt),
  }), (a) => findPendingAdminPda(a.newAdmin), 1, registryOwner(accounts.getPendingAdminSize())),
  spec("authority_proposals", accounts.getAuthorityProposalDiscriminatorBytes(), accounts.getAuthorityProposalDecoder(), (a) => ({
    target: a.target, kind: a.kind, current_authority: a.currentAuthority, new_authority: a.newAuthority, proposed_by: a.proposedBy,
    proposed_at: i64(a.proposedAt), eta: i64(a.eta), expires_at: i64(a.expiresAt),
  }), (a) => findAuthorityProposalPda(a.target), 1, registryOwner(accounts.getAuthorityProposalSize())),
  spec("platform_recoveries", accounts.getPlatformRecoveryDiscriminatorBytes(), accounts.getPlatformRecoveryDecoder(), (a) => ({
    platform_pda: a.platform, current_admin: a.currentAdmin, new_admin: a.newAdmin, proposed_by: a.proposedBy,
    proposed_at: i64(a.proposedAt), eta: i64(a.eta), expires_at: i64(a.expiresAt),
  }), async (a) => (await accounts.findAcceptPlatformAdminRecoveryPda({ platform: a.platform }))[0], 1,
  registryOwner(accounts.getPlatformRecoverySize())),
  // transfer_hook singletons; no version field (account_version 0).
  spec("blocklist_authority_proposals", hook.getBlocklistAuthorityProposalDiscriminatorBytes(), hook.getBlocklistAuthorityProposalDecoder(), (a) => ({
    current_authority: a.currentAuthority, new_authority: a.newAuthority, proposed_at: i64(a.proposedAt), expires_at: i64(a.expiresAt),
  }), () => findBlocklistAuthorityProposalPda(), 1, hookOwner(hook.getBlocklistAuthorityProposalSize())),
  spec("blocklist_recoveries", hook.getBlocklistRecoveryDiscriminatorBytes(), hook.getBlocklistRecoveryDecoder(), (a) => ({
    current_authority: a.currentAuthority, new_authority: a.newAuthority, proposed_by: a.proposedBy,
    proposed_at: i64(a.proposedAt), eta: i64(a.eta), expires_at: i64(a.expiresAt),
  }), () => findBlocklistRecoveryPda(), 1, hookOwner(hook.getBlocklistRecoverySize())),
];

/** Every mirrored type: the 14 market tables, then the 6 role-state tables (0079). */
export const ALL_INDEXER_ENTITIES: readonly Entry[] = [...INDEXER_ENTITIES, ...ROLE_STATE_ENTITIES];

export type DecodedIndexerAccount = { table: string; row: Row };
export async function decodeIndexerAccount(pdaAddress: string, owner: string, bytes: Uint8Array): Promise<DecodedIndexerAccount | null> {
  if (owner === INDEXER_HOOK_PROGRAM) {
    // Only the two role-state singletons are mirrored; BlockEntry, the
    // blocklist authority, per-mint configs and the TLV meta lists are not.
    if (bytes.length < 8) return null;
  } else if (owner !== INDEXER_PROGRAM) {
    return null; // ordinary wallet/token accounts are not program accounts
  } else if (bytes.length < 8) {
    throw new Error("Incomplete registry discriminator");
  }
  // rc.x AuthorityTransfer / BlocklistAuthorityTransfer: a known, inert layout
  // (lib/legacy-accounts.ts), never mirrored. The reconcile reports them.
  if (legacyAccountType(owner, bytes)) return null;
  const entry = ALL_INDEXER_ENTITIES.find((e) => e.program === owner && e.discriminator.every((b, i) => bytes[i] === b));
  if (!entry) return null; // valid program account type outside the mirror tables
  const row = await entry.decode(bytes, pdaAddress); // generated decoder enforces complete field lengths
  if (row.pda !== pdaAddress) throw new Error(`${entry.table} derived PDA does not match the snapshot address`);
  return { table: entry.table, row };
}
