use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    Admin, BlocklistClawback, CustodyVault, RealizeAction, ShareClass, VaultState, VaultType,
};
use crate::util::{read_hook_config, require_blocklisted, seize_into_quarantine};

#[derive(Accounts)]
#[instruction(holder: Pubkey)]
pub struct ClawbackBlocklistedHolder<'info> {
    pub authority: Signer<'info>,

    /// Admin gate — the signer must hold an `Admin` record. This is the second
    /// key; the first is the BlocklistAuthority that created `block_entry`.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        seeds = [SHARE_CLASS_SEED, share_class.asset.as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
        has_one = mint @ RegistryError::Unauthorized,
        constraint = share_class.mint_initialized @ RegistryError::MintNotInitialized,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Any token account of this mint owned by `holder` — the clawback source.
    /// The hook independently re-derives its `BlockEntry` from this account's
    /// owner, so the evidence chain is `source.owner == holder ==
    /// BlockEntry.wallet`.
    #[account(
        mut,
        constraint = holder_share_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = holder_share_account.owner == holder @ RegistryError::Unauthorized,
    )]
    pub holder_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Proof that `holder` is an ordinary wallet and not one of this program's
    /// own escrows (`EscrowMarker` / `EscrowIdentity` at this address). The
    /// BlocklistAuthority can block ANY pubkey, escrow PDAs included, so even
    /// with both keys a program escrow cannot be targeted — see
    /// `clawback_from_holder` for the full reasoning.
    #[account(
        seeds = [ESCROW_MARKER_SEED, holder.as_ref()],
        bump,
        constraint = holder_escrow_marker.data_is_empty()
            @ RegistryError::ClawbackTargetIsEscrow,
    )]
    /// CHECK: address-derived; only its emptiness is read (see above).
    pub holder_escrow_marker: UncheckedAccount<'info>,

    /// CHECK: the hook's `BlockEntry` PDA `["blocked", holder]` — address pinned
    /// by the seeds constraint; contents (hook-owned, discriminator, wallet)
    /// checked by `util::require_blocklisted`. Only the hook's
    /// `BlocklistAuthority` can create it.
    #[account(
        seeds = [HOOK_BLOCK_ENTRY_SEED, holder.as_ref()],
        seeds::program = TRANSFER_HOOK_PROGRAM,
        bump,
    )]
    pub block_entry: UncheckedAccount<'info>,

    /// Destination — the escrow of `custody_vault` below (burn-only quarantine
    /// of THIS share class).
    #[account(
        mut,
        constraint = destination.mint == mint.key() @ RegistryError::Unauthorized,
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The quarantine vault — identical constraints to `clawback_from_holder`:
    /// a typed, Active `RedemptionQueue` + `BurnAndAttest` `CustodyVault` of
    /// this class whose every exit burns.
    #[account(
        seeds = [CUSTODY_SEED, share_class.key().as_ref(), &custody_vault.vault_id.to_le_bytes()],
        bump = custody_vault.bump,
        has_one = mint @ RegistryError::ClawbackDestinationInvalid,
        has_one = share_class @ RegistryError::ClawbackDestinationInvalid,
        constraint = custody_vault.escrow == destination.key()
            @ RegistryError::ClawbackDestinationInvalid,
        constraint = custody_vault.vault_type == VaultType::RedemptionQueue
            @ RegistryError::ClawbackDestinationInvalid,
        constraint = custody_vault.realize_action == RealizeAction::BurnAndAttest
            @ RegistryError::ClawbackDestinationInvalid,
        constraint = custody_vault.state == VaultState::Active
            @ RegistryError::ClawbackDestinationInvalid,
    )]
    pub custody_vault: Box<Account<'info, CustodyVault>>,

    /// CHECK: the mint's `TransferHookConfig` PDA (`["hook_cfg", mint]` under
    /// the hook) — address pinned by the seeds constraint; the handler checks
    /// it is hook-owned and names this mint and share class, in ANY mode.
    #[account(
        seeds = [HOOK_CONFIG_SEED, mint.key().as_ref()],
        seeds::program = TRANSFER_HOOK_PROGRAM,
        bump,
    )]
    pub hook_config: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: the holder→escrow leg's hook tail in the mint's
    // CURRENT shape (source authority = ShareClass PDA, the permanent
    // delegate; source BlockEntry keyed on the HOLDER):
    //   Open:     [BlockEntry(holder), ExtraAccountMetaList(mint), hook program]
    //   KycGated: the 9-account tail (destination marker = the custody vault's).
}

/// Claws back the units of a holder on the transfer-hook blocklist into a
/// burn-only quarantine escrow, on an `Open` OR a `KycGated` mint, via the
/// mint's Token-2022 `PermanentDelegate` (the `ShareClass` PDA). Two keys:
///   * the hook's `BlocklistAuthority` must have added the holder to the
///     blocklist (a live, hook-owned `BlockEntry` naming `holder`) — no admin
///     of this program can create one;
///   * an `Admin` of this program signs.
///
/// Everything else mirrors `clawback_from_holder` (which stays the KycGated
/// revoked/expired path, unchanged): the holder must not be a program escrow,
/// and the destination is an Active `RedemptionQueue` + `BurnAndAttest` vault
/// escrow of this class. The transfer hook admits a blocked source only for
/// this ShareClass-signed permanent-delegate leg into a registry escrow.
///
/// No pause check: like `clawback_from_holder`, enforcement into a burn-only
/// sink stays available during an incident. `amount == 0` sweeps the holder's
/// full balance.
pub fn handle_clawback_blocklisted_holder<'info>(
    ctx: Context<'info, ClawbackBlocklistedHolder<'info>>,
    holder: Pubkey,
    amount: u64,
) -> Result<()> {
    // First, so a holder in good standing fails with ClawbackHolderNotBlocked.
    let blocked_by = require_blocklisted(&ctx.accounts.block_entry, &holder)?;
    let kyc_gated = read_hook_config(
        &ctx.accounts.hook_config,
        &ctx.accounts.mint.key(),
        &ctx.accounts.share_class.key(),
    )?;

    let clawback_amount = seize_into_quarantine(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.share_class,
        &ctx.accounts.holder_share_account,
        &ctx.accounts.mint,
        &ctx.accounts.destination.to_account_info(),
        ctx.remaining_accounts,
        amount,
    )?;

    emit!(BlocklistClawback {
        share_class: ctx.accounts.share_class.key(),
        mint: ctx.accounts.mint.key(),
        holder,
        block_entry: ctx.accounts.block_entry.key(),
        blocked_by,
        admin: ctx.accounts.authority.key(),
        destination: ctx.accounts.destination.key(),
        custody_vault: ctx.accounts.custody_vault.key(),
        kyc_gated,
        amount: clawback_amount,
    });
    msg!(
        "Blocklist clawback — {} units from holder {}",
        clawback_amount,
        holder
    );
    Ok(())
}
