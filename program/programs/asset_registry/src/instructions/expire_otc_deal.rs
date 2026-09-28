use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{EscrowMarker, OtcDeal, OtcDealStatus};
use crate::util::refund_otc_deposits;

#[derive(Accounts)]
pub struct ExpireOtcDeal<'info> {
    /// Permissionless after `expires_at` — any signer may pay the fee.
    /// Mut: receives the closed escrow marker's rent.
    #[account(mut)]
    pub payer: Signer<'info>,

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

    /// Escrow marker for the deal PDA — closed here (rent → payer);
    /// expiry is a terminal path.
    #[account(
        mut,
        close = payer,
        seeds = [ESCROW_MARKER_SEED, deal.key().as_ref()],
        bump = escrow_marker.bump,
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    pub share_token_program: Interface<'info, TokenInterface>,
    pub payment_token_program: Interface<'info, TokenInterface>,

    /// O-11 (appended before the hook tail): the buyer's hook BlockEntry.
    /// Only its address is pinned here; the handler refuses a permissionless
    /// refund of a DEPOSITED leg to a blocked party (the Admin
    /// `cancel_otc_deal` stays the manual path).
    /// CHECK: address pinned by the seeds; read by `util::is_unset`.
    #[account(seeds = [HOOK_BLOCK_ENTRY_SEED, deal.buyer.as_ref()], seeds::program = TRANSFER_HOOK_PROGRAM, bump)]
    pub buyer_block_entry: UncheckedAccount<'info>,
    /// The seller's hook BlockEntry (see `buyer_block_entry`).
    /// CHECK: address pinned by the seeds; read by `util::is_unset`.
    #[account(seeds = [HOOK_BLOCK_ENTRY_SEED, deal.seller.as_ref()], seeds::program = TRANSFER_HOOK_PROGRAM, bump)]
    pub seller_block_entry: UncheckedAccount<'info>,
    // remaining_accounts: the refund leg's hook tail (source authority = deal
    // PDA) — [BlockEntry, ExtraAccountMetaList, hook program] in Open mode,
    // 9 accounts in KycGated mode (see docs in transfer_hook).
}

/// Expires an open OTC deal whose `expires_at` has passed — permissionless.
/// Whichever side deposited is refunded (deal PDA signs); the deal flips to
/// `Expired`.
///
/// Receiver KYC — see `util::refund_otc_deposits`. Each leg refunds at most
/// that party's RECORDED deposit with no check (a KYC expiry must not trap a
/// deposit, and this path is permissionless so it must never fail on
/// eligibility); a surplus above the ledger — units somebody raw-transferred
/// into the escrow — reaches the seller only through `require_receiver_kyc`
/// and is otherwise withheld.
pub fn handle_expire_otc_deal<'info>(ctx: Context<'info, ExpireOtcDeal<'info>>) -> Result<()> {
    let expires_at = ctx.accounts.deal.expires_at;
    let now = Clock::get()?.unix_timestamp;
    require!(
        expires_at > 0 && now > expires_at,
        RegistryError::DealNotExpired
    );
    // O-11: a permissionless refund never pays a blocked party. Only the
    // legs that were actually deposited are checked.
    let deal = &ctx.accounts.deal;
    crate::util::ensure(
        (!deal.payment_deposited || crate::util::is_unset(&ctx.accounts.buyer_block_entry))
            && (!deal.asset_deposited || crate::util::is_unset(&ctx.accounts.seller_block_entry)),
        RegistryError::PartyBlocklisted,
    )?;

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
    deal.status = OtcDealStatus::Expired;
    msg!("OTC deal {} expired — deposits refunded", deal.deal_id);
    Ok(())
}
