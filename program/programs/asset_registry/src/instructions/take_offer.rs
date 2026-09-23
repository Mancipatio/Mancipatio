use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{EscrowMarker, Offer, OfferStatus};
use crate::util::{hook_transfer, require_receiver_kyc};

#[derive(Accounts)]
pub struct TakeOffer<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        mut,
        seeds = [OFFER_SEED, offer.share_class.as_ref(), &offer.offer_id.to_le_bytes()],
        bump = offer.bump,
        has_one = mint @ RegistryError::Unauthorized,
        has_one = escrow @ RegistryError::Unauthorized,
        has_one = payment_mint @ RegistryError::Unauthorized,
        constraint = offer.status == OfferStatus::Open @ RegistryError::OfferNotOpen,
    )]
    pub offer: Box<Account<'info, Offer>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Taker receives the share units here. Bound to the taker signer so the
    /// receiver of the escrowed security is the party whose KYC is checked below
    /// — shares can never be redirected to an arbitrary third-party account
    /// (mirrors `expire_offer` / `deposit_otc_asset`).
    #[account(
        mut,
        constraint = taker_share_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = taker_share_account.owner == taker.key() @ RegistryError::Unauthorized,
    )]
    pub taker_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Taker pays from here.
    #[account(
        mut,
        constraint = taker_payment_account.mint == offer.payment_mint @ RegistryError::Unauthorized,
    )]
    pub taker_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Maker receives the payment here.
    #[account(
        mut,
        constraint = maker_payment_account.mint == offer.payment_mint @ RegistryError::Unauthorized,
        constraint = maker_payment_account.owner == offer.maker @ RegistryError::Unauthorized,
    )]
    pub maker_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Escrow marker for the offer PDA — closed here (rent → taker);
    /// take is a terminal path.
    #[account(
        mut,
        close = taker,
        seeds = [ESCROW_MARKER_SEED, offer.key().as_ref()],
        bump = escrow_marker.bump,
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    pub share_token_program: Interface<'info, TokenInterface>,
    pub payment_token_program: Interface<'info, TokenInterface>,

    /// Emergency-pause gate (read-only). Keep LAST among named accounts: old
    /// account indices and the remaining-accounts hook tail keep their positions.
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_SECONDARY) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, crate::state::Platform>>,
    // remaining_accounts: the escrow→taker leg's hook tail (source authority =
    // offer PDA) — [BlockEntry, ExtraAccountMetaList, hook program] in Open
    // mode, 9 accounts in KycGated mode (see docs in transfer_hook).
}

/// Fills an open OTC offer: the taker pays `offer.price` to the maker and the
/// escrowed share units are released to the taker. The escrow→taker leg is a
/// hook-aware `transfer_checked` signed by the `Offer` PDA (docs/05 §5).
pub fn handle_take_offer<'info>(ctx: Context<'info, TakeOffer<'info>>) -> Result<()> {
    crate::util::require_supported_mint(
        &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.payment_token_program.key(),
        false,
    )?;

    let amount = ctx.accounts.offer.amount;
    let price = ctx.accounts.offer.price;
    let expires_at = ctx.accounts.offer.expires_at;
    let now = Clock::get()?.unix_timestamp;
    require!(
        expires_at == 0 || now <= expires_at,
        RegistryError::OfferExpired
    );
    // The MAKER must have deposited at least what they are selling, through
    // `deposit_to_offer_escrow` (the only instruction that credits the ledger).
    // Keying on `offer.deposited` rather than on the live escrow balance does
    // two things: it stops a maker from selling units a third party pushed
    // into the escrow with a raw `transfer_checked` (they would pocket the
    // payment for somebody else's property), and it means a single stray base
    // unit sent into the escrow can no longer brick the fill — the old
    // `escrow.amount == amount` equality made that a one-lamport grief.
    // `escrow.amount >= offer.deposited` always holds (deposits only add;
    // every subtracting path is terminal), so the transfer below is covered.
    require!(
        ctx.accounts.offer.deposited >= amount,
        RegistryError::OfferNotFunded
    );

    // Receiver eligibility (KycGated mints only). Offers are permissionless on
    // both sides, so — unlike admin-created OTC deals / custody / distributions
    // — the taker is never platform-vetted and the hook's source-marker
    // exemption would otherwise let an unqualified wallet acquire the security.
    // Enforce the receiver's KYC on-chain here (the escrow→taker leg's receiver
    // is `taker_share_account.owner`, constrained above to equal `taker`).
    require_receiver_kyc(
        ctx.remaining_accounts,
        &ctx.accounts.mint.key(),
        &ctx.accounts.taker_share_account.owner,
    )?;

    // 1. payment: taker → maker (payment mint has no hook — plain CPI)
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.payment_token_program.key(),
            TransferChecked {
                from: ctx.accounts.taker_payment_account.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.maker_payment_account.to_account_info(),
                authority: ctx.accounts.taker.to_account_info(),
            },
        ),
        price,
        ctx.accounts.payment_mint.decimals,
    )?;

    // 2. release: escrow → taker (share mint — hook-aware, Offer PDA signs)
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
        &ctx.accounts.taker_share_account.to_account_info(),
        &ctx.accounts.offer.to_account_info(),
        ctx.remaining_accounts,
        amount,
        ctx.accounts.mint.decimals,
        signer_seeds,
    )?;

    let offer = &mut ctx.accounts.offer;
    offer.deposited = offer.deposited.saturating_sub(amount);
    offer.status = OfferStatus::Filled;
    msg!(
        "OTC offer {} filled — {} units for {}",
        offer.offer_id,
        amount,
        price
    );
    Ok(())
}
