//! Mancipatio asset registry (Faza 1).
//!
//! Source of truth for issuers, assets, share classes and KYC. Design:
//! `docs/01-asset-registry-design.md`. Token-2022 mint creation, the
//! `transfer_hook` wiring, the `CustodyVault` primitive and launchpad / OTC /
//! governance are later increments.

pub mod constants;
pub mod error;
pub mod instructions;
pub mod legacy;
pub mod state;
pub mod util;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS");

// Gated like the Anchor entrypoint: host test binaries link both programs'
// rlibs (the hook as a `no-entrypoint` dev-dependency), and two exported
// `SECURITY_TXT` symbols would collide.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Manci asset_registry",
    project_url: "https://www.manci.io",
    contacts: "email:security@mancipatio.io",
    policy: "https://www.manci.io/security",
    preferred_languages: "en",
    source_code: "https://github.com/Mancipatio/Mancipatio"
}

#[program]
pub mod asset_registry {
    use super::*;

    /// Creates the platform singleton. The signer becomes the platform admin.
    pub fn initialize_platform(
        ctx: Context<InitializePlatform>,
        protocol_treasury: Pubkey,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        instructions::handle_initialize_platform(ctx, protocol_treasury, protocol_fee_bps)
    }

    /// Grants/revokes issuer-local operational capabilities without global Admin.
    pub fn set_issuer_permissions(
        ctx: Context<SetIssuerPermissions>,
        capabilities: u8,
    ) -> Result<()> {
        instructions::handle_set_issuer_permissions(ctx, capabilities)
    }

    /// Recovers a Pending/Rejected legal-ID reservation with no existing assets.
    pub fn recover_issuer_registration(
        ctx: Context<RecoverIssuerRegistration>,
        jurisdiction: u16,
        kyb_doc_hash: [u8; 32],
    ) -> Result<()> {
        instructions::handle_recover_issuer_registration(ctx, jurisdiction, kyb_doc_hash)
    }

    pub fn propose_platform_admin(
        ctx: Context<ProposePlatformAdmin>,
        new_admin: Pubkey,
    ) -> Result<()> {
        instructions::handle_propose_platform_admin(ctx, new_admin)
    }
    pub fn accept_platform_admin(ctx: Context<AcceptPlatformAdmin>) -> Result<()> {
        instructions::handle_accept_platform_admin(ctx)
    }
    pub fn propose_custody_authority(
        ctx: Context<ProposeCustodyAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::handle_propose_custody_authority(ctx, new_authority)
    }
    pub fn accept_custody_authority(ctx: Context<AcceptCustodyAuthority>) -> Result<()> {
        instructions::handle_accept_custody_authority(ctx)
    }

