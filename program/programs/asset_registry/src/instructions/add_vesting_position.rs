use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{VestingPosition, VestingPositionAdded, VestingSeries, VestingSeriesStatus};

#[derive(Accounts)]
pub struct AddVestingPosition<'info> {
    /// The client — series authority.
    #[account(mut)]
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
        constraint = series.status == VestingSeriesStatus::Draft
            @ RegistryError::VestingNotDraft,
    )]
    pub series: Box<Account<'info, VestingSeries>>,

    #[account(
        init,
        payer = authority,
        space = 8 + VestingPosition::INIT_SPACE,
        seeds = [
            VESTING_POSITION_SEED,
            series.key().as_ref(),
            &series.positions_count.to_le_bytes(),
        ],
        bump
    )]
    pub position: Box<Account<'info, VestingPosition>>,

    pub system_program: Program<'info, System>,
}

/// Adds a recipient position — wallet + allocation. Non-transferable by
/// construction: only the recorded wallet can ever claim/receive, and only
/// `recover_vesting_position` (if enabled at creation) can change that record.
pub fn handle_add_vesting_position(
    ctx: Context<AddVestingPosition>,
    wallet: Pubkey,
    allocation: u64,
) -> Result<()> {
    require!(allocation > 0, RegistryError::InvalidVestingAllocation);

    let s = &mut ctx.accounts.series;
    let p = &mut ctx.accounts.position;
    p.series = s.key();
    p.index = s.positions_count;
    p.wallet = wallet;
    p.allocation = allocation;
    p.released = 0;
    p.version = STATE_VERSION;
    p.bump = ctx.bumps.position;

    s.positions_count = s
        .positions_count
        .checked_add(1)
        .ok_or(RegistryError::Overflow)?;
    s.total_allocated = s
        .total_allocated
        .checked_add(allocation)
        .ok_or(RegistryError::Overflow)?;

    emit!(VestingPositionAdded {
        series: s.key(),
        position: p.key(),
        wallet,
        allocation,
        total_allocated: s.total_allocated,
    });

    msg!("Vesting position #{} added — {} units", p.index, allocation);
    Ok(())
}
