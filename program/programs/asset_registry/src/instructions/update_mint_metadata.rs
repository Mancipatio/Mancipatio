use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::{
        extension::{BaseStateWithExtensions, StateWithExtensions},
        state::Mint as SplMint,
    },
    token_2022_extensions::{
        spl_token_metadata_interface::state::{Field, TokenMetadata},
        token_metadata_update_field, TokenMetadataUpdateField,
    },
    token_interface::{Mint, TokenInterface},
};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Asset, Issuer, ShareClass};

#[derive(Accounts)]
pub struct UpdateMintMetadata<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Global Admin or issuer-local METADATA capability; signer is also the issuer.
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

    #[account(
        seeds = [SHARE_CLASS_SEED, asset.key().as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
        has_one = mint @ RegistryError::Unauthorized,
        constraint = share_class.mint_initialized @ RegistryError::MintNotInitialized,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    #[account(
        mut,
        seeds = [SHARE_MINT_SEED, share_class.key().as_ref()],
        bump,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Updates a whitelisted on-chain metadata field of a share-class mint — only
/// `uri` may change; name and symbol are fixed at mint creation. The
/// `ShareClass` PDA is the metadata update authority and signs the CPI.
///
/// A longer value grows the TokenMetadata TLV entry; the Token-2022 program
/// reallocs the mint, so the handler first tops the account up to
/// rent-exemption for the grown size (payer = authority).
pub fn handle_update_mint_metadata(
    ctx: Context<UpdateMintMetadata>,
    field: String,
    value: String,
) -> Result<()> {
    crate::util::require_issuer_permission(
        &ctx.accounts.admin_record.to_account_info(),
        &ctx.accounts.issuer,
        &ctx.accounts.authority.key(),
        ISSUER_PERMISSION_METADATA,
    )?;

    require!(field == "uri", RegistryError::InvalidMetadataField);

    // Current uri length → exact account-length delta after the update.
    let mint_info = ctx.accounts.mint.to_account_info();
    let old_uri_len = {
        let data = mint_info.try_borrow_data()?;
        let state = StateWithExtensions::<SplMint>::unpack(&data)
            .map_err(|_| RegistryError::MintMetadataMissing)?;
        state
            .get_variable_len_extension::<TokenMetadata>()
            .map_err(|_| RegistryError::MintMetadataMissing)?
            .uri
            .len()
    };
    let new_account_len = mint_info.data_len() + value.len().saturating_sub(old_uri_len);
    let required_lamports = Rent::get()?.minimum_balance(new_account_len);
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

    let asset_key = ctx.accounts.asset.key();
    let class_index_seed = [ctx.accounts.share_class.class_index];
    let bump_seed = [ctx.accounts.share_class.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        SHARE_CLASS_SEED,
        asset_key.as_ref(),
        &class_index_seed,
        &bump_seed,
    ]];
    token_metadata_update_field(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TokenMetadataUpdateField {
                program_id: ctx.accounts.token_program.to_account_info(),
                metadata: mint_info,
                update_authority: ctx.accounts.share_class.to_account_info(),
            },
            signer_seeds,
        ),
        Field::Uri,
        value,
    )?;

    msg!(
        "Share-class mint metadata updated — class {} uri",
        ctx.accounts.share_class.class_index
    );
    Ok(())
}
