//! D3 — admin grants behind a 48 h timelock (design 8.3 §5.2).
//!
//! * `propose_admin(new_admin)` — the super admin stages a grant in
//!   `PendingAdmin` `["pending_admin", new_admin]`: executable from
//!   `eta = proposed_at + 48 h`, expiring 14 days later. A re-proposal
//!   overwrites it and restarts both clocks.
//! * `add_admin(new_admin)` — the executor (name and argument kept from rc.x
//!   for the discriminator): the NEW admin key signs (proof of possession, no
//!   second signature from a cold super admin), inside `[eta, expires_at)`,
//!   while the proposer is still the super admin. While the one-way bootstrap
//!   window is open the 48 h wait is waived at execution (`util::effective_eta`).
//! * `cancel_admin_proposal()` — the super admin, any live Admin, or the
//!   program upgrade authority. The upgrade authority is the veto a
//!   compromised super admin cannot remove (`remove_admin` stays instant);
//!   a griefing Admin is removed by the super admin.
//!
//! `remove_admin` and setting pause bits stay instant (`manage_admins.rs`,
//! `set_pause.rs`). The timelock gives NOTICE of a grant; the terminal answer
//! to a compromised super admin is the upgrade authority (D4 / incident build).

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    Admin, AdminAdded, AdminProposalCancelled, AdminProposed, PendingAdmin, Platform,
};
use crate::util::{effective_eta, ensure, is_veto_holder, require_window};

#[derive(Accounts)]
#[instruction(new_admin: Pubkey)]
pub struct ProposeAdmin<'info> {
    #[account(mut)]
    pub super_admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump,
        constraint = platform.admin == super_admin.key() @ RegistryError::Unauthorized)]
    pub platform: Box<Account<'info, Platform>>,
    /// The key must not hold the role already.
    /// CHECK: address pinned by seeds; only its emptiness is read.
    #[account(seeds = [ADMIN_SEED, new_admin.as_ref()], bump,
        constraint = new_admin_record.data_is_empty() @ RegistryError::InvalidProposedAuthority)]
    pub new_admin_record: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = super_admin, space = 8 + PendingAdmin::INIT_SPACE,
        seeds = [PENDING_ADMIN_SEED, new_admin.as_ref()], bump)]
    pub pending_admin: Box<Account<'info, PendingAdmin>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
    ensure(
        new_admin != Pubkey::default(),
        RegistryError::InvalidProposedAuthority,
    )?;
    let now = Clock::get()?.unix_timestamp;
    let eta = now
        .checked_add(ADMIN_TIMELOCK_SECS)
        .ok_or(RegistryError::Overflow)?;
    let expires_at = eta
        .checked_add(PROPOSAL_WINDOW_SECS)
        .ok_or(RegistryError::Overflow)?;
    let proposed_by = ctx.accounts.super_admin.key();
    let pending = &mut ctx.accounts.pending_admin;
    pending.new_admin = new_admin;
    pending.proposed_by = proposed_by;
    pending.proposed_at = now;
    pending.eta = eta;
    pending.expires_at = expires_at;
    pending.version = STATE_VERSION;
    pending.bump = ctx.bumps.pending_admin;
    emit!(AdminProposed {
        new_admin,
        proposed_by,
        proposed_at: now,
        eta,
        expires_at,
        bootstrap_open: ctx.accounts.platform.bootstrap_open(),
    });
    msg!("Admin proposed — {} executable from {}", new_admin, eta);
    Ok(())
}

#[derive(Accounts)]
#[instruction(proposed: Pubkey)]
pub struct AddAdmin<'info> {
    /// The proposed key itself; pays the Admin record's rent.
    #[account(mut, constraint = new_admin.key() == proposed @ RegistryError::InvalidAdminProposal)]
    pub new_admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    /// Consumed here (rent to the proposer). Stale once the super admin that
    /// proposed it is no longer the super admin.
    #[account(mut, close = proposer,
        seeds = [PENDING_ADMIN_SEED, new_admin.key().as_ref()], bump = pending_admin.bump,
        constraint = pending_admin.proposed_by == platform.admin @ RegistryError::InvalidAdminProposal)]
    pub pending_admin: Box<Account<'info, PendingAdmin>>,
    /// CHECK: the proposing super admin, who paid the proposal's rent.
    #[account(mut, address = pending_admin.proposed_by @ RegistryError::InvalidAdminProposal)]
    pub proposer: UncheckedAccount<'info>,
    #[account(init, payer = new_admin, space = 8 + Admin::INIT_SPACE,
        seeds = [ADMIN_SEED, new_admin.key().as_ref()], bump)]
    pub admin_record: Box<Account<'info, Admin>>,
    pub system_program: Program<'info, System>,
}

/// The proposed key takes the Admin role inside `[eta, expires_at)`
/// (`eta` waived while bootstrap is open).
pub fn handle_add_admin(ctx: Context<AddAdmin>, _new_admin: Pubkey) -> Result<()> {
    let pending = &ctx.accounts.pending_admin;
    let now = Clock::get()?.unix_timestamp;
    require_window(
        now,
        effective_eta(&ctx.accounts.platform, pending.proposed_at, pending.eta),
        pending.expires_at,
    )?;
    let admin = ctx.accounts.new_admin.key();
    let added_by = pending.proposed_by;
    let proposed_at = pending.proposed_at;
    let record = &mut ctx.accounts.admin_record;
    record.admin = admin;
    record.added_by = added_by;
    record.bump = ctx.bumps.admin_record;
    emit!(AdminAdded {
        admin,
        added_by,
        proposed_at,
    });
    msg!("Admin granted — {}", admin);
    Ok(())
}

#[derive(Accounts)]
pub struct CancelAdminProposal<'info> {
    /// The super admin, a live Admin, or the program upgrade authority. Not
    /// `mut`: it may be the same key as `proposer`.
    pub canceller: Signer<'info>,
    /// CHECK: `["admin", canceller]`; read by `util::is_active_admin`.
    #[account(seeds = [ADMIN_SEED, canceller.key().as_ref()], bump)]
    pub canceller_admin_record: UncheckedAccount<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut, close = proposer,
        seeds = [PENDING_ADMIN_SEED, pending_admin.new_admin.as_ref()], bump = pending_admin.bump)]
    pub pending_admin: Box<Account<'info, PendingAdmin>>,
    /// CHECK: the proposing super admin; the rent always returns to it.
    #[account(mut, address = pending_admin.proposed_by @ RegistryError::InvalidAdminProposal)]
    pub proposer: UncheckedAccount<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ RegistryError::Unauthorized)]
    pub program: Program<'info, crate::program::AssetRegistry>,
    pub program_data: Box<Account<'info, ProgramData>>,
}

pub fn handle_cancel_admin_proposal(ctx: Context<CancelAdminProposal>) -> Result<()> {
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
    let pending = &ctx.accounts.pending_admin;
    emit!(AdminProposalCancelled {
        new_admin: pending.new_admin,
        proposed_by: pending.proposed_by,
        cancelled_by: by,
    });
    msg!("Admin proposal cancelled — {}", pending.new_admin);
    Ok(())
}
