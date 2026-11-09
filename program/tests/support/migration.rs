//! Token-migration (program V2) fixtures for the asset_registry host tests:
//! PDAs, legacy-token mints (SPL Token and Token-2022, plain or with one
//! extension), token accounts, the eleven instruction builders, the hook
//! tails of the vault legs and a send that reports compute units. Built on
//! the `issuer::World` harness.
//!
//! The including test also declares `mod issuer` and `mod support`.
#![allow(dead_code)]
use super::issuer::*;
use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        system_instruction, system_program,
    },
    InstructionData, ToAccountMetas,
};
use asset_registry::{accounts as acc, instruction as ixd};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_associated_token_account_interface::{
    address::get_associated_token_address_with_program_id, instruction as ata_ix,
};
use spl_token_2022_interface::{
    extension::{self, ExtensionType},
    instruction as token_ix,
    state::{AccountState, Mint as SplMint},
};

pub const SPL_TOKEN: Pubkey = anchor_spl::token::ID;
pub const DAY: i64 = 86_400;

// ── PDAs ─────────────────────────────────────────────────────────────────────

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &asset_registry::ID).0
}
pub fn migration_pda(share_class: &Pubkey, id: u64) -> Pubkey {
    pda(&[
        asset_registry::MIGRATION_SEED,
        share_class.as_ref(),
        &id.to_le_bytes(),
    ])
}
pub fn mig_escrow_pda(migration: &Pubkey) -> Pubkey {
    pda(&[asset_registry::MIGRATION_ESCROW_SEED, migration.as_ref()])
}
pub fn mig_vault_pda(migration: &Pubkey) -> Pubkey {
    pda(&[asset_registry::MIGRATION_VAULT_SEED, migration.as_ref()])
}
/// `["escrow_marker", owner]` — an `EscrowMarker` or an `EscrowIdentity`.
pub fn marker_pda(owner: &Pubkey) -> Pubkey {
    pda(&[asset_registry::ESCROW_MARKER_SEED, owner.as_ref()])
}
pub fn mig_deposit_pda(migration: &Pubkey, holder: &Pubkey) -> Pubkey {
    pda(&[
        asset_registry::MIGRATION_DEPOSIT_SEED,
        migration.as_ref(),
        holder.as_ref(),
    ])
}
pub fn mig_claim_pda(migration: &Pubkey, claimer: &Pubkey) -> Pubkey {
    pda(&[
        asset_registry::MIGRATION_CLAIM_SEED,
        migration.as_ref(),
        claimer.as_ref(),
    ])
}
pub fn kyc_entry_pda(registry: &Pubkey, holder: &Pubkey) -> Pubkey {
    pda(&[asset_registry::KYC_SEED, registry.as_ref(), holder.as_ref()])
}
pub fn hook_config_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &transfer_hook::ID,
    )
    .0
}
pub fn extra_metas_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint.as_ref()],
        &transfer_hook::ID,
    )
    .0
}

// ── One migration under test ─────────────────────────────────────────────────

/// The terms `create_migration` takes.
#[derive(Clone, Copy, Debug)]
pub struct Terms {
    pub id: u64,
    pub lot: u64,
    pub units_cap: u64,
    pub opens_at: i64,
    pub closes_at: i64,
    pub claim_deadline: i64,
    pub return_to: Pubkey,
    pub terms_hash: [u8; 32],
}

impl Terms {
    /// The owner's default: a 75-day window from `opens_at`, then the
    /// minimum 30-day claim period.
    pub fn standard(id: u64, lot: u64, units_cap: u64, opens_at: i64, return_to: Pubkey) -> Self {
        let closes_at = opens_at + 75 * DAY;
        Self {
            id,
            lot,
            units_cap,
            opens_at,
            closes_at,
            claim_deadline: closes_at + 30 * DAY,
            return_to,
            terms_hash: [7u8; 32],
        }
    }
}

/// The addresses of one migration.
#[derive(Clone, Copy, Debug)]
pub struct Mig {
    pub fx: Fixture,
    pub migration: Pubkey,
    pub old_mint: Pubkey,
    pub old_program: Pubkey,
    /// The creating Admin (rent payer and recipient).
    pub admin: Pubkey,
    pub return_to: Pubkey,
}

