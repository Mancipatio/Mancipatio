use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, Platform};

#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Platform::INIT_SPACE,
        seeds = [PLATFORM_SEED],
        bump
    )]
    pub platform: Account<'info, Platform>,

    /// The super admin is also admin #1 — every privileged instruction requires
    /// an `Admin` record, so the super admin needs one to operate.
    #[account(
        init,
        payer = admin,
        space = 8 + Admin::INIT_SPACE,
        seeds = [ADMIN_SEED, admin.key().as_ref()],
        bump
    )]
    pub super_admin_record: Account<'info, Admin>,

    pub system_program: Program<'info, System>,

    /// Deployment authority authorizes the initial operational administrator.
    pub upgrade_authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ RegistryError::Unauthorized)]
    pub program: Program<'info, crate::program::AssetRegistry>,
    #[account(constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ RegistryError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
}

pub fn handle_initialize_platform(
    ctx: Context<InitializePlatform>,
    protocol_treasury: Pubkey,
    protocol_fee_bps: u16,
) -> Result<()> {
    require!(
        protocol_fee_bps <= MAX_FEE_BPS,
        RegistryError::InvalidFeeBps
    );
    require!(
        protocol_treasury != Pubkey::default(),
        RegistryError::InvalidProtocolTreasury
    );

    let platform = &mut ctx.accounts.platform;
    platform.admin = ctx.accounts.admin.key();
    platform.protocol_treasury = protocol_treasury;
    platform.protocol_fee_bps = protocol_fee_bps;
    // A fresh platform starts fully paused: the bootstrap finishes its setup
    // (blocklist authority, admins, custody) and then clears the flags with
    // `set_pause_flags(0, PAUSE_FLAGS_ALL)` before handing over authority.
    platform.pause_flags = PAUSE_FLAGS_ALL;
    platform.issuers_count = 0;
    platform.version = STATE_VERSION;
    platform.bump = ctx.bumps.platform;

    let rec = &mut ctx.accounts.super_admin_record;
    rec.admin = ctx.accounts.admin.key();
    rec.added_by = ctx.accounts.admin.key();
    rec.bump = ctx.bumps.super_admin_record;

    msg!(
        "Platform initialized — super admin {}",
        ctx.accounts.admin.key()
    );
    Ok(())
}
