use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{VestingCancellationDisabled, VestingSeries, VestingSeriesStatus};

#[derive(Accounts)]
pub struct DisableVestingCancellation<'info> {
    /// The client — series authority.
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [
            VESTING_SERIES_SEED,
            series.authority.as_ref(),
            &series.series_id.to_le_bytes(),
        ],
        bump = series.bump,
        has_one = authority @ RegistryError::Unauthorized,
        constraint = series.status == VestingSeriesStatus::Active
            @ RegistryError::VestingNotActive,
        constraint = series.cancellation_enabled @ RegistryError::VestingNotCancellable,
    )]
    pub series: Box<Account<'info, VestingSeries>>,
}

/// Irrevocably gives up the cancellation power: ON → OFF, never the reverse
/// (spec §11.1.10). Investor schedules are typically created non-cancellable;
/// a client who started cancellable can lock that in here.
pub fn handle_disable_vesting_cancellation(ctx: Context<DisableVestingCancellation>) -> Result<()> {
    let s = &mut ctx.accounts.series;
    s.cancellation_enabled = false;

    emit!(VestingCancellationDisabled { series: s.key() });

    msg!(
        "Vesting series {} — cancellation permanently disabled",
        s.series_id
    );
    Ok(())
}
