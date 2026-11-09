use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, Migration, MigrationOpened, MigrationStatus, Platform};
use crate::util::ensure;

#[derive(Accounts)]
pub struct OpenMigration<'info> {
    pub authority: Signer<'info>,

    /// Admin gate.
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump = admin_record.bump)]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        mut,
        seeds = [MIGRATION_SEED, migration.share_class.as_ref(), &migration.migration_id.to_le_bytes()],
        bump = migration.bump,
        constraint = migration.status == MigrationStatus::Draft @ RegistryError::MigrationStatusInvalid,
    )]
    pub migration: Box<Account<'info, Migration>>,

    /// Emergency-pause gate (read-only).
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_CUSTODY_ENTRY) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, Platform>>,
}

/// Opens a fully funded migration (`Draft → Open`): every unit the window can
/// ever commit is already in the vault (`units_funded == units_cap`, else
/// `MigrationUnderfunded`), so no deposit ever depends on a later transfer by
/// the issuer. Deposits are then accepted from `opens_at` until `closes_at`;
/// opening at or after `closes_at` is refused (`MigrationOutsideWindow`) —
/// cancel such a Draft instead. Any Admin. Pause: `PAUSE_CUSTODY_ENTRY`.
pub fn handle_open_migration(ctx: Context<OpenMigration>) -> Result<()> {
    let m = &mut ctx.accounts.migration;
    ensure(
        m.units_funded == m.units_cap,
        RegistryError::MigrationUnderfunded,
    )?;
    ensure(
        Clock::get()?.unix_timestamp < m.closes_at,
        RegistryError::MigrationOutsideWindow,
    )?;
    m.status = MigrationStatus::Open;
    emit!(MigrationOpened {
        migration: m.key(),
        admin: ctx.accounts.authority.key(),
    });
    Ok(())
}
