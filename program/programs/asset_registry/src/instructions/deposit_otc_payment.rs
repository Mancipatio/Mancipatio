use anchor_lang::prelude::*;
use anchor_lang::AccountsClose;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{EscrowMarker, OtcDeal, OtcDealStatus};
use crate::util::settle_otc_deal;

#[derive(Accounts)]
pub struct DepositOtcPayment<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [OTC_DEAL_SEED, deal.share_class.as_ref(), &deal.deal_id.to_le_bytes()],
        bump = deal.bump,
        has_one = buyer @ RegistryError::WrongDealParty,
        has_one = mint @ RegistryError::Unauthorized,
        has_one = payment_mint @ RegistryError::Unauthorized,
        has_one = asset_escrow @ RegistryError::Unauthorized,
        has_one = payment_escrow @ RegistryError::Unauthorized,
        constraint = deal.status == OtcDealStatus::Open @ RegistryError::DealNotOpen,
        constraint = !deal.payment_deposited @ RegistryError::DealAlreadyDeposited,
    )]
    pub deal: Box<Account<'info, OtcDeal>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Buyer's payment token account — debited exactly `deal.price`.
    #[account(
        mut,
        constraint = buyer_payment_account.mint == payment_mint.key() @ RegistryError::Unauthorized,
        constraint = buyer_payment_account.owner == buyer.key() @ RegistryError::Unauthorized,
    )]
    pub buyer_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub payment_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub asset_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

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

    /// Escrow marker for the deal PDA — closed (rent → buyer) when this
    /// deposit completes the pair and the swap settles.
    #[account(
        mut,
        seeds = [ESCROW_MARKER_SEED, deal.key().as_ref()],
        bump = escrow_marker.bump,
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    pub share_token_program: Interface<'info, TokenInterface>,
    pub payment_token_program: Interface<'info, TokenInterface>,
    // remaining_accounts (only when this deposit completes the pair): the
    // settle leg's hook tail (source authority = deal PDA) — 3 accounts in
    // Open mode ([BlockEntry, ExtraAccountMetaList, hook program]), 9 in
    // KycGated mode (see docs in transfer_hook).
}

/// Buyer deposits exactly `deal.price` payment units into the payment escrow
/// (payment mint has no hook — plain CPI with the buyer as authority). If the
/// seller's asset is already escrowed, the swap settles atomically in the same
/// instruction.
pub fn handle_deposit_otc_payment<'info>(
    ctx: Context<'info, DepositOtcPayment<'info>>,
) -> Result<()> {
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

    // 1. deposit: buyer → payment escrow
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.payment_token_program.key(),
            TransferChecked {
                from: ctx.accounts.buyer_payment_account.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.payment_escrow.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        ctx.accounts.deal.price,
        ctx.accounts.payment_mint.decimals,
    )?;

    // 2. both sides funded → atomic swap (deal PDA signs)
    let will_settle = ctx.accounts.deal.asset_deposited;
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
            ctx.remaining_accounts,
        )?;
        // Terminal path — close the escrow marker (rent → the depositing
        // signer). Closed after the settle CPI so the hook could resolve it.
        ctx.accounts
            .escrow_marker
            .close(ctx.accounts.buyer.to_account_info())?;
    }

    let deal = &mut ctx.accounts.deal;
    deal.payment_deposited = true;
    // Record WHAT was deposited (exactly `price`, one-shot via the
    // `!payment_deposited` constraint). The refund path is capped at this, so
    // it can never hand the buyer payment units somebody else pushed into the
    // escrow — see `util::refund_otc_deposits`.
    deal.payment_deposited_amount = deal.price;
    if will_settle {
        deal.status = OtcDealStatus::Completed;
        msg!(
            "OTC deal {} completed — {} units for {}",
            deal.deal_id,
            deal.amount,
            deal.price
        );
    } else {
        msg!("OTC deal {} — payment deposited", deal.deal_id);
    }
    Ok(())
}
