use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{VestingDeposited, VestingSeries, VestingSeriesStatus};
use crate::util::hook_transfer;

#[derive(Accounts)]
pub struct DepositToVestingEscrow<'info> {
    /// The depositing wallet — signs the escrow-funding transfer. Usually the
    /// client; anyone may top a series up.
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [
            VESTING_SERIES_SEED,
            series.authority.as_ref(),
            &series.series_id.to_le_bytes(),
        ],
        bump = series.bump,
        has_one = token_mint @ RegistryError::Unauthorized,
        has_one = escrow @ RegistryError::Unauthorized,
        constraint = matches!(series.status, VestingSeriesStatus::Draft | VestingSeriesStatus::Active)
            @ RegistryError::VestingNotActive,
    )]
    pub series: Box<Account<'info, VestingSeries>>,

    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The depositor's token account — debited exactly `amount`.
    #[account(
        mut,
        constraint = depositor_token_account.mint == token_mint.key()
            @ RegistryError::Unauthorized,
        constraint = depositor_token_account.owner == depositor.key()
            @ RegistryError::Unauthorized,
    )]
    pub depositor_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts — transfer-hook accounts for the depositor → escrow
    // leg, in meta-list order. EscrowIdentity authorizes inbound routing;
    // it does not approve the eventual recipient or create a refund allowance
    // for units supplied by someone other than the series authority.
    #[account(mut, seeds = [ESCROW_MARKER_SEED, series.key().as_ref()], bump = identity.bump,
        constraint = identity.refund_owner == series.authority @ RegistryError::Unauthorized)]
    pub identity: Box<Account<'info, crate::state::EscrowIdentity>>,
}

/// Funds a series escrow — the ONLY instruction that credits
/// `series.deposited`. The client deposits in one or more transactions;
/// releases stay blocked until `deposited >= total_allocated`, and the
/// contract can never release more than was deposited (spec §11.1.7).
pub fn handle_deposit_to_vesting_escrow<'info>(
    ctx: Context<'info, DepositToVestingEscrow<'info>>,
    amount: u64,
) -> Result<()> {
    crate::util::require_supported_mint(
        &ctx.accounts.token_mint.to_account_info(),
        &ctx.accounts.token_program.key(),
        true,
    )?;

    require!(amount > 0, RegistryError::InvalidDepositAmount);

    // The immutable schedule is already known while allocations are Draft.
    // Never credit more cumulative funding than those promised units; raw token
    // transfers remain uncredited surplus recoverable by the separate sweep.
    let next_deposited = ctx
        .accounts
        .series
        .deposited
        .checked_add(amount)
        .ok_or(RegistryError::Overflow)?;
    let schedule_total = crate::util::vesting_schedule_total(&ctx.accounts.series.tranches)?;
    require!(
        next_deposited <= schedule_total,
        RegistryError::VestingFundingExceedsSchedule
    );

    hook_transfer(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.depositor_token_account.to_account_info(),
        &ctx.accounts.token_mint.to_account_info(),
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.depositor.to_account_info(),
        ctx.remaining_accounts,
        amount,
        ctx.accounts.token_mint.decimals,
        &[],
    )?;

    if ctx.accounts.depositor.key() == ctx.accounts.series.authority {
        ctx.accounts.identity.own_deposited = ctx
            .accounts
            .identity
            .own_deposited
            .checked_add(amount)
            .ok_or(RegistryError::Overflow)?;
    }

    let s = &mut ctx.accounts.series;
    s.deposited = next_deposited;

    emit!(VestingDeposited {
        series: s.key(),
        depositor: ctx.accounts.depositor.key(),
        amount,
        total_deposited: s.deposited,
    });

    msg!(
        "Vesting series {} — {} deposited ({} total)",
        s.series_id,
        amount,
        s.deposited
    );
    Ok(())
}
