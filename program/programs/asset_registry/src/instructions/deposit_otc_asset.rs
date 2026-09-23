use anchor_lang::prelude::*;
use anchor_lang::AccountsClose;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{EscrowMarker, OtcDeal, OtcDealStatus};
use crate::util::{hook_transfer, settle_otc_deal};

#[derive(Accounts)]
pub struct DepositOtcAsset<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [OTC_DEAL_SEED, deal.share_class.as_ref(), &deal.deal_id.to_le_bytes()],
        bump = deal.bump,
        has_one = seller @ RegistryError::WrongDealParty,
        has_one = mint @ RegistryError::Unauthorized,
        has_one = payment_mint @ RegistryError::Unauthorized,
        has_one = asset_escrow @ RegistryError::Unauthorized,
        has_one = payment_escrow @ RegistryError::Unauthorized,
        constraint = deal.status == OtcDealStatus::Open @ RegistryError::DealNotOpen,
        constraint = !deal.asset_deposited @ RegistryError::DealAlreadyDeposited,
    )]
    pub deal: Box<Account<'info, OtcDeal>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Seller's share-class token account — debited exactly `deal.amount`.
    #[account(
        mut,
        constraint = seller_share_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = seller_share_account.owner == seller.key() @ RegistryError::Unauthorized,
    )]
    pub seller_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub asset_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub payment_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Buyer receives the share units here if this deposit completes the pair.
    #[account(
        mut,
        constraint = buyer_share_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = buyer_share_account.owner == deal.buyer @ RegistryError::Unauthorized,
    )]
    pub buyer_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Seller receives the payment here if this deposit completes the pair.
    #[account(
        mut,
        constraint = seller_payment_account.mint == payment_mint.key() @ RegistryError::Unauthorized,
        constraint = seller_payment_account.owner == deal.seller @ RegistryError::Unauthorized,
    )]
    pub seller_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Escrow marker for the deal PDA — closed (rent → seller) when this
    /// deposit completes the pair and the swap settles.
    #[account(
        mut,
        seeds = [ESCROW_MARKER_SEED, deal.key().as_ref()],
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
    // remaining_accounts: the deposit leg's hook tail (source authority =
    // seller), plus — when this deposit completes the pair — the settle leg's
    // hook tail (source authority = deal PDA). Both legs transfer the same
    // share mint, so the tails are equal length: 3 accounts each in Open mode
    // ([BlockEntry, ExtraAccountMetaList, hook program]), 9 each in KycGated
    // mode (see docs in transfer_hook).
}

/// Seller deposits exactly `deal.amount` share units into the asset escrow.
/// The deposit leg is hook-aware with the seller as authority — the seller is
/// a real transaction signer, so empty signer seeds suffice (`invoke_signed`
/// with `&[]` propagates the outer signature). If the buyer's payment is
/// already escrowed, the swap settles atomically in the same instruction.
pub fn handle_deposit_otc_asset<'info>(ctx: Context<'info, DepositOtcAsset<'info>>) -> Result<()> {
    crate::util::require_supported_mint(
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.share_token_program.key(),
        true,
    )?;
    crate::util::require_supported_mint(
        &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.payment_token_program.key(),
        false,
    )?;

    let expires_at = ctx.accounts.deal.expires_at;
    let now = Clock::get()?.unix_timestamp;
    require!(
        expires_at == 0 || now <= expires_at,
        RegistryError::DealExpired
    );

    let will_settle = ctx.accounts.deal.payment_deposited;
    // Both legs transfer the same share mint ⇒ equal-length hook tails
    // (3 accounts each in Open mode, 9 each in KycGated) — split in half.
    let (deposit_hook, settle_hook) = if will_settle {
        ctx.remaining_accounts
            .split_at(ctx.remaining_accounts.len() / 2)
    } else {
        (ctx.remaining_accounts, &[][..])
    };

    // 1. deposit: seller → asset escrow (hook-aware; seller signs the tx)
    hook_transfer(
        &ctx.accounts.share_token_program.to_account_info(),
        &ctx.accounts.seller_share_account.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.asset_escrow.to_account_info(),
        &ctx.accounts.seller.to_account_info(),
        deposit_hook,
        ctx.accounts.deal.amount,
        ctx.accounts.mint.decimals,
        &[],
    )?;

    // 2. both sides funded → atomic swap (deal PDA signs)
    if will_settle {
        settle_otc_deal(
            &ctx.accounts.deal,
            &ctx.accounts.mint,
            &ctx.accounts.asset_escrow,
            &ctx.accounts.buyer_share_account,
            &ctx.accounts.payment_mint,
            &ctx.accounts.payment_escrow,
            &ctx.accounts.seller_payment_account,
            &ctx.accounts.share_token_program.to_account_info(),
            &ctx.accounts.payment_token_program.to_account_info(),
            settle_hook,
        )?;
        // Terminal path — close the escrow marker (rent → the depositing
        // signer). Closed after the settle CPI so the hook could resolve it.
        ctx.accounts
            .escrow_marker
            .close(ctx.accounts.seller.to_account_info())?;
    }

    let deal = &mut ctx.accounts.deal;
    deal.asset_deposited = true;
    // Record WHAT was deposited, not just THAT something was. The refund paths
    // pay the seller at most this much without a receiver-KYC check; sweeping
    // the live escrow balance instead would refund units a third party (or the
    // admin who named the seller) raw-transferred in — see
    // `util::refund_otc_deposits`. The deposit above moves exactly `amount`,
    // and `!asset_deposited` in the account constraints makes this a one-shot.
    deal.asset_deposited_amount = deal.amount;
    if will_settle {
        deal.status = OtcDealStatus::Completed;
        msg!(
            "OTC deal {} completed — {} units for {}",
            deal.deal_id,
            deal.amount,
            deal.price
        );
    } else {
        msg!("OTC deal {} — asset deposited", deal.deal_id);
    }
    Ok(())
}
