use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::Platform;

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

/// Emergency circuit breaker — blocks issuer / asset creation while paused.
pub fn handle_set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
    ctx.accounts.platform.paused = paused;
    msg!("Platform paused = {}", paused);
    Ok(())
}
