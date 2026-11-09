use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Migration, MigrationClaimed, MigrationDeposit, MigrationStatus};
use crate::util::deliver_migration_units;

#[derive(Accounts)]
pub struct ClaimMigration<'info> {
    /// The depositor.
    pub holder: Signer<'info>,

    #[account(
        mut,
        seeds = [MIGRATION_SEED, migration.share_class.as_ref(), &migration.migration_id.to_le_bytes()],
        bump = migration.bump,
        has_one = mint @ RegistryError::Unauthorized,
        constraint = migration.status == MigrationStatus::Claimable @ RegistryError::MigrationStatusInvalid,
    )]
    pub migration: Box<Account<'info, Migration>>,

    #[account(
        mut,
        seeds = [MIGRATION_DEPOSIT_SEED, migration.key().as_ref(), holder.key().as_ref()],
        bump = migration_deposit.bump,
        constraint = !migration_deposit.claimed && !migration_deposit.refunded @ RegistryError::MigrationDepositSettled,
    )]
    pub migration_deposit: Box<Account<'info, MigrationDeposit>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [MIGRATION_VAULT_SEED, migration.key().as_ref()], bump = migration.vault_bump)]
    pub migration_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The holder's own share-class account — bound to the signer, whose key
    /// is the one the deposit and (KycGated) the KYC check refer to.
    #[account(
        mut,
        constraint = holder_share_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = holder_share_account.owner == holder.key() @ RegistryError::Unauthorized,
    )]
    pub holder_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts — the vault → holder leg's hook tail (source
    // authority = the Migration PDA):
    //   Open (3):     [BlockEntry(migration PDA), ExtraAccountMetaList,
    //                  transfer_hook program]
    //   KycGated (9): [BlockEntry(migration PDA), TransferHookConfig,
    //                  KycRegistry, asset_registry program, KycEntry(holder),
    //                  EscrowMarker(holder), EscrowIdentity(migration PDA),
    //                  ExtraAccountMetaList, transfer_hook program]
}

/// Delivers a depositor's units (`Claimable`): exactly `deposit.lots` units
/// leave the vault for the holder's own account, hook-aware, after the
/// receiver-KYC check of a KycGated class (`util::deliver_migration_units`,
/// as `claim_milestone`), and the deposit is marked claimed. An exit: no
/// pause bit. A holder blocked after depositing is not refused here — the
/// units land frozen in the blocked wallet (the hook refuses every transfer
/// out of it except the two-key quarantine clawback) instead of being
/// forfeited to `return_to` at the claim deadline. Claims stay possible
/// until the close, also after the deadline.
pub fn handle_claim_migration<'info>(ctx: Context<'info, ClaimMigration<'info>>) -> Result<()> {
    let units = ctx.accounts.migration_deposit.lots;
    deliver_migration_units(
        &mut ctx.accounts.migration,
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.migration_vault.to_account_info(),
        &ctx.accounts.mint,
        &ctx.accounts.holder_share_account.to_account_info(),
        &ctx.accounts.holder.key(),
        ctx.remaining_accounts,
        units,
    )?;
    ctx.accounts.migration_deposit.claimed = true;

    let m = &ctx.accounts.migration;
    emit!(MigrationClaimed {
        migration: m.key(),
        holder: ctx.accounts.holder.key(),
        units,
        units_claimed: m.units_claimed,
    });
    Ok(())
}
