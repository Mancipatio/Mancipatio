//! On-chain account state for the asset registry.
//!
//! Account model follows `docs/01-asset-registry-design.md` §3. Every account
//! carries a `version` byte so future major schema changes can ship idempotent
//! `migrate_*` instructions (docs/01 §9 Q7).

use anchor_lang::prelude::*;

// ── Enums ────────────────────────────────────────────────────────────────────
// NOTE: no explicit discriminants and no #[repr(u8)] — Anchor 1.0's
// AnchorSerialize macro rejects tagged enums (see Anchor 1.0 gotchas).

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum KybStatus {
    Pending,
    Verified,
    Rejected,
    Suspended,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AssetType {
    Equity,
    RevenueShare,
    Royalty,
    RealEstate,
    Debt,
    Commodity,
    /// Unique physical items. Share classes of a `PhysicalGood` asset are
    /// supply-1 by design (`add_share_class` enforces `max_supply == Some(1)`);
    /// physical settlement runs through `DeliveryEscrow` custody vaults.
    PhysicalGood,
    Other,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AssetStatus {
    Draft,
    Active,
    Frozen,
    WoundDown,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ShareClassType {
    Common,
    PreferredA,
    PreferredB,
    SeniorDebt,
    JuniorDebt,
    RevShareTier,
    RoyaltyTier,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum KycStatus {
    Pending,
    Approved,
    Revoked,
    Expired,
}

// ── Jurisdiction bitmaps ─────────────────────────────────────────────────────

/// Size in bytes of every jurisdiction bitmap (1024 bits). Bit N = ISO-3166-1
/// numeric country code N. The full ISO numeric range is 000–899 with 900–999
/// user-assigned, so 128 bytes covers every possible code — the original
/// 32-byte (256-bit) maps could not encode most of the world (Germany 276,
/// Serbia 688, Spain 724, UK 826 …).
///
/// ⚠ Layout constant: `transfer_hook` reads `KycRegistry` by raw offset and
/// mirrors this value; the hook-side constants are pinned by tests that link
/// both crates.
pub const JURISDICTION_BITMAP_BYTES: usize = 128;

// ── Shared sub-struct ────────────────────────────────────────────────────────

/// Transfer-eligibility policy attached to an `Asset`.
///
/// **Informational only — NOT enforced on-chain.** No program reads these
/// fields when validating a transfer; actual enforcement is the
/// `transfer_hook` program's KYC registry (sanctions blocklist on every
/// transfer, plus the optional per-mint KYC-gated mode). This struct is a
/// declared policy record that off-chain tooling may display or act on.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct JurisdictionRules {
    /// 1024-bit bitmap over ISO-3166 numeric country codes (bit N = country N).
    pub allowed_countries: [u8; JURISDICTION_BITMAP_BYTES],
    /// Maximum distinct holders; 0 = unlimited.
    pub max_holders: u32,
    /// Unix ts until which only whitelist transfers are allowed; 0 = none.
    pub restricted_period_end: i64,
    /// Whether peer-to-peer (non-launchpad / non-OTC) transfers are allowed.
    pub allow_p2p: bool,
}

// ── Accounts ─────────────────────────────────────────────────────────────────

/// Singleton. Seeds: `["platform"]`.
#[account]
#[derive(InitSpace)]
pub struct Platform {
    /// The super admin — the only key that may add or remove `Admin`s.
    pub admin: Pubkey,
    pub protocol_treasury: Pubkey,
    pub protocol_fee_bps: u16,
    /// Bitmask of `PAUSE_*` (constants.rs); byte 74, formerly `paused: bool`.
    /// 0 and 1 keep their old meaning (1 = onboarding paused).
    pub pause_flags: u8,
    pub issuers_count: u64,
    pub version: u8,
    pub bump: u8,
}

impl Platform {
    /// Whether any bit of `flag` is paused. Bits outside `PAUSE_FLAGS_ALL`
    /// gate nothing — no instruction asks for them.
    pub fn is_paused(&self, flag: u8) -> bool {
        self.pause_flags & flag != 0
    }
}

/// Marks a Mancipatio admin — the role that may issue mints, run custody and
/// other privileged operations. Created/removed by the super admin.
/// Seeds: `["admin", admin]`.
#[account]
#[derive(InitSpace)]
pub struct Admin {
    pub admin: Pubkey,
    pub added_by: Pubkey,
    pub bump: u8,
}

/// One per legal entity issuing assets. Seeds: `["issuer", legal_entity_id]`.
#[account]
#[derive(InitSpace)]
pub struct Issuer {
    pub authority: Pubkey,
    /// Client-supplied 32-byte legal-entity identifier (also the PDA seed).
    pub legal_entity_id: [u8; 32],
    /// ISO-3166 numeric country code of incorporation.
    pub jurisdiction: u16,
    pub kyb_status: KybStatus,
    /// SHA-256 of the off-chain KYB document bundle.
    pub kyb_doc_hash: [u8; 32],
    pub assets_count: u64,
    pub version: u8,
    pub bump: u8,
}

/// Parent container for one or more share classes.
/// Seeds: `["asset", issuer, asset_id]`.
#[account]
#[derive(InitSpace)]
pub struct Asset {
    pub issuer: Pubkey,
    #[max_len(32)]
    pub asset_id: String,
    pub asset_type: AssetType,
    #[max_len(64)]
    pub name: String,
    #[max_len(10)]
    pub symbol_prefix: String,
    /// SHA-256 of the off-chain legal documentation (term sheet, prospectus…).
    pub legal_doc_hash: [u8; 32],
    pub jurisdiction_rules: JurisdictionRules,
    pub status: AssetStatus,
    pub share_classes_count: u8,
    /// `None` = use the global KYC registry; `Some` = stricter per-issuer
    /// registry (extra restrictions only, never a relaxation). docs/01 §9.
    ///
    /// NOTE: Token-2022 permanent-delegate clawback is **always-on** — Mancipatio
    /// is the permanent delegate on every share-class mint (clawback / regulatory
    /// orders / forced delivery), applied at mint creation, not a per-asset flag
    /// (Answers for Mladen §2).
    pub extra_kyc_registry: Option<Pubkey>,
    pub version: u8,
    pub bump: u8,
}

/// One share class = one Token-2022 mint.
/// Seeds: `["share_class", asset, class_index]`.
#[account]
#[derive(InitSpace)]
pub struct ShareClass {
    pub asset: Pubkey,
    /// Token-2022 mint. `Pubkey::default()` until `initialize_share_class_mint`
    /// (next increment) creates the mint with the transfer-hook extension.
    pub mint: Pubkey,
    pub class_index: u8,
    pub class_type: ShareClassType,
    /// Bitfield of `RIGHT_*` flags (docs/01 §3).
    pub rights_bitfield: u8,
    /// Liquidation-preference multiplier in bps (10000 = 1.0x, 15000 = 1.5x).
    pub liq_pref_multiplier_bps: u16,
    /// Lower number = more senior in the liquidation waterfall.
    pub liq_seniority: u8,
    /// Votes per token unit.
    pub voting_weight: u32,
    /// Share class this one converts into, if any.
    pub convertible_to: Option<Pubkey>,
    /// Supply cap: lifetime for PhysicalGood, circulating for other assets.
    /// `None` = uncapped (never permitted for PhysicalGood).
    pub max_supply: Option<u64>,
    pub circulating_supply: u64,
    pub locked_supply: u64,
    /// docs/01 §9 Q6: post-launch minting (dilution) is gated behind this flag.
    pub mintable_post_launch: bool,
    /// Set once the Token-2022 mint has been created for this class.
    pub mint_initialized: bool,
    /// Once locked, no further minting unless `mintable_post_launch` is set.
    pub supply_locked: bool,
    pub version: u8,
    pub bump: u8,
    /// Cumulative issued units; burns never reduce this counter (v2).
    pub lifetime_minted: u64,
    /// PhysicalGood caps are cumulative; other assets retain circulating caps.
    pub cumulative_cap: bool,
}

/// Emitted by `set_convertible_to` — the share class's conversion target was
/// set (`Some`) or cleared (`None`).
#[event]
pub struct ConvertibleTargetSet {
    pub share_class: Pubkey,
    pub target: Option<Pubkey>,
}

/// Emitted by `mint_to_treasury` — primary emission outside a sale. `mint_to`
/// does not run the transfer hook, so this event is the indexable on-chain
/// record of who received treasury-minted units.
#[event]
pub struct TreasuryMinted {
    pub share_class: Pubkey,
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub destination_owner: Pubkey,
    pub amount: u64,
}

/// Emitted by `set_pause_flags` and `set_pause` — the emergency-pause bitmask
/// changed from `old` to `new`, signed by `by`.
#[event]
pub struct PauseFlagsChanged {
    pub old: u8,
    pub new: u8,
    pub by: Pubkey,
}

/// Emitted by `set_protocol_treasury` — the wallet whose token accounts
/// receive the protocol's share of routed yield changed.
#[event]
pub struct ProtocolTreasuryChanged {
    pub old: Pubkey,
    pub new: Pubkey,
    pub by: Pubkey,
}

/// KYC registry. docs/01 §9 Q1: the platform runs a global registry; an asset
/// may additionally point at a stricter per-issuer one via `extra_kyc_registry`.
/// Seeds: `["kyc_registry", creating authority]`. The address is permanent;
/// `authority` rotates via `propose_kyc_registry_authority` /
/// `accept_kyc_registry_authority`. Never re-derive the registry from
/// `authority` — take it by address (hook config, pinned front config).
/// `bump` keeps the bump of the ORIGINAL seeds and is no longer verified.
#[account]
#[derive(InitSpace)]
pub struct KycRegistry {
    /// KYC-provider multisig authorised to approve / revoke holders, rotate
    /// this authority and replace the jurisdiction bitmaps.
    pub authority: Pubkey,
    pub approved_jurisdictions: [u8; JURISDICTION_BITMAP_BYTES],
    pub blocked_jurisdictions: [u8; JURISDICTION_BITMAP_BYTES],
    pub entries_count: u64,
    pub version: u8,
    pub bump: u8,
}

/// Marks a registry-owned escrow authority PDA (OTC deal, offer, custody
/// vault or distribution). The `transfer_hook` program resolves
/// `["escrow_marker", token-account owner]` for both transfer legs and — when
/// the marker exists (owned by this program, non-empty) — exempts the leg from
/// the receiver-KYC checks in `KycGated` mode: the transfer is
/// platform-mediated (into or out of a program escrow), not wallet↔wallet.
/// Created alongside the escrow's parent account; closed on every terminal
/// path (settle / cancel / expire / realize / revert / return / close), rent
/// to the closing signer. Seeds: `["escrow_marker", owner_pda]`.
#[account]
#[derive(InitSpace)]
pub struct EscrowMarker {
    pub bump: u8,
}

/// Per-holder KYC record. Seeds: `["kyc", registry, holder]`.
#[account]
#[derive(InitSpace)]
pub struct KycEntry {
    pub registry: Pubkey,
    pub holder: Pubkey,
    pub status: KycStatus,
    pub jurisdiction: u16,
    /// 0 = retail, higher = accredited / qualified-investor tiers.
    pub accreditation_level: u8,
    /// Unix ts after which the entry is stale and transfers to the holder fail.
    pub expiry: i64,
    pub provider_id: u16,
    /// SHA-256 reference to the off-chain KYC dossier.
    pub external_ref_hash: [u8; 32],
    pub version: u8,
    pub bump: u8,
}

/// Emitted by `create_kyc_registry`.
#[event]
pub struct KycRegistryCreated {
    pub registry: Pubkey,
    pub authority: Pubkey,
}

/// Emitted by `approve_holder` — a holder was approved, or re-approved after
/// a revoke / expiry (`reapproval` distinguishes the two).
#[event]
pub struct HolderApproved {
    pub registry: Pubkey,
    pub holder: Pubkey,
    pub jurisdiction: u16,
    pub accreditation_level: u8,
    pub expiry: i64,
    pub provider_id: u16,
    pub reapproval: bool,
    /// The registry authority that signed. The registry address no longer
    /// implies the approver once the authority has rotated (2C-1).
    pub authority: Pubkey,
}

/// Emitted by `revoke_holder`.
#[event]
pub struct HolderRevoked {
    pub registry: Pubkey,
    pub holder: Pubkey,
    /// The registry authority that signed (see `HolderApproved::authority`).
    pub authority: Pubkey,
}

/// Emitted by `propose_kyc_registry_authority` (a re-proposal overwrites the
/// pending one and emits again).
#[event]
pub struct KycRegistryAuthorityProposed {
    pub registry: Pubkey,
    pub current_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted by `cancel_kyc_registry_authority_transfer`.
#[event]
pub struct KycRegistryAuthorityProposalCancelled {
    pub registry: Pubkey,
    pub authority: Pubkey,
    pub cancelled_new_authority: Pubkey,
}

/// Emitted by `accept_kyc_registry_authority` — the registry address is
/// unchanged; only its `authority` moved.
#[event]
pub struct KycRegistryAuthorityChanged {
    pub registry: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted by `update_kyc_registry_jurisdictions` — both bitmaps were replaced
/// whole (the new values are carried for audit).
#[event]
pub struct KycRegistryJurisdictionsUpdated {
    pub registry: Pubkey,
    pub authority: Pubkey,
    pub approved_jurisdictions: [u8; JURISDICTION_BITMAP_BYTES],
    pub blocked_jurisdictions: [u8; JURISDICTION_BITMAP_BYTES],
}

/// Why a clawback was allowed — the holder's entry was revoked outright, or it
/// simply lapsed. Kept on the event so an audit can tell a sanction apart from
/// a paperwork expiry.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClawbackReason {
    Revoked,
    Expired,
}

/// Emitted by `clawback_from_holder` — a revoked / KYC-expired holder's units
/// were seized into a burn-only quarantine vault via the mint's permanent
/// delegate. `registry` is the registry the mint's hook config names (the
/// instruction pins it), so the trail cannot cite a throwaway registry.
#[event]
pub struct HolderClawback {
    pub share_class: Pubkey,
    pub mint: Pubkey,
    pub registry: Pubkey,
    pub holder: Pubkey,
    pub destination: Pubkey,
    /// The `CustodyVault` (RedemptionQueue) owning `destination`.
    pub custody_vault: Pubkey,
    pub reason: ClawbackReason,
    pub amount: u64,
}

// ── CustodyVault — the mint → custody → burn primitive (docs/01 §3) ───────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VaultType {
    /// Startup vested tokens released on a schedule.
    Vesting,
    /// Equity token held pending an off-chain share conversion.
    ConversionPending,
    /// RWA token locked pending physical delivery — also the type the platform
    /// uses for a holder's equity conversion. Its realize (the conversion or
    /// delivery itself) is KYC-gated: the vault pins a `KycRegistry` at open
    /// and `realize_custody_vault` requires the beneficiary's Approved,
    /// unexpired, jurisdiction-allowed `KycEntry` in it (2C-3). Without one
    /// the beneficiary's deposit leaves through `return_custody_vault`.
    DeliveryEscrow,
    /// Token held in a treasury buyback / redemption queue.
    RedemptionQueue,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RealizeAction {
    /// Burn the escrowed tokens and emit an on-chain attestation.
    BurnAndAttest,
    /// Transfer the escrowed tokens to the beneficiary (vesting release).
    TransferToBeneficiary,
    /// Burn the escrowed tokens and pay the seller in a stable token.
    BurnAndPayout,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VaultState {
    Active,
    Triggered,
    Realized,
    Reverted,
    Expired,
    /// Delivery-escrow vault whose tokens were returned to the beneficiary
    /// (tokens re-enter circulation — nothing is burned). Appended last so
    /// existing discriminants keep their values.
    Returned,
}

/// Generic custody escrow — the unifying mint → custody → burn primitive that
/// serves vesting, conversion and delivery. Seeds: `["custody", share_class, vault_id]`.
#[account]
#[derive(InitSpace)]
pub struct CustodyVault {
    pub share_class: Pubkey,
    pub mint: Pubkey,
    /// Token-2022 escrow account holding the custodied tokens; its authority is
    /// this `CustodyVault` PDA.
    pub escrow: Pubkey,
    pub vault_id: u64,
    /// Who may `trigger` the vault.
    pub authority: Pubkey,
    pub vault_type: VaultType,
    pub realize_action: RealizeAction,
    /// Expected custodied amount (informational; escrow balance is source of truth).
    pub amount: u64,
    pub state: VaultState,
    /// Unix ts after which the vault may be reverted.
    pub deadline: i64,
    /// SHA-256 of the off-chain agreement / conversion document.
    pub metadata_hash: [u8; 32],
    /// Recipient of `return_custody_vault` (DeliveryEscrow only).
    /// `Pubkey::default()` when unused.
    pub beneficiary: Pubkey,
    pub version: u8,
    pub bump: u8,
    /// **Deposit ledger** — the running total the beneficiary has put into this
    /// escrow through `deposit_to_custody_vault` (the only instruction that
    /// increments it). It is what makes `return_custody_vault`'s KYC exemption
    /// evidence-based instead of assumed: a return of at most `deposited` is a
    /// refund of the beneficiary's OWN units and needs no receiver KYC (a
    /// lapsed passport must never strand a holder's deposit), while anything
    /// beyond it did not come from the beneficiary — the only other way units
    /// can land in the escrow is a raw `transfer_checked` from elsewhere (e.g.
    /// freshly emitted treasury units) — and is released only to a receiver
    /// whose `KycEntry` passes. Appended last so the account's existing byte
    /// layout is unchanged up to `bump`.
    pub deposited: u64,
    /// KYC registry pinned by `open_custody_vault` (DeliveryEscrow only;
    /// `Pubkey::default()` otherwise). `realize_custody_vault` requires the
    /// beneficiary's Approved, unexpired, jurisdiction-allowed `KycEntry` in
    /// it. Appended last (v2, `CUSTODY_STATE_VERSION`): bytes 237..269.
    pub kyc_registry: Pubkey,
}

/// Emitted by `deposit_to_custody_vault` — the beneficiary funded the escrow
/// with their own units; `total_deposited` is the ledger after the deposit.
#[event]
pub struct CustodyDeposited {
    pub custody_vault: Pubkey,
    pub mint: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub total_deposited: u64,
}

/// Emitted by `realize_custody_vault` with `BurnAndAttest` — the on-chain
/// attestation that the custodied tokens were consumed (e.g. equity converted).
#[event]
pub struct CustodyRealized {
    pub custody_vault: Pubkey,
    pub mint: Pubkey,
    pub burned: u64,
    pub metadata_hash: [u8; 32],
    /// The beneficiary whose KYC this realize checked (DeliveryEscrow);
    /// default for every other type, even one that stored a beneficiary —
    /// the event never names an unchecked beneficiary.
    pub beneficiary: Pubkey,
    /// The registry the beneficiary's KYC was checked in (DeliveryEscrow;
    /// default otherwise).
    pub kyc_registry: Pubkey,
}

/// Emitted by `revert_custody_vault` — the custodied tokens were returned
/// (v0.1: burned) after the vault's deadline passed without realization.
#[event]
pub struct CustodyReverted {
    pub custody_vault: Pubkey,
    pub mint: Pubkey,
    pub burned: u64,
}

/// Emitted by `return_custody_vault` — the escrowed tokens of a
/// `DeliveryEscrow` vault were transferred back to the beneficiary
/// (tokens re-enter circulation — nothing is burned).
#[event]
pub struct CustodyReturned {
    pub custody_vault: Pubkey,
    pub mint: Pubkey,
    pub returned: u64,
    pub beneficiary: Pubkey,
    /// Units left in the escrow because they exceeded the deposit ledger and
    /// the beneficiary could not pass receiver-KYC for the surplus.
    pub withheld: u64,
    /// False when `withheld > 0`: the vault stays open (state unchanged, escrow
    /// marker alive) and a second return is possible. Consumers must not treat
    /// this event as a transition to `Returned` unless this is true — the event
    /// was emitted unconditionally before the split payout existed, so an
    /// indexer keying off its mere presence would show the wrong state.
    pub terminal: bool,
}

// ── Launchpad — primary sale (Faza 2) ────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum SaleStatus {
    Open,
    Closed,
}

/// A primary sale of a share class. Seeds: `["sale", share_class, sale_id]`.
#[account]
#[derive(InitSpace)]
pub struct Sale {
    pub share_class: Pubkey,
    /// Share-class Token-2022 mint being sold.
    pub mint: Pubkey,
    /// Payment mint (e.g. USDC) buyers pay in.
    pub payment_mint: Pubkey,
    /// Escrow token account (payment mint) collecting proceeds.
    pub proceeds: Pubkey,
    /// Issuer authority that opened the sale.
    pub authority: Pubkey,
    pub sale_id: u64,
    /// Payment-token base units per one share-class unit.
    pub price_per_unit: u64,
    pub total_for_sale: u64,
    pub sold: u64,
    pub start_ts: i64,
    /// 0 = no end.
    pub end_ts: i64,
    pub status: SaleStatus,
    /// Disbursement type, fixed at sale open (investors see it before buying).
    pub raise_type: RaiseType,
    /// Startup: months with no payout before first tranche.
    pub cliff_months: u8,
    /// Startup: total vesting horizon in months.
    pub vesting_months: u8,
    pub version: u8,
    pub bump: u8,
    // ── v2 (`SALE_STATE_VERSION`): appended, every v1 offset is unchanged ──
    /// The `SaleApproval` that `open_sale` consumed (and closed).
    pub sale_approval: Pubkey,
    /// Copied from the approval: commitment to the reviewed application.
    pub application_hash: [u8; 32],
}

/// An Admin's approval to open exactly one sale. Seeds:
/// `["sale_approval", share_class, sale_id LE]`. Consumed and closed by
/// `open_sale`, or closed by `revoke_sale_approval`; the rent always returns to
/// `approved_by`.
///
/// ⚠ Layout: the field order is fixed so `issuer` sits at byte offset 48 (the
/// issuer launchpad lists its approvals with a memcmp at that offset) and
/// `approved_by` at 177 (an Admin's approvals, listed when the Admin is
/// removed). Later fields are appended after `version`.
#[account]
#[derive(InitSpace)]
pub struct SaleApproval {
    /// Byte 8.
    pub share_class: Pubkey,
    /// Byte 40.
    pub sale_id: u64,
    /// Byte 48: the `Issuer` PDA (not its authority), so an approval
    /// survives an issuer authority rotation.
    pub issuer: Pubkey,
    pub payment_mint: Pubkey,
    /// Payment-mint base units; `price_per_unit * total_for_sale` must not exceed it.
    pub max_gross_raise: u64,
    pub min_price_per_unit: u64,
    pub max_price_per_unit: u64,
    pub raise_type: RaiseType,
    /// Unix ts; `open_sale` is refused after it.
    pub expires_at: i64,
    /// sha256 of the canonical reviewed-application snapshot (kept off-chain).
    pub application_hash: [u8; 32],
    /// The approving Admin; receives the rent on consume / revoke. `open_sale`
    /// also requires this key to still hold its Admin record.
    pub approved_by: Pubkey,
    pub bump: u8,
    pub version: u8,
    /// Byte 211. The Startup payout schedule the sale must use exactly (the
    /// reviewed application's terms); both 0 for a Mature raise.
    pub cliff_months: u8,
    /// Byte 212. Startup: greater than `cliff_months`.
    pub vesting_months: u8,
}

/// Emitted by `approve_sale`.
#[event]
pub struct SaleApproved {
    pub sale_approval: Pubkey,
    pub share_class: Pubkey,
    pub sale_id: u64,
    pub issuer: Pubkey,
    pub payment_mint: Pubkey,
    pub max_gross_raise: u64,
    pub min_price_per_unit: u64,
    pub max_price_per_unit: u64,
    pub raise_type: RaiseType,
    pub expires_at: i64,
    pub application_hash: [u8; 32],
    pub approved_by: Pubkey,
    pub cliff_months: u8,
    pub vesting_months: u8,
}

/// Emitted by `revoke_sale_approval`.
#[event]
pub struct SaleApprovalRevoked {
    pub sale_approval: Pubkey,
    pub share_class: Pubkey,
    pub sale_id: u64,
    pub revoked_by: Pubkey,
    pub rent_to: Pubkey,
}

/// Emitted by `open_sale` when it consumes (and closes) the approval.
#[event]
pub struct SaleApprovalConsumed {
    pub sale_approval: Pubkey,
    pub sale: Pubkey,
    pub share_class: Pubkey,
    pub sale_id: u64,
    pub price_per_unit: u64,
    pub total_for_sale: u64,
    pub approved_by: Pubkey,
}

// ── OTC secondary market (Faza 3) ────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum OfferStatus {
    Open,
    Filled,
    Cancelled,
    /// Expired past `expires_at` and swept by `expire_offer`. Appended last so
    /// existing discriminants keep their values.
    Expired,
}

/// An OTC sell offer for share-class units. Seeds: `["offer", share_class, offer_id]`.
/// docs/05.
#[account]
#[derive(InitSpace)]
pub struct Offer {
    pub maker: Pubkey,
    pub share_class: Pubkey,
    /// Share-class Token-2022 mint being sold.
    pub mint: Pubkey,
    /// Offer-PDA-owned escrow holding the maker's deposited share units.
    pub escrow: Pubkey,
    /// Payment mint the taker pays in.
    pub payment_mint: Pubkey,
    /// Share-class units offered.
    pub amount: u64,
    /// Total price in payment-token base units.
    pub price: u64,
    pub status: OfferStatus,
    pub offer_id: u64,
    /// Unix ts after which the offer can no longer be taken and anyone may
    /// `expire_offer` it (escrow returns to the maker). 0 = never expires.
    pub expires_at: i64,
    pub version: u8,
    pub bump: u8,
    /// **Deposit ledger** — the running total the MAKER has put into this
    /// offer's escrow through `deposit_to_offer_escrow` (the only instruction
    /// that increments it). `create_offer` is permissionless and opens an EMPTY
    /// escrow, and that escrow is an ordinary Token-2022 account anyone can
    /// `transfer_checked` into, so "whatever sits in the escrow is the maker's"
    /// is not a fact the chain knows — it has to be recorded. Every escrow→
    /// wallet exit (`cancel_offer` / `expire_offer`) releases at most this much
    /// without a receiver-KYC check, and `take_offer` refuses to sell units the
    /// maker never deposited. Appended last so the existing byte layout up to
    /// `bump` is unchanged.
    pub deposited: u64,
}

/// Emitted by `deposit_to_offer_escrow` — the maker funded their own offer;
/// `total_deposited` is the ledger after the deposit.
#[event]
pub struct OfferDeposited {
    pub offer: Pubkey,
    pub mint: Pubkey,
    pub maker: Pubkey,
    pub amount: u64,
    pub total_deposited: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum OtcDealStatus {
    Open,
    Completed,
    Expired,
    Cancelled,
}

/// A bilateral (two-party) OTC escrow between a named buyer and seller.
/// The platform creates the deal after the parties agree off-chain; both
/// deposit, and once both escrows are funded the swap settles atomically.
/// If the deal expires (or an admin cancels) with only one side funded, the
/// deposit is refunded. Seeds: `["otc_deal", share_class, deal_id]`.
#[account]
#[derive(InitSpace)]
pub struct OtcDeal {
    /// Admin that created the deal (also the signer of `cancel_otc_deal`).
    pub admin: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub share_class: Pubkey,
    /// Share-class Token-2022 mint being sold.
    pub mint: Pubkey,
    /// Payment mint the buyer pays in.
    pub payment_mint: Pubkey,
    /// Deal-PDA-owned escrow holding the seller's deposited share units.
    pub asset_escrow: Pubkey,
    /// Deal-PDA-owned escrow holding the buyer's deposited payment.
    pub payment_escrow: Pubkey,
    /// Share-class units the seller deposits.
    pub amount: u64,
    /// Total price in payment-token base units the buyer deposits.
    pub price: u64,
    pub asset_deposited: bool,
    pub payment_deposited: bool,
    pub status: OtcDealStatus,
    pub deal_id: u64,
    /// Unix ts after which anyone may `expire_otc_deal` it (deposits are
    /// refunded). 0 = never expires.
    pub expires_at: i64,
    pub version: u8,
    pub bump: u8,
    /// **Deposit ledger (asset leg)** — share units the SELLER actually moved
    /// into `asset_escrow` through `deposit_otc_asset` (always exactly
    /// `amount`; recorded rather than assumed). The refund paths cap the
    /// KYC-free payout to the seller at this number: the escrow is an ordinary
    /// token account, so anyone — including the admin who named both parties —
    /// can raw-`transfer_checked` extra units into it, and sweeping the live
    /// balance would hand those units to a wallet the chain never vetted.
    /// Appended last so the existing byte layout up to `bump` is unchanged.
    pub asset_deposited_amount: u64,
    /// **Deposit ledger (payment leg)** — payment units the BUYER actually
    /// moved into `payment_escrow` through `deposit_otc_payment` (always
    /// exactly `price`). The payment mint carries no transfer hook, so this is
    /// not a KYC control; it stops a refund from paying out value the buyer
    /// never deposited.
    pub payment_deposited_amount: u64,
}

// ── Revenue distribution — push-based pro-rata payouts (business-doc §2–§5) ──

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum DistributionStatus {
    /// Created but not yet funded (transient — `create_distribution` funds and
    /// flips straight to `Distributing`).
    Funding,
    Distributing,
    Closed,
}

/// A push-based pro-rata revenue distribution for a share class: the issuer
/// funds the escrow in one go and the program pays out holder-proportionate
/// batches computed off-chain from a holder snapshot.
/// Seeds: `["distribution", share_class, distribution_id]`.
#[account]
#[derive(InitSpace)]
pub struct Distribution {
    /// Admin that created the distribution.
    pub admin: Pubkey,
    /// Wallet that funded the escrow — `close_distribution` may only sweep the
    /// remainder to a token account owned by it (and sends the escrow's rent
    /// there too).
    pub funder: Pubkey,
    pub share_class: Pubkey,
    /// Share-class Token-2022 mint the distribution relates to (indexing).
    pub mint: Pubkey,
    /// Payment mint being distributed (e.g. USDT).
    pub payment_mint: Pubkey,
    /// Distribution-PDA-owned escrow holding the payment tokens.
    pub escrow: Pubkey,
    /// Total payment-token units funded for this distribution.
    pub total_amount: u64,
    /// Share supply the off-chain pro-rata was computed against
    /// (informational on-chain record).
    pub snapshot_supply: u64,
    /// Cumulative payment-token units paid out so far.
    pub distributed_amount: u64,
    /// Cumulative number of payouts executed so far.
    pub paid_count: u32,
    pub status: DistributionStatus,
    pub distribution_id: u64,
    pub version: u8,
    pub bump: u8,
}

/// Emitted by `distribute_batch` once per payout.
#[event]
pub struct YieldPaid {
    pub distribution: Pubkey,
    /// Recipient payment-token account.
    pub recipient: Pubkey,
    pub amount: u64,
}

// ── Governance — advisory voting (Faza 4) ────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ProposalStatus {
    Active,
    Finalized,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ProposalOutcome {
    Pending,
    Passed,
    Rejected,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VoteChoice {
    For,
    Against,
    Abstain,
}

/// An advisory governance proposal for a share class. Votes are weighted by a
/// holder snapshot (Merkle root); the outcome is signaling only — no on-chain
/// execution. Seeds: `["proposal", share_class, proposal_id]`. docs/01 §10.
#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub share_class: Pubkey,
    /// Admin that created the proposal.
    pub authority: Pubkey,
    pub proposal_id: u64,
    /// SHA-256 of the off-chain proposal text.
    pub metadata_hash: [u8; 32],
    /// Slot at which the holder snapshot was taken.
    pub snapshot_slot: u64,
    /// Merkle root of the `(voter, weight)` snapshot.
    pub snapshot_root: [u8; 32],
    pub start_ts: i64,
    pub end_ts: i64,
    pub for_weight: u64,
    pub against_weight: u64,
    pub abstain_weight: u64,
    pub status: ProposalStatus,
    pub outcome: ProposalOutcome,
    pub version: u8,
    pub bump: u8,
}

/// A holder's vote on a proposal — its existence prevents double-voting.
/// Seeds: `["vote", proposal, voter]`.
#[account]
#[derive(InitSpace)]
pub struct VoteRecord {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub choice: VoteChoice,
    pub weight: u64,
    pub bump: u8,
}

// ── Rights Token — vesting-claim layer (Faza 5, docs/03) ─────────────────────

/// Links a Rights-Token share class to an underlying token that vests to its
/// holders through milestone Merkle claims. Seeds: `["rights", share_class,
/// issuance_id]`.
#[account]
#[derive(InitSpace)]
pub struct RightsIssuance {
    /// The Rights-Token share class whose holders are entitled to the underlying.
    pub share_class: Pubkey,
    /// The underlying token delivered at each milestone.
    pub underlying_mint: Pubkey,
    /// Escrow holding the underlying tokens; authority is this `RightsIssuance` PDA.
    pub escrow: Pubkey,
    /// Admin that opened the issuance.
    pub authority: Pubkey,
    pub issuance_id: u64,
    pub total_claimed: u64,
    pub milestones_count: u16,
    pub version: u8,
    pub bump: u8,
}

/// One vesting milestone — a pool of underlying tokens claimable against a
/// Rights-Token holder snapshot. Seeds: `["rt_milestone", issuance, index]`.
#[account]
#[derive(InitSpace)]
pub struct VestingMilestone {
    pub issuance: Pubkey,
    pub index: u16,
    /// Merkle root of `(claimer, entitlement)` — the holder snapshot.
    pub merkle_root: [u8; 32],
    /// Total underlying claimable in this milestone.
    pub amount_pool: u64,
    pub claimed: u64,
    /// Claims open once `unix_timestamp >= unlock_ts`.
    pub unlock_ts: i64,
    pub version: u8,
    pub bump: u8,
}

/// Records a holder's claim against a milestone — prevents double-claiming.
/// Seeds: `["rt_claim", milestone, claimer]`.
#[account]
#[derive(InitSpace)]
pub struct MilestoneClaim {
    pub milestone: Pubkey,
    pub claimer: Pubkey,
    pub amount: u64,
    pub bump: u8,
}

// ── PayoutVault — proceeds disbursement ──

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RaiseType {
    /// Established company — proceeds disbursed in full at close (close_sale).
    Mature,
    /// Startup — proceeds vested to founder over months, update-gated.
    Startup,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PayoutVaultState {
    Active,
    Frozen,
    Completed,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VaultVoteChoice {
    ReturnCapital,
    Extend,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VaultVoteOutcome {
    Pending,
    ReturnCapital,
    Extend,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ClaimKind {
    Refund,
    InvestorYield,
}

/// Holds the proceeds (payment mint) of one sale and disburses them to the
/// founder. Seeds: `["payout", sale]`.
#[account]
#[derive(InitSpace)]
pub struct PayoutVault {
    pub sale: Pubkey,
    pub share_class: Pubkey,
    pub payment_mint: Pubkey,
    /// Payment-token escrow token account; authority = this vault PDA.
    pub escrow: Pubkey,
    /// Beneficiary (issuer authority).
    pub founder: Pubkey,
    pub raise_type: RaiseType,
    pub total_amount: u64,
    pub released: u64,
    // vesting (Startup only)
    pub start_ts: i64,
    pub cliff_months: u8,
    pub vesting_months: u8,
    /// = vesting_months - cliff_months. Capped at 255 (u8) — ~21 years, ample.
    pub num_tranches: u8,
    pub tranche_amount: u64,
    pub tranches_released: u8,
    pub updates_posted: u32,
    pub last_update_ts: i64,
    // yield accounting
    pub founder_yield_claimable: u64,
    pub investor_yield_pool: u64,
    pub investor_yield_root: [u8; 32],
    pub total_weight: u64,
    // meta
    pub state: PayoutVaultState,
    pub metadata_hash: [u8; 32],
    pub version: u8,
    pub bump: u8,
    /// Most recently opened vote round (v2); the first round is 1.
    pub vote_round: u64,
    pub vote_pending: bool,
}

impl PayoutVault {
    /// Unix timestamp at which the OLDEST unfulfilled founder update becomes
    /// due: the `n`-th update (0-indexed, `n == updates_posted`) is owed at
    /// `start_ts + n * MONTH` — the same period start `post_update` enforces.
    pub fn oldest_due_ts(&self) -> Result<i64> {
        use crate::constants::MONTH;
        use crate::error::RegistryError;
        self.start_ts
            .checked_add(
                (self.updates_posted as i64)
                    .checked_mul(MONTH)
                    .ok_or(RegistryError::Overflow)?,
            )
            .ok_or_else(|| RegistryError::Overflow.into())
    }

    /// Whole periods the oldest unfulfilled update is overdue at `now`,
    /// counting the period that contains `now` (due date reached → 1), and 0
    /// while it is not yet due. Measured UNCAPPED from the oldest unfulfilled
    /// obligation — never as `min(periods_elapsed, num_tranches) -
    /// updates_posted`. This is the single source of truth shared by
    /// `freeze_vault` (freeze iff `>= MISSED_FREEZE_THRESHOLD`) and the Extend
    /// branch of `finalize_vault_vote` (shift the schedule by exactly this many
    /// months so the founder is current again); the two must never drift, or
    /// an Extend could leave the vault immediately re-freezable.
    pub fn overdue_periods(&self, now: i64) -> Result<i64> {
        use crate::constants::MONTH;
        let due = self.oldest_due_ts()?;
        Ok(if now < due {
            0
        } else {
            ((now - due) / MONTH) + 1
        })
    }
}

/// Investor vote opened when a vault is frozen. Seeds: `["vaultvote", payout_vault, round_le]`.
#[account]
#[derive(InitSpace)]
pub struct VaultVote {
    pub payout_vault: Pubkey,
    pub snapshot_root: [u8; 32],
    pub start_ts: i64,
    pub end_ts: i64,
    pub return_weight: u64,
    pub extend_weight: u64,
    pub outcome: VaultVoteOutcome,
    pub version: u8,
    pub bump: u8,
    /// Binds this immutable snapshot/outcome to one vault freeze round (v2).
    pub round: u64,
}

/// One investor's vote. Seeds: `["vvrec", vault_vote, voter]`.
#[account]
#[derive(InitSpace)]
pub struct VaultVoteRecord {
    pub vault_vote: Pubkey,
    pub voter: Pubkey,
    pub weight: u64,
    pub choice: VaultVoteChoice,
    pub version: u8,
    pub bump: u8,
}

/// Tracks cumulative drawn for refund / investor-yield claims.
/// Seeds: `["pv_claim", payout_vault, [kind as u8], investor]`.
#[account]
#[derive(InitSpace)]
pub struct ClaimRecord {
    pub payout_vault: Pubkey,
    pub investor: Pubkey,
    pub kind: ClaimKind,
    pub claimed: u64,
    pub version: u8,
    pub bump: u8,
}

// ── Vesting series — client self-serve token vesting (spec: "11. Vesting — Mancipatio") ──
//
// A Vesting series locks a client's OWN tokens into a program escrow and
// releases them to fixed recipient positions on a schedule fixed at creation.
// Unlike the Rights-Token flow (transferable, snapshot/Merkle, admin-run),
// positions here are non-transferable per-recipient accounts and every
// authority (approval, recovery, cancellation) sits with the CLIENT wallet —
// Mancipatio holds no key over the escrow.

/// Timing mode — fixed at creation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VestingTimingMode {
    /// Tranches become deliverable at their `unlock_ts`, no intervention.
    Auto,
    /// Each tranche needs the client's approval before it goes out — but
    /// approval can only DELAY, never freeze: once `unlock_ts +
    /// approval_window_secs` passes without action, the tranche is
    /// deliverable anyway.
    Approval,
}

/// Delivery mode — fixed at creation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VestingDeliveryMode {
    /// Anyone may trigger delivery to the recipient's current wallet.
    Push,
    /// The recipient pulls their vested amount.
    Claim,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VestingSeriesStatus {
    Active,
    /// Cancelled by the client (only when `cancellation_enabled`). Vested
    /// entitlements stay claimable forever; the unvested remainder is
    /// withdrawable by the client via `withdraw_unvested`.
    Cancelled,
    /// Composition is editable, but no entitlement exists before finalization.
    /// Appended to preserve existing Active/Cancelled discriminants.
    Draft,
}

/// One schedule entry — `amount` units (across ALL positions, pro-rata to
/// each position's allocation) unlock at `unlock_ts`. The full schedule is
/// stored in the series account and is immutable after creation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct VestingTranche {
    pub unlock_ts: i64,
    pub amount: u64,
}

/// A vesting series — one token, one schedule, N recipient positions.
/// Seeds: `["vesting_series", authority, series_id]`.
#[account]
#[derive(InitSpace)]
pub struct VestingSeries {
    /// The client wallet — approval / recovery / cancellation authority.
    pub authority: Pubkey,
    /// The token being vested (any SPL / Token-2022 mint).
    pub token_mint: Pubkey,
    /// Escrow token account holding the deposits; authority is this PDA.
    pub escrow: Pubkey,
    pub series_id: u64,
    /// Sum of all position allocations. Frozen when Draft is finalized to Active.
    pub total_allocated: u64,
    /// Deposit ledger — only `deposit_to_vesting_escrow` writes it.
    pub deposited: u64,
    /// Cumulative released to recipients (claims + pushes).
    pub total_released: u64,
    pub timing_mode: VestingTimingMode,
    pub delivery_mode: VestingDeliveryMode,
    pub status: VestingSeriesStatus,
    /// Approval-mode window (seconds) after which an un-approved vested
    /// tranche becomes deliverable anyway. Fixed at creation; 0 in Auto mode.
    pub approval_window_secs: i64,
    /// Fixed forever at creation: the client may re-point a position to a
    /// replacement wallet (same recipient, lost keys).
    pub recovery_enabled: bool,
    /// Starts as chosen at creation; ON can be irrevocably turned OFF
    /// (`disable_vesting_cancellation`), never the reverse.
    pub cancellation_enabled: bool,
    /// % (bps of each allocation) recipients keep when cancelled before
    /// anything vested. Fixed at creation; 0 = "recipient gets nothing".
    pub pre_cliff_bps: u16,
    /// Bitmask of client-approved tranches (Approval mode; bit i = tranche i).
    pub approved_mask: u64,
    pub cancelled_at: i64,
    /// Vested cumulative frozen at cancellation (or the pre-cliff amount) —
    /// the post-cancel entitlement basis.
    pub final_cumulative: u64,
    pub positions_count: u32,
    pub created_at: i64,
    pub version: u8,
    pub bump: u8,
    /// The schedule — ascending `unlock_ts`, every `amount > 0`. The final
    /// tranche's cumulative must equal `total_allocated` once all positions
    /// are added (enforced at finalization, release and active cancellation).
    #[max_len(64)]
    pub tranches: Vec<VestingTranche>,
}

/// A recipient's position in a series — non-transferable by construction:
/// only the wallet currently recorded here can claim (Claim mode) or receive
/// (Push mode), and `recover_vesting_position` is the ONLY way that record
/// changes. Seeds: `["vesting_position", series, index]`.
#[account]
#[derive(InitSpace)]
pub struct VestingPosition {
    pub series: Pubkey,
    pub index: u32,
    /// Current recipient wallet — mutated only by recovery.
    pub wallet: Pubkey,
    pub allocation: u64,
    pub released: u64,
    pub version: u8,
    pub bump: u8,
}

/// Emitted by `create_vesting_series`.
#[event]
pub struct VestingSeriesCreated {
    pub series: Pubkey,
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub series_id: u64,
    pub tranches_count: u16,
}

/// Emitted by `add_vesting_position`.
#[event]
pub struct VestingPositionAdded {
    pub series: Pubkey,
    pub position: Pubkey,
    pub wallet: Pubkey,
    pub allocation: u64,
    pub total_allocated: u64,
}

/// Emitted by `deposit_to_vesting_escrow`.
#[event]
pub struct VestingDeposited {
    pub series: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub total_deposited: u64,
}

/// Emitted by `approve_vesting_tranche`.
#[event]
pub struct VestingTrancheApproved {
    pub series: Pubkey,
    pub tranche_index: u16,
    pub approved_mask: u64,
}

/// Emitted by `claim_vested` / `push_vested`.
#[event]
pub struct VestingReleased {
    pub series: Pubkey,
    pub position: Pubkey,
    pub wallet: Pubkey,
    pub amount: u64,
    pub total_released: u64,
}

/// Emitted by `recover_vesting_position`.
#[event]
pub struct VestingPositionRecovered {
    pub series: Pubkey,
    pub position: Pubkey,
    pub old_wallet: Pubkey,
    pub new_wallet: Pubkey,
}

/// Emitted by `cancel_vesting_series`.
#[event]
pub struct VestingSeriesCancelled {
    pub series: Pubkey,
    pub cancelled_at: i64,
    pub final_cumulative: u64,
}

/// Emitted by `disable_vesting_cancellation` — irreversible.
#[event]
pub struct VestingCancellationDisabled {
    pub series: Pubkey,
}

/// Emitted by `withdraw_unvested`.
#[event]
pub struct VestingUnvestedWithdrawn {
    pub series: Pubkey,
    pub wallet: Pubkey,
    pub amount: u64,
}

/// Emitted by `withdraw_vesting_surplus`; all unpaid allocations stay reserved.
#[event]
pub struct VestingSurplusWithdrawn {
    pub series: Pubkey,
    pub wallet: Pubkey,
    pub amount: u64,
}

/// An operational grant for one issuer authority; never confers global admin.
/// Seeds: ["issuer_permissions", issuer, authority].
#[account]
#[derive(InitSpace)]
pub struct IssuerPermissions {
    pub issuer: Pubkey,
    pub authority: Pubkey,
    pub capabilities: u8,
    pub updated_by: Pubkey,
    pub version: u8,
    pub bump: u8,
}

/// A staged operational authority change; no program upgrade authority changes.
/// Seeds: ["authority_transfer", target account].
#[account]
#[derive(InitSpace)]
pub struct AuthorityTransfer {
    pub target: Pubkey,
    pub current_authority: Pubkey,
    pub new_authority: Pubkey,
    pub proposed_by: Pubkey,
    pub bump: u8,
}

/// A super-admin recovery of a LOST issuer authority key, effective only after
/// a 7-day timelock and cancellable by the current issuer authority (or the
/// super admin) meanwhile. Seeds: `["issuer_recovery", issuer]`.
///
/// ⚠ Layout: the field order is fixed. Byte offsets: issuer 8,
/// current_authority 40, new_authority 72 (the same offset as
/// `AuthorityTransfer.new_authority`: the front lists both by a memcmp there),
/// proposed_by 104, proposed_at 136, eta 144, expires_at 152, version 160,
/// bump 161. Later fields are appended after `bump`.
#[account]
#[derive(InitSpace)]
pub struct IssuerRecovery {
    /// Byte 8: the Issuer PDA.
    pub issuer: Pubkey,
    /// Byte 40: `issuer.authority` when proposed; execute requires it to still
    /// be the live authority (a rotation in between makes the recovery stale).
    pub current_authority: Pubkey,
    /// Byte 72: the only key that can execute (it signs).
    pub new_authority: Pubkey,
    /// Byte 104: the proposing super admin; execute requires it to still be
    /// `platform.admin`. Receives every refund (this rent and the old grant's).
    pub proposed_by: Pubkey,
    /// Byte 136.
    pub proposed_at: i64,
    /// Byte 144: executable at or after this unix ts.
    pub eta: i64,
    /// Byte 152: `eta + ISSUER_RECOVERY_EXECUTION_WINDOW`; executable strictly before it.
    pub expires_at: i64,
    /// Byte 160: `STATE_VERSION`.
    pub version: u8,
    /// Byte 161.
    pub bump: u8,
}

/// How `Issuer.authority` changed (carried by `IssuerAuthorityChanged`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum IssuerAuthorityChangeKind {
    /// `accept_issuer_authority`: proposed by the current authority.
    Rotation,
    /// `execute_issuer_recovery`: proposed by the super admin, after the timelock.
    TimelockedRecovery,
    /// `recover_issuer_registration`: the instant two-signer path for an
    /// unverified, unused registration.
    RegistrationRecovery,
}

/// Emitted by `propose_issuer_authority` (a re-proposal emits again).
#[event]
pub struct IssuerAuthorityProposed {
    pub issuer: Pubkey,
    pub current_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted by `cancel_issuer_authority_transfer`.
#[event]
pub struct IssuerAuthorityProposalCancelled {
    pub issuer: Pubkey,
    pub authority: Pubkey,
    pub cancelled_new_authority: Pubkey,
}

/// Emitted whenever `Issuer.authority` changes. `old_grant_closed` says whether
/// an `IssuerPermissions` record of the old authority was closed;
/// `capabilities_carried` is what the new authority's record now holds (0 when
/// no record was written).
#[event]
pub struct IssuerAuthorityChanged {
    pub issuer: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
    pub kind: IssuerAuthorityChangeKind,
    pub capabilities_carried: u8,
    pub old_grant_closed: bool,
}

/// Emitted by `propose_issuer_recovery` (a re-proposal resets the timelock and
/// emits again).
#[event]
pub struct IssuerRecoveryProposed {
    pub issuer: Pubkey,
    pub current_authority: Pubkey,
    pub new_authority: Pubkey,
    pub proposed_by: Pubkey,
    pub eta: i64,
    pub expires_at: i64,
}

/// Emitted by `cancel_issuer_recovery`.
#[event]
pub struct IssuerRecoveryCancelled {
    pub issuer: Pubkey,
    pub cancelled_by: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted by `sync_sale_authority` when `Sale.authority` actually changed.
#[event]
pub struct SaleAuthoritySynced {
    pub sale: Pubkey,
    pub issuer: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted by `sync_payout_founder` when `PayoutVault.founder` actually changed.
#[event]
pub struct PayoutFounderSynced {
    pub vault: Pubkey,
    pub issuer: Pubkey,
    pub old_founder: Pubkey,
    pub new_founder: Pubkey,
}

/// Escrow identity is distinct from the general escrow-routing exemption.
/// Same PDA seed as EscrowMarker, separate discriminator: inbound routing is
/// exempt, ordinary outbound delivery is screened. Only a recorded refund owner
/// can use the narrowly ledger-backed refund route; zero means no such route.
#[account]
#[derive(InitSpace)]
pub struct EscrowIdentity {
    pub refund_owner: Pubkey,
    pub own_deposited: u64,
    pub own_refunded: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DistributionPlan {
    pub distribution: Pubkey,
    pub batch_root: [u8; 32],
    pub batch_count: u32,
    pub version: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DistributionBatch {
    pub distribution: Pubkey,
    pub batch_id: u32,
    pub batch_hash: [u8; 32],
    pub total_amount: u64,
    pub paid_count: u32,
    pub version: u8,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::*;

    fn platform(pause_flags: u8) -> Platform {
        Platform {
            admin: Pubkey::new_from_array([1; 32]),
            protocol_treasury: Pubkey::new_from_array([2; 32]),
            protocol_fee_bps: 0x0403,
            pause_flags,
            issuers_count: 7,
            version: 1,
            bump: 254,
        }
    }

    /// The devnet Platform is 85 bytes with the former `paused` byte at
    /// offset 74; the `pause_flags` rename must keep both.
    #[test]
    fn platform_layout_is_unchanged() {
        assert_eq!(8 + Platform::INIT_SPACE, 85);
        let mut data = Vec::new();
        platform(PAUSE_FLAGS_ALL).try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), 85);
        assert_eq!(&data[..8], Platform::DISCRIMINATOR);
        assert_eq!(data[8..40], [1; 32]);
        assert_eq!(data[40..72], [2; 32]);
        assert_eq!(data[72..74], [0x03, 0x04]);
        assert_eq!(data[74], 0x3F);
        assert_eq!(data[75..83], 7u64.to_le_bytes());
        assert_eq!(data[83], 1);
        assert_eq!(data[84], 254);
        let decoded = Platform::try_deserialize(&mut data.as_slice()).unwrap();
        assert_eq!(decoded.pause_flags, PAUSE_FLAGS_ALL);
    }

    /// `SaleApproval` is listed by the issuer launchpad with a memcmp on
    /// `issuer` at byte 48 and `dataSize` 213, and by approver at byte 177;
    /// all are pinned here.
    #[test]
    fn sale_approval_layout_is_pinned() {
        assert_eq!(8 + SaleApproval::INIT_SPACE, 213);
        let approval = SaleApproval {
            share_class: Pubkey::new_from_array([1; 32]),
            sale_id: 0x0807_0605_0403_0201,
            issuer: Pubkey::new_from_array([3; 32]),
            payment_mint: Pubkey::new_from_array([4; 32]),
            max_gross_raise: 5,
            min_price_per_unit: 6,
            max_price_per_unit: 7,
            raise_type: RaiseType::Startup,
            expires_at: 8,
            application_hash: [9; 32],
            approved_by: Pubkey::new_from_array([10; 32]),
            bump: 254,
            version: 1,
            cliff_months: 6,
            vesting_months: 24,
        };
        let mut data = Vec::new();
        approval.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), 213);
        assert_eq!(&data[..8], SaleApproval::DISCRIMINATOR);
        assert_eq!(data[8..40], [1; 32]);
        assert_eq!(data[40..48], 0x0807_0605_0403_0201u64.to_le_bytes());
        assert_eq!(data[48..80], [3; 32]);
        assert_eq!(data[80..112], [4; 32]);
        assert_eq!(data[112..120], 5u64.to_le_bytes());
        assert_eq!(data[120..128], 6u64.to_le_bytes());
        assert_eq!(data[128..136], 7u64.to_le_bytes());
        assert_eq!(data[136], 1); // RaiseType::Startup
        assert_eq!(data[137..145], 8i64.to_le_bytes());
        assert_eq!(data[145..177], [9; 32]);
        assert_eq!(data[177..209], [10; 32]);
        assert_eq!(data[209], 254);
        assert_eq!(data[210], 1);
        assert_eq!(data[211], 6);
        assert_eq!(data[212], 24);
    }

    /// Sale v2 appends two fields; every v1 offset stays where it was.
    #[test]
    fn sale_v2_appends_after_v1_layout() {
        assert_eq!(8 + Sale::INIT_SPACE, 286);
        let sale = Sale {
            share_class: Pubkey::new_from_array([1; 32]),
            mint: Pubkey::new_from_array([2; 32]),
            payment_mint: Pubkey::new_from_array([3; 32]),
            proceeds: Pubkey::new_from_array([4; 32]),
            authority: Pubkey::new_from_array([5; 32]),
            sale_id: 6,
            price_per_unit: 7,
            total_for_sale: 8,
            sold: 9,
            start_ts: 10,
            end_ts: 11,
            status: SaleStatus::Closed,
            raise_type: RaiseType::Startup,
            cliff_months: 12,
            vesting_months: 13,
            version: SALE_STATE_VERSION,
            bump: 253,
            sale_approval: Pubkey::new_from_array([14; 32]),
            application_hash: [15; 32],
        };
        let mut data = Vec::new();
        sale.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), 286);
        assert_eq!(&data[..8], Sale::DISCRIMINATOR);
        assert_eq!(data[8..40], [1; 32]);
        assert_eq!(data[40..72], [2; 32]);
        assert_eq!(data[72..104], [3; 32]);
        assert_eq!(data[104..136], [4; 32]);
        assert_eq!(data[136..168], [5; 32]);
        assert_eq!(data[168..176], 6u64.to_le_bytes());
        assert_eq!(data[176..184], 7u64.to_le_bytes());
        assert_eq!(data[184..192], 8u64.to_le_bytes());
        assert_eq!(data[192..200], 9u64.to_le_bytes());
        assert_eq!(data[200..208], 10i64.to_le_bytes());
        assert_eq!(data[208..216], 11i64.to_le_bytes());
        assert_eq!(data[216], 1); // SaleStatus::Closed
        assert_eq!(data[217], 1); // RaiseType::Startup
        assert_eq!(data[218], 12);
        assert_eq!(data[219], 13);
        assert_eq!(data[220], 2);
        assert_eq!(data[221], 253);
        assert_eq!(data[222..254], [14; 32]);
        assert_eq!(data[254..286], [15; 32]);
    }

    #[test]
    fn pause_bits_are_pinned() {
        assert_eq!(PAUSE_ONBOARDING, 0x01);
        assert_eq!(PAUSE_PRIMARY, 0x02);
        assert_eq!(PAUSE_SECONDARY, 0x04);
        assert_eq!(PAUSE_CUSTODY_ENTRY, 0x08);
        assert_eq!(PAUSE_DISTRIBUTIONS, 0x10);
        assert_eq!(PAUSE_ISSUER_PROCEEDS, 0x20);
        assert_eq!(PAUSE_FLAGS_ALL, 0x3F);
        // Legacy `paused = true` (byte 1) gates only onboarding.
        assert!(platform(1).is_paused(PAUSE_ONBOARDING));
        assert!(!platform(1).is_paused(PAUSE_PRIMARY));
        assert!(!platform(0).is_paused(PAUSE_FLAGS_ALL));
        // Undefined bits gate nothing.
        assert!(!platform(0xC0).is_paused(PAUSE_FLAGS_ALL));
    }
}
