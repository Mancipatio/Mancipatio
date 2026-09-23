use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::{Admin, KycRegistry, KycRegistryCreated, JURISDICTION_BITMAP_BYTES};

#[derive(Accounts)]
pub struct CreateKycRegistry<'info> {
    /// The KYC provider the registry belongs to — pays for and owns it, and is
    /// the only signer `approve_holder` / `revoke_holder` accept afterwards,
    /// until rotated (`propose_kyc_registry_authority` /
    /// `accept_kyc_registry_authority`). The registry address stays derived
    /// from THIS creating key forever, so this key can never create a second
    /// registry, even after rotating the first one away.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Platform admin co-signer. Registries are the root of trust for every
    /// `KycGated` mint, so one cannot be conjured permissionlessly; the
    /// provider key stays distinct from the admin key (it gets no admin
    /// powers, and the admin never owns the registry).
    pub admin_authority: Signer<'info>,

    /// Admin gate — `admin_authority` must hold an `Admin` record.
    #[account(
        seeds = [ADMIN_SEED, admin_authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        init,
        payer = authority,
        space = 8 + KycRegistry::INIT_SPACE,
        seeds = [KYC_REGISTRY_SEED, authority.key().as_ref()],
        bump
    )]
    pub kyc_registry: Box<Account<'info, KycRegistry>>,

    pub system_program: Program<'info, System>,
}

/// Creates a KYC registry owned by `authority` (a KYC-provider multisig), with
/// a platform admin co-signing. docs/01 §9 Q1: the platform runs one global
/// registry; issuers may spin up stricter ones and reference them via
/// `Asset.extra_kyc_registry`.
///
/// The admin co-signature is defence in depth: `clawback_from_holder` already
/// pins the registry to the mint's hook config, so a stray registry cannot be
/// used against a holder — but without a gate anyone could litter the program
/// with registries that look authoritative to an off-chain indexer.
pub fn handle_create_kyc_registry(
    ctx: Context<CreateKycRegistry>,
    approved_jurisdictions: [u8; JURISDICTION_BITMAP_BYTES],
    blocked_jurisdictions: [u8; JURISDICTION_BITMAP_BYTES],
) -> Result<()> {
    let reg = &mut ctx.accounts.kyc_registry;
    reg.authority = ctx.accounts.authority.key();
    reg.approved_jurisdictions = approved_jurisdictions;
    reg.blocked_jurisdictions = blocked_jurisdictions;
    reg.entries_count = 0;
    reg.version = STATE_VERSION;
    reg.bump = ctx.bumps.kyc_registry;

    emit!(KycRegistryCreated {
        registry: ctx.accounts.kyc_registry.key(),
        authority: ctx.accounts.authority.key(),
    });
    msg!(
        "KYC registry created — authority {}",
        ctx.accounts.kyc_registry.authority
    );
    Ok(())
}
