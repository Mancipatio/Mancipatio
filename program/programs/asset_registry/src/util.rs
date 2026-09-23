//! Shared on-chain helpers.

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};
use anchor_spl::token_2022::{
    self,
    spl_token_2022::{
        extension::{
            immutable_owner::ImmutableOwner, BaseStateWithExtensions, ExtensionType,
            StateWithExtensions,
        },
        state::{Account as SplTokenAccount, Mint as SplMint},
    },
};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TransferChecked};
use solana_sha256_hasher::hashv;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{KycEntry, KycRegistry, KycStatus, OtcDeal, ShareClass};

/// Supported first-release mint policy. Ledgers and quotes use base units;
/// extension-dependent fees, display scaling and external transfer control are
/// rejected before accepting new funds. Existing refund instructions keep their
/// original exit semantics and are not made conditional on a new allowlist.
pub fn require_supported_mint(
    mint: &AccountInfo,
    token_program: &Pubkey,
    allow_share_hook: bool,
) -> Result<()> {
    use anchor_spl::token_2022::spl_token_2022::extension::{
        permanent_delegate::PermanentDelegate, transfer_hook::TransferHook,
    };
    require_keys_eq!(*mint.owner, *token_program, RegistryError::Unauthorized);
    if *token_program == anchor_spl::token::ID {
        return Ok(());
    }
    require_keys_eq!(*token_program, token_2022::ID, RegistryError::Unauthorized);
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<SplMint>::unpack(&data)?;
    let authentic_share_mint = || -> bool {
        let Some(authority) = Option::<Pubkey>::from(state.base.mint_authority) else {
            return false;
        };
        let expected =
            Pubkey::find_program_address(&[SHARE_MINT_SEED, authority.as_ref()], &crate::ID).0;
        if expected != *mint.key {
            return false;
        }
        let Ok(hook) = state.get_extension::<TransferHook>() else {
            return false;
        };
        let Ok(delegate) = state.get_extension::<PermanentDelegate>() else {
            return false;
        };
        Option::<Pubkey>::from(hook.program_id) == Some(TRANSFER_HOOK_PROGRAM)
            && Option::<Pubkey>::from(hook.authority) == Some(authority)
            && Option::<Pubkey>::from(delegate.delegate) == Some(authority)
    };
    for extension in state.get_extension_types()? {
        let allowed = match extension {
            ExtensionType::Uninitialized
            | ExtensionType::MintCloseAuthority
            | ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata
            | ExtensionType::GroupPointer
            | ExtensionType::TokenGroup
            | ExtensionType::GroupMemberPointer
            | ExtensionType::TokenGroupMember => true,
            ExtensionType::TransferHook | ExtensionType::PermanentDelegate => {
                allow_share_hook && authentic_share_mint()
            }
            _ => false,
        };
        require!(allowed, RegistryError::UnsupportedMintExtension);
    }
    Ok(())
}

/// Plain payment legs have no hook-account resolver and accept no hook/delegate.
pub fn payment_escrow_space(mint: &AccountInfo, token_program: &Pubkey) -> Result<usize> {
    require_supported_mint(mint, token_program, false)?;
    token_escrow_space(mint, token_program)
}

/// Allocate every new Token-2022 escrow with a fixed owner. Holder accounts and
/// escrows obey the same hook invariant; no off-curve-owner exception is needed.
/// Legacy payment/vesting token accounts keep the standard SPL layout.
pub fn token_escrow_space(mint: &AccountInfo, token_program: &Pubkey) -> Result<usize> {
    require_supported_mint(mint, token_program, true)?;
    require_keys_eq!(*mint.owner, *token_program, RegistryError::Unauthorized);
    if *token_program == anchor_spl::token::ID {
        return Ok(165);
    }
    require_keys_eq!(*token_program, token_2022::ID, RegistryError::Unauthorized);
    let data = mint.try_borrow_data()?;
    let mint_state = StateWithExtensions::<SplMint>::unpack(&data)?;
    let mut extensions =
        ExtensionType::get_required_init_account_extensions(&mint_state.get_extension_types()?);
    extensions.push(ExtensionType::ImmutableOwner);
    Ok(ExtensionType::try_calculate_account_len::<SplTokenAccount>(
        &extensions,
    )?)
}

/// Called immediately after Anchor allocates the uninitialized token PDA.
pub fn initialize_token_escrow<'info>(
    account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    if *token_program.key == token_2022::ID {
        token_2022::initialize_immutable_owner(CpiContext::new(
            *token_program.key,
            token_2022::InitializeImmutableOwner {
                account: account.clone(),
            },
        ))?;
    }
    token_2022::initialize_account3(CpiContext::new(
        *token_program.key,
        token_2022::InitializeAccount3 {
            account: account.clone(),
            mint: mint.clone(),
            authority: authority.clone(),
        },
    ))
}

/// MintTo bypasses transfer hooks, so primary and treasury issuance must enforce
/// the same immutable-holder invariant explicitly before increasing supply.
pub fn require_immutable_owner(account: &AccountInfo) -> Result<()> {
    require_keys_eq!(
        *account.owner,
        token_2022::ID,
        RegistryError::ImmutableOwnerRequired
    );
    let data = account.try_borrow_data()?;
    let state = StateWithExtensions::<SplTokenAccount>::unpack(&data)?;
    require!(
        state.get_extension::<ImmutableOwner>().is_ok(),
        RegistryError::ImmutableOwnerRequired
    );
    Ok(())
}

/// Checks a live global Admin record, including its key, owner and contents.
pub fn is_active_admin(proof: &AccountInfo, authority: &Pubkey) -> bool {
    let expected = Pubkey::find_program_address(&[ADMIN_SEED, authority.as_ref()], &crate::ID).0;
    if *proof.key != expected || proof.owner != &crate::ID {
        return false;
    }
    let Ok(data) = proof.try_borrow_data() else {
        return false;
    };
    crate::state::Admin::try_deserialize(&mut data.as_ref())
        .map(|record| record.admin == *authority)
        .unwrap_or(false)
}