impl Mig {
    pub fn new(
        fx: &Fixture,
        t: &Terms,
        old_mint: Pubkey,
        old_program: Pubkey,
        admin: Pubkey,
    ) -> Self {
        Self {
            fx: *fx,
            migration: migration_pda(&fx.share_class, t.id),
            old_mint,
            old_program,
            admin,
            return_to: t.return_to,
        }
    }
    pub fn escrow(&self) -> Pubkey {
        mig_escrow_pda(&self.migration)
    }
    pub fn vault(&self) -> Pubkey {
        mig_vault_pda(&self.migration)
    }
    pub fn identity(&self) -> Pubkey {
        marker_pda(&self.migration)
    }
    pub fn deposit(&self, holder: &Pubkey) -> Pubkey {
        mig_deposit_pda(&self.migration, holder)
    }
}

// ── Mints and token accounts ─────────────────────────────────────────────────

/// A legacy SPL Token mint; the fee payer is its mint authority.
pub fn spl_mint(w: &mut World, decimals: u8) -> Pubkey {
    let fees = w.fees.insecure_clone();
    let mint = Keypair::new();
    let create = system_instruction::create_account(
        &fees.pubkey(),
        &mint.pubkey(),
        w.svm.minimum_balance_for_rent_exemption(82),
        82,
        &SPL_TOKEN,
    );
    let init =
        token_ix::initialize_mint2(&SPL_TOKEN, &mint.pubkey(), &fees.pubkey(), None, decimals)
            .unwrap();
    w.send(&[&mint], &[create, init], "create SPL mint");
    mint.pubkey()
}

/// The Token-2022 mint extensions the old-mint policy is tested against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ext {
    TransferFee,
    TransferHook,
    NonTransferable,
    PermanentDelegate,
    ConfidentialTransfer,
    DefaultFrozen,
    DefaultInitialized,
    InterestBearing,
    ScaledUiAmount,
    Pausable,
    MetadataPointer,
    MintCloseAuthority,
}

/// A Token-2022 mint with `exts` (fee payer = mint and every extension
/// authority), initialized like a real issuer's would be.
pub fn t22_mint(w: &mut World, decimals: u8, exts: &[Ext]) -> Pubkey {
    let fees = w.fees.insecure_clone();
    let authority = fees.pubkey();
    let mint = Keypair::new();
    let key = mint.pubkey();
    let kinds: Vec<ExtensionType> = exts
        .iter()
        .map(|e| match e {
            Ext::TransferFee => ExtensionType::TransferFeeConfig,
            Ext::TransferHook => ExtensionType::TransferHook,
            Ext::NonTransferable => ExtensionType::NonTransferable,
            Ext::PermanentDelegate => ExtensionType::PermanentDelegate,
            Ext::ConfidentialTransfer => ExtensionType::ConfidentialTransferMint,
            Ext::DefaultFrozen | Ext::DefaultInitialized => ExtensionType::DefaultAccountState,
            Ext::InterestBearing => ExtensionType::InterestBearingConfig,
            Ext::ScaledUiAmount => ExtensionType::ScaledUiAmount,
            Ext::Pausable => ExtensionType::Pausable,
            Ext::MetadataPointer => ExtensionType::MetadataPointer,
            Ext::MintCloseAuthority => ExtensionType::MintCloseAuthority,
        })
        .collect();
    let space = ExtensionType::try_calculate_account_len::<SplMint>(&kinds).unwrap();
    let mut ixs = vec![system_instruction::create_account(
        &authority,
        &key,
        w.svm.minimum_balance_for_rent_exemption(space),
        space as u64,
        &TOKEN_2022,
    )];
    for e in exts {
        ixs.push(match e {
            Ext::TransferFee => {
                extension::transfer_fee::instruction::initialize_transfer_fee_config(
                    &TOKEN_2022,
                    &key,
                    Some(&authority),
                    Some(&authority),
                    100,
                    1_000,
                )
                .unwrap()
            }
            Ext::TransferHook => extension::transfer_hook::instruction::initialize(
                &TOKEN_2022,
                &key,
                Some(authority),
                Some(transfer_hook::ID),
            )
            .unwrap(),
            Ext::NonTransferable => {
                token_ix::initialize_non_transferable_mint(&TOKEN_2022, &key).unwrap()
            }
            Ext::PermanentDelegate => {
                token_ix::initialize_permanent_delegate(&TOKEN_2022, &key, &authority).unwrap()
            }
            Ext::ConfidentialTransfer => {
                extension::confidential_transfer::instruction::initialize_mint(
                    &TOKEN_2022,
                    &key,
                    Some(authority),
                    true,
                    None,
                )
                .unwrap()
            }
            Ext::DefaultFrozen | Ext::DefaultInitialized => {
                let state = if *e == Ext::DefaultFrozen {
                    AccountState::Frozen
                } else {
                    AccountState::Initialized
                };
                extension::default_account_state::instruction::initialize_default_account_state(
                    &TOKEN_2022,
                    &key,
                    &state,
                )
                .unwrap()
            }
            Ext::InterestBearing => extension::interest_bearing_mint::instruction::initialize(
                &TOKEN_2022,
                &key,
                Some(authority),
                100,
            )
            .unwrap(),
            Ext::ScaledUiAmount => extension::scaled_ui_amount::instruction::initialize(
                &TOKEN_2022,
                &key,
                Some(authority),
                2.0,
            )
            .unwrap(),
            Ext::Pausable => {
                extension::pausable::instruction::initialize(&TOKEN_2022, &key, &authority).unwrap()
            }
            Ext::MetadataPointer => extension::metadata_pointer::instruction::initialize(
                &TOKEN_2022,
                &key,
                Some(authority),
                Some(key),
            )
            .unwrap(),
            Ext::MintCloseAuthority => {
                token_ix::initialize_mint_close_authority(&TOKEN_2022, &key, Some(&authority))
                    .unwrap()
            }
        });
    }
    // A DefaultAccountState mint needs a freeze authority.
    let freeze = exts
        .iter()
        .any(|e| matches!(e, Ext::DefaultFrozen | Ext::DefaultInitialized))
        .then_some(authority);
    ixs.push(
        token_ix::initialize_mint2(&TOKEN_2022, &key, &authority, freeze.as_ref(), decimals)
            .unwrap(),
    );
    w.send(&[&mint], &ixs, "create Token-2022 mint");
    key
}

