use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, Distribution, DistributionStatus, EscrowMarker};

#[derive(Accounts)]
pub struct CloseDistribution<'info> {
    /// Mut: receives the closed escrow marker's rent.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate — only an admin may close distributions.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        mut,
        seeds = [DISTRIBUTION_SEED, distribution.share_class.as_ref(), &distribution.distribution_id.to_le_bytes()],
        bump = distribution.bump,
        has_one = escrow @ RegistryError::Unauthorized,
        has_one = payment_mint @ RegistryError::Unauthorized,
        constraint = distribution.status != DistributionStatus::Closed @ RegistryError::DistributionNotActive,
    )]
    pub distribution: Box<Account<'info, Distribution>>,

    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Receives the undistributed remainder — must be owned by the wallet
    /// that funded the distribution (`distribution.funder`).
    #[account(
        mut,
        constraint = refund_account.mint == payment_mint.key() @ RegistryError::Unauthorized,
        constraint = refund_account.owner == distribution.funder @ RegistryError::RefundNotFunderOwned,
    )]
    pub refund_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: receives the escrow token account's rent lamports when it is
    /// closed — constrained to be the distribution funder (the wallet that
    /// owns `refund_account`), so both the remainder and the rent return to
    /// whoever funded the distribution.
    #[account(
        mut,
        constraint = escrow_rent_recipient.key() == distribution.funder @ RegistryError::RefundNotFunderOwned,
    )]
    pub escrow_rent_recipient: UncheckedAccount<'info>,

    /// Escrow marker for the distribution PDA — closed here (rent →
    /// authority); close is the distribution's only terminal path.
    #[account(
        mut,
        close = authority,
        seeds = [ESCROW_MARKER_SEED, distribution.key().as_ref()],
        bump = escrow_marker.bump,
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    pub payment_token_program: Interface<'info, TokenInterface>,
}

/// Closes a distribution: the undistributed remainder (if any) is swept to
/// `refund_account` (which must be funder-owned) via a transfer signed by the
/// `Distribution` PDA, the escrow token account is closed (rent → the funder
/// via `escrow_rent_recipient`), the escrow marker is closed (rent → the
/// closing admin) and the status flips to `Closed`.
pub fn handle_close_distribution(ctx: Context<CloseDistribution>) -> Result<()> {
    let remainder = ctx.accounts.escrow.amount;

    let share_class = ctx.accounts.distribution.share_class;
    let distribution_id_seed = ctx.accounts.distribution.distribution_id.to_le_bytes();
    let distribution_bump = ctx.accounts.distribution.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        DISTRIBUTION_SEED,
        share_class.as_ref(),
        &distribution_id_seed,
        &[distribution_bump],
    ]];

    if remainder > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.payment_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.escrow.to_account_info(),
                    mint: ctx.accounts.payment_mint.to_account_info(),
                    to: ctx.accounts.refund_account.to_account_info(),
                    authority: ctx.accounts.distribution.to_account_info(),
                },
                signer_seeds,
            ),
            remainder,
            ctx.accounts.payment_mint.decimals,
        )?;
    }

    // Escrow is now empty — close it and send its rent to the funder.
    token_interface::close_account(CpiContext::new_with_signer(
        ctx.accounts.payment_token_program.key(),
        CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.escrow_rent_recipient.to_account_info(),
            authority: ctx.accounts.distribution.to_account_info(),
        },
        signer_seeds,
    ))?;

    let d = &mut ctx.accounts.distribution;
    d.status = DistributionStatus::Closed;
    msg!(
        "Distribution {} closed — {} swept to refund account, escrow closed",
        d.distribution_id,
        remainder
    );
    Ok(())
}
