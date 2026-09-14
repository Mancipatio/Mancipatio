use anchor_lang::prelude::*;
use anchor_lang::AccountsClose;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    CustodyReturned, CustodyVault, EscrowMarker, ShareClass, VaultState, VaultType,
};
use crate::util::{hook_transfer, split_escrow_release};

#[derive(Accounts)]
pub struct ReturnCustodyVault<'info> {
    /// Vault authority with a live Admin role at any time (`Active`/`Triggered`); anyone
    /// once a positive `deadline` has passed (`deadline == 0` — the only
    /// non-positive value `open_custody_vault` accepts — disables the
    /// permissionless path). Mut: receives the closed escrow marker's rent.
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
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
        constraint = custody_vault.vault_type == VaultType::DeliveryEscrow
            @ RegistryError::InvalidVaultState,
        constraint = custody_vault.beneficiary != Pubkey::default()
            @ RegistryError::BeneficiaryRequired,
        constraint = custody_vault.state == VaultState::Active
            || custody_vault.state == VaultState::Triggered
            @ RegistryError::InvalidVaultState,
    )]
    pub custody_vault: Box<Account<'info, CustodyVault>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The beneficiary receives the escrowed tokens back here.
    #[account(
        mut,
        constraint = beneficiary_token_account.mint == custody_vault.mint
            @ RegistryError::Unauthorized,
        constraint = beneficiary_token_account.owner == custody_vault.beneficiary
            @ RegistryError::Unauthorized,
    )]
    pub beneficiary_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Escrow marker for the vault PDA. Closed by the handler (rent → signer)
    /// ONLY when the escrow is fully drained — a return that had to withhold an
    /// un-releasable surplus leaves the vault (and this marker) alive so the
    /// remainder still has an exit. Closed manually rather than with
    /// `close = signer` for exactly that reason.
    #[account(
        mut,
        seeds = [ESCROW_MARKER_SEED, custody_vault.key().as_ref()],
        bump = escrow_marker.bump,
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts — the transfer-hook accounts appended to the
    // `transfer_checked` CPI, in meta-list order (shape depends on the mint's
    // current `restriction_mode`):
    //   Open (3):     [BlockEntry(custody_vault PDA), ExtraAccountMetaList,
    //                  transfer_hook program]
    //   KycGated (9): [BlockEntry(custody_vault PDA), TransferHookConfig,
    //                  KycRegistry, asset_registry program,
    //                  KycEntry(beneficiary), EscrowMarker(beneficiary),
    //                  EscrowMarker(custody_vault PDA), ExtraAccountMetaList,
    //                  transfer_hook program]
    /// CHECK: derived live operator role; may be unresolved for permissionless deadline exits.
    #[account(seeds = [ADMIN_SEED, custody_vault.authority.as_ref()], bump)]
    pub authority_admin_record: UncheckedAccount<'info>,
}

