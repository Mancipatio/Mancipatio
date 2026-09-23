//! Mancipatio transfer hook program.
//!
//! Token-2022 calls this program on every `transfer` / `transferChecked` of a
//! share-class mint. Mancipatio tokens are bearer instruments and trade freely
//! in the default `Open` mode, where the hook enforces immutable receiving accounts and the blocklist:
//! a transfer whose source owner is on the blocklist (sanctions / court order) fails.
//!
//! The blocklist is administered by a single `BlocklistAuthority` (a Mancipatio
//! admin multisig) — only it may add or remove entries.
//!
//! In the opt-in `KycGated` mode the hook additionally enforces **receiver
//! eligibility**: the destination token-account owner must hold a valid
//! `KycEntry` (Approved, not expired, jurisdiction allowed) in the issuer's
//! `KycRegistry`. Both accounts are owned by the `asset_registry` program; the
//! hook reads them by raw byte offset (it has no `asset_registry` dependency —
//! that crate does not build as a library).
//!
//! **Escrow-marker exemption (KycGated only):** the registry stamps every
//! platform escrow authority (OTC deal / offer / custody vault / distribution
//! PDA) with an `EscrowMarker` PDA `["escrow_marker", owner]` under the
//! `asset_registry` program. The meta list resolves that PDA for both the
//! destination owner (Execute idx 10) and the source owner (idx 11); when
//! either resolves to a valid registry EscrowMarker the receiver-KYC checks
//! are skipped for platform routing. Rights/Vesting instead use EscrowIdentity
//! at the same seeds: inbound routing is allowed, ordinary outbound deliveries
//! stay screened. Only its named refund owner gets a refund route, backed by
//! the registry's separate own-deposit ledger and explicit surplus KYC gate. Unresolved markers are system-owned ⇒ no exemption, so
//! direct wallet↔wallet transfers stay fully gated. The source-owner blocklist is enforced in every mode. A blocked holder can
//! only leave via the authenticated registry permanent-delegate quarantine path
//! (`require_quarantine_clawback`) — in `Open` mode too, where the mint's
//! `PermanentDelegate` pins the ShareClass and the destination must be a
//! registry escrow PDA.
//!
//! **The exemption is a routing decision, not an eligibility verdict.** It
//! exists because a program escrow can never hold a `KycEntry` of its own, so
//! without it no deposit into an escrow could ever settle. It says nothing
//! about the wallet on the other end of an escrow→wallet leg — and it used to
//! be read as if it did ("admin-created flows are platform-vetted"), which is
//! circular when the platform's own admin key is the party being trusted.
//! `asset_registry` therefore re-derives receiver eligibility on-chain for
//! EVERY leg that delivers share units out of an escrow to a wallet
//! (`util::require_receiver_kyc`):
//!
//!   * `take_offer` — offers are permissionless, so the taker was never
//!     vetted by anyone;
//!   * `settle_otc_deal` — an admin picks both `deal.buyer` and `deal.seller`,
//!     so "vetted off-chain" would reduce to trusting one key;
//!   * every REFUND leg (`cancel_offer` / `expire_offer` / OTC cancel+expire /
//!     `return_custody_vault`) — for the part of the escrow balance the payee
//!     did NOT deposit themselves.
//!
//! That last bullet is the general form of the invariant, and it exists
//! because this exemption also lets ANYONE push units into ANY escrow: the
//! destination-owner marker (idx 10) exempts an inbound leg regardless of who
//! sent it, and no `asset_registry` instruction is involved, so nothing can
//! refuse it. "Whatever is in the escrow belongs to the party we are paying"
//! is therefore not a fact — it has to be RECORDED. Each escrow keeps a
//! deposit ledger written only by its own deposit instruction
//! (`deposit_to_offer_escrow` → `Offer.deposited`, `deposit_otc_asset` →
//! `OtcDeal.asset_deposited_amount`, `deposit_to_custody_vault` →
//! `CustodyVault.deposited`), and `util::split_escrow_release` pays out at
//! most that much unchecked, gating any surplus on the receiver's KYC.
//!
//! `asset_registry::buy` does the same for primary-sale delivery, which is a
//! `mint_to` and never reaches this hook at all
//! (`util::require_receiver_kyc_for_mint_to`, fail-closed).
//!
//! What stays exempt on purpose: deposits INTO an escrow, the ledger-backed
//! part of every refund (a lapsed passport must never confiscate a deposit),
//! and clawbacks into a burn-only quarantine vault — the callers document each
//! one at its call site.
//!
//! The meta list is per-mint and its shape is fixed by `restriction_mode`:
//! `Open` resolves only the source `BlockEntry` (Execute idx 5); `KycGated`
//! also resolves the config, registry, asset_registry program, the receiver
//! `KycEntry`, and the destination-/source-owner `EscrowMarker`s
//! (Execute idx 6–11).

use anchor_lang::{
    prelude::*,
    system_program::{
        allocate, assign, create_account, transfer, Allocate, Assign, CreateAccount, Transfer,
    },
};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_token_2022_interface::{
    extension::{
        immutable_owner::ImmutableOwner, permanent_delegate::PermanentDelegate,
        BaseStateWithExtensions, StateWithExtensions,
    },
    state::{Account as SplTokenAccount, Mint as SplMint},
};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

declare_id!("GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy");

// Gated like the Anchor entrypoint: the registry's host tests link this crate
// as a `no-entrypoint` dev-dependency next to the registry, and two exported
// `SECURITY_TXT` symbols would collide.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Manci transfer_hook",
    project_url: "https://www.manci.io",
    contacts: "email:security@mancipatio.io",
    policy: "https://www.manci.io/security",
    preferred_languages: "en",
    source_code: "https://github.com/Mancipatio/Mancipatio"
}

/// The `asset_registry` program — owner of the `KycRegistry` / `KycEntry`
/// accounts the `KycGated` mode reads. Kept in sync with `asset_registry`'s
/// `declare_id!`.
pub const ASSET_REGISTRY_PROGRAM: Pubkey = pubkey!("FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS");