/// Existing platform operators may use their global role; an external issuer
/// may instead carry only the capability granted for this issuer and authority.
pub fn require_issuer_permission(
    proof: &AccountInfo,
    issuer: &Account<crate::state::Issuer>,
    authority: &Pubkey,
    capability: u8,
) -> Result<()> {
    require_keys_eq!(issuer.authority, *authority, RegistryError::Unauthorized);
    if is_active_admin(proof, authority) {
        return Ok(());
    }
    let expected = Pubkey::find_program_address(
        &[
            ISSUER_PERMISSIONS_SEED,
            issuer.key().as_ref(),
            authority.as_ref(),
        ],
        &crate::ID,
    )
    .0;
    require_keys_eq!(*proof.key, expected, RegistryError::Unauthorized);
    require!(proof.owner == &crate::ID, RegistryError::Unauthorized);
    let data = proof.try_borrow_data()?;
    let permissions = crate::state::IssuerPermissions::try_deserialize(&mut data.as_ref())
        .map_err(|_| error!(RegistryError::Unauthorized))?;
    require!(
        permissions.issuer == issuer.key()
            && permissions.authority == *authority
            && permissions.capabilities & capability == capability,
        RegistryError::Unauthorized
    );
    Ok(())
}

/// Closes a program-owned account in place: every lamport to `recipient`, then
/// system-owned with zero data (the same close as the platform-admin rotation).
pub fn close_program_account(account: &AccountInfo, recipient: &AccountInfo) -> Result<()> {
    let refunded = recipient
        .lamports()
        .checked_add(account.lamports())
        .ok_or(RegistryError::Overflow)?;
    **recipient.try_borrow_mut_lamports()? = refunded;
    **account.try_borrow_mut_lamports()? = 0;
    account.assign(&anchor_lang::system_program::ID);
    account.resize(0)?;
    Ok(())
}

/// Reads and closes the `IssuerPermissions` record at `record` (the caller
/// pins its address by seeds) when an issuer authority changes, so a grant can
/// never come back to life on an A -> B -> A round trip. Returns `None` when no
/// record exists; otherwise the record's `(capabilities, updated_by)` after
/// checking owner, discriminator, issuer and authority. The rent goes to
/// `refund_to`.
pub fn take_old_grant(
    record: &AccountInfo,
    issuer: &Pubkey,
    authority: &Pubkey,
    refund_to: &AccountInfo,
) -> Result<Option<(u8, Pubkey)>> {
    if record.data_is_empty() {
        return Ok(None);
    }
    require!(record.owner == &crate::ID, RegistryError::Unauthorized);
    let grant = {
        let data = record.try_borrow_data()?;
        crate::state::IssuerPermissions::try_deserialize(&mut data.as_ref())
            .map_err(|_| error!(RegistryError::Unauthorized))?
    };
    require!(
        grant.issuer == *issuer && grant.authority == *authority,
        RegistryError::Unauthorized
    );
    close_program_account(record, refund_to)?;
    Ok(Some((grant.capabilities, grant.updated_by)))
}

/// Retires a pending `AuthorityTransfer` or `IssuerRecovery` of `issuer` at
/// `record` (the caller pins its address by seeds) when the issuer authority
/// changes by the OTHER path: its `current_authority` (byte 40 in both
/// layouts) becomes the default key, which no issuer authority can equal, so
/// an A -> B -> A round trip can never make it acceptable / executable again.
/// Cancel still works and returns the rent. Returns whether a live-looking
/// proposal was retired; a missing account is a no-op.
pub fn retire_pending_proposal(
    record: &AccountInfo,
    issuer: &Pubkey,
    discriminator: &[u8],
) -> Result<bool> {
    if record.data_is_empty() || record.owner != &crate::ID {
        return Ok(false);
    }
    let mut data = record.try_borrow_mut_data()?;
    require!(
        data.len() >= 72 && data[..8] == *discriminator && data[8..40] == issuer.to_bytes(),
        RegistryError::Unauthorized
    );
    if data[40..72].iter().all(|b| *b == 0) {
        return Ok(false);
    }
    data[40..72].fill(0);
    Ok(true)
}

/// Reads the parent key stored in the first field (byte 8) of a registry
/// account without deserializing the rest, after checking its address, owner
/// and discriminator. `ShareClass.asset` and `Asset.issuer` sit there in every
/// layout version, so legacy v1 share classes read the same as v2 ones.
pub fn read_parent_key(
    account: &AccountInfo,
    expected_key: &Pubkey,
    discriminator: &[u8],
) -> Result<Pubkey> {
    require_keys_eq!(*account.key, *expected_key, RegistryError::Unauthorized);
    require!(account.owner == &crate::ID, RegistryError::Unauthorized);
    let data = account.try_borrow_data()?;
    require!(
        data.len() >= 40 && data[..8] == *discriminator,
        RegistryError::Unauthorized
    );
    let mut parent = [0u8; 32];
    parent.copy_from_slice(&data[8..40]);
    Ok(Pubkey::new_from_array(parent))
}

/// Checks issuance before any CPI. Legacy optional-field padding must never
/// be mistaken for an initialized v2 lifetime counter.
pub fn next_issuance_supply(
    share_class: &crate::state::ShareClass,
    amount: u64,
) -> Result<(u64, u64)> {
    require!(
        share_class.version == SHARE_CLASS_STATE_VERSION,
        RegistryError::AccountMigrationRequired
    );
    let circulating = share_class
        .circulating_supply
        .checked_add(amount)
        .ok_or(RegistryError::Overflow)?;
    let lifetime = share_class
        .lifetime_minted
        .checked_add(amount)
        .ok_or(RegistryError::Overflow)?;
    if let Some(max) = share_class.max_supply {
        let used = if share_class.cumulative_cap {
            lifetime
        } else {
            circulating
        };
        require!(used <= max, RegistryError::MaxSupplyExceeded);
    }
    Ok((circulating, lifetime))
}

