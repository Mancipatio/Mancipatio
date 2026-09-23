use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    CustodyDeposited, CustodyVault, RealizeAction, ShareClass, VaultState, VaultType,
};
use crate::util::hook_transfer;

#[derive(Accounts)]
pub struct DepositToCustodyVault<'info> {
    /// The depositing holder — signs the escrow-funding `transfer_checked`.
    /// For a `DeliveryEscrow` vault this MUST be the vault's `beneficiary`
    /// (checked in the handler): the ledger this instruction writes is the
    /// evidence `return_custody_vault` uses to release units KYC-free, so it
    /// may only ever record the beneficiary's own units.
    pub depositor: Signer<'info>,

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
        constraint = custody_vault.state == VaultState::Active
            @ RegistryError::VaultNotAcceptingDeposits,
    )]
    pub custody_vault: Box<Account<'info, CustodyVault>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The depositor's share-class token account — debited exactly `amount`.
    #[account(
        mut,
        constraint = depositor_share_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = depositor_share_account.owner == depositor.key() @ RegistryError::Unauthorized,
    )]
    pub depositor_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,

    /// Emergency-pause gate (read-only). Keep LAST among named accounts: old
    /// account indices and the remaining-accounts hook tail keep their positions.
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_CUSTODY_ENTRY) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, crate::state::Platform>>,
    // remaining_accounts — the transfer-hook accounts for the depositor →
    // escrow leg, in meta-list order:
    //   Open (3):     [BlockEntry(depositor), ExtraAccountMetaList,
    //                  transfer_hook program]
    //   KycGated (9): [BlockEntry(depositor), TransferHookConfig, KycRegistry,
    //                  asset_registry program, KycEntry(custody_vault PDA),
    //                  EscrowMarker(custody_vault PDA), EscrowMarker(depositor),
    //                  ExtraAccountMetaList, transfer_hook program]
    // The destination owner is the vault PDA, whose `EscrowMarker` exempts the
    // leg from receiver KYC — a holder with a lapsed passport can still put
    // their units into custody (and, by the ledger, get them back).
}

/// Funds a custody vault's escrow from the depositor's own wallet — the ONLY
/// instruction that credits `custody_vault.deposited`.
///
/// Why it exists: a custody escrow is an ordinary Token-2022 account, so any
/// holder of the mint (including the issuer treasury) can push units into it
/// with a raw `transfer_checked`. That is unavoidable on-chain and harmless in
/// itself — what mattered is that `return_custody_vault` (the program's only
/// escrow→wallet exit) used to pay the FULL escrow balance to the beneficiary
/// with the receiver-KYC checks skipped, on the assumption that whatever sits
/// in a `DeliveryEscrow` is the beneficiary's own deposit. A privileged signer
/// (`Admin` + issuer authority) could therefore mint into the treasury, raw
/// transfer into a delivery escrow named after a wallet with no `KycEntry`,
/// and return the fresh units out — the escrow-marker exemption made the leg
/// invisible to the hook.
///
/// The fix is bookkeeping, not prohibition: deposits routed through here are
/// recorded, and `return_custody_vault` releases at most the recorded sum
/// without a KYC check. Anything above it — i.e. anything that did NOT come
/// from the beneficiary — is released only to a receiver whose `KycEntry`
/// passes. Legitimate flows are untouched: the holder deposits here, and gets
/// their deposit back even after their passport lapses.
///
/// For non-`DeliveryEscrow` vault types the ledger is informational (their
/// every exit burns), but the same instruction serves them — e.g. a holder
/// putting units into a `RedemptionQueue` buyback.
pub fn handle_deposit_to_custody_vault<'info>(
    ctx: Context<'info, DepositToCustodyVault<'info>>,
    amount: u64,
) -> Result<()> {
    crate::util::require_supported_mint(
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.token_program.key(),
        true,
    )?;

    require!(amount > 0, RegistryError::InvalidDepositAmount);

    // Mirror of the `mint_to_treasury` escrow-destination gate, for the same
    // reason: never fund a vault whose realize action `realize_custody_vault`
    // cannot execute. Once such a vault is triggered every exit is closed
    // (`realize` → UnsupportedRealizeAction, `revert` needs Active, `return`
    // is DeliveryEscrow-only), so the deposit would be stranded.
    // `open_custody_vault` refuses to create such a vault today; this guard
    // also covers vaults written before that gate existed. The
    // `vault_type != DeliveryEscrow` half of the mint-side gate is NOT
    // mirrored — it exists because fresh emission must not reach a
    // `return_custody_vault` exit, whereas a delivery escrow is funded
    // precisely by the beneficiary's own deposit through this instruction.
    require!(
        ctx.accounts.custody_vault.realize_action == RealizeAction::BurnAndAttest,
        RegistryError::UnsupportedRealizeAction
    );

    // A delivery escrow's ledger is a claim about the BENEFICIARY's units —
    // only they may write it. Without this a third party (e.g. the issuer
    // authority holding freshly minted treasury units) could credit the
    // beneficiary's ledger and hand the fresh units to a non-KYC'd wallet
    // through `return_custody_vault`, which is exactly the hole being closed.
    require!(
        ctx.accounts.custody_vault.vault_type != VaultType::DeliveryEscrow
            || ctx.accounts.depositor.key() == ctx.accounts.custody_vault.beneficiary,
        RegistryError::DepositorNotBeneficiary
    );

    // Deposit leg: depositor wallet → vault escrow. Hook-aware; the depositor
    // is a real transaction signer so empty signer seeds suffice.
    hook_transfer(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.depositor_share_account.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.depositor.to_account_info(),
        ctx.remaining_accounts,
        amount,
        ctx.accounts.mint.decimals,
        &[],
    )?;

    let vault = &mut ctx.accounts.custody_vault;
    vault.deposited = vault
        .deposited
        .checked_add(amount)
        .ok_or(RegistryError::Overflow)?;

    emit!(CustodyDeposited {
        custody_vault: vault.key(),
        mint: vault.mint,
        depositor: ctx.accounts.depositor.key(),
        amount,
        total_deposited: vault.deposited,
    });

    msg!(
        "Custody vault {} — {} units deposited ({} credited total)",
        vault.vault_id,
        amount,
        vault.deposited
    );
    Ok(())
}
