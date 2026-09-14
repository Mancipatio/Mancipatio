use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    CustodyRealized, CustodyVault, EscrowMarker, RealizeAction, ShareClass, VaultState,
};

#[derive(Accounts)]
pub struct RealizeCustodyVault<'info> {
    /// Mut: receives the closed escrow marker's rent.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SHARE_CLASS_SEED, share_class.asset.as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    #[account(
        mut,
        seeds = [CUSTODY_SEED, share_class.key().as_ref(), &custody_vault.vault_id.to_le_bytes()],
        bump = custody_vault.bump,
        has_one = authority @ RegistryError::Unauthorized,
        has_one = mint @ RegistryError::Unauthorized,
        has_one = escrow @ RegistryError::Unauthorized,
        has_one = share_class @ RegistryError::Unauthorized,
        constraint = custody_vault.state == VaultState::Triggered @ RegistryError::InvalidVaultState,
    )]
    pub custody_vault: Box<Account<'info, CustodyVault>>,

    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Escrow marker for the vault PDA — closed here (rent → authority);
    /// realize is a terminal path.
    #[account(
        mut,
        close = authority,
        seeds = [ESCROW_MARKER_SEED, custody_vault.key().as_ref()],
        bump = escrow_marker.bump,
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    pub token_program: Interface<'info, TokenInterface>,
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump = authority_admin_record.bump)]
    pub authority_admin_record: Account<'info, crate::state::Admin>,
}

/// Realizes a `Triggered` custody vault. v0.1 supports `BurnAndAttest`: the full
/// escrow balance is burned and a `CustodyRealized` event is emitted as the
/// on-chain attestation (e.g. equity token consumed → off-chain share issued).
///
/// Receiver KYC: NOT APPLICABLE — there is no receiver. The escrow balance is
/// burned, so no share units leave the program. When `TransferToBeneficiary`
/// is implemented it becomes a real escrow→wallet delivery and MUST call
/// `util::require_receiver_kyc` for `beneficiary` (with the hook tail in
/// `remaining_accounts`), exactly like `return_custody_vault`'s surplus
/// branch — the vault's own `EscrowMarker` would otherwise exempt that leg.
pub fn handle_realize_custody_vault(ctx: Context<RealizeCustodyVault>) -> Result<()> {
    require!(
        ctx.accounts.custody_vault.realize_action == RealizeAction::BurnAndAttest,
        RegistryError::UnsupportedRealizeAction
    );

    let burn_amount = ctx.accounts.escrow.amount;

    // The CustodyVault PDA is the escrow authority — sign the burn with its seeds.
    let share_class_key = ctx.accounts.share_class.key();
    let vault_id_seed = ctx.accounts.custody_vault.vault_id.to_le_bytes();
    let cv_bump = ctx.accounts.custody_vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        CUSTODY_SEED,
        share_class_key.as_ref(),
        &vault_id_seed,
        &[cv_bump],
    ]];

    if burn_amount > 0 {
        token_interface::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.escrow.to_account_info(),
                    authority: ctx.accounts.custody_vault.to_account_info(),
                },
                signer_seeds,
            ),
            burn_amount,
        )?;

        let sc = &mut ctx.accounts.share_class;
        sc.circulating_supply = sc
            .circulating_supply
            .checked_sub(burn_amount)
            .ok_or(RegistryError::Overflow)?;
    }

    let cv = &mut ctx.accounts.custody_vault;
    cv.state = VaultState::Realized;

    emit!(CustodyRealized {
        custody_vault: cv.key(),
        mint: cv.mint,
        burned: burn_amount,
        metadata_hash: cv.metadata_hash,
    });

    msg!(
        "Custody vault {} realized — burned {}",
        cv.vault_id,
        burn_amount
    );
    Ok(())
}
