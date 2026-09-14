use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    CustodyReverted, CustodyVault, EscrowMarker, ShareClass, VaultState, VaultType,
};

#[derive(Accounts)]
pub struct RevertCustodyVault<'info> {
    /// The vault `authority`, or — once a POSITIVE `deadline` has passed —
    /// anyone (`deadline == 0` disables the permissionless path, mirroring
    /// `return_custody_vault`). Mut: receives the closed escrow marker's rent.
    #[account(mut)]
    pub payer: Signer<'info>,

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
        has_one = mint @ RegistryError::Unauthorized,
        has_one = escrow @ RegistryError::Unauthorized,
        has_one = share_class @ RegistryError::Unauthorized,
        constraint = custody_vault.state == VaultState::Active @ RegistryError::InvalidVaultState,
        // Delivery escrows hold *holder deposits* — a revert would burn them.
        // They exit via `return_custody_vault` (escrow → beneficiary) instead.
        constraint = custody_vault.vault_type != VaultType::DeliveryEscrow
            @ RegistryError::DeliveryVaultUseReturn,
    )]
    pub custody_vault: Box<Account<'info, CustodyVault>>,

    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Escrow marker for the vault PDA — closed here (rent → payer);
    /// revert is a terminal path.
    #[account(
        mut,
        close = payer,
        seeds = [ESCROW_MARKER_SEED, custody_vault.key().as_ref()],
        bump = escrow_marker.bump,
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: derived live operator role; may be unresolved for permissionless deadline exits.
    #[account(seeds = [ADMIN_SEED, custody_vault.authority.as_ref()], bump)]
    pub authority_admin_record: UncheckedAccount<'info>,
}

/// Reverts an `Active` custody vault once its `deadline` has passed without
/// realization — the escape hatch. v0.1 burns the escrow balance (undoing the
/// provisional mint) and marks the vault `Reverted`.
///
/// Authorization — the burn is irreversible, so who may trigger it matters:
///   * the vault `authority` (the admin who opened it, and the only signer
///     `trigger` / `realize` accept) may revert as soon as `deadline` allows;
///   * anyone else needs a POSITIVE `deadline` that has passed. `deadline == 0`
///     (the only non-positive value `open_custody_vault` accepts) therefore
///     means "no permissionless revert, ever" — the same semantic
///     `return_custody_vault` already gives it.
///
/// Why the `deadline == 0` case is authority-only: a zero deadline used to mean
/// "revertible by anyone in the very block the vault opens", which made the
/// quarantine vault of `clawback_from_holder` (`RedemptionQueue` +
/// `BurnAndAttest`, opened with no deadline) a griefing target. A stranger
/// could (a) burn a holder's seized units the moment they land — foreclosing
/// the `realize` path whose `CustodyRealized` event carries the `metadata_hash`
/// attestation the seizure is documented with — and (b) flip an EMPTY vault to
/// `Reverted`, closing its `EscrowMarker` and permanently bricking it, since
/// `clawback_from_holder` requires `state == Active`; repeated per vault, that
/// blocks enforcement for the cost of one transaction each. Opting in to the
/// permissionless hatch (a positive deadline) is a per-vault decision now.
///
/// Operators who want lost-authority recovery must set a deadline; with
/// `deadline == 0` the escrow can still only ever burn (`realize` / `revert`),
/// never leave — `return_custody_vault` is `DeliveryEscrow`-only.
///
/// Receiver KYC: NOT APPLICABLE — the escrow balance is burned, so no share
/// units leave the program and there is no receiver to check.
pub fn handle_revert_custody_vault(ctx: Context<RevertCustodyVault>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let deadline = ctx.accounts.custody_vault.deadline;
    require!(now >= deadline, RegistryError::VaultNotExpired);
    let is_authority = ctx.accounts.payer.key() == ctx.accounts.custody_vault.authority
        && crate::util::is_active_admin(
            &ctx.accounts.authority_admin_record.to_account_info(),
            &ctx.accounts.custody_vault.authority,
        );
    require!(
        is_authority || deadline > 0,
        RegistryError::RevertNotAllowed
    );

    let burn_amount = ctx.accounts.escrow.amount;

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
    cv.state = VaultState::Reverted;

    emit!(CustodyReverted {
        custody_vault: cv.key(),
        mint: cv.mint,
        burned: burn_amount,
    });

    msg!(
        "Custody vault {} reverted — burned {}",
        cv.vault_id,
        burn_amount
    );
    Ok(())
}
