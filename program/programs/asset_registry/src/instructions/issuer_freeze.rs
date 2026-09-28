//! D1 — freeze the proceeds of ONE issuer (design 8.3 §3).
//!
//! `freeze_issuer_proceeds` (any live Admin, or the super admin) creates the
//! `IssuerFreeze` PDA `["issuer_freeze", issuer]`; `unfreeze_issuer_proceeds`
//! (super admin only — the same asymmetry as the pause bits) closes it, rent
//! to the freezer. While it exists, every instruction through which investor
//! money reaches that issuer fails with `IssuerProceedsFrozen` (6143):
//! `close_sale`, `open_payout_vault`, `release_payout`,
//! `claim_founder_yield`, and — so no new money flows in — `buy` and
//! `open_sale`. Each takes the PDA as an appended account that must be unset
//! (system-owned, no data; `util::is_unset`), so a pre-funded address does
//! not freeze anyone and a live freeze cannot be skipped.
//!
//! Not gated, by decision: investor exits (`claim_refund`,
//! `claim_investor_yield`, `claim_milestone`), `close_distribution` (the
//! funder's money), vesting withdrawals (the client's own tokens) and
//! secondary sales from the issuer's own wallet (owner decision O-9: a
//! BlocklistAuthority block of that wallet, per runbook). v1 has no on-chain
//! refund of frozen proceeds: the money stays in the proceeds or payout
//! escrow until the super admin unfreezes or the program is upgraded.
//!
//! Neither instruction reads the pause bits: a freeze is an incident
//! response, and an unfreeze moves no funds.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Issuer, IssuerFreeze, IssuerProceedsFrozen, IssuerProceedsUnfrozen, Platform};
use crate::util::{ensure, is_active_admin};

#[derive(Accounts)]
pub struct FreezeIssuerProceeds<'info> {
    /// A live Admin, or the super admin (with or without an Admin record).
    /// Pays the freeze's rent and gets it back on unfreeze.
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: `["admin", authority]`; read by `util::is_active_admin` unless
    /// `authority` is the super admin.
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump)]
    pub admin_record: UncheckedAccount<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()], bump = issuer.bump)]
    pub issuer: Box<Account<'info, Issuer>>,
    /// A second freeze of the same issuer fails (the account is in use): it
    /// never silently overwrites the first freezer or reason.
    #[account(init, payer = authority, space = 8 + IssuerFreeze::INIT_SPACE,
        seeds = [ISSUER_FREEZE_SEED, issuer.key().as_ref()], bump)]
    pub issuer_freeze: Box<Account<'info, IssuerFreeze>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_freeze_issuer_proceeds(
    ctx: Context<FreezeIssuerProceeds>,
    reason_hash: [u8; 32],
) -> Result<()> {
    let by = ctx.accounts.authority.key();
    ensure(
        by == ctx.accounts.platform.admin
            || is_active_admin(&ctx.accounts.admin_record.to_account_info(), &by),
        RegistryError::Unauthorized,
    )?;
    let issuer = ctx.accounts.issuer.key();
    let now = Clock::get()?.unix_timestamp;
    let freeze = &mut ctx.accounts.issuer_freeze;
    freeze.issuer = issuer;
    freeze.frozen_by = by;
    freeze.frozen_at = now;
    freeze.reason_hash = reason_hash;
    freeze.version = STATE_VERSION;
    freeze.bump = ctx.bumps.issuer_freeze;
    emit!(IssuerProceedsFrozen {
        issuer,
        frozen_by: by,
        frozen_at: now,
        reason_hash,
    });
    msg!("Issuer {} proceeds frozen by {}", issuer, by);
    Ok(())
}

#[derive(Accounts)]
pub struct UnfreezeIssuerProceeds<'info> {
    pub super_admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump,
        constraint = platform.admin == super_admin.key() @ RegistryError::Unauthorized)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut, close = frozen_by,
        seeds = [ISSUER_FREEZE_SEED, issuer_freeze.issuer.as_ref()], bump = issuer_freeze.bump)]
    pub issuer_freeze: Box<Account<'info, IssuerFreeze>>,
    /// CHECK: the freezer, who paid the rent and gets it back.
    #[account(mut, address = issuer_freeze.frozen_by @ RegistryError::Unauthorized)]
    pub frozen_by: UncheckedAccount<'info>,
}

/// Only the super admin lifts a freeze. It does NOT remove a
/// BlocklistAuthority block of the issuer's wallet (O-9 SOP): that is a
/// separate `remove_from_blocklist` by the hook's BlocklistAuthority.
pub fn handle_unfreeze_issuer_proceeds(ctx: Context<UnfreezeIssuerProceeds>) -> Result<()> {
    let freeze = &ctx.accounts.issuer_freeze;
    emit!(IssuerProceedsUnfrozen {
        issuer: freeze.issuer,
        unfrozen_by: ctx.accounts.super_admin.key(),
        frozen_by: freeze.frozen_by,
        frozen_at: freeze.frozen_at,
    });
    msg!("Issuer {} proceeds unfrozen", freeze.issuer);
    Ok(())
}
