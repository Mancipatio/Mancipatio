use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Platform, ProtocolTreasuryChanged};

#[derive(Accounts)]
pub struct SetProtocolTreasury<'info> {
    pub super_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = platform.admin == super_admin.key() @ RegistryError::Unauthorized,
    )]
    pub platform: Account<'info, Platform>,
}

/// Super admin rotates the protocol treasury wallet. `route_yield` reads it
/// live, so the next routed yield pays the new owner's token account. The new
/// treasury does not co-sign: a multisig vault PDA could not.
pub fn handle_set_protocol_treasury(
    ctx: Context<SetProtocolTreasury>,
    new_treasury: Pubkey,
) -> Result<()> {
    require!(
        new_treasury != Pubkey::default(),
        RegistryError::InvalidProtocolTreasury
    );
    let platform = &mut ctx.accounts.platform;
    let old = platform.protocol_treasury;
    platform.protocol_treasury = new_treasury;
    emit!(ProtocolTreasuryChanged {
        old,
        new: new_treasury,
        by: ctx.accounts.super_admin.key(),
    });
    msg!("Protocol treasury {} -> {}", old, new_treasury);
    Ok(())
}