/// PDA seed for the per-mint transfer-hook config.
pub const HOOK_CONFIG_SEED: &[u8] = b"hook_cfg";
/// PDA seed for a blocklist entry.
pub const BLOCK_ENTRY_SEED: &[u8] = b"blocked";
/// PDA seed for the singleton blocklist authority.
pub const BLOCKLIST_AUTHORITY_SEED: &[u8] = b"blocklist_authority";
pub const BLOCKLIST_AUTHORITY_TRANSFER_SEED: &[u8] = b"blocklist_authority_transfer";
/// Must match `spl_transfer_hook_interface`'s `EXTRA_ACCOUNT_METAS_SEED`.
pub const EXTRA_METAS_SEED: &[u8] = b"extra-account-metas";
/// PDA seed (under `asset_registry`) for a per-holder `KycEntry`.
pub const KYC_ENTRY_SEED: &[u8] = b"kyc";
/// PDA seed (under `asset_registry`) for an `EscrowMarker` — stamped on every
/// platform escrow authority PDA (deal / offer / custody vault / distribution).
pub const ESCROW_MARKER_SEED: &[u8] = b"escrow_marker";
/// Separate registry identity: inbound routing and a bounded named refund route.
pub const ESCROW_IDENTITY_DISCRIMINATOR: [u8; 8] = [11, 3, 104, 6, 28, 163, 95, 48];
pub const ESCROW_MARKER_DISCRIMINATOR: [u8; 8] = [180, 74, 152, 91, 29, 38, 13, 81];

/// The Anchor account discriminator of `asset_registry::ShareClass` —
/// `sha256("account:ShareClass")[0..8]`. Hardcoded (the hook has no
/// `asset_registry` crate dependency); kept in sync by an assertion in the
/// asset_registry test suite, which links both crates.
pub const SHARE_CLASS_DISCRIMINATOR: [u8; 8] = [169, 98, 255, 104, 159, 47, 105, 6];

/// `true` iff the account's data begins with the `ShareClass` discriminator.
///
/// Together with the `owner == ASSET_REGISTRY_PROGRAM` constraint this proves
/// the co-signer really is a registry `ShareClass` account: an attacker can
/// place a keypair-signable account under the registry's ownership
/// (system `allocate` + `assign`), but such an account is all zeros and only
/// the asset_registry program itself can ever write the discriminator.
fn is_share_class_account(info: &AccountInfo) -> bool {
    match info.try_borrow_data() {
        Ok(data) => data.len() >= 8 && data[..8] == SHARE_CLASS_DISCRIMINATOR,
        Err(_) => false,
    }
}

/// asset_registry `ESCROW_SEED`: custody / offer / rights escrow token
/// accounts are PDAs `["escrow", parent]` under the registry, owned by
/// `parent`. Pinned by a cross-crate assertion in the asset_registry tests.
pub const REGISTRY_ESCROW_SEED: &[u8] = b"escrow";

/// The ONLY owner-block exception: the registry's permanent-delegate
/// quarantine clawback (`clawback_from_holder` / `clawback_blocklisted_holder`
/// — the only registry transfers the `ShareClass` PDA signs). The authority
/// must be a registry `ShareClass` account that is this mint's Token-2022
/// `PermanentDelegate`, and the destination a registry escrow token PDA
/// `["escrow", destination owner]`. `KycGated` also pins the authority to
/// `config.share_class`; the `Open` tail carries no config, so there the
/// mint's `PermanentDelegate` (fixed to its ShareClass at mint creation) is
/// the pin. Generic token delegates and the blocked owner never pass.
fn require_quarantine_clawback(
    mint_ai: &AccountInfo,
    destination_ai: &AccountInfo,
    destination_owner: &Pubkey,
    authority_ai: &AccountInfo,
    expected_share_class: Option<&Pubkey>,
) -> Result<()> {
    require!(
        authority_ai.owner == &ASSET_REGISTRY_PROGRAM && is_share_class_account(authority_ai),
        HookError::SenderBlocked
    );
    if let Some(share_class) = expected_share_class {
        require_keys_eq!(*authority_ai.key, *share_class, HookError::SenderBlocked);
    }
    require_keys_eq!(
        *mint_ai.owner,
        spl_token_2022_interface::ID,
        HookError::SenderBlocked
    );
    {
        let data = mint_ai.try_borrow_data()?;
        let mint = StateWithExtensions::<SplMint>::unpack(&data)?;
        let delegate = mint
            .get_extension::<PermanentDelegate>()
            .map_err(|_| error!(HookError::SenderBlocked))?;
        require!(
            Option::<Pubkey>::from(delegate.delegate) == Some(*authority_ai.key),
            HookError::SenderBlocked
        );
    }
    // Defense in depth (Open has no idx-10 marker): the destination must be a
    // registry escrow token account, never a wallet.
    let (escrow, _) = Pubkey::find_program_address(
        &[REGISTRY_ESCROW_SEED, destination_owner.as_ref()],
        &ASSET_REGISTRY_PROGRAM,
    );
    require_keys_eq!(*destination_ai.key, escrow, HookError::SenderBlocked);
    Ok(())
}

/// The Anchor account discriminator of `asset_registry::KycRegistry` —
/// `sha256("account:KycRegistry")[0..8]`. Hardcoded like
/// `SHARE_CLASS_DISCRIMINATOR`; pinned by a cross-crate assertion in the
/// asset_registry test suite.
pub const KYC_REGISTRY_DISCRIMINATOR: [u8; 8] = [204, 241, 19, 79, 46, 77, 56, 20];
/// Full `asset_registry::KycRegistry` account length (`8 + INIT_SPACE`) — the
/// minimum `update_transfer_hook_config` accepts for a named registry. Pinned
/// by the same cross-crate test.
pub const KYC_REGISTRY_ACCOUNT_LEN: usize = 306;

/// `true` iff `info` is a real `asset_registry::KycRegistry`: owned by the
/// registry program, full length, and carrying the `KycRegistry`
/// discriminator (only the registry program can write it, and only
/// `create_kyc_registry` — admin co-signed — creates one).
fn is_kyc_registry_account(info: &AccountInfo) -> bool {
    if info.owner != &ASSET_REGISTRY_PROGRAM {
        return false;
    }
    match info.try_borrow_data() {
        Ok(data) => {
            data.len() >= KYC_REGISTRY_ACCOUNT_LEN && data[..8] == KYC_REGISTRY_DISCRIMINATOR
        }
        Err(_) => false,
    }
}

/// A mode / registry pairing is coherent: `KycGated` must name a registry and
/// `Open` must not (an Open config naming a registry would be silently
/// ignored by `build_metas`, and mislead any reader of the config).
fn validate_mode_registry(mode: RestrictionMode, kyc_registry: Option<Pubkey>) -> Result<()> {
    match (mode, kyc_registry) {
        (RestrictionMode::KycGated, None) => err!(HookError::KycRegistryRequired),
        (RestrictionMode::Open, Some(_)) => err!(HookError::KycRegistryNotAllowed),
        _ => Ok(()),
    }
}

