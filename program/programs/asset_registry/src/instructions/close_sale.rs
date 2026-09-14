use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{RaiseType, Sale, SaleStatus};

#[derive(Accounts)]
pub struct CloseSale<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SALE_SEED, sale.share_class.as_ref(), &sale.sale_id.to_le_bytes()],
        bump = sale.bump,
        has_one = authority @ RegistryError::Unauthorized,
        has_one = proceeds @ RegistryError::Unauthorized,
        has_one = payment_mint @ RegistryError::Unauthorized,
        constraint = sale.status == SaleStatus::Open @ RegistryError::SaleNotOpen,
    )]
    pub sale: Box<Account<'info, Sale>>,

    #[account(mut)]
    pub proceeds: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Issuer's payment account — receives the collected proceeds.
    #[account(
        mut,
        constraint = destination.mint == sale.payment_mint @ RegistryError::Unauthorized,
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_token_program: Interface<'info, TokenInterface>,
}

/// Closes a sale: sweeps the proceeds escrow to the issuer's payment account
/// and marks the sale `Closed`.
pub fn handle_close_sale(ctx: Context<CloseSale>) -> Result<()> {
    require!(
        ctx.accounts.sale.raise_type == RaiseType::Mature,
        RegistryError::InvalidRaiseParams
    );

    let proceeds_amount = ctx.accounts.proceeds.amount;

    if proceeds_amount > 0 {
        // The Sale PDA is the proceeds-escrow authority — sign with its seeds.
        let share_class_key = ctx.accounts.sale.share_class;
        let sale_id_seed = ctx.accounts.sale.sale_id.to_le_bytes();
        let sale_bump = ctx.accounts.sale.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            SALE_SEED,
            share_class_key.as_ref(),
            &sale_id_seed,
            &[sale_bump],
        ]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.payment_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.proceeds.to_account_info(),
                    mint: ctx.accounts.payment_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.sale.to_account_info(),
                },
                signer_seeds,
            ),
            proceeds_amount,
            ctx.accounts.payment_mint.decimals,
        )?;
    }

    ctx.accounts.sale.status = SaleStatus::Closed;
    msg!(
        "Sale {} closed — {} proceeds withdrawn",
        ctx.accounts.sale.sale_id,
        proceeds_amount
    );
    Ok(())
}