/// `owner`'s associated token account of `mint` under `program` (created
/// when missing; a Token-2022 ATA carries ImmutableOwner).
pub fn ata(w: &mut World, mint: &Pubkey, owner: &Pubkey, program: &Pubkey) -> Pubkey {
    let address = get_associated_token_address_with_program_id(owner, mint, program);
    if w.svm.get_account(&address).is_none() {
        let fees = w.fees.pubkey();
        let ix = ata_ix::create_associated_token_account(&fees, owner, mint, program);
        w.send(&[], &[ix], "create ATA");
    }
    address
}

/// Mints `amount` of a fee-payer-controlled mint into `to`.
pub fn mint_old(w: &mut World, mint: &Pubkey, program: &Pubkey, to: &Pubkey, amount: u64) {
    let fees = w.fees.pubkey();
    let ix = token_ix::mint_to(program, mint, to, &fees, &[], amount).unwrap();
    w.send(&[], &[ix], "mint old tokens");
}

/// The amount of an SPL / Token-2022 token account (bytes 64..72); 0 when
/// the account does not exist.
pub fn balance(w: &World, token_account: &Pubkey) -> u64 {
    w.svm.get_account(token_account).map_or(0, |a| {
        u64::from_le_bytes(a.data[64..72].try_into().unwrap())
    })
}

/// A mint's supply (bytes 36..44).
pub fn supply(w: &World, mint: &Pubkey) -> u64 {
    let data = w.svm.get_account(mint).expect("mint").data;
    u64::from_le_bytes(data[36..44].try_into().unwrap())
}

/// `mint_to_treasury(amount)` into the issuer authority's own account (the
/// authority holds the global Admin role, which a treasury mint requires).
pub fn mint_to_treasury_ix(
    authority: &Pubkey,
    fx: &Fixture,
    destination: &Pubkey,
    amount: u64,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::MintToTreasury { amount }.data(),
        acc::MintToTreasury {
            authority: *authority,
            admin_record: admin_pda(authority),
            issuer: fx.issuer,
            asset: fx.asset,
            share_class: fx.share_class,
            mint: fx.mint,
            destination: *destination,
            token_program: TOKEN_2022,
            platform: platform_pda(),
        }
        .to_account_metas(None),
    )
}

// ── Hook tails ───────────────────────────────────────────────────────────────

fn ro(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, false)
}

/// The Open-mode tail of a share-unit leg whose source owner is `source_owner`.
pub fn open_tail(mint: &Pubkey, source_owner: &Pubkey) -> Vec<AccountMeta> {
    vec![
        ro(block_entry_pda(source_owner)),
        ro(extra_metas_pda(mint)),
        ro(transfer_hook::ID),
    ]
}

