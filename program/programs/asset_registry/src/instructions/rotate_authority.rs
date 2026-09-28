//! Super-admin and custody-vault authority rotation (propose / accept /
//! cancel), staged in `AuthorityProposal` `["authority_proposal", target]`.
//!
//! * Platform (D3): the super admin proposes; the proposed key accepts inside
//!   `[proposed_at + 48 h, eta + 14 d)` (the 48 h are waived while the one-way
//!   bootstrap window is open); the super admin, any live Admin or the
//!   program upgrade authority may cancel. Accepting retires a pending
//!   `PlatformRecovery`, so an A -> B -> A round trip cannot revive it.
//! * Custody vault: the super admin proposes a key that holds an Admin
//!   record; it accepts within 14 days; the super admin, or the current vault
//!   authority while it still holds a live Admin record, may cancel (an
//!   operator already removed for cause cannot block its own replacement).
//!
//! Neither changes the ProgramData upgrade authority, an independent
//! deployment role. The rc.x `AuthorityTransfer` accounts at
//! `["authority_transfer", target]` are never read here.

use crate::{
    constants::*,
    error::RegistryError,
    state::{
        Admin, AuthorityProposal, AuthorityProposalCancelled, AuthorityProposalCreated,
        CustodyVault, Platform, PlatformAdminChangeKind, PlatformAdminChanged, PlatformRecovery,
        VaultState,
    },
    util::{
        effective_eta, ensure, install_platform_admin, is_active_admin, is_veto_holder,
        require_window, retire_pending_proposal,
    },
};
use anchor_lang::prelude::*;

pub(crate) fn validate_new_authority(current: Pubkey, proposed: Pubkey) -> Result<()> {
    require!(
        proposed != Pubkey::default() && proposed != current,
        RegistryError::InvalidProposedAuthority
    );
    Ok(())
}

/// Writes (or overwrites) a proposal: executable from `now + timelock`,
/// expiring `PROPOSAL_WINDOW_SECS` later. Returns `(eta, expires_at)`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn write_proposal(
    record: &mut AuthorityProposal,
    target: Pubkey,
    current: Pubkey,
    proposed: Pubkey,
    proposer: Pubkey,
    kind: u8,
    timelock: i64,
    bump: u8,
) -> Result<(i64, i64)> {
    let now = Clock::get()?.unix_timestamp;
    let eta = now.checked_add(timelock).ok_or(RegistryError::Overflow)?;
    let expires_at = eta
        .checked_add(PROPOSAL_WINDOW_SECS)
        .ok_or(RegistryError::Overflow)?;
    record.target = target;
    record.current_authority = current;
    record.new_authority = proposed;
    record.proposed_by = proposer;
    record.proposed_at = now;
    record.eta = eta;
    record.expires_at = expires_at;
    record.kind = kind;
    record.version = STATE_VERSION;
    record.bump = bump;
    Ok((eta, expires_at))
}

/// An accept of a flow without a timelock (`eta == proposed_at`): only the
/// expiry applies.
pub(crate) fn require_not_expired(record: &AuthorityProposal) -> Result<()> {
    ensure(
        Clock::get()?.unix_timestamp < record.expires_at,
        RegistryError::ProposalExpired,
    )
}

