use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    PayoutVault, PayoutVaultState, VaultVote, VaultVoteChoice, VaultVoteOutcome, VaultVoteRecord,
};
use crate::util::{snapshot_leaf, verify_merkle_proof};

#[derive(Accounts)]
pub struct CastVaultVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_VOTE_SEED, vote.payout_vault.as_ref(), &vote.round.to_le_bytes()],
        bump = vote.bump,
        constraint = vote.outcome == VaultVoteOutcome::Pending @ RegistryError::VoteInProgress,
    )]
    pub vote: Box<Account<'info, VaultVote>>,

    #[account(
        init,
        payer = voter,
        space = 8 + VaultVoteRecord::INIT_SPACE,
        seeds = [VAULT_VOTE_RECORD_SEED, vote.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub record: Box<Account<'info, VaultVoteRecord>>,

    pub system_program: Program<'info, System>,

    #[account(
        seeds = [PAYOUT_SEED, vault.sale.as_ref()],
        bump = vault.bump,
        constraint = vault.version == PAYOUT_STATE_VERSION @ RegistryError::AccountMigrationRequired,
        constraint = vote.payout_vault == vault.key() && vault.vote_pending && vote.round == vault.vote_round @ RegistryError::InvalidVaultVoteRound,
        constraint = vault.state == PayoutVaultState::Frozen @ RegistryError::VaultNotFrozen,
    )]
    pub vault: Box<Account<'info, PayoutVault>>,
}

pub fn handle_cast_vault_vote(
    ctx: Context<CastVaultVote>,
    weight: u64,
    proof: Vec<[u8; 32]>,
    choice: VaultVoteChoice,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now < ctx.accounts.vote.end_ts, RegistryError::VotingClosed);

    let leaf = snapshot_leaf(&ctx.accounts.voter.key(), weight);
    require!(
        verify_merkle_proof(ctx.accounts.vote.snapshot_root, leaf, &proof),
        RegistryError::InvalidMerkleProof
    );

    let total_cast = ctx
        .accounts
        .vote
        .return_weight
        .checked_add(ctx.accounts.vote.extend_weight)
        .and_then(|sum| sum.checked_add(weight))
        .ok_or(RegistryError::Overflow)?;
    require!(
        weight > 0 && total_cast <= ctx.accounts.vault.total_weight,
        RegistryError::InvalidRaiseParams
    );

    let vote = &mut ctx.accounts.vote;
    match choice {
        VaultVoteChoice::ReturnCapital => {
            vote.return_weight = vote
                .return_weight
                .checked_add(weight)
                .ok_or(RegistryError::Overflow)?
        }
        VaultVoteChoice::Extend => {
            vote.extend_weight = vote
                .extend_weight
                .checked_add(weight)
                .ok_or(RegistryError::Overflow)?
        }
    }

    let record = &mut ctx.accounts.record;
    record.vault_vote = vote.key();
    record.voter = ctx.accounts.voter.key();
    record.weight = weight;
    record.choice = choice;
    record.version = STATE_VERSION;
    record.bump = ctx.bumps.record;

    msg!("VaultVote cast — {:?} weight {}", choice, weight);
    Ok(())
}
