use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, EscrowMarker, OtcDeal, OtcDealStatus, ShareClass};

#[derive(Accounts)]
#[instruction(deal_id: u64)]
pub struct CreateOtcDeal<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate — only an admin may create OTC deals (the platform opens the
    /// deal after the parties have agreed off-chain).
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        seeds = [SHARE_CLASS_SEED, share_class.asset.as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
        has_one = mint @ RegistryError::Unauthorized,
        constraint = share_class.mint_initialized @ RegistryError::MintNotInitialized,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Payment mint the buyer will pay in (plain SPL or Token-2022).
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = 8 + OtcDeal::INIT_SPACE,
        seeds = [OTC_DEAL_SEED, share_class.key().as_ref(), &deal_id.to_le_bytes()],
        bump
    )]
    pub deal: Box<Account<'info, OtcDeal>>,

    /// Escrow for the seller's deposited share units; authority is the deal PDA.
    #[account(
        init,
        payer = authority,
        seeds = [OTC_ASSET_ESCROW_SEED, deal.key().as_ref()],
        bump,
        space = crate::util::token_escrow_space(&mint.to_account_info(), &token_program.key())?,
        owner = token_program.key(),
    )]
    /// CHECK: allocated above, initialized with the bound mint and PDA owner in the handler.
    pub asset_escrow: UncheckedAccount<'info>,

    /// Escrow for the buyer's deposited payment; authority is the deal PDA.
    #[account(
        init,
        payer = authority,
        seeds = [OTC_PAYMENT_ESCROW_SEED, deal.key().as_ref()],
        bump,
        space = crate::util::payment_escrow_space(&payment_mint.to_account_info(), &payment_token_program.key())?,
        owner = payment_token_program.key(),
    )]
    /// CHECK: allocated above, initialized with the bound mint and PDA owner in the handler.
    pub payment_escrow: UncheckedAccount<'info>,

    /// Marks the deal PDA as a platform escrow authority — the transfer hook
    /// exempts escrow legs from receiver-KYC while this exists. Closed on
    /// every terminal path (settle / cancel / expire).
    #[account(
        init,
        payer = authority,
        space = 8 + EscrowMarker::INIT_SPACE,
        seeds = [ESCROW_MARKER_SEED, deal.key().as_ref()],
        bump
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub payment_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Opens a bilateral OTC escrow deal between a named buyer and seller with
/// both escrows empty. Each party deposits their side; once both are funded
/// the swap settles atomically — otherwise `expire_otc_deal` / `cancel_otc_deal`
/// refund whichever side deposited. business-doc §9.
#[allow(clippy::too_many_arguments)]
pub fn handle_create_otc_deal(
    ctx: Context<CreateOtcDeal>,
    deal_id: u64,
    buyer: Pubkey,
    seller: Pubkey,
    amount: u64,
    price: u64,
    payment_mint: Pubkey,
    expires_at: i64,
) -> Result<()> {
    crate::util::initialize_token_escrow(
        &ctx.accounts.asset_escrow.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.deal.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
    )?;
    crate::util::initialize_token_escrow(
        &ctx.accounts.payment_escrow.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.deal.to_account_info(),
        &ctx.accounts.payment_token_program.to_account_info(),
    )?;

    require!(amount > 0 && price > 0, RegistryError::InvalidDealParams);
    require!(buyer != seller, RegistryError::InvalidDealParams);
    require!(
        ctx.accounts.payment_mint.key() == payment_mint,
        RegistryError::InvalidDealParams
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        expires_at == 0 || expires_at > now,
        RegistryError::InvalidExpiry
    );

    let deal = &mut ctx.accounts.deal;
    deal.admin = ctx.accounts.authority.key();
    deal.buyer = buyer;
    deal.seller = seller;
    deal.share_class = ctx.accounts.share_class.key();
    deal.mint = ctx.accounts.mint.key();
    deal.payment_mint = ctx.accounts.payment_mint.key();
    deal.asset_escrow = ctx.accounts.asset_escrow.key();
    deal.payment_escrow = ctx.accounts.payment_escrow.key();
    deal.amount = amount;
    deal.price = price;
    deal.asset_deposited = false;
    deal.payment_deposited = false;
    // Deposit ledgers — credited only by `deposit_otc_asset` /
    // `deposit_otc_payment`, and the cap on every refund leg.
    deal.asset_deposited_amount = 0;
    deal.payment_deposited_amount = 0;
    deal.status = OtcDealStatus::Open;
    deal.deal_id = deal_id;
    deal.expires_at = expires_at;
    deal.version = STATE_VERSION;
    deal.bump = ctx.bumps.deal;

    ctx.accounts.escrow_marker.bump = ctx.bumps.escrow_marker;

    msg!(
        "OTC deal {} opened — {} units for {} (buyer {}, seller {})",
        deal_id,
        amount,
        price,
        buyer,
        seller
    );
    Ok(())
}
