//! Issuer authority rotation (2C-2): a regular propose / accept / cancel, a
//! super-admin recovery of a LOST key behind a 7-day timelock, and two
//! permissionless syncs that copy the live `issuer.authority` into the
//! `Sale.authority` / `PayoutVault.founder` snapshots.
//!
//! The `Issuer` layout is frozen (117 B): these instructions write only
//! `Issuer.authority`; all new state lives in separate PDAs.
//!
//! * Regular rotation reuses `AuthorityTransfer` at
//!   `["authority_transfer", issuer]` (the 2C-1 pattern). Only the current
//!   authority proposes and cancels; only the proposed key accepts. The seed is
//!   the Issuer PDA, so a platform, custody or KYC-registry transfer can never
//!   stand in for it.
//! * Recovery lives in `IssuerRecovery` at `["issuer_recovery", issuer]`: the
//!   super admin (`Platform.admin`) proposes, it becomes executable at `eta`
//!   (7 days) and expires 14 days later; the CURRENT issuer authority or the
//!   super admin may cancel; only the proposed key executes. It is bound to the
//!   authority and super admin it was proposed against: any change of either
//!   makes it stale (execute fails with `InvalidIssuerRecovery`, cancel still
//!   works).
//! * Every authority change closes the old authority's `IssuerPermissions`
//!   grant (the PDA is seeded by the authority), so a grant never comes back to
//!   life on an A -> B -> A round trip. A regular accept carries the
//!   capabilities over to the new key (the old key already had them); a
//!   recovery carries nothing, the super admin re-grants after review.
//!
//! Threat model: the recovery protects a LOST key. A COMPROMISED issuer key can
//! cancel any recovery; that incident path is `PAUSE_ISSUER_PROCEEDS` plus
//! off-chain action.
//!
//! Until `sync_sale_authority` / `sync_payout_founder` run, the OLD key keeps
//! `close_sale`, `open_payout_vault`, `post_update` and `claim_founder_yield`,
//! and the permissionless `release_payout` still pays the old key's account.
//! The front bundles accept / execute with the syncs in one transaction; the
//! runbook pauses issuer proceeds before executing a recovery for an issuer
//! with Startup vaults.
//!
//! None of these reads the pause flags: rotation and recovery are security
//! exits, and a sync moves no funds (the payout exits stay gated).

use anchor_lang::prelude::*;

use super::rotate_authority::{validate_new_authority, write_proposal};
use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    Asset, AuthorityTransfer, Issuer, IssuerAuthorityChangeKind, IssuerAuthorityChanged,
    IssuerAuthorityProposalCancelled, IssuerAuthorityProposed, IssuerPermissions, IssuerRecovery,
    IssuerRecoveryCancelled, IssuerRecoveryProposed, PayoutFounderSynced, PayoutVault, Platform,
    Sale, SaleAuthoritySynced, ShareClass,
};
use crate::util::{read_parent_key, take_old_grant};

// ── (a) Regular rotation ─────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ProposeIssuerAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()], bump = issuer.bump,
        has_one = authority @ RegistryError::Unauthorized)]
    pub issuer: Box<Account<'info, Issuer>>,
    #[account(init_if_needed, payer = authority, space = 8 + AuthorityTransfer::INIT_SPACE,
        seeds = [AUTHORITY_TRANSFER_SEED, issuer.key().as_ref()], bump)]
    pub transfer: Account<'info, AuthorityTransfer>,
    pub system_program: Program<'info, System>,
}

