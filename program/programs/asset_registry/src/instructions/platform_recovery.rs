//! D4 — recovery of a LOST super-admin key by the program upgrade authority
//! (design 8.3 §7.1), after 7 days' notice.
//!
//! * `propose_platform_recovery(new_admin)` — signed by
//!   `ProgramData.upgrade_authority_address` (the `initialize_platform`
//!   pattern: `program` bound to its `program_data`). Executable from
//!   `eta = proposed_at + 7 d`, expiring 14 days later; a re-proposal
//!   overwrites it and restarts both clocks. Runs through Squads when the
//!   upgrade authority is the Squads vault.
//! * `cancel_platform_recovery()` — the current super admin (the holder of a
//!   key that was not lost) or the proposer; rent to the proposer.
//! * `execute_platform_recovery()` — the new key signs inside
//!   `[eta, expires_at)` (never waived by bootstrap), while the super admin is
//!   still the one proposed against and the proposer is still the upgrade
//!   authority. Installs the key exactly as `accept_platform_admin` does and
//!   retires a pending super-admin rotation.
//!
//! While it is pending, `accept_platform_admin` refuses
//! (`PlatformRecoveryPending`): the super admin cannot rotate away from it.
//!
//! Threat model: this protects a LOST key. A COMPROMISED super admin can
//! cancel it; the answer to that is the `incident` build (never a release
//! artifact): the same code with a zero delay, where only the proposer may
//! cancel, and where the refused accept keeps the compromised key from
//! rotating to a second key of its own between the propose and the execute.
//! The upgrade authority can replace the program anyway, so neither adds
//! trust.

use anchor_lang::prelude::*;

use super::rotate_authority::validate_new_authority;
use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    Admin, AuthorityProposal, Platform, PlatformAdminChangeKind, PlatformAdminChanged,
    PlatformRecovery, PlatformRecoveryCancelled, PlatformRecoveryProposed,
};
use crate::util::{ensure, install_platform_admin, require_window, retire_pending_proposal};

#[derive(Accounts)]
pub struct ProposePlatformRecovery<'info> {
    /// `ProgramData.upgrade_authority_address`; pays the proposal's rent.
    #[account(mut)]
    pub upgrade_authority: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(init_if_needed, payer = upgrade_authority, space = 8 + PlatformRecovery::INIT_SPACE,
        seeds = [PLATFORM_RECOVERY_SEED, platform.key().as_ref()], bump)]
    pub recovery: Box<Account<'info, PlatformRecovery>>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ RegistryError::Unauthorized)]
    pub program: Program<'info, crate::program::AssetRegistry>,
    #[account(constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ RegistryError::Unauthorized)]
    pub program_data: Box<Account<'info, ProgramData>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_propose_platform_recovery(
    ctx: Context<ProposePlatformRecovery>,
    new_admin: Pubkey,
) -> Result<()> {
    let current_admin = ctx.accounts.platform.admin;
    validate_new_authority(current_admin, new_admin)?;
    let now = Clock::get()?.unix_timestamp;
    let eta = now
        .checked_add(PLATFORM_RECOVERY_DELAY_SECS)
        .ok_or(RegistryError::Overflow)?;
    let expires_at = eta
        .checked_add(PROPOSAL_WINDOW_SECS)
        .ok_or(RegistryError::Overflow)?;
    let proposed_by = ctx.accounts.upgrade_authority.key();
    let recovery = &mut ctx.accounts.recovery;
    recovery.platform = ctx.accounts.platform.key();
    recovery.current_admin = current_admin;
    recovery.new_admin = new_admin;
    recovery.proposed_by = proposed_by;
    recovery.proposed_at = now;
    recovery.eta = eta;
    recovery.expires_at = expires_at;
    recovery.version = STATE_VERSION;
    recovery.bump = ctx.bumps.recovery;
    emit!(PlatformRecoveryProposed {
        current_admin,
        new_admin,
        proposed_by,
        eta,
        expires_at,
    });
    msg!(
        "Super-admin recovery proposed — {} executable from {}",
        new_admin,
        eta
    );
    Ok(())
}

