use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, EscrowIdentity, Migration, MigrationClosed, MigrationStatus};
use crate::util::{
    close_empty_escrow, ensure, migration_seeds, migration_vault_transfer, split_escrow_release,
};

#[derive(Accounts)]
pub struct CloseMigration<'info> {
    pub authority: Signer<'info>,

    /// Admin gate.
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump = admin_record.bump)]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        mut,
        seeds = [MIGRATION_SEED, migration.share_class.as_ref(), &migration.migration_id.to_le_bytes()],
        bump = migration.bump,
        has_one = mint @ RegistryError::Unauthorized,
        has_one = old_mint @ RegistryError::Unauthorized,
        has_one = old_token_program @ RegistryError::Unauthorized,
    )]
    pub migration: Box<Account<'info, Migration>>,

    /// The creating Admin (`migration.admin`), who paid every rent: it gets
    /// the vault's, the escrow's and the identity's back.
    /// CHECK: bound by address to `migration.admin`; only credited.
    #[account(mut, address = migration.admin @ RegistryError::Unauthorized)]
    pub rent_to: UncheckedAccount<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [MIGRATION_VAULT_SEED, migration.key().as_ref()], bump = migration.vault_bump)]
    pub migration_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Any share-class account owned by `migration.return_to`.
    #[account(
        mut,
        constraint = return_to_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = return_to_account.owner == migration.return_to @ RegistryError::Unauthorized,
    )]
    pub return_to_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Mut: the escrow's old tokens are burned.
    #[account(mut)]
    pub old_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [MIGRATION_ESCROW_SEED, migration.key().as_ref()], bump = migration.escrow_bump)]
    pub migration_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Closed at the end of the instruction (rent → `rent_to`), after the
    /// return leg's hook CPI has read it.
    #[account(
        mut,
        close = rent_to,
        seeds = [ESCROW_MARKER_SEED, migration.key().as_ref()],
        bump = migration_identity.bump,
    )]
    pub migration_identity: Box<Account<'info, EscrowIdentity>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub old_token_program: Interface<'info, TokenInterface>,
    // remaining_accounts — the vault → return_to leg's hook tail (source
    // authority = the Migration PDA), needed when units remain:
    //   Open (3):     [BlockEntry(migration PDA), ExtraAccountMetaList,
    //                  transfer_hook program]
    //   KycGated (9): [BlockEntry(migration PDA), TransferHookConfig,
    //                  KycRegistry, asset_registry program, KycEntry(return_to),
    //                  EscrowMarker(return_to), EscrowIdentity(migration PDA),
    //                  ExtraAccountMetaList, transfer_hook program]
}

/// Ends a migration (any Admin) — after its claim deadline while `Open` or
/// `Claimable`, or once `Cancelled` with every deposit refunded (else
/// `MigrationNotClosable`):
///
/// 1. Every unit left in the vault goes to `return_to`'s account, by the
///    escrow-release rule (`util::split_escrow_release`): the units
///    `return_to` funded itself and nobody claimed (`own_deposited -
///    units_claimed - own_refunded`, claims counted against them first) go
///    back with no receiver check — the identity's refund route, which the
///    hook mirrors; anything above that (units another key funded, or raw
///    transfers into the vault) is a delivery and needs `return_to`'s KYC on
///    a KycGated class. A refused surplus fails the close with its KYC
///    error rather than stranding units in a closed migration: approve
///    `return_to` in the class's registry and close again.
/// 2. The escrow's old tokens — the deposits of every claimed or unclaimed
///    lot, plus anything pushed in raw — are burned (the Migration PDA owns
///    the escrow, so an owner burn always works for a supported old mint).
///    After a cancellation the refunds have emptied it of deposits already.
/// 3. The vault, the escrow and the identity close; their rent goes to the
///    creating Admin. The `Migration` stays, `Closed`, as the id-reuse guard
///    and the record of the campaign.
///
/// A depositor who never claimed by the close keeps a `MigrationDeposit`
/// with `claimed == false`; their units went back to `return_to` (the
/// published claim deadline). Never pause-gated: the close is an exit.
pub fn handle_close_migration<'info>(ctx: Context<'info, CloseMigration<'info>>) -> Result<()> {
    let m = &ctx.accounts.migration;
    let now = Clock::get()?.unix_timestamp;
    let past_deadline = matches!(m.status, MigrationStatus::Open | MigrationStatus::Claimable)
        && now >= m.claim_deadline;
    let unwound = m.status == MigrationStatus::Cancelled && m.lots_refunded == m.lots_deposited;
    ensure(
        past_deadline || unwound,
        RegistryError::MigrationNotClosable,
    )?;

    // 1. Units back to `return_to`.
    let balance = ctx.accounts.migration_vault.amount;
    let mut returned = 0;
    if balance > 0 {
        let identity = &ctx.accounts.migration_identity;
        let own = identity
            .own_deposited
            .saturating_sub(m.units_claimed)
            .saturating_sub(identity.own_refunded);
        let release =
            split_escrow_release(balance, own, ctx.remaining_accounts, &m.mint, &m.return_to);
        if let Some(refusal) = release.surplus_refusal {
            return Err(refusal);
        }
        migration_vault_transfer(
            m,
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.migration_vault.to_account_info(),
            &ctx.accounts.mint,
            &ctx.accounts.return_to_account.to_account_info(),
            ctx.remaining_accounts,
            release.payout,
        )?;
        returned = release.payout;
    }

    let id = m.migration_id.to_le_bytes();
    let bump = [m.bump];
    let seeds = migration_seeds(m, &id, &bump);
    let authority = m.to_account_info();
    let rent_to = ctx.accounts.rent_to.to_account_info();
    close_empty_escrow(
        &ctx.accounts.migration_vault.to_account_info(),
        Some(&ctx.accounts.token_program),
        &authority,
        &rent_to,
        &seeds,
    )?;

    // 2. Old tokens burned.
    let old_burned = ctx.accounts.migration_escrow.amount;
    if old_burned > 0 {
        token_interface::burn(
            CpiContext::new_with_signer(
                ctx.accounts.old_token_program.key(),
                Burn {
                    mint: ctx.accounts.old_mint.to_account_info(),
                    from: ctx.accounts.migration_escrow.to_account_info(),
                    authority: authority.clone(),
                },
                &[&seeds],
            ),
            old_burned,
        )?;
    }
    close_empty_escrow(
        &ctx.accounts.migration_escrow.to_account_info(),
        Some(&ctx.accounts.old_token_program),
        &authority,
        &rent_to,
        &seeds,
    )?;

    // 3. The identity closes on exit (`close = rent_to`).
    let m = &mut ctx.accounts.migration;
    m.status = MigrationStatus::Closed;
    emit!(MigrationClosed {
        migration: m.key(),
        admin: ctx.accounts.authority.key(),
        return_to: m.return_to,
        units_returned: returned,
        old_burned,
        rent_to: m.admin,
    });
    Ok(())
}
