use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    ClaimKind, ClaimRecord, PayoutVault, PayoutVaultState, VaultVote, VaultVoteOutcome,
};
use crate::util::{snapshot_leaf, verify_merkle_proof};

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(
        mut,
        seeds = [PAYOUT_SEED, vault.sale.as_ref()],
        bump = vault.bump,
        has_one = escrow @ RegistryError::Unauthorized,
        has_one = payment_mint @ RegistryError::Unauthorized,
        constraint = vault.state == PayoutVaultState::Cancelled @ RegistryError::NotCancelled,
        constraint = vault.version == 1 || vault.version == PAYOUT_STATE_VERSION @ RegistryError::AccountMigrationRequired,
        constraint = !vault.vote_pending @ RegistryError::InvalidVaultVoteRound,
    )]
    pub vault: Box<Account<'info, PayoutVault>>,

    #[account(
        constraint = vote.payout_vault == vault.key() && vote.round == vault.vote_round && vote.outcome == VaultVoteOutcome::ReturnCapital @ RegistryError::InvalidVaultVoteRound,
    )]
    pub vote: Box<Account<'info, VaultVote>>,

    #[account(
        init_if_needed,
        payer = investor,
        space = 8 + ClaimRecord::INIT_SPACE,
        seeds = [PAYOUT_CLAIM_SEED, vault.key().as_ref(), &[ClaimKind::Refund as u8], investor.key().as_ref()],
        bump
    )]
    pub claim: Box<Account<'info, ClaimRecord>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = investor_account.mint == vault.payment_mint @ RegistryError::Unauthorized,
        constraint = investor_account.owner == investor.key() @ RegistryError::Unauthorized,
    )]
    pub investor_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Receiver KYC: NOT APPLICABLE — this escrow pays out the PAYMENT mint, a
/// plain SPL/Token-2022 token with no Mancipatio transfer hook and no
/// `KycRegistry`. The receiver-KYC regime governs share-class units only; the
/// destination here is additionally pinned to the entitled party by the
/// account constraints above.
pub fn handle_claim_refund(
    ctx: Context<ClaimRefund>,
    weight: u64,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    // A size-prepared legacy terminal refund retains its original vote PDA;
    // it does not reinterpret or reactivate that old vote as a new round.
    let vault_key = ctx.accounts.vault.key();
    let expected_vote = if ctx.accounts.vault.version == 1 {
        require!(
            ctx.accounts.vote.version == 1
                && ctx.accounts.vote.round == 0
                && ctx.accounts.vault.vote_round == 0,
            RegistryError::InvalidVaultVoteRound
        );
        Pubkey::create_program_address(
            &[
                VAULT_VOTE_SEED,
                vault_key.as_ref(),
                &[ctx.accounts.vote.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| RegistryError::Unauthorized)?
    } else {
        require!(
            ctx.accounts.vote.version == PAYOUT_STATE_VERSION,
            RegistryError::InvalidVaultVoteRound
        );
        Pubkey::create_program_address(
            &[
                VAULT_VOTE_SEED,
                vault_key.as_ref(),
                &ctx.accounts.vote.round.to_le_bytes(),
                &[ctx.accounts.vote.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| RegistryError::Unauthorized)?
    };
    require_keys_eq!(
        ctx.accounts.vote.key(),
        expected_vote,
        RegistryError::InvalidVaultVoteRound
    );
    let leaf = snapshot_leaf(&ctx.accounts.investor.key(), weight);
    require!(
        verify_merkle_proof(ctx.accounts.vote.snapshot_root, leaf, &proof),
        RegistryError::InvalidMerkleProof
    );

    let v = &ctx.accounts.vault;
    let remaining_principal = v
        .total_amount
        .checked_sub(v.released)
        .ok_or(RegistryError::Overflow)?;
    let entitlement = (weight as u128)
        .checked_mul(remaining_principal as u128)
        .ok_or(RegistryError::Overflow)?
        .checked_div(v.total_weight as u128)
        .ok_or(RegistryError::Overflow)? as u64;

    let already = ctx.accounts.claim.claimed;
    require!(entitlement > already, RegistryError::AlreadyClaimed);
    let payout = entitlement - already;

    let sale_key = v.sale;
    let bump = v.bump;
    let signer: &[&[&[u8]]] = &[&[PAYOUT_SEED, sale_key.as_ref(), &[bump]]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.payment_token_program.key(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.investor_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer,
        ),
        payout,
        ctx.accounts.payment_mint.decimals,
    )?;

    let c = &mut ctx.accounts.claim;
    c.payout_vault = ctx.accounts.vault.key();
    c.investor = ctx.accounts.investor.key();
    c.kind = ClaimKind::Refund;
    c.claimed = entitlement;
    c.version = STATE_VERSION;
    c.bump = ctx.bumps.claim;
    Ok(())
}
