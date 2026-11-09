use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{EscrowIdentity, Issuer, Migration, MigrationFunded, MigrationStatus, Platform};
use crate::util::{ensure, hook_transfer};

#[derive(Accounts)]
pub struct FundMigration<'info> {
    /// The share class's live issuer authority, moving its own units in.
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [MIGRATION_SEED, migration.share_class.as_ref(), &migration.migration_id.to_le_bytes()],
        bump = migration.bump,
        has_one = mint @ RegistryError::Unauthorized,
        constraint = migration.status == MigrationStatus::Draft @ RegistryError::MigrationStatusInvalid,
    )]
    pub migration: Box<Account<'info, Migration>>,

    /// The migration's issuer; its LIVE authority must sign (an authority
    /// rotated since the creation funds with the new key).
    #[account(
        address = migration.issuer @ RegistryError::Unauthorized,
        constraint = issuer.authority == authority.key() @ RegistryError::Unauthorized,
    )]
    pub issuer: Box<Account<'info, Issuer>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [MIGRATION_VAULT_SEED, migration.key().as_ref()], bump = migration.vault_bump)]
    pub migration_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The authority's own token account of the share class — debited
    /// exactly `units`.
    #[account(
        mut,
        constraint = source.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = source.owner == authority.key() @ RegistryError::Unauthorized,
    )]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Credits the refund ledger when the funder is `return_to`.
    #[account(mut, seeds = [ESCROW_MARKER_SEED, migration.key().as_ref()], bump = migration_identity.bump)]
    pub migration_identity: Box<Account<'info, EscrowIdentity>>,

    pub token_program: Interface<'info, TokenInterface>,

    /// Emergency-pause gate (read-only).
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_CUSTODY_ENTRY) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, Platform>>,
    // remaining_accounts — the source → vault leg's hook tail, in meta-list
    // order (source authority = the issuer authority):
    //   Open (3):     [BlockEntry(authority), ExtraAccountMetaList,
    //                  transfer_hook program]
    //   KycGated (9): [BlockEntry(authority), TransferHookConfig, KycRegistry,
    //                  asset_registry program, KycEntry(migration PDA),
    //                  EscrowIdentity(migration PDA), EscrowMarker(authority),
    //                  ExtraAccountMetaList, transfer_hook program]
    // The destination owner's identity exempts the leg from receiver KYC; the
    // hook still refuses a blocklisted authority (source blocklist).
}

/// Moves `units` share-class units from the issuer authority's own account
/// into the migration's vault (hook-aware) while the migration is `Draft`;
/// `units_funded` may reach but never pass `units_cap`, and the window opens
/// only once it equals it. Units the funder moves in while it is also
/// `return_to` are credited to the identity's refund ledger: at the close
/// they go back to it without a receiver-KYC check. Units anyone else
/// funded, or pushed in with a raw transfer, reach `return_to` only through
/// that check (`util::split_escrow_release`). Pause: `PAUSE_CUSTODY_ENTRY`.
pub fn handle_fund_migration<'info>(
    ctx: Context<'info, FundMigration<'info>>,
    units: u64,
) -> Result<()> {
    ensure(units > 0, RegistryError::InvalidDepositAmount)?;
    let funded = ctx
        .accounts
        .migration
        .units_funded
        .checked_add(units)
        .ok_or(RegistryError::Overflow)?;
    ensure(
        funded <= ctx.accounts.migration.units_cap,
        RegistryError::MigrationCapExceeded,
    )?;

    // The funder is a real transaction signer: empty signer seeds suffice.
    hook_transfer(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.source.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.migration_vault.to_account_info(),
        &ctx.accounts.authority.to_account_info(),
        ctx.remaining_accounts,
        units,
        ctx.accounts.mint.decimals,
        &[],
    )?;

    let funder = ctx.accounts.authority.key();
    if funder == ctx.accounts.migration.return_to {
        let identity = &mut ctx.accounts.migration_identity;
        identity.own_deposited = identity
            .own_deposited
            .checked_add(units)
            .ok_or(RegistryError::Overflow)?;
    }
    let m = &mut ctx.accounts.migration;
    m.units_funded = funded;

    emit!(MigrationFunded {
        migration: m.key(),
        funder,
        units,
        units_funded: funded,
    });
    Ok(())
}
