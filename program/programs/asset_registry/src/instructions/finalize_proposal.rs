use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Proposal, ProposalOutcome, ProposalStatus};

#[derive(Accounts)]
pub struct FinalizeProposal<'info> {
    /// Permissionless after the voting window — any signer pays the fee.
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.share_class.as_ref(), &proposal.proposal_id.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.status == ProposalStatus::Active @ RegistryError::ProposalNotActive,
    )]
    pub proposal: Box<Account<'info, Proposal>>,
}

/// Finalizes a proposal once its voting window has ended. The outcome is
/// advisory — simple majority of `for` over `against` (abstentions ignored).
pub fn handle_finalize_proposal(ctx: Context<FinalizeProposal>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.proposal.end_ts,
        RegistryError::ProposalNotEnded
    );

    let p = &mut ctx.accounts.proposal;
    p.outcome = if p.for_weight > p.against_weight {
        ProposalOutcome::Passed
    } else {
        ProposalOutcome::Rejected
    };
    p.status = ProposalStatus::Finalized;

    msg!(
        "Proposal {} finalized — {:?} (for {} / against {} / abstain {})",
        p.proposal_id,
        p.outcome,
        p.for_weight,
        p.against_weight,
        p.abstain_weight
    );
    Ok(())
}