/// The current issuer authority stages a new authority. A re-proposal
/// overwrites the pending one. Allowed in every KYB status.
pub fn handle_propose_issuer_authority(
    ctx: Context<ProposeIssuerAuthority>,
    new_authority: Pubkey,
) -> Result<()> {
    let issuer = ctx.accounts.issuer.key();
    let current = ctx.accounts.issuer.authority;
    validate_new_authority(current, new_authority)?;
    write_proposal(
        &mut ctx.accounts.transfer,
        issuer,
        current,
        new_authority,
        ctx.accounts.authority.key(),
        ctx.bumps.transfer,
    );
    emit!(IssuerAuthorityProposed {
        issuer,
        current_authority: current,
        new_authority,
    });
    msg!("Issuer {} authority proposed — {}", issuer, new_authority);
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptIssuerAuthority<'info> {
    #[account(mut)]
    pub new_authority: Signer<'info>,
    #[account(mut, seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()], bump = issuer.bump)]
    pub issuer: Box<Account<'info, Issuer>>,
    #[account(mut, close = new_authority,
        seeds = [AUTHORITY_TRANSFER_SEED, issuer.key().as_ref()], bump = transfer.bump,
        constraint = transfer.target == issuer.key()
            && transfer.current_authority == issuer.authority
            && transfer.proposed_by == issuer.authority
            && transfer.new_authority == new_authority.key() @ RegistryError::InvalidAuthorityTransfer)]
    pub transfer: Account<'info, AuthorityTransfer>,
    /// The outgoing authority's grant, closed here when present (rent to the
    /// acceptor); its capabilities move to `new_permissions`.
    /// CHECK: address pinned by seeds; owner, discriminator and contents are
    /// validated by `util::take_old_grant`. It may not exist.
    #[account(mut, seeds = [ISSUER_PERMISSIONS_SEED, issuer.key().as_ref(), issuer.authority.as_ref()], bump)]
    pub old_permissions: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = new_authority, space = 8 + IssuerPermissions::INIT_SPACE,
        seeds = [ISSUER_PERMISSIONS_SEED, issuer.key().as_ref(), new_authority.key().as_ref()], bump)]
    pub new_permissions: Account<'info, IssuerPermissions>,
    pub system_program: Program<'info, System>,
}

/// The proposed authority accepts. Only `Issuer.authority` changes (legal ID,
/// KYB, asset count and every PDA seeded by the Issuer are untouched). The old
/// grant is closed and its capabilities carried over (none: a zero record).
pub fn handle_accept_issuer_authority(ctx: Context<AcceptIssuerAuthority>) -> Result<()> {
    let issuer = ctx.accounts.issuer.key();
    let old_authority = ctx.accounts.issuer.authority;
    let new_authority = ctx.accounts.new_authority.key();
    let old_grant = take_old_grant(
        &ctx.accounts.old_permissions.to_account_info(),
        &issuer,
        &old_authority,
        &ctx.accounts.new_authority.to_account_info(),
    )?;
    let (capabilities, updated_by) = old_grant.unwrap_or((0, Pubkey::default()));
    let record = &mut ctx.accounts.new_permissions;
    record.issuer = issuer;
    record.authority = new_authority;
    record.capabilities = capabilities;
    record.updated_by = updated_by;
    record.version = STATE_VERSION;
    record.bump = ctx.bumps.new_permissions;
    ctx.accounts.issuer.authority = new_authority;
    emit!(IssuerAuthorityChanged {
        issuer,
        old_authority,
        new_authority,
        kind: IssuerAuthorityChangeKind::Rotation,
        capabilities_carried: capabilities,
        old_grant_closed: old_grant.is_some(),
    });
    msg!(
        "Issuer {} authority rotated — {} -> {}",
        issuer,
        old_authority,
        new_authority
    );
    Ok(())
}

#[derive(Accounts)]
pub struct CancelIssuerAuthorityTransfer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()], bump = issuer.bump,
        has_one = authority @ RegistryError::Unauthorized)]
    pub issuer: Box<Account<'info, Issuer>>,
    #[account(mut, close = authority,
        seeds = [AUTHORITY_TRANSFER_SEED, issuer.key().as_ref()], bump = transfer.bump,
        constraint = transfer.target == issuer.key() @ RegistryError::InvalidAuthorityTransfer)]
    pub transfer: Account<'info, AuthorityTransfer>,
}

