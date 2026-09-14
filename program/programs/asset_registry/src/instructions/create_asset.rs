use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Asset, AssetStatus, AssetType, Issuer, JurisdictionRules, KybStatus, Platform};

#[derive(Accounts)]
#[instruction(asset_id: String)]
pub struct CreateAsset<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.paused @ RegistryError::PlatformPaused,
    )]
    pub platform: Account<'info, Platform>,

    #[account(
        mut,
        seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()],
        bump = issuer.bump,
        has_one = authority @ RegistryError::Unauthorized,
        constraint = issuer.kyb_status == KybStatus::Verified @ RegistryError::IssuerNotVerified,
    )]
    pub issuer: Box<Account<'info, Issuer>>,

    #[account(
        init,
        payer = authority,
        space = 8 + Asset::INIT_SPACE,
        seeds = [ASSET_SEED, issuer.key().as_ref(), asset_id.as_bytes()],
        bump
    )]
    pub asset: Box<Account<'info, Asset>>,

    pub system_program: Program<'info, System>,
}

/// Creates an asset in `Draft` status. Share classes are added while still in
/// `Draft`; metadata and rights are immutable once the asset goes `Active`.
///
/// `jurisdiction_rules` is **informational only — NOT enforced on-chain**:
/// nothing in this program or in the token path reads it during transfers.
/// Actual transfer enforcement is the `transfer_hook` program's KYC registry
/// (sanctions blocklist + optional per-mint KYC-gated mode).
pub fn handle_create_asset(
    ctx: Context<CreateAsset>,
    asset_id: String,
    asset_type: AssetType,
    name: String,
    symbol_prefix: String,
    legal_doc_hash: [u8; 32],
    jurisdiction_rules: JurisdictionRules,
) -> Result<()> {
    require!(
        !asset_id.is_empty() && asset_id.len() <= MAX_ASSET_ID_LEN,
        RegistryError::InvalidAssetId
    );
    require!(
        !name.is_empty() && name.len() <= MAX_ASSET_NAME_LEN,
        RegistryError::InvalidText
    );
    require!(
        !symbol_prefix.is_empty() && symbol_prefix.len() <= MAX_SYMBOL_PREFIX_LEN,
        RegistryError::InvalidText
    );

    let asset = &mut ctx.accounts.asset;
    asset.issuer = ctx.accounts.issuer.key();
    asset.asset_id = asset_id;
    asset.asset_type = asset_type;
    asset.name = name;
    asset.symbol_prefix = symbol_prefix;
    asset.legal_doc_hash = legal_doc_hash;
    asset.jurisdiction_rules = jurisdiction_rules;
    asset.status = AssetStatus::Draft;
    asset.share_classes_count = 0;
    asset.extra_kyc_registry = None;
    asset.version = STATE_VERSION;
    asset.bump = ctx.bumps.asset;

    let issuer = &mut ctx.accounts.issuer;
    issuer.assets_count = issuer
        .assets_count
        .checked_add(1)
        .ok_or(RegistryError::Overflow)?;

    msg!(
        "Asset created — {} ({:?})",
        asset.asset_id,
        asset.asset_type
    );
    Ok(())
}
