use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, Platform};

// `add_admin` (the timelocked executor) lives in `admin_timelock.rs`.

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
