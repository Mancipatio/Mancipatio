use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    Admin, Asset, AssetStatus, EscrowIdentity, Issuer, KybStatus, Migration, MigrationCreated,
    MigrationStatus, Platform, ShareClass,
};
use crate::util::{ensure, initialize_token_escrow};

#[derive(Accounts)]
#[instruction(migration_id: u64)]
pub struct CreateMigration<'info> {
    /// The Admin half of the double gate. Pays every rent of the campaign and
    /// receives it back at the close (`Migration.admin`).
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump = admin_record.bump)]
    pub admin_record: Box<Account<'info, Admin>>,

    /// The issuer half: the live authority of the share class's issuer. Its
    /// signature commits the issuer to the terms (lot, cap, window, claim
    /// deadline, return_to) before any of its units move.
    pub issuer_authority: Signer<'info>,

    #[account(
        seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()],
        bump = issuer.bump,
        constraint = issuer.authority == issuer_authority.key() @ RegistryError::Unauthorized,
        constraint = issuer.kyb_status == KybStatus::Verified @ RegistryError::IssuerNotVerified,
    )]
    pub issuer: Box<Account<'info, Issuer>>,

    #[account(
        seeds = [ASSET_SEED, issuer.key().as_ref(), asset.asset_id.as_bytes()],
        bump = asset.bump,
        has_one = issuer @ RegistryError::Unauthorized,
        constraint = asset.status == AssetStatus::Active @ RegistryError::AssetNotActive,
    )]
    pub asset: Box<Account<'info, Asset>>,

    #[account(
        seeds = [SHARE_CLASS_SEED, asset.key().as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
        has_one = mint @ RegistryError::Unauthorized,
        constraint = share_class.mint_initialized @ RegistryError::MintNotInitialized,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    /// The share class's Token-2022 mint — the vault's mint.
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// The legacy token holders deposit (`util::require_supported_old_mint`,
    /// run by the escrow's size expression below).
    pub old_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = 8 + Migration::INIT_SPACE,
        seeds = [MIGRATION_SEED, share_class.key().as_ref(), &migration_id.to_le_bytes()],
        bump
    )]
    pub migration: Box<Account<'info, Migration>>,

    /// Escrow of the old token; authority is the Migration PDA.
    #[account(
        init,
        payer = authority,
        seeds = [MIGRATION_ESCROW_SEED, migration.key().as_ref()],
        bump,
        space = crate::util::old_mint_escrow_space(&old_mint.to_account_info(), &old_token_program.key())?,
        owner = old_token_program.key(),
    )]
    /// CHECK: allocated above, initialized with the old mint and the Migration PDA as owner in the handler.
    pub migration_escrow: UncheckedAccount<'info>,

    /// Vault of share-class units; authority is the Migration PDA.
    #[account(
        init,
        payer = authority,
        seeds = [MIGRATION_VAULT_SEED, migration.key().as_ref()],
        bump,
        space = crate::util::token_escrow_space(&mint.to_account_info(), &token_program.key())?,
        owner = token_program.key(),
    )]
    /// CHECK: allocated above, initialized with the share-class mint and the Migration PDA as owner in the handler.
    pub migration_vault: UncheckedAccount<'info>,

    /// The registry's escrow identity for the Migration PDA (same seeds as an
    /// `EscrowMarker`, its own discriminator). The transfer hook exempts legs
    /// INTO the vault from receiver KYC (the issuer's funding) and lets only a
    /// leg OUT to the refund owner `return_to` pass unscreened; every claim is
    /// screened, by the hook and by `util::deliver_migration_units`. Its
    /// existence also keeps the clawbacks off the vault (`ClawbackTargetIsEscrow`).
    /// `own_deposited` counts the units `return_to` itself funded — the only
    /// part of the close's return that needs no receiver KYC.
    #[account(
        init,
        payer = authority,
        space = 8 + EscrowIdentity::INIT_SPACE,
        seeds = [ESCROW_MARKER_SEED, migration.key().as_ref()],
        bump
    )]
    pub migration_identity: Box<Account<'info, EscrowIdentity>>,

    /// The share-class mint's program (Token-2022).
    pub token_program: Interface<'info, TokenInterface>,
    /// The old mint's program (SPL Token or Token-2022).
    pub old_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    /// Emergency-pause gate (read-only): a migration is an entry into custody.
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_CUSTODY_ENTRY) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, Platform>>,
}

