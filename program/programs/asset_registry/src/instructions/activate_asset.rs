use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, Asset, AssetStatus, Issuer};

#[derive(Accounts)]
pub struct ActivateAsset<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate — only an admin may activate assets.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()],
        bump = issuer.bump,
        constraint = issuer.kyb_status == crate::state::KybStatus::Verified @ RegistryError::IssuerNotVerified,
    )]
    pub issuer: Box<Account<'info, Issuer>>,

    #[account(
        mut,
        seeds = [ASSET_SEED, issuer.key().as_ref(), asset.asset_id.as_bytes()],
        bump = asset.bump,
        has_one = issuer @ RegistryError::Unauthorized,
        constraint = asset.status == AssetStatus::Draft @ RegistryError::AssetNotDraft,
    )]
    pub asset: Box<Account<'info, Asset>>,
}

/// Flips an asset `Draft → Active` once its share classes are configured.
/// Minting (`mint_to_treasury`) and primary sales (`open_sale`) require an
/// active asset.
pub fn handle_activate_asset(ctx: Context<ActivateAsset>) -> Result<()> {
    require!(
        ctx.accounts.asset.share_classes_count > 0,
        RegistryError::AssetHasNoShareClasses
    );
    let asset = &mut ctx.accounts.asset;
    asset.status = AssetStatus::Active;
    msg!("Asset {} activated", asset.asset_id);
    Ok(())
}
