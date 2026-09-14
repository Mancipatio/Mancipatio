use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{EscrowMarker, Offer, OfferStatus};
use crate::util::{hook_transfer, split_escrow_release};

#[derive(Accounts)]
pub struct CancelOffer<'info> {
    /// Mut: receives the closed escrow marker's rent.
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        mut,
        seeds = [OFFER_SEED, offer.share_class.as_ref(), &offer.offer_id.to_le_bytes()],
        bump = offer.bump,
        has_one = maker @ RegistryError::Unauthorized,
        has_one = mint @ RegistryError::Unauthorized,
        has_one = escrow @ RegistryError::Unauthorized,
        constraint = offer.status == OfferStatus::Open @ RegistryError::OfferNotOpen,
    )]
    pub offer: Box<Account<'info, Offer>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Maker reclaims the escrowed share units here — bound to the maker so the
    /// refund cannot be redirected through the escrow-marker exemption to an
    /// arbitrary (e.g. non-KYC) account (mirrors `expire_offer`).
    #[account(
        mut,
        constraint = maker_share_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = maker_share_account.owner == offer.maker @ RegistryError::Unauthorized,
    )]
    pub maker_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Escrow marker for the offer PDA — closed here (rent → maker);
    /// cancel is a terminal path.
    #[account(
        mut,
        close = maker,
        seeds = [ESCROW_MARKER_SEED, offer.key().as_ref()],
        bump = escrow_marker.bump,
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    pub share_token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: the escrow→maker leg's hook tail (source authority =
    // offer PDA) — [BlockEntry, ExtraAccountMetaList, hook program] in Open
    // mode, 9 accounts in KycGated mode (see docs in transfer_hook).
}

/// Cancels an open OTC offer — the maker's escrowed share units are returned
/// via a hook-aware `transfer_checked` signed by the `Offer` PDA.
///
/// Receiver KYC — EVIDENCE-BASED, split by `util::split_escrow_release`:
///
///   * up to `offer.deposited` (what the maker moved in through
///     `deposit_to_offer_escrow`) is released with NO check whatsoever. It is
///     their own property; a passport that lapsed while the units sat in
///     escrow must not be able to confiscate it;
///   * anything ABOVE the ledger was put in by somebody else — a raw
///     `transfer_checked` into the escrow, which nothing on-chain can prevent
///     — and handing it to the maker would be a DELIVERY. It is released only
///     if `require_receiver_kyc` passes for `offer.maker`.
///
/// That distinction is the whole point: `create_offer` is PERMISSIONLESS and
/// opens an empty escrow, so without it a wallet with no `KycEntry` could open
/// an offer, let any holder (or an issuer treasury sitting on fresh units)
/// raw-fund the escrow, and cancel to walk the units out — no admin, no KYC,
/// no cost. The hook cannot see it, because the offer PDA's own `EscrowMarker`
/// exempts the leg.
///
/// The cancel ALWAYS completes and the offer always reaches `Cancelled` — a
/// refusal never bricks it (and a withheld surplus is not the maker's to lose).
/// Withheld units stay in the escrow; since cancel is terminal and closes the
/// marker, they are immobilised there permanently. Leaving the offer `Open`
/// instead would be worse: it would still be takeable.
pub fn handle_cancel_offer<'info>(ctx: Context<'info, CancelOffer<'info>>) -> Result<()> {
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
    offer.status = OfferStatus::Cancelled;
    if release.withheld > 0 {
        msg!(
            "OTC offer {} — {} un-deposited units withheld (maker not eligible to receive them)",
            offer.offer_id,
            release.withheld
        );
    }
    msg!(
        "OTC offer {} cancelled — {} units refunded",
        offer.offer_id,
        escrow_amount
    );
    Ok(())
}