// ── asset_registry account byte layout (read by offset; no crate dependency) ──
//
// These offsets mirror `asset_registry::state::{KycEntry, KycRegistry}`. They
// are exercised by tests that fabricate the accounts; a layout drift there
// fails CI. The leading 8 bytes are the Anchor account discriminator.

/// `KycEntry.status` — `u8` at this offset. 0=Pending 1=Approved 2=Revoked 3=Expired.
const KYC_ENTRY_STATUS_OFFSET: usize = 72;
/// `KycEntry.jurisdiction` — `u16` LE.
const KYC_ENTRY_JURISDICTION_OFFSET: usize = 73;
/// `KycEntry.expiry` — `i64` LE unix timestamp.
const KYC_ENTRY_EXPIRY_OFFSET: usize = 76;
/// Minimum `KycEntry` data length (through `bump`).
const KYC_ENTRY_MIN_LEN: usize = 120;
/// `KycStatus::Approved` discriminant.
const KYC_STATUS_APPROVED: u8 = 1;

/// Size of every jurisdiction bitmap — mirrors
/// `asset_registry::state::JURISDICTION_BITMAP_BYTES` (1024 bits, the full
/// ISO-3166-1 numeric range incl. user-assigned 900–999).
const JURISDICTION_BITMAP_BYTES: usize = 128;
/// `KycRegistry.approved_jurisdictions` — `[u8; JURISDICTION_BITMAP_BYTES]` bitmap.
const KYC_REGISTRY_APPROVED_OFFSET: usize = 40;
/// `KycRegistry.blocked_jurisdictions` — `[u8; JURISDICTION_BITMAP_BYTES]` bitmap.
const KYC_REGISTRY_BLOCKED_OFFSET: usize = KYC_REGISTRY_APPROVED_OFFSET + JURISDICTION_BITMAP_BYTES;
/// Minimum `KycRegistry` data length (through both bitmaps).
const KYC_REGISTRY_MIN_LEN: usize = KYC_REGISTRY_BLOCKED_OFFSET + JURISDICTION_BITMAP_BYTES;

// ── KycEntry / KycRegistry offset readers ────────────────────────────────────
//
// Each bounds-checks the slice first and returns a `HookError` on short data,
// so a malformed or truncated account can never panic the hook.

/// Reads `KycEntry.status` (Approved == 1).
fn kyc_entry_status(data: &[u8]) -> Result<u8> {
    if data.len() < KYC_ENTRY_MIN_LEN {
        return err!(HookError::InvalidKycEntry);
    }
    Ok(data[KYC_ENTRY_STATUS_OFFSET])
}

/// Reads `KycEntry.jurisdiction` (`u16` LE).
fn kyc_entry_jurisdiction(data: &[u8]) -> Result<u16> {
    if data.len() < KYC_ENTRY_MIN_LEN {
        return err!(HookError::InvalidKycEntry);
    }
    let bytes: [u8; 2] = data[KYC_ENTRY_JURISDICTION_OFFSET..KYC_ENTRY_JURISDICTION_OFFSET + 2]
        .try_into()
        .map_err(|_| error!(HookError::InvalidKycEntry))?;
    Ok(u16::from_le_bytes(bytes))
}

/// Reads `KycEntry.expiry` (`i64` LE unix timestamp).
fn kyc_entry_expiry(data: &[u8]) -> Result<i64> {
    if data.len() < KYC_ENTRY_MIN_LEN {
        return err!(HookError::InvalidKycEntry);
    }
    let bytes: [u8; 8] = data[KYC_ENTRY_EXPIRY_OFFSET..KYC_ENTRY_EXPIRY_OFFSET + 8]
        .try_into()
        .map_err(|_| error!(HookError::InvalidKycEntry))?;
    Ok(i64::from_le_bytes(bytes))
}

/// Reads the registry's `(approved, blocked)` jurisdiction bitmaps.
fn kyc_registry_bitmaps(
    data: &[u8],
) -> Result<(
    [u8; JURISDICTION_BITMAP_BYTES],
    [u8; JURISDICTION_BITMAP_BYTES],
)> {
    if data.len() < KYC_REGISTRY_MIN_LEN {
        return err!(HookError::InvalidKycRegistry);
    }
    let approved: [u8; JURISDICTION_BITMAP_BYTES] = data
        [KYC_REGISTRY_APPROVED_OFFSET..KYC_REGISTRY_APPROVED_OFFSET + JURISDICTION_BITMAP_BYTES]
        .try_into()
        .map_err(|_| error!(HookError::InvalidKycRegistry))?;
    let blocked: [u8; JURISDICTION_BITMAP_BYTES] = data
        [KYC_REGISTRY_BLOCKED_OFFSET..KYC_REGISTRY_BLOCKED_OFFSET + JURISDICTION_BITMAP_BYTES]
        .try_into()
        .map_err(|_| error!(HookError::InvalidKycRegistry))?;
    Ok((approved, blocked))
}

/// Jurisdiction is allowed iff its bit is set in `approved` and clear in
/// `blocked` (blocked wins). Bit `j` lives at `approved[j/8] & (1 << (j%8))`.
fn jurisdiction_allowed(
    jurisdiction: u16,
    approved: &[u8; JURISDICTION_BITMAP_BYTES],
    blocked: &[u8; JURISDICTION_BITMAP_BYTES],
) -> bool {
    let byte = (jurisdiction / 8) as usize;
    let bit = (jurisdiction % 8) as u8;
    byte < JURISDICTION_BITMAP_BYTES
        && (approved[byte] & (1 << bit)) != 0
        && (blocked[byte] & (1 << bit)) == 0
}

#[program]
pub mod transfer_hook {
    use super::*;

    /// Creates the singleton blocklist authority. Call once at deployment; set
    /// `authority` to the Mancipatio admin multisig.
    pub fn initialize_blocklist_authority(
        ctx: Context<InitializeBlocklistAuthority>,
        authority: Pubkey,
    ) -> Result<()> {
        let ba = &mut ctx.accounts.blocklist_authority;
        ba.authority = authority;
        ba.bump = ctx.bumps.blocklist_authority;
        msg!("Blocklist authority set — {}", authority);
        Ok(())
    }

