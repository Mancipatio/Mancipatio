use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    CustodyRealized, CustodyVault, EscrowMarker, KycEntry, KycRegistry, RealizeAction, ShareClass,
    VaultState, VaultType,
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

    /// DeliveryEscrow only: the registry pinned at open
    /// (`custody_vault.kyc_registry`). Ignored for every other type. Appended
    /// LAST (2C-3).
    pub kyc_registry: Option<Box<Account<'info, KycRegistry>>>,

    /// DeliveryEscrow only: the beneficiary's entry,
    /// `["kyc", kyc_registry, custody_vault.beneficiary]` — checked in the
    /// handler (no Anchor seeds, so clients never auto-fill a non-existent
    /// entry and each failure keeps its own error). Ignored otherwise.
    pub kyc_entry: Option<Box<Account<'info, KycEntry>>>,
}

/// Realizes a `Triggered` custody vault. v0.1 supports `BurnAndAttest`: the full
/// escrow balance is burned and a `CustodyRealized` event is emitted as the
/// on-chain attestation (e.g. equity token consumed → off-chain share issued).
///
/// Beneficiary KYC (2C-3): a `DeliveryEscrow` realize IS the holder's equity
/// conversion or physical delivery, so it requires the beneficiary's
/// `KycEntry` in the registry the vault pinned at open — Approved (6069),
/// unexpired (6070) and in an allowed jurisdiction (6071), the same checks and
/// order as the receiver-KYC gates (`util::require_kyc_entry_current` +
/// `util::require_jurisdiction_allowed`). A missing registry account is
/// `CustodyKycRegistryRequired`, a different one `CustodyKycRegistryMismatch`,
/// a missing or other holder's entry `ReceiverNotApproved`. Without KYC the
/// beneficiary is not stuck: `return_custody_vault` refunds their recorded
/// deposit (Active or Triggered). Every other vault type (the clawback
/// quarantine, ConversionPending) passes None / None and is not gated.
///
/// Receiver KYC: NOT APPLICABLE — there is no receiver. The escrow balance is
/// burned, so no share units leave the program. When `TransferToBeneficiary`
/// is implemented it becomes a real escrow→wallet delivery and MUST call
/// `util::require_receiver_kyc` for `beneficiary` (with the hook tail in
/// `remaining_accounts`), exactly like `return_custody_vault`'s surplus
/// branch — the vault's own `EscrowMarker` would otherwise exempt that leg.
///
/// Pause: realize is an exit and stays ungated.
pub fn handle_realize_custody_vault(ctx: Context<RealizeCustodyVault>) -> Result<()> {
    require!(
        ctx.accounts.custody_vault.realize_action == RealizeAction::BurnAndAttest,
        RegistryError::UnsupportedRealizeAction
    );

    // Beneficiary KYC gate — before anything is burned.
    let vault = &ctx.accounts.custody_vault;
    let checked_registry = if vault.vault_type == VaultType::DeliveryEscrow {
        require_keys_neq!(
            vault.kyc_registry,
            Pubkey::default(),
            RegistryError::CustodyKycRegistryRequired
        );
        let registry = ctx
            .accounts
            .kyc_registry
            .as_ref()
            .ok_or(error!(RegistryError::CustodyKycRegistryRequired))?;
        require_keys_eq!(
            registry.key(),
            vault.kyc_registry,
            RegistryError::CustodyKycRegistryMismatch
        );
        let entry = ctx
            .accounts
            .kyc_entry
            .as_ref()
            .ok_or(error!(RegistryError::ReceiverNotApproved))?;
        let (expected_entry, _) = Pubkey::find_program_address(
            &[
                KYC_SEED,
                registry.key().as_ref(),
                vault.beneficiary.as_ref(),
            ],
            &crate::ID,
        );
        require_keys_eq!(
            entry.key(),
            expected_entry,
            RegistryError::ReceiverNotApproved
        );
        crate::util::require_kyc_entry_current(entry, Clock::get()?.unix_timestamp)?;
        crate::util::require_jurisdiction_allowed(registry, entry.jurisdiction)?;
        registry.key()
    } else {
        Pubkey::default()
    };

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
        beneficiary: cv.beneficiary,
        kyc_registry: checked_registry,
    });

    msg!(
        "Custody vault {} realized — burned {}",
        cv.vault_id,
        burn_amount
    );
    Ok(())
}
