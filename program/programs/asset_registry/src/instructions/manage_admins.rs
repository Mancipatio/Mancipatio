use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, Platform};

#[derive(Accounts)]
#[instruction(new_admin: Pubkey)]
pub struct AddAdmin<'info> {
    #[account(mut)]
    pub super_admin: Signer<'info>,

    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = platform.admin == super_admin.key() @ RegistryError::Unauthorized,
    )]
    pub platform: Account<'info, Platform>,

    #[account(
        init,
        payer = super_admin,
        space = 8 + Admin::INIT_SPACE,
        seeds = [ADMIN_SEED, new_admin.as_ref()],
        bump
    )]
    pub admin_record: Account<'info, Admin>,

    pub system_program: Program<'info, System>,
}

/// Super admin grants the admin role to `new_admin`.
pub fn handle_add_admin(ctx: Context<AddAdmin>, new_admin: Pubkey) -> Result<()> {
    let rec = &mut ctx.accounts.admin_record;
    rec.admin = new_admin;
    rec.added_by = ctx.accounts.super_admin.key();
    rec.bump = ctx.bumps.admin_record;
    msg!("Admin granted — {}", new_admin);
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

/// Super admin revokes the admin role from `admin`.
pub fn handle_remove_admin(ctx: Context<RemoveAdmin>, admin: Pubkey) -> Result<()> {
    require!(
        admin != ctx.accounts.platform.admin,
        RegistryError::CannotRevokePlatformAdmin
    );
    msg!("Admin revoked — {}", admin);
    Ok(())
}