/// Returns a `DeliveryEscrow` vault's escrowed tokens to the beneficiary —
/// the "delivery fell through / holder changed their mind" exit. Unlike
/// `revert_custody_vault`, nothing is burned: the tokens re-enter circulation.
///
/// Authorization: the vault `authority` with a live Admin role may return at any time
/// (state `Active` or `Triggered` — the account constraint above enforces
/// that set). The permissionless path requires a positive deadline that has
/// passed: `deadline == 0` means "no permissionless return, ever". Once the
/// deadline has passed the permissionless branch works in `Triggered` too —
/// before the deadline `Triggered` still blocks it (the vault authority's
/// decision is pending), but afterwards it is the recovery path when the
/// authority key is lost post-trigger; without it the beneficiary's escrowed
/// tokens would be stranded forever (`trigger`/`realize` are authority-only
/// and `revert` is banned for DeliveryEscrow).
///
/// Receiver KYC — the exemption is EVIDENCE-BASED, and applies to an AMOUNT,
/// not to the transaction as a whole:
///
/// The transfer itself runs through the mint's transfer hook (escrow →
/// beneficiary is a Token-2022 `transfer_checked`), but the vault PDA's own
/// `EscrowMarker` — a source-owner marker, still alive during the CPI — makes
/// the hook skip its receiver-KYC checks in `KycGated` mode. This handler
/// therefore decides for itself, via `util::split_escrow_release`, against
/// `custody_vault.deposited`:
///
///   * `min(escrow.amount, deposited)` — units the beneficiary put in through
///     `deposit_to_custody_vault`. Released with NO check of any kind: their
///     own property comes back even with a lapsed or revoked passport;
///   * the surplus above it — units the beneficiary never deposited. The only
///     way they can be there is a raw `transfer_checked` from some other
///     account (a custody escrow is an ordinary token account), which is
///     precisely how a privileged signer used to launder freshly emitted units
///     into a wallet with no `KycEntry`: mint to the treasury → raw transfer
///     into a `DeliveryEscrow` naming that wallet → return. Handing those over
///     is a DELIVERY, so `require_receiver_kyc` must pass for it.
///
/// Why a SPLIT and not a threshold on the total: an earlier version refused
/// the whole return whenever `escrow.amount > deposited`, which handed anyone
/// a one-base-unit denial of service — dust the escrow and the beneficiary's
/// entire deposit is hostage to a passport they may not be able to renew, with
/// burning it (trigger + realize) the only way out. A deposit must never be
/// takeable hostage; the split makes the grief cost the attacker their units
/// and gain them nothing.
///
/// What happens to a withheld surplus: it stays in the escrow and the vault
/// does NOT go terminal — the state stays `Active`/`Triggered` and the
/// `EscrowMarker` stays open. That keeps every exit alive: the beneficiary can
/// come back with a valid `KycEntry` and sweep the rest (the ledger is already
/// spent, so that second return is fully gated, as it should be), or the vault
/// authority can `trigger` + `realize` to burn it. Nothing is stranded and
/// nothing is confiscated. A return that fully drains the escrow is terminal
/// exactly as before.
///
/// The sender blocklist applies in every case: a return is blocked iff the
/// custody-vault PDA (the source authority) is blocklisted, which is
/// recoverable operationally by removing the blocklist entry.
pub fn handle_return_custody_vault<'info>(
    ctx: Context<'info, ReturnCustodyVault<'info>>,
) -> Result<()> {
    let vault = &ctx.accounts.custody_vault;
    let now = Clock::get()?.unix_timestamp;
    let is_authority = ctx.accounts.signer.key() == vault.authority
        && crate::util::is_active_admin(
            &ctx.accounts.authority_admin_record.to_account_info(),
            &vault.authority,
        );
    let permissionless_ok = vault.deadline > 0
        && now >= vault.deadline
        && matches!(vault.state, VaultState::Active | VaultState::Triggered);
    require!(
        is_authority || permissionless_ok,
        RegistryError::ReturnNotAllowed
    );

    let balance = ctx.accounts.escrow.amount;
    // In `Open` mode the tail carries no hook config and the surplus check is a
    // no-op; a stripped tail on a `KycGated` mint cannot reach the transfer
    // below at all, because Token-2022 resolves the full meta list before the
    // hook CPI.
    let release = split_escrow_release(
        balance,
        ctx.accounts.custody_vault.deposited,
        ctx.remaining_accounts,
        &ctx.accounts.mint.key(),
        &ctx.accounts.beneficiary_token_account.owner,
    );
    let return_amount = release.payout;

    // Nothing at all is releasable (no ledger backing, and the surplus was
    // refused) — surface the real reason instead of a silent no-op that would
    // still burn the caller's fee and look like success.
    if return_amount == 0 && balance > 0 {
        if let Some(err) = release.surplus_refusal {
            return Err(err);
        }
    }

    if return_amount > 0 {
        let share_class_key = ctx.accounts.share_class.key();
        let vault_id_seed = ctx.accounts.custody_vault.vault_id.to_le_bytes();
        let cv_bump = ctx.accounts.custody_vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            CUSTODY_SEED,
            share_class_key.as_ref(),
            &vault_id_seed,
            &[cv_bump],
        ]];
        hook_transfer(
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.beneficiary_token_account.to_account_info(),
            &ctx.accounts.custody_vault.to_account_info(),
            ctx.remaining_accounts,
            return_amount,
            ctx.accounts.mint.decimals,
            signer_seeds,
        )?;
    }

    let fully_drained = release.withheld == 0;
    let cv = &mut ctx.accounts.custody_vault;
    // The ledger is consumed by what it backed; a follow-up return of the
    // withheld surplus is therefore fully gated on the receiver's KYC.
    cv.deposited = cv.deposited.saturating_sub(release.from_ledger);
    if fully_drained {
        cv.state = VaultState::Returned;
    }

    emit!(CustodyReturned {
        custody_vault: cv.key(),
        mint: cv.mint,
        returned: return_amount,
        beneficiary: cv.beneficiary,
        withheld: release.withheld,
        terminal: fully_drained,
    });

    if fully_drained {
        msg!(
            "Custody vault {} returned — {} units to beneficiary",
            cv.vault_id,
            return_amount
        );
        // Terminal — close the marker (rent → signer). Done here rather than
        // declaratively so a partial return can keep the vault usable, and
        // after the CPI above so the hook could still resolve the marker.
        ctx.accounts
            .escrow_marker
            .close(ctx.accounts.signer.to_account_info())?;
    } else {
        msg!(
            "Custody vault {} — {} units refunded to beneficiary, {} un-deposited units withheld \
             (receiver not eligible); vault stays open for a KYC'd sweep or a burn",
            cv.vault_id,
            return_amount,
            release.withheld
        );
    }
    Ok(())
}
