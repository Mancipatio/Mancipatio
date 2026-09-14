use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Asset, ConvertibleTargetSet, Issuer, ShareClass};

#[derive(Accounts)]
pub struct SetConvertibleTo<'info> {
    pub authority: Signer<'info>,

    /// Global Admin or issuer-local CONVERSION capability; signer is also the issuer.
    /// CHECK: validated by require_issuer_permission before any state change/CPI.
    pub admin_record: UncheckedAccount<'info>,

    #[account(
        seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()],
        bump = issuer.bump,
        has_one = authority @ RegistryError::Unauthorized,
    )]
    pub issuer: Box<Account<'info, Issuer>>,

    #[account(
        seeds = [ASSET_SEED, issuer.key().as_ref(), asset.asset_id.as_bytes()],
        bump = asset.bump,
        has_one = issuer @ RegistryError::Unauthorized,
    )]
    pub asset: Box<Account<'info, Asset>>,

    /// The share class whose conversion target is being set.
    #[account(
        mut,
        seeds = [SHARE_CLASS_SEED, asset.key().as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    /// The share class this one converts into. Pass it to set the target;
    /// omit it to clear (`convertible_to = None`). Must be an existing share
    /// class of the SAME asset and must not be `share_class` itself.
    pub target_share_class: Option<Box<Account<'info, ShareClass>>>,
}

/// Sets or clears `ShareClass.convertible_to` with issuer identity and a
/// global Admin or issuer-local CONVERSION grant. The target must be an existing share class of the same
/// asset and different from the class being updated.
pub fn handle_set_convertible_to(ctx: Context<SetConvertibleTo>) -> Result<()> {
    crate::util::require_issuer_permission(
        &ctx.accounts.admin_record.to_account_info(),
        &ctx.accounts.issuer,
        &ctx.accounts.authority.key(),
        ISSUER_PERMISSION_CONVERSION,
    )?;

    let target = match &ctx.accounts.target_share_class {
        Some(t) => {
            require!(
                t.asset == ctx.accounts.asset.key(),
                RegistryError::ConvertibleTargetInvalid
            );
            require!(
                t.key() != ctx.accounts.share_class.key(),
                RegistryError::ConvertibleTargetInvalid
            );
            Some(t.key())
        }
        None => None,
    };

    let sc = &mut ctx.accounts.share_class;
    sc.convertible_to = target;

    emit!(ConvertibleTargetSet {
        share_class: sc.key(),
        target,
    });
    msg!(
        "Convertible target for class {} set to {:?}",
        sc.class_index,
        target
    );
    Ok(())
}
