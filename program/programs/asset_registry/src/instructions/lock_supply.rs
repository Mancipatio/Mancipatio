use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::{Admin, ShareClass};

#[derive(Accounts)]
pub struct LockSupply<'info> {
    pub authority: Signer<'info>,

    /// Admin gate — only an admin may lock a share class's supply.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        mut,
        seeds = [SHARE_CLASS_SEED, share_class.asset.as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,
}

/// Locks a share class's supply — marks the end of launch distribution. After
/// this, `mint_to_treasury` and `buy` reject further minting unless
/// `mintable_post_launch` is set. One-way (audit finding M3, docs/01 §9 Q6).
pub fn handle_lock_supply(ctx: Context<LockSupply>) -> Result<()> {
    ctx.accounts.share_class.supply_locked = true;
    msg!(
        "Supply locked — share class {}",
        ctx.accounts.share_class.class_index
    );
    Ok(())
}