/// The sorted-pair SHA-256 parent of two Merkle nodes.
pub fn merkle_parent(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    if a <= b {
        hashv(&[&a, &b]).to_bytes()
    } else {
        hashv(&[&b, &a]).to_bytes()
    }
}

/// Verifies a sorted-pair SHA-256 Merkle proof — `leaf` is in the tree `root`.
pub fn verify_merkle_proof(root: [u8; 32], leaf: [u8; 32], proof: &[[u8; 32]]) -> bool {
    let mut computed = leaf;
    for sibling in proof {
        computed = merkle_parent(computed, *sibling);
    }
    computed == root
}

/// Canonical batch commitment: domain || distribution || batch_id LE32 ||
/// count LE32 || ordered (token-account || wallet-owner || amount LE64).
pub fn distribution_batch_leaf(
    distribution: &Pubkey,
    batch_id: u32,
    entries: &[(Pubkey, Pubkey, u64)],
) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(70 + entries.len() * 72);
    bytes.extend_from_slice(b"mancipatio:distribution-batch:v1");
    bytes.extend_from_slice(distribution.as_ref());
    bytes.extend_from_slice(&batch_id.to_le_bytes());
    bytes.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (token_account, wallet, amount) in entries {
        bytes.extend_from_slice(token_account.as_ref());
        bytes.extend_from_slice(wallet.as_ref());
        bytes.extend_from_slice(&amount.to_le_bytes());
    }
    hashv(&[&bytes]).to_bytes()
}

/// A snapshot Merkle leaf for `(account, amount)` — used both for governance
/// vote weights and Rights-Token milestone claim entitlements.
pub fn snapshot_leaf(account: &Pubkey, amount: u64) -> [u8; 32] {
    hashv(&[account.as_ref(), &amount.to_le_bytes()]).to_bytes()
}

/// SPL Token / Token-2022 `TransferChecked` instruction discriminator.
const TRANSFER_CHECKED_IX: u8 = 12;

/// CPI a Token-2022 `transfer_checked` of a transfer-hook mint, signed by a PDA.
///
/// `hook_accounts` are appended after the four standard `transfer_checked`
/// accounts. For the Mancipatio share-class mint that is
/// `[source BlockEntry, ExtraAccountMetaList, transfer_hook program]` — the
/// layout proven by the happy-path real-transfer test (docs/05 §5). The caller
/// passes them through `ctx.remaining_accounts`.
///
/// INVARIANT: the `ShareClass` PDA must never be the `authority` here except
/// via [`seize_into_quarantine`]. The transfer hook lets a BLOCKED source move
/// only when the authority is the mint's PermanentDelegate ShareClass and the
/// destination is a registry escrow PDA — on an Open mint it cannot tell WHICH
/// escrow, so the "burn-only quarantine" guarantee rests on this program
/// signing as the ShareClass only for the pinned quarantine leg. Guarded by
/// `share_class_signs_only_the_quarantine_transfer` (asset_registry tests).
#[allow(clippy::too_many_arguments)]
pub fn hook_transfer<'info>(
    token_program: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    hook_accounts: &[AccountInfo<'info>],
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(10);
    data.push(TRANSFER_CHECKED_IX);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);

    let mut metas = vec![
        AccountMeta::new(*source.key, false),
        AccountMeta::new_readonly(*mint.key, false),
        AccountMeta::new(*destination.key, false),
        AccountMeta::new_readonly(*authority.key, true),
    ];
    let mut infos = vec![
        source.clone(),
        mint.clone(),
        destination.clone(),
        authority.clone(),
    ];
    for acc in hook_accounts {
        metas.push(AccountMeta {
            pubkey: *acc.key,
            is_signer: false,
            is_writable: acc.is_writable,
        });
        infos.push(acc.clone());
    }

    invoke_signed(
        &Instruction {
            program_id: *token_program.key,
            accounts: metas,
            data,
        },
        &infos,
        signer_seeds,
    )?;
    Ok(())
}

/// The seizure leg shared by both permanent-delegate clawbacks
/// (`clawback_from_holder`, `clawback_blocklisted_holder`): `source` → the
/// quarantine `destination`, hook-aware, the `ShareClass` PDA signing as the
/// mint's Token-2022 `PermanentDelegate`. The callers pin `destination` to an
/// Active `RedemptionQueue` + `BurnAndAttest` vault escrow of this class and
/// authorise the holder; this only moves the units.
///
/// `amount == 0` sweeps `source`'s full balance; nothing to move ⇒
/// `NothingToClaim`. Returns the amount moved.
///
/// INVARIANT: this is the ONLY place the ShareClass signs a token transfer,
/// and the registry never calls `SetAuthority` (so the PermanentDelegate stays
/// the ShareClass). The transfer hook's blocked-source exception — above all
/// in Open mode, where no config names the class and no marker names the
/// escrow — accepts any ShareClass-signed transfer into any registry escrow
/// PDA; it is burn-only quarantine only because both callers pin
/// `destination` to an Active RedemptionQueue + BurnAndAttest vault. A new
/// ShareClass-signed transfer widens that exception. Guarded by
/// `share_class_signs_only_the_quarantine_transfer` (asset_registry tests).
pub fn seize_into_quarantine<'info>(
    token_program: &AccountInfo<'info>,
    share_class: &Account<'info, ShareClass>,
    source: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    destination: &AccountInfo<'info>,
    hook_accounts: &[AccountInfo<'info>],
    amount: u64,
) -> Result<u64> {
    let clawback_amount = if amount == 0 { source.amount } else { amount };
    require!(clawback_amount > 0, RegistryError::NothingToClaim);

    let asset_key = share_class.asset;
    let class_index_seed = [share_class.class_index];
    let bump_seed = [share_class.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        SHARE_CLASS_SEED,
        asset_key.as_ref(),
        &class_index_seed,
        &bump_seed,
    ]];
    hook_transfer(
        token_program,
        &source.to_account_info(),
        &mint.to_account_info(),
        destination,
        &share_class.to_account_info(),
        hook_accounts,
        clawback_amount,
        mint.decimals,
        signer_seeds,
    )?;
    Ok(clawback_amount)
}

