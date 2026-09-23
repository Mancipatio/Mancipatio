use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    Admin, CustodyVault, EscrowMarker, KycRegistry, RealizeAction, ShareClass, VaultState,
    VaultType,
};

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct OpenCustodyVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate — only an admin may open custody vaults.
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

    #[account(
        init,
        payer = authority,
        space = 8 + CustodyVault::INIT_SPACE,
        seeds = [CUSTODY_SEED, share_class.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub custody_vault: Box<Account<'info, CustodyVault>>,

    /// Token-2022 escrow account holding the custodied tokens; authority is the
    /// `CustodyVault` PDA.
    #[account(
        init,
        payer = authority,
        seeds = [ESCROW_SEED, custody_vault.key().as_ref()],
        bump,
        space = crate::util::token_escrow_space(&mint.to_account_info(), &token_program.key())?,
        owner = token_program.key(),
    )]
    /// CHECK: allocated above, initialized with the bound mint and PDA owner in the handler.
    pub escrow: UncheckedAccount<'info>,

    /// Marks the vault PDA as a platform escrow authority — the transfer hook
    /// exempts escrow legs from receiver-KYC while this exists. Closed on
    /// every terminal path (realize / revert / return).
    #[account(
        init,
        payer = authority,
        space = 8 + EscrowMarker::INIT_SPACE,
        seeds = [ESCROW_MARKER_SEED, custody_vault.key().as_ref()],
        bump
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    /// Emergency-pause gate (read-only), checked in the handler: a burn-only
    /// quarantine vault (RedemptionQueue + BurnAndAttest) stays openable for
    /// clawback. Appended after the original accounts (old account indices
    /// keep their positions); only `kyc_registry` (2C-3) follows it.
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, crate::state::Platform>>,

    /// DeliveryEscrow: REQUIRED — the registry `realize_custody_vault` checks
    /// the beneficiary's `KycEntry` in (pinned on the vault). Any other type:
    /// must be None (the program-id placeholder). `Account<KycRegistry>`
    /// checks owner + discriminator, and only `create_kyc_registry` (admin
    /// co-signed) can create one. Appended LAST (2C-3): no index moves.
    pub kyc_registry: Option<Box<Account<'info, KycRegistry>>>,
}

