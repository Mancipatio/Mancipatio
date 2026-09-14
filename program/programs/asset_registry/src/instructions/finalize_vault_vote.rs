use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{PayoutVault, PayoutVaultState, VaultVote, VaultVoteOutcome};

#[derive(Accounts)]
pub struct FinalizeVaultVote<'info> {
    #[account(
        mut,
        seeds = [PAYOUT_SEED, vault.sale.as_ref()],
        bump = vault.bump,
        constraint = vault.state == PayoutVaultState::Frozen @ RegistryError::VaultNotFrozen,
        constraint = vault.version == PAYOUT_STATE_VERSION @ RegistryError::AccountMigrationRequired,
        constraint = vault.vote_pending @ RegistryError::InvalidVaultVoteRound,
    )]
    pub vault: Box<Account<'info, PayoutVault>>,

    #[account(
        mut,
        seeds = [VAULT_VOTE_SEED, vault.key().as_ref(), &vote.round.to_le_bytes()],
        bump = vote.bump,
        constraint = vote.payout_vault == vault.key() @ RegistryError::Unauthorized,
        constraint = vote.round == vault.vote_round && vote.outcome == VaultVoteOutcome::Pending @ RegistryError::InvalidVaultVoteRound,
    )]
    pub vote: Box<Account<'info, VaultVote>>,
}

pub fn handle_finalize_vault_vote(ctx: Context<FinalizeVaultVote>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.vote.end_ts,
        RegistryError::VoteInProgress
    );

    ctx.accounts.vault.vote_pending = false;
    let return_w = ctx.accounts.vote.return_weight;
    let extend_w = ctx.accounts.vote.extend_weight;

    if return_w > extend_w {
        ctx.accounts.vote.outcome = VaultVoteOutcome::ReturnCapital;
        ctx.accounts.vault.state = PayoutVaultState::Cancelled;
    } else {
        ctx.accounts.vote.outcome = VaultVoteOutcome::Extend;
        let v = &mut ctx.accounts.vault;
        // Extend = give the founder a fresh start: move the schedule forward
        // by exactly the number of periods the oldest unfulfilled update is
        // overdue (the SAME uncapped measure `freeze_vault` uses, via
        // `PayoutVault::overdue_periods`), so that afterwards
        // `now < start_ts' + updates_posted * MONTH` — zero periods overdue.
        // The previous `min(elapsed, num_tranches) - updates_posted` shift was
        // too small whenever the freeze happened more than
        // `MISSED_FREEZE_THRESHOLD - 1` months past the schedule end (every
        // short-schedule / last-tranche freeze lands there), leaving the vault
        // >= threshold overdue and permissionlessly re-freezable in the next
        // transaction, which nullified the investors' Extend outcome.
        let overdue = v.overdue_periods(now)?;
        v.start_ts = v
            .start_ts
            .checked_add(overdue.checked_mul(MONTH).ok_or(RegistryError::Overflow)?)
            .ok_or(RegistryError::Overflow)?;
        v.state = PayoutVaultState::Active;
    }
    Ok(())
}
