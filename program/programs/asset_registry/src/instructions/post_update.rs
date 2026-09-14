use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{PayoutVault, PayoutVaultState};

#[derive(Accounts)]
pub struct PostUpdate<'info> {
    pub founder: Signer<'info>,

    #[account(
        mut,
        seeds = [PAYOUT_SEED, vault.sale.as_ref()],
        bump = vault.bump,
        has_one = founder @ RegistryError::NotFounder,
        constraint = vault.state == PayoutVaultState::Active @ RegistryError::VaultNotActive,
    )]
    pub vault: Box<Account<'info, PayoutVault>>,
}

pub fn handle_post_update(ctx: Context<PostUpdate>, content_hash: [u8; 32]) -> Result<()> {
    let v = &mut ctx.accounts.vault;
    require!(
        v.updates_posted < v.num_tranches as u32,
        RegistryError::NothingToRelease
    );

    let now = Clock::get()?.unix_timestamp;
    let period_start = v.start_ts + (v.updates_posted as i64) * MONTH;
    require!(now >= period_start, RegistryError::UpdateRequired);

    v.updates_posted += 1;
    v.last_update_ts = now;
    emit!(UpdatePosted {
        payout_vault: v.key(),
        period: v.updates_posted,
        content_hash,
        ts: now,
    });
    Ok(())
}

#[event]
pub struct UpdatePosted {
    pub payout_vault: Pubkey,
    pub period: u32,
    pub content_hash: [u8; 32],
    pub ts: i64,
}
