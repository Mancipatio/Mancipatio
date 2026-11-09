use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, Migration, MigrationCancelled, MigrationStatus};
use crate::util::ensure;

#[derive(Accounts)]
pub struct CancelMigration<'info> {
    pub authority: Signer<'info>,

    /// Admin gate.
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump = admin_record.bump)]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        mut,
        seeds = [MIGRATION_SEED, migration.share_class.as_ref(), &migration.migration_id.to_le_bytes()],
        bump = migration.bump,
    )]
    pub migration: Box<Account<'info, Migration>>,
}

/// Cancels a migration (any Admin): a `Draft` at any time — it holds no
/// deposits, and without this a Draft never opened before `closes_at` would
/// strand its funded units — or an `Open` one strictly before `closes_at` and
/// before any claim (a published root makes claims possible while Open; once
/// one is paid the swap is under way and only the close can end it). Else
/// `MigrationNotCancellable`. Afterwards every deposit is refunded
/// (`refund_migration_deposit`, permissionless) and the close returns the
/// vault to `return_to`. Never pause-gated: an unwind is an exit.
pub fn handle_cancel_migration(ctx: Context<CancelMigration>) -> Result<()> {
    let m = &mut ctx.accounts.migration;
    let open_early = m.status == MigrationStatus::Open
        && Clock::get()?.unix_timestamp < m.closes_at
        && m.units_claimed == 0;
    ensure(
        m.status == MigrationStatus::Draft || open_early,
        RegistryError::MigrationNotCancellable,
    )?;
    m.status = MigrationStatus::Cancelled;
    emit!(MigrationCancelled {
        migration: m.key(),
        admin: ctx.accounts.authority.key(),
        lots_deposited: m.lots_deposited,
    });
    Ok(())
}
