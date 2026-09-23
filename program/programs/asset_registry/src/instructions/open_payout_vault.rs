use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{PayoutVault, PayoutVaultState, RaiseType, Sale, SaleStatus};

#[derive(Accounts)]
pub struct OpenPayoutVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SALE_SEED, sale.share_class.as_ref(), &sale.sale_id.to_le_bytes()],
        bump = sale.bump,
        has_one = authority @ RegistryError::Unauthorized,
        has_one = proceeds @ RegistryError::Unauthorized,
        has_one = payment_mint @ RegistryError::Unauthorized,
        constraint = sale.status == SaleStatus::Open @ RegistryError::SaleNotOpen,
        constraint = sale.raise_type == RaiseType::Startup @ RegistryError::InvalidRaiseParams,
    )]
    pub sale: Box<Account<'info, Sale>>,

    #[account(mut)]
    pub proceeds: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = 8 + PayoutVault::INIT_SPACE,
        seeds = [PAYOUT_SEED, sale.key().as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, PayoutVault>>,

    #[account(
        init,
        payer = authority,
        seeds = [PAYOUT_ESCROW_SEED, vault.key().as_ref()],
        bump,
        space = crate::util::payment_escrow_space(&payment_mint.to_account_info(), &payment_token_program.key())?,
        owner = payment_token_program.key(),
    )]
    /// CHECK: allocated above, initialized with the bound mint and PDA owner in the handler.
    pub escrow: UncheckedAccount<'info>,

    pub payment_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_payout_vault(
    ctx: Context<OpenPayoutVault>,
    metadata_hash: [u8; 32],
) -> Result<()> {
    crate::util::initialize_token_escrow(
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.payment_token_program.to_account_info(),
    )?;

    let swept = ctx.accounts.proceeds.amount;
    require!(swept > 0, RegistryError::NothingToRelease);

    let cliff = ctx.accounts.sale.cliff_months;
    let vesting = ctx.accounts.sale.vesting_months;
    require!(vesting > cliff, RegistryError::InvalidRaiseParams);
    let num_tranches = vesting - cliff;
    // Liveness guard: with swept < num_tranches the per-tranche amount would
    // truncate to 0 and lock the vault. Raises are far larger in practice.
    require!(
        swept >= num_tranches as u64,
        RegistryError::InvalidRaiseParams
    );

    let sc_key = ctx.accounts.sale.share_class;
    let sale_id_seed = ctx.accounts.sale.sale_id.to_le_bytes();
    let sale_bump = ctx.accounts.sale.bump;
    let seeds: &[&[u8]] = &[SALE_SEED, sc_key.as_ref(), &sale_id_seed, &[sale_bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.payment_token_program.key(),
            TransferChecked {
                from: ctx.accounts.proceeds.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.sale.to_account_info(),
            },
            &[seeds],
        ),
        swept,
        ctx.accounts.payment_mint.decimals,
    )?;
    // 2D: the proceeds account is empty after the sweep; its rent goes back to
    // the sale authority (the founder), which paid for it.
    crate::util::close_empty_escrow(
        &ctx.accounts.proceeds.to_account_info(),
        Some(&ctx.accounts.payment_token_program),
        &ctx.accounts.sale.to_account_info(),
        &ctx.accounts.authority.to_account_info(),
        seeds,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let v = &mut ctx.accounts.vault;
    v.sale = ctx.accounts.sale.key();
    v.share_class = ctx.accounts.sale.share_class;
    v.payment_mint = ctx.accounts.payment_mint.key();
    v.escrow = ctx.accounts.escrow.key();
    v.founder = ctx.accounts.authority.key();
    v.raise_type = RaiseType::Startup;
    v.total_amount = swept;
    v.released = 0;
    v.start_ts = now + (cliff as i64) * MONTH;
    v.cliff_months = cliff;
    v.vesting_months = vesting;
    v.num_tranches = num_tranches;
    v.tranche_amount = swept / (num_tranches as u64);
    v.tranches_released = 0;
    v.updates_posted = 0;
    v.last_update_ts = 0;
    v.founder_yield_claimable = 0;
    v.investor_yield_pool = 0;
    v.investor_yield_root = [0u8; 32];
    v.total_weight = 0;
    v.state = PayoutVaultState::Active;
    v.metadata_hash = metadata_hash;
    v.version = PAYOUT_STATE_VERSION;
    v.vote_round = 0;
    v.vote_pending = false;
    v.bump = ctx.bumps.vault;

    ctx.accounts.sale.status = SaleStatus::Closed;
    msg!(
        "Payout vault opened — {} over {} tranches",
        swept,
        num_tranches
    );
    Ok(())
}
