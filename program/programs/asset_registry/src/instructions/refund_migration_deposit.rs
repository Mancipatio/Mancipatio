use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Migration, MigrationDeposit, MigrationDepositRefunded, MigrationStatus};
use crate::util::migration_seeds;

#[derive(Accounts)]
pub struct RefundMigrationDeposit<'info> {
    #[account(
        mut,
        seeds = [MIGRATION_SEED, migration.share_class.as_ref(), &migration.migration_id.to_le_bytes()],
        bump = migration.bump,
        has_one = old_mint @ RegistryError::Unauthorized,
        has_one = old_token_program @ RegistryError::Unauthorized,
        constraint = migration.status == MigrationStatus::Cancelled @ RegistryError::MigrationStatusInvalid,
    )]
    pub migration: Box<Account<'info, Migration>>,

    #[account(
        mut,
        seeds = [MIGRATION_DEPOSIT_SEED, migration.key().as_ref(), migration_deposit.holder.as_ref()],
        bump = migration_deposit.bump,
        constraint = !migration_deposit.claimed && !migration_deposit.refunded @ RegistryError::MigrationDepositSettled,
    )]
    pub migration_deposit: Box<Account<'info, MigrationDeposit>>,

    pub old_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [MIGRATION_ESCROW_SEED, migration.key().as_ref()], bump = migration.escrow_bump)]
    pub migration_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Any old-token account OWNED BY THE DEPOSITOR — the refund can only
    /// ever reach the wallet that deposited (a crank may create one for it).
    #[account(
        mut,
        constraint = holder_token_account.mint == old_mint.key() @ RegistryError::Unauthorized,
        constraint = holder_token_account.owner == migration_deposit.holder @ RegistryError::Unauthorized,
    )]
    pub holder_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub old_token_program: Interface<'info, TokenInterface>,
}

/// Refunds one deposit of a `Cancelled` migration: exactly the recorded
/// `lots * lot` base units leave the escrow (Migration PDA signs) for an
/// old-token account of the depositor, and the deposit is marked refunded.
/// Permissionless — no signer at all, so a lost or idle depositor never
/// blocks the close, which needs every deposit refunded. The payout is the
/// ledger, never the escrow balance: old tokens someone pushed into the
/// escrow with a raw transfer are not anyone's deposit and are burned at the
/// close. An exit: it never reads the pause bits, and it does not check the
/// blocklist either — the old token is not a Manci share class, and refusing
/// would leave the platform holding a holder's foreign tokens indefinitely.
pub fn handle_refund_migration_deposit(ctx: Context<RefundMigrationDeposit>) -> Result<()> {
    let m = &ctx.accounts.migration;
    let lots = ctx.accounts.migration_deposit.lots;
    let amount = lots.checked_mul(m.lot).ok_or(RegistryError::Overflow)?;

    let id = m.migration_id.to_le_bytes();
    let bump = [m.bump];
    let seeds = migration_seeds(m, &id, &bump);
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.old_token_program.key(),
            TransferChecked {
                from: ctx.accounts.migration_escrow.to_account_info(),
                mint: ctx.accounts.old_mint.to_account_info(),
                to: ctx.accounts.holder_token_account.to_account_info(),
                authority: m.to_account_info(),
            },
            &[&seeds],
        ),
        amount,
        ctx.accounts.old_mint.decimals,
    )?;

    let deposit = &mut ctx.accounts.migration_deposit;
    deposit.refunded = true;
    let m = &mut ctx.accounts.migration;
    m.lots_refunded = m
        .lots_refunded
        .checked_add(lots)
        .ok_or(RegistryError::Overflow)?;

    emit!(MigrationDepositRefunded {
        migration: m.key(),
        holder: deposit.holder,
        lots,
        amount,
    });
    Ok(())
}
