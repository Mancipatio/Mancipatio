use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, EscrowMarker, OtcDeal, OtcDealStatus};
use crate::util::refund_otc_deposits;

#[derive(Accounts)]
pub struct CancelOtcDeal<'info> {
    /// Mut: receives the closed escrow marker's rent.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate — only an admin may cancel an OTC deal.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        mut,
        seeds = [OTC_DEAL_SEED, deal.share_class.as_ref(), &deal.deal_id.to_le_bytes()],
        bump = deal.bump,
        has_one = mint @ RegistryError::Unauthorized,
        has_one = payment_mint @ RegistryError::Unauthorized,
        has_one = asset_escrow @ RegistryError::Unauthorized,
        has_one = payment_escrow @ RegistryError::Unauthorized,
        constraint = deal.status == OtcDealStatus::Open @ RegistryError::DealNotOpen,
    )]
    pub deal: Box<Account<'info, OtcDeal>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub asset_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The seller reclaims the escrowed share units here.
    #[account(
        mut,
        constraint = seller_share_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = seller_share_account.owner == deal.seller @ RegistryError::Unauthorized,
    )]
    pub seller_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub payment_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The buyer reclaims the escrowed payment here.
    #[account(
        mut,
        constraint = buyer_payment_account.mint == payment_mint.key() @ RegistryError::Unauthorized,
        constraint = buyer_payment_account.owner == deal.buyer @ RegistryError::Unauthorized,
    )]
    pub buyer_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Escrow marker for the deal PDA — closed here (rent → authority);
    /// cancel is a terminal path.
    #[account(
        mut,
        close = authority,
        seeds = [ESCROW_MARKER_SEED, deal.key().as_ref()],
        bump = escrow_marker.bump,
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    pub share_token_program: Interface<'info, TokenInterface>,
    pub payment_token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: the refund leg's hook tail (source authority = deal
    // PDA) — [BlockEntry, ExtraAccountMetaList, hook program] in Open mode,
    // 9 accounts in KycGated mode (see docs in transfer_hook).
}

/// Cancels an open OTC deal (admin) at any time before completion — whichever
/// side deposited is refunded (deal PDA signs); the deal flips to `Cancelled`.
///
/// Receiver KYC — see `util::refund_otc_deposits` for the rule and the reason.
/// Each leg is CAPPED at that party's recorded deposit
/// (`deal.asset_deposited_amount` / `deal.payment_deposited_amount`) and that
/// much flows back with no check at all — the destinations are pinned to
/// `deal.seller` / `deal.buyer` by the constraints above, and a lapsed or
/// revoked passport must not confiscate a deposit. Any surplus above the
/// ledger (only a raw `transfer_checked` into an escrow can create one) is
/// released to the seller only if `require_receiver_kyc` passes, and is
/// otherwise withheld — the cancel itself never fails on that account.
pub fn handle_cancel_otc_deal<'info>(ctx: Context<'info, CancelOtcDeal<'info>>) -> Result<()> {
    refund_otc_deposits(
        &ctx.accounts.deal,
        &ctx.accounts.mint,
        &ctx.accounts.asset_escrow,
        &ctx.accounts.seller_share_account,
        &ctx.accounts.payment_mint,
        &ctx.accounts.payment_escrow,
        &ctx.accounts.buyer_payment_account,
        &ctx.accounts.share_token_program.to_account_info(),
        &ctx.accounts.payment_token_program.to_account_info(),
        ctx.remaining_accounts,
    )?;

    let deal = &mut ctx.accounts.deal;
    deal.status = OtcDealStatus::Cancelled;
    msg!("OTC deal {} cancelled — deposits refunded", deal.deal_id);
    Ok(())
}