    /// Stages an operational authority change; does not affect ProgramData.
    pub fn propose_blocklist_authority(
        ctx: Context<ProposeBlocklistAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        let current = ctx.accounts.blocklist_authority.authority;
        require!(
            new_authority != Pubkey::default() && new_authority != current,
            HookError::InvalidProposedAuthority
        );
        let transfer = &mut ctx.accounts.transfer;
        transfer.current_authority = current;
        transfer.new_authority = new_authority;
        transfer.bump = ctx.bumps.transfer;
        Ok(())
    }

    pub fn accept_blocklist_authority(ctx: Context<AcceptBlocklistAuthority>) -> Result<()> {
        ctx.accounts.blocklist_authority.authority = ctx.accounts.new_authority.key();
        msg!(
            "Blocklist operational authority rotated — {}",
            ctx.accounts.new_authority.key()
        );
        Ok(())
    }

    /// Creates the per-mint transfer-hook config.
    ///
    /// Gated: the registry-owned `ShareClass` account must co-sign. Only the
    /// `asset_registry` program can produce that signature (CPI with the
    /// ShareClass PDA seeds), so an external wallet can no longer front-run a
    /// mint's config and fix its mode.
    pub fn initialize_transfer_hook_config(
        ctx: Context<InitializeTransferHookConfig>,
        blocklist: Pubkey,
        restriction_mode: RestrictionMode,
        kyc_registry: Option<Pubkey>,
    ) -> Result<()> {
        // No registry ACCOUNT is visible here, so a KycGated init cannot
        // validate the named registry. That path is reachable only through
        // asset_registry's ShareClass-co-signed CPI, which always passes
        // `(Open, None)` (`initialize_share_class_mint`); KycGated is reached
        // via `update_transfer_hook_config`, which does validate it.
        validate_mode_registry(restriction_mode, kyc_registry)?;

        let cfg = &mut ctx.accounts.config;
        cfg.mint = ctx.accounts.mint.key();
        cfg.share_class = ctx.accounts.share_class.key();
        cfg.blocklist = blocklist;
        cfg.restriction_mode = restriction_mode;
        cfg.kyc_registry = kyc_registry;
        cfg.version = 1;
        cfg.bump = ctx.bumps.config;

        msg!("Transfer hook config initialized — mint {}", cfg.mint);
        Ok(())
    }

    /// Writes the `ExtraAccountMetaList` PDA that tells Token-2022 which extra
    /// accounts to resolve and pass to `Execute`. The list content is fixed by
    /// this program (and by the mint's `restriction_mode`), so the instruction
    /// needs no authority gate. Creation is pre-fund-safe: a PDA that already
    /// holds lamports (griefing transfer) is topped up / allocated / assigned
    /// rather than `create_account`-ed, so it can never block initialization.
    ///
    /// Always emits idx 5: the source-owner `BlockEntry` PDA (resolved from
    /// the source token account at Execute idx 0, data offset 32).
    ///
    /// In `KycGated` mode it also emits the accounts needed to check the
    /// receiver's KYC:
    ///   * idx 6 — this program's `TransferHookConfig` self-PDA (`["hook_cfg", mint]`),
    ///   * idx 7 — the `KycRegistry`, baked from `config.kyc_registry`,
    ///   * idx 8 — the `asset_registry` program (owner of the KYC accounts),
    ///   * idx 9 — the receiver `KycEntry` external PDA `["kyc", registry, holder]`,
    ///     whose `holder` is read from the destination token account's `owner`
    ///     field (Execute idx 2, data offset 32),
    ///   * idx 10 — the destination-owner `EscrowMarker` external PDA
    ///     `["escrow_marker", dest owner]` (same AccountData source as idx 9),
    ///   * idx 11 — the source-owner `EscrowMarker` external PDA
    ///     `["escrow_marker", source owner]` (source token account, Execute
    ///     idx 0, data offset 32).
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        let metas = build_metas(config.restriction_mode, config.kyc_registry)?;

        let size = ExtraAccountMetaList::size_of(metas.len())?;
        let mint = ctx.accounts.mint.key();
        let bump = ctx.bumps.extra_account_meta_list;
        let signer_seeds: &[&[&[u8]]] = &[&[EXTRA_METAS_SEED, mint.as_ref(), &[bump]]];

        let metas_ai = ctx.accounts.extra_account_meta_list.to_account_info();
        let required_lamports = Rent::get()?.minimum_balance(size);
        let current_lamports = metas_ai.lamports();

