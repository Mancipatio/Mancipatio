use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::{invoke, invoke_signed},
    },
};
use anchor_spl::{
    token_2022_extensions::{
        spl_pod::optional_keys::OptionalNonZeroPubkey,
        spl_token_metadata_interface::state::TokenMetadata, token_metadata_initialize,
        TokenMetadataInitialize,
    },
    token_interface::{Mint, TokenInterface},
};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Asset, Issuer, ShareClass};

/// Max on-chain metadata lengths — wallets display these (docs/01 §6).
const MAX_METADATA_NAME_LEN: usize = 32;
const MAX_METADATA_SYMBOL_LEN: usize = 10;

// ── transfer_hook instruction discriminators (hand-rolled CPI — no crate dep) ─
//
// Anchor discriminator = `sha256("global:<instruction_name>")[0..8]`. Hardcoded
// consts (no runtime hashing); the `discriminators_match_sha256` unit test
// below recomputes both and fails the build's test run on drift.

/// `transfer_hook::initialize_transfer_hook_config`.
const HOOK_INIT_CONFIG_DISCRIMINATOR: [u8; 8] = [169, 224, 202, 10, 67, 62, 216, 135];
/// `transfer_hook::initialize_extra_account_meta_list`.
const HOOK_INIT_EXTRA_METAS_DISCRIMINATOR: [u8; 8] = [92, 197, 174, 197, 41, 124, 19, 3];
/// Borsh discriminant of `transfer_hook::RestrictionMode::Open`.
const HOOK_RESTRICTION_MODE_OPEN: u8 = 0;

/// Truncates to at most `max_bytes` without splitting a UTF-8 boundary.
fn truncate_utf8(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

#[derive(Accounts)]
pub struct InitializeShareClassMint<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Global Admin or issuer-local MINT capability; the signer must also be the issuer.
    /// CHECK: validated by require_issuer_permission before any state change/CPI.
    pub admin_record: UncheckedAccount<'info>,

    #[account(
        seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()],
        bump = issuer.bump,
        constraint = issuer.kyb_status == crate::state::KybStatus::Verified @ RegistryError::IssuerNotVerified,
        has_one = authority @ RegistryError::Unauthorized,
    )]
    pub issuer: Box<Account<'info, Issuer>>,

    #[account(
        seeds = [ASSET_SEED, issuer.key().as_ref(), asset.asset_id.as_bytes()],
        bump = asset.bump,
        has_one = issuer @ RegistryError::Unauthorized,
    )]
    pub asset: Box<Account<'info, Asset>>,

    #[account(
        mut,
        seeds = [SHARE_CLASS_SEED, asset.key().as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
        constraint = !share_class.mint_initialized @ RegistryError::MintAlreadyInitialized,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    /// Token-2022 mint for this share class — a PDA, with the `ShareClass` PDA
    /// as mint authority. TransferHook extension wired to the Mancipatio
    /// `transfer_hook` program. No `DefaultAccountState=Frozen` — custody, not
    /// freeze (docs/01 §6).
    #[account(
        init,
        payer = authority,
        seeds = [SHARE_MINT_SEED, share_class.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = share_class,
        mint::token_program = token_program,
        extensions::transfer_hook::authority = share_class,
        extensions::transfer_hook::program_id = TRANSFER_HOOK_PROGRAM,
        extensions::permanent_delegate::delegate = share_class,
        extensions::close_authority::authority = share_class,
        extensions::metadata_pointer::authority = share_class,
        extensions::metadata_pointer::metadata_address = mint,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: the hook's per-mint `TransferHookConfig` PDA
    /// (`["hook_cfg", mint]` under the transfer_hook program) — created by the
    /// hook program via CPI; that program enforces the seeds, and the handler
    /// additionally checks the derived address.
    #[account(mut)]
    pub hook_config: UncheckedAccount<'info>,

    /// CHECK: the hook's per-mint `ExtraAccountMetaList` PDA
    /// (`["extra-account-metas", mint]` under the transfer_hook program) —
    /// created by the hook program via CPI; same validation as `hook_config`.
    #[account(mut)]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// CHECK: pinned to the hardcoded Mancipatio transfer_hook program.
    #[account(
        constraint = transfer_hook_program.key() == TRANSFER_HOOK_PROGRAM
            @ RegistryError::Unauthorized,
    )]
    pub transfer_hook_program: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    /// Emergency-pause gate (read-only). Keep LAST among named accounts: old
    /// account indices and the remaining-accounts hook tail keep their positions.
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_ONBOARDING) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, crate::state::Platform>>,
}

