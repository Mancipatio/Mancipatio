use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{CustodyVault, VaultState};

#[derive(Accounts)]
pub struct TriggerCustodyVault<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ RegistryError::Unauthorized,
        constraint = custody_vault.state == VaultState::Active @ RegistryError::InvalidVaultState,
    )]
    pub custody_vault: Box<Account<'info, CustodyVault>>,
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump = authority_admin_record.bump)]
    pub authority_admin_record: Account<'info, crate::state::Admin>,
}

/// Moves a custody vault `Active → Triggered`. The vault `authority` signs —
/// this stands in for the `trigger_type` check (time / oracle / multisig) that
/// the generic design (docs/01 §3) will dispatch on in a later increment.
pub fn handle_trigger_custody_vault(ctx: Context<TriggerCustodyVault>) -> Result<()> {
    ctx.accounts.custody_vault.state = VaultState::Triggered;
    msg!(
        "Custody vault {} triggered",
        ctx.accounts.custody_vault.vault_id
    );
    Ok(())
}