/// The current issuer authority withdraws a pending proposal (including one a
/// recovery made stale); the rent returns to it.
pub fn handle_cancel_issuer_authority_transfer(
    ctx: Context<CancelIssuerAuthorityTransfer>,
) -> Result<()> {
    let issuer = ctx.accounts.issuer.key();
    emit!(IssuerAuthorityProposalCancelled {
        issuer,
        authority: ctx.accounts.authority.key(),
        cancelled_new_authority: ctx.accounts.transfer.new_authority,
    });
    msg!("Issuer {} authority proposal cancelled", issuer);
    Ok(())
}

// ── (b) Timelocked recovery ──────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ProposeIssuerRecovery<'info> {
    #[account(mut)]
    pub super_admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump,
        constraint = platform.admin == super_admin.key() @ RegistryError::Unauthorized)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()], bump = issuer.bump)]
    pub issuer: Box<Account<'info, Issuer>>,
    #[account(init_if_needed, payer = super_admin, space = 8 + IssuerRecovery::INIT_SPACE,
        seeds = [ISSUER_RECOVERY_SEED, issuer.key().as_ref()], bump)]
    pub recovery: Account<'info, IssuerRecovery>,
    pub system_program: Program<'info, System>,
}

/// The super admin proposes a recovery to `new_authority`, executable from
/// `now + 7 days` for 14 days. A re-proposal overwrites the pending one and
/// restarts the timelock (the window can only get longer). Allowed in every
/// KYB status and asset count.
pub fn handle_propose_issuer_recovery(
    ctx: Context<ProposeIssuerRecovery>,
    new_authority: Pubkey,
) -> Result<()> {
    let issuer = ctx.accounts.issuer.key();
    let current = ctx.accounts.issuer.authority;
    validate_new_authority(current, new_authority)?;
    let now = Clock::get()?.unix_timestamp;
    let eta = now
        .checked_add(ISSUER_RECOVERY_DELAY)
        .ok_or(RegistryError::Overflow)?;
    let expires_at = eta
        .checked_add(ISSUER_RECOVERY_EXECUTION_WINDOW)
        .ok_or(RegistryError::Overflow)?;
    let proposed_by = ctx.accounts.super_admin.key();
    let recovery = &mut ctx.accounts.recovery;
    recovery.issuer = issuer;
    recovery.current_authority = current;
    recovery.new_authority = new_authority;
    recovery.proposed_by = proposed_by;
    recovery.proposed_at = now;
    recovery.eta = eta;
    recovery.expires_at = expires_at;
    recovery.version = STATE_VERSION;
    recovery.bump = ctx.bumps.recovery;
    emit!(IssuerRecoveryProposed {
        issuer,
        current_authority: current,
        new_authority,
        proposed_by,
        eta,
        expires_at,
    });
    msg!(
        "Issuer {} recovery proposed — {} executable from {}",
        issuer,
        new_authority,
        eta
    );
    Ok(())
}

#[derive(Accounts)]
pub struct CancelIssuerRecovery<'info> {
    /// The live issuer authority or the live super admin. Not `mut`: it may be
    /// the same key as `proposer`.
    pub canceller: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()], bump = issuer.bump)]
    pub issuer: Box<Account<'info, Issuer>>,
    #[account(mut, close = proposer,
        seeds = [ISSUER_RECOVERY_SEED, issuer.key().as_ref()], bump = recovery.bump,
        constraint = recovery.issuer == issuer.key() @ RegistryError::InvalidIssuerRecovery,
        constraint = canceller.key() == issuer.authority
            || canceller.key() == platform.admin @ RegistryError::Unauthorized)]
    pub recovery: Account<'info, IssuerRecovery>,
    /// CHECK: the proposing super admin, who paid the rent and gets it back.
    #[account(mut, address = recovery.proposed_by @ RegistryError::InvalidIssuerRecovery)]
    pub proposer: UncheckedAccount<'info>,
}

