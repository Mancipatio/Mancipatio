use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::constants::*;
use crate::state::{Admin, RightsIssuance, ShareClass};

#[derive(Accounts)]
#[instruction(issuance_id: u64)]
pub struct CreateRightsIssuance<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate — only an admin may open a Rights-Token issuance.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    /// The Rights-Token share class whose holders the underlying vests to.
    #[account(
        seeds = [SHARE_CLASS_SEED, share_class.asset.as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    /// The underlying token to be delivered to Rights-Token holders.
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = 8 + RightsIssuance::INIT_SPACE,
        seeds = [RIGHTS_SEED, share_class.key().as_ref(), &issuance_id.to_le_bytes()],
        bump
    )]
    pub rights_issuance: Box<Account<'info, RightsIssuance>>,

    /// Escrow holding the underlying tokens; authority is the `RightsIssuance` PDA.
    #[account(
        init,
        payer = authority,
        seeds = [ESCROW_SEED, rights_issuance.key().as_ref()],
        bump,
        space = crate::util::token_escrow_space(&underlying_mint.to_account_info(), &token_program.key())?,
        owner = token_program.key(),
    )]
    /// CHECK: allocated above, initialized with the bound mint and PDA owner in the handler.
    pub escrow: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    #[account(init, payer = authority, space = 8 + crate::state::EscrowIdentity::INIT_SPACE,
        seeds = [ESCROW_MARKER_SEED, rights_issuance.key().as_ref()], bump)]
    pub identity: Box<Account<'info, crate::state::EscrowIdentity>>,
}

/// Opens a Rights-Token vesting issuance with an empty underlying escrow. The
/// escrow is funded with `mint_to_treasury` (destination = this escrow — pass
/// this issuance's PDA in that instruction's `remaining_accounts`, which
/// deserializes it as a `RightsIssuance` and checks `underlying_mint == mint`
/// and `escrow == destination`); the underlying is then released to holders
/// milestone by milestone. EscrowIdentity proves program custody, enables
/// inbound transfers, and prevents holder clawback. It grants no outbound
/// receiver exemption; milestone delivery explicitly verifies recipient KYC.
pub fn handle_create_rights_issuance(
    ctx: Context<CreateRightsIssuance>,
    issuance_id: u64,
) -> Result<()> {
    ctx.accounts.identity.refund_owner = Pubkey::default();
    ctx.accounts.identity.own_deposited = 0;
    ctx.accounts.identity.own_refunded = 0;
    ctx.accounts.identity.bump = ctx.bumps.identity;

    crate::util::initialize_token_escrow(
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.underlying_mint.to_account_info(),
        &ctx.accounts.rights_issuance.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
    )?;

    let ri = &mut ctx.accounts.rights_issuance;
    ri.share_class = ctx.accounts.share_class.key();
    ri.underlying_mint = ctx.accounts.underlying_mint.key();
    ri.escrow = ctx.accounts.escrow.key();
    ri.authority = ctx.accounts.authority.key();
    ri.issuance_id = issuance_id;
    ri.total_claimed = 0;
    ri.milestones_count = 0;
    ri.version = STATE_VERSION;
    ri.bump = ctx.bumps.rights_issuance;

    msg!("Rights issuance {} created", issuance_id);
    Ok(())
}
