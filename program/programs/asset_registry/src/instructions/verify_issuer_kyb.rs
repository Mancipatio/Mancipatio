use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Issuer, KybStatus, Platform};

#[derive(Accounts)]
pub struct VerifyIssuerKyb<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        has_one = admin @ RegistryError::Unauthorized,
    )]
    pub platform: Account<'info, Platform>,

    #[account(
        mut,
        seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()],
        bump = issuer.bump,
    )]
    pub issuer: Box<Account<'info, Issuer>>,
}

/// Platform admin records the off-chain KYB decision for an issuer.
pub fn handle_verify_issuer_kyb(ctx: Context<VerifyIssuerKyb>, approved: bool) -> Result<()> {
    let issuer = &mut ctx.accounts.issuer;
    issuer.kyb_status = if approved {
        KybStatus::Verified
    } else {
        KybStatus::Rejected
    };
    msg!("Issuer {} KYB -> {:?}", issuer.authority, issuer.kyb_status);
    Ok(())
}