        if current_lamports == 0 {
            create_account(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    CreateAccount {
                        from: ctx.accounts.payer.to_account_info(),
                        to: metas_ai.clone(),
                    },
                )
                .with_signer(signer_seeds),
                required_lamports,
                size as u64,
                ctx.program_id,
            )?;
        } else {
            // The PDA already holds lamports. Its address is public and
            // anyone can transfer to it, so a raw `create_account` (which
            // fails with AccountAlreadyInUse on any non-zero balance) would
            // let a 1-lamport grief permanently block this call — and, since
            // `initialize_share_class_mint` CPIs here atomically, block the
            // share class's mint creation forever. Use the pre-fund-safe
            // pattern Anchor `init` uses instead: top up to rent-exemption,
            // then allocate + assign with the PDA signing.
            let top_up = required_lamports.saturating_sub(current_lamports);
            if top_up > 0 {
                transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.key(),
                        Transfer {
                            from: ctx.accounts.payer.to_account_info(),
                            to: metas_ai.clone(),
                        },
                    ),
                    top_up,
                )?;
            }
            allocate(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Allocate {
                        account_to_allocate: metas_ai.clone(),
                    },
                )
                .with_signer(signer_seeds),
                size as u64,
            )?;
            assign(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Assign {
                        account_to_assign: metas_ai.clone(),
                    },
                )
                .with_signer(signer_seeds),
                ctx.program_id,
            )?;
        }

        let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;

        msg!("ExtraAccountMetaList initialized — mint {}", mint);
        Ok(())
    }

    /// Switches a mint's `restriction_mode` (Open ↔ KycGated) after creation
    /// and rewrites the `ExtraAccountMetaList` to the matching shape — a
    /// super-admin operation gated by the `BlocklistAuthority`.
    ///
    /// The meta-list account is resized in place: grown (topped up to
    /// rent-exemption by `authority`) for Open → KycGated, shrunk for
    /// KycGated → Open (no lamport refund — the account simply stays above
    /// its rent-exempt minimum).
    ///
    /// A named registry must be passed as `kyc_registry_account` and must be a
    /// real `asset_registry::KycRegistry` (owner, discriminator, length);
    /// Open mode must name none and pass none.
    pub fn update_transfer_hook_config(
        ctx: Context<UpdateTransferHookConfig>,
        restriction_mode: RestrictionMode,
        kyc_registry: Option<Pubkey>,
    ) -> Result<()> {
        validate_mode_registry(restriction_mode, kyc_registry)?;
        match (kyc_registry, ctx.accounts.kyc_registry_account.as_ref()) {
            (Some(key), Some(ai)) => require!(
                ai.key() == key && is_kyc_registry_account(&ai.to_account_info()),
                HookError::InvalidKycRegistry
            ),
            (Some(_), None) => return err!(HookError::InvalidKycRegistry),
            (None, Some(_)) => return err!(HookError::KycRegistryNotAllowed),
            (None, None) => {}
        }

        let cfg = &mut ctx.accounts.config;
        let old_mode = cfg.restriction_mode;
        cfg.restriction_mode = restriction_mode;
        cfg.kyc_registry = kyc_registry;
        cfg.version = cfg.version.saturating_add(1);

        // Rebuild the meta list for the new mode and resize the account.
        let metas = build_metas(restriction_mode, kyc_registry)?;
        let new_size = ExtraAccountMetaList::size_of(metas.len())?;
        let metas_ai = ctx.accounts.extra_account_meta_list.to_account_info();
        let old_size = metas_ai.data_len();

        if new_size > old_size {
            // Growing: top up to rent-exemption BEFORE the resize, then let
            // the TLV update expand the list into the new zeroed tail.
            let required = Rent::get()?.minimum_balance(new_size);
            let top_up = required.saturating_sub(metas_ai.lamports());
            if top_up > 0 {
                anchor_lang::system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.key(),
                        anchor_lang::system_program::Transfer {
                            from: ctx.accounts.authority.to_account_info(),
                            to: metas_ai.clone(),
                        },
                    ),
                    top_up,
                )?;
            }
            metas_ai.resize(new_size)?;
            let mut data = metas_ai.try_borrow_mut_data()?;
            ExtraAccountMetaList::update::<ExecuteInstruction>(&mut data, &metas)?;
        } else {
            // Shrinking (or equal): rewrite within the old buffer first — the
            // TLV update compacts and zero-fills the tail — then truncate.
            // No lamport refund on shrink (kept simple; account stays
            // rent-exempt).
            {
                let mut data = metas_ai.try_borrow_mut_data()?;
                ExtraAccountMetaList::update::<ExecuteInstruction>(&mut data, &metas)?;
            }
            metas_ai.resize(new_size)?;
        }

        msg!(
            "Transfer hook config updated — mint {} mode {:?} -> {:?} ({} metas, v{})",
            ctx.accounts.config.mint,
            old_mode,
            restriction_mode,
            metas.len(),
            ctx.accounts.config.version
        );
        Ok(())
    }

    /// Adds a wallet to the blocklist. Only the `BlocklistAuthority` may call it.
    pub fn add_to_blocklist(ctx: Context<AddToBlocklist>, wallet: Pubkey) -> Result<()> {
        let entry = &mut ctx.accounts.block_entry;
        entry.wallet = wallet;
        entry.added_by = ctx.accounts.authority.key();
        entry.bump = ctx.bumps.block_entry;
        msg!("Blocklisted {}", wallet);
        Ok(())
    }

    /// Removes a wallet from the blocklist. Only the `BlocklistAuthority` may call it.
    pub fn remove_from_blocklist(_ctx: Context<RemoveFromBlocklist>, wallet: Pubkey) -> Result<()> {
        msg!("Removed {} from blocklist", wallet);
        Ok(())
    }

    /// Token-2022 dispatches the transfer-hook `Execute` instruction here: its
    /// SPL discriminator matches no Anchor instruction, so it lands in fallback.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let ix = TransferHookInstruction::unpack(data)
            .map_err(|_| error!(HookError::InvalidInstruction))?;
        match ix {
            TransferHookInstruction::Execute { amount } => {
                process_execute(program_id, accounts, amount)
            }
            _ => err!(HookError::InvalidInstruction),
        }
    }
}

/// Builds the `ExtraAccountMeta` vec whose shape is fixed by the mode:
/// `Open` = 1 meta (source `BlockEntry`, Execute idx 5); `KycGated` = 7 metas
/// (adds config, `KycRegistry`, asset_registry program, receiver `KycEntry`,
/// destination-owner `EscrowMarker`, source-owner `EscrowMarker` — Execute
/// idx 6–11). Shared by `initialize_extra_account_meta_list` and
/// `update_transfer_hook_config`.
fn build_metas(
    mode: RestrictionMode,
    kyc_registry: Option<Pubkey>,
) -> Result<Vec<ExtraAccountMeta>> {
    // idx 5 — source `BlockEntry` (always present; the Open-mode shape).
    let mut metas = vec![ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal {
                bytes: BLOCK_ENTRY_SEED.to_vec(),
            },
            Seed::AccountData {
                account_index: 0,
                data_index: 32,
                length: 32,
            }, // source owner
        ],
        false, // is_signer
        false, // is_writable
    )?];

    if mode == RestrictionMode::KycGated {
        // Guaranteed `Some` for KycGated by the config init / update handlers.
        let registry = kyc_registry.ok_or(error!(HookError::KycRegistryRequired))?;

        // idx 6 — this program's `TransferHookConfig` self-PDA.
        metas.push(ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: HOOK_CONFIG_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 }, // mint
            ],
            false,
            false,
        )?);
        // idx 7 — the `KycRegistry`, as a fixed account from config.
        metas.push(ExtraAccountMeta::new_with_pubkey(&registry, false, false)?);
        // idx 8 — the `asset_registry` program (owner of the KYC accounts).
        metas.push(ExtraAccountMeta::new_with_pubkey(
            &ASSET_REGISTRY_PROGRAM,
            false,
            false,
        )?);
        // idx 9 — receiver `KycEntry`, an external PDA on `asset_registry`
        // (program account at idx 8): seeds ["kyc", registry(idx 7),
        // holder = destination owner (idx 2, data offset 32, len 32)].
        metas.push(ExtraAccountMeta::new_external_pda_with_seeds(
            8, // index of the owning program in the account list
            &[
                Seed::Literal {
                    bytes: KYC_ENTRY_SEED.to_vec(),
                },
                Seed::AccountKey { index: 7 }, // registry
                Seed::AccountData {
                    account_index: 2, // destination token account
                    data_index: 32,   // Token-2022 `owner` offset
                    length: 32,
                },
            ],
            false,
            false,
        )?);
        // idx 10 — destination-owner `EscrowMarker`, an external PDA on
        // asset_registry: ["escrow_marker", destination token-account owner
        // (idx 2, data offset 32, len 32)]. Resolved iff the destination is a
        // platform escrow (deal / offer / vault / distribution PDA owner).
        metas.push(ExtraAccountMeta::new_external_pda_with_seeds(
            8,
            &[
                Seed::Literal {
                    bytes: ESCROW_MARKER_SEED.to_vec(),
                },
                Seed::AccountData {
                    account_index: 2, // destination token account
                    data_index: 32,   // Token-2022 `owner` offset
                    length: 32,
                },
            ],
            false,
            false,
        )?);
        // idx 11 — source-owner `EscrowMarker`: same seeds but keyed on the
        // source token account's owner (idx 0). Resolved iff the source is a
        // platform escrow (settle / refund / return legs).
        metas.push(ExtraAccountMeta::new_external_pda_with_seeds(
            8,
            &[
                Seed::Literal {
                    bytes: ESCROW_MARKER_SEED.to_vec(),
                },
                Seed::AccountData {
                    account_index: 0, // source token account
                    data_index: 32,   // Token-2022 `owner` offset
                    length: 32,
                },
            ],
            false,
            false,
        )?);
    }

    Ok(metas)
}

