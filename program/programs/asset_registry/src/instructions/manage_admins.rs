use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, AdminGranted, Platform};

// `add_admin` (the timelocked executor) lives in `admin_timelock.rs`.

#[derive(Accounts)]
#[instruction(new_admin: Pubkey)]
pub struct GrantAdmin<'info> {
    /// Pays the Admin record's rent (`remove_admin` returns it to the super
    /// admin that signs the removal).
    #[account(mut)]
    pub super_admin: Signer<'info>,

    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = platform.admin == super_admin.key() @ RegistryError::Unauthorized,
    )]
    pub platform: Account<'info, Platform>,

    /// Created here, so a key that already holds the role fails the `init`.
    #[account(
        init,
        payer = super_admin,
        space = 8 + Admin::INIT_SPACE,
        seeds = [ADMIN_SEED, new_admin.as_ref()],
        bump,
    )]
    pub admin_record: Account<'info, Admin>,

    pub system_program: Program<'info, System>,
}

/// Super admin grants the admin role to `new_admin` at once: no timelock and
/// no signature of the new key (owner decision 2026-11-09). It sits beside
/// the D3 path (`propose_admin` → 48 h → `add_admin` by the new key), which
/// stays for a grant the new key should confirm itself. Without the 48 h
/// there is no window for a veto: a compromised super admin can add Admins
/// at once, and the answer is `remove_admin` after the recovery (D4 /
/// incident build), so every grant is a critical alarm.
pub fn handle_grant_admin(ctx: Context<GrantAdmin>, new_admin: Pubkey) -> Result<()> {
    require!(
        new_admin != Pubkey::default(),
        RegistryError::InvalidProposedAuthority
    );
    let granted_by = ctx.accounts.super_admin.key();
    let granted_at = Clock::get()?.unix_timestamp;
    let record = &mut ctx.accounts.admin_record;
    record.admin = new_admin;
    record.added_by = granted_by;
    record.bump = ctx.bumps.admin_record;
    emit!(AdminGranted {
        admin: new_admin,
        granted_by,
        granted_at,
    });
    msg!("Admin granted by the super admin — {}", new_admin);
    Ok(())
}

#[derive(Accounts)]
#[instruction(admin: Pubkey)]
pub struct RemoveAdmin<'info> {
    #[account(mut)]
    pub super_admin: Signer<'info>,

    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = platform.admin == super_admin.key() @ RegistryError::Unauthorized,
    )]
    pub platform: Account<'info, Platform>,

    #[account(
        mut,
        close = super_admin,
        seeds = [ADMIN_SEED, admin.as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Account<'info, Admin>,
}

/// Super admin revokes the admin role from `admin` — instant (D3 keeps the
/// removal of a role untimelocked; only grants wait).
pub fn handle_remove_admin(ctx: Context<RemoveAdmin>, admin: Pubkey) -> Result<()> {
    require!(
        admin != ctx.accounts.platform.admin,
        RegistryError::CannotRevokePlatformAdmin
    );
    msg!("Admin revoked — {}", admin);
    Ok(())
}
