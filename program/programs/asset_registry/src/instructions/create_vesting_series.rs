use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    VestingDeliveryMode, VestingSeries, VestingSeriesCreated, VestingSeriesStatus,
    VestingTimingMode, VestingTranche,
};

#[derive(Accounts)]
#[instruction(series_id: u64)]
pub struct CreateVestingSeries<'info> {
    /// The client — series authority (approval / recovery / cancellation).
    /// Mancipatio holds NO key over the escrow: there is no admin gate here;
    /// the platform's review happens off-chain before the client is shown
    /// the creation form.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Supported SPL / Token-2022 mint; extension policy is enforced before creation.
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = 8 + VestingSeries::INIT_SPACE,
        seeds = [VESTING_SERIES_SEED, authority.key().as_ref(), &series_id.to_le_bytes()],
        bump
    )]
    pub series: Box<Account<'info, VestingSeries>>,

    /// Escrow holding the deposited tokens; authority is the series PDA.
    #[account(
        init,
        payer = authority,
        seeds = [VESTING_ESCROW_SEED, series.key().as_ref()],
        bump,
        space = crate::util::token_escrow_space(&token_mint.to_account_info(), &token_program.key())?,
        owner = token_program.key(),
    )]
    /// CHECK: allocated above, initialized with the bound mint and PDA owner in the handler.
    pub escrow: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    #[account(init, payer = authority, space = 8 + crate::state::EscrowIdentity::INIT_SPACE,
        seeds = [ESCROW_MARKER_SEED, series.key().as_ref()], bump)]
    pub identity: Box<Account<'info, crate::state::EscrowIdentity>>,
}

/// Creates a Draft with its schedule and settings FIXED at creation.
/// Allocations are committed by finalize_vesting_series before the first unlock:
/// schedule (tranches), timing mode (auto / approval), delivery mode
/// (push / claim), approval window, recovery on/off, cancellation on/off and
/// the pre-cliff percentage. Of these, only `cancellation_enabled` may ever
/// change later — and only ON → OFF, irrevocably (spec §11.1.10).
pub fn handle_create_vesting_series(
    ctx: Context<CreateVestingSeries>,
    series_id: u64,
    tranches: Vec<VestingTranche>,
    timing_mode: VestingTimingMode,
    delivery_mode: VestingDeliveryMode,
    approval_window_secs: i64,
    recovery_enabled: bool,
    cancellation_enabled: bool,
    pre_cliff_bps: u16,
) -> Result<()> {
    ctx.accounts.identity.refund_owner = ctx.accounts.authority.key();
    ctx.accounts.identity.own_deposited = 0;
    ctx.accounts.identity.own_refunded = 0;
    ctx.accounts.identity.bump = ctx.bumps.identity;

    crate::util::initialize_token_escrow(
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.token_mint.to_account_info(),
        &ctx.accounts.series.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
    )?;

    // Schedule: 1..=64 entries, strictly ascending, every amount positive.
    require!(
        !tranches.is_empty() && tranches.len() <= MAX_VESTING_TRANCHES,
        RegistryError::InvalidVestingSchedule
    );
    require!(
        tranches.iter().all(|t| t.amount > 0)
            && tranches.windows(2).all(|w| w[0].unlock_ts < w[1].unlock_ts),
        RegistryError::InvalidVestingSchedule
    );
    // Reject overflow at creation; every later entitlement uses this fixed sum.
    crate::util::vesting_schedule_total(&tranches)?;
    // Approval window: required (and bounded) exactly in Approval mode.
    match timing_mode {
        VestingTimingMode::Approval => require!(
            (MIN_APPROVAL_WINDOW_SECS..=MAX_APPROVAL_WINDOW_SECS).contains(&approval_window_secs),
            RegistryError::InvalidApprovalWindow
        ),
        VestingTimingMode::Auto => require!(
            approval_window_secs == 0,
            RegistryError::InvalidApprovalWindow
        ),
    }
    require!(
        tranches
            .iter()
            .all(|t| t.unlock_ts.checked_add(approval_window_secs).is_some()),
        RegistryError::InvalidVestingSchedule
    );
    require!(pre_cliff_bps <= 10_000, RegistryError::InvalidPreCliffBps);

    let s = &mut ctx.accounts.series;
    s.authority = ctx.accounts.authority.key();
    s.token_mint = ctx.accounts.token_mint.key();
    s.escrow = ctx.accounts.escrow.key();
    s.series_id = series_id;
    s.total_allocated = 0;
    s.deposited = 0;
    s.total_released = 0;
    s.timing_mode = timing_mode;
    s.delivery_mode = delivery_mode;
    s.status = VestingSeriesStatus::Draft;
    s.approval_window_secs = approval_window_secs;
    s.recovery_enabled = recovery_enabled;
    s.cancellation_enabled = cancellation_enabled;
    s.pre_cliff_bps = pre_cliff_bps;
    s.approved_mask = 0;
    s.cancelled_at = 0;
    s.final_cumulative = 0;
    s.positions_count = 0;
    s.created_at = Clock::get()?.unix_timestamp;
    s.version = VESTING_STATE_VERSION;
    s.bump = ctx.bumps.series;
    s.tranches = tranches;

    emit!(VestingSeriesCreated {
        series: s.key(),
        authority: s.authority,
        token_mint: s.token_mint,
        series_id,
        tranches_count: s.tranches.len() as u16,
    });

    msg!("Vesting series {} created", series_id);
    Ok(())
}
