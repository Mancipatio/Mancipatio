//! KYC registry authority rotation (propose / accept / cancel).
//!
//! The registry ADDRESS is permanent (`["kyc_registry", creating authority]`);
//! only `KycRegistry.authority` moves. The staged transfer reuses the
//! per-target `AuthorityTransfer` PDA `["authority_transfer", registry]`.
//!
//! Signers: the only proposer and the only canceller is the CURRENT registry
//! authority; the only acceptor is the proposed new authority. There is
//! deliberately no super-admin cancel or recovery (signer-matrix §5: one human
//! signer per instruction, roles never linked by co-signing; a compromised KYC
//! key could propose + accept back to back anyway). A LOST KYC key is
//! recovered without a program change: create a new registry (admin
//! co-signed), re-point each KycGated mint with `update_transfer_hook_config`,
//! re-issue passports.
//!
//! None of these reads `Platform`, so none is subject to the pause flags (the
//! same as `approve_holder`).

use anchor_lang::prelude::*;

use super::rotate_authority::{validate_new_authority, write_proposal};
use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    AuthorityTransfer, KycRegistry, KycRegistryAuthorityChanged,
    KycRegistryAuthorityProposalCancelled, KycRegistryAuthorityProposed,
};

#[derive(Accounts)]
pub struct ProposeKycRegistryAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ RegistryError::Unauthorized)]
    pub kyc_registry: Box<Account<'info, KycRegistry>>,
    #[account(init_if_needed, payer = authority, space = 8 + AuthorityTransfer::INIT_SPACE,
        seeds = [AUTHORITY_TRANSFER_SEED, kyc_registry.key().as_ref()], bump)]
    pub transfer: Account<'info, AuthorityTransfer>,
    pub system_program: Program<'info, System>,
}

/// The current registry authority stages a new authority. A re-proposal
/// overwrites the pending one (same as the platform-admin transfer).
pub fn handle_propose_kyc_registry_authority(
    ctx: Context<ProposeKycRegistryAuthority>,
    new_authority: Pubkey,
) -> Result<()> {
    let registry = ctx.accounts.kyc_registry.key();
    let current = ctx.accounts.kyc_registry.authority;
    validate_new_authority(current, new_authority)?;
    write_proposal(
        &mut ctx.accounts.transfer,
        registry,
        current,
        new_authority,
        ctx.accounts.authority.key(),
        ctx.bumps.transfer,
    );
    emit!(KycRegistryAuthorityProposed {
        registry,
        current_authority: current,
        new_authority,
    });
    msg!(
        "KYC registry {} authority proposed — {}",
        registry,
        new_authority
    );
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptKycRegistryAuthority<'info> {
    #[account(mut)]
    pub new_authority: Signer<'info>,
    #[account(mut)]
    pub kyc_registry: Box<Account<'info, KycRegistry>>,
    #[account(mut, close = new_authority,
        seeds = [AUTHORITY_TRANSFER_SEED, kyc_registry.key().as_ref()], bump = transfer.bump,
        constraint = transfer.target == kyc_registry.key()
            && transfer.current_authority == kyc_registry.authority
            && transfer.proposed_by == kyc_registry.authority
            && transfer.new_authority == new_authority.key() @ RegistryError::InvalidAuthorityTransfer)]
    pub transfer: Account<'info, AuthorityTransfer>,
}

/// The proposed authority accepts; the registry address, bitmaps, entries and
/// every `KycEntry` under it are unchanged. Transfer rent goes to the acceptor.
pub fn handle_accept_kyc_registry_authority(
    ctx: Context<AcceptKycRegistryAuthority>,
) -> Result<()> {
    let registry = ctx.accounts.kyc_registry.key();
    let old_authority = ctx.accounts.kyc_registry.authority;
    let new_authority = ctx.accounts.new_authority.key();
    ctx.accounts.kyc_registry.authority = new_authority;
    emit!(KycRegistryAuthorityChanged {
        registry,
        old_authority,
        new_authority,
    });
    msg!(
        "KYC registry {} authority rotated — {} -> {}",
        registry,
        old_authority,
        new_authority
    );
    Ok(())
}

#[derive(Accounts)]
pub struct CancelKycRegistryAuthorityTransfer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ RegistryError::Unauthorized)]
    pub kyc_registry: Box<Account<'info, KycRegistry>>,
    #[account(mut, close = authority,
        seeds = [AUTHORITY_TRANSFER_SEED, kyc_registry.key().as_ref()], bump = transfer.bump,
        constraint = transfer.target == kyc_registry.key() @ RegistryError::InvalidAuthorityTransfer)]
    pub transfer: Account<'info, AuthorityTransfer>,
}

/// The current registry authority withdraws a pending proposal; the rent
/// returns to it (it paid for the transfer account).
pub fn handle_cancel_kyc_registry_authority_transfer(
    ctx: Context<CancelKycRegistryAuthorityTransfer>,
) -> Result<()> {
    let registry = ctx.accounts.kyc_registry.key();
    emit!(KycRegistryAuthorityProposalCancelled {
        registry,
        authority: ctx.accounts.authority.key(),
        cancelled_new_authority: ctx.accounts.transfer.new_authority,
    });
    msg!("KYC registry {} authority proposal cancelled", registry);
    Ok(())
}