/// Execute accounts (Token-2022 transfer-hook interface):
///   0 source · 1 mint · 2 destination · 3 source authority ·
///   4 ExtraAccountMetaList · 5 source `BlockEntry` (resolved from the list).
///
/// In `KycGated` mode the list also resolves (and Token-2022 passes):
///   6 `TransferHookConfig` · 7 `KycRegistry` · 8 asset_registry program ·
///   9 receiver `KycEntry` · 10 destination-owner `EscrowMarker` ·
///   11 source-owner `EscrowMarker`.
fn process_execute(program_id: &Pubkey, accounts: &[AccountInfo], _amount: u64) -> Result<()> {
    let source_ai = accounts
        .first()
        .ok_or(error!(HookError::MissingExtraAccount))?;
    let mint_ai = accounts
        .get(1)
        .ok_or(error!(HookError::MissingExtraAccount))?;
    let destination_ai = accounts
        .get(2)
        .ok_or(error!(HookError::MissingExtraAccount))?;
    let authority_ai = accounts
        .get(3)
        .ok_or(error!(HookError::MissingExtraAccount))?;
    require_keys_eq!(
        *source_ai.owner,
        spl_token_2022_interface::ID,
        HookError::InvalidTokenAccount
    );
    require_keys_eq!(
        *destination_ai.owner,
        spl_token_2022_interface::ID,
        HookError::InvalidTokenAccount
    );
    let source_owner = {
        let data = source_ai.try_borrow_data()?;
        StateWithExtensions::<SplTokenAccount>::unpack(&data)?
            .base
            .owner
    };
    let destination_owner = {
        let data = destination_ai.try_borrow_data()?;
        let destination = StateWithExtensions::<SplTokenAccount>::unpack(&data)?;
        // This includes every escrow: routing exemptions must never permit
        // owner reassignment to evade either KYC or the owner blocklist.
        require!(
            destination.get_extension::<ImmutableOwner>().is_ok(),
            HookError::ImmutableOwnerRequired
        );
        destination.base.owner
    };
    let source_block_entry = accounts
        .get(5)
        .ok_or(error!(HookError::MissingExtraAccount))?;
    let (expected_block_entry, _) =
        Pubkey::find_program_address(&[BLOCK_ENTRY_SEED, source_owner.as_ref()], program_id);
    require_keys_eq!(
        *source_block_entry.key,
        expected_block_entry,
        HookError::InvalidBlockEntry
    );
    let blocked = source_block_entry.owner == program_id && !source_block_entry.data_is_empty();

    // Open mode has no config tail. Ordinary delegates never replace the
    // source owner for sanctions checks, including when the owner delegated
    // their tokens before being blocked; a blocked source leaves only via the
    // registry's permanent-delegate quarantine clawback. Here the hook can
    // only prove "ShareClass-signed, into SOME registry escrow PDA": that it
    // is the burn-only quarantine vault relies on asset_registry signing as
    // the ShareClass solely in `util::seize_into_quarantine` (whose callers
    // pin the vault) and never calling SetAuthority — guarded there by
    // `share_class_signs_only_the_quarantine_transfer`.
    let Some(config_ai) = accounts.get(6).filter(|ai| ai.owner == program_id) else {
        if blocked {
            require_quarantine_clawback(
                mint_ai,
                destination_ai,
                &destination_owner,
                authority_ai,
                None,
            )?;
        }
        return Ok(());
    };
    let config = {
        let data = config_ai.try_borrow_data()?;
        TransferHookConfig::try_deserialize(&mut data.as_ref())?
    };
    let (expected_config, _) =
        Pubkey::find_program_address(&[HOOK_CONFIG_SEED, mint_ai.key.as_ref()], program_id);
    require_keys_eq!(*config_ai.key, expected_config, HookError::Unauthorized);
    require_keys_eq!(config.mint, *mint_ai.key, HookError::Unauthorized);
    if config.restriction_mode != RestrictionMode::KycGated {
        if blocked {
            require_quarantine_clawback(
                mint_ai,
                destination_ai,
                &destination_owner,
                authority_ai,
                Some(&config.share_class),
            )?;
        }
        return Ok(());
    }
    // None = no proven identity; Some(None) = general platform routing;
    // Some(Some(owner)) = identity-only escrow with a named refund route.
    let marker_policy = |idx: usize, owner: &Pubkey| -> Option<Option<Pubkey>> {
        let expected = Pubkey::find_program_address(
            &[ESCROW_MARKER_SEED, owner.as_ref()],
            &ASSET_REGISTRY_PROGRAM,
        )
        .0;
        let ai = accounts.get(idx)?;
        if *ai.key != expected || ai.owner != &ASSET_REGISTRY_PROGRAM {
            return None;
        }
        let data = ai.try_borrow_data().ok()?;
        if data.len() >= 9 && data[..8] == ESCROW_MARKER_DISCRIMINATOR {
            return Some(None);
        }
        if data.len() >= 57 && data[..8] == ESCROW_IDENTITY_DISCRIMINATOR {
            return Some(Some(Pubkey::new_from_array(data[8..40].try_into().ok()?)));
        }
        None
    };
    let destination_is_escrow = marker_policy(10, &destination_owner).is_some();
    let source_routing_exempt = match marker_policy(11, &source_owner) {
        Some(None) => true,
        Some(Some(refund_owner)) => {
            refund_owner != Pubkey::default() && refund_owner == destination_owner
        }
        None => false,
    };
    if blocked {
        // The only owner-block exception is registry enforcement into escrow:
        // the registry's two PermanentDelegate transfer instructions pin this
        // destination to an active burn-only quarantine vault and the holder
        // to revoked/expired KYC or a live BlockEntry. Generic token delegates
        // cannot use this route.
        require!(destination_is_escrow, HookError::SenderBlocked);
        require_quarantine_clawback(
            mint_ai,
            destination_ai,
            &destination_owner,
            authority_ai,
            Some(&config.share_class),
        )?;
    }

    // ── Escrow-marker exemption (platform-mediated escrow legs) ──────────────
    //
    // idx 10 / 11 resolve `["escrow_marker", token-account owner]` under the
    // asset_registry program for the destination / source owner respectively.
    // A valid registry EscrowMarker discriminator proves that owner is a
    // registry escrow authority PDA (OTC deal / offer / custody vault /
    // distribution) — only the asset_registry program can create accounts it
    // owns at those seeds, and it does so exclusively for its escrow parents.
    // Such a leg is platform-mediated (deposit into, or settle/refund out of,
    // a program escrow), so the receiver-KYC checks here are skipped — an
    // escrow PDA can never hold a `KycEntry`, so without this no deposit could
    // ever settle. This is NOT a verdict on the wallet at the far end of an
    // escrow→wallet leg: every such delivery re-derives receiver eligibility
    // in `asset_registry` itself (`take_offer`, `settle_otc_deal`, and the
    // part of every refund leg that exceeds the payee's recorded deposit —
    // `util::split_escrow_release`) — see the module doc. Note idx 10 also
    // means ANYONE may raw-`transfer_checked` INTO any escrow; that is why the
    // exits key on a per-escrow deposit ledger rather than on the balance. An
    // unresolved marker is system-owned ⇒ no exemption — direct wallet↔wallet
    // transfers stay gated. The owner blocklist (above) only exempts authenticated quarantine enforcement.
    if destination_is_escrow || source_routing_exempt {
        return Ok(());
    }

    // KycGated: the receiver must hold a valid `KycEntry` in `config.kyc_registry`.
    let registry_ai = accounts
        .get(7)
        .ok_or(error!(HookError::MissingExtraAccount))?;
    let entry_ai = accounts
        .get(9)
        .ok_or(error!(HookError::MissingExtraAccount))?;

    // The registry passed must be the one this mint is configured for.
    let expected_registry = config
        .kyc_registry
        .ok_or(error!(HookError::KycRegistryRequired))?;
    require_keys_eq!(
        *registry_ai.key,
        expected_registry,
        HookError::InvalidKycRegistry
    );

    // The entry must be an initialised account owned by the asset_registry
    // program — an unresolved (system-owned) or empty PDA means "no KYC".
    require!(
        entry_ai.owner == &ASSET_REGISTRY_PROGRAM && !entry_ai.data_is_empty(),
        HookError::ReceiverNotApproved
    );
    require!(
        registry_ai.owner == &ASSET_REGISTRY_PROGRAM && !registry_ai.data_is_empty(),
        HookError::InvalidKycRegistry
    );

    let entry_data = entry_ai.try_borrow_data()?;
    require!(
        kyc_entry_status(&entry_data)? == KYC_STATUS_APPROVED,
        HookError::ReceiverNotApproved
    );
    require!(
        kyc_entry_expiry(&entry_data)? > Clock::get()?.unix_timestamp,
        HookError::HolderKycExpired
    );
    let jurisdiction = kyc_entry_jurisdiction(&entry_data)?;

    let registry_data = registry_ai.try_borrow_data()?;
    let (approved, blocked) = kyc_registry_bitmaps(&registry_data)?;
    require!(
        jurisdiction_allowed(jurisdiction, &approved, &blocked),
        HookError::JurisdictionBlocked
    );

    Ok(())
}