/// Creates the Token-2022 mint for a share class. Mint authority is the
/// `ShareClass` PDA; the TransferHook extension routes every transfer through
/// the Mancipatio `transfer_hook` program.
///
/// Extensions: TransferHook, PermanentDelegate (Mancipatio always-on clawback),
/// MintCloseAuthority, MetadataPointer + TokenMetadata (docs/01 §6 — basic
/// token info lives on the mint). No `DefaultAccountState=Frozen`.
///
/// On-chain metadata is derived from the asset: name =
/// `"<Asset.name> · Class <class_index>"` (≤32 bytes), symbol =
/// `"<Asset.symbol_prefix><class_index>"` (≤10 bytes), uri = empty (set later
/// via `update_mint_metadata`). The mint is allocated by Anchor with room for
/// the fixed extensions only; the Token-2022 metadata initialize reallocs it
/// to fit the TokenMetadata TLV entry, so the handler tops the account up to
/// rent-exemption for the final size before the CPI.
pub fn handle_initialize_share_class_mint(ctx: Context<InitializeShareClassMint>) -> Result<()> {
    crate::util::require_issuer_permission(
        &ctx.accounts.admin_record.to_account_info(),
        &ctx.accounts.issuer,
        &ctx.accounts.authority.key(),
        ISSUER_PERMISSION_MINT,
    )?;

    let class_index = ctx.accounts.share_class.class_index;

    // ── on-chain metadata (derived from the asset — no new instruction args) ──
    let name = truncate_utf8(
        &format!("{} · Class {}", ctx.accounts.asset.name, class_index),
        MAX_METADATA_NAME_LEN,
    );
    let symbol = truncate_utf8(
        &format!("{}{}", ctx.accounts.asset.symbol_prefix, class_index),
        MAX_METADATA_SYMBOL_LEN,
    );
    let uri = String::new();

    let mint_info = ctx.accounts.mint.to_account_info();
    let token_metadata = TokenMetadata {
        update_authority: OptionalNonZeroPubkey::try_from(Some(ctx.accounts.share_class.key()))
            .map_err(|_| RegistryError::Overflow)?,
        mint: ctx.accounts.mint.key(),
        name: name.clone(),
        symbol: symbol.clone(),
        uri: uri.clone(),
        additional_metadata: vec![],
    };
    let metadata_len = token_metadata
        .tlv_size_of()
        .map_err(|_| RegistryError::Overflow)?;

    // The metadata initialize reallocs the mint to fit the TokenMetadata TLV
    // entry — fund the account up to rent-exemption for the final size.
    let required_lamports = Rent::get()?.minimum_balance(mint_info.data_len() + metadata_len);
    let top_up = required_lamports.saturating_sub(mint_info.lamports());
    if top_up > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: mint_info.clone(),
                },
            ),
            top_up,
        )?;
    }

    // ShareClass PDA is both mint authority and metadata update authority.
    let asset_key = ctx.accounts.asset.key();
    let class_index_seed = [class_index];
    let bump_seed = [ctx.accounts.share_class.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        SHARE_CLASS_SEED,
        asset_key.as_ref(),
        &class_index_seed,
        &bump_seed,
    ]];
    token_metadata_initialize(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TokenMetadataInitialize {
                program_id: ctx.accounts.token_program.to_account_info(),
                metadata: mint_info.clone(),
                update_authority: ctx.accounts.share_class.to_account_info(),
                mint_authority: ctx.accounts.share_class.to_account_info(),
                mint: mint_info,
            },
            signer_seeds,
        ),
        name,
        symbol,
        uri,
    )?;

    let share_class = &mut ctx.accounts.share_class;
    share_class.mint = ctx.accounts.mint.key();
    share_class.mint_initialized = true;

    // ── auto-init the transfer-hook config + meta list (Open mode) ────────────
    //
    // Two hand-rolled CPIs into the transfer_hook program (no crate dep —
    // mirrors util.rs). Config init is gated on a ShareClass co-signature, so
    // the ShareClass PDA signs CPI 1 via `invoke_signed`; every new mint is
    // born with an Open-mode config and a matching 1-meta list, transferable
    // immediately.
    let mint_key = ctx.accounts.mint.key();
    let (hook_config_pda, _) = Pubkey::find_program_address(
        &[HOOK_CONFIG_SEED, mint_key.as_ref()],
        &TRANSFER_HOOK_PROGRAM,
    );
    require_keys_eq!(
        ctx.accounts.hook_config.key(),
        hook_config_pda,
        RegistryError::Unauthorized
    );
    let (extra_metas_pda, _) = Pubkey::find_program_address(
        &[HOOK_EXTRA_METAS_SEED, mint_key.as_ref()],
        &TRANSFER_HOOK_PROGRAM,
    );
    require_keys_eq!(
        ctx.accounts.extra_account_meta_list.key(),
        extra_metas_pda,
        RegistryError::Unauthorized
    );
    // The hook's blocklist-registry address recorded in the config — the
    // singleton BlocklistAuthority PDA (an address; it need not exist yet).
    let (blocklist_pda, _) =
        Pubkey::find_program_address(&[HOOK_BLOCKLIST_AUTHORITY_SEED], &TRANSFER_HOOK_PROGRAM);

    // CPI 1 — initialize_transfer_hook_config:
    // args (borsh): blocklist: Pubkey, restriction_mode: u8 = Open,
    // kyc_registry: Option<Pubkey> = None.
    let mut init_config_data = Vec::with_capacity(8 + 32 + 1 + 1);
    init_config_data.extend_from_slice(&HOOK_INIT_CONFIG_DISCRIMINATOR);
    init_config_data.extend_from_slice(blocklist_pda.as_ref());
    init_config_data.push(HOOK_RESTRICTION_MODE_OPEN);
    init_config_data.push(0); // Option::None
    invoke_signed(
        &Instruction {
            program_id: TRANSFER_HOOK_PROGRAM,
            accounts: vec![
                AccountMeta::new(ctx.accounts.authority.key(), true), // payer
                AccountMeta::new_readonly(mint_key, false),
                AccountMeta::new_readonly(ctx.accounts.share_class.key(), true),
                AccountMeta::new(hook_config_pda, false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: init_config_data,
        },
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.share_class.to_account_info(),
            ctx.accounts.hook_config.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.transfer_hook_program.to_account_info(),
        ],
        signer_seeds, // ShareClass PDA co-signs — only this program can
    )?;

    // CPI 2 — initialize_extra_account_meta_list (no args; the outer
    // `authority` signature passes through as the payer).
    invoke(
        &Instruction {
            program_id: TRANSFER_HOOK_PROGRAM,
            accounts: vec![
                AccountMeta::new(ctx.accounts.authority.key(), true), // payer
                AccountMeta::new_readonly(mint_key, false),
                AccountMeta::new_readonly(hook_config_pda, false),
                AccountMeta::new(extra_metas_pda, false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: HOOK_INIT_EXTRA_METAS_DISCRIMINATOR.to_vec(),
        },
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.hook_config.to_account_info(),
            ctx.accounts.extra_account_meta_list.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.transfer_hook_program.to_account_info(),
        ],
    )?;

    let share_class = &ctx.accounts.share_class;
    msg!(
        "Share-class mint initialized — class {} mint {} (hook config: Open)",
        share_class.class_index,
        share_class.mint
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hardcoded hook-instruction discriminators must equal
    /// `sha256("global:<name>")[0..8]` (the Anchor formula).
    #[test]
    fn discriminators_match_sha256() {
        let init_config =
            solana_sha256_hasher::hash(b"global:initialize_transfer_hook_config").to_bytes();
        assert_eq!(HOOK_INIT_CONFIG_DISCRIMINATOR, init_config[..8]);

        let init_metas =
            solana_sha256_hasher::hash(b"global:initialize_extra_account_meta_list").to_bytes();
        assert_eq!(HOOK_INIT_EXTRA_METAS_DISCRIMINATOR, init_metas[..8]);
    }
}
