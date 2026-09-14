use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Proposal, ProposalStatus, VoteChoice, VoteRecord};
use crate::util::{snapshot_leaf, verify_merkle_proof};

#[derive(Accounts)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.share_class.as_ref(), &proposal.proposal_id.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.status == ProposalStatus::Active @ RegistryError::ProposalNotActive,
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    /// One vote per voter — `init` fails on a second vote.
    #[account(
        init,
        payer = voter,
        space = 8 + VoteRecord::INIT_SPACE,
        seeds = [VOTE_SEED, proposal.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub vote_record: Box<Account<'info, VoteRecord>>,

    pub system_program: Program<'info, System>,
}

/// Casts a weighted advisory vote. `weight` is proven against the proposal's
/// snapshot Merkle root, so a voter can neither inflate it nor vote without
/// having held tokens at the snapshot slot.
pub fn handle_cast_vote(
    ctx: Context<CastVote>,
    choice: VoteChoice,
    weight: u64,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.proposal.start_ts,
        RegistryError::VotingNotStarted
    );
    require!(
        now < ctx.accounts.proposal.end_ts,
        RegistryError::VotingClosed
    );

    let leaf = snapshot_leaf(&ctx.accounts.voter.key(), weight);
    require!(
        verify_merkle_proof(ctx.accounts.proposal.snapshot_root, leaf, &proof),
        RegistryError::InvalidMerkleProof
    );

    let p = &mut ctx.accounts.proposal;
    match choice {
        VoteChoice::For => {
            p.for_weight = p
                .for_weight
                .checked_add(weight)
                .ok_or(RegistryError::Overflow)?
        }
        VoteChoice::Against => {
            p.against_weight = p
                .against_weight
                .checked_add(weight)
                .ok_or(RegistryError::Overflow)?
        }
        VoteChoice::Abstain => {
            p.abstain_weight = p
                .abstain_weight
                .checked_add(weight)
                .ok_or(RegistryError::Overflow)?
        }
    }

    let rec = &mut ctx.accounts.vote_record;
    rec.proposal = ctx.accounts.proposal.key();
    rec.voter = ctx.accounts.voter.key();
    rec.choice = choice;
    rec.weight = weight;
    rec.bump = ctx.bumps.vote_record;

    msg!("Vote cast — {:?} weight {}", choice, weight);
    Ok(())
}