    /// Legacy onboarding switch (super admin): sets / clears only
    /// `PAUSE_ONBOARDING`. The full emergency pause is `set_pause_flags`.
    pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
        instructions::handle_set_pause(ctx, paused)
    }

    /// Emergency pause: `flags = (flags | set_mask) & !clear_mask`. Any Admin
    /// may set defined bits; only the super admin may clear.
    pub fn set_pause_flags(
        ctx: Context<SetPauseFlags>,
        set_mask: u8,
        clear_mask: u8,
    ) -> Result<()> {
        instructions::handle_set_pause_flags(ctx, set_mask, clear_mask)
    }

    /// Super admin rotates the protocol treasury (nonzero key).
    pub fn set_protocol_treasury(
        ctx: Context<SetProtocolTreasury>,
        new_treasury: Pubkey,
    ) -> Result<()> {
        instructions::handle_set_protocol_treasury(ctx, new_treasury)
    }

    /// Super admin grants the admin role to `new_admin`.
    pub fn add_admin(ctx: Context<AddAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::handle_add_admin(ctx, new_admin)
    }

    /// Super admin revokes the admin role from `admin`.
    pub fn remove_admin(ctx: Context<RemoveAdmin>, admin: Pubkey) -> Result<()> {
        instructions::handle_remove_admin(ctx, admin)
    }

    /// Registers an issuer in `Pending` KYB state.
    pub fn prepare_legacy_account(ctx: Context<PrepareLegacyAccount>) -> Result<()> {
        handle_prepare_legacy_account(ctx)
    }

    pub fn register_vesting_escrow_identity(
        ctx: Context<RegisterVestingEscrowIdentity>,
    ) -> Result<()> {
        handle_register_vesting_escrow_identity(ctx)
    }
    pub fn register_rights_escrow_identity(
        ctx: Context<RegisterRightsEscrowIdentity>,
    ) -> Result<()> {
        handle_register_rights_escrow_identity(ctx)
    }

    pub fn register_issuer(
        ctx: Context<RegisterIssuer>,
        legal_entity_id: [u8; 32],
        jurisdiction: u16,
        kyb_doc_hash: [u8; 32],
    ) -> Result<()> {
        instructions::handle_register_issuer(ctx, legal_entity_id, jurisdiction, kyb_doc_hash)
    }

    /// Platform admin records the off-chain KYB decision.
    pub fn verify_issuer_kyb(ctx: Context<VerifyIssuerKyb>, approved: bool) -> Result<()> {
        instructions::handle_verify_issuer_kyb(ctx, approved)
    }

    /// Creates a `Draft` asset under a KYB-verified issuer.
    #[allow(clippy::too_many_arguments)]
    pub fn create_asset(
        ctx: Context<CreateAsset>,
        asset_id: String,
        asset_type: AssetType,
        name: String,
        symbol_prefix: String,
        legal_doc_hash: [u8; 32],
        jurisdiction_rules: JurisdictionRules,
    ) -> Result<()> {
        instructions::handle_create_asset(
            ctx,
            asset_id,
            asset_type,
            name,
            symbol_prefix,
            legal_doc_hash,
            jurisdiction_rules,
        )
    }

    /// Activates a `Draft` asset once its share classes are configured
    /// (admin). Minting and primary sales require an active asset.
    pub fn activate_asset(ctx: Context<ActivateAsset>) -> Result<()> {
        instructions::handle_activate_asset(ctx)
    }

    /// Adds a sequential share class to a draft asset.
    #[allow(clippy::too_many_arguments)]
    pub fn add_share_class(
        ctx: Context<AddShareClass>,
        class_index: u8,
        class_type: ShareClassType,
        rights_bitfield: u8,
        liq_pref_multiplier_bps: u16,
        liq_seniority: u8,
        voting_weight: u32,
        max_supply: Option<u64>,
        mintable_post_launch: bool,
    ) -> Result<()> {
        instructions::handle_add_share_class(
            ctx,
            class_index,
            class_type,
            rights_bitfield,
            liq_pref_multiplier_bps,
            liq_seniority,
            voting_weight,
            max_supply,
            mintable_post_launch,
        )
    }

    /// Creates the Token-2022 mint for a share class (TransferHook extension
    /// wired to the `transfer_hook` program; on-chain metadata via the
    /// MetadataPointer + TokenMetadata extensions).
    pub fn initialize_share_class_mint(ctx: Context<InitializeShareClassMint>) -> Result<()> {
        instructions::handle_initialize_share_class_mint(ctx)
    }

    /// Updates the on-chain metadata of a share-class mint — only the `uri`
    /// field may change (admin + issuer authority, ShareClass PDA signs).
    pub fn update_mint_metadata(
        ctx: Context<UpdateMintMetadata>,
        field: String,
        value: String,
    ) -> Result<()> {
        instructions::handle_update_mint_metadata(ctx, field, value)
    }

    /// Sets or clears a share class's conversion target (admin + issuer
    /// authority double gate). Pass `target_share_class` to set — it must be
    /// an existing share class of the same asset and not the class itself —
    /// or omit it to clear.
    pub fn set_convertible_to(ctx: Context<SetConvertibleTo>) -> Result<()> {
        instructions::handle_set_convertible_to(ctx)
    }

    /// Mints share-class units into a destination token account (Token-2022
    /// CPI signed by the `ShareClass` PDA).
    pub fn mint_to_treasury(ctx: Context<MintToTreasury>, amount: u64) -> Result<()> {
        instructions::handle_mint_to_treasury(ctx, amount)
    }

    /// Locks a share class's supply — closes minting (admin; audit finding M3).
    pub fn lock_supply(ctx: Context<LockSupply>) -> Result<()> {
        instructions::handle_lock_supply(ctx)
    }

    /// Opens a custody vault (`Active`) with an empty escrow token account.
    #[allow(clippy::too_many_arguments)]
    pub fn open_custody_vault(
        ctx: Context<OpenCustodyVault>,
        vault_id: u64,
        vault_type: VaultType,
        realize_action: RealizeAction,
        amount: u64,
        deadline: i64,
        metadata_hash: [u8; 32],
        beneficiary: Pubkey,
    ) -> Result<()> {
        instructions::handle_open_custody_vault(
            ctx,
            vault_id,
            vault_type,
            realize_action,
            amount,
            deadline,
            metadata_hash,
            beneficiary,
        )
    }

    /// Funds an `Active` custody vault's escrow from the depositor's own
    /// wallet and CREDITS the vault's deposit ledger. For a `DeliveryEscrow`
    /// the depositor must be the vault's `beneficiary` — the ledger is what
    /// lets `return_custody_vault` refund them without a receiver-KYC check.
    pub fn deposit_to_custody_vault<'info>(
        ctx: Context<'info, DepositToCustodyVault<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::handle_deposit_to_custody_vault(ctx, amount)
    }

    /// Moves a custody vault `Active → Triggered`.
    pub fn trigger_custody_vault(ctx: Context<TriggerCustodyVault>) -> Result<()> {
        instructions::handle_trigger_custody_vault(ctx)
    }

    /// Realizes a `Triggered` custody vault (v0.1: burn escrow + attest event).
    pub fn realize_custody_vault(ctx: Context<RealizeCustodyVault>) -> Result<()> {
        instructions::handle_realize_custody_vault(ctx)
    }

    /// Reverts an `Active` custody vault after its deadline (escape hatch).
    /// Forbidden for `DeliveryEscrow` vaults — use `return_custody_vault`.
    pub fn revert_custody_vault(ctx: Context<RevertCustodyVault>) -> Result<()> {
        instructions::handle_revert_custody_vault(ctx)
    }

    /// Returns a `DeliveryEscrow` vault's escrowed tokens to the beneficiary
    /// (no burn). Authority at any time; anyone once the deadline has passed.
    pub fn return_custody_vault<'info>(
        ctx: Context<'info, ReturnCustodyVault<'info>>,
    ) -> Result<()> {
        instructions::handle_return_custody_vault(ctx)
    }

    /// Admin approval to open exactly one sale (`share_class`, `sale_id`),
    /// bounded by payment mint, price range, maximum gross raise, raise type,
    /// Startup payout schedule (cliff / vesting months) and expiry (at most 90
    /// days). Consumed by `open_sale`.
    #[allow(clippy::too_many_arguments)]
    pub fn approve_sale(
        ctx: Context<ApproveSale>,
        sale_id: u64,
        max_gross_raise: u64,
        min_price_per_unit: u64,
        max_price_per_unit: u64,
        raise_type: RaiseType,
        expires_at: i64,
        application_hash: [u8; 32],
        cliff_months: u8,
        vesting_months: u8,
    ) -> Result<()> {
        instructions::handle_approve_sale(
            ctx,
            sale_id,
            max_gross_raise,
            min_price_per_unit,
            max_price_per_unit,
            raise_type,
            expires_at,
            application_hash,
            cliff_months,
            vesting_months,
        )
    }

    /// Closes an unused sale approval (any Admin; rent to the approver).
    pub fn revoke_sale_approval(ctx: Context<RevokeSaleApproval>) -> Result<()> {
        instructions::handle_revoke_sale_approval(ctx)
    }

    /// Opens a primary sale of a share class (launchpad), consuming the
    /// Admin's `SaleApproval` for this `(share_class, sale_id)`. The approver
    /// must still be an Admin; the sale must start by the approval's expiry
    /// and use its exact payout schedule.
    pub fn open_sale(
        ctx: Context<OpenSale>,
        sale_id: u64,
        price_per_unit: u64,
        total_for_sale: u64,
        start_ts: i64,
        end_ts: i64,
        raise_type: RaiseType,
        cliff_months: u8,
        vesting_months: u8,
    ) -> Result<()> {
        instructions::handle_open_sale(
            ctx,
            sale_id,
            price_per_unit,
            total_for_sale,
            start_ts,
            end_ts,
            raise_type,
            cliff_months,
            vesting_months,
        )
    }

    /// Buys share-class units from an open sale — pay, then receive minted units.
    pub fn buy(ctx: Context<Buy>, amount: u64) -> Result<()> {
        instructions::handle_buy(ctx, amount)
    }

    /// Closes a sale and sweeps proceeds to the issuer.
    pub fn close_sale(ctx: Context<CloseSale>) -> Result<()> {
        instructions::handle_close_sale(ctx)
    }

    /// Closes a Startup sale, sweeps proceeds into a payout vault escrow,
    /// and initialises the monthly tranche schedule.
    pub fn open_payout_vault(ctx: Context<OpenPayoutVault>, metadata_hash: [u8; 32]) -> Result<()> {
        instructions::handle_open_payout_vault(ctx, metadata_hash)
    }

    /// Posts a monthly update from the founder; gated on the period start
    /// timestamp to prevent pre-posting all updates up front.
    pub fn post_update(ctx: Context<PostUpdate>, content_hash: [u8; 32]) -> Result<()> {
        instructions::handle_post_update(ctx, content_hash)
    }

    /// Releases the next due tranche to the founder; gated on tranche time AND
    /// an update posted for that tranche's period. Startup vaults only.
    pub fn release_payout(ctx: Context<ReleasePayout>) -> Result<()> {
        instructions::handle_release_payout(ctx)
    }

    /// Permissionless: freezes an Active vault when the founder is ≥3
    /// update-periods overdue (i.e. periods_elapsed − updates_posted ≥ 3).
    pub fn freeze_vault(ctx: Context<FreezeVault>) -> Result<()> {
        instructions::handle_freeze_vault(ctx)
    }

    /// Opens an investor vote on a Frozen vault with a Merkle snapshot root.
    /// Sets the total investor weight (set-once) on the vault for later pro-rata
    /// refund calculations.
    pub fn open_vault_vote(
        ctx: Context<OpenVaultVote>,
        snapshot_root: [u8; 32],
        total_weight: u64,
        voting_period: i64,
    ) -> Result<()> {
        instructions::handle_open_vault_vote(ctx, snapshot_root, total_weight, voting_period)
    }

    /// Casts an investor's weighted vote on a VaultVote; Merkle-proves membership
    /// in the snapshot and blocks double-voting via the record PDA.
    pub fn cast_vault_vote(
        ctx: Context<CastVaultVote>,
        weight: u64,
        proof: Vec<[u8; 32]>,
        choice: VaultVoteChoice,
    ) -> Result<()> {
        instructions::handle_cast_vault_vote(ctx, weight, proof, choice)
    }

    /// Finalises a vault vote after the window ends; ReturnCapital majority
    /// cancels the vault (enables refunds), otherwise Extend resumes it and
    /// shifts the schedule forward past overdue periods.
    pub fn finalize_vault_vote(ctx: Context<FinalizeVaultVote>) -> Result<()> {
        instructions::handle_finalize_vault_vote(ctx)
    }

    /// After a vault is Cancelled (ReturnCapital vote), each investor reclaims
    /// their pro-rata share of the remaining principal, proven by Merkle
    /// membership in the vote's snapshot. Idempotent — ClaimRecord tracks
    /// cumulative drawn.
    pub fn claim_refund(
        ctx: Context<ClaimRefund>,
        weight: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::handle_claim_refund(ctx, weight, proof)
    }

    /// Opens an OTC sell offer for share-class units (Faza 3).
    /// `expires_at` = unix ts after which the offer is takeable no more
    /// (0 = never expires).
    pub fn create_offer(
        ctx: Context<CreateOffer>,
        offer_id: u64,
        amount: u64,
        price: u64,
        expires_at: i64,
    ) -> Result<()> {
        instructions::handle_create_offer(ctx, offer_id, amount, price, expires_at)
    }

    /// Funds an open offer's escrow from the maker's own wallet and CREDITS
    /// `offer.deposited`. The maker must sign; this is the only route that
    /// makes the escrow balance provably theirs, and it is what lets
    /// `cancel_offer` / `expire_offer` refund them without a receiver-KYC
    /// check (and what stops `take_offer` selling somebody else's units).
    pub fn deposit_to_offer_escrow<'info>(
        ctx: Context<'info, DepositToOfferEscrow<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::handle_deposit_to_offer_escrow(ctx, amount)
    }

    /// Fills an open OTC offer — taker pays, escrowed units are released.
    pub fn take_offer<'info>(ctx: Context<'info, TakeOffer<'info>>) -> Result<()> {
        instructions::handle_take_offer(ctx)
    }

    /// Cancels an open OTC offer — escrowed units return to the maker.
    pub fn cancel_offer<'info>(ctx: Context<'info, CancelOffer<'info>>) -> Result<()> {
        instructions::handle_cancel_offer(ctx)
    }

    /// Expires an open OTC offer past its `expires_at` — permissionless;
    /// escrowed units return to the maker.
    pub fn expire_offer<'info>(ctx: Context<'info, ExpireOffer<'info>>) -> Result<()> {
        instructions::handle_expire_offer(ctx)
    }

    /// Opens a bilateral OTC escrow deal between a named buyer and seller
    /// (admin; business-doc §9). `expires_at` = unix ts after which the deal
    /// can no longer be deposited into (0 = never expires).
    #[allow(clippy::too_many_arguments)]
    pub fn create_otc_deal(
        ctx: Context<CreateOtcDeal>,
        deal_id: u64,
        buyer: Pubkey,
        seller: Pubkey,
        amount: u64,
        price: u64,
        payment_mint: Pubkey,
        expires_at: i64,
    ) -> Result<()> {
        instructions::handle_create_otc_deal(
            ctx,
            deal_id,
            buyer,
            seller,
            amount,
            price,
            payment_mint,
            expires_at,
        )
    }

    /// Seller deposits the share units into the deal's asset escrow; if the
    /// payment is already escrowed, the swap settles atomically.
    pub fn deposit_otc_asset<'info>(ctx: Context<'info, DepositOtcAsset<'info>>) -> Result<()> {
        instructions::handle_deposit_otc_asset(ctx)
    }

    /// Buyer deposits the payment into the deal's payment escrow; if the
    /// asset is already escrowed, the swap settles atomically.
    pub fn deposit_otc_payment<'info>(ctx: Context<'info, DepositOtcPayment<'info>>) -> Result<()> {
        instructions::handle_deposit_otc_payment(ctx)
    }

    /// Expires an open OTC deal past its `expires_at` — permissionless;
    /// deposited funds return to the respective party.
    pub fn expire_otc_deal<'info>(ctx: Context<'info, ExpireOtcDeal<'info>>) -> Result<()> {
        instructions::handle_expire_otc_deal(ctx)
    }

    /// Cancels an open OTC deal (admin) — deposited funds return to the
    /// respective party.
    pub fn cancel_otc_deal<'info>(ctx: Context<'info, CancelOtcDeal<'info>>) -> Result<()> {
        instructions::handle_cancel_otc_deal(ctx)
    }

    /// Opens a push-based pro-rata revenue distribution for a share class
    /// (admin; business-doc §2–§5) and funds its escrow atomically.
    pub fn create_distribution(
        ctx: Context<CreateDistribution>,
        distribution_id: u64,
        total_amount: u64,
        snapshot_supply: u64,
        batch_root: [u8; 32],
        batch_count: u32,
    ) -> Result<()> {
        instructions::handle_create_distribution(
            ctx,
            distribution_id,
            total_amount,
            snapshot_supply,
            batch_root,
            batch_count,
        )
    }

    /// Pushes a batch of pro-rata payouts from the distribution escrow
    /// (admin); one `YieldPaid` event per payout.
    pub fn distribute_batch<'info>(
        ctx: Context<'info, DistributeBatch<'info>>,
        distribution_id: u64,
        batch_id: u32,
        amounts: Vec<u64>,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::handle_distribute_batch(ctx, distribution_id, batch_id, amounts, proof)
    }

    /// Closes a distribution (admin) — the undistributed remainder is swept
    /// to the refund account.
    pub fn close_distribution(ctx: Context<CloseDistribution>) -> Result<()> {
        instructions::handle_close_distribution(ctx)
    }

    /// Opens an advisory governance proposal for a share class (Faza 4).
    #[allow(clippy::too_many_arguments)]
    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        proposal_id: u64,
        metadata_hash: [u8; 32],
        snapshot_slot: u64,
        snapshot_root: [u8; 32],
        start_ts: i64,
        end_ts: i64,
    ) -> Result<()> {
        instructions::handle_create_proposal(
            ctx,
            proposal_id,
            metadata_hash,
            snapshot_slot,
            snapshot_root,
            start_ts,
            end_ts,
        )
    }

    /// Casts a weighted advisory vote, proven against the snapshot Merkle root.
    pub fn cast_vote(
        ctx: Context<CastVote>,
        choice: VoteChoice,
        weight: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::handle_cast_vote(ctx, choice, weight, proof)
    }

    /// Finalizes a proposal after its voting window — advisory outcome.
    pub fn finalize_proposal(ctx: Context<FinalizeProposal>) -> Result<()> {
        instructions::handle_finalize_proposal(ctx)
    }

    /// Admin deposits `amount` of payment-token yield and splits it 3-ways:
    /// founder third + investor third stay in vault escrow; platform third is
    /// transferred immediately to the platform treasury. Sets the investor
    /// cap-table root and total_weight (set-once) for later `claim_investor_yield`.
    pub fn route_yield(
        ctx: Context<RouteYield>,
        amount: u64,
        investor_root: [u8; 32],
        total_weight: u64,
    ) -> Result<()> {
        instructions::handle_route_yield(ctx, amount, investor_root, total_weight)
    }

    /// Founder withdraws their accumulated yield from the vault escrow; resets
    /// `founder_yield_claimable` to 0. Fails with `NothingToClaim` if balance
    /// is zero. Gated by `has_one = founder` on the vault.
    pub fn claim_founder_yield(ctx: Context<ClaimFounderYield>) -> Result<()> {
        instructions::handle_claim_founder_yield(ctx)
    }

    /// Investor proves Merkle membership in the investor yield snapshot and
    /// withdraws their pro-rata share of `investor_yield_pool`. Cumulative:
    /// entitlement = `weight * investor_yield_pool / total_weight`; the investor
    /// can re-claim the delta as the pool grows with each `route_yield`.
    pub fn claim_investor_yield(
        ctx: Context<ClaimInvestorYield>,
        weight: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::handle_claim_investor_yield(ctx, weight, proof)
    }

    /// Opens a Rights-Token vesting issuance (Faza 5).
    pub fn create_rights_issuance(
        ctx: Context<CreateRightsIssuance>,
        issuance_id: u64,
    ) -> Result<()> {
        instructions::handle_create_rights_issuance(ctx, issuance_id)
    }

    /// Publishes a vesting milestone with its claim snapshot Merkle root.
    pub fn publish_milestone(
        ctx: Context<PublishMilestone>,
        index: u16,
        merkle_root: [u8; 32],
        amount_pool: u64,
        unlock_ts: i64,
    ) -> Result<()> {
        instructions::handle_publish_milestone(ctx, index, merkle_root, amount_pool, unlock_ts)
    }

    /// Claims a holder's entitlement from a vesting milestone.
    pub fn claim_milestone<'info>(
        ctx: Context<'info, ClaimMilestone<'info>>,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::handle_claim_milestone(ctx, amount, proof)
    }

    /// Creates a KYC registry owned by a KYC-provider authority, co-signed by
    /// a platform admin. The address `["kyc_registry", authority]` is fixed
    /// forever; the authority itself can later rotate.
    pub fn create_kyc_registry(
        ctx: Context<CreateKycRegistry>,
        approved_jurisdictions: [u8; state::JURISDICTION_BITMAP_BYTES],
        blocked_jurisdictions: [u8; state::JURISDICTION_BITMAP_BYTES],
    ) -> Result<()> {
        instructions::handle_create_kyc_registry(ctx, approved_jurisdictions, blocked_jurisdictions)
    }

    /// Records an approved (time-bounded) holder in a KYC registry. The
    /// registry is taken by address and gated by `has_one = authority`.
    #[allow(clippy::too_many_arguments)]
    pub fn approve_holder(
        ctx: Context<ApproveHolder>,
        holder: Pubkey,
        jurisdiction: u16,
        accreditation_level: u8,
        expiry: i64,
        provider_id: u16,
        external_ref_hash: [u8; 32],
    ) -> Result<()> {
        instructions::handle_approve_holder(
            ctx,
            holder,
            jurisdiction,
            accreditation_level,
            expiry,
            provider_id,
            external_ref_hash,
        )
    }

    /// Revokes a holder's KYC entry — flips status to `Revoked`.
    /// The `transfer_hook` program checks only the RECEIVER, so a revoked
    /// holder can no longer receive — but keeps (and can still send) their
    /// balance. Use `clawback_from_holder` to seize it.
    pub fn revoke_holder(ctx: Context<RevokeHolder>, holder: Pubkey) -> Result<()> {
        instructions::handle_revoke_holder(ctx, holder)
    }

    /// The current KYC registry authority proposes a new authority. The
    /// registry ADDRESS never changes; only `authority` rotates on accept.
    pub fn propose_kyc_registry_authority(
        ctx: Context<ProposeKycRegistryAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::handle_propose_kyc_registry_authority(ctx, new_authority)
    }

    /// The proposed authority accepts the KYC registry.
    pub fn accept_kyc_registry_authority(ctx: Context<AcceptKycRegistryAuthority>) -> Result<()> {
        instructions::handle_accept_kyc_registry_authority(ctx)
    }

    /// The current KYC registry authority cancels a pending proposal.
    pub fn cancel_kyc_registry_authority_transfer(
        ctx: Context<CancelKycRegistryAuthorityTransfer>,
    ) -> Result<()> {
        instructions::handle_cancel_kyc_registry_authority_transfer(ctx)
    }

    // ── Issuer authority rotation (2C-2) ─────────────────────────────────────

    /// The current issuer authority proposes a new authority (regular rotation).
    pub fn propose_issuer_authority(
        ctx: Context<ProposeIssuerAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::handle_propose_issuer_authority(ctx, new_authority)
    }

    /// The proposed key accepts; the old grant's capabilities move to it.
    pub fn accept_issuer_authority(ctx: Context<AcceptIssuerAuthority>) -> Result<()> {
        instructions::handle_accept_issuer_authority(ctx)
    }

    /// The current issuer authority cancels a pending proposal.
    pub fn cancel_issuer_authority_transfer(
        ctx: Context<CancelIssuerAuthorityTransfer>,
    ) -> Result<()> {
        instructions::handle_cancel_issuer_authority_transfer(ctx)
    }

    /// The super admin proposes recovering a lost issuer key, executable after
    /// a 7-day timelock.
    pub fn propose_issuer_recovery(
        ctx: Context<ProposeIssuerRecovery>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::handle_propose_issuer_recovery(ctx, new_authority)
    }

    /// The current issuer authority or the super admin cancels a recovery.
    pub fn cancel_issuer_recovery(ctx: Context<CancelIssuerRecovery>) -> Result<()> {
        instructions::handle_cancel_issuer_recovery(ctx)
    }

    /// The recovered key executes a recovery once its timelock has passed.
    pub fn execute_issuer_recovery(ctx: Context<ExecuteIssuerRecovery>) -> Result<()> {
        instructions::handle_execute_issuer_recovery(ctx)
    }

    /// Permissionless: copies the live issuer authority into `Sale.authority`.
    pub fn sync_sale_authority(ctx: Context<SyncSaleAuthority>) -> Result<()> {
        instructions::handle_sync_sale_authority(ctx)
    }

    /// Permissionless: copies the live issuer authority into `PayoutVault.founder`.
    pub fn sync_payout_founder(ctx: Context<SyncPayoutFounder>) -> Result<()> {
        instructions::handle_sync_payout_founder(ctx)
    }

    /// The KYC registry authority replaces both jurisdiction bitmaps.
    pub fn update_kyc_registry_jurisdictions(
        ctx: Context<UpdateKycRegistryJurisdictions>,
        approved_jurisdictions: [u8; state::JURISDICTION_BITMAP_BYTES],
        blocked_jurisdictions: [u8; state::JURISDICTION_BITMAP_BYTES],
    ) -> Result<()> {
        instructions::handle_update_kyc_registry_jurisdictions(
            ctx,
            approved_jurisdictions,
            blocked_jurisdictions,
        )
    }

    /// Admin claws back a revoked (or KYC-expired) holder's share units into a
    /// burn-only quarantine escrow (a `RedemptionQueue` + `BurnAndAttest`
    /// custody vault of the same share class) via the mint's
    /// `PermanentDelegate` (the ShareClass PDA signs). `KycGated` mints only —
    /// the registry is pinned to the one the mint's hook config names.
    /// `amount == 0` sweeps the holder's full balance.
    pub fn clawback_from_holder<'info>(
        ctx: Context<'info, ClawbackFromHolder<'info>>,
        holder: Pubkey,
        amount: u64,
    ) -> Result<()> {
        instructions::handle_clawback_from_holder(ctx, holder, amount)
    }

    // ── Vesting series (spec: "11. Vesting — Mancipatio") ───────────────────

    /// Creates a client-owned vesting series — schedule and settings fixed at
    /// creation (timing/delivery mode, approval window, recovery,
    /// cancellation, pre-cliff %). No admin gate: every series authority sits
    /// with the client, and Mancipatio holds no key over the escrow.
    #[allow(clippy::too_many_arguments)]
    pub fn create_vesting_series(
        ctx: Context<CreateVestingSeries>,
        series_id: u64,
        tranches: Vec<VestingTranche>,
        timing_mode: VestingTimingMode,
        delivery_mode: VestingDeliveryMode,
        approval_window_secs: i64,
        recovery_enabled: bool,
        cancellation_enabled: bool,
        pre_cliff_bps: u16,
    ) -> Result<()> {
        instructions::handle_create_vesting_series(
            ctx,
            series_id,
            tranches,
            timing_mode,
            delivery_mode,
            approval_window_secs,
            recovery_enabled,
            cancellation_enabled,
            pre_cliff_bps,
        )
    }

    /// Finalizes a complete Draft before its first unlock, permanently fixing allocations.
    pub fn finalize_vesting_series(ctx: Context<FinalizeVestingSeries>) -> Result<()> {
        instructions::handle_finalize_vesting_series(ctx)
    }

    /// Adds a recipient position (wallet + allocation) — only while Draft.
    pub fn add_vesting_position(
        ctx: Context<AddVestingPosition>,
        wallet: Pubkey,
        allocation: u64,
    ) -> Result<()> {
        instructions::handle_add_vesting_position(ctx, wallet, allocation)
    }

    /// Deposits tokens into the series escrow; releases are blocked until
    /// deposits cover the full allocation.
    pub fn deposit_to_vesting_escrow<'info>(
        ctx: Context<'info, DepositToVestingEscrow<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::handle_deposit_to_vesting_escrow(ctx, amount)
    }

    /// Approves one tranche (Approval-mode series). Approval delays but can
    /// never freeze a vested tranche past its approval window.
    pub fn approve_vesting_tranche(
        ctx: Context<ApproveVestingTranche>,
        tranche_index: u16,
    ) -> Result<()> {
        instructions::handle_approve_vesting_tranche(ctx, tranche_index)
    }

    /// Claim-mode release — the recipient pulls their vested amount.
    pub fn claim_vested<'info>(
        ctx: Context<'info, ClaimVested<'info>>,
        position_index: u32,
    ) -> Result<()> {
        instructions::handle_claim_vested(ctx, position_index)
    }

    /// Push-mode release — anyone may trigger delivery to the position's
    /// current wallet.
    pub fn push_vested<'info>(
        ctx: Context<'info, PushVested<'info>>,
        position_index: u32,
    ) -> Result<()> {
        instructions::handle_push_vested(ctx, position_index)
    }

    /// Re-points a position to a replacement wallet (recovery-enabled series
    /// only) — same recipient, new address.
    pub fn recover_vesting_position(
        ctx: Context<RecoverVestingPosition>,
        position_index: u32,
        new_wallet: Pubkey,
    ) -> Result<()> {
        instructions::handle_recover_vesting_position(ctx, position_index, new_wallet)
    }

    /// Cancels the series (cancellation-enabled only): vested stays the
    /// recipient's forever, only the unvested remainder returns.
    pub fn cancel_vesting_series(ctx: Context<CancelVestingSeries>) -> Result<()> {
        instructions::handle_cancel_vesting_series(ctx)
    }

    /// Irrevocably turns cancellation OFF (never the reverse).
    pub fn disable_vesting_cancellation(ctx: Context<DisableVestingCancellation>) -> Result<()> {
        instructions::handle_disable_vesting_cancellation(ctx)
    }

    /// Withdraws the unvested remainder after cancellation; the recipients'
    /// reserved amount can never leave through here.
    pub fn withdraw_unvested<'info>(ctx: Context<'info, WithdrawUnvested<'info>>) -> Result<()> {
        instructions::handle_withdraw_unvested(ctx)
    }

    /// Withdraws only the actual excess above every unpaid Active allocation.
    pub fn withdraw_vesting_surplus<'info>(
        ctx: Context<'info, WithdrawUnvested<'info>>,
    ) -> Result<()> {
        instructions::handle_withdraw_vesting_surplus(ctx)
    }
}