/// The current issuer authority (the owner of a key that was not lost) or the
/// super admin withdraws a recovery, live or stale.
pub fn handle_cancel_issuer_recovery(ctx: Context<CancelIssuerRecovery>) -> Result<()> {
    let issuer = ctx.accounts.issuer.key();
    emit!(IssuerRecoveryCancelled {
        issuer,
        cancelled_by: ctx.accounts.canceller.key(),
        new_authority: ctx.accounts.recovery.new_authority,
    });
    msg!("Issuer {} recovery cancelled", issuer);
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteIssuerRecovery<'info> {
    /// The recovered key signs. Not `mut`: the old grant's and the recovery's
    /// rent both go to `proposer`, so this key needs no balance.
    pub new_authority: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut, seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()], bump = issuer.bump)]
    pub issuer: Box<Account<'info, Issuer>>,
    #[account(mut, close = proposer,
        seeds = [ISSUER_RECOVERY_SEED, issuer.key().as_ref()], bump = recovery.bump,
        constraint = recovery.issuer == issuer.key()
            && recovery.current_authority == issuer.authority
            && recovery.proposed_by == platform.admin
            && recovery.new_authority == new_authority.key() @ RegistryError::InvalidIssuerRecovery)]
    pub recovery: Account<'info, IssuerRecovery>,
    /// CHECK: the proposing super admin (still `platform.admin`, see above).
    #[account(mut, address = recovery.proposed_by @ RegistryError::InvalidIssuerRecovery)]
    pub proposer: UncheckedAccount<'info>,
    /// The lost authority's grant, closed when present (rent to `proposer`).
    /// CHECK: address pinned by seeds; validated by `util::take_old_grant`.
    #[account(mut, seeds = [ISSUER_PERMISSIONS_SEED, issuer.key().as_ref(), issuer.authority.as_ref()], bump)]
    pub old_permissions: UncheckedAccount<'info>,
    /// A leftover grant of the RECOVERED key, closed when present (rent to
    /// `proposer`): a recovery never carries capabilities, so none may revive.
    /// CHECK: address pinned by seeds; validated by `util::take_old_grant`.
    #[account(mut, seeds = [ISSUER_PERMISSIONS_SEED, issuer.key().as_ref(), new_authority.key().as_ref()], bump)]
    pub new_permissions: UncheckedAccount<'info>,
}

/// The recovered key executes the recovery inside `[eta, expires_at)`. Both
/// grants are closed and none is written: the super admin re-grants with
/// `set_issuer_permissions` after review.
pub fn handle_execute_issuer_recovery(ctx: Context<ExecuteIssuerRecovery>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.recovery.eta,
        RegistryError::IssuerRecoveryTimelockActive
    );
    require!(
        now < ctx.accounts.recovery.expires_at,
        RegistryError::IssuerRecoveryExpired
    );
    let issuer = ctx.accounts.issuer.key();
    let old_authority = ctx.accounts.issuer.authority;
    let new_authority = ctx.accounts.new_authority.key();
    let proposer = ctx.accounts.proposer.to_account_info();
    let old_grant = take_old_grant(
        &ctx.accounts.old_permissions.to_account_info(),
        &issuer,
        &old_authority,
        &proposer,
    )?;
    take_old_grant(
        &ctx.accounts.new_permissions.to_account_info(),
        &issuer,
        &new_authority,
        &proposer,
    )?;
    ctx.accounts.issuer.authority = new_authority;
    emit!(IssuerAuthorityChanged {
        issuer,
        old_authority,
        new_authority,
        kind: IssuerAuthorityChangeKind::TimelockedRecovery,
        capabilities_carried: 0,
        old_grant_closed: old_grant.is_some(),
    });
    msg!(
        "Issuer {} authority recovered — {} -> {}",
        issuer,
        old_authority,
        new_authority
    );
    Ok(())
}

// ── (d) Permissionless sync ──────────────────────────────────────────────────