/// Proof that `holder` is on the transfer-hook blocklist: `entry` (address
/// already pinned by the caller's `seeds::program` constraint to the hook's
/// `["blocked", holder]` PDA) must be a live, hook-owned `BlockEntry` naming
/// `holder`. Only the hook's `BlocklistAuthority` can create one
/// (`add_to_blocklist`); `remove_from_blocklist` closes it (empty,
/// system-owned ⇒ refused). Owner + address already suffice — the
/// discriminator / length / wallet checks are defense in depth.
///
/// Returns `BlockEntry.added_by` — the BlocklistAuthority key on record.
pub fn require_blocklisted(entry: &AccountInfo, holder: &Pubkey) -> Result<Pubkey> {
    require!(
        entry.owner == &TRANSFER_HOOK_PROGRAM,
        RegistryError::ClawbackHolderNotBlocked
    );
    let data = entry.try_borrow_data()?;
    require!(
        data.len() >= HOOK_BLOCK_ENTRY_LEN
            && data[..8] == HOOK_BLOCK_ENTRY_DISCRIMINATOR
            && data[HOOK_BLOCK_ENTRY_WALLET_OFFSET..HOOK_BLOCK_ENTRY_WALLET_OFFSET + 32]
                == holder.to_bytes(),
        RegistryError::ClawbackHolderNotBlocked
    );
    let added_by: [u8; 32] = data
        [HOOK_BLOCK_ENTRY_ADDED_BY_OFFSET..HOOK_BLOCK_ENTRY_ADDED_BY_OFFSET + 32]
        .try_into()
        .map_err(|_| error!(RegistryError::ClawbackHolderNotBlocked))?;
    Ok(Pubkey::new_from_array(added_by))
}

/// Reads the mint's `TransferHookConfig` (address pinned by the caller's
/// `seeds::program` constraint) in ANY mode: it must be hook-owned, full
/// length, and name this `mint` and `share_class`. Returns `true` iff the
/// mint is `KycGated`.
pub fn read_hook_config(cfg: &AccountInfo, mint: &Pubkey, share_class: &Pubkey) -> Result<bool> {
    require!(
        cfg.owner == &TRANSFER_HOOK_PROGRAM,
        RegistryError::HookConfigInvalid
    );
    let data = cfg.try_borrow_data()?;
    require!(
        data.len() >= HOOK_CONFIG_MIN_LEN
            && data[HOOK_CONFIG_MINT_OFFSET..HOOK_CONFIG_MINT_OFFSET + 32] == mint.to_bytes()
            && data[HOOK_CONFIG_SHARE_CLASS_OFFSET..HOOK_CONFIG_SHARE_CLASS_OFFSET + 32]
                == share_class.to_bytes(),
        RegistryError::HookConfigInvalid
    );
    Ok(data[HOOK_CONFIG_RESTRICTION_MODE_OFFSET] == RESTRICTION_MODE_KYC_GATED)
}

/// How much of an escrow balance a refund leg may release, split by evidence.
pub struct EscrowRelease {
    /// Total to transfer out on this leg (`from_ledger + released surplus`).
    pub payout: u64,
    /// The part covered by the deposit ledger — subtract it from the ledger.
    pub from_ledger: u64,
    /// Surplus left sitting in the escrow because the receiver is not eligible.
    pub withheld: u64,
    /// `Some(err)` iff a surplus existed and the receiver-KYC check refused it.
    /// Call sites that must never brick (cleanup / permissionless paths) ignore
    /// it and withhold; call sites where withholding everything would be a
    /// silent no-op surface it as the instruction's error.
    pub surplus_refusal: Option<Error>,
}

/// **The escrow-release rule**, applied identically by every program escrow
/// that can pay out to a wallet (`cancel_offer`, `expire_offer`,
/// `refund_otc_deposits`, `return_custody_vault`).
///
/// A platform escrow is an ordinary Token-2022 account whose owner is a PDA
/// carrying an `EscrowMarker`, and the transfer hook skips its receiver-KYC
/// checks for any leg touching such a marker (the PDA cannot hold a `KycEntry`,
/// so the exemption is a routing fact, not a verdict on the wallet at the far
/// end). Two consequences that cannot be fixed by prohibition:
///
///   1. ANYONE can push units into ANY escrow with a raw `transfer_checked` —
///      the destination marker exempts that leg, and no instruction of this
///      program is involved, so nothing can refuse it;
///   2. therefore "the balance in this escrow belongs to the party we are about
///      to pay" is not a fact the chain knows. It has to be RECORDED, by the
///      instruction that moved the units in.
///
/// Hence the rule, on `balance` (live escrow balance) and `deposited` (that
/// party's ledger):
///
///   * `min(balance, deposited)` — the payee's own property. Released with NO
///     check of any kind: a refund must never be stranded by a lapsed or
///     revoked passport, and a permissionless cleanup path must never fail;
///   * the surplus above it — units the payee did not put in. Releasing those
///     is a DELIVERY, so it happens only if `require_receiver_kyc` passes.
///
/// The split (rather than a threshold on the total) is deliberate and is what
/// makes the rule grief-proof: a single base unit sent into the escrow by a
/// stranger must not be able to hold a holder's whole deposit hostage. The
/// withheld surplus stays in the escrow — see each call site for what happens
/// to it there.
pub fn split_escrow_release(
    balance: u64,
    deposited: u64,
    remaining_accounts: &[AccountInfo],
    mint: &Pubkey,
    receiver: &Pubkey,
) -> EscrowRelease {
    let from_ledger = balance.min(deposited);
    let surplus = balance.saturating_sub(from_ledger);
    if surplus == 0 {
        return EscrowRelease {
            payout: from_ledger,
            from_ledger,
            withheld: 0,
            surplus_refusal: None,
        };
    }
    match require_receiver_kyc(remaining_accounts, mint, receiver) {
        Ok(()) => EscrowRelease {
            payout: balance,
            from_ledger,
            withheld: 0,
            surplus_refusal: None,
        },
        Err(e) => EscrowRelease {
            payout: from_ledger,
            from_ledger,
            withheld: surplus,
            surplus_refusal: Some(e),
        },
    }
}

