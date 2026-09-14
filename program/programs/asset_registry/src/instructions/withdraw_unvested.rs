use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    VestingSeries, VestingSeriesStatus, VestingSurplusWithdrawn, VestingUnvestedWithdrawn,
};
use crate::util::hook_transfer;

#[derive(Accounts)]
pub struct WithdrawUnvested<'info> {
    /// The client — series authority.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [
            VESTING_SERIES_SEED,
            series.authority.as_ref(),
            &series.series_id.to_le_bytes(),
        ],
        bump = series.bump,
        has_one = authority @ RegistryError::Unauthorized,
        has_one = token_mint @ RegistryError::Unauthorized,
        has_one = escrow @ RegistryError::Unauthorized,
    )]
    pub series: Box<Account<'info, VestingSeries>>,

    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The client's token account — destination of the unvested remainder.
    #[account(
        mut,
        constraint = authority_token_account.mint == token_mint.key()
            @ RegistryError::Unauthorized,
        constraint = authority_token_account.owner == authority.key()
            @ RegistryError::Unauthorized,
    )]
    pub authority_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts — transfer-hook accounts for the escrow → client leg.
    #[account(mut, seeds = [ESCROW_MARKER_SEED, series.key().as_ref()], bump = identity.bump,
        constraint = identity.refund_owner == series.authority @ RegistryError::Unauthorized)]
    pub identity: Box<Account<'info, crate::state::EscrowIdentity>>,
}

/// Withdraws the UNVESTED remainder after cancellation (all funds for an aborted Draft). The amount provably
/// reserved for recipients — `final_cumulative` minus what they have already
/// taken — can never leave: the withdrawal is capped at
/// `escrow_balance − reserved`. Since position entitlements are floored
/// pro-rata shares of `final_cumulative`, their true sum is ≤ the reserved
/// figure, so recipients are always made whole; only rounding dust and
/// post-cancel deposits (refundable here) sit above it. Repeatable — each
/// call sweeps whatever is currently free (spec §11.1.10: "only the unvested
/// tokens return to the client").
pub fn handle_withdraw_unvested<'info>(ctx: Context<'info, WithdrawUnvested<'info>>) -> Result<()> {
    let s = &ctx.accounts.series;
    require!(
        s.status == VestingSeriesStatus::Cancelled,
        RegistryError::VestingNotCancelled
    );
    let reserved = s.final_cumulative.saturating_sub(s.total_released);
    let own_consumed = s.total_released;
    withdraw_available(ctx, reserved, own_consumed, false)
}

/// Sweeps only assets above every outstanding finalized allocation. A client's
/// own deposit first backs the entire allocation, so a donated excess cannot
/// borrow that deposit's KYC refund exception. Legacy identity attachment starts
/// with no own ledger and therefore requires normal recipient eligibility.
pub fn handle_withdraw_vesting_surplus<'info>(
    ctx: Context<'info, WithdrawUnvested<'info>>,
) -> Result<()> {
    let s = &ctx.accounts.series;
    require!(
        s.status == VestingSeriesStatus::Active,
        RegistryError::VestingNotActive
    );
    let schedule_total = crate::util::vesting_schedule_total(&s.tranches)?;
    require!(
        schedule_total > 0 && schedule_total == s.total_allocated,
        RegistryError::VestingAllocationMismatch
    );
    let reserved = s
        .total_allocated
        .checked_sub(s.total_released)
        .ok_or(RegistryError::Overflow)?;
    let own_consumed = s.total_allocated;
    withdraw_available(ctx, reserved, own_consumed, true)
}

fn withdraw_available<'info>(
    ctx: Context<'info, WithdrawUnvested<'info>>,
    reserved: u64,
    own_consumed: u64,
    surplus: bool,
) -> Result<()> {
    let s = &ctx.accounts.series;
    let available = ctx.accounts.escrow.amount.saturating_sub(reserved);
    // Conservatively count every recipient release against the client's own
    // deposits first. Gifts, raw transfers and pre-attach history never create
    // an unverified refund allowance. The allowance is consumed after CPI.
    let own_remaining = ctx
        .accounts
        .identity
        .own_deposited
        .saturating_sub(own_consumed)
        .saturating_sub(ctx.accounts.identity.own_refunded);
    let release = crate::util::split_escrow_release(
        available,
        own_remaining,
        ctx.remaining_accounts,
        &ctx.accounts.token_mint.key(),
        &s.authority,
    );
    let amount = release.payout;
    require!(amount > 0, RegistryError::VestingNothingToWithdraw);

    let authority_key = s.authority;
    let series_id_seed = s.series_id.to_le_bytes();
    let bump = s.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VESTING_SERIES_SEED,
        authority_key.as_ref(),
        &series_id_seed,
        &[bump],
    ]];
    hook_transfer(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.token_mint.to_account_info(),
        &ctx.accounts.authority_token_account.to_account_info(),
        &ctx.accounts.series.to_account_info(),
        ctx.remaining_accounts,
        amount,
        ctx.accounts.token_mint.decimals,
        signer_seeds,
    )?;

    ctx.accounts.identity.own_refunded = ctx
        .accounts
        .identity
        .own_refunded
        .checked_add(release.from_ledger)
        .ok_or(RegistryError::Overflow)?;

    if surplus {
        emit!(VestingSurplusWithdrawn {
            series: s.key(),
            wallet: authority_key,
            amount,
        });
    } else {
        emit!(VestingUnvestedWithdrawn {
            series: s.key(),
            wallet: authority_key,
            amount,
        });
    }

    msg!("Vesting excess withdrawal — {} units returned", amount);
    Ok(())
}
