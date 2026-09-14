use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::PayoutVault;

#[derive(Accounts)]
pub struct ClaimFounderYield<'info> {
    pub founder: Signer<'info>,

    #[account(
        mut,
        seeds = [PAYOUT_SEED, vault.sale.as_ref()],
        bump = vault.bump,
        has_one = escrow @ RegistryError::Unauthorized,
        has_one = payment_mint @ RegistryError::Unauthorized,
        has_one = founder @ RegistryError::NotFounder,
    )]
    pub vault: Box<Account<'info, PayoutVault>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = founder_account.mint == vault.payment_mint @ RegistryError::Unauthorized,
        constraint = founder_account.owner == vault.founder @ RegistryError::NotFounder,
    )]
    pub founder_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_token_program: Interface<'info, TokenInterface>,
}

/// Receiver KYC: NOT APPLICABLE — this escrow pays out the PAYMENT mint, a
/// plain SPL/Token-2022 token with no Mancipatio transfer hook and no
/// `KycRegistry`. The receiver-KYC regime governs share-class units only; the
/// destination here is additionally pinned to the entitled party by the
/// account constraints above.
pub fn handle_claim_founder_yield(ctx: Context<ClaimFounderYield>) -> Result<()> {
    let amount = ctx.accounts.vault.founder_yield_claimable;
    require!(amount > 0, RegistryError::NothingToClaim);

    let sale_key = ctx.accounts.vault.sale;
    let bump = ctx.accounts.vault.bump;
    let signer: &[&[&[u8]]] = &[&[PAYOUT_SEED, sale_key.as_ref(), &[bump]]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.payment_token_program.key(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.founder_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer,
        ),
        amount,
        ctx.accounts.payment_mint.decimals,
    )?;
    ctx.accounts.vault.founder_yield_claimable = 0;
    Ok(())
}
