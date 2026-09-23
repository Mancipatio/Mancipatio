use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{HolderRevoked, KycEntry, KycRegistry, KycStatus};

#[derive(Accounts)]
#[instruction(holder: Pubkey)]
pub struct RevokeHolder<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Taken by address (see `ApproveHolder::kyc_registry`): the registry
    /// address is permanent, its `authority` rotates.
    #[account(has_one = authority @ RegistryError::Unauthorized)]
    pub kyc_registry: Box<Account<'info, KycRegistry>>,

    #[account(
        mut,
        seeds = [KYC_SEED, kyc_registry.key().as_ref(), holder.as_ref()],
        bump = kyc_entry.bump
    )]
    pub kyc_entry: Box<Account<'info, KycEntry>>,
}

/// KYC-provider revokes a previously approved holder.
///
/// Scope of the revocation: the `transfer_hook` program checks only the
/// RECEIVER of a transfer, so a revoked holder can no longer *receive* units
/// on a `KycGated` mint — but they keep their existing balance and can still
/// send it (the sender side is gated by the blocklist alone). Seizing the
/// balance is a separate, admin-gated step: `clawback_from_holder`, which
/// moves it into a burn-only quarantine escrow (a `RedemptionQueue` custody
/// vault) via the mint's permanent delegate.
pub fn handle_revoke_holder(ctx: Context<RevokeHolder>, holder: Pubkey) -> Result<()> {
    ctx.accounts.kyc_entry.status = KycStatus::Revoked;

    emit!(HolderRevoked {
        registry: ctx.accounts.kyc_registry.key(),
        holder,
    });
    msg!("Holder {} revoked (KYC)", holder);
    Ok(())
}
