use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{EscrowMarker, Offer, OfferStatus, ShareClass};

#[derive(Accounts)]
#[instruction(offer_id: u64)]
pub struct CreateOffer<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        seeds = [SHARE_CLASS_SEED, share_class.asset.as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
        has_one = mint @ RegistryError::Unauthorized,
        constraint = share_class.mint_initialized @ RegistryError::MintNotInitialized,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Payment mint the taker will pay in.
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = maker,
        space = 8 + Offer::INIT_SPACE,
        seeds = [OFFER_SEED, share_class.key().as_ref(), &offer_id.to_le_bytes()],
        bump
    )]
    pub offer: Box<Account<'info, Offer>>,

    /// Escrow for the maker's deposited share units; authority is the `Offer` PDA.
    #[account(
        init,
        payer = maker,
        seeds = [ESCROW_SEED, offer.key().as_ref()],
        bump,
        space = crate::util::token_escrow_space(&mint.to_account_info(), &token_program.key())?,
        owner = token_program.key(),
    )]
    /// CHECK: allocated above, initialized with the bound mint and PDA owner in the handler.
    pub escrow: UncheckedAccount<'info>,

    /// Marks the offer PDA as a platform escrow authority — the transfer hook
    /// exempts escrow legs from receiver-KYC while this exists. Closed on
    /// every terminal path (take / cancel / expire).
    ///
    /// NOTE: the marker is a ROUTING fact (an escrow PDA can never hold a
    /// `KycEntry`), not a statement that whatever leaves this escrow may go
    /// anywhere. Because `create_offer` is permissionless and the escrow is an
    /// ordinary token account, anyone can push units into it — so every exit
    /// decides for itself, against `offer.deposited`.
    #[account(
        init,
        payer = maker,
        space = 8 + EscrowMarker::INIT_SPACE,
        seeds = [ESCROW_MARKER_SEED, offer.key().as_ref()],
        bump
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    /// Emergency-pause gate (read-only). Keep LAST among named accounts: old
    /// account indices and the remaining-accounts hook tail keep their positions.
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_SECONDARY) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, crate::state::Platform>>,
}

/// Opens an OTC sell offer with an EMPTY escrow — permissionless, no KYC and
/// no units are required of the maker at this point.
///
/// The maker then funds it with `deposit_to_offer_escrow`, which credits
/// `offer.deposited`; `take_offer` requires `offer.deposited >= offer.amount`
/// before it will sell. A bare client-side `transfer_checked` into the escrow
/// still succeeds (nothing on-chain can stop it) but records NOTHING, and
/// every escrow→wallet exit is capped at the ledger — that is what keeps a
/// permissionless "open an offer, let someone else fund it, cancel" sequence
/// from being a KYC bypass. docs/05.
pub fn handle_create_offer(
    ctx: Context<CreateOffer>,
    offer_id: u64,
    amount: u64,
    price: u64,
    expires_at: i64,
) -> Result<()> {
    crate::util::require_supported_mint(
        &ctx.accounts.payment_mint.to_account_info(),
        ctx.accounts.payment_mint.to_account_info().owner,
        false,
    )?;

    crate::util::initialize_token_escrow(
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.offer.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
    )?;

    require!(amount > 0 && price > 0, RegistryError::InvalidOfferParams);
    let now = Clock::get()?.unix_timestamp;
    require!(
        expires_at == 0 || expires_at > now,
        RegistryError::InvalidExpiry
    );

    let offer = &mut ctx.accounts.offer;
    offer.maker = ctx.accounts.maker.key();
    offer.share_class = ctx.accounts.share_class.key();
    offer.mint = ctx.accounts.mint.key();
    offer.escrow = ctx.accounts.escrow.key();
    offer.payment_mint = ctx.accounts.payment_mint.key();
    offer.amount = amount;
    offer.price = price;
    offer.status = OfferStatus::Open;
    offer.offer_id = offer_id;
    offer.expires_at = expires_at;
    offer.version = STATE_VERSION;
    offer.bump = ctx.bumps.offer;
    offer.deposited = 0; // credited only by `deposit_to_offer_escrow`

    ctx.accounts.escrow_marker.bump = ctx.bumps.escrow_marker;

    msg!(
        "OTC offer {} opened — {} units for {}",
        offer_id,
        amount,
        price
    );
    Ok(())
}