#[derive(Accounts)]
pub struct CancelPlatformRecovery<'info> {
    /// The current super admin or the proposer. Not `mut`: it may be the same
    /// key as `proposer`.
    pub canceller: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut, close = proposer,
        seeds = [PLATFORM_RECOVERY_SEED, platform.key().as_ref()], bump = recovery.bump)]
    pub recovery: Box<Account<'info, PlatformRecovery>>,
    /// CHECK: the proposing upgrade authority; the rent always returns to it.
    #[account(mut, address = recovery.proposed_by @ RegistryError::InvalidPlatformRecovery)]
    pub proposer: UncheckedAccount<'info>,
}

pub fn handle_cancel_platform_recovery(ctx: Context<CancelPlatformRecovery>) -> Result<()> {
    let by = ctx.accounts.canceller.key();
    // Incident build: a COMPROMISED super admin must not be able to cancel,
    // so only the proposing upgrade authority may.
    #[cfg(not(feature = "incident"))]
    let allowed = by == ctx.accounts.platform.admin || by == ctx.accounts.recovery.proposed_by;
    #[cfg(feature = "incident")]
    let allowed = by == ctx.accounts.recovery.proposed_by;
    ensure(allowed, RegistryError::Unauthorized)?;
    emit!(PlatformRecoveryCancelled {
        cancelled_by: by,
        new_admin: ctx.accounts.recovery.new_admin,
    });
    msg!("Super-admin recovery cancelled");
    Ok(())
}

#[derive(Accounts)]
pub struct ExecutePlatformRecovery<'info> {
    /// The recovered key; pays its Admin record's rent (a Squads vault can).
    #[account(mut)]
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut, close = proposer,
        seeds = [PLATFORM_RECOVERY_SEED, platform.key().as_ref()], bump = recovery.bump,
        constraint = recovery.current_admin == platform.admin
            && recovery.new_admin == new_admin.key() @ RegistryError::InvalidPlatformRecovery)]
    pub recovery: Box<Account<'info, PlatformRecovery>>,
    /// CHECK: the proposing upgrade authority; receives the recovery's rent.
    #[account(mut, address = recovery.proposed_by @ RegistryError::InvalidPlatformRecovery)]
    pub proposer: UncheckedAccount<'info>,
    /// Binds `program_data` to THIS program (another program's ProgramData
    /// with the same upgrade authority must not stand in).
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ RegistryError::Unauthorized)]
    pub program: Program<'info, crate::program::AssetRegistry>,
    /// The upgrade authority must still be the proposer.
    #[account(constraint = program_data.upgrade_authority_address == Some(recovery.proposed_by) @ RegistryError::InvalidPlatformRecovery)]
    pub program_data: Box<Account<'info, ProgramData>>,
    /// CHECK: the lost super admin's Admin PDA, validated and closed in the
    /// handler when present.
    #[account(mut, seeds = [ADMIN_SEED, platform.admin.as_ref()], bump)]
    pub old_admin_record: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = new_admin, space = 8 + Admin::INIT_SPACE,
        seeds = [ADMIN_SEED, new_admin.key().as_ref()], bump)]
    pub new_admin_record: Box<Account<'info, Admin>>,
    /// A pending super-admin rotation, retired here when present.
    /// CHECK: address pinned by seeds; `util::retire_pending_proposal` checks the rest.
    #[account(mut, seeds = [AUTHORITY_PROPOSAL_SEED, platform.key().as_ref()], bump)]
    pub transfer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_execute_platform_recovery(ctx: Context<ExecutePlatformRecovery>) -> Result<()> {
    let recovery = &ctx.accounts.recovery;
    require_window(
        Clock::get()?.unix_timestamp,
        recovery.eta,
        recovery.expires_at,
    )?;
    let platform_key = ctx.accounts.platform.key();
    if retire_pending_proposal(
        &ctx.accounts.transfer.to_account_info(),
        &platform_key,
        AuthorityProposal::DISCRIMINATOR,
    )? {
        msg!("Pending super-admin rotation retired");
    }
    let new_admin = ctx.accounts.new_admin.key();
    let new_admin_record = &mut ctx.accounts.new_admin_record;
    let old_admin = install_platform_admin(
        &mut ctx.accounts.platform,
        &ctx.accounts.old_admin_record.to_account_info(),
        new_admin_record,
        new_admin,
        ctx.bumps.new_admin_record,
        &ctx.accounts.new_admin.to_account_info(),
    )?;
    emit!(PlatformAdminChanged {
        old_admin,
        new_admin,
        kind: PlatformAdminChangeKind::Recovery,
    });
    msg!("Super admin recovered — {} -> {}", old_admin, new_admin);
    Ok(())
}
