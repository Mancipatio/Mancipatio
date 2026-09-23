use anchor_lang::prelude::*;

use crate::error::RegistryError;
use crate::state::{KycRegistry, KycRegistryJurisdictionsUpdated, JURISDICTION_BITMAP_BYTES};

#[derive(Accounts)]
pub struct UpdateKycRegistryJurisdictions<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ RegistryError::Unauthorized)]
    pub kyc_registry: Box<Account<'info, KycRegistry>>,
}

/// The registry authority replaces BOTH jurisdiction bitmaps whole.
/// `entries_count`, `version` and `bump` are untouched.
///
/// No bitmap validation (same as `create_kyc_registry`): blocked wins over
/// approved in both the hook and `receiver_kyc_outcome`, and an all-zero
/// approved map is a deliberate way to freeze every KycGated receiver. The
/// change is live immediately on every KycGated mint pointing at this
/// registry, because both read the bitmaps on every transfer / buy.
pub fn handle_update_kyc_registry_jurisdictions(
    ctx: Context<UpdateKycRegistryJurisdictions>,
    approved_jurisdictions: [u8; JURISDICTION_BITMAP_BYTES],
    blocked_jurisdictions: [u8; JURISDICTION_BITMAP_BYTES],
) -> Result<()> {
    let registry = ctx.accounts.kyc_registry.key();
    let reg = &mut ctx.accounts.kyc_registry;
    reg.approved_jurisdictions = approved_jurisdictions;
    reg.blocked_jurisdictions = blocked_jurisdictions;
    emit!(KycRegistryJurisdictionsUpdated {
        registry,
        authority: ctx.accounts.authority.key(),
        approved_jurisdictions,
        blocked_jurisdictions,
    });
    msg!("KYC registry {} jurisdictions updated", registry);
    Ok(())
}