// ── Accounts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeBlocklistAuthority<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + BlocklistAuthority::INIT_SPACE,
        seeds = [BLOCKLIST_AUTHORITY_SEED],
        bump
    )]
    pub blocklist_authority: Account<'info, BlocklistAuthority>,

    pub system_program: Program<'info, System>,

    /// Deployment authority authorizes the initial blocklist administrator.
    pub upgrade_authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ HookError::Unauthorized)]
    pub program: Program<'info, crate::program::TransferHook>,
    #[account(constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ HookError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
}

#[derive(Accounts)]
pub struct ProposeBlocklistAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [BLOCKLIST_AUTHORITY_SEED], bump = blocklist_authority.bump,
        has_one = authority @ HookError::Unauthorized)]
    pub blocklist_authority: Account<'info, BlocklistAuthority>,
    #[account(init_if_needed, payer = authority, space = 8 + BlocklistAuthorityTransfer::INIT_SPACE,
        seeds = [BLOCKLIST_AUTHORITY_TRANSFER_SEED], bump)]
    pub transfer: Account<'info, BlocklistAuthorityTransfer>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptBlocklistAuthority<'info> {
    #[account(mut)]
    pub new_authority: Signer<'info>,
    #[account(mut, seeds = [BLOCKLIST_AUTHORITY_SEED], bump = blocklist_authority.bump)]
    pub blocklist_authority: Account<'info, BlocklistAuthority>,
    #[account(mut, close = new_authority, seeds = [BLOCKLIST_AUTHORITY_TRANSFER_SEED], bump = transfer.bump,
        constraint = transfer.current_authority == blocklist_authority.authority && transfer.new_authority == new_authority.key() @ HookError::InvalidAuthorityTransfer)]
    pub transfer: Account<'info, BlocklistAuthorityTransfer>,
}

#[account]
#[derive(InitSpace)]
pub struct BlocklistAuthorityTransfer {
    pub current_authority: Pubkey,
    pub new_authority: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializeTransferHookConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: only the key is used, as the `["hook_cfg", mint]` PDA seed.
    pub mint: UncheckedAccount<'info>,

