use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Issuer, KybStatus, Platform};

#[derive(Accounts)]
#[instruction(legal_entity_id: [u8; 32])]
pub struct RegisterIssuer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_ONBOARDING) @ RegistryError::PlatformPaused,
    )]
    pub platform: Account<'info, Platform>,

    #[account(
        init,
        payer = authority,
        space = 8 + Issuer::INIT_SPACE,
        seeds = [ISSUER_SEED, legal_entity_id.as_ref()],
        bump
    )]
    pub issuer: Box<Account<'info, Issuer>>,

    pub system_program: Program<'info, System>,
}

/// Registers an issuer in `Pending` KYB state. A platform admin must later call
/// `verify_issuer_kyb` before the issuer can create assets.
pub fn handle_register_issuer(
    ctx: Context<RegisterIssuer>,
    legal_entity_id: [u8; 32],
    jurisdiction: u16,
    kyb_doc_hash: [u8; 32],
) -> Result<()> {
    let issuer = &mut ctx.accounts.issuer;
    issuer.authority = ctx.accounts.authority.key();
    issuer.legal_entity_id = legal_entity_id;
    issuer.jurisdiction = jurisdiction;
    issuer.kyb_status = KybStatus::Pending;
    issuer.kyb_doc_hash = kyb_doc_hash;
    issuer.assets_count = 0;
    issuer.version = STATE_VERSION;
    issuer.bump = ctx.bumps.issuer;

    let platform = &mut ctx.accounts.platform;
    platform.issuers_count = platform
        .issuers_count
        .checked_add(1)
        .ok_or(RegistryError::Overflow)?;

    msg!("Issuer registered — authority {}", issuer.authority);
    Ok(())
}
