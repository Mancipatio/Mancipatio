use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, PayoutVault, PayoutVaultState, VaultVote, VaultVoteOutcome};

#[derive(Accounts)]
pub struct OpenVaultVote<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate — the signer must hold an `Admin` record.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        mut,
        seeds = [PAYOUT_SEED, vault.sale.as_ref()],
        bump = vault.bump,
        constraint = vault.state == PayoutVaultState::Frozen @ RegistryError::VaultNotFrozen,
        constraint = vault.version == PAYOUT_STATE_VERSION @ RegistryError::AccountMigrationRequired,
        constraint = !vault.vote_pending @ RegistryError::VaultVoteAlreadyOpen,
    )]
    pub vault: Box<Account<'info, PayoutVault>>,

    #[account(
        init,
        payer = authority,
        space = 8 + VaultVote::INIT_SPACE,
        seeds = [VAULT_VOTE_SEED, vault.key().as_ref(), &vault.vote_round.checked_add(1).ok_or(RegistryError::Overflow)?.to_le_bytes()],
        bump
    )]
    pub vote: Box<Account<'info, VaultVote>>,

    pub system_program: Program<'info, System>,
}

pub fn handle_open_vault_vote(
    ctx: Context<OpenVaultVote>,
    snapshot_root: [u8; 32],
    total_weight: u64,
    voting_period: i64,
) -> Result<()> {
    require!(
        total_weight > 0 && voting_period > 0,
        RegistryError::InvalidRaiseParams
    );
    let now = Clock::get()?.unix_timestamp;

    let vote = &mut ctx.accounts.vote;
    vote.payout_vault = ctx.accounts.vault.key();
    vote.snapshot_root = snapshot_root;
    vote.start_ts = now;
    vote.end_ts = now
        .checked_add(voting_period)
        .ok_or(RegistryError::Overflow)?;
    vote.return_weight = 0;
    vote.extend_weight = 0;
    vote.outcome = VaultVoteOutcome::Pending;
    vote.version = PAYOUT_STATE_VERSION;
    vote.round = ctx
        .accounts
        .vault
        .vote_round
        .checked_add(1)
        .ok_or(RegistryError::Overflow)?;
    vote.bump = ctx.bumps.vote;

    let v = &mut ctx.accounts.vault;
    v.vote_round = vote.round;
    v.vote_pending = true;
    if v.total_weight == 0 {
        v.total_weight = total_weight;
    } else {
        require!(
            v.total_weight == total_weight,
            RegistryError::InvalidRaiseParams
        );
    }
    Ok(())
}