/// Signer seeds for an `OtcDeal` PDA.
fn otc_deal_signer<'a>(
    deal: &'a OtcDeal,
    deal_id_seed: &'a [u8; 8],
    bump_seed: &'a [u8; 1],
) -> [&'a [u8]; 4] {
    [
        OTC_DEAL_SEED,
        deal.share_class.as_ref(),
        deal_id_seed,
        bump_seed,
    ]
}

/// Settles a fully-funded OTC deal atomically: the escrowed share units go to
/// the buyer (hook-aware, deal PDA signs) and the escrowed payment goes to the
/// seller (plain CPI, deal PDA signs).
///
/// Transfers `deal.amount` / `deal.price` rather than the live escrow
/// balances: deposits move exactly those amounts, and the escrow typed
/// accounts may be stale snapshots when a deposit CPI ran earlier in the same
/// instruction.
///
/// **Receiver KYC is enforced here** (`KycGated` mints), exactly as in
/// `take_offer`. The buyer leg is an escrow→wallet DELIVERY of the security,
/// and the hook's source-marker exemption (the deal PDA carries an
/// `EscrowMarker`) would otherwise let it through unchecked. It used to be
/// treated as safe because an admin creates the deal and vets both parties
/// off-chain — but `create_otc_deal` lets that same admin name any `buyer`
/// and any `seller`, so the "platform vetted them" argument reduces to
/// trusting one key: mint to the treasury, open a deal selling to a wallet
/// with no `KycEntry`, deposit both sides, settle. The check makes the buyer's
/// eligibility a fact the chain verifies rather than a claim the platform
/// makes about itself.
///
/// REFUND legs are deliberately NOT gated — see `refund_otc_deposits`.
#[allow(clippy::too_many_arguments)]
pub fn settle_otc_deal<'info>(
    deal: &Account<'info, OtcDeal>,
    mint: &InterfaceAccount<'info, Mint>,
    asset_escrow: &InterfaceAccount<'info, TokenAccount>,
    buyer_share_account: &InterfaceAccount<'info, TokenAccount>,
    payment_mint: &InterfaceAccount<'info, Mint>,
    payment_escrow: &InterfaceAccount<'info, TokenAccount>,
    seller_payment_account: &InterfaceAccount<'info, TokenAccount>,
    share_token_program: &AccountInfo<'info>,
    payment_token_program: &AccountInfo<'info>,
    hook_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let deal_id_seed = deal.deal_id.to_le_bytes();
    let bump_seed = [deal.bump];
    let seeds = otc_deal_signer(deal, &deal_id_seed, &bump_seed);
    let signer_seeds: &[&[&[u8]]] = &[&seeds];

    // Receiver eligibility for the escrow→buyer delivery leg. `hook_accounts`
    // is the settle leg's own hook tail, which in `KycGated` mode already
    // carries the config, the registry and the buyer's `KycEntry` (the meta
    // list derives idx 9 from the DESTINATION owner) — so no extra accounts
    // are needed beyond what the transfer below requires anyway. The
    // destination's owner is bound to `deal.buyer` by the account constraints
    // in both callers, so the party checked here is the party paid.
    require_receiver_kyc(hook_accounts, &mint.key(), &buyer_share_account.owner)?;

    // 1. shares: asset escrow → buyer (share mint — hook-aware, deal PDA signs)
    hook_transfer(
        share_token_program,
        &asset_escrow.to_account_info(),
        &mint.to_account_info(),
        &buyer_share_account.to_account_info(),
        &deal.to_account_info(),
        hook_accounts,
        deal.amount,
        mint.decimals,
        signer_seeds,
    )?;

    // 2. payment: payment escrow → seller (payment mint has no hook — plain CPI)
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            payment_token_program.key(),
            TransferChecked {
                from: payment_escrow.to_account_info(),
                mint: payment_mint.to_account_info(),
                to: seller_payment_account.to_account_info(),
                authority: deal.to_account_info(),
            },
            signer_seeds,
        ),
        deal.price,
        payment_mint.decimals,
    )?;
    Ok(())
}

