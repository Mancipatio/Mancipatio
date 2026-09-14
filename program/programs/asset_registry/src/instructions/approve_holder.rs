use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{HolderApproved, KycEntry, KycRegistry, KycStatus};

#[derive(Accounts)]
#[instruction(holder: Pubkey)]
pub struct ApproveHolder<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [KYC_REGISTRY_SEED, authority.key().as_ref()],
        bump = kyc_registry.bump,
        has_one = authority @ RegistryError::Unauthorized,
    )]
    pub kyc_registry: Box<Account<'info, KycRegistry>>,

    /// `init_if_needed` — first approval creates the entry; a later call for
    /// the same holder RE-approves it in place (after a revoke or an expiry),
    /// overwriting every field with the fresh KYC decision.
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + KycEntry::INIT_SPACE,
        seeds = [KYC_SEED, kyc_registry.key().as_ref(), holder.as_ref()],
        bump
    )]
    pub kyc_entry: Box<Account<'info, KycEntry>>,

    pub system_program: Program<'info, System>,
}

/// KYC-provider records an approved holder. The `transfer_hook` program reads
/// this entry on every receive — `expiry` makes the approval time-bounded.
///
/// Re-approval: the entry PDA is `init_if_needed`, so calling this again for a
/// revoked or expired holder overwrites status, jurisdiction, accreditation
/// tier, expiry, provider and dossier hash with the fresh decision (the PDA —
/// and therefore the canonical bump — is unchanged). `entries_count` is only
/// incremented on first creation.
pub fn handle_approve_holder(
    ctx: Context<ApproveHolder>,
    holder: Pubkey,
    jurisdiction: u16,
    accreditation_level: u8,
    expiry: i64,
    provider_id: u16,
    external_ref_hash: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(expiry > now, RegistryError::KycExpiryInPast);

    let entry = &mut ctx.accounts.kyc_entry;
    // A freshly `init`-ed account is all zeros; every initialised entry carries
    // `version == STATE_VERSION (>= 1)` — so `version == 0` ⇔ first approval.
    let is_new = entry.version == 0;

    entry.registry = ctx.accounts.kyc_registry.key();
    entry.holder = holder;
    entry.status = KycStatus::Approved;
    entry.jurisdiction = jurisdiction;
    entry.accreditation_level = accreditation_level;
    entry.expiry = expiry;
    entry.provider_id = provider_id;
    entry.external_ref_hash = external_ref_hash;
    entry.version = STATE_VERSION;
    // Canonical bump (PDA seeds are fixed) — identical on re-approval.
    entry.bump = ctx.bumps.kyc_entry;

    if is_new {
        let reg = &mut ctx.accounts.kyc_registry;
        reg.entries_count = reg
            .entries_count
            .checked_add(1)
            .ok_or(RegistryError::Overflow)?;
        msg!("Holder {} approved (KYC)", holder);
    } else {
        msg!("Holder {} re-approved (KYC refreshed)", holder);
    }

    emit!(HolderApproved {
        registry: ctx.accounts.kyc_registry.key(),
        holder,
        jurisdiction,
        accreditation_level,
        expiry,
        provider_id,
        reapproval: !is_new,
    });
    Ok(())
}
