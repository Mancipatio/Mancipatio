use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Asset, Issuer, KybStatus, Sale, SaleStatus, ShareClass};
use crate::util::require_receiver_kyc_for_mint_to;

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [SALE_SEED, sale.share_class.as_ref(), &sale.sale_id.to_le_bytes()],
        bump = sale.bump,
        has_one = mint @ RegistryError::Unauthorized,
        has_one = proceeds @ RegistryError::Unauthorized,
        has_one = share_class @ RegistryError::Unauthorized,
        constraint = sale.status == SaleStatus::Open @ RegistryError::SaleNotOpen,
    )]
    pub sale: Box<Account<'info, Sale>>,

    #[account(
        mut,
        seeds = [SHARE_CLASS_SEED, share_class.asset.as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Buyer's share-class token account — receives the purchased units.
    /// Bound to the buyer signer so the receiver of the minted security is the
    /// party whose KYC is checked in the handler — units can never be
    /// redirected to an arbitrary third-party account (mirrors `take_offer`).
    #[account(
        mut,
        constraint = buyer_share_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = buyer_share_account.owner == buyer.key() @ RegistryError::Unauthorized,
    )]
    pub buyer_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Buyer's payment token account — debited the price.
    #[account(
        mut,
        constraint = buyer_payment_account.mint == sale.payment_mint @ RegistryError::Unauthorized,
    )]
    pub buyer_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = sale.payment_mint @ RegistryError::Unauthorized)]
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub proceeds: Box<InterfaceAccount<'info, TokenAccount>>,

    pub share_token_program: Interface<'info, TokenInterface>,
    pub payment_token_program: Interface<'info, TokenInterface>,

    #[account(address = share_class.asset, has_one = issuer @ RegistryError::Unauthorized)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(
        seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()],
        bump = issuer.bump,
        constraint = issuer.kyb_status == KybStatus::Verified @ RegistryError::IssuerNotVerified,
    )]
    pub issuer: Box<Account<'info, Issuer>>,

    /// Emergency-pause gate (read-only). Keep LAST among named accounts: old
    /// account indices and the remaining-accounts hook tail keep their positions.
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_PRIMARY) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, crate::state::Platform>>,
    // remaining_accounts — accounts the fail-closed receiver-KYC check in the
    // handler resolves. No transfer runs here (delivery is a `mint_to`), so
    // this is NOT a positional hook tail: each account is looked up by its
    // re-derived PDA key, so order and extra accounts are irrelevant. The
    // contract is a membership one:
    //
    //   * always: `["hook_cfg", mint]` (the `TransferHookConfig`) OR
    //     `["extra-account-metas", mint]` (the `ExtraAccountMetaList`) — one of
    //     the two must be present to prove the mint's restriction mode. A tail
    //     carrying neither fails with `KycProofRequired`, in Open mode too;
    //   * additionally when the config says `KycGated`: the `KycRegistry` it
    //     names and `["kyc", registry, buyer]` (the buyer's `KycEntry`).
    //
    // Passing the mint's full hook tail (3 accounts in Open mode, 9 in
    // KycGated — see docs in transfer_hook) satisfies both, which is what
    // `take_offer` callers already build; a caller may equally pass just the
    // subset above.
}

/// Buys `amount` share-class units: the buyer pays `price_per_unit * amount`
/// into the proceeds escrow, and that many units are minted to the buyer.
pub fn handle_buy(ctx: Context<Buy>, amount: u64) -> Result<()> {
    crate::util::require_supported_mint(
        &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.payment_token_program.key(),
        false,
    )?;

    crate::util::require_immutable_owner(&ctx.accounts.buyer_share_account.to_account_info())?;

    require!(amount > 0, RegistryError::InvalidSaleParams);
    require!(
        !ctx.accounts.share_class.supply_locked || ctx.accounts.share_class.mintable_post_launch,
        RegistryError::SupplyLocked
    );

    let (new_supply, new_lifetime) =
        crate::util::next_issuance_supply(&ctx.accounts.share_class, amount)?;

    let price = ctx.accounts.sale.price_per_unit;
    let total = ctx.accounts.sale.total_for_sale;
    let sold = ctx.accounts.sale.sold;
    let start_ts = ctx.accounts.sale.start_ts;
    let end_ts = ctx.accounts.sale.end_ts;
    let sale_id = ctx.accounts.sale.sale_id;

    let now = Clock::get()?.unix_timestamp;
    require!(now >= start_ts, RegistryError::SaleNotStarted);
    require!(
        end_ts == 0 || now <= end_ts,
        RegistryError::SaleWindowClosed
    );

    let new_sold = sold.checked_add(amount).ok_or(RegistryError::Overflow)?;
    require!(new_sold <= total, RegistryError::SaleSoldOut);
    let cost = price.checked_mul(amount).ok_or(RegistryError::Overflow)?;

    // Receiver eligibility (KycGated mints only). Primary-sale delivery is a
    // `mint_to`, which Token-2022 never routes through the transfer hook — so
    // unlike every transfer leg there is no hook CPI to backstop a stripped
    // account tail. The check is therefore fail-closed: the caller must pass
    // the accounts listed in the `remaining_accounts` contract above so the
    // restriction mode can be proven on-chain; a `KycGated` mint then demands
    // a valid `KycEntry` for the receiver (`buyer_share_account.owner`,
    // constrained above to equal `buyer`).
    require_receiver_kyc_for_mint_to(
        ctx.remaining_accounts,
        &ctx.accounts.mint.key(),
        &ctx.accounts.buyer_share_account.owner,
    )?;

    // 1. payment: buyer → proceeds escrow
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.payment_token_program.key(),
            TransferChecked {
                from: ctx.accounts.buyer_payment_account.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.proceeds.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        cost,
        ctx.accounts.payment_mint.decimals,
    )?;

    // 2. delivery: mint share-class units → buyer (ShareClass PDA signs)
    let asset_key = ctx.accounts.share_class.asset;
    let class_index_seed = [ctx.accounts.share_class.class_index];
    let bump_seed = [ctx.accounts.share_class.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        SHARE_CLASS_SEED,
        asset_key.as_ref(),
        &class_index_seed,
        &bump_seed,
    ]];
    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.share_token_program.key(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.buyer_share_account.to_account_info(),
                authority: ctx.accounts.share_class.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // 3. Commit both counters; only circulating supply is reduced by burns.
    let sc = &mut ctx.accounts.share_class;
    sc.circulating_supply = new_supply;
    sc.lifetime_minted = new_lifetime;
    ctx.accounts.sale.sold = new_sold;

    msg!("Buy — {} units for {} (sale {})", amount, cost, sale_id);
    Ok(())
}