/// Refunds what was deposited into an OTC deal's escrows — share units back to
/// the seller (hook-aware, deal PDA signs) and payment back to the buyer (plain
/// CPI, deal PDA signs). Used by `expire_otc_deal` and `cancel_otc_deal`.
///
/// **Each leg is capped at that party's DEPOSIT LEDGER**
/// (`deal.asset_deposited_amount` / `deal.payment_deposited_amount`), never at
/// the live escrow balance — `split_escrow_release` states the rule and why.
/// Both escrows are ordinary token accounts anyone can raw-transfer into, and
/// `create_otc_deal` is admin-gated with the admin naming BOTH parties, so
/// sweeping the balance was a two-hop laundering route: open a deal whose
/// `seller` is a wallet with no `KycEntry`, have it deposit one unit, raw-push
/// a million freshly minted units into the asset escrow, then cancel/expire.
///
/// What is and is not gated, per leg:
///
///   * asset leg (share mint, hook-backstopped): up to
///     `asset_deposited_amount` goes back to `deal.seller` with NO receiver
///     check — a refund of their own property must survive a passport that
///     lapsed while it sat in escrow, and `expire_otc_deal` is permissionless
///     so a failing check would brick the cleanup path for everyone. Anything
///     ABOVE the ledger is a delivery and needs `require_receiver_kyc`;
///   * payment leg (payment mint): capped at `payment_deposited_amount`. The
///     payment mint carries no transfer hook and no KYC registry, so there is
///     no eligibility question here at all — the cap is purely about not
///     paying out value the buyer never deposited.
///
/// Surplus that cannot be released stays in the escrow. Both callers are
/// terminal (`Cancelled` / `Expired`) and close the deal's `EscrowMarker`, so
/// it is immobilised there for good: it is by construction NOT the payee's
/// property, and forfeiting units that someone chose to push into a program
/// escrow is what makes the grief pointless. The alternative — leaving the deal
/// open — would be worse: a still-`Open` deal remains settleable.
#[allow(clippy::too_many_arguments)]
pub fn refund_otc_deposits<'info>(
    deal: &Account<'info, OtcDeal>,
    mint: &InterfaceAccount<'info, Mint>,
    asset_escrow: &InterfaceAccount<'info, TokenAccount>,
    seller_share_account: &InterfaceAccount<'info, TokenAccount>,
    payment_mint: &InterfaceAccount<'info, Mint>,
    payment_escrow: &InterfaceAccount<'info, TokenAccount>,
    buyer_payment_account: &InterfaceAccount<'info, TokenAccount>,
    share_token_program: &AccountInfo<'info>,
    payment_token_program: &AccountInfo<'info>,
    hook_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let deal_id_seed = deal.deal_id.to_le_bytes();
    let bump_seed = [deal.bump];
    let seeds = otc_deal_signer(deal, &deal_id_seed, &bump_seed);
    let signer_seeds: &[&[&[u8]]] = &[&seeds];

    // Asset leg — ledger-capped, surplus gated on the seller's KYC. A refusal
    // is NOT propagated: cancel/expire must always be able to close the deal.
    let asset = split_escrow_release(
        asset_escrow.amount,
        deal.asset_deposited_amount,
        hook_accounts,
        &mint.key(),
        &seller_share_account.owner,
    );
    if asset.payout > 0 {
        hook_transfer(
            share_token_program,
            &asset_escrow.to_account_info(),
            &mint.to_account_info(),
            &seller_share_account.to_account_info(),
            &deal.to_account_info(),
            hook_accounts,
            asset.payout,
            mint.decimals,
            signer_seeds,
        )?;
    }
    if asset.withheld > 0 {
        msg!(
            "OTC deal {} — {} un-deposited share units withheld (receiver not eligible)",
            deal.deal_id,
            asset.withheld
        );
    }

    // Payment leg — ledger-capped only (payment mint has no hook / no KYC).
    let payment_refund = payment_escrow.amount.min(deal.payment_deposited_amount);
    if payment_refund > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                payment_token_program.key(),
                TransferChecked {
                    from: payment_escrow.to_account_info(),
                    mint: payment_mint.to_account_info(),
                    to: buyer_payment_account.to_account_info(),
                    authority: deal.to_account_info(),
                },
                signer_seeds,
            ),
            payment_refund,
            payment_mint.decimals,
        )?;
    }
    Ok(())
}

/// Outcome of a receiver-KYC resolution against the mint's hook config.
enum ReceiverKycOutcome {
    /// The hook config was found and says `Open` — receiver KYC not required.
    OpenByConfig,
    /// No (initialised) hook config among the provided accounts — the
    /// restriction mode could not be established from the tail.
    ConfigUnavailable,
    /// The mint is `KycGated` and the receiver's entry passed every check.
    Approved,
}

