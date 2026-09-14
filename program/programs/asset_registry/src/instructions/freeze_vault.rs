use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{PayoutVault, PayoutVaultState};

#[derive(Accounts)]
pub struct FreezeVault<'info> {
    #[account(
        mut,
        seeds = [PAYOUT_SEED, vault.sale.as_ref()],
        bump = vault.bump,
        constraint = vault.state == PayoutVaultState::Active @ RegistryError::VaultNotActive,
    )]
    pub vault: Box<Account<'info, PayoutVault>>,
}

/// Freezes an `Active` payout vault whose founder has stopped reporting.
///
/// Rule: the founder owes one update per tranche period, and the `n`-th update
/// (0-indexed, `n == updates_posted`) becomes due at
/// `start_ts + n * MONTH` (`post_update` enforces the same period start). The
/// vault is freezable once the OLDEST unfulfilled update is at least
/// `MISSED_FREEZE_THRESHOLD` months overdue — i.e. `now` is in the
/// `MISSED_FREEZE_THRESHOLD`-th period counted from that due date — and there
/// is still principal in the vault (`released < total_amount`).
///
/// Overdue is measured from the oldest unfulfilled obligation, NOT as
/// `min(periods_elapsed, num_tranches) - updates_posted`: capping the elapsed
/// count at `num_tranches` made the threshold unreachable for schedules with
/// fewer than `MISSED_FREEZE_THRESHOLD` tranches and for the last
/// `MISSED_FREEZE_THRESHOLD - 1` tranches of ANY schedule — a founder who went
/// silent there could never be frozen, so `open_vault_vote` → `finalize` →
/// `claim_refund` was unreachable and the remaining principal was stranded for
/// founder and investors alike. For a founder who has posted nothing the two
/// formulas agree while `periods_elapsed <= num_tranches`, so the original
/// semantics (overdue 1 → refuse, overdue 3 → freeze) are unchanged.
///
/// The overdue count lives in `PayoutVault::overdue_periods` so that the
/// Extend branch of `finalize_vault_vote` shifts the schedule by the very same
/// amount; a smaller shift there would leave the vault re-freezable in the
/// next transaction and nullify the investors' Extend outcome.
pub fn handle_freeze_vault(ctx: Context<FreezeVault>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let v = &mut ctx.accounts.vault;

    // No unfulfilled obligation → nothing to be overdue on. A founder who has
    // posted every update but not yet pulled every tranche is not in breach;
    // a vault whose principal is fully released has nothing left to protect.
    require!(
        v.updates_posted < v.num_tranches as u32 && v.released < v.total_amount,
        RegistryError::UpdateRequired
    );

    // Shared with the Extend branch of `finalize_vault_vote`, which shifts the
    // schedule by exactly this many months — see `PayoutVault::overdue_periods`.
    let overdue = v.overdue_periods(now)?;
    require!(
        overdue >= MISSED_FREEZE_THRESHOLD as i64,
        RegistryError::UpdateRequired
    );

    v.state = PayoutVaultState::Frozen;
    msg!("Vault frozen — {} periods overdue", overdue);
    Ok(())
}
