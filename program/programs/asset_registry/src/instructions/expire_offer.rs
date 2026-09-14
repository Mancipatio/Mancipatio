use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{EscrowMarker, Offer, OfferStatus};
use crate::util::{hook_transfer, split_escrow_release};

#[derive(Accounts)]
pub struct ExpireOffer<'info> {
    /// Permissionless after `expires_at` — any signer may pay the fee.
    /// Mut: receives the closed escrow marker's rent.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [OFFER_SEED, offer.share_class.as_ref(), &offer.offer_id.to_le_bytes()],
        bump = offer.bump,
        has_one = mint @ RegistryError::Unauthorized,
        has_one = escrow @ RegistryError::Unauthorized,
        constraint = offer.status == OfferStatus::Open @ RegistryError::OfferNotOpen,
    )]
    pub offer: Box<Account<'info, Offer>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The maker reclaims the escrowed share units here.
    #[account(
        mut,
        constraint = maker_share_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = maker_share_account.owner == offer.maker @ RegistryError::Unauthorized,
    )]
    pub maker_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Escrow marker for the offer PDA — closed here (rent → payer);
    /// expiry is a terminal path.
    #[account(
        mut,
        close = payer,
        seeds = [ESCROW_MARKER_SEED, offer.key().as_ref()],
        bump = escrow_marker.bump,
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    pub share_token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: the escrow→maker leg's hook tail (source authority =
    // offer PDA) — [BlockEntry, ExtraAccountMetaList, hook program] in Open
    // mode, 9 accounts in KycGated mode (see docs in transfer_hook).
}

/// Expires an open OTC offer whose `expires_at` has passed — permissionless.
/// The maker's escrowed share units (if any) return via a hook-aware
/// `transfer_checked` signed by the `Offer` PDA; the offer flips to `Expired`.
///
/// Receiver KYC — same evidence-based split as `cancel_offer`
/// (`util::split_escrow_release`): at most `offer.deposited` — what the maker
/// actually put in through `deposit_to_offer_escrow` — leaves without any
/// check, and only a receiver whose `KycEntry` passes may also take the
/// surplus that somebody else raw-transferred into the escrow. Without the
/// ledger this path was the permissionless half of the offer laundry: anyone
/// could expire a non-KYC'd maker's offer and push the whole balance out.
///
/// Being permissionless, this must NEVER fail on eligibility grounds — a
/// refused surplus is withheld (and immobilised, since expiry is terminal and
/// closes the marker), the refund still happens and the offer still expires.
pub fn handle_expire_offer<'info>(ctx: Context<'info, ExpireOffer<'info>>) -> Result<()> {
    let expires_at = ctx.accounts.offer.expires_at;
    let now = Clock::get()?.unix_timestamp;
    require!(
        expires_at > 0 && now > expires_at,
        RegistryError::OfferNotExpired
    );

    let release = split_escrow_release(
        ctx.accounts.escrow.amount,
        ctx.accounts.offer.deposited,
        ctx.remaining_accounts,
        &ctx.accounts.mint.key(),
        &ctx.accounts.maker_share_account.owner,
    );
    let escrow_amount = release.payout;
    if escrow_amount > 0 {
        let share_class = ctx.accounts.offer.share_class;
        let offer_id_seed = ctx.accounts.offer.offer_id.to_le_bytes();
        let offer_bump = ctx.accounts.offer.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            OFFER_SEED,
            share_class.as_ref(),
            &offer_id_seed,
            &[offer_bump],
        ]];
        hook_transfer(
            &ctx.accounts.share_token_program.to_account_info(),
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.maker_share_account.to_account_info(),
            &ctx.accounts.offer.to_account_info(),
            ctx.remaining_accounts,
            escrow_amount,
            ctx.accounts.mint.decimals,
            signer_seeds,
        )?;
    }

    let offer = &mut ctx.accounts.offer;
    offer.deposited = offer.deposited.saturating_sub(release.from_ledger);
    offer.status = OfferStatus::Expired;
    if release.withheld > 0 {
        msg!(
            "OTC offer {} — {} un-deposited units withheld (maker not eligible to receive them)",
            offer.offer_id,
            release.withheld
        );
    }
    msg!(
        "OTC offer {} expired — {} units returned to maker",
        offer.offer_id,
        escrow_amount
    );
    Ok(())
}