// ── Platform super admin ─────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ProposePlatformAdmin<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump, constraint = platform.admin == authority.key() @ RegistryError::Unauthorized)]
    pub platform: Account<'info, Platform>,
    #[account(init_if_needed, payer = authority, space = 8 + AuthorityProposal::INIT_SPACE,
        seeds = [AUTHORITY_PROPOSAL_SEED, platform.key().as_ref()], bump)]
    pub transfer: Box<Account<'info, AuthorityProposal>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_propose_platform_admin(
    ctx: Context<ProposePlatformAdmin>,
    new_admin: Pubkey,
) -> Result<()> {
    let platform = ctx.accounts.platform.key();
    let current = ctx.accounts.platform.admin;
    validate_new_authority(current, new_admin)?;
    let proposed_by = ctx.accounts.authority.key();
    let (eta, expires_at) = write_proposal(
        &mut ctx.accounts.transfer,
        platform,
        current,
        new_admin,
        proposed_by,
        AUTHORITY_PROPOSAL_KIND_PLATFORM,
        SUPER_ADMIN_ROTATION_TIMELOCK_SECS,
        ctx.bumps.transfer,
    )?;
    emit!(AuthorityProposalCreated {
        target: platform,
        kind: AUTHORITY_PROPOSAL_KIND_PLATFORM,
        current_authority: current,
        new_authority: new_admin,
        proposed_by,
        eta,
        expires_at,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptPlatformAdmin<'info> {
    #[account(mut)]
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(mut, close = new_admin, seeds = [AUTHORITY_PROPOSAL_SEED, platform.key().as_ref()], bump = transfer.bump,
        constraint = transfer.target == platform.key() && transfer.current_authority == platform.admin
            && transfer.proposed_by == platform.admin && transfer.new_authority == new_admin.key() @ RegistryError::InvalidAuthorityTransfer)]
    pub transfer: Box<Account<'info, AuthorityProposal>>,
    /// CHECK: derived old role, validated and closed in the handler if present.
    /// It may be unresolved on an older deployment that revoked its own role.
    #[account(mut, seeds = [ADMIN_SEED, platform.admin.as_ref()], bump)]
    pub old_admin_record: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = new_admin, space = 8 + Admin::INIT_SPACE,
        seeds = [ADMIN_SEED, new_admin.key().as_ref()], bump)]
    pub new_admin_record: Account<'info, Admin>,
    pub system_program: Program<'info, System>,
    /// A pending upgrade-authority recovery, retired here when present (it
    /// may not exist), so an A -> B -> A round trip cannot revive it.
    /// CHECK: address pinned by seeds; `util::retire_pending_proposal` checks the rest.
    #[account(mut, seeds = [PLATFORM_RECOVERY_SEED, platform.key().as_ref()], bump)]
    pub recovery: UncheckedAccount<'info>,
}

/// Rotates application administration only; the ProgramData upgrade authority
/// is an independent deployment role and is never changed by this instruction.
pub fn handle_accept_platform_admin(ctx: Context<AcceptPlatformAdmin>) -> Result<()> {
    let transfer = &ctx.accounts.transfer;
    require_window(
        Clock::get()?.unix_timestamp,
        effective_eta(&ctx.accounts.platform, transfer.proposed_at, transfer.eta),
        transfer.expires_at,
    )?;
    let platform_key = ctx.accounts.platform.key();
    if retire_pending_proposal(
        &ctx.accounts.recovery.to_account_info(),
        &platform_key,
        PlatformRecovery::DISCRIMINATOR,
    )? {
        msg!("Pending super-admin recovery retired");
    }
    let new_admin = ctx.accounts.new_admin.key();
    let old_admin = install_platform_admin(
        &mut ctx.accounts.platform,
        &ctx.accounts.old_admin_record.to_account_info(),
        &mut ctx.accounts.new_admin_record,
        new_admin,
        ctx.bumps.new_admin_record,
        &ctx.accounts.new_admin.to_account_info(),
    )?;
    emit!(PlatformAdminChanged {
        old_admin,
        new_admin,
        kind: PlatformAdminChangeKind::Rotation,
    });
    msg!(
        "Platform operational admin rotated — {} -> {}",
        old_admin,
        new_admin
    );
    Ok(())
}