/// Creates a token migration in `Draft`: the Migration PDA, an empty escrow of
/// the old token, an empty vault of share-class units and the escrow identity.
///
/// Double gate, like `set_convertible_to`'s pairing of issuer identity with a
/// platform role — here as two signatures: an Admin (the platform vetted the
/// legacy token and the ratio) and the share class's live issuer authority
/// (whose units will fund the vault). Neither can start a campaign alone.
///
/// Terms, all fixed for the life of the migration:
///   * `lot` old-token base units buy one unit; `units_cap` units must be
///     funded before the window opens (`open_migration`);
///   * the window `[opens_at, closes_at)` lasts 30 to 180 days and starts no
///     earlier than one day ago; `claim_deadline` is at least 30 days after
///     the window, so every depositor gets a claim period;
///   * `return_to` receives every unit left in the vault at the close;
///   * `terms_hash` (sha256 of the off-chain terms) is non-zero.
///
/// The old mint must differ from the share-class mint and pass
/// `util::require_supported_old_mint` (refused extensions:
/// `UnsupportedMintExtension`). Pause: `PAUSE_CUSTODY_ENTRY`.
#[allow(clippy::too_many_arguments)]
pub fn handle_create_migration(
    ctx: Context<CreateMigration>,
    migration_id: u64,
    lot: u64,
    units_cap: u64,
    opens_at: i64,
    closes_at: i64,
    claim_deadline: i64,
    return_to: Pubkey,
    terms_hash: [u8; 32],
) -> Result<()> {
    // `return_to` may not be the Migration PDA: its "own" account would be the
    // vault, a self-transfer at the close would leave the vault non-empty, and
    // the migration could never close.
    ensure(
        lot > 0
            && units_cap > 0
            && terms_hash != [0u8; 32]
            && return_to != Pubkey::default()
            && return_to != ctx.accounts.migration.key()
            && ctx.accounts.old_mint.key() != ctx.accounts.mint.key(),
        RegistryError::MigrationTermsInvalid,
    )?;
    let now = Clock::get()?.unix_timestamp;
    let window_ok = closes_at.checked_sub(opens_at).is_some_and(|window| {
        (MIGRATION_MIN_WINDOW_SECS..=MIGRATION_MAX_WINDOW_SECS).contains(&window)
    });
    let start_ok = now
        .checked_sub(MIGRATION_OPEN_GRACE_SECS)
        .is_some_and(|earliest| opens_at >= earliest);
    let claim_ok = closes_at
        .checked_add(MIGRATION_MIN_CLAIM_SECS)
        .is_some_and(|floor| claim_deadline >= floor);
    ensure(
        window_ok && start_ok && claim_ok,
        RegistryError::MigrationWindowInvalid,
    )?;

    let migration_info = ctx.accounts.migration.to_account_info();
    initialize_token_escrow(
        &ctx.accounts.migration_escrow.to_account_info(),
        &ctx.accounts.old_mint.to_account_info(),
        &migration_info,
        &ctx.accounts.old_token_program.to_account_info(),
    )?;
    initialize_token_escrow(
        &ctx.accounts.migration_vault.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &migration_info,
        &ctx.accounts.token_program.to_account_info(),
    )?;

    let identity = &mut ctx.accounts.migration_identity;
    identity.refund_owner = return_to;
    identity.own_deposited = 0;
    identity.own_refunded = 0;
    identity.bump = ctx.bumps.migration_identity;

    let m = &mut ctx.accounts.migration;
    m.share_class = ctx.accounts.share_class.key();
    m.mint = ctx.accounts.mint.key();
    m.issuer = ctx.accounts.issuer.key();
    m.admin = ctx.accounts.authority.key();
    m.old_mint = ctx.accounts.old_mint.key();
    m.old_token_program = ctx.accounts.old_token_program.key();
    m.return_to = return_to;
    m.migration_id = migration_id;
    m.lot = lot;
    m.units_cap = units_cap;
    m.units_funded = 0;
    m.units_committed = 0;
    m.units_claimed = 0;
    m.lots_deposited = 0;
    m.lots_refunded = 0;
    m.opens_at = opens_at;
    m.closes_at = closes_at;
    m.claim_deadline = claim_deadline;
    m.terms_hash = terms_hash;
    m.status = MigrationStatus::Draft;
    m.merkle_total = 0;
    m.merkle_claimed = 0;
    m.bump = ctx.bumps.migration;
    m.escrow_bump = ctx.bumps.migration_escrow;
    m.vault_bump = ctx.bumps.migration_vault;
    m.version = MIGRATION_STATE_VERSION;
    m.merkle_root = None;

    emit!(MigrationCreated {
        migration: m.key(),
        share_class: m.share_class,
        mint: m.mint,
        issuer: m.issuer,
        admin: m.admin,
        issuer_authority: ctx.accounts.issuer_authority.key(),
        old_mint: m.old_mint,
        old_token_program: m.old_token_program,
        return_to,
        migration_id,
        lot,
        units_cap,
        opens_at,
        closes_at,
        claim_deadline,
        terms_hash,
    });
    Ok(())
}
