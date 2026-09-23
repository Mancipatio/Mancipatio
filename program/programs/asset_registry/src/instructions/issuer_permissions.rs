use crate::{
    constants::*,
    error::RegistryError,
    state::{
        Issuer, IssuerAuthorityChangeKind, IssuerAuthorityChanged, IssuerPermissions, KybStatus,
        Platform,
    },
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(capabilities: u8)]
pub struct SetIssuerPermissions<'info> {
    #[account(mut)]
    pub super_admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump, constraint = platform.admin == super_admin.key() @ RegistryError::Unauthorized)]
    pub platform: Account<'info, Platform>,
    #[account(seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()], bump = issuer.bump,
        constraint = capabilities == 0 || issuer.kyb_status == KybStatus::Verified @ RegistryError::IssuerNotVerified)]
    pub issuer: Box<Account<'info, Issuer>>,
    #[account(init_if_needed, payer = super_admin, space = 8 + IssuerPermissions::INIT_SPACE,
        seeds = [ISSUER_PERMISSIONS_SEED, issuer.key().as_ref(), issuer.authority.as_ref()], bump)]
    pub permissions: Account<'info, IssuerPermissions>,
    pub system_program: Program<'info, System>,
}

/// Grants only issuer-local mint/metadata/conversion powers; zero revokes all.
pub fn handle_set_issuer_permissions(
    ctx: Context<SetIssuerPermissions>,
    capabilities: u8,
) -> Result<()> {
    require!(
        capabilities & !ISSUER_PERMISSIONS_ALL == 0,
        RegistryError::InvalidIssuerPermissions
    );
    let permissions = &mut ctx.accounts.permissions;
    permissions.issuer = ctx.accounts.issuer.key();
    permissions.authority = ctx.accounts.issuer.authority;
    permissions.capabilities = capabilities;
    permissions.updated_by = ctx.accounts.super_admin.key();
    permissions.version = STATE_VERSION;
    permissions.bump = ctx.bumps.permissions;
    msg!(
        "Issuer permissions updated — issuer {} authority {} capabilities {}",
        permissions.issuer,
        permissions.authority,
        capabilities
    );
    Ok(())
}

#[derive(Accounts)]
pub struct RecoverIssuerRegistration<'info> {
    pub super_admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump, constraint = platform.admin == super_admin.key() @ RegistryError::Unauthorized)]
    pub platform: Account<'info, Platform>,
    #[account(mut, seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()], bump = issuer.bump,
        constraint = issuer.assets_count == 0 && matches!(issuer.kyb_status, KybStatus::Pending | KybStatus::Rejected) @ RegistryError::IssuerRegistrationNotRecoverable)]
    pub issuer: Box<Account<'info, Issuer>>,
    pub new_authority: Signer<'info>,
}

/// Recovers an unverified, unused legal-ID reservation. Issuers with any asset
/// cannot be reassigned through this path (they use the timelocked
/// `propose_issuer_recovery`). A Verified issuer with no asset CAN: the super
/// admin alone may flip KYB to Rejected (`verify_issuer_kyb(false)`) and then
/// co-sign this with any key, skipping the 7-day timelock. That residual is a
/// super-admin trust assumption (no asset, sale or vault is at stake); the
/// runbook forbids the flip for an issuer that was ever Verified.
///
/// The account list is frozen (the K9 co-sign envelope depends on it), so the
/// old authority's `IssuerPermissions` record is left in place, and so is any
/// leftover record of `new_authority` and any pending `AuthorityTransfer` /
/// `IssuerRecovery`. A dormant record (`require_issuer_permission` derives it
/// from the live authority) can only be non-zero when KYB went Verified ->
/// Rejected after a grant. It is overwritten when its key later takes over
/// through `accept_issuer_authority` and closed through
/// `execute_issuer_recovery`, but it REVIVES when this instruction assigns
/// the registration back to that key (A -> C -> A, each leg needing the super
/// admin): the super admin must re-check or revoke the grant with
/// `set_issuer_permissions` after every registration recovery.
pub fn handle_recover_issuer_registration(
    ctx: Context<RecoverIssuerRegistration>,
    jurisdiction: u16,
    kyb_doc_hash: [u8; 32],
) -> Result<()> {
    let issuer_key = ctx.accounts.issuer.key();
    let issuer = &mut ctx.accounts.issuer;
    let old_authority = issuer.authority;
    issuer.authority = ctx.accounts.new_authority.key();
    issuer.jurisdiction = jurisdiction;
    issuer.kyb_doc_hash = kyb_doc_hash;
    issuer.kyb_status = KybStatus::Pending;
    emit!(IssuerAuthorityChanged {
        issuer: issuer_key,
        old_authority,
        new_authority: issuer.authority,
        kind: IssuerAuthorityChangeKind::RegistrationRecovery,
        capabilities_carried: 0,
        old_grant_closed: false,
    });
    msg!(
        "Issuer registration recovered — legal ID preserved, new pending authority {}",
        issuer.authority
    );
    Ok(())
}
