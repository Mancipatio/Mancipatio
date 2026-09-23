use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{PauseFlagsChanged, Platform};
use crate::util;

#[derive(Accounts)]
pub struct SetPause<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        has_one = admin @ RegistryError::Unauthorized,
    )]
    pub platform: Account<'info, Platform>,
}

/// Legacy onboarding switch (super admin only): sets or clears ONLY
/// `PAUSE_ONBOARDING`; every other pause bit is left untouched. The full
/// emergency pause is `set_pause_flags`.
pub fn handle_set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
    let platform = &mut ctx.accounts.platform;
    let old = platform.pause_flags;
    platform.pause_flags = if paused {
        old | PAUSE_ONBOARDING
    } else {
        old & !PAUSE_ONBOARDING
    };
    emit!(PauseFlagsChanged {
        old,
        new: platform.pause_flags,
        by: ctx.accounts.admin.key(),
    });
    msg!(
        "Platform pause flags {:#04x} -> {:#04x}",
        old,
        platform.pause_flags
    );
    Ok(())
}

#[derive(Accounts)]
pub struct SetPauseFlags<'info> {
    pub authority: Signer<'info>,

    /// CHECK: `["admin", authority]`; validated in the handler with
    /// `util::is_active_admin` unless `authority == platform.admin` (a super
    /// admin without an Admin record is tolerated).
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump)]
    pub admin_record: UncheckedAccount<'info>,

    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
}

/// Emergency pause. `new = (old | set_mask) & !clear_mask`, so concurrent
/// pauses by different Admins combine instead of overwriting each other.
/// Any active Admin may SET defined bits; only the super admin may CLEAR
/// (and may clear undefined bits too, e.g. to normalize before a rollback).
pub fn handle_set_pause_flags(
    ctx: Context<SetPauseFlags>,
    set_mask: u8,
    clear_mask: u8,
) -> Result<()> {
    let by = ctx.accounts.authority.key();
    let platform = &mut ctx.accounts.platform;
    let is_super = by == platform.admin;
    require!(
        is_super || util::is_active_admin(&ctx.accounts.admin_record.to_account_info(), &by),
        RegistryError::Unauthorized
    );
    require!(
        set_mask & !PAUSE_FLAGS_ALL == 0 && set_mask & clear_mask == 0,
        RegistryError::InvalidPauseFlags
    );
    require!(
        clear_mask == 0 || is_super,
        RegistryError::PauseClearNotAllowed
    );
    let old = platform.pause_flags;
    platform.pause_flags = (old | set_mask) & !clear_mask;
    emit!(PauseFlagsChanged {
        old,
        new: platform.pause_flags,
        by,
    });
    msg!(
        "Platform pause flags {:#04x} -> {:#04x}",
        old,
        platform.pause_flags
    );
    Ok(())
}
