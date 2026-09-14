use crate::{
    constants::*,
    error::RegistryError,
    state::{VestingSeries, VestingSeriesStatus},
    util::vesting_schedule_total,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct FinalizeVestingSeries<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [VESTING_SERIES_SEED, series.authority.as_ref(), &series.series_id.to_le_bytes()],
        bump = series.bump,
        has_one = authority @ RegistryError::Unauthorized,
        constraint = series.status == VestingSeriesStatus::Draft @ RegistryError::VestingNotDraft,
    )]
    pub series: Box<Account<'info, VestingSeries>>,
}

/// Commits all recipient allocations before any scheduled rights arise.
/// Funding may arrive in installments; delivery retains its full-funding gate.
pub fn handle_finalize_vesting_series(ctx: Context<FinalizeVestingSeries>) -> Result<()> {
    let series = &mut ctx.accounts.series;
    let total = vesting_schedule_total(&series.tranches)?;
    require!(
        series.positions_count > 0 && total > 0 && series.total_allocated == total,
        RegistryError::VestingAllocationMismatch
    );
    let first = series
        .tranches
        .first()
        .ok_or(RegistryError::InvalidVestingSchedule)?;
    require!(
        Clock::get()?.unix_timestamp < first.unlock_ts,
        RegistryError::VestingStartReached
    );
    require!(
        series.total_released == 0 && series.approved_mask == 0,
        RegistryError::VestingAlreadyStarted
    );
    series.status = VestingSeriesStatus::Active;
    msg!(
        "Vesting series {} finalized — {} fixed units across {} positions",
        series.series_id,
        total,
        series.positions_count
    );
    Ok(())
}
