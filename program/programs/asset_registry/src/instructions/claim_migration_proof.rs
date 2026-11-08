use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Migration, MigrationProofClaim, MigrationProofClaimed, MigrationStatus};
use crate::util::{deliver_migration_units, ensure, snapshot_leaf, verify_merkle_proof};

#[derive(Accounts)]
pub struct ClaimMigrationProof<'info> {
    /// The entitled key — the leaf's account; pays the claim record.
    #[account(mut)]
    pub claimer: Signer<'info>,

    #[account(
        mut,
        seeds = [MIGRATION_SEED, migration.share_class.as_ref(), &migration.migration_id.to_le_bytes()],
        bump = migration.bump,
        has_one = mint @ RegistryError::Unauthorized,
        constraint = matches!(migration.status, MigrationStatus::Open | MigrationStatus::Claimable)
            @ RegistryError::MigrationStatusInvalid,
    )]
    pub migration: Box<Account<'info, Migration>>,

    /// One claim per (migration, claimer) — `init` fails on a second claim.
    #[account(
        init,
        payer = claimer,
        space = 8 + MigrationProofClaim::INIT_SPACE,
        seeds = [MIGRATION_CLAIM_SEED, migration.key().as_ref(), claimer.key().as_ref()],
        bump
    )]
    pub proof_claim: Box<Account<'info, MigrationProofClaim>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [MIGRATION_VAULT_SEED, migration.key().as_ref()], bump = migration.vault_bump)]
    pub migration_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The claimer's own share-class account (mirrors `claim_milestone`: a
    /// root naming one key can never route units to another's account).
    #[account(
        mut,
        constraint = claimer_share_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = claimer_share_account.owner == claimer.key() @ RegistryError::Unauthorized,
    )]
    pub claimer_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    // remaining_accounts — the vault → claimer leg's hook tail, as for
    // `claim_migration` (KycEntry / EscrowMarker of the claimer).
}

/// Claims an off-chain lock's units against the published root (`Open` or
/// `Claimable`): the proof must place `(claimer, units)` in the root
/// (`InvalidMerkleProof`), the root's running total may not pass
/// `merkle_total` (`MigrationRootExceeded` — a root whose leaves sum above
/// its declared total can never eat into deposit-backed units), and the
/// units leave the vault for the claimer's own account after the receiver-KYC
/// check of a KycGated class (`util::deliver_migration_units`). One claim per
/// claimer (the `MigrationProofClaim` record). An exit: no pause bit.
pub fn handle_claim_migration_proof<'info>(
    ctx: Context<'info, ClaimMigrationProof<'info>>,
    units: u64,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    let claimer = ctx.accounts.claimer.key();
    let root = ctx
        .accounts
        .migration
        .merkle_root
        .ok_or(error!(RegistryError::MigrationRootMissing))?;
    ensure(units > 0, RegistryError::NothingToClaim)?;
    ensure(
        verify_merkle_proof(root, snapshot_leaf(&claimer, units), &proof),
        RegistryError::InvalidMerkleProof,
    )?;
    let merkle_claimed = ctx
        .accounts
        .migration
        .merkle_claimed
        .checked_add(units)
        .ok_or(RegistryError::Overflow)?;
    ensure(
        merkle_claimed <= ctx.accounts.migration.merkle_total,
        RegistryError::MigrationRootExceeded,
    )?;

    deliver_migration_units(
        &mut ctx.accounts.migration,
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.migration_vault.to_account_info(),
        &ctx.accounts.mint,
        &ctx.accounts.claimer_share_account.to_account_info(),
        &claimer,
        ctx.remaining_accounts,
        units,
    )?;
    let m = &mut ctx.accounts.migration;
    m.merkle_claimed = merkle_claimed;

    let claim = &mut ctx.accounts.proof_claim;
    claim.migration = m.key();
    claim.claimer = claimer;
    claim.units = units;
    claim.bump = ctx.bumps.proof_claim;

    emit!(MigrationProofClaimed {
        migration: m.key(),
        claimer,
        units,
        merkle_claimed,
        units_claimed: m.units_claimed,
    });
    Ok(())
}