#[derive(Accounts)]
pub struct CancelPlatformAdminTransfer<'info> {
    /// The super admin, a live Admin, or the program upgrade authority. Not
    /// `mut`: it may be the same key as `proposer`.
    pub canceller: Signer<'info>,
    /// CHECK: `["admin", canceller]`; read by `util::is_active_admin`.
    #[account(seeds = [ADMIN_SEED, canceller.key().as_ref()], bump)]
    pub canceller_admin_record: UncheckedAccount<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut, close = proposer, seeds = [AUTHORITY_PROPOSAL_SEED, platform.key().as_ref()], bump = transfer.bump,
        constraint = transfer.target == platform.key() @ RegistryError::InvalidAuthorityTransfer)]
    pub transfer: Box<Account<'info, AuthorityProposal>>,
    /// CHECK: the proposing super admin; the rent always returns to it.
    #[account(mut, address = transfer.proposed_by @ RegistryError::InvalidAuthorityTransfer)]
    pub proposer: UncheckedAccount<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ RegistryError::Unauthorized)]
    pub program: Program<'info, crate::program::AssetRegistry>,
    pub program_data: Box<Account<'info, ProgramData>>,
}

/// Withdraws a pending super-admin rotation (live, stale or expired).
pub fn handle_cancel_platform_admin_transfer(
    ctx: Context<CancelPlatformAdminTransfer>,
) -> Result<()> {
    let by = ctx.accounts.canceller.key();
    ensure(
        is_veto_holder(
            &ctx.accounts.platform,
            &by,
            &ctx.accounts.canceller_admin_record.to_account_info(),
            &ctx.accounts.program_data,
        ),
        RegistryError::Unauthorized,
    )?;
    emit!(AuthorityProposalCancelled {
        target: ctx.accounts.platform.key(),
        kind: AUTHORITY_PROPOSAL_KIND_PLATFORM,
        cancelled_by: by,
        cancelled_new_authority: ctx.accounts.transfer.new_authority,
    });
    msg!("Super-admin rotation cancelled");
    Ok(())
}

// ── Custody vault operational authority ─────────────────────────────────────

#[derive(Accounts)]
#[instruction(new_authority: Pubkey)]
pub struct ProposeCustodyAuthority<'info> {
    #[account(mut)]
    pub super_admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump, constraint = platform.admin == super_admin.key() @ RegistryError::Unauthorized)]
    pub platform: Account<'info, Platform>,
    #[account(seeds = [CUSTODY_SEED, custody_vault.share_class.as_ref(), &custody_vault.vault_id.to_le_bytes()], bump = custody_vault.bump,
        constraint = matches!(custody_vault.state, VaultState::Active | VaultState::Triggered) @ RegistryError::InvalidVaultState)]
    pub custody_vault: Box<Account<'info, CustodyVault>>,
    #[account(seeds = [ADMIN_SEED, new_authority.as_ref()], bump = new_admin_record.bump)]
    pub new_admin_record: Account<'info, Admin>,
    #[account(init_if_needed, payer = super_admin, space = 8 + AuthorityProposal::INIT_SPACE,
        seeds = [AUTHORITY_PROPOSAL_SEED, custody_vault.key().as_ref()], bump)]
    pub transfer: Box<Account<'info, AuthorityProposal>>,
    pub system_program: Program<'info, System>,
}

