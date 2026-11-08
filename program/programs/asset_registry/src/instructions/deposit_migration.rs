use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Migration, MigrationDeposit, MigrationDeposited, MigrationStatus, Platform};
use crate::util::ensure;

#[derive(Accounts)]
pub struct DepositMigration<'info> {
    /// The depositing holder — signs the old-token transfer and pays the
    /// deposit record's rent on the first deposit.
    #[account(mut)]
    pub holder: Signer<'info>,

    #[account(
        mut,
        seeds = [MIGRATION_SEED, migration.share_class.as_ref(), &migration.migration_id.to_le_bytes()],
        bump = migration.bump,
        has_one = old_mint @ RegistryError::Unauthorized,
        has_one = old_token_program @ RegistryError::Unauthorized,
        constraint = migration.status == MigrationStatus::Open @ RegistryError::MigrationStatusInvalid,
    )]
    pub migration: Box<Account<'info, Migration>>,

    /// The holder's cumulative deposit (created on the first deposit).
    #[account(
        init_if_needed,
        payer = holder,
        space = 8 + MigrationDeposit::INIT_SPACE,
        seeds = [MIGRATION_DEPOSIT_SEED, migration.key().as_ref(), holder.key().as_ref()],
        bump
    )]
    pub migration_deposit: Box<Account<'info, MigrationDeposit>>,

    pub old_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [MIGRATION_ESCROW_SEED, migration.key().as_ref()], bump = migration.escrow_bump)]
    pub migration_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The holder's own old-token account — debited exactly `lots * lot`.
    #[account(
        mut,
        constraint = holder_token_account.mint == old_mint.key() @ RegistryError::Unauthorized,
        constraint = holder_token_account.owner == holder.key() @ RegistryError::Unauthorized,
    )]
    pub holder_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub old_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    /// Emergency-pause gate (read-only): a deposit is an entry into custody.
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_CUSTODY_ENTRY) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, Platform>>,

    /// prog-novac-4: the depositing holder is not blocked. The old token has no
    /// Manci hook, so nothing else would stop a blocklisted wallet from
    /// entering the migration.
    /// CHECK: the hook's `["blocked", wallet]` PDA (address pinned by the
    /// seeds); it must be unset — system-owned, no data (`util::is_unset`,
    /// fail-closed: a live BlockEntry is refused).
    #[account(
        seeds = [HOOK_BLOCK_ENTRY_SEED, holder.key().as_ref()],
        seeds::program = TRANSFER_HOOK_PROGRAM,
        bump,
        constraint = crate::util::is_unset(&holder_block_entry) @ RegistryError::PartyBlocklisted,
    )]
    pub holder_block_entry: UncheckedAccount<'info>,
}

/// Deposits `lots` whole lots of the old token (`lots * lot` base units,
/// `transfer_checked`) into the escrow and records them on the holder's
/// `MigrationDeposit`: the holder will claim exactly `lots` units once the
/// window closes, or get the same base units back if the migration is
/// cancelled. A deposit is a lot count, so it is a multiple of the lot by
/// construction (at least one: `InvalidDepositAmount`); it is accepted only
/// while `Open` and `opens_at <= now < closes_at` (`MigrationOutsideWindow`),
/// and only while the committed units stay within the funded ones
/// (`MigrationAllocationExceeded`) — every accepted lot is backed by a unit
/// already in the vault. The old mint is re-checked against the migration's
/// old-mint policy here, the moment holders commit funds. No KYC: holding
/// needs none; a KycGated class checks the receiver at the claim. Pause:
/// `PAUSE_CUSTODY_ENTRY`; a blocklisted holder is `PartyBlocklisted`.
pub fn handle_deposit_migration(ctx: Context<DepositMigration>, lots: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let m = &ctx.accounts.migration;
    ensure(
        now >= m.opens_at && now < m.closes_at,
        RegistryError::MigrationOutsideWindow,
    )?;
    ensure(lots > 0, RegistryError::InvalidDepositAmount)?;
    crate::util::require_supported_old_mint(
        &ctx.accounts.old_mint.to_account_info(),
        &ctx.accounts.old_token_program.key(),
    )?;
    let amount = lots.checked_mul(m.lot).ok_or(RegistryError::Overflow)?;
    let committed = m
        .units_committed
        .checked_add(lots)
        .ok_or(RegistryError::Overflow)?;
    ensure(
        committed <= m.units_funded,
        RegistryError::MigrationAllocationExceeded,
    )?;

    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.old_token_program.key(),
            TransferChecked {
                from: ctx.accounts.holder_token_account.to_account_info(),
                mint: ctx.accounts.old_mint.to_account_info(),
                to: ctx.accounts.migration_escrow.to_account_info(),
                authority: ctx.accounts.holder.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.old_mint.decimals,
    )?;

    let deposit = &mut ctx.accounts.migration_deposit;
    deposit.migration = ctx.accounts.migration.key();
    deposit.holder = ctx.accounts.holder.key();
    deposit.lots = deposit
        .lots
        .checked_add(lots)
        .ok_or(RegistryError::Overflow)?;
    deposit.bump = ctx.bumps.migration_deposit;

    let m = &mut ctx.accounts.migration;
    m.units_committed = committed;
    m.lots_deposited = m
        .lots_deposited
        .checked_add(lots)
        .ok_or(RegistryError::Overflow)?;

    emit!(MigrationDeposited {
        migration: m.key(),
        holder: deposit.holder,
        lots,
        amount,
        holder_lots: deposit.lots,
        units_committed: committed,
    });
    Ok(())
}
