use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{ClaimKind, ClaimRecord, PayoutVault};
use crate::util::{snapshot_leaf, verify_merkle_proof};

#[derive(Accounts)]
pub struct ClaimInvestorYield<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(
        mut,
        seeds = [PAYOUT_SEED, vault.sale.as_ref()],
        bump = vault.bump,
        has_one = escrow @ RegistryError::Unauthorized,
        has_one = payment_mint @ RegistryError::Unauthorized,
    )]
    pub vault: Box<Account<'info, PayoutVault>>,

    #[account(
        init_if_needed,
        payer = investor,
        space = 8 + ClaimRecord::INIT_SPACE,
        seeds = [PAYOUT_CLAIM_SEED, vault.key().as_ref(), &[ClaimKind::InvestorYield as u8], investor.key().as_ref()],
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
pub fn handle_claim_investor_yield(
    ctx: Context<ClaimInvestorYield>,
    weight: u64,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    let leaf = snapshot_leaf(&ctx.accounts.investor.key(), weight);
    require!(
        verify_merkle_proof(ctx.accounts.vault.investor_yield_root, leaf, &proof),
        RegistryError::InvalidMerkleProof
    );

    let v = &ctx.accounts.vault;
    let entitlement = (weight as u128)
        .checked_mul(v.investor_yield_pool as u128)
        .ok_or(RegistryError::Overflow)?
        .checked_div(v.total_weight as u128)
        .ok_or(RegistryError::Overflow)? as u64;
    let already = ctx.accounts.claim.claimed;
    require!(entitlement > already, RegistryError::NothingToClaim);
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
    c.kind = ClaimKind::InvestorYield;
    c.claimed = entitlement;
    c.version = STATE_VERSION;
    c.bump = ctx.bumps.claim;
    Ok(())
}
