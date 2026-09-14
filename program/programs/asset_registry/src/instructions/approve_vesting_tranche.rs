use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{VestingSeries, VestingSeriesStatus, VestingTimingMode, VestingTrancheApproved};

#[derive(Accounts)]
#[instruction(tranche_index: u16)]
pub struct ApproveVestingTranche<'info> {
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
        constraint = series.timing_mode == VestingTimingMode::Approval
            @ RegistryError::VestingNotApprovalMode,
    )]
    pub series: Box<Account<'info, VestingSeries>>,
}

/// Approves one tranche's release (Approval-mode series). Approval gates
/// TIMING, never ownership: a vested tranche the client leaves un-approved
/// becomes deliverable anyway once its approval window lapses, and a
/// cancelled series keeps every vested tranche the recipient's regardless of
/// approval state (spec §11.1.10).
pub fn handle_approve_vesting_tranche(
    ctx: Context<ApproveVestingTranche>,
    tranche_index: u16,
) -> Result<()> {
    let s = &mut ctx.accounts.series;
    require!(
        (tranche_index as usize) < s.tranches.len(),
        RegistryError::InvalidTrancheIndex
    );

    s.approved_mask |= 1u64 << tranche_index;

    emit!(VestingTrancheApproved {
        series: s.key(),
        tranche_index,
        approved_mask: s.approved_mask,
    });

    msg!("Vesting tranche {} approved", tranche_index);
    Ok(())
}
