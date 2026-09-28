use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{RaiseType, Sale, SaleStatus};

#[derive(Accounts)]
pub struct CloseSale<'info> {
    /// Mut (2D): receives the closed proceeds account's rent.
    #[account(mut)]
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

    /// Emergency-pause gate (read-only). Keep LAST among named accounts: old
    /// account indices and the remaining-accounts hook tail keep their positions.
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_ISSUER_PROCEEDS) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, crate::state::Platform>>,

    /// D1 chain to the issuer: the sale's share class ...
    #[account(address = sale.share_class @ RegistryError::Unauthorized)]
    pub share_class: Box<Account<'info, crate::state::ShareClass>>,
    /// ... and its asset (`asset.issuer` keys the freeze below).
    #[account(address = share_class.asset @ RegistryError::Unauthorized)]
    pub asset: Box<Account<'info, crate::state::Asset>>,
    /// D1: the issuer's `IssuerFreeze` PDA `["issuer_freeze", issuer]` must be
    /// unset (no freeze in force).
    /// CHECK: address pinned by the seeds; `util::is_unset` (fail-closed).
    #[account(
        seeds = [ISSUER_FREEZE_SEED, asset.issuer.as_ref()],
        bump,
        constraint = crate::util::is_unset(&issuer_freeze) @ RegistryError::IssuerProceedsFrozen,
    )]
    pub issuer_freeze: UncheckedAccount<'info>,
    /// prog-novac-4: the signing sale authority is not blocked ...
    /// CHECK: the hook's `["blocked", wallet]` PDA (address pinned by the
    /// seeds); it must be unset — system-owned, no data (`util::is_unset`,
    /// fail-closed: a live BlockEntry is refused).
    #[account(
        seeds = [HOOK_BLOCK_ENTRY_SEED, authority.key().as_ref()],
        seeds::program = TRANSFER_HOOK_PROGRAM,
        bump,
        constraint = crate::util::is_unset(&authority_block_entry) @ RegistryError::PartyBlocklisted,
    )]
    pub authority_block_entry: UncheckedAccount<'info>,
    /// ... nor is the owner of the proceeds destination.
    /// CHECK: the hook's `["blocked", wallet]` PDA (address pinned by the
    /// seeds); it must be unset — system-owned, no data (`util::is_unset`,
    /// fail-closed: a live BlockEntry is refused).
    #[account(
        seeds = [HOOK_BLOCK_ENTRY_SEED, destination.owner.as_ref()],
        seeds::program = TRANSFER_HOOK_PROGRAM,
        bump,
        constraint = crate::util::is_unset(&destination_block_entry) @ RegistryError::PartyBlocklisted,
    )]
    pub destination_block_entry: UncheckedAccount<'info>,
}

/// Closes a sale: sweeps the proceeds escrow to the issuer's payment account,
/// closes the (now empty) proceeds account with its rent to `sale.authority`
/// (2D; also when nothing was raised) and marks the sale `Closed`. The Sale
/// itself stays: it is the sale-id reuse guard.
pub fn handle_close_sale(ctx: Context<CloseSale>) -> Result<()> {
    require!(
        ctx.accounts.sale.raise_type == RaiseType::Mature,
        RegistryError::InvalidRaiseParams
    );

    let proceeds_amount = ctx.accounts.proceeds.amount;

    // The Sale PDA is the proceeds-escrow authority — sign with its seeds.
    let share_class_key = ctx.accounts.sale.share_class;
    let sale_id_seed = ctx.accounts.sale.sale_id.to_le_bytes();
    let sale_bump = ctx.accounts.sale.bump;
    let seeds: &[&[u8]] = &[
        SALE_SEED,
        share_class_key.as_ref(),
        &sale_id_seed,
        &[sale_bump],
    ];

    if proceeds_amount > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.payment_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.proceeds.to_account_info(),
                    mint: ctx.accounts.payment_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.sale.to_account_info(),
                },
                &[seeds],
            ),
            proceeds_amount,
            ctx.accounts.payment_mint.decimals,
        )?;
    }

    // Empty after the sweep, and `buy` requires Open: nothing reads it again.
    crate::util::close_empty_escrow(
        &ctx.accounts.proceeds.to_account_info(),
        Some(&ctx.accounts.payment_token_program),
        &ctx.accounts.sale.to_account_info(),
        &ctx.accounts.authority.to_account_info(),
        seeds,
    )?;

    ctx.accounts.sale.status = SaleStatus::Closed;
    msg!(
        "Sale {} closed — {} proceeds withdrawn",
        ctx.accounts.sale.sale_id,
        proceeds_amount
    );
    Ok(())
}
