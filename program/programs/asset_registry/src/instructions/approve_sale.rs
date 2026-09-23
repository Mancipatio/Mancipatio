use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    Admin, Asset, Issuer, KybStatus, RaiseType, SaleApproval, SaleApproved, ShareClass,
};

#[derive(Accounts)]
#[instruction(sale_id: u64)]
pub struct ApproveSale<'info> {
    /// The approving Admin; pays the approval's rent and becomes `approved_by`.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate: only a platform Admin may approve a sale.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()],
        bump = issuer.bump,
        constraint = issuer.kyb_status == KybStatus::Verified @ RegistryError::IssuerNotVerified,
    )]
    pub issuer: Box<Account<'info, Issuer>>,

    #[account(
        seeds = [ASSET_SEED, issuer.key().as_ref(), asset.asset_id.as_bytes()],
        bump = asset.bump,
        has_one = issuer @ RegistryError::Unauthorized,
    )]
    pub asset: Box<Account<'info, Asset>>,

    #[account(
        seeds = [SHARE_CLASS_SEED, asset.key().as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
        has_one = asset @ RegistryError::Unauthorized,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    /// The payment mint the approved sale must use (validated in the handler
    /// with the same payment-leg rule `open_sale` applies to its escrow).
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The future `Sale` PDA for this id. It must still be empty, so the
    /// approval can actually be consumed.
    /// CHECK: seeds-bound and required to be empty; never read or written.
    #[account(
        seeds = [SALE_SEED, share_class.key().as_ref(), &sale_id.to_le_bytes()],
        bump,
        constraint = sale.data_is_empty() @ RegistryError::SaleIdAlreadyUsed,
    )]
    pub sale: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + SaleApproval::INIT_SPACE,
        seeds = [SALE_APPROVAL_SEED, share_class.key().as_ref(), &sale_id.to_le_bytes()],
        bump
    )]
    pub sale_approval: Box<Account<'info, SaleApproval>>,

    pub system_program: Program<'info, System>,
}

/// Records an Admin's approval to open exactly one sale of `share_class` under
/// `sale_id`, bounded by payment mint, price range, maximum gross raise, raise
/// type and expiry. `open_sale` consumes (and closes) it. No `Platform`
/// account: approving is not an entry flow, so the emergency pause does not
/// apply (the consuming `open_sale` is still `PAUSE_PRIMARY`-gated).
pub fn handle_approve_sale(
    ctx: Context<ApproveSale>,
    sale_id: u64,
    max_gross_raise: u64,
    min_price_per_unit: u64,
    max_price_per_unit: u64,
    raise_type: RaiseType,
    expires_at: i64,
    application_hash: [u8; 32],
) -> Result<()> {
    // The payment-leg rule `open_sale` applies (via `payment_escrow_space`):
    // an approval for a mint the sale could never use is refused up front.
    let payment_mint_info = ctx.accounts.payment_mint.to_account_info();
    crate::util::require_supported_mint(&payment_mint_info, payment_mint_info.owner, false)?;

    let now = Clock::get()?.unix_timestamp;
    let latest_expiry = now
        .checked_add(SALE_APPROVAL_MAX_TTL_SECS)
        .ok_or(RegistryError::Overflow)?;
    require!(
        max_gross_raise > 0
            && min_price_per_unit > 0
            && min_price_per_unit <= max_price_per_unit
            && application_hash != [0u8; 32]
            && expires_at > now
            && expires_at <= latest_expiry,
        RegistryError::InvalidSaleApproval
    );

    let approval_key = ctx.accounts.sale_approval.key();
    let share_class = ctx.accounts.share_class.key();
    let issuer = ctx.accounts.issuer.key();
    let payment_mint = ctx.accounts.payment_mint.key();
    let approved_by = ctx.accounts.authority.key();

    let approval = &mut ctx.accounts.sale_approval;
    approval.share_class = share_class;
    approval.sale_id = sale_id;
    approval.issuer = issuer;
    approval.payment_mint = payment_mint;
    approval.max_gross_raise = max_gross_raise;
    approval.min_price_per_unit = min_price_per_unit;
    approval.max_price_per_unit = max_price_per_unit;
    approval.raise_type = raise_type;
    approval.expires_at = expires_at;
    approval.application_hash = application_hash;
    approval.approved_by = approved_by;
    approval.bump = ctx.bumps.sale_approval;
    approval.version = STATE_VERSION;

    emit!(SaleApproved {
        sale_approval: approval_key,
        share_class,
        sale_id,
        issuer,
        payment_mint,
        max_gross_raise,
        min_price_per_unit,
        max_price_per_unit,
        raise_type,
        expires_at,
        application_hash,
        approved_by,
    });
    msg!(
        "Sale {} approved: max gross {} at {}..={} per unit, expires {}",
        sale_id,
        max_gross_raise,
        min_price_per_unit,
        max_price_per_unit,
        expires_at
    );
    Ok(())
}
