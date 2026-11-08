use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, Issuer, Migration, MigrationRootPublished, MigrationStatus, Platform};
use crate::util::ensure;

#[derive(Accounts)]
pub struct PublishMigrationRoot<'info> {
    pub authority: Signer<'info>,

    /// Admin gate.
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump = admin_record.bump)]
    pub admin_record: Box<Account<'info, Admin>>,

    /// The migration issuer's live authority co-signs: the root allocates the
    /// issuer's funded units, which would otherwise go back to `return_to`.
    pub issuer_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [MIGRATION_SEED, migration.share_class.as_ref(), &migration.migration_id.to_le_bytes()],
        bump = migration.bump,
        constraint = matches!(migration.status, MigrationStatus::Open | MigrationStatus::Claimable)
            @ RegistryError::MigrationStatusInvalid,
    )]
    pub migration: Box<Account<'info, Migration>>,

    #[account(
        address = migration.issuer @ RegistryError::Unauthorized,
        constraint = issuer.authority == issuer_authority.key() @ RegistryError::Unauthorized,
    )]
    pub issuer: Box<Account<'info, Issuer>>,

    /// Emergency-pause gate (read-only): new entitlements are an entry.
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_CUSTODY_ENTRY) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, Platform>>,
}

/// Publishes, once, the Merkle root of the off-chain locks (a future EVM lock
/// contract): leaves `util::snapshot_leaf(claimer, units)`, sorted-pair
/// SHA-256 (`util::verify_merkle_proof`), claimable with
/// `claim_migration_proof` up to `total_units` in all. `Open` or `Claimable`,
/// before `claim_deadline` (`MigrationClaimDeadlinePassed`); a second root is
/// `MigrationRootAlreadyPublished`; a zero root or total is
/// `MigrationTermsInvalid`. The total is committed like deposits: deposits
/// plus the root never exceed the funded units (`MigrationAllocationExceeded`),
/// so the root cannot spend a depositor's unit and no deposit can spend a
/// root claimer's.
///
/// Trust: the chain cannot see the other chain, so the root is an attestation
/// — which is why it takes both keys that `create_migration` took: an Admin
/// AND the issuer's live authority. An Admin alone cannot redirect the
/// issuer's unallocated units. Pause: `PAUSE_CUSTODY_ENTRY`.
pub fn handle_publish_migration_root(
    ctx: Context<PublishMigrationRoot>,
    root: [u8; 32],
    total_units: u64,
) -> Result<()> {
    let m = &mut ctx.accounts.migration;
    ensure(
        Clock::get()?.unix_timestamp < m.claim_deadline,
        RegistryError::MigrationClaimDeadlinePassed,
    )?;
    ensure(
        m.merkle_root.is_none(),
        RegistryError::MigrationRootAlreadyPublished,
    )?;
    ensure(
        root != [0u8; 32] && total_units > 0,
        RegistryError::MigrationTermsInvalid,
    )?;
    let committed = m
        .units_committed
        .checked_add(total_units)
        .ok_or(RegistryError::Overflow)?;
    ensure(
        committed <= m.units_funded,
        RegistryError::MigrationAllocationExceeded,
    )?;
    m.merkle_root = Some(root);
    m.merkle_total = total_units;
    m.units_committed = committed;

    emit!(MigrationRootPublished {
        migration: m.key(),
        admin: ctx.accounts.authority.key(),
        issuer_authority: ctx.accounts.issuer_authority.key(),
        root,
        total_units,
        units_committed: committed,
    });
    Ok(())
}
