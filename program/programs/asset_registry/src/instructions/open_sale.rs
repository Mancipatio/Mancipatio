use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    Asset, AssetStatus, Issuer, RaiseType, Sale, SaleApproval, SaleApprovalConsumed, SaleStatus,
    ShareClass,
};

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

    /// The Admin's approval for exactly this `(share_class, sale_id)` (the
    /// seeds bind both). Consumed here: closed, rent to `approved_by`.
    #[account(
        mut,
        seeds = [SALE_APPROVAL_SEED, share_class.key().as_ref(), &sale_id.to_le_bytes()],
        bump = sale_approval.bump,
        has_one = issuer @ RegistryError::SaleApprovalMismatch,
        has_one = payment_mint @ RegistryError::SaleApprovalMismatch,
        has_one = approved_by @ RegistryError::SaleApprovalMismatch,
        close = approved_by,
    )]
    pub sale_approval: Box<Account<'info, SaleApproval>>,

    /// The approving Admin (`sale_approval.approved_by`); receives the consumed
    /// approval's rent. May be the same key as `authority`.
    /// CHECK: bound to `sale_approval.approved_by` by `has_one`.
    #[account(mut)]
    pub approved_by: UncheckedAccount<'info>,

    /// Emergency-pause gate (read-only). Keep LAST among named accounts: old
    /// account indices and the remaining-accounts hook tail keep their positions.
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_PRIMARY) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, crate::state::Platform>>,
}

/// Opens a primary sale of a share class — `total_for_sale` units at
/// `price_per_unit` payment-token base units each — within the bounds of an
/// Admin `SaleApproval`, which it consumes.
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
    // A zero price would hand out units for free (and a Startup vault of 0).
    require!(price_per_unit > 0, RegistryError::InvalidSalePrice);
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

    // The approval's terms. Issuer, share class, sale id, payment mint and
    // rent recipient are already bound by the account constraints.
    let approval = &ctx.accounts.sale_approval;
    require!(
        Clock::get()?.unix_timestamp <= approval.expires_at,
        RegistryError::SaleApprovalExpired
    );
    require!(
        raise_type == approval.raise_type,
        RegistryError::SaleApprovalMismatch
    );
    require!(
        price_per_unit >= approval.min_price_per_unit
            && price_per_unit <= approval.max_price_per_unit,
        RegistryError::SalePriceOutsideApproval
    );
    // A product past u64::MAX is over any u64 cap by definition. This also
    // bounds `buy`'s `price * amount`, which can no longer overflow.
    let gross = price_per_unit
        .checked_mul(total_for_sale)
        .ok_or(RegistryError::SaleExceedsApprovedRaise)?;
    require!(
        gross <= approval.max_gross_raise,
        RegistryError::SaleExceedsApprovedRaise
    );
    let approval_key = approval.key();
    let application_hash = approval.application_hash;
    let approved_by = approval.approved_by;

    let sale_key = ctx.accounts.sale.key();
    let share_class_key = ctx.accounts.share_class.key();
    let sale = &mut ctx.accounts.sale;
    sale.share_class = share_class_key;
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
    sale.version = SALE_STATE_VERSION;
    sale.bump = ctx.bumps.sale;
    sale.sale_approval = approval_key;
    sale.application_hash = application_hash;

    // Anchor closes the approval (`close = approved_by`) when this returns.
    emit!(SaleApprovalConsumed {
        sale_approval: approval_key,
        sale: sale_key,
        share_class: share_class_key,
        sale_id,
        price_per_unit,
        total_for_sale,
        approved_by,
    });
    msg!(
        "Sale {} opened — {} units @ {}",
        sale_id,
        total_for_sale,
        price_per_unit
    );
    Ok(())
}
