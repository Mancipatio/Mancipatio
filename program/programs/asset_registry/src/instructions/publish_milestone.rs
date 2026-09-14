use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, RightsIssuance, VestingMilestone};

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct PublishMilestone<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        mut,
        seeds = [
            RIGHTS_SEED,
            rights_issuance.share_class.as_ref(),
            &rights_issuance.issuance_id.to_le_bytes(),
        ],
        bump = rights_issuance.bump,
        has_one = authority @ RegistryError::Unauthorized,
    )]
    pub rights_issuance: Box<Account<'info, RightsIssuance>>,

    #[account(
        init,
        payer = authority,
        space = 8 + VestingMilestone::INIT_SPACE,
        seeds = [RT_MILESTONE_SEED, rights_issuance.key().as_ref(), &index.to_le_bytes()],
        bump
    )]
    pub milestone: Box<Account<'info, VestingMilestone>>,

    pub system_program: Program<'info, System>,
}

/// Publishes a vesting milestone — a pool of underlying tokens claimable
/// against `merkle_root`, a snapshot of `(claimer, entitlement)`.
pub fn handle_publish_milestone(
    ctx: Context<PublishMilestone>,
    index: u16,
    merkle_root: [u8; 32],
    amount_pool: u64,
    unlock_ts: i64,
) -> Result<()> {
    let m = &mut ctx.accounts.milestone;
    m.issuance = ctx.accounts.rights_issuance.key();
    m.index = index;
    m.merkle_root = merkle_root;
    m.amount_pool = amount_pool;
    m.claimed = 0;
    m.unlock_ts = unlock_ts;
    m.version = STATE_VERSION;
    m.bump = ctx.bumps.milestone;

    let ri = &mut ctx.accounts.rights_issuance;
    ri.milestones_count = ri
        .milestones_count
        .checked_add(1)
        .ok_or(RegistryError::Overflow)?;

    msg!(
        "Vesting milestone {} published — pool {}",
        index,
        amount_pool
    );
    Ok(())
}
