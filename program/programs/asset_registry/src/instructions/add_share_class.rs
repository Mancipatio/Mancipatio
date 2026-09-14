use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Asset, AssetStatus, AssetType, Issuer, Platform, ShareClass, ShareClassType};

#[derive(Accounts)]
#[instruction(class_index: u8)]
pub struct AddShareClass<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.paused @ RegistryError::PlatformPaused,
    )]
    pub platform: Account<'info, Platform>,

    #[account(
        seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()],
        bump = issuer.bump,
        constraint = issuer.kyb_status == crate::state::KybStatus::Verified @ RegistryError::IssuerNotVerified,
        has_one = authority @ RegistryError::Unauthorized,
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

    #[account(
        init,
        payer = authority,
        space = 8 + ShareClass::INIT_SPACE,
        seeds = [SHARE_CLASS_SEED, asset.key().as_ref(), &[class_index]],
        bump
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    pub system_program: Program<'info, System>,
}

/// Adds a share class to a draft asset. `class_index` must be sequential
/// (equal to the asset's current `share_classes_count`). The Token-2022 mint
/// itself is created by a later `initialize_share_class_mint` instruction.
#[allow(clippy::too_many_arguments)]
pub fn handle_add_share_class(
    ctx: Context<AddShareClass>,
    class_index: u8,
    class_type: ShareClassType,
    rights_bitfield: u8,
    liq_pref_multiplier_bps: u16,
    liq_seniority: u8,
    voting_weight: u32,
    max_supply: Option<u64>,
    mintable_post_launch: bool,
) -> Result<()> {
    require!(
        class_index == ctx.accounts.asset.share_classes_count,
        RegistryError::InvalidShareClassIndex
    );
    require!(
        class_index < MAX_SHARE_CLASSES,
        RegistryError::TooManyShareClasses
    );
    require!(
        rights_bitfield & !RIGHTS_MASK == 0,
        RegistryError::InvalidRightsBitfield
    );
    require!(
        liq_pref_multiplier_bps >= MIN_LIQ_PREF_BPS,
        RegistryError::InvalidLiqPref
    );
    // Unique physical items are supply-1 by design — a PhysicalGood share
    // class must be hard-capped at exactly one unit.
    if ctx.accounts.asset.asset_type == AssetType::PhysicalGood {
        require!(
            max_supply == Some(1),
            RegistryError::PhysicalGoodRequiresUnitSupply
        );
        // ONE item ⇒ ONE class. The supply-1 cap is per share class, and each
        // class gets its own Token-2022 mint — allowing a second class would
        // mint a second "the item" token (each able to open its own delivery
        // escrow) for the same unique physical good.
        require!(class_index == 0, RegistryError::PhysicalGoodSingleClass);
        // The unit cap must be cumulative, not merely concurrent: realizing a
        // delivery escrow burns the unit and resets circulating_supply to 0,
        // and `mintable_post_launch` bypasses `supply_locked` in
        // mint_to_treasury/buy — a fresh unit could be re-minted for an item
        // that already left custody. Physical-good classes are therefore never
        // mintable post-launch. The v2 lifetime counter also enforces this
        // independently of the optional supply lock.
        require!(
            !mintable_post_launch,
            RegistryError::PhysicalGoodPostLaunchMint
        );
    }

    let sc = &mut ctx.accounts.share_class;
    sc.asset = ctx.accounts.asset.key();
    sc.mint = Pubkey::default();
    sc.class_index = class_index;
    sc.class_type = class_type;
    sc.rights_bitfield = rights_bitfield;
    sc.liq_pref_multiplier_bps = liq_pref_multiplier_bps;
    sc.liq_seniority = liq_seniority;
    sc.voting_weight = voting_weight;
    sc.convertible_to = None;
    sc.max_supply = max_supply;
    sc.circulating_supply = 0;
    sc.locked_supply = 0;
    sc.mintable_post_launch = mintable_post_launch;
    sc.mint_initialized = false;
    sc.supply_locked = false;
    sc.version = SHARE_CLASS_STATE_VERSION;
    sc.lifetime_minted = 0;
    sc.cumulative_cap = ctx.accounts.asset.asset_type == AssetType::PhysicalGood;
    sc.bump = ctx.bumps.share_class;

    let asset = &mut ctx.accounts.asset;
    asset.share_classes_count = class_index.checked_add(1).ok_or(RegistryError::Overflow)?;

    msg!(
        "Share class {} added to asset {}",
        class_index,
        asset.asset_id
    );
    Ok(())
}
