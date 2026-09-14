use crate::{
    constants::*,
    state::{EscrowIdentity, RightsIssuance, VestingSeries},
};
use anchor_lang::prelude::*;

/// A permissionless, typed attach path for legacy escrows. It adds identity,
/// not an entitlement or an invented historical deposit ledger.
#[derive(Accounts)]
pub struct RegisterVestingEscrowIdentity<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [VESTING_SERIES_SEED, series.authority.as_ref(), &series.series_id.to_le_bytes()], bump = series.bump)]
    pub series: Box<Account<'info, VestingSeries>>,
    #[account(init, payer = payer, space = 8 + EscrowIdentity::INIT_SPACE,
        seeds = [ESCROW_MARKER_SEED, series.key().as_ref()], bump)]
    pub identity: Box<Account<'info, EscrowIdentity>>,
    pub system_program: Program<'info, System>,
}
pub fn handle_register_vesting_escrow_identity(
    ctx: Context<RegisterVestingEscrowIdentity>,
) -> Result<()> {
    ctx.accounts.identity.refund_owner = ctx.accounts.series.authority;
    ctx.accounts.identity.own_deposited = 0;
    ctx.accounts.identity.own_refunded = 0;
    ctx.accounts.identity.bump = ctx.bumps.identity;
    Ok(())
}

#[derive(Accounts)]
pub struct RegisterRightsEscrowIdentity<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [RIGHTS_SEED, rights_issuance.share_class.as_ref(), &rights_issuance.issuance_id.to_le_bytes()], bump = rights_issuance.bump)]
    pub rights_issuance: Box<Account<'info, RightsIssuance>>,
    #[account(init, payer = payer, space = 8 + EscrowIdentity::INIT_SPACE,
        seeds = [ESCROW_MARKER_SEED, rights_issuance.key().as_ref()], bump)]
    pub identity: Box<Account<'info, EscrowIdentity>>,
    pub system_program: Program<'info, System>,
}
pub fn handle_register_rights_escrow_identity(
    ctx: Context<RegisterRightsEscrowIdentity>,
) -> Result<()> {
    ctx.accounts.identity.refund_owner = Pubkey::default();
    ctx.accounts.identity.own_deposited = 0;
    ctx.accounts.identity.own_refunded = 0;
    ctx.accounts.identity.bump = ctx.bumps.identity;
    Ok(())
}