/// Re-derives a receiver's KYC eligibility on-chain, for paths the transfer
/// hook cannot gate.
///
/// The transfer hook's escrow-marker exemption skips the receiver-KYC checks
/// for every platform escrow leg — and a `mint_to` never runs the hook at all.
/// Each path that DELIVERS share units out of a program escrow to a wallet
/// therefore re-checks the receiver itself, from the same accounts the hook
/// resolves (passed through `remaining_accounts`):
///
///   * `take_offer` — offers are permissionless on both sides (`create_offer`
///     / `take_offer` have no admin gate), so the taker — the receiver on the
///     escrow→wallet leg — is never platform-vetted, yet the hook would exempt
///     that leg via the offer PDA's source marker (`require_receiver_kyc`);
///   * `settle_otc_deal` — the buyer leg of an admin-created OTC deal. The
///     admin picks both `deal.buyer` and `deal.seller`, so "the platform
///     vetted the parties" is a statement the platform makes about itself;
///     the buyer's `KycEntry` is verified on-chain instead
///     (`require_receiver_kyc`);
///   * every REFUND leg, for the part of the escrow balance the payee did NOT
///     deposit themselves — `cancel_offer` / `expire_offer` (ledger:
///     `offer.deposited`), `refund_otc_deposits` (ledger:
///     `deal.asset_deposited_amount`) and `return_custody_vault` (ledger:
///     `custody_vault.deposited`), all through `split_escrow_release`;
///   * `buy` — primary-sale delivery is a `mint_to`, which Token-2022 never
///     routes through the hook (`require_receiver_kyc_for_mint_to`).
///
/// The ONLY units that leave a program escrow for a wallet without any check
/// are units that a program instruction recorded as that same party's deposit
/// (`deposit_to_offer_escrow`, `deposit_otc_asset`,
/// `deposit_to_custody_vault`) — a refund of one's own property must never be
/// stranded by a lapsed passport. Beyond that, only burn legs skip the
/// receiver check (`realize_custody_vault` / `revert_custody_vault`) because
/// they have no receiver at all; each carries a comment at its call site
/// saying so. The `DeliveryEscrow` realize burn IS the holder's conversion or
/// delivery, so it is KYC-gated separately (2C-3): the beneficiary's
/// `KycEntry` in the registry the vault pinned at open must pass
/// `require_kyc_entry_current` + `require_jurisdiction_allowed`.
///
/// Resolution:
///
///   * finds the mint's `TransferHookConfig` (owned by the hook program).
///     When present and `KycGated`, the `kyc_registry` is read from it and the
///     receiver's `KycEntry` (`["kyc", registry, receiver]`, an
///     asset_registry-owned account this program deserializes directly) must
///     be `Approved`, unexpired, and in an allowed jurisdiction;
///   * when the config is absent the mode cannot be established from the tail
///     — the two public wrappers differ in how they interpret that.
///
/// Account identity is by re-derived PDA key, so it cannot be spoofed: the
/// runtime loads the authentic account data for any pubkey passed.
fn receiver_kyc_outcome(
    remaining_accounts: &[AccountInfo],
    mint: &Pubkey,
    receiver: &Pubkey,
) -> Result<ReceiverKycOutcome> {
    let (config_key, _) =
        Pubkey::find_program_address(&[HOOK_CONFIG_SEED, mint.as_ref()], &TRANSFER_HOOK_PROGRAM);
    let Some(config_ai) = remaining_accounts.iter().find(|ai| *ai.key == config_key) else {
        return Ok(ReceiverKycOutcome::ConfigUnavailable);
    };
    if config_ai.owner != &TRANSFER_HOOK_PROGRAM || config_ai.data_is_empty() {
        return Ok(ReceiverKycOutcome::ConfigUnavailable);
    }

    let registry_key = {
        let data = config_ai.try_borrow_data()?;
        require!(
            data.len() >= HOOK_CONFIG_MIN_LEN,
            RegistryError::InvalidKycRegistry
        );
        if data[HOOK_CONFIG_RESTRICTION_MODE_OFFSET] != RESTRICTION_MODE_KYC_GATED {
            return Ok(ReceiverKycOutcome::OpenByConfig); // receiver KYC not required
        }
        require!(
            data[HOOK_CONFIG_KYC_REGISTRY_TAG_OFFSET] == 1,
            RegistryError::InvalidKycRegistry
        );
        let key: [u8; 32] = data
            [HOOK_CONFIG_KYC_REGISTRY_KEY_OFFSET..HOOK_CONFIG_KYC_REGISTRY_KEY_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(RegistryError::InvalidKycRegistry))?;
        Pubkey::new_from_array(key)
    };

    // Receiver `KycEntry` — an asset_registry-owned PDA; deserialize directly.
    let (entry_key, _) = Pubkey::find_program_address(
        &[KYC_SEED, registry_key.as_ref(), receiver.as_ref()],
        &crate::ID,
    );
    let entry_ai = remaining_accounts
        .iter()
        .find(|ai| *ai.key == entry_key)
        .ok_or(error!(RegistryError::ReceiverNotApproved))?;
    require!(
        entry_ai.owner == &crate::ID && !entry_ai.data_is_empty(),
        RegistryError::ReceiverNotApproved
    );
    let entry = {
        let data = entry_ai.try_borrow_data()?;
        KycEntry::try_deserialize(&mut data.as_ref())?
    };
    require_kyc_entry_current(&entry, Clock::get()?.unix_timestamp)?;

    // Jurisdiction bitmaps live on the registry (also asset_registry-owned).
    let registry_ai = remaining_accounts
        .iter()
        .find(|ai| *ai.key == registry_key)
        .ok_or(error!(RegistryError::InvalidKycRegistry))?;
    require!(
        registry_ai.owner == &crate::ID && !registry_ai.data_is_empty(),
        RegistryError::InvalidKycRegistry
    );
    let registry = {
        let data = registry_ai.try_borrow_data()?;
        KycRegistry::try_deserialize(&mut data.as_ref())?
    };
    require_jurisdiction_allowed(&registry, entry.jurisdiction)?;

    Ok(ReceiverKycOutcome::Approved)
}

/// A `KycEntry` counts as current when it is `Approved` (else
/// `ReceiverNotApproved`, 6069) and its expiry is strictly after `now` (else
/// `ReceiverKycExpired`, 6070) — in that order. Shared by the receiver-KYC
/// gates and the `DeliveryEscrow` realize gate.
pub fn require_kyc_entry_current(entry: &KycEntry, now: i64) -> Result<()> {
    require!(
        entry.status == KycStatus::Approved,
        RegistryError::ReceiverNotApproved
    );
    require!(entry.expiry > now, RegistryError::ReceiverKycExpired);
    Ok(())
}

/// `jurisdiction` must be set in the registry's approved bitmap and clear in
/// its blocked bitmap (else `ReceiverJurisdictionBlocked`, 6071).
pub fn require_jurisdiction_allowed(registry: &KycRegistry, jurisdiction: u16) -> Result<()> {
    let j = jurisdiction as usize;
    let byte = j / 8;
    let bit = (j % 8) as u8;
    require!(
        byte < crate::state::JURISDICTION_BITMAP_BYTES
            && (registry.approved_jurisdictions[byte] & (1 << bit)) != 0
            && (registry.blocked_jurisdictions[byte] & (1 << bit)) == 0,
        RegistryError::ReceiverJurisdictionBlocked
    );
    Ok(())
}