/// The KycGated-mode tail of a share-unit leg, in meta-list order.
pub fn kyc_tail(
    mint: &Pubkey,
    registry: &Pubkey,
    source_owner: &Pubkey,
    dest_owner: &Pubkey,
) -> Vec<AccountMeta> {
    vec![
        ro(block_entry_pda(source_owner)),
        ro(hook_config_pda(mint)),
        ro(*registry),
        ro(asset_registry::ID),
        ro(kyc_entry_pda(registry, dest_owner)),
        ro(marker_pda(dest_owner)),
        ro(marker_pda(source_owner)),
        ro(extra_metas_pda(mint)),
        ro(transfer_hook::ID),
    ]
}

// ── Instruction builders ─────────────────────────────────────────────────────

fn ix(data: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction {
    Instruction::new_with_bytes(asset_registry::ID, &data, metas)
}

fn with_tail(mut metas: Vec<AccountMeta>, tail: Vec<AccountMeta>) -> Vec<AccountMeta> {
    metas.extend(tail);
    metas
}

pub fn create_ix(
    admin: &Pubkey,
    issuer_authority: &Pubkey,
    fx: &Fixture,
    old_mint: &Pubkey,
    old_program: &Pubkey,
    t: &Terms,
) -> Instruction {
    let migration = migration_pda(&fx.share_class, t.id);
    ix(
        ixd::CreateMigration {
            migration_id: t.id,
            lot: t.lot,
            units_cap: t.units_cap,
            opens_at: t.opens_at,
            closes_at: t.closes_at,
            claim_deadline: t.claim_deadline,
            return_to: t.return_to,
            terms_hash: t.terms_hash,
        }
        .data(),
        acc::CreateMigration {
            authority: *admin,
            admin_record: admin_pda(admin),
            issuer_authority: *issuer_authority,
            issuer: fx.issuer,
            asset: fx.asset,
            share_class: fx.share_class,
            mint: fx.mint,
            old_mint: *old_mint,
            migration,
            migration_escrow: mig_escrow_pda(&migration),
            migration_vault: mig_vault_pda(&migration),
            migration_identity: marker_pda(&migration),
            token_program: TOKEN_2022,
            old_token_program: *old_program,
            system_program: system_program::ID,
            platform: platform_pda(),
        }
        .to_account_metas(None),
    )
}

pub fn fund_ix(
    authority: &Pubkey,
    m: &Mig,
    source: &Pubkey,
    units: u64,
    tail: Vec<AccountMeta>,
) -> Instruction {
    ix(
        ixd::FundMigration { units }.data(),
        with_tail(
            acc::FundMigration {
                authority: *authority,
                migration: m.migration,
                issuer: m.fx.issuer,
                mint: m.fx.mint,
                migration_vault: m.vault(),
                source: *source,
                migration_identity: m.identity(),
                token_program: TOKEN_2022,
                platform: platform_pda(),
            }
            .to_account_metas(None),
            tail,
        ),
    )
}

pub fn open_ix(admin: &Pubkey, m: &Mig) -> Instruction {
    ix(
        ixd::OpenMigration {}.data(),
        acc::OpenMigration {
            authority: *admin,
            admin_record: admin_pda(admin),
            migration: m.migration,
            platform: platform_pda(),
        }
        .to_account_metas(None),
    )
}

/// A deposit into an Open class: the proof of the mode is the share mint's
/// meta list (its Open shape).
pub fn deposit_ix(holder: &Pubkey, m: &Mig, holder_old: &Pubkey, lots: u64) -> Instruction {
    let proof = vec![ro(extra_metas_pda(&m.fx.mint))];
    deposit_ix_with(holder, m, holder_old, lots, proof)
}

/// A deposit with an explicit mode proof (`kyc_proof` on a KycGated class,
/// nothing to test `KycProofRequired`).
pub fn deposit_ix_with(
    holder: &Pubkey,
    m: &Mig,
    holder_old: &Pubkey,
    lots: u64,
    proof: Vec<AccountMeta>,
) -> Instruction {
    ix(
        ixd::DepositMigration { lots }.data(),
        with_tail(
            acc::DepositMigration {
                holder: *holder,
                migration: m.migration,
                migration_deposit: m.deposit(holder),
                old_mint: m.old_mint,
                migration_escrow: m.escrow(),
                holder_token_account: *holder_old,
                old_token_program: m.old_program,
                system_program: system_program::ID,
                platform: platform_pda(),
                holder_block_entry: block_entry_pda(holder),
            }
            .to_account_metas(None),
            proof,
        ),
    )
}

/// The KycGated mode proof of a deposit: the share mint's hook config, its
/// registry and the holder's entry.
pub fn kyc_proof(mint: &Pubkey, registry: &Pubkey, holder: &Pubkey) -> Vec<AccountMeta> {
    vec![
        ro(hook_config_pda(mint)),
        ro(*registry),
        ro(kyc_entry_pda(registry, holder)),
    ]
}

pub fn cancel_ix(admin: &Pubkey, m: &Mig) -> Instruction {
    ix(
        ixd::CancelMigration {}.data(),
        acc::CancelMigration {
            authority: *admin,
            admin_record: admin_pda(admin),
            migration: m.migration,
        }
        .to_account_metas(None),
    )
}

pub fn refund_ix(m: &Mig, holder: &Pubkey, holder_old: &Pubkey) -> Instruction {
    ix(
        ixd::RefundMigrationDeposit {}.data(),
        acc::RefundMigrationDeposit {
            migration: m.migration,
            migration_deposit: m.deposit(holder),
            old_mint: m.old_mint,
            migration_escrow: m.escrow(),
            holder_token_account: *holder_old,
            old_token_program: m.old_program,
        }
        .to_account_metas(None),
    )
}

pub fn finalize_ix(m: &Mig) -> Instruction {
    ix(
        ixd::FinalizeMigration {}.data(),
        acc::FinalizeMigration {
            migration: m.migration,
        }
        .to_account_metas(None),
    )
}

pub fn claim_ix(
    holder: &Pubkey,
    m: &Mig,
    holder_share: &Pubkey,
    tail: Vec<AccountMeta>,
) -> Instruction {
    ix(
        ixd::ClaimMigration {}.data(),
        with_tail(
            acc::ClaimMigration {
                holder: *holder,
                migration: m.migration,
                migration_deposit: m.deposit(holder),
                mint: m.fx.mint,
                migration_vault: m.vault(),
                holder_share_account: *holder_share,
                token_program: TOKEN_2022,
            }
            .to_account_metas(None),
            tail,
        ),
    )
}

pub fn publish_ix(
    admin: &Pubkey,
    issuer_authority: &Pubkey,
    m: &Mig,
    root: [u8; 32],
    total_units: u64,
) -> Instruction {
    ix(
        ixd::PublishMigrationRoot { root, total_units }.data(),
        acc::PublishMigrationRoot {
            authority: *admin,
            admin_record: admin_pda(admin),
            issuer_authority: *issuer_authority,
            migration: m.migration,
            issuer: m.fx.issuer,
            platform: platform_pda(),
        }
        .to_account_metas(None),
    )
}

pub fn claim_proof_ix(
    claimer: &Pubkey,
    m: &Mig,
    claimer_share: &Pubkey,
    units: u64,
    proof: Vec<[u8; 32]>,
    tail: Vec<AccountMeta>,
) -> Instruction {
    ix(
        ixd::ClaimMigrationProof { units, proof }.data(),
        with_tail(
            acc::ClaimMigrationProof {
                claimer: *claimer,
                migration: m.migration,
                proof_claim: mig_claim_pda(&m.migration, claimer),
                mint: m.fx.mint,
                migration_vault: m.vault(),
                claimer_share_account: *claimer_share,
                token_program: TOKEN_2022,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            tail,
        ),
    )
}

pub fn close_ix(
    admin: &Pubkey,
    m: &Mig,
    return_to_account: &Pubkey,
    tail: Vec<AccountMeta>,
) -> Instruction {
    ix(
        ixd::CloseMigration {}.data(),
        with_tail(
            acc::CloseMigration {
                authority: *admin,
                admin_record: admin_pda(admin),
                migration: m.migration,
                rent_to: m.admin,
                mint: m.fx.mint,
                migration_vault: m.vault(),
                return_to_account: *return_to_account,
                old_mint: m.old_mint,
                migration_escrow: m.escrow(),
                migration_identity: m.identity(),
                token_program: TOKEN_2022,
                old_token_program: m.old_program,
            }
            .to_account_metas(None),
            tail,
        ),
    )
}

// ── Sending with compute units ───────────────────────────────────────────────

/// Like `World::try_send`, returning `(logs, compute units consumed)`.
pub fn send_cu(
    w: &mut World,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<(Vec<String>, u64), String> {
    w.svm.expire_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&w.fees.pubkey()), &w.svm.latest_blockhash());
    let mut all: Vec<&Keypair> = vec![&w.fees];
    for s in signers {
        if !all.iter().any(|k| k.pubkey() == s.pubkey()) {
            all.push(s);
        }
    }
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all)
        .map_err(|e| format!("sign: {e:?}"))?;
    w.svm
        .send_transaction(tx)
        .map(|meta| (meta.logs, meta.compute_units_consumed))
        .map_err(|e| format!("{e:?}"))
}
