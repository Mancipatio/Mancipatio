use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, SaleApproval, SaleApprovalRevoked};

#[derive(Accounts)]
pub struct RevokeSaleApproval<'info> {
    pub authority: Signer<'info>,

    /// Admin gate: any active Admin may revoke, not only the approver.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        mut,
        seeds = [
            SALE_APPROVAL_SEED,
            sale_approval.share_class.as_ref(),
            &sale_approval.sale_id.to_le_bytes(),
        ],
        bump = sale_approval.bump,
        has_one = approved_by @ RegistryError::SaleApprovalMismatch,
        close = approved_by,
    )]
    pub sale_approval: Box<Account<'info, SaleApproval>>,

    /// The approving Admin; receives the approval's rent, whoever revokes.
    /// CHECK: bound to `sale_approval.approved_by` by `has_one`.
    #[account(mut)]
    pub approved_by: UncheckedAccount<'info>,
}

/// Closes an unused `SaleApproval` in any state (live or expired). The rent
/// returns to the approving Admin. No `Platform` account: revoking is an exit,
/// so the emergency pause never blocks it.
pub fn handle_revoke_sale_approval(ctx: Context<RevokeSaleApproval>) -> Result<()> {
    let approval = &ctx.accounts.sale_approval;
    emit!(SaleApprovalRevoked {
        sale_approval: approval.key(),
        share_class: approval.share_class,
        sale_id: approval.sale_id,
        revoked_by: ctx.accounts.authority.key(),
        rent_to: approval.approved_by,
    });
    msg!(
        "Sale approval for sale {} revoked; rent to {}",
        approval.sale_id,
        approval.approved_by
    );
    Ok(())
}