/// Receiver-KYC gate for hook-backstopped escrow-release legs (`take_offer`,
/// `settle_otc_deal`, `return_custody_vault`).
///
/// In `Open` mode the 3-account hook tail carries no config, so its absence
/// here means "not gated" — and a `KycGated` transfer cannot resolve at all
/// without the full tail (Token-2022 rebuilds the whole meta list before the
/// hook CPI), so the hook CPI is the backstop for a stripped tail. Only safe
/// on paths that go on to run a hook-aware `transfer_checked`.
pub fn require_receiver_kyc(
    remaining_accounts: &[AccountInfo],
    mint: &Pubkey,
    receiver: &Pubkey,
) -> Result<()> {
    receiver_kyc_outcome(remaining_accounts, mint, receiver).map(|_| ())
}

/// Fail-closed receiver-KYC gate for `mint_to` deliveries (`buy`).
///
/// `mint_to` never invokes the transfer hook, so — unlike `take_offer` —
/// nothing backstops a stripped account tail: treating a missing config as
/// "Open" would let anyone mint-buy a `KycGated` security by simply omitting
/// the tail. The restriction mode must instead be proven on-chain by one of
/// two accounts, both of which exist for every share-class mint
/// (`initialize_share_class_mint` creates them atomically with the mint):
///
///   * the mint's `TransferHookConfig` (present in the 9-account KycGated
///     tail) — its `restriction_mode` is authoritative; or
///   * the mint's `ExtraAccountMetaList` (present in the 3-account Open tail)
///     in its **Open shape** (exactly one extra meta): the hook program
///     rewrites and resizes that PDA atomically with every mode flip, so the
///     Open shape proves `Open` mode.
///
/// A tail carrying neither fails with `KycProofRequired`.
pub fn require_receiver_kyc_for_mint_to(
    remaining_accounts: &[AccountInfo],
    mint: &Pubkey,
    receiver: &Pubkey,
) -> Result<()> {
    match receiver_kyc_outcome(remaining_accounts, mint, receiver)? {
        ReceiverKycOutcome::Approved | ReceiverKycOutcome::OpenByConfig => Ok(()),
        ReceiverKycOutcome::ConfigUnavailable => {
            let (metas_key, _) = Pubkey::find_program_address(
                &[HOOK_EXTRA_METAS_SEED, mint.as_ref()],
                &TRANSFER_HOOK_PROGRAM,
            );
            let metas_ai = remaining_accounts
                .iter()
                .find(|ai| *ai.key == metas_key)
                .ok_or(error!(RegistryError::KycProofRequired))?;
            require!(
                metas_ai.owner == &TRANSFER_HOOK_PROGRAM && !metas_ai.data_is_empty(),
                RegistryError::KycProofRequired
            );
            // Open shape = exactly 1 extra meta (the source BlockEntry). The
            // meta-list account is always exactly `size_of(len)` bytes — the
            // hook program creates and resizes it to that — so length
            // equality is an exact mode check.
            let open_len = ExtraAccountMetaList::size_of(1)
                .map_err(|_| error!(RegistryError::KycProofRequired))?;
            require!(
                metas_ai.data_len() == open_len,
                RegistryError::KycProofRequired
            );
            Ok(())
        }
    }
}

// ── Vesting series math (spec: "11. Vesting — Mancipatio") ──────────────────

use crate::state::{VestingSeries, VestingSeriesStatus, VestingTimingMode, VestingTranche};

/// Checked, immutable total used by creation, finalization and all releases.
pub fn vesting_schedule_total(tranches: &[VestingTranche]) -> Result<u64> {
    tranches.iter().try_fold(0u64, |sum, tranche| {
        sum.checked_add(tranche.amount)
            .ok_or_else(|| error!(RegistryError::InvalidVestingSchedule))
    })
}

/// Cumulative scheduled amount unlocked at `ts` — ownership basis ("vested"),
/// independent of approval state or funding.
pub fn vesting_cumulative(tranches: &[VestingTranche], ts: i64) -> u64 {
    tranches
        .iter()
        .filter(|t| t.unlock_ts <= ts)
        .fold(0u64, |acc, t| acc.saturating_add(t.amount))
}

/// Cumulative amount DELIVERABLE at `ts` — vested, plus the series gates:
/// - a Cancelled series delivers against `final_cumulative` (frozen at cancel
///   time; approval no longer applies, funding gate no longer blocks);
/// - releases are blocked until deposits cover the full allocation
///   ("release blocked until deposit covers total allocations");
/// - in Approval mode a tranche counts once it is approved OR its approval
///   window has lapsed (`unlock_ts + approval_window_secs <= ts`) — approval
///   delays but can never freeze a vested tranche.
pub fn vesting_deliverable_cumulative(series: &VestingSeries, ts: i64) -> u64 {
    if series.status == VestingSeriesStatus::Cancelled {
        return series.final_cumulative;
    }
    if series.status == VestingSeriesStatus::Draft
        || series.total_allocated == 0
        || series.deposited < series.total_allocated
    {
        return 0;
    }
    match series.timing_mode {
        VestingTimingMode::Auto => vesting_cumulative(&series.tranches, ts),
        VestingTimingMode::Approval => series
            .tranches
            .iter()
            .enumerate()
            .filter(|(i, t)| {
                t.unlock_ts <= ts
                    && (series.approved_mask & (1u64 << i) != 0
                        || t.unlock_ts
                            .checked_add(series.approval_window_secs)
                            .map(|deadline| deadline <= ts)
                            .unwrap_or(false))
            })
            .fold(0u64, |acc, (_, t)| acc.saturating_add(t.amount)),
    }
}

/// A position's deliverable entitlement — its pro-rata share of the
/// deliverable cumulative, floored. Schedule amounts are series-wide;
/// uniformity across positions is what makes cancellation accounting exact.
pub fn vesting_position_entitlement(
    allocation: u64,
    deliverable_cumulative: u64,
    total_allocated: u64,
) -> u64 {
    if total_allocated == 0 {
        return 0;
    }
    ((allocation as u128) * (deliverable_cumulative as u128) / (total_allocated as u128)) as u64
}
