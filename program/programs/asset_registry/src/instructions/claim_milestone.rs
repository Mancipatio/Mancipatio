use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{MilestoneClaim, RightsIssuance, VestingMilestone};
use crate::util::{hook_transfer, snapshot_leaf, verify_merkle_proof};

#[derive(Accounts)]
pub struct ClaimMilestone<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,

    #[account(
        mut,
        seeds = [
            RIGHTS_SEED,
            rights_issuance.share_class.as_ref(),
            &rights_issuance.issuance_id.to_le_bytes(),
        ],
        bump = rights_issuance.bump,
        has_one = underlying_mint @ RegistryError::Unauthorized,
        has_one = escrow @ RegistryError::Unauthorized,
    )]
    pub rights_issuance: Box<Account<'info, RightsIssuance>>,

    #[account(
        mut,
        seeds = [RT_MILESTONE_SEED, milestone.issuance.as_ref(), &milestone.index.to_le_bytes()],
        bump = milestone.bump,
        constraint = milestone.issuance == rights_issuance.key() @ RegistryError::Unauthorized,
    )]
    pub milestone: Box<Account<'info, VestingMilestone>>,

    /// One claim per (milestone, claimer) — `init` fails on a second claim.
    #[account(
        init,
        payer = claimer,
        space = 8 + MilestoneClaim::INIT_SPACE,
        seeds = [RT_CLAIM_SEED, milestone.key().as_ref(), claimer.key().as_ref()],
        bump
    )]
    pub claim: Box<Account<'info, MilestoneClaim>>,

    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Claimer receives the underlying tokens here — bound to the `claimer`
    /// signer, whose key IS the entitlement proven against the milestone root.
    /// Without the owner bind the escrow→destination leg could be pointed at
    /// any third-party account: `publish_milestone` takes an arbitrary
    /// `merkle_root`, so an admin plus one accomplice could route the escrow
    /// into a permissionlessly created `Offer` escrow (owner = `Offer` PDA,
    /// which carries an `EscrowMarker` — the hook's destination-marker
    /// exemption skips receiver KYC there) and `cancel_offer` the balance out
    /// to a wallet with no `KycEntry`. Mirrors `buy` / `take_offer`.
    #[account(
        mut,
        constraint = claimer_token_account.mint == underlying_mint.key() @ RegistryError::Unauthorized,
        constraint = claimer_token_account.owner == claimer.key() @ RegistryError::Unauthorized,
    )]
    pub claimer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: [BlockEntry(RightsIssuance PDA), ExtraAccountMetaList, transfer_hook]
}

/// Claims a holder's entitlement from a vesting milestone. The entitlement is
/// proven against the milestone's snapshot Merkle root; the underlying is
/// released escrow → claimer via a hook-aware transfer signed by the
/// `RightsIssuance` PDA. docs/03 §Mod A.
///
/// Receiver KYC is checked explicitly before delivery and by the hook for an
/// identity-only source. Rights identity allows funding and prevents holder
/// clawback; it never exempts an ordinary escrow-to-recipient delivery.
pub fn handle_claim_milestone<'info>(
    ctx: Context<'info, ClaimMilestone<'info>>,
    amount: u64,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.milestone.unlock_ts,
        RegistryError::MilestoneLocked
    );

    // Prove the claimer's entitlement against the milestone snapshot.
    let leaf = snapshot_leaf(&ctx.accounts.claimer.key(), amount);
    require!(
        verify_merkle_proof(ctx.accounts.milestone.merkle_root, leaf, &proof),
        RegistryError::InvalidMerkleProof
    );

    let new_claimed = ctx
        .accounts
        .milestone
        .claimed
        .checked_add(amount)
        .ok_or(RegistryError::Overflow)?;
    require!(
        new_claimed <= ctx.accounts.milestone.amount_pool,
        RegistryError::MilestonePoolExceeded
    );

    crate::util::require_receiver_kyc(
        ctx.remaining_accounts,
        &ctx.accounts.underlying_mint.key(),
        &ctx.accounts.claimer.key(),
    )?;

    // Deliver the underlying — escrow → claimer, RightsIssuance PDA signs.
    let share_class = ctx.accounts.rights_issuance.share_class;
    let issuance_id_seed = ctx.accounts.rights_issuance.issuance_id.to_le_bytes();
    let ri_bump = ctx.accounts.rights_issuance.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        RIGHTS_SEED,
        share_class.as_ref(),
        &issuance_id_seed,
        &[ri_bump],
    ]];
    hook_transfer(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.underlying_mint.to_account_info(),
        &ctx.accounts.claimer_token_account.to_account_info(),
        &ctx.accounts.rights_issuance.to_account_info(),
        ctx.remaining_accounts,
        amount,
        ctx.accounts.underlying_mint.decimals,
        signer_seeds,
    )?;

    ctx.accounts.milestone.claimed = new_claimed;
    ctx.accounts.rights_issuance.total_claimed = ctx
        .accounts
        .rights_issuance
        .total_claimed
        .checked_add(amount)
        .ok_or(RegistryError::Overflow)?;

    let claim = &mut ctx.accounts.claim;
    claim.milestone = ctx.accounts.milestone.key();
    claim.claimer = ctx.accounts.claimer.key();
    claim.amount = amount;
    claim.bump = ctx.bumps.claim;

    msg!("Milestone claim — {} underlying delivered", amount);
    Ok(())
}