/// Checks `share_class -> asset -> issuer` by the parent key in each account's
/// first field (owner + discriminator checked), without deserializing the
/// share class, so legacy v1 share classes sync too.
fn require_issuer_chain(
    share_class: &AccountInfo,
    expected_share_class: &Pubkey,
    asset: &AccountInfo,
    issuer: &Pubkey,
) -> Result<()> {
    let asset_key = read_parent_key(share_class, expected_share_class, ShareClass::DISCRIMINATOR)?;
    let issuer_key = read_parent_key(asset, &asset_key, Asset::DISCRIMINATOR)?;
    require_keys_eq!(issuer_key, *issuer, RegistryError::Unauthorized);
    Ok(())
}

#[derive(Accounts)]
pub struct SyncSaleAuthority<'info> {
    #[account(mut, seeds = [SALE_SEED, sale.share_class.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Box<Account<'info, Sale>>,
    /// CHECK: key == sale.share_class, program-owned, ShareClass discriminator;
    /// only `asset` (byte 8) is read.
    pub share_class: UncheckedAccount<'info>,
    /// CHECK: key == share_class.asset, program-owned, Asset discriminator;
    /// only `issuer` (byte 8) is read.
    pub asset: UncheckedAccount<'info>,
    #[account(seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()], bump = issuer.bump)]
    pub issuer: Box<Account<'info, Issuer>>,
}

/// Anyone may copy the live `issuer.authority` into `Sale.authority` (any sale
/// status). A no-op when already in sync, so clients can always bundle it.
pub fn handle_sync_sale_authority(ctx: Context<SyncSaleAuthority>) -> Result<()> {
    let issuer = ctx.accounts.issuer.key();
    require_issuer_chain(
        &ctx.accounts.share_class.to_account_info(),
        &ctx.accounts.sale.share_class,
        &ctx.accounts.asset.to_account_info(),
        &issuer,
    )?;
    let new_authority = ctx.accounts.issuer.authority;
    let old_authority = ctx.accounts.sale.authority;
    if old_authority == new_authority {
        return Ok(());
    }
    ctx.accounts.sale.authority = new_authority;
    emit!(SaleAuthoritySynced {
        sale: ctx.accounts.sale.key(),
        issuer,
        old_authority,
        new_authority,
    });
    msg!(
        "Sale {} authority synced — {} -> {}",
        ctx.accounts.sale.key(),
        old_authority,
        new_authority
    );
    Ok(())
}

#[derive(Accounts)]
pub struct SyncPayoutFounder<'info> {
    #[account(mut, seeds = [PAYOUT_SEED, vault.sale.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, PayoutVault>>,
    /// CHECK: key == vault.share_class, program-owned, ShareClass discriminator;
    /// only `asset` (byte 8) is read.
    pub share_class: UncheckedAccount<'info>,
    /// CHECK: key == share_class.asset, program-owned, Asset discriminator;
    /// only `issuer` (byte 8) is read.
    pub asset: UncheckedAccount<'info>,
    #[account(seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()], bump = issuer.bump)]
    pub issuer: Box<Account<'info, Issuer>>,
}

/// Anyone may copy the live `issuer.authority` into `PayoutVault.founder` (any
/// vault state). A no-op when already in sync. Legacy v1 vaults run
/// `prepare_legacy_account` first, as `release_payout` already requires.
pub fn handle_sync_payout_founder(ctx: Context<SyncPayoutFounder>) -> Result<()> {
    let issuer = ctx.accounts.issuer.key();
    require_issuer_chain(
        &ctx.accounts.share_class.to_account_info(),
        &ctx.accounts.vault.share_class,
        &ctx.accounts.asset.to_account_info(),
        &issuer,
    )?;
    let new_founder = ctx.accounts.issuer.authority;
    let old_founder = ctx.accounts.vault.founder;
    if old_founder == new_founder {
        return Ok(());
    }
    ctx.accounts.vault.founder = new_founder;
    emit!(PayoutFounderSynced {
        vault: ctx.accounts.vault.key(),
        issuer,
        old_founder,
        new_founder,
    });
    msg!(
        "Payout vault {} founder synced — {} -> {}",
        ctx.accounts.vault.key(),
        old_founder,
        new_founder
    );
    Ok(())
}