    /// The `asset_registry`-owned `ShareClass` account for this mint, as a
    /// co-signer. A `ShareClass` is a PDA — it has no private key — so this
    /// signature can only come from the asset_registry program's own CPI
    /// (`invoke_signed` with the ShareClass seeds). The discriminator check
    /// rejects registry-owned-but-keypair-signable shells created via system
    /// `allocate`+`assign` (their data is all zeros).
    #[account(
        constraint = share_class.owner == &ASSET_REGISTRY_PROGRAM @ HookError::Unauthorized,
        constraint = is_share_class_account(&share_class) @ HookError::Unauthorized,
    )]
    pub share_class: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + TransferHookConfig::INIT_SPACE,
        seeds = [HOOK_CONFIG_SEED, mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, TransferHookConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateTransferHookConfig<'info> {
    /// Must be the `BlocklistAuthority.authority` (Mancipatio admin multisig);
    /// pays the rent top-up when the meta list grows.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [BLOCKLIST_AUTHORITY_SEED],
        bump = blocklist_authority.bump,
        constraint = blocklist_authority.authority == authority.key() @ HookError::Unauthorized,
    )]
    pub blocklist_authority: Account<'info, BlocklistAuthority>,

    /// CHECK: only the key is used, as the `["hook_cfg", mint]` PDA seed.
    pub mint: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [HOOK_CONFIG_SEED, mint.key().as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, TransferHookConfig>,

    /// CHECK: the ExtraAccountMetaList PDA — must already exist (owned by this
    /// program, i.e. initialized); resized and rewritten in the handler.
    #[account(
        mut,
        seeds = [EXTRA_METAS_SEED, mint.key().as_ref()],
        bump,
        constraint = extra_account_meta_list.owner == &crate::ID @ HookError::MetaListNotInitialized,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// The `KycRegistry` the `kyc_registry` argument names: required iff the
    /// argument is `Some`, and its key must equal it. Appended LAST so the
    /// existing account order is kept.
    /// CHECK: owner / discriminator / length are validated in the handler.
    pub kyc_registry_account: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: only the key is used, as the extra-account-metas PDA seed.
    pub mint: UncheckedAccount<'info>,

    /// Per-mint config — its `restriction_mode` / `kyc_registry` fix the shape
    /// of the meta list written here.
    #[account(
        seeds = [HOOK_CONFIG_SEED, mint.key().as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, TransferHookConfig>,

    /// CHECK: the ExtraAccountMetaList PDA — created and written in the handler.
    #[account(
        mut,
        seeds = [EXTRA_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct AddToBlocklist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [BLOCKLIST_AUTHORITY_SEED],
        bump = blocklist_authority.bump,
        constraint = blocklist_authority.authority == authority.key() @ HookError::Unauthorized,
    )]
    pub blocklist_authority: Account<'info, BlocklistAuthority>,

    #[account(
        init,
        payer = authority,
        space = 8 + BlockEntry::INIT_SPACE,
        seeds = [BLOCK_ENTRY_SEED, wallet.as_ref()],
        bump
    )]
    pub block_entry: Account<'info, BlockEntry>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RemoveFromBlocklist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [BLOCKLIST_AUTHORITY_SEED],
        bump = blocklist_authority.bump,
        constraint = blocklist_authority.authority == authority.key() @ HookError::Unauthorized,
    )]
    pub blocklist_authority: Account<'info, BlocklistAuthority>,

    #[account(
        mut,
        close = authority,
        seeds = [BLOCK_ENTRY_SEED, wallet.as_ref()],
        bump = block_entry.bump
    )]
    pub block_entry: Account<'info, BlockEntry>,
}

// ── State ────────────────────────────────────────────────────────────────────

/// Singleton — the wallet authorised to administer the blocklist (a Mancipatio
/// admin multisig). Seeds: `["blocklist_authority"]`.
#[account]
#[derive(InitSpace)]
pub struct BlocklistAuthority {
    pub authority: Pubkey,
    pub bump: u8,
}

/// Per-mint transfer-hook config. Seeds: `["hook_cfg", mint]`.
#[account]
#[derive(InitSpace)]
pub struct TransferHookConfig {
    pub mint: Pubkey,
    pub share_class: Pubkey,
    /// Blocklist registry consulted on every transfer (sanctions / court order).
    pub blocklist: Pubkey,
    pub restriction_mode: RestrictionMode,
    /// Required when `restriction_mode == KycGated`, and must be `None` for
    /// `Open` (both enforced). `update_transfer_hook_config` also verifies the
    /// named account is a real `asset_registry::KycRegistry`. Pinned by
    /// ADDRESS: a registry's authority can rotate without moving it.
    pub kyc_registry: Option<Pubkey>,
    pub version: u8,
    pub bump: u8,
}

/// Blocklist entry. Existence of this PDA = the wallet is blocked.
/// Seeds: `["blocked", wallet]`.
#[account]
#[derive(InitSpace)]
pub struct BlockEntry {
    pub wallet: Pubkey,
    pub added_by: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RestrictionMode {
    /// Default — only the blocklist is enforced; the token trades freely.
    Open,
    /// VIP-issuer opt-in — receiver must hold a valid `KycEntry` in `kyc_registry`.
    KycGated,
}

#[error_code]
pub enum HookError {
    #[msg("KycGated restriction mode requires a kyc_registry")]
    KycRegistryRequired,
    #[msg("Unsupported transfer-hook instruction")]
    InvalidInstruction,
    #[msg("Expected extra account was not provided")]
    MissingExtraAccount,
    #[msg("Sender is on the blocklist")]
    SenderBlocked,
    #[msg("Signer is not the blocklist authority")]
    Unauthorized,
    #[msg("Receiver has no approved KYC entry in the registry")]
    ReceiverNotApproved,
    #[msg("Receiver's KYC entry has expired")]
    HolderKycExpired,
    #[msg("Receiver's jurisdiction is not allowed by the registry")]
    JurisdictionBlocked,
    #[msg("KYC entry account is malformed or truncated")]
    InvalidKycEntry,
    #[msg("KYC registry account is malformed, truncated, or unexpected")]
    InvalidKycRegistry,
    #[msg("ExtraAccountMetaList must be initialized before it can be updated")]
    MetaListNotInitialized,
    #[msg("Share-token recipients must have the Token-2022 ImmutableOwner extension")]
    ImmutableOwnerRequired,
    #[msg("Expected a Token-2022 token account")]
    InvalidTokenAccount,
    #[msg("BlockEntry must be derived from the source token-account owner")]
    InvalidBlockEntry,
    #[msg("Proposed authority must be a different nonzero key")]
    InvalidProposedAuthority,
    #[msg("Authority proposal does not match current authority and accepting signer")]
    InvalidAuthorityTransfer,
    #[msg("Open restriction mode must not name a KYC registry")]
    KycRegistryNotAllowed,
}
