use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, PayoutVault, PayoutVaultState};

#[derive(Accounts)]
pub struct RouteYield<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate — the signer must hold an `Admin` record.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        mut,
        seeds = [PAYOUT_SEED, vault.sale.as_ref()],
        bump = vault.bump,
        has_one = escrow @ RegistryError::Unauthorized,
        has_one = payment_mint @ RegistryError::Unauthorized,
        constraint = vault.state == PayoutVaultState::Active @ RegistryError::VaultNotActive,
    )]
    pub vault: Box<Account<'info, PayoutVault>>,

    /// Distributor's payment-token source account (authority-owned).
    #[account(
        mut,
        constraint = source.mint == vault.payment_mint @ RegistryError::Unauthorized,
        constraint = source.owner == authority.key() @ RegistryError::Unauthorized,
    )]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Platform treasury — receives its third immediately.
    #[account(
        mut,
        constraint = platform_treasury.mint == vault.payment_mint @ RegistryError::Unauthorized,
        constraint = platform_treasury.owner == platform.protocol_treasury @ RegistryError::Unauthorized,
    )]
    pub platform_treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,
    pub payment_token_program: Interface<'info, TokenInterface>,
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_DISTRIBUTIONS) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, crate::state::Platform>>,
}

pub fn handle_route_yield(
    ctx: Context<RouteYield>,
    amount: u64,
    investor_root: [u8; 32],
    total_weight: u64,
) -> Result<()> {
    crate::util::require_supported_mint(
        &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.payment_token_program.key(),
        false,
    )?;

    require!(amount >= 3, RegistryError::InvalidRaiseParams);
    require!(
        total_weight > 0 && investor_root != [0; 32],
        RegistryError::InvalidRaiseParams
    );
    require!(
        ctx.accounts.vault.investor_yield_root == [0; 32]
            || ctx.accounts.vault.investor_yield_root == investor_root,
        RegistryError::InvalidRaiseParams
    );
    require!(
        ctx.accounts.vault.total_weight == 0 || ctx.accounts.vault.total_weight == total_weight,
        RegistryError::InvalidRaiseParams
    );

    let third = amount / 3;
    let founder_third = third;
    let platform_third = third;
    let investor_third = amount - founder_third - platform_third;

    let decimals = ctx.accounts.payment_mint.decimals;

    // distributor → escrow (founder + investor share stay in escrow)
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.payment_token_program.key(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        founder_third + investor_third,
        decimals,
    )?;

    // distributor → platform treasury (immediate)
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.payment_token_program.key(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.platform_treasury.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        platform_third,
        decimals,
    )?;

    let v = &mut ctx.accounts.vault;
    v.founder_yield_claimable = v
        .founder_yield_claimable
        .checked_add(founder_third)
        .ok_or(RegistryError::Overflow)?;
    v.investor_yield_pool = v
        .investor_yield_pool
        .checked_add(investor_third)
        .ok_or(RegistryError::Overflow)?;
    if v.investor_yield_root == [0u8; 32] {
        v.investor_yield_root = investor_root;
    } else {
        require!(
            v.investor_yield_root == investor_root,
            RegistryError::InvalidRaiseParams
        );
    }
    if v.total_weight == 0 {
        v.total_weight = total_weight;
    } else {
        require!(
            v.total_weight == total_weight,
            RegistryError::InvalidRaiseParams
        );
    }
    Ok(())
}