/// Opens a custody vault in `Active` state with an empty escrow token account.
/// The escrow is funded separately — either by fresh emission
/// (`mint_to_treasury` with the escrow as destination: pass this vault's PDA in
/// that instruction's `remaining_accounts`, which deserializes it as a
/// `CustodyVault` and checks `share_class` / `mint` / `escrow` /
/// `state == Active` AND that the vault is burn-only, i.e. not a
/// `DeliveryEscrow` and `realize_action == BurnAndAttest`), or — for a
/// `DeliveryEscrow` — by the beneficiary's own hook-checked
/// `deposit_to_custody_vault`, which is where its units are supposed to come
/// from AND the only route that credits `custody_vault.deposited`. v0.1
/// realize path: `BurnAndAttest`.
///
/// The escrow is a plain token account, so a raw `transfer_checked` can always
/// push units into it from outside the program. That is deliberately NOT
/// forbidden (it cannot be) — it is instead made harmless by the ledger:
/// `return_custody_vault` releases at most `deposited` without a receiver-KYC
/// check and requires one for anything above it, so units that did not come
/// from the beneficiary (e.g. freshly emitted treasury units) can never reach
/// a wallet without a valid `KycEntry`.
///
/// A `RedemptionQueue` + `BurnAndAttest` vault doubles as the quarantine
/// destination for `clawback_from_holder`: `return_custody_vault` (the only
/// escrow→wallet exit) is reserved for `DeliveryEscrow`, so every exit of such
/// a vault burns. Open it with `deadline == 0` unless you deliberately want a
/// permissionless burn after some T — see `revert_custody_vault`. The
/// quarantine vault takes no `kyc_registry`.
///
/// KYC at conversion / delivery (2C-3): a `DeliveryEscrow` — the type the
/// platform uses for both holder conversions and physical deliveries — pins
/// a `KycRegistry` here, and `realize_custody_vault` requires the
/// beneficiary's Approved, unexpired, jurisdiction-allowed `KycEntry` in it.
/// Nothing is KYC-checked at open or deposit (buying / holding needs no KYC);
/// without a passport the beneficiary's deposit leaves via
/// `return_custody_vault`. Every other vault type must pass no registry.
#[allow(clippy::too_many_arguments)]
pub fn handle_open_custody_vault(
    ctx: Context<OpenCustodyVault>,
    vault_id: u64,
    vault_type: VaultType,
    realize_action: RealizeAction,
    amount: u64,
    deadline: i64,
    metadata_hash: [u8; 32],
    beneficiary: Pubkey,
) -> Result<()> {
    // Emergency pause (custody entry). A burn-only quarantine vault stays
    // openable: clawback (always open) needs one as its destination, and every
    // exit of such a vault burns — see the note above.
    let quarantine =
        vault_type == VaultType::RedemptionQueue && realize_action == RealizeAction::BurnAndAttest;
    require!(
        quarantine || !ctx.accounts.platform.is_paused(PAUSE_CUSTODY_ENTRY),
        RegistryError::PlatformPaused
    );

    crate::util::initialize_token_escrow(
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.custody_vault.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
    )?;

    // A delivery escrow must name the holder who gets the tokens back if the
    // delivery falls through — `return_custody_vault` transfers to them.
    require!(
        vault_type != VaultType::DeliveryEscrow || beneficiary != Pubkey::default(),
        RegistryError::BeneficiaryRequired
    );

    // KYC registry pin (2C-3): required for a DeliveryEscrow (its realize is
    // the holder's conversion / delivery and is KYC-gated against it), refused
    // for every other type — the clawback quarantine included, so its path is
    // unchanged.
    let pinned_registry = match (vault_type, ctx.accounts.kyc_registry.as_ref()) {
        (VaultType::DeliveryEscrow, Some(registry)) => registry.key(),
        (VaultType::DeliveryEscrow, None) => {
            return err!(RegistryError::CustodyKycRegistryRequired)
        }
        (_, None) => Pubkey::default(),
        (_, Some(_)) => return err!(RegistryError::CustodyKycRegistryNotAllowed),
    };

    // `deadline == 0` means "no deadline": it disables BOTH permissionless
    // paths — `return_custody_vault` and `revert_custody_vault` — leaving the
    // vault authority as the only signer who can end the vault. Any positive
    // value is a unix timestamp after which either path opens to anyone.
    // Negative values are rejected — they would read as "already expired" to
    // `revert_custody_vault` while disabling the permissionless branch in both,
    // silently inverting the intended semantics.
    require!(deadline >= 0, RegistryError::InvalidDeadline);

    // Only a realize action that `realize_custody_vault` actually implements
    // may be stored. `trigger_custody_vault` moves Active → Triggered, and from
    // Triggered the ONLY exits are `realize_custody_vault` (BurnAndAttest-only)
    // and, for a `DeliveryEscrow`, `return_custody_vault`; `revert` requires
    // Active. A vault opened with `TransferToBeneficiary` / `BurnAndPayout`
    // would therefore accept deposits (and, for non-delivery types, be
    // triggerable) into a state with no exit at all — the units would be
    // stranded. Re-open this gate together with the realize implementation
    // when those actions ship; `mint_to_treasury` and
    // `deposit_to_custody_vault` enforce the same rule on the funding side.
    require!(
        realize_action == RealizeAction::BurnAndAttest,
        RegistryError::UnsupportedRealizeAction
    );

    let v = &mut ctx.accounts.custody_vault;
    v.share_class = ctx.accounts.share_class.key();
    v.mint = ctx.accounts.mint.key();
    v.escrow = ctx.accounts.escrow.key();
    v.vault_id = vault_id;
    v.authority = ctx.accounts.authority.key();
    v.vault_type = vault_type;
    v.realize_action = realize_action;
    v.amount = amount;
    v.state = VaultState::Active;
    v.deadline = deadline;
    v.metadata_hash = metadata_hash;
    v.beneficiary = beneficiary;
    v.version = CUSTODY_STATE_VERSION;
    v.bump = ctx.bumps.custody_vault;
    // Deposit ledger starts empty: nothing has been contributed by the
    // beneficiary yet, so `return_custody_vault` would require receiver KYC
    // for every unit that shows up in the escrow by any other route.
    v.deposited = 0;
    v.kyc_registry = pinned_registry;

    ctx.accounts.escrow_marker.bump = ctx.bumps.escrow_marker;

    msg!("Custody vault {} opened ({:?})", vault_id, vault_type);
    Ok(())
}
