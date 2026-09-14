use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{VestingSeries, VestingSeriesCancelled, VestingSeriesStatus};
use crate::util::vesting_cumulative;

#[derive(Accounts)]
pub struct CancelVestingSeries<'info> {
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
        constraint = matches!(series.status, VestingSeriesStatus::Draft | VestingSeriesStatus::Active)
            @ RegistryError::VestingNotActive,
        constraint = series.status == VestingSeriesStatus::Draft || series.cancellation_enabled @ RegistryError::VestingNotCancellable,
    )]
    pub series: Box<Account<'info, VestingSeries>>,
}

/// Aborts any Draft without granting rights, or cancels an Active series
/// when cancellation is enabled. Active cancellation
/// can never take vested tokens: every position keeps what had vested at this
/// moment — INCLUDING tranches still awaiting approval, approval gates timing
/// not ownership — and only the unvested remainder becomes withdrawable by
/// the client via `withdraw_unvested`. Cancelled before anything vested, each
/// recipient keeps `pre_cliff_bps` of their allocation (0 unless the client
/// set it at creation). Entitlements stay claimable forever (spec §11.1.10).
pub fn handle_cancel_vesting_series(ctx: Context<CancelVestingSeries>) -> Result<()> {
    let s = &mut ctx.accounts.series;
    let now = Clock::get()?.unix_timestamp;

    s.final_cumulative = if s.status == VestingSeriesStatus::Draft {
        // Drafts never grant rights, even after their proposed start passes or
        // when active cancellation was disabled. Abort always unlocks deposits.
        0
    } else {
        let total = crate::util::vesting_schedule_total(&s.tranches)?;
        require!(
            total == s.total_allocated && total > 0,
            RegistryError::VestingAllocationMismatch
        );
        let vested_cum = vesting_cumulative(&s.tranches, now);
        if vested_cum == 0 {
            ((s.total_allocated as u128) * (s.pre_cliff_bps as u128) / 10_000u128) as u64
        } else {
            vested_cum
        }
    };
    s.status = VestingSeriesStatus::Cancelled;
    s.cancelled_at = now;

    emit!(VestingSeriesCancelled {
        series: s.key(),
        cancelled_at: now,
        final_cumulative: s.final_cumulative,
    });

    msg!(
        "Vesting series {} cancelled — {} units stay reserved for recipients",
        s.series_id,
        s.final_cumulative
    );
    Ok(())
}
