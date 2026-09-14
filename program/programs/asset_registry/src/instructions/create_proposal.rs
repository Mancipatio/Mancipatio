use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, Proposal, ProposalOutcome, ProposalStatus, ShareClass};

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate — only an admin may open a governance proposal.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        seeds = [SHARE_CLASS_SEED, share_class.asset.as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    #[account(
        init,
        payer = authority,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [PROPOSAL_SEED, share_class.key().as_ref(), &proposal_id.to_le_bytes()],
        bump
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    pub system_program: Program<'info, System>,
}

/// Opens an advisory governance proposal. Voting weight is fixed by the
/// `snapshot_root` — a Merkle root of `(voter, weight)` computed off-chain from
/// holder balances at `snapshot_slot`.
#[allow(clippy::too_many_arguments)]
pub fn handle_create_proposal(
    ctx: Context<CreateProposal>,
    proposal_id: u64,
    metadata_hash: [u8; 32],
    snapshot_slot: u64,
    snapshot_root: [u8; 32],
    start_ts: i64,
    end_ts: i64,
) -> Result<()> {
    require!(end_ts >= start_ts, RegistryError::InvalidProposalParams);

    let p = &mut ctx.accounts.proposal;
    p.share_class = ctx.accounts.share_class.key();
    p.authority = ctx.accounts.authority.key();
    p.proposal_id = proposal_id;
    p.metadata_hash = metadata_hash;
    p.snapshot_slot = snapshot_slot;
    p.snapshot_root = snapshot_root;
    p.start_ts = start_ts;
    p.end_ts = end_ts;
    p.for_weight = 0;
    p.against_weight = 0;
    p.abstain_weight = 0;
    p.status = ProposalStatus::Active;
    p.outcome = ProposalOutcome::Pending;
    p.version = STATE_VERSION;
    p.bump = ctx.bumps.proposal;

    msg!("Governance proposal {} created", proposal_id);
    Ok(())
}
