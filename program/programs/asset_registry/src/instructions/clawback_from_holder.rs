use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    Admin, ClawbackReason, CustodyVault, HolderClawback, KycEntry, KycRegistry, KycStatus,
    RealizeAction, ShareClass, VaultState, VaultType,
};
use crate::util::hook_transfer;

#[derive(Accounts)]
#[instruction(holder: Pubkey)]
pub struct ClawbackFromHolder<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate — the signer must hold an `Admin` record.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        seeds = [SHARE_CLASS_SEED, share_class.asset.as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
        has_one = mint @ RegistryError::Unauthorized,
        constraint = share_class.mint_initialized @ RegistryError::MintNotInitialized,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// The holder's share token account — the clawback source. The `ShareClass`
    /// PDA is the mint's Token-2022 `PermanentDelegate` (set at mint creation),
    /// so no holder signature is needed.
    #[account(
        mut,
        constraint = holder_share_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = holder_share_account.owner == holder @ RegistryError::Unauthorized,
    )]
    pub holder_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Proof that `holder` is an ordinary wallet and not one of this program's
    /// own escrows. `holder` is a free parameter and `approve_holder` mints a
    /// `KycEntry` for ANY pubkey, PDAs included — so without this an admin
    /// could approve→revoke an Offer / OtcDeal / CustodyVault PDA and "claw
    /// back" its balance into a burn vault, destroying the ledgered deposit of
    /// a fully compliant maker, seller or beneficiary. Every such escrow
    /// carries an `EscrowMarker` or `EscrowIdentity` at this address, so an INITIALISED account
    /// here means the target is program-held property. The address is derived
    /// by Anchor, so the caller can neither omit nor substitute it; the
    /// constraint demands it be empty (never opened, or already closed).
    #[account(
        seeds = [ESCROW_MARKER_SEED, holder.as_ref()],
        bump,
        constraint = holder_escrow_marker.data_is_empty()
            @ RegistryError::ClawbackTargetIsEscrow,
    )]
    /// CHECK: address-derived; only its emptiness is read (see above).
    pub holder_escrow_marker: UncheckedAccount<'info>,

    /// Destination — the escrow of `custody_vault` below, i.e. a burn-only
    /// quarantine escrow of THIS share class. The vault PDA owns it and carries
    /// an `EscrowMarker`, so the hook's destination-marker exemption keeps the
    /// clawback leg from ever being blocked by receiver-KYC.
    #[account(
        mut,
        constraint = destination.mint == mint.key() @ RegistryError::Unauthorized,
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The quarantine vault the seized units land in — a typed, admin-opened
    /// `CustodyVault` of this share class, restricted to the one vault shape
    /// whose every exit BURNS: `RedemptionQueue` + `BurnAndAttest`
    /// (`realize_custody_vault` burns, `revert_custody_vault` burns, and
    /// `return_custody_vault` — the only escrow→wallet exit — is reserved for
    /// `DeliveryEscrow` vaults and therefore unreachable here). An
    /// `EscrowMarker` alone would NOT be containment: `create_offer` mints one
    /// permissionlessly and `cancel_offer` pays the full escrow balance back to
    /// the maker's wallet.
    #[account(
        seeds = [CUSTODY_SEED, share_class.key().as_ref(), &custody_vault.vault_id.to_le_bytes()],
        bump = custody_vault.bump,
        has_one = mint @ RegistryError::ClawbackDestinationInvalid,
        has_one = share_class @ RegistryError::ClawbackDestinationInvalid,
        constraint = custody_vault.escrow == destination.key()
            @ RegistryError::ClawbackDestinationInvalid,
        constraint = custody_vault.vault_type == VaultType::RedemptionQueue
            @ RegistryError::ClawbackDestinationInvalid,
        constraint = custody_vault.realize_action == RealizeAction::BurnAndAttest
            @ RegistryError::ClawbackDestinationInvalid,
        constraint = custody_vault.state == VaultState::Active
            @ RegistryError::ClawbackDestinationInvalid,
    )]
    pub custody_vault: Box<Account<'info, CustodyVault>>,

    /// Registry the holder's entry is checked against — pinned by the handler
    /// to the registry the mint's hook config points at (clawback is only
    /// allowed on `KycGated` mints, so the pin always applies).
    pub kyc_registry: Box<Account<'info, KycRegistry>>,

    /// The holder's KYC entry — must be `Revoked` or expired (see handler).
    #[account(
        seeds = [KYC_SEED, kyc_registry.key().as_ref(), holder.as_ref()],
        bump = kyc_entry.bump,
    )]
    pub kyc_entry: Box<Account<'info, KycEntry>>,

    /// CHECK: the mint's `TransferHookConfig` PDA (`["hook_cfg", mint]` under
    /// the transfer_hook program) — address enforced by the seeds constraint;
    /// the handler reads `restriction_mode` / `kyc_registry` by offset
    /// (layout mirrored in constants.rs, no crate dependency on the hook).
    /// Must exist and say `KycGated`: on an `Open` mint there is no registry
    /// to pin `kyc_registry` to, so the whole instruction is refused.
    #[account(
        seeds = [HOOK_CONFIG_SEED, mint.key().as_ref()],
        seeds::program = TRANSFER_HOOK_PROGRAM,
        bump,
    )]
    pub hook_config: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: the holder→escrow leg's hook tail (source authority
    // = ShareClass PDA, the permanent delegate). Always the 9-account KycGated
    // tail — the handler refuses anything but a KycGated mint (see docs in
    // transfer_hook for the order). The destination-owner EscrowMarker (the
    // custody vault's) exempts the leg from the hook's receiver-KYC checks.
}