/// The platform can recover an operator's vault after that operator's Admin
/// role was revoked. It never changes the beneficiary or custody contract.
pub fn handle_propose_custody_authority(
    ctx: Context<ProposeCustodyAuthority>,
    new_authority: Pubkey,
) -> Result<()> {
    let vault = ctx.accounts.custody_vault.key();
    let current = ctx.accounts.custody_vault.authority;
    validate_new_authority(current, new_authority)?;
    let proposed_by = ctx.accounts.super_admin.key();
    let (eta, expires_at) = write_proposal(
        &mut ctx.accounts.transfer,
        vault,
        current,
        new_authority,
        proposed_by,
        AUTHORITY_PROPOSAL_KIND_CUSTODY,
        0,
        ctx.bumps.transfer,
    )?;
    emit!(AuthorityProposalCreated {
        target: vault,
        kind: AUTHORITY_PROPOSAL_KIND_CUSTODY,
        current_authority: current,
        new_authority,
        proposed_by,
        eta,
        expires_at,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptCustodyAuthority<'info> {
    #[account(mut)]
    pub new_authority: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(mut, seeds = [CUSTODY_SEED, custody_vault.share_class.as_ref(), &custody_vault.vault_id.to_le_bytes()], bump = custody_vault.bump,
        constraint = matches!(custody_vault.state, VaultState::Active | VaultState::Triggered) @ RegistryError::InvalidVaultState)]
    pub custody_vault: Box<Account<'info, CustodyVault>>,
    #[account(seeds = [ADMIN_SEED, new_authority.key().as_ref()], bump = new_admin_record.bump)]
    pub new_admin_record: Account<'info, Admin>,
    #[account(mut, close = new_authority, seeds = [AUTHORITY_PROPOSAL_SEED, custody_vault.key().as_ref()], bump = transfer.bump,
        constraint = transfer.target == custody_vault.key() && transfer.current_authority == custody_vault.authority
            && transfer.proposed_by == platform.admin && transfer.new_authority == new_authority.key() @ RegistryError::InvalidAuthorityTransfer)]
    pub transfer: Box<Account<'info, AuthorityProposal>>,
}

pub fn handle_accept_custody_authority(ctx: Context<AcceptCustodyAuthority>) -> Result<()> {
    require_not_expired(&ctx.accounts.transfer)?;
    ctx.accounts.custody_vault.authority = ctx.accounts.new_authority.key();
    msg!(
        "Custody operational authority rotated — vault {}",
        ctx.accounts.custody_vault.key()
    );
    Ok(())
}

#[derive(Accounts)]
pub struct CancelCustodyAuthorityTransfer<'info> {
    /// The super admin, or the current vault authority while it holds a live
    /// Admin record. Not `mut`: it may be the same key as `proposer`.
    pub canceller: Signer<'info>,
    /// CHECK: `["admin", canceller]`; read by `util::is_active_admin`.
    #[account(seeds = [ADMIN_SEED, canceller.key().as_ref()], bump)]
    pub canceller_admin_record: UncheckedAccount<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(seeds = [CUSTODY_SEED, custody_vault.share_class.as_ref(), &custody_vault.vault_id.to_le_bytes()], bump = custody_vault.bump)]
    pub custody_vault: Box<Account<'info, CustodyVault>>,
    #[account(mut, close = proposer, seeds = [AUTHORITY_PROPOSAL_SEED, custody_vault.key().as_ref()], bump = transfer.bump,
        constraint = transfer.target == custody_vault.key() @ RegistryError::InvalidAuthorityTransfer)]
    pub transfer: Box<Account<'info, AuthorityProposal>>,
    /// CHECK: the proposing super admin; the rent always returns to it.
    #[account(mut, address = transfer.proposed_by @ RegistryError::InvalidAuthorityTransfer)]
    pub proposer: UncheckedAccount<'info>,
}

/// Withdraws a pending custody rotation (live, stale or expired).
pub fn handle_cancel_custody_authority_transfer(
    ctx: Context<CancelCustodyAuthorityTransfer>,
) -> Result<()> {
    let by = ctx.accounts.canceller.key();
    ensure(
        by == ctx.accounts.platform.admin
            || (by == ctx.accounts.custody_vault.authority
                && is_active_admin(&ctx.accounts.canceller_admin_record.to_account_info(), &by)),
        RegistryError::Unauthorized,
    )?;
    emit!(AuthorityProposalCancelled {
        target: ctx.accounts.custody_vault.key(),
        kind: AUTHORITY_PROPOSAL_KIND_CUSTODY,
        cancelled_by: by,
        cancelled_new_authority: ctx.accounts.transfer.new_authority,
    });
    msg!(
        "Custody rotation cancelled — vault {}",
        ctx.accounts.custody_vault.key()
    );
    Ok(())
}
