use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{VestingDeliveryMode, VestingPosition, VestingReleased, VestingSeries};
use crate::util::{hook_transfer, vesting_deliverable_cumulative, vesting_position_entitlement};

/// Shared release logic for `claim_vested` (recipient pulls, Claim-mode
/// series) and `push_vested` (anyone triggers, Push-mode series). Computes
/// the position's deliverable entitlement at `now`, moves the unreleased
/// delta escrow → recipient wallet, and updates the ledgers. The transfer is
/// capped at the escrow's actual balance so an under-funded cancelled series
/// pays out pro-rata-in-time instead of hard-failing.
pub fn release_vested<'info>(
    series: &mut Account<'info, VestingSeries>,
    position: &mut Account<'info, VestingPosition>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    token_mint: &InterfaceAccount<'info, Mint>,
    recipient_token_account: &InterfaceAccount<'info, TokenAccount>,
    token_program: &AccountInfo<'info>,
    hook_accounts: &[AccountInfo<'info>],
) -> Result<u64> {
    let now = Clock::get()?.unix_timestamp;

    require!(
        series.status != crate::state::VestingSeriesStatus::Draft,
        RegistryError::VestingNotActive
    );
    let schedule_total = crate::util::vesting_schedule_total(&series.tranches)?;
    // Identical locked denominator before and after cancellation. An
    // inconsistent series is rejected, never split by guesswork.
    require!(
        schedule_total == series.total_allocated && schedule_total > 0,
        RegistryError::VestingAllocationMismatch
    );
    let deliverable_cum = vesting_deliverable_cumulative(series, now);

    let entitlement =
        vesting_position_entitlement(position.allocation, deliverable_cum, series.total_allocated);
    let mut amount = entitlement.saturating_sub(position.released);
    amount = amount.min(escrow.amount);
    require!(amount > 0, RegistryError::VestingNothingToClaim);

    // Escrow identity permits only the client's refund route. Even a position
    // whose recipient is that client remains a screened delivery, not a refund.
    crate::util::require_receiver_kyc(
        hook_accounts,
        &token_mint.key(),
        &recipient_token_account.owner,
    )?;

    let authority_key = series.authority;
    let series_id_seed = series.series_id.to_le_bytes();
    let bump = series.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VESTING_SERIES_SEED,
        authority_key.as_ref(),
        &series_id_seed,
        &[bump],
    ]];
    hook_transfer(
        token_program,
        &escrow.to_account_info(),
        &token_mint.to_account_info(),
        &recipient_token_account.to_account_info(),
        &series.to_account_info(),
        hook_accounts,
        amount,
        token_mint.decimals,
        signer_seeds,
    )?;

    position.released = position
        .released
        .checked_add(amount)
        .ok_or(RegistryError::Overflow)?;
    series.total_released = series
        .total_released
        .checked_add(amount)
        .ok_or(RegistryError::Overflow)?;

    emit!(VestingReleased {
        series: series.key(),
        position: position.key(),
        wallet: position.wallet,
        amount,
        total_released: series.total_released,
    });

    Ok(amount)
}

#[derive(Accounts)]
#[instruction(position_index: u32)]
pub struct ClaimVested<'info> {
    /// The recipient — must be the wallet currently recorded on the position.
    pub recipient: Signer<'info>,

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
        constraint = series.delivery_mode == VestingDeliveryMode::Claim
            @ RegistryError::VestingWrongDeliveryMode,
    )]
    pub series: Box<Account<'info, VestingSeries>>,

    #[account(
        mut,
        seeds = [
            VESTING_POSITION_SEED,
            series.key().as_ref(),
            &position_index.to_le_bytes(),
        ],
        bump = position.bump,
        has_one = series @ RegistryError::Unauthorized,
        constraint = position.wallet == recipient.key()
            @ RegistryError::Unauthorized,
    )]
    pub position: Box<Account<'info, VestingPosition>>,

    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The recipient's token account — must be owned by the position's wallet.
    #[account(
        mut,
        constraint = recipient_token_account.mint == token_mint.key()
            @ RegistryError::Unauthorized,
        constraint = recipient_token_account.owner == position.wallet
            @ RegistryError::Unauthorized,
    )]
    pub recipient_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts — transfer-hook accounts for the escrow → recipient
    // leg. EscrowIdentity separates inbound routing from outbound delivery;
    // release_vested screens every recipient, including the series authority.
}

/// Claim-mode release: the recipient pulls everything vested and deliverable.
/// Unclaimed vested tokens stay reserved for the recipient forever — there is
/// no expiry and no path back to the client except the unvested remainder on
/// cancellation (spec §11.1.13).
pub fn handle_claim_vested<'info>(
    ctx: Context<'info, ClaimVested<'info>>,
    _position_index: u32,
) -> Result<()> {
    let amount = release_vested(
        &mut ctx.accounts.series,
        &mut ctx.accounts.position,
        &ctx.accounts.escrow,
        &ctx.accounts.token_mint,
        &ctx.accounts.recipient_token_account,
        &ctx.accounts.token_program.to_account_info(),
        ctx.remaining_accounts,
    )?;
    msg!("Vesting claim — {} units released", amount);
    Ok(())
}

#[derive(Accounts)]
#[instruction(position_index: u32)]
pub struct PushVested<'info> {
    /// Anyone — pays for the delivery. Permissionless by design: in Push mode
    /// the contract releases on schedule without depending on the client, the
    /// recipient, or Mancipatio (spec §11.1.8, §11.1.11).
    #[account(mut)]
    pub payer: Signer<'info>,

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
        constraint = series.delivery_mode == VestingDeliveryMode::Push
            @ RegistryError::VestingWrongDeliveryMode,
    )]
    pub series: Box<Account<'info, VestingSeries>>,

    #[account(
        mut,
        seeds = [
            VESTING_POSITION_SEED,
            series.key().as_ref(),
            &position_index.to_le_bytes(),
        ],
        bump = position.bump,
        has_one = series @ RegistryError::Unauthorized,
    )]
    pub position: Box<Account<'info, VestingPosition>>,

    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The recipient's token account — owned by the position's CURRENT wallet
    /// (recovery re-points delivery).
    #[account(
        mut,
        constraint = recipient_token_account.mint == token_mint.key()
            @ RegistryError::Unauthorized,
        constraint = recipient_token_account.owner == position.wallet
            @ RegistryError::Unauthorized,
    )]
    pub recipient_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts — transfer-hook accounts for the escrow → recipient
    // leg (same receiver-KYC semantics as `claim_vested`).
}

/// Push-mode release: delivers the position's vested-and-deliverable amount
/// to its recorded wallet. Callable by anyone at any time.
pub fn handle_push_vested<'info>(
    ctx: Context<'info, PushVested<'info>>,
    _position_index: u32,
) -> Result<()> {
    let amount = release_vested(
        &mut ctx.accounts.series,
        &mut ctx.accounts.position,
        &ctx.accounts.escrow,
        &ctx.accounts.token_mint,
        &ctx.accounts.recipient_token_account,
        &ctx.accounts.token_program.to_account_info(),
        ctx.remaining_accounts,
    )?;
    msg!("Vesting push — {} units delivered", amount);
    Ok(())
}
