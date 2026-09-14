use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Asset, AssetStatus, Issuer, RaiseType, Sale, SaleStatus, ShareClass};

#[derive(Accounts)]
#[instruction(sale_id: u64)]
pub struct OpenSale<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()],
        bump = issuer.bump,
        constraint = issuer.kyb_status == crate::state::KybStatus::Verified @ RegistryError::IssuerNotVerified,
        has_one = authority @ RegistryError::Unauthorized,
    )]
    pub issuer: Box<Account<'info, Issuer>>,

    #[account(
        seeds = [ASSET_SEED, issuer.key().as_ref(), asset.asset_id.as_bytes()],
        bump = asset.bump,
        has_one = issuer @ RegistryError::Unauthorized,
        constraint = asset.status == AssetStatus::Active @ RegistryError::AssetNotActive,
    )]
    pub asset: Box<Account<'info, Asset>>,

    #[account(
        seeds = [SHARE_CLASS_SEED, asset.key().as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
        has_one = asset @ RegistryError::Unauthorized,
        has_one = mint @ RegistryError::Unauthorized,
        constraint = share_class.mint_initialized @ RegistryError::MintNotInitialized,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Payment mint buyers pay in (e.g. USDC).
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = 8 + Sale::INIT_SPACE,
        seeds = [SALE_SEED, share_class.key().as_ref(), &sale_id.to_le_bytes()],
        bump
    )]
    pub sale: Box<Account<'info, Sale>>,

    /// Proceeds escrow (payment mint) — authority is the `Sale` PDA.
    #[account(
        init,
        payer = authority,
        seeds = [PROCEEDS_SEED, sale.key().as_ref()],
        bump,
        space = crate::util::payment_escrow_space(&payment_mint.to_account_info(), &payment_token_program.key())?,
        owner = payment_token_program.key(),
    )]
    /// CHECK: allocated above, initialized with the bound mint and PDA owner in the handler.
    pub proceeds: UncheckedAccount<'info>,

    pub payment_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Opens a primary sale of a share class — `total_for_sale` units at
/// `price_per_unit` payment-token base units each.
pub fn handle_open_sale(
    ctx: Context<OpenSale>,
    sale_id: u64,
    price_per_unit: u64,
    total_for_sale: u64,
    start_ts: i64,
    end_ts: i64,
    raise_type: RaiseType,
    cliff_months: u8,
    vesting_months: u8,
) -> Result<()> {
    crate::util::initialize_token_escrow(
        &ctx.accounts.proceeds.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.sale.to_account_info(),
        &ctx.accounts.payment_token_program.to_account_info(),
    )?;

    require!(total_for_sale > 0, RegistryError::InvalidSaleParams);
    require!(
        end_ts == 0 || end_ts > start_ts,
        RegistryError::InvalidSaleParams
    );
    if raise_type == RaiseType::Startup {
        require!(
            vesting_months > cliff_months,
            RegistryError::InvalidRaiseParams
        );
    }

    let sale = &mut ctx.accounts.sale;
    sale.share_class = ctx.accounts.share_class.key();
    sale.mint = ctx.accounts.mint.key();
    sale.payment_mint = ctx.accounts.payment_mint.key();
    sale.proceeds = ctx.accounts.proceeds.key();
    sale.authority = ctx.accounts.authority.key();
    sale.sale_id = sale_id;
    sale.price_per_unit = price_per_unit;
    sale.total_for_sale = total_for_sale;
    sale.sold = 0;
    sale.start_ts = start_ts;
    sale.end_ts = end_ts;
    sale.status = SaleStatus::Open;
    sale.raise_type = raise_type;
    sale.cliff_months = cliff_months;
    sale.vesting_months = vesting_months;
    sale.version = STATE_VERSION;
    sale.bump = ctx.bumps.sale;

    msg!(
        "Sale {} opened — {} units @ {}",
        sale_id,
        total_for_sale,
        price_per_unit
    );
    Ok(())
}
