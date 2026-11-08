use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Migration, MigrationFinalized, MigrationStatus};
use crate::util::ensure;

#[derive(Accounts)]
pub struct FinalizeMigration<'info> {
    #[account(
        mut,
        seeds = [MIGRATION_SEED, migration.share_class.as_ref(), &migration.migration_id.to_le_bytes()],
        bump = migration.bump,
        constraint = migration.status == MigrationStatus::Open @ RegistryError::MigrationStatusInvalid,
    )]
    pub migration: Box<Account<'info, Migration>>,
}

/// Ends the deposit window (`Open → Claimable`) once `now >= closes_at`
/// (else `MigrationWindowNotClosed`). Permissionless and signerless, like the
/// window it records: no key can hold depositors' claims back. Never
/// pause-gated.
pub fn handle_finalize_migration(ctx: Context<FinalizeMigration>) -> Result<()> {
    let m = &mut ctx.accounts.migration;
    ensure(
        Clock::get()?.unix_timestamp >= m.closes_at,
        RegistryError::MigrationWindowNotClosed,
    )?;
    m.status = MigrationStatus::Claimable;
    emit!(MigrationFinalized {
        migration: m.key(),
        lots_deposited: m.lots_deposited,
        units_committed: m.units_committed,
    });
    Ok(())
}
