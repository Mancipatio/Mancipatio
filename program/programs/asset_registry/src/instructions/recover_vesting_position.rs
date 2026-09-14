use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{VestingPosition, VestingPositionRecovered, VestingSeries, VestingSeriesStatus};

#[derive(Accounts)]
#[instruction(position_index: u32)]
pub struct RecoverVestingPosition<'info> {
    /// The client — series authority. Recovery authority sits with the
    /// CLIENT, not with Mancipatio (spec §11.1.10); confirming that the
    /// replacement wallet belongs to the same person is the client's own
    /// off-chain verification process.
    pub authority: Signer<'info>,

    #[account(
        seeds = [
            VESTING_SERIES_SEED,
            series.authority.as_ref(),
            &series.series_id.to_le_bytes(),
        ],
        bump = series.bump,
        has_one = authority @ RegistryError::Unauthorized,
        constraint = series.recovery_enabled @ RegistryError::VestingRecoveryDisabled,
        constraint = series.status != VestingSeriesStatus::Draft @ RegistryError::VestingNotActive,
    )]
    pub series: Box<Account<'info, VestingSeries>>,

    #[account(
        mut,
        seeds = [
            VESTING_POSITION_SEED,
            series.key().as_ref(),
            &position_index.to_le_bytes(),
        ],
        bump = position.bump,
        has_one = series @ RegistryError::Unauthorized,
    )]
    pub position: Box<Account<'info, VestingPosition>>,
}

/// Re-points a position to a replacement wallet when the recipient loses
/// access to their key. It changes the ADDRESS of the same recipient — it
/// does not move the position to a different person: the full position
/// (unreleased claimable balance + all future tranches) now belongs to the
/// new wallet, and the old wallet can no longer claim anything. Tokens
/// already released were the recipient's property and stay where they are.
/// Available only when the series was created with recovery ON — a setting
/// fixed forever at creation.
pub fn handle_recover_vesting_position(
    ctx: Context<RecoverVestingPosition>,
    _position_index: u32,
    new_wallet: Pubkey,
) -> Result<()> {
    let p = &mut ctx.accounts.position;
    let old_wallet = p.wallet;
    p.wallet = new_wallet;

    emit!(VestingPositionRecovered {
        series: p.series,
        position: p.key(),
        old_wallet,
        new_wallet,
    });

    msg!("Vesting position #{} recovered to {}", p.index, new_wallet);
    Ok(())
}