/// Claws back a revoked (or KYC-expired) holder's share units into a burn-only
/// quarantine escrow, using the mint's Token-2022 `PermanentDelegate` (the
/// `ShareClass` PDA — set at mint creation, docs/01 §6) as the authority. This is
/// the enforcement arm of `revoke_holder`: revocation only blocks the holder
/// from *receiving* (the hook checks the receiver alone), so the units they
/// already hold stay put — and remain sendable — until an admin claws them
/// back.
///
/// Safeguards — a clawback cannot be turned against a holder in good standing,
/// nor used to drain units into an admin's own wallet:
///   * admin gate: only an `Admin` record holder may call it;
///   * the mint must be `KycGated` (proven by its hook config). On an `Open`
///     mint there is no configured registry to pin against, so any admin could
///     bring a registry of their own carrying a fabricated `Revoked` entry for
///     the victim — the instruction is therefore refused outright;
///   * `kyc_registry` is pinned to the registry the hook config names — always,
///     since the mode check above already rejects everything else. The
///     `HolderClawback` event's `registry` field is that pinned registry, so
///     the audit trail cannot name a throwaway one;
///   * the holder's `KycEntry` (a PDA of that pinned registry) must be
///     `Revoked`, or past its `expiry`;
///   * the destination is a typed `RedemptionQueue` + `BurnAndAttest`
///     `CustodyVault` escrow of this very share class — a quarantine whose
///     every exit burns. An `EscrowMarker`-only destination check was NOT
///     containment: `create_offer` is permissionless, so an admin could point
///     the clawback at a freshly created offer escrow and `cancel_offer` the
///     whole balance into their own wallet.
///
/// `amount == 0` sweeps the holder's full balance.
pub fn handle_clawback_from_holder<'info>(
    ctx: Context<'info, ClawbackFromHolder<'info>>,
    holder: Pubkey,
    amount: u64,
) -> Result<()> {
    // The mint must be KycGated, and `kyc_registry` must be the registry its
    // hook config names. Both are unconditional: a clawback justified by a KYC
    // record is meaningless on a mint that enforces no KYC, and without the
    // pin any admin could supply a registry of their own carrying a fabricated
    // `Revoked` entry for the victim.
    {
        let cfg_ai = &ctx.accounts.hook_config;
        require!(
            cfg_ai.owner == &TRANSFER_HOOK_PROGRAM && !cfg_ai.data_is_empty(),
            RegistryError::InvalidKycRegistry
        );
        let data = cfg_ai.try_borrow_data()?;
        require!(
            data.len() >= HOOK_CONFIG_MIN_LEN,
            RegistryError::InvalidKycRegistry
        );
        require!(
            data[HOOK_CONFIG_RESTRICTION_MODE_OFFSET] == RESTRICTION_MODE_KYC_GATED,
            RegistryError::ClawbackNotKycGated
        );
        require!(
            data[HOOK_CONFIG_KYC_REGISTRY_TAG_OFFSET] == 1,
            RegistryError::InvalidKycRegistry
        );
        let key: [u8; 32] = data
            [HOOK_CONFIG_KYC_REGISTRY_KEY_OFFSET..HOOK_CONFIG_KYC_REGISTRY_KEY_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(RegistryError::InvalidKycRegistry))?;
        require_keys_eq!(
            ctx.accounts.kyc_registry.key(),
            Pubkey::new_from_array(key),
            RegistryError::InvalidKycRegistry
        );
    }

    // The holder must be ineligible: entry revoked, or its expiry in the past.
    // (The entry is a PDA of the pinned registry — see the seeds constraint.)
    let now = Clock::get()?.unix_timestamp;
    let entry = &ctx.accounts.kyc_entry;
    let reason = if entry.status == KycStatus::Revoked {
        ClawbackReason::Revoked
    } else {
        ClawbackReason::Expired
    };
    require!(
        entry.status == KycStatus::Revoked || entry.expiry <= now,
        RegistryError::ClawbackHolderStillEligible
    );

    let clawback_amount = if amount == 0 {
        ctx.accounts.holder_share_account.amount
    } else {
        amount
    };
    require!(clawback_amount > 0, RegistryError::NothingToClaim);

    // holder ATA → quarantine escrow (hook-aware; the ShareClass PDA signs as
    // permanent delegate). The hook still runs: the sender blocklist checks
    // the ShareClass PDA (the source authority), and the destination-owner
    // EscrowMarker (the custody vault's, alive while the vault is Active)
    // exempts the receiver-KYC checks.
    //
    // Receiver KYC: EXPLICITLY NOT required, and the direction is why — this
    // moves units INTO a program escrow, never out to a wallet. The receiver
    // is a burn-only `RedemptionQueue` + `BurnAndAttest` vault (pinned by the
    // account constraints), which has no escrow→wallet exit at all:
    // `return_custody_vault` is `DeliveryEscrow`-only. Demanding a `KycEntry`
    // for the escrow would make the enforcement action impossible.
    let asset_key = ctx.accounts.share_class.asset;
    let class_index_seed = [ctx.accounts.share_class.class_index];
    let bump_seed = [ctx.accounts.share_class.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        SHARE_CLASS_SEED,
        asset_key.as_ref(),
        &class_index_seed,
        &bump_seed,
    ]];
    hook_transfer(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.holder_share_account.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.destination.to_account_info(),
        &ctx.accounts.share_class.to_account_info(),
        ctx.remaining_accounts,
        clawback_amount,
        ctx.accounts.mint.decimals,
        signer_seeds,
    )?;

    emit!(HolderClawback {
        share_class: ctx.accounts.share_class.key(),
        mint: ctx.accounts.mint.key(),
        // Pinned above to the hook config's registry — this field cannot name
        // a registry the mint is not actually governed by.
        registry: ctx.accounts.kyc_registry.key(),
        holder,
        destination: ctx.accounts.destination.key(),
        custody_vault: ctx.accounts.custody_vault.key(),
        reason,
        amount: clawback_amount,
    });
    msg!(
        "Clawback — {} units from holder {}",
        clawback_amount,
        holder
    );
    Ok(())
}
