//! transfer_hook program tests (LiteSVM).
//!
//! 1. config + blocklist lifecycle (pure-Anchor instructions)
//! 2. the `Execute` hook entrypoint — drives the SPL transfer-hook `Execute`
//!    instruction directly and asserts a blocklisted sender is rejected.
//!
//! Driving `Execute` directly (with the SPL discriminator) exercises the real
//! `process_execute` logic. Token-2022's own job — resolving the extra accounts
//! and CPI-ing the hook during `transferChecked` — is covered by the SPL test
//! suite; the genuine cross-program `transferChecked` integration check is a
//! follow-up.

#[path = "../../../tests/support/mod.rs"]
mod support;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_account::Account,
    solana_clock::Clock,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    spl_transfer_hook_interface::instruction::TransferHookInstruction,
    transfer_hook::{
        accounts as acc, instruction as ixd, BlockEntry, RestrictionMode, TransferHookConfig,
        ASSET_REGISTRY_PROGRAM,
    },
};

/// Sends a single-instruction tx; panics on failure.
fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction, label: &str) {
    if let Err(e) = try_send(svm, payer, ix) {
        panic!("[{label}] transaction failed: {e}");
    }
}

/// Sends a single-instruction tx; returns the outcome instead of panicking.
fn try_send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> Result<(), String> {
    try_send_signed(svm, &[payer], ix)
}

/// Like `send`, but with extra signers (first = fee payer).
fn send_signed(svm: &mut LiteSVM, signers: &[&Keypair], ix: Instruction, label: &str) {
    if let Err(e) = try_send_signed(svm, signers, ix) {
        panic!("[{label}] transaction failed: {e}");
    }
}

/// Like `try_send`, but with extra signers (first = fee payer).
fn try_send_signed(svm: &mut LiteSVM, signers: &[&Keypair], ix: Instruction) -> Result<(), String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&signers[0].pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).expect("sign");
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

/// Fabricates a registry-owned, `ShareClass`-shaped account at a keypair
/// address so that keypair can co-sign `initialize_transfer_hook_config` in
/// these direct tests. On-chain a real `ShareClass` is a PDA (no private key),
/// so only the asset_registry program's CPI can produce the signature — the
/// fixture stands in for that CPI.
fn install_fake_share_class(svm: &mut LiteSVM, address: &Pubkey) {
    let mut data = vec![0u8; 32];
    data[..8].copy_from_slice(&transfer_hook::SHARE_CLASS_DISCRIMINATOR);
    svm.set_account(
        *address,
        Account {
            lamports: 2_000_000,
            data,
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

/// Builds an `initialize_transfer_hook_config` instruction (post-gate layout:
/// the registry-owned `share_class` co-signs and is stored, not passed as arg).
fn init_config_ix(
    program_id: Pubkey,
    payer: &Pubkey,
    mint: &Pubkey,
    share_class: &Pubkey,
    config_pda: &Pubkey,
    restriction_mode: RestrictionMode,
    kyc_registry: Option<Pubkey>,
) -> Instruction {
    Instruction::new_with_bytes(
        program_id,
        &ixd::InitializeTransferHookConfig {
            blocklist: Pubkey::new_unique(),
            restriction_mode,
            kyc_registry,
        }
        .data(),
        acc::InitializeTransferHookConfig {
            authority: *payer,
            mint: *mint,
            share_class: *share_class,
            config: *config_pda,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn load<T: AccountDeserialize>(svm: &LiteSVM, pda: &Pubkey, label: &str) -> T {
    let account = svm
        .get_account(pda)
        .unwrap_or_else(|| panic!("[{label}] account not found"));
    T::try_deserialize(&mut account.data.as_slice())
        .unwrap_or_else(|e| panic!("[{label}] deserialize failed: {e:?}"))
}

#[test]
fn transfer_hook_config_and_blocklist() {
    let program_id = transfer_hook::id();

    let mut svm = LiteSVM::new();
    let bytes = include_bytes!("../../../target/deploy/transfer_hook.so");
    svm.add_program(program_id, bytes).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    let mint = Keypair::new().pubkey();
    let blocked_wallet = Keypair::new().pubkey();

    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );
    let (block_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::BLOCK_ENTRY_SEED, blocked_wallet.as_ref()],
        &program_id,
    );

    let (blocklist_authority_pda, _) =
        Pubkey::find_program_address(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED], &program_id);
    support::set_upgrade_authority(&mut svm, &transfer_hook::ID, Some(payer.pubkey()));
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeBlocklistAuthority {
                authority: payer.pubkey(),
            }
            .data(),
            acc::InitializeBlocklistAuthority {
                payer: payer.pubkey(),
                upgrade_authority: payer.pubkey(),
                program: transfer_hook::ID,
                program_data: support::program_data(&transfer_hook::ID),
                blocklist_authority: blocklist_authority_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_blocklist_authority",
    );

    // ── 1. initialize_transfer_hook_config (registry-owned co-signer) ────────
    let share_class_kp = Keypair::new();
    install_fake_share_class(&mut svm, &share_class_kp.pubkey());
    send_signed(
        &mut svm,
        &[&payer, &share_class_kp],
        init_config_ix(
            program_id,
            &payer.pubkey(),
            &mint,
            &share_class_kp.pubkey(),
            &config_pda,
            RestrictionMode::Open,
            None,
        ),
        "initialize_transfer_hook_config",
    );
    let cfg: TransferHookConfig = load(&svm, &config_pda, "config");
    assert_eq!(cfg.mint, mint);
    assert_eq!(cfg.share_class, share_class_kp.pubkey());
    assert_eq!(cfg.restriction_mode, RestrictionMode::Open);
    assert_eq!(cfg.kyc_registry, None);

    // ── 2. add_to_blocklist ──────────────────────────────────────────────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::AddToBlocklist {
                wallet: blocked_wallet,
            }
            .data(),
            acc::AddToBlocklist {
                authority: payer.pubkey(),
                blocklist_authority: blocklist_authority_pda,
                block_entry: block_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "add_to_blocklist",
    );
    let entry: BlockEntry = load(&svm, &block_pda, "block_entry");
    assert_eq!(entry.wallet, blocked_wallet);
    assert_eq!(entry.added_by, payer.pubkey());

    // ── 3. remove_from_blocklist ─────────────────────────────────────────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::RemoveFromBlocklist {
                wallet: blocked_wallet,
            }
            .data(),
            acc::RemoveFromBlocklist {
                authority: payer.pubkey(),
                blocklist_authority: blocklist_authority_pda,
                block_entry: block_pda,
            }
            .to_account_metas(None),
        ),
        "remove_from_blocklist",
    );
    let closed = svm
        .get_account(&block_pda)
        .map(|a| a.data.is_empty() || a.lamports == 0)
        .unwrap_or(true);
    assert!(closed, "block entry should be closed");

    println!("transfer_hook OK — config + blocklist add/remove");
}

#[test]
fn execute_blocks_blocklisted_sender() {
    let program_id = transfer_hook::id();

    let mut svm = LiteSVM::new();
    let bytes = include_bytes!("../../../target/deploy/transfer_hook.so");
    svm.add_program(program_id, bytes).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    let mint = Keypair::new().pubkey();
    let sender = Keypair::new().pubkey(); // the transfer's source authority
    let src_token = Pubkey::new_unique();
    svm.set_account(src_token, dest_token_account(&sender))
        .unwrap();
    let dst_token = Pubkey::new_unique();
    svm.set_account(dst_token, dest_token_account(&Pubkey::new_unique()))
        .unwrap();

    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );
    let (extra_metas_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint.as_ref()],
        &program_id,
    );
    let (block_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::BLOCK_ENTRY_SEED, sender.as_ref()],
        &program_id,
    );

    let (blocklist_authority_pda, _) =
        Pubkey::find_program_address(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED], &program_id);
    support::set_upgrade_authority(&mut svm, &transfer_hook::ID, Some(payer.pubkey()));
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeBlocklistAuthority {
                authority: payer.pubkey(),
            }
            .data(),
            acc::InitializeBlocklistAuthority {
                payer: payer.pubkey(),
                upgrade_authority: payer.pubkey(),
                program: transfer_hook::ID,
                program_data: support::program_data(&transfer_hook::ID),
                blocklist_authority: blocklist_authority_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_blocklist_authority",
    );

    // ── 1. initialize_transfer_hook_config (Open) — meta list reads it ────────
    let share_class_kp = Keypair::new();
    install_fake_share_class(&mut svm, &share_class_kp.pubkey());
    send_signed(
        &mut svm,
        &[&payer, &share_class_kp],
        init_config_ix(
            program_id,
            &payer.pubkey(),
            &mint,
            &share_class_kp.pubkey(),
            &config_pda,
            RestrictionMode::Open,
            None,
        ),
        "initialize_transfer_hook_config",
    );

    // ── 2. initialize_extra_account_meta_list ────────────────────────────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeExtraAccountMetaList {}.data(),
            acc::InitializeExtraAccountMetaList {
                payer: payer.pubkey(),
                mint,
                config: config_pda,
                extra_account_meta_list: extra_metas_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_extra_account_meta_list",
    );
    let list = svm
        .get_account(&extra_metas_pda)
        .expect("ExtraAccountMetaList account should exist");
    assert_eq!(list.owner, program_id);
    assert!(!list.data.is_empty());

    // The SPL `Execute` instruction, as Token-2022 would build it:
    //   0 source · 1 mint · 2 destination · 3 source authority ·
    //   4 ExtraAccountMetaList · 5 source BlockEntry.
    let build_execute = || Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(src_token, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(dst_token, false),
            AccountMeta::new_readonly(sender, false),
            AccountMeta::new_readonly(extra_metas_pda, false),
            AccountMeta::new_readonly(block_pda, false),
        ],
        data: TransferHookInstruction::Execute { amount: 1_000 }.pack(),
    };

    // ── 2. Execute — sender not blocklisted ⇒ passes ─────────────────────────
    assert!(
        try_send(&mut svm, &payer, build_execute()).is_ok(),
        "Execute should pass when the sender is not blocklisted"
    );

    // ── 3. blocklist the sender ──────────────────────────────────────────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::AddToBlocklist { wallet: sender }.data(),
            acc::AddToBlocklist {
                authority: payer.pubkey(),
                blocklist_authority: blocklist_authority_pda,
                block_entry: block_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "add_to_blocklist",
    );

    // ── 4. Execute again — sender blocklisted ⇒ rejected ─────────────────────
    svm.expire_blockhash(); // structurally identical tx — force a fresh blockhash
    assert!(
        try_send(&mut svm, &payer, build_execute()).is_err(),
        "Execute should fail when the sender is blocklisted"
    );

    println!("transfer_hook OK — Execute blocks blocklisted sender");
}

// ── KycGated receiver-eligibility tests ──────────────────────────────────────
//
// These unit-test the hook's `Execute` logic directly. We fabricate the
// asset_registry-owned `KycRegistry` / `KycEntry` accounts (and the Token-2022
// destination token account) with `set_account`, matching the raw byte layout
// the asset_registry program writes — we do NOT load that program. The Execute
// account list is built to mirror the KycGated meta-list order:
//   0 source · 1 mint · 2 destination · 3 source authority · 4 metas ·
//   5 source BlockEntry · 6 TransferHookConfig · 7 KycRegistry ·
//   8 asset_registry program · 9 receiver KycEntry ·
//   10 destination-owner EscrowMarker · 11 source-owner EscrowMarker.

/// `KycStatus` discriminants, matching asset_registry's enum order
/// (Pending=0, Approved=1, Revoked=2, Expired=3). Only the ones used by the
/// cases below are named.
const KYC_APPROVED: u8 = 1;
const KYC_REVOKED: u8 = 2;

/// `HookError` custom codes (Anchor base 6000 + variant index). Used to assert
/// each negative case fails for the *intended* reason, not an incidental one.
const ERR_RECEIVER_NOT_APPROVED: u32 = 6005;
const ERR_HOLDER_KYC_EXPIRED: u32 = 6006;
const ERR_JURISDICTION_BLOCKED: u32 = 6007;

/// Asserts a tx failed with a specific Anchor custom error code. The LiteSVM
/// failure debug string embeds `Custom(<code>)`, so we match on that.
fn assert_hook_err(result: Result<(), String>, code: u32, label: &str) {
    let err = match result {
        Ok(()) => panic!("[{label}] expected failure, got success"),
        Err(e) => e,
    };
    let needle = format!("Custom({code})");
    assert!(
        err.contains(&needle),
        "[{label}] expected {needle}, got: {err}"
    );
}

/// Builds the raw bytes of an asset_registry `KycEntry` account.
/// Layout after the 8-byte Anchor discriminator:
///   registry(32) holder(32) status@72(1) jurisdiction@73(u16 LE)
///   accreditation@75(1) expiry@76(i64 LE) provider_id@84(u16) ref_hash@86(32)
///   version@118(1) bump@119(1) — total 120 bytes.
fn kyc_entry_bytes(
    registry: &Pubkey,
    holder: &Pubkey,
    status: u8,
    jurisdiction: u16,
    expiry: i64,
) -> Vec<u8> {
    let mut d = vec![0u8; 120];
    // Discriminator bytes [0..8) are irrelevant to the hook (it reads by offset).
    d[8..40].copy_from_slice(registry.as_ref());
    d[40..72].copy_from_slice(holder.as_ref());
    d[72] = status;
    d[73..75].copy_from_slice(&jurisdiction.to_le_bytes());
    d[75] = 0; // accreditation_level
    d[76..84].copy_from_slice(&expiry.to_le_bytes());
    d[84..86].copy_from_slice(&7u16.to_le_bytes()); // provider_id
    d[118] = 1; // version
    d[119] = 255; // bump
    d
}

/// Builds the raw bytes of an asset_registry `KycRegistry` account.
/// Layout after disc: authority(32) approved@40([u8;128]) blocked@168([u8;128])
/// entries_count@296(u64) version@304(1) bump@305(1) — total 306 bytes.
fn kyc_registry_bytes(authority: &Pubkey, approved: [u8; 128], blocked: [u8; 128]) -> Vec<u8> {
    let mut d = vec![0u8; 306];
    d[..8].copy_from_slice(&transfer_hook::KYC_REGISTRY_DISCRIMINATOR);
    d[8..40].copy_from_slice(authority.as_ref());
    d[40..168].copy_from_slice(&approved);
    d[168..296].copy_from_slice(&blocked);
    d[296..304].copy_from_slice(&1u64.to_le_bytes()); // entries_count
    d[304] = 1; // version
    d[305] = 255; // bump
    d
}

/// Installs a well-formed `KycRegistry` account (306 B, real discriminator)
/// at `key`, owned by `owner` — `ASSET_REGISTRY_PROGRAM` for a genuine one.
fn install_kyc_registry(svm: &mut LiteSVM, key: &Pubkey, owner: Pubkey) {
    install_raw_registry(
        svm,
        key,
        owner,
        kyc_registry_bytes(&Pubkey::new_unique(), [0u8; 128], [0u8; 128]),
    );
}

fn install_raw_registry(svm: &mut LiteSVM, key: &Pubkey, owner: Pubkey, data: Vec<u8>) {
    svm.set_account(
        *key,
        Account {
            lamports: 3_000_000,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

/// Sets the bit for `jurisdiction` in a 128-byte bitmap.
fn set_jurisdiction_bit(map: &mut [u8; 128], jurisdiction: u16) {
    let byte = (jurisdiction / 8) as usize;
    let bit = (jurisdiction % 8) as u8;
    map[byte] |= 1 << bit;
}

/// Fabricates an initialized Token-2022 account with ImmutableOwner.
/// Real Token-2022 CPIs and ATA creation are covered by registry integration tests.
fn dest_token_account(owner: &Pubkey) -> Account {
    let mut data = vec![0u8; 170]; // initialized account + ImmutableOwner TLV
    data[32..64].copy_from_slice(owner.as_ref());
    data[108] = 1; // AccountState::Initialized
    data[165] = 2; // AccountType::Account
    data[166..168].copy_from_slice(
        &(spl_token_2022_interface::extension::ExtensionType::ImmutableOwner as u16).to_le_bytes(),
    );
    Account {
        lamports: 2_000_000,
        data,
        owner: spl_token_2022_interface::ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn token_owner_marker(svm: &LiteSVM, token: &Pubkey) -> Pubkey {
    let data = svm.get_account(token).unwrap().data;
    Pubkey::find_program_address(
        &[transfer_hook::ESCROW_MARKER_SEED, &data[32..64]],
        &ASSET_REGISTRY_PROGRAM,
    )
    .0
}

/// Shared KycGated fixture: deploys the program, creates the blocklist authority,
/// a KycGated config (pointing at `registry`), and the extra-account-meta list.
/// Returns `(svm, payer, program_id, mint, registry, extra_metas_pda)`.
fn kyc_gated_fixture(registry: Pubkey) -> (LiteSVM, Keypair, Pubkey, Pubkey, Pubkey, Pubkey) {
    let program_id = transfer_hook::id();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!("../../../target/deploy/transfer_hook.so");
    svm.add_program(program_id, bytes).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    let mint = Keypair::new().pubkey();

    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );
    let (extra_metas_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint.as_ref()],
        &program_id,
    );
    let (blocklist_authority_pda, _) =
        Pubkey::find_program_address(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED], &program_id);

    support::set_upgrade_authority(&mut svm, &transfer_hook::ID, Some(payer.pubkey()));
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeBlocklistAuthority {
                authority: payer.pubkey(),
            }
            .data(),
            acc::InitializeBlocklistAuthority {
                payer: payer.pubkey(),
                upgrade_authority: payer.pubkey(),
                program: transfer_hook::ID,
                program_data: support::program_data(&transfer_hook::ID),
                blocklist_authority: blocklist_authority_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_blocklist_authority",
    );

    // KycGated config — its kyc_registry drives the meta-list shape.
    let share_class_kp = Keypair::new();
    install_fake_share_class(&mut svm, &share_class_kp.pubkey());
    send_signed(
        &mut svm,
        &[&payer, &share_class_kp],
        init_config_ix(
            program_id,
            &payer.pubkey(),
            &mint,
            &share_class_kp.pubkey(),
            &config_pda,
            RestrictionMode::KycGated,
            Some(registry),
        ),
        "initialize_transfer_hook_config",
    );

    // Extra-account-meta list — handler reads the config to pick the KycGated shape.
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeExtraAccountMetaList {}.data(),
            acc::InitializeExtraAccountMetaList {
                payer: payer.pubkey(),
                mint,
                config: config_pda,
                extra_account_meta_list: extra_metas_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_extra_account_meta_list",
    );

    (svm, payer, program_id, mint, registry, extra_metas_pda)
}

/// Derives the unresolved (system-owned) source `BlockEntry` PDA for a sender.
fn block_entry_pda(program_id: &Pubkey, sender: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[transfer_hook::BLOCK_ENTRY_SEED, sender.as_ref()],
        program_id,
    )
    .0
}

/// Derives the receiver `KycEntry` PDA `["kyc", registry, holder]` under the
/// asset_registry program — what Token-2022 would resolve from the meta list.
fn kyc_entry_pda(registry: &Pubkey, holder: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"kyc", registry.as_ref(), holder.as_ref()],
        &ASSET_REGISTRY_PROGRAM,
    )
    .0
}

#[allow(clippy::too_many_arguments)]
fn build_kyc_execute(
    program_id: Pubkey,
    mint: Pubkey,
    src_token: Pubkey,
    dst_token: Pubkey,
    sender: Pubkey,
    extra_metas_pda: Pubkey,
    block_pda: Pubkey,
    config_pda: Pubkey,
    registry: Pubkey,
    kyc_entry: Pubkey,
) -> Instruction {
    // Unresolved (system-owned) marker PDAs — the wallet↔wallet default.
    build_kyc_execute_with_markers(
        program_id,
        mint,
        src_token,
        dst_token,
        sender,
        extra_metas_pda,
        block_pda,
        config_pda,
        registry,
        kyc_entry,
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    )
}

#[allow(clippy::too_many_arguments)]
fn build_kyc_execute_with_markers(
    program_id: Pubkey,
    mint: Pubkey,
    src_token: Pubkey,
    dst_token: Pubkey,
    sender: Pubkey,
    extra_metas_pda: Pubkey,
    block_pda: Pubkey,
    config_pda: Pubkey,
    registry: Pubkey,
    kyc_entry: Pubkey,
    dest_marker: Pubkey,
    src_marker: Pubkey,
) -> Instruction {
    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(src_token, false), // 0 source
            AccountMeta::new_readonly(mint, false),      // 1 mint
            AccountMeta::new_readonly(dst_token, false), // 2 destination
            AccountMeta::new_readonly(sender, false),    // 3 source authority
            AccountMeta::new_readonly(extra_metas_pda, false), // 4 metas list
            AccountMeta::new_readonly(block_pda, false), // 5 source BlockEntry
            AccountMeta::new_readonly(config_pda, false), // 6 TransferHookConfig
            AccountMeta::new_readonly(registry, false),  // 7 KycRegistry
            AccountMeta::new_readonly(ASSET_REGISTRY_PROGRAM, false), // 8 asset_registry program
            AccountMeta::new_readonly(kyc_entry, false), // 9 receiver KycEntry
            AccountMeta::new_readonly(dest_marker, false), // 10 dest-owner EscrowMarker
            AccountMeta::new_readonly(src_marker, false), // 11 source-owner EscrowMarker
        ],
        data: TransferHookInstruction::Execute { amount: 1_000 }.pack(),
    }
}

/// Fabricates an initialised, asset_registry-owned `EscrowMarker`-shaped
/// account at `address` (the hook only checks owner + non-empty data).
fn install_escrow_marker(svm: &mut LiteSVM, address: &Pubkey, owner_program: Pubkey) {
    svm.set_account(
        *address,
        Account {
            lamports: 2_000_000,
            data: [
                transfer_hook::ESCROW_MARKER_DISCRIMINATOR.as_slice(),
                &[0u8],
            ]
            .concat(),
            owner: owner_program,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

/// Sets the SVM clock so `now` is a known unix timestamp (entries use absolute ts).
fn set_clock(svm: &mut LiteSVM, unix_ts: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_ts;
    svm.set_sysvar(&clock);
}

#[test]
fn kyc_gated_approved_in_jurisdiction_passes() {
    let registry = Pubkey::new_unique();
    let (mut svm, payer, program_id, mint, registry, extra_metas_pda) = kyc_gated_fixture(registry);
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );

    set_clock(&mut svm, 1_000_000);

    let sender = Keypair::new().pubkey();
    let receiver = Keypair::new().pubkey();
    let src_token = Pubkey::new_unique();
    svm.set_account(src_token, dest_token_account(&sender))
        .unwrap();
    let dst_token = Pubkey::new_unique();
    svm.set_account(dst_token, dest_token_account(&Pubkey::new_unique()))
        .unwrap();
    let jurisdiction: u16 = 688; // Serbia — a real code the old 256-bit bitmap could not encode

    // Registry: approve the holder's jurisdiction, block nothing.
    let mut approved = [0u8; 128];
    set_jurisdiction_bit(&mut approved, jurisdiction);
    svm.set_account(
        registry,
        Account {
            lamports: 2_000_000,
            data: kyc_registry_bytes(&Pubkey::new_unique(), approved, [0u8; 128]),
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    // Destination token account owned by the receiver.
    svm.set_account(dst_token, dest_token_account(&receiver))
        .unwrap();

    // Approved, non-expired KycEntry for the receiver.
    let kyc_entry = kyc_entry_pda(&registry, &receiver);
    svm.set_account(
        kyc_entry,
        Account {
            lamports: 2_000_000,
            data: kyc_entry_bytes(&registry, &receiver, KYC_APPROVED, jurisdiction, 2_000_000),
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let block_pda = block_entry_pda(&program_id, &sender);
    let ix = build_kyc_execute(
        program_id,
        mint,
        src_token,
        dst_token,
        sender,
        extra_metas_pda,
        block_pda,
        config_pda,
        registry,
        kyc_entry,
    );
    assert!(
        try_send(&mut svm, &payer, ix).is_ok(),
        "KycGated Execute should pass for an approved, in-jurisdiction receiver"
    );
    println!("transfer_hook OK — KycGated approved/in-jurisdiction passes");
}

#[test]
fn kyc_gated_missing_entry_fails() {
    let registry = Pubkey::new_unique();
    let (mut svm, payer, program_id, mint, registry, extra_metas_pda) = kyc_gated_fixture(registry);
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );

    set_clock(&mut svm, 1_000_000);

    let sender = Keypair::new().pubkey();
    let receiver = Keypair::new().pubkey();
    let src_token = Pubkey::new_unique();
    svm.set_account(src_token, dest_token_account(&sender))
        .unwrap();
    let dst_token = Pubkey::new_unique();
    svm.set_account(dst_token, dest_token_account(&Pubkey::new_unique()))
        .unwrap();
    let jurisdiction: u16 = 130;

    let mut approved = [0u8; 128];
    set_jurisdiction_bit(&mut approved, jurisdiction);
    svm.set_account(
        registry,
        Account {
            lamports: 2_000_000,
            data: kyc_registry_bytes(&Pubkey::new_unique(), approved, [0u8; 128]),
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    svm.set_account(dst_token, dest_token_account(&receiver))
        .unwrap();

    // KycEntry PDA is NEVER created ⇒ system-owned / empty ⇒ ReceiverNotApproved.
    let kyc_entry = kyc_entry_pda(&registry, &receiver);
    let block_pda = block_entry_pda(&program_id, &sender);
    let ix = build_kyc_execute(
        program_id,
        mint,
        src_token,
        dst_token,
        sender,
        extra_metas_pda,
        block_pda,
        config_pda,
        registry,
        kyc_entry,
    );
    assert_hook_err(
        try_send(&mut svm, &payer, ix),
        ERR_RECEIVER_NOT_APPROVED,
        "missing_entry",
    );
    println!("transfer_hook OK — KycGated missing entry fails");
}

#[test]
fn kyc_gated_expired_fails() {
    let registry = Pubkey::new_unique();
    let (mut svm, payer, program_id, mint, registry, extra_metas_pda) = kyc_gated_fixture(registry);
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );

    set_clock(&mut svm, 1_000_000);

    let sender = Keypair::new().pubkey();
    let receiver = Keypair::new().pubkey();
    let src_token = Pubkey::new_unique();
    svm.set_account(src_token, dest_token_account(&sender))
        .unwrap();
    let dst_token = Pubkey::new_unique();
    svm.set_account(dst_token, dest_token_account(&Pubkey::new_unique()))
        .unwrap();
    let jurisdiction: u16 = 130;

    let mut approved = [0u8; 128];
    set_jurisdiction_bit(&mut approved, jurisdiction);
    svm.set_account(
        registry,
        Account {
            lamports: 2_000_000,
            data: kyc_registry_bytes(&Pubkey::new_unique(), approved, [0u8; 128]),
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    svm.set_account(dst_token, dest_token_account(&receiver))
        .unwrap();

    // Approved but expiry is in the past (clock = 1_000_000) ⇒ HolderKycExpired.
    let kyc_entry = kyc_entry_pda(&registry, &receiver);
    svm.set_account(
        kyc_entry,
        Account {
            lamports: 2_000_000,
            data: kyc_entry_bytes(&registry, &receiver, KYC_APPROVED, jurisdiction, 999_999),
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let block_pda = block_entry_pda(&program_id, &sender);
    let ix = build_kyc_execute(
        program_id,
        mint,
        src_token,
        dst_token,
        sender,
        extra_metas_pda,
        block_pda,
        config_pda,
        registry,
        kyc_entry,
    );
    // Approved but past expiry ⇒ HolderKycExpired (proves we got past the status
    // check, so the account wiring is correct).
    assert_hook_err(
        try_send(&mut svm, &payer, ix),
        ERR_HOLDER_KYC_EXPIRED,
        "expired",
    );
    println!("transfer_hook OK — KycGated expired entry fails");
}

#[test]
fn kyc_gated_revoked_fails() {
    let registry = Pubkey::new_unique();
    let (mut svm, payer, program_id, mint, registry, extra_metas_pda) = kyc_gated_fixture(registry);
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );

    set_clock(&mut svm, 1_000_000);

    let sender = Keypair::new().pubkey();
    let receiver = Keypair::new().pubkey();
    let src_token = Pubkey::new_unique();
    svm.set_account(src_token, dest_token_account(&sender))
        .unwrap();
    let dst_token = Pubkey::new_unique();
    svm.set_account(dst_token, dest_token_account(&Pubkey::new_unique()))
        .unwrap();
    let jurisdiction: u16 = 130;

    let mut approved = [0u8; 128];
    set_jurisdiction_bit(&mut approved, jurisdiction);
    svm.set_account(
        registry,
        Account {
            lamports: 2_000_000,
            data: kyc_registry_bytes(&Pubkey::new_unique(), approved, [0u8; 128]),
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    svm.set_account(dst_token, dest_token_account(&receiver))
        .unwrap();

    // Status Revoked (not Approved), entry not expired ⇒ ReceiverNotApproved.
    let kyc_entry = kyc_entry_pda(&registry, &receiver);
    svm.set_account(
        kyc_entry,
        Account {
            lamports: 2_000_000,
            data: kyc_entry_bytes(&registry, &receiver, KYC_REVOKED, jurisdiction, 2_000_000),
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let block_pda = block_entry_pda(&program_id, &sender);
    let ix = build_kyc_execute(
        program_id,
        mint,
        src_token,
        dst_token,
        sender,
        extra_metas_pda,
        block_pda,
        config_pda,
        registry,
        kyc_entry,
    );
    // Revoked (status != Approved) ⇒ ReceiverNotApproved.
    assert_hook_err(
        try_send(&mut svm, &payer, ix),
        ERR_RECEIVER_NOT_APPROVED,
        "revoked",
    );
    println!("transfer_hook OK — KycGated revoked entry fails");
}

#[test]
fn kyc_gated_blocked_jurisdiction_fails() {
    let registry = Pubkey::new_unique();
    let (mut svm, payer, program_id, mint, registry, extra_metas_pda) = kyc_gated_fixture(registry);
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );

    set_clock(&mut svm, 1_000_000);

    let sender = Keypair::new().pubkey();
    let receiver = Keypair::new().pubkey();
    let src_token = Pubkey::new_unique();
    svm.set_account(src_token, dest_token_account(&sender))
        .unwrap();
    let dst_token = Pubkey::new_unique();
    svm.set_account(dst_token, dest_token_account(&Pubkey::new_unique()))
        .unwrap();
    let jurisdiction: u16 = 130;

    // Jurisdiction is both approved AND blocked ⇒ blocked wins ⇒ JurisdictionBlocked.
    let mut approved = [0u8; 128];
    let mut blocked = [0u8; 128];
    set_jurisdiction_bit(&mut approved, jurisdiction);
    set_jurisdiction_bit(&mut blocked, jurisdiction);
    svm.set_account(
        registry,
        Account {
            lamports: 2_000_000,
            data: kyc_registry_bytes(&Pubkey::new_unique(), approved, blocked),
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    svm.set_account(dst_token, dest_token_account(&receiver))
        .unwrap();

    let kyc_entry = kyc_entry_pda(&registry, &receiver);
    svm.set_account(
        kyc_entry,
        Account {
            lamports: 2_000_000,
            data: kyc_entry_bytes(&registry, &receiver, KYC_APPROVED, jurisdiction, 2_000_000),
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let block_pda = block_entry_pda(&program_id, &sender);
    let ix = build_kyc_execute(
        program_id,
        mint,
        src_token,
        dst_token,
        sender,
        extra_metas_pda,
        block_pda,
        config_pda,
        registry,
        kyc_entry,
    );
    // Approved + not expired, but jurisdiction is blocked ⇒ JurisdictionBlocked
    // (proves status + expiry checks passed first).
    assert_hook_err(
        try_send(&mut svm, &payer, ix),
        ERR_JURISDICTION_BLOCKED,
        "blocked_jurisdiction",
    );
    println!("transfer_hook OK — KycGated blocked jurisdiction fails");
}

#[test]
fn kyc_gated_out_of_bitmap_jurisdiction_fails() {
    let registry = Pubkey::new_unique();
    let (mut svm, payer, program_id, mint, registry, extra_metas_pda) = kyc_gated_fixture(registry);
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );

    set_clock(&mut svm, 1_000_000);

    let sender = Keypair::new().pubkey();
    let receiver = Keypair::new().pubkey();
    let src_token = Pubkey::new_unique();
    svm.set_account(src_token, dest_token_account(&sender))
        .unwrap();
    let dst_token = Pubkey::new_unique();
    svm.set_account(dst_token, dest_token_account(&Pubkey::new_unique()))
        .unwrap();
    // Beyond the 1024-bit bitmap (byte index ≥ 128). No valid ISO-3166-1
    // numeric code lives here (the range ends at 999) — a `KycEntry` carrying
    // such a jurisdiction is malformed and must fail closed, even against a
    // registry that approves everything it CAN encode.
    let jurisdiction: u16 = 1024;

    svm.set_account(
        registry,
        Account {
            lamports: 2_000_000,
            data: kyc_registry_bytes(&Pubkey::new_unique(), [0xFFu8; 128], [0u8; 128]),
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    svm.set_account(dst_token, dest_token_account(&receiver))
        .unwrap();

    let kyc_entry = kyc_entry_pda(&registry, &receiver);
    svm.set_account(
        kyc_entry,
        Account {
            lamports: 2_000_000,
            data: kyc_entry_bytes(&registry, &receiver, KYC_APPROVED, jurisdiction, 2_000_000),
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let block_pda = block_entry_pda(&program_id, &sender);
    let ix = build_kyc_execute(
        program_id,
        mint,
        src_token,
        dst_token,
        sender,
        extra_metas_pda,
        block_pda,
        config_pda,
        registry,
        kyc_entry,
    );
    assert_hook_err(
        try_send(&mut svm, &payer, ix),
        ERR_JURISDICTION_BLOCKED,
        "out_of_bitmap_jurisdiction",
    );
    println!("transfer_hook OK — KycGated out-of-bitmap jurisdiction fails closed");
}

// ── KycGated escrow-marker exemption ─────────────────────────────────────────

/// `HookError::SenderBlocked`.
const ERR_SENDER_BLOCKED: u32 = 6003;

/// Shared setup for the marker tests: KycGated fixture with a valid registry
/// and NO KycEntry for the receiver (⇒ ReceiverNotApproved unless a marker
/// exempts the leg). Returns everything `build_kyc_execute_with_markers` needs.
#[allow(clippy::type_complexity)]
fn marker_fixture() -> (
    LiteSVM,
    Keypair,
    Pubkey, // program_id
    Pubkey, // mint
    Pubkey, // registry
    Pubkey, // extra_metas_pda
    Pubkey, // config_pda
    Pubkey, // src_token
    Pubkey, // dst_token
    Pubkey, // sender
    Pubkey, // kyc_entry (unresolved)
) {
    let registry = Pubkey::new_unique();
    let (mut svm, payer, program_id, mint, registry, extra_metas_pda) = kyc_gated_fixture(registry);
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );

    set_clock(&mut svm, 1_000_000);

    let sender = Keypair::new().pubkey();
    let receiver = Keypair::new().pubkey();
    let src_token = Pubkey::new_unique();
    svm.set_account(src_token, dest_token_account(&sender))
        .unwrap();
    let dst_token = Pubkey::new_unique();
    svm.set_account(dst_token, dest_token_account(&Pubkey::new_unique()))
        .unwrap();
    let jurisdiction: u16 = 130;

    let mut approved = [0u8; 128];
    set_jurisdiction_bit(&mut approved, jurisdiction);
    svm.set_account(
        registry,
        Account {
            lamports: 2_000_000,
            data: kyc_registry_bytes(&Pubkey::new_unique(), approved, [0u8; 128]),
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    svm.set_account(dst_token, dest_token_account(&receiver))
        .unwrap();

    // No KycEntry is ever installed for the receiver.
    let kyc_entry = kyc_entry_pda(&registry, &receiver);

    (
        svm,
        payer,
        program_id,
        mint,
        registry,
        extra_metas_pda,
        config_pda,
        src_token,
        dst_token,
        sender,
        kyc_entry,
    )
}

#[test]
fn kyc_gated_dest_escrow_marker_exempts_receiver_kyc() {
    let (
        mut svm,
        payer,
        program_id,
        mint,
        registry,
        extra_metas_pda,
        config_pda,
        src_token,
        dst_token,
        sender,
        kyc_entry,
    ) = marker_fixture();

    // Destination owner is a platform escrow: install its marker (idx 10).
    let dest_marker = token_owner_marker(&svm, &dst_token);
    install_escrow_marker(&mut svm, &dest_marker, ASSET_REGISTRY_PROGRAM);

    let block_pda = block_entry_pda(&program_id, &sender);
    let ix = build_kyc_execute_with_markers(
        program_id,
        mint,
        src_token,
        dst_token,
        sender,
        extra_metas_pda,
        block_pda,
        config_pda,
        registry,
        kyc_entry,
        dest_marker,
        Pubkey::new_unique(),
    );
    assert!(
        try_send(&mut svm, &payer, ix).is_ok(),
        "an active destination-owner marker must exempt the receiver-KYC checks"
    );
    println!("transfer_hook OK — dest escrow marker exempts receiver KYC");
}

#[test]
fn kyc_gated_source_escrow_marker_exempts_receiver_kyc() {
    let (
        mut svm,
        payer,
        program_id,
        mint,
        registry,
        extra_metas_pda,
        config_pda,
        src_token,
        dst_token,
        sender,
        kyc_entry,
    ) = marker_fixture();

    // Source owner is a platform escrow (settle / refund leg): marker at idx 11.
    let src_marker = token_owner_marker(&svm, &src_token);
    install_escrow_marker(&mut svm, &src_marker, ASSET_REGISTRY_PROGRAM);

    let block_pda = block_entry_pda(&program_id, &sender);
    let ix = build_kyc_execute_with_markers(
        program_id,
        mint,
        src_token,
        dst_token,
        sender,
        extra_metas_pda,
        block_pda,
        config_pda,
        registry,
        kyc_entry,
        Pubkey::new_unique(),
        src_marker,
    );
    assert!(
        try_send(&mut svm, &payer, ix).is_ok(),
        "an active source-owner marker must exempt the receiver-KYC checks"
    );
    println!("transfer_hook OK — source escrow marker exempts receiver KYC");
}

#[test]
fn kyc_gated_foreign_owned_marker_grants_no_exemption() {
    let (
        mut svm,
        payer,
        program_id,
        mint,
        registry,
        extra_metas_pda,
        config_pda,
        src_token,
        dst_token,
        sender,
        kyc_entry,
    ) = marker_fixture();

    // A marker-shaped account owned by some OTHER program must not exempt.
    let fake_marker = Pubkey::new_unique();
    install_escrow_marker(&mut svm, &fake_marker, Pubkey::new_unique());

    let block_pda = block_entry_pda(&program_id, &sender);
    let ix = build_kyc_execute_with_markers(
        program_id,
        mint,
        src_token,
        dst_token,
        sender,
        extra_metas_pda,
        block_pda,
        config_pda,
        registry,
        kyc_entry,
        fake_marker,
        Pubkey::new_unique(),
    );
    assert_hook_err(
        try_send(&mut svm, &payer, ix),
        ERR_RECEIVER_NOT_APPROVED,
        "foreign-owned marker",
    );
    println!("transfer_hook OK — foreign-owned marker grants no exemption");
}

#[test]
fn kyc_gated_unresolved_markers_stay_gated() {
    let (
        mut svm,
        payer,
        program_id,
        mint,
        registry,
        extra_metas_pda,
        config_pda,
        src_token,
        dst_token,
        sender,
        kyc_entry,
    ) = marker_fixture();

    // Both markers unresolved (system-owned) — the wallet↔wallet default —
    // and no KycEntry ⇒ the receiver check still applies and fails.
    let block_pda = block_entry_pda(&program_id, &sender);
    let ix = build_kyc_execute(
        program_id,
        mint,
        src_token,
        dst_token,
        sender,
        extra_metas_pda,
        block_pda,
        config_pda,
        registry,
        kyc_entry,
    );
    assert_hook_err(
        try_send(&mut svm, &payer, ix),
        ERR_RECEIVER_NOT_APPROVED,
        "unresolved markers",
    );
    println!("transfer_hook OK — unresolved markers stay gated");
}

#[test]
fn escrow_marker_does_not_bypass_blocklist() {
    let (
        mut svm,
        payer,
        program_id,
        mint,
        registry,
        extra_metas_pda,
        config_pda,
        src_token,
        dst_token,
        sender,
        kyc_entry,
    ) = marker_fixture();

    // Marker active on the source — but the SENDER is blocklisted: the
    // blocklist is enforced in every mode, exemption or not.
    let src_marker = token_owner_marker(&svm, &src_token);
    install_escrow_marker(&mut svm, &src_marker, ASSET_REGISTRY_PROGRAM);

    let (blocklist_authority_pda, _) =
        Pubkey::find_program_address(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED], &program_id);
    let block_pda = block_entry_pda(&program_id, &sender);
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::AddToBlocklist { wallet: sender }.data(),
            acc::AddToBlocklist {
                authority: payer.pubkey(),
                blocklist_authority: blocklist_authority_pda,
                block_entry: block_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "add_to_blocklist",
    );

    let ix = build_kyc_execute_with_markers(
        program_id,
        mint,
        src_token,
        dst_token,
        sender,
        extra_metas_pda,
        block_pda,
        config_pda,
        registry,
        kyc_entry,
        Pubkey::new_unique(),
        src_marker,
    );
    assert_hook_err(
        try_send(&mut svm, &payer, ix),
        ERR_SENDER_BLOCKED,
        "marker with blocklisted sender",
    );
    println!("transfer_hook OK — marker does not bypass the blocklist");
}

#[test]
fn open_mode_passes_without_kyc() {
    // Open mode keeps blocklist-only behavior: the meta list has no config at
    // idx 6, so Execute runs only the sender-blocklist check.
    let program_id = transfer_hook::id();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!("../../../target/deploy/transfer_hook.so");
    svm.add_program(program_id, bytes).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    let mint = Keypair::new().pubkey();
    let sender = Keypair::new().pubkey();
    let src_token = Pubkey::new_unique();
    svm.set_account(src_token, dest_token_account(&sender))
        .unwrap();
    let dst_token = Pubkey::new_unique();
    svm.set_account(dst_token, dest_token_account(&Pubkey::new_unique()))
        .unwrap();

    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );
    let (extra_metas_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint.as_ref()],
        &program_id,
    );
    let (blocklist_authority_pda, _) =
        Pubkey::find_program_address(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED], &program_id);

    support::set_upgrade_authority(&mut svm, &transfer_hook::ID, Some(payer.pubkey()));
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeBlocklistAuthority {
                authority: payer.pubkey(),
            }
            .data(),
            acc::InitializeBlocklistAuthority {
                payer: payer.pubkey(),
                upgrade_authority: payer.pubkey(),
                program: transfer_hook::ID,
                program_data: support::program_data(&transfer_hook::ID),
                blocklist_authority: blocklist_authority_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_blocklist_authority",
    );
    let share_class_kp = Keypair::new();
    install_fake_share_class(&mut svm, &share_class_kp.pubkey());
    send_signed(
        &mut svm,
        &[&payer, &share_class_kp],
        init_config_ix(
            program_id,
            &payer.pubkey(),
            &mint,
            &share_class_kp.pubkey(),
            &config_pda,
            RestrictionMode::Open,
            None,
        ),
        "initialize_transfer_hook_config",
    );
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeExtraAccountMetaList {}.data(),
            acc::InitializeExtraAccountMetaList {
                payer: payer.pubkey(),
                mint,
                config: config_pda,
                extra_account_meta_list: extra_metas_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_extra_account_meta_list",
    );

    // Open-mode Execute: only the 6 base accounts, no KYC extras.
    let block_pda = block_entry_pda(&program_id, &sender);
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(src_token, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(dst_token, false),
            AccountMeta::new_readonly(sender, false),
            AccountMeta::new_readonly(extra_metas_pda, false),
            AccountMeta::new_readonly(block_pda, false),
        ],
        data: TransferHookInstruction::Execute { amount: 1_000 }.pack(),
    };
    assert!(
        try_send(&mut svm, &payer, ix).is_ok(),
        "Open-mode Execute should pass without any KYC accounts"
    );
    println!("transfer_hook OK — Open mode passes without KYC");
}

// ── Config init gate + update_transfer_hook_config ───────────────────────────

/// `HookError::Unauthorized` (Anchor base 6000 + variant index 4).
const ERR_UNAUTHORIZED: u32 = 6004;
/// `HookError::KycRegistryRequired`.
const ERR_KYC_REGISTRY_REQUIRED: u32 = 6000;
/// `HookError::MetaListNotInitialized`.
const ERR_META_LIST_NOT_INITIALIZED: u32 = 6010;

/// Deploys the program and creates the blocklist authority (owned by `payer`).
/// Returns `(svm, payer, program_id)`.
fn base_fixture() -> (LiteSVM, Keypair, Pubkey) {
    let program_id = transfer_hook::id();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!("../../../target/deploy/transfer_hook.so");
    svm.add_program(program_id, bytes).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    let (blocklist_authority_pda, _) =
        Pubkey::find_program_address(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED], &program_id);
    support::set_upgrade_authority(&mut svm, &transfer_hook::ID, Some(payer.pubkey()));
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeBlocklistAuthority {
                authority: payer.pubkey(),
            }
            .data(),
            acc::InitializeBlocklistAuthority {
                payer: payer.pubkey(),
                upgrade_authority: payer.pubkey(),
                program: transfer_hook::ID,
                program_data: support::program_data(&transfer_hook::ID),
                blocklist_authority: blocklist_authority_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_blocklist_authority",
    );
    (svm, payer, program_id)
}

/// Builds an `update_transfer_hook_config` instruction (all PDAs derived).
fn update_config_ix(
    program_id: Pubkey,
    authority: &Pubkey,
    mint: &Pubkey,
    restriction_mode: RestrictionMode,
    kyc_registry: Option<Pubkey>,
    kyc_registry_account: Option<Pubkey>,
) -> Instruction {
    let (blocklist_authority_pda, _) =
        Pubkey::find_program_address(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED], &program_id);
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );
    let (extra_metas_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint.as_ref()],
        &program_id,
    );
    Instruction::new_with_bytes(
        program_id,
        &ixd::UpdateTransferHookConfig {
            restriction_mode,
            kyc_registry,
        }
        .data(),
        acc::UpdateTransferHookConfig {
            authority: *authority,
            blocklist_authority: blocklist_authority_pda,
            mint: *mint,
            config: config_pda,
            extra_account_meta_list: extra_metas_pda,
            system_program: system_program::ID,
            kyc_registry_account,
        }
        .to_account_metas(None),
    )
}

/// Unpacks the on-chain `ExtraAccountMetaList` TLV entry and returns the
/// metas it actually holds — verifying content, not just byte length.
fn unpack_metas(data: &[u8]) -> Vec<spl_tlv_account_resolution::account::ExtraAccountMeta> {
    use spl_tlv_account_resolution::state::ExtraAccountMetaList;
    use spl_transfer_hook_interface::instruction::ExecuteInstruction;
    use spl_type_length_value::state::TlvStateBorrowed;
    let state = TlvStateBorrowed::unpack(data).expect("TLV state unpack");
    let list = ExtraAccountMetaList::unpack_with_tlv_state::<ExecuteInstruction>(&state)
        .expect("meta list unpack");
    list.to_vec()
}

/// The Open-mode meta shape the program writes: 1 meta — the source-authority
/// `BlockEntry` PDA (mirrors `build_metas` in lib.rs).
fn expected_open_metas() -> Vec<spl_tlv_account_resolution::account::ExtraAccountMeta> {
    use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed};
    vec![ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal {
                bytes: transfer_hook::BLOCK_ENTRY_SEED.to_vec(),
            },
            Seed::AccountData {
                account_index: 0,
                data_index: 32,
                length: 32,
            },
        ],
        false,
        false,
    )
    .unwrap()]
}

/// The KycGated meta shape: BlockEntry + config + registry + asset_registry
/// program + receiver KycEntry + dest-owner EscrowMarker + source-owner
/// EscrowMarker (mirrors `build_metas` in lib.rs).
fn expected_kyc_gated_metas(
    registry: &Pubkey,
) -> Vec<spl_tlv_account_resolution::account::ExtraAccountMeta> {
    use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed};
    let mut metas = expected_open_metas();
    metas.push(
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: transfer_hook::HOOK_CONFIG_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )
        .unwrap(),
    );
    metas.push(ExtraAccountMeta::new_with_pubkey(registry, false, false).unwrap());
    metas.push(ExtraAccountMeta::new_with_pubkey(&ASSET_REGISTRY_PROGRAM, false, false).unwrap());
    metas.push(
        ExtraAccountMeta::new_external_pda_with_seeds(
            8,
            &[
                Seed::Literal {
                    bytes: transfer_hook::KYC_ENTRY_SEED.to_vec(),
                },
                Seed::AccountKey { index: 7 },
                Seed::AccountData {
                    account_index: 2,
                    data_index: 32,
                    length: 32,
                },
            ],
            false,
            false,
        )
        .unwrap(),
    );
    // idx 10 — destination-owner EscrowMarker.
    metas.push(
        ExtraAccountMeta::new_external_pda_with_seeds(
            8,
            &[
                Seed::Literal {
                    bytes: transfer_hook::ESCROW_MARKER_SEED.to_vec(),
                },
                Seed::AccountData {
                    account_index: 2,
                    data_index: 32,
                    length: 32,
                },
            ],
            false,
            false,
        )
        .unwrap(),
    );
    // idx 11 — source-owner EscrowMarker.
    metas.push(
        ExtraAccountMeta::new_external_pda_with_seeds(
            8,
            &[
                Seed::Literal {
                    bytes: transfer_hook::ESCROW_MARKER_SEED.to_vec(),
                },
                Seed::AccountData {
                    account_index: 0,
                    data_index: 32,
                    length: 32,
                },
            ],
            false,
            false,
        )
        .unwrap(),
    );
    metas
}

#[test]
fn init_config_without_registry_share_class_fails() {
    let (mut svm, payer, program_id) = base_fixture();
    let mint = Keypair::new().pubkey();
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );

    // (a) plain keypair co-signer (system-owned account) — owner gate fails.
    let wallet_kp = Keypair::new();
    svm.airdrop(&wallet_kp.pubkey(), 1_000_000_000).unwrap();
    assert_hook_err(
        try_send_signed(
            &mut svm,
            &[&payer, &wallet_kp],
            init_config_ix(
                program_id,
                &payer.pubkey(),
                &mint,
                &wallet_kp.pubkey(),
                &config_pda,
                RestrictionMode::Open,
                None,
            ),
        ),
        ERR_UNAUTHORIZED,
        "init_config: system-owned signer",
    );

    // (b) registry-owned but zero-data shell (what system allocate+assign can
    // produce for a keypair address) — discriminator gate fails.
    let shell_kp = Keypair::new();
    svm.set_account(
        shell_kp.pubkey(),
        Account {
            lamports: 2_000_000,
            data: vec![0u8; 32], // no ShareClass discriminator
            owner: ASSET_REGISTRY_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    assert_hook_err(
        try_send_signed(
            &mut svm,
            &[&payer, &shell_kp],
            init_config_ix(
                program_id,
                &payer.pubkey(),
                &mint,
                &shell_kp.pubkey(),
                &config_pda,
                RestrictionMode::Open,
                None,
            ),
        ),
        ERR_UNAUTHORIZED,
        "init_config: registry-owned zero-data shell",
    );

    // (c) correct ShareClass discriminator but NOT registry-owned — the owner
    // gate alone must reject it. An attacker CAN produce this state: assign a
    // keypair account to their own program and have that program write the
    // 8 discriminator bytes (a program may write to accounts it owns), while
    // the keypair still co-signs. Cases (a)/(b) both fail the discriminator
    // check on their own, so without this case a deleted owner constraint
    // would go unnoticed.
    let impostor_kp = Keypair::new();
    let mut impostor_data = vec![0u8; 32];
    impostor_data[..8].copy_from_slice(&transfer_hook::SHARE_CLASS_DISCRIMINATOR);
    svm.set_account(
        impostor_kp.pubkey(),
        Account {
            lamports: 2_000_000,
            data: impostor_data,
            owner: Pubkey::new_unique(), // attacker's program, not the registry
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    assert_hook_err(
        try_send_signed(
            &mut svm,
            &[&payer, &impostor_kp],
            init_config_ix(
                program_id,
                &payer.pubkey(),
                &mint,
                &impostor_kp.pubkey(),
                &config_pda,
                RestrictionMode::Open,
                None,
            ),
        ),
        ERR_UNAUTHORIZED,
        "init_config: non-registry owner with ShareClass discriminator",
    );

    assert!(
        svm.get_account(&config_pda).is_none(),
        "no config may exist after the rejected attempts"
    );
    println!("transfer_hook OK — init config without registry ShareClass fails");
}

#[test]
fn update_config_flips_mode_and_resizes_meta_list() {
    use spl_tlv_account_resolution::state::ExtraAccountMetaList;

    let (mut svm, payer, program_id) = base_fixture();
    let mint = Keypair::new().pubkey();
    let registry = Pubkey::new_unique();
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );
    let (extra_metas_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint.as_ref()],
        &program_id,
    );

    // Open config + meta list.
    let share_class_kp = Keypair::new();
    install_fake_share_class(&mut svm, &share_class_kp.pubkey());
    send_signed(
        &mut svm,
        &[&payer, &share_class_kp],
        init_config_ix(
            program_id,
            &payer.pubkey(),
            &mint,
            &share_class_kp.pubkey(),
            &config_pda,
            RestrictionMode::Open,
            None,
        ),
        "initialize_transfer_hook_config",
    );
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeExtraAccountMetaList {}.data(),
            acc::InitializeExtraAccountMetaList {
                payer: payer.pubkey(),
                mint,
                config: config_pda,
                extra_account_meta_list: extra_metas_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_extra_account_meta_list",
    );
    let open_len = ExtraAccountMetaList::size_of(1).unwrap();
    let gated_len = ExtraAccountMetaList::size_of(7).unwrap();
    let created = svm.get_account(&extra_metas_pda).unwrap();
    assert_eq!(created.data.len(), open_len, "Open meta list holds 1 meta");
    assert_eq!(
        unpack_metas(&created.data),
        expected_open_metas(),
        "freshly created TLV holds the Open BlockEntry meta"
    );

    // KycGated without a registry — rejected.
    assert_hook_err(
        try_send(
            &mut svm,
            &payer,
            update_config_ix(
                program_id,
                &payer.pubkey(),
                &mint,
                RestrictionMode::KycGated,
                None,
                None,
            ),
        ),
        ERR_KYC_REGISTRY_REQUIRED,
        "update: KycGated without registry",
    );

    // Open → KycGated: config flips, meta list grows to the 5-meta shape.
    install_kyc_registry(&mut svm, &registry, ASSET_REGISTRY_PROGRAM);
    send(
        &mut svm,
        &payer,
        update_config_ix(
            program_id,
            &payer.pubkey(),
            &mint,
            RestrictionMode::KycGated,
            Some(registry),
            Some(registry),
        ),
        "update_transfer_hook_config (Open -> KycGated)",
    );
    let cfg: TransferHookConfig = load(&svm, &config_pda, "config after KycGated");
    assert_eq!(cfg.restriction_mode, RestrictionMode::KycGated);
    assert_eq!(cfg.kyc_registry, Some(registry));
    assert_eq!(cfg.version, 2, "version bumped");
    let metas_account = svm.get_account(&extra_metas_pda).unwrap();
    assert_eq!(
        metas_account.data.len(),
        gated_len,
        "meta list grew to 7 metas"
    );
    assert!(
        metas_account.lamports >= svm.minimum_balance_for_rent_exemption(gated_len),
        "grown meta list stays rent-exempt"
    );
    // Content, not just length: the TLV must hold exactly the 7 KycGated
    // metas (a stale 1-meta header in a 7-meta buffer would silently skip
    // KYC resolution — fail-open — while passing every length assertion).
    assert_eq!(
        unpack_metas(&metas_account.data),
        expected_kyc_gated_metas(&registry),
        "rewritten TLV holds the exact KycGated meta set"
    );

    // KycGated → Open: back to the 1-meta shape.
    send(
        &mut svm,
        &payer,
        update_config_ix(
            program_id,
            &payer.pubkey(),
            &mint,
            RestrictionMode::Open,
            None,
            None,
        ),
        "update_transfer_hook_config (KycGated -> Open)",
    );
    let cfg: TransferHookConfig = load(&svm, &config_pda, "config after Open");
    assert_eq!(cfg.restriction_mode, RestrictionMode::Open);
    assert_eq!(cfg.kyc_registry, None);
    assert_eq!(cfg.version, 3, "version bumped again");
    let shrunk = svm.get_account(&extra_metas_pda).unwrap();
    assert_eq!(
        shrunk.data.len(),
        open_len,
        "meta list shrank back to 1 meta"
    );
    // A stale 5-count header truncated into a 1-meta buffer would brick every
    // transfer of the mint — verify the TLV was compacted, not just resized.
    assert_eq!(
        unpack_metas(&shrunk.data),
        expected_open_metas(),
        "TLV compacted back to the single Open meta"
    );

    println!("transfer_hook OK — update flips mode and resizes meta list");
}

#[test]
fn update_config_without_meta_list_fails() {
    let (mut svm, payer, program_id) = base_fixture();
    let mint = Keypair::new().pubkey();
    let registry = Pubkey::new_unique();
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );

    // Config exists, but the meta list was never initialized — exactly the
    // state the `MetaListNotInitialized` owner guard exists for. Without the
    // guard the handler would resize/TLV-write a system-owned account.
    let share_class_kp = Keypair::new();
    install_fake_share_class(&mut svm, &share_class_kp.pubkey());
    send_signed(
        &mut svm,
        &[&payer, &share_class_kp],
        init_config_ix(
            program_id,
            &payer.pubkey(),
            &mint,
            &share_class_kp.pubkey(),
            &config_pda,
            RestrictionMode::Open,
            None,
        ),
        "initialize_transfer_hook_config",
    );

    assert_hook_err(
        try_send(
            &mut svm,
            &payer,
            update_config_ix(
                program_id,
                &payer.pubkey(),
                &mint,
                RestrictionMode::KycGated,
                Some(registry),
                Some(registry),
            ),
        ),
        ERR_META_LIST_NOT_INITIALIZED,
        "update without initialized meta list",
    );
    let cfg: TransferHookConfig = load(&svm, &config_pda, "config unchanged");
    assert_eq!(
        cfg.restriction_mode,
        RestrictionMode::Open,
        "config not flipped"
    );
    assert_eq!(cfg.version, 1, "version not bumped");

    println!("transfer_hook OK — update without meta list fails (6010)");
}

#[test]
fn init_meta_list_on_prefunded_pda_succeeds() {
    use spl_tlv_account_resolution::state::ExtraAccountMetaList;

    let (mut svm, payer, program_id) = base_fixture();
    let mint = Keypair::new().pubkey();
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );
    let (extra_metas_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint.as_ref()],
        &program_id,
    );

    let share_class_kp = Keypair::new();
    install_fake_share_class(&mut svm, &share_class_kp.pubkey());
    send_signed(
        &mut svm,
        &[&payer, &share_class_kp],
        init_config_ix(
            program_id,
            &payer.pubkey(),
            &mint,
            &share_class_kp.pubkey(),
            &config_pda,
            RestrictionMode::Open,
            None,
        ),
        "initialize_transfer_hook_config",
    );

    // Griefing pre-fund: the metas PDA address is deterministic and public,
    // so anyone can land lamports on it before initialization. A raw
    // `create_account` would fail with AccountAlreadyInUse forever —
    // initialization must tolerate the pre-funded account.
    svm.airdrop(&extra_metas_pda, 1).unwrap();

    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeExtraAccountMetaList {}.data(),
            acc::InitializeExtraAccountMetaList {
                payer: payer.pubkey(),
                mint,
                config: config_pda,
                extra_account_meta_list: extra_metas_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_extra_account_meta_list (pre-funded PDA)",
    );

    let acct = svm
        .get_account(&extra_metas_pda)
        .expect("meta list must exist despite the pre-fund");
    let open_len = ExtraAccountMetaList::size_of(1).unwrap();
    assert_eq!(acct.owner, program_id, "assigned to the hook program");
    assert_eq!(acct.data.len(), open_len, "allocated to the Open shape");
    assert!(
        acct.lamports >= svm.minimum_balance_for_rent_exemption(open_len),
        "topped up to rent exemption"
    );
    assert_eq!(
        unpack_metas(&acct.data),
        expected_open_metas(),
        "TLV written correctly on the pre-funded account"
    );

    println!("transfer_hook OK — pre-funded metas PDA cannot block initialization");
}

#[test]
fn update_config_by_non_authority_fails() {
    let (mut svm, payer, program_id) = base_fixture();
    let mint = Keypair::new().pubkey();
    let registry = Pubkey::new_unique();
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );
    let (extra_metas_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint.as_ref()],
        &program_id,
    );

    let share_class_kp = Keypair::new();
    install_fake_share_class(&mut svm, &share_class_kp.pubkey());
    send_signed(
        &mut svm,
        &[&payer, &share_class_kp],
        init_config_ix(
            program_id,
            &payer.pubkey(),
            &mint,
            &share_class_kp.pubkey(),
            &config_pda,
            RestrictionMode::Open,
            None,
        ),
        "initialize_transfer_hook_config",
    );
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeExtraAccountMetaList {}.data(),
            acc::InitializeExtraAccountMetaList {
                payer: payer.pubkey(),
                mint,
                config: config_pda,
                extra_account_meta_list: extra_metas_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_extra_account_meta_list",
    );

    // Mallory is not the blocklist authority — update must fail, even with a
    // genuine registry (the only thing wrong is the signer).
    install_kyc_registry(&mut svm, &registry, ASSET_REGISTRY_PROGRAM);
    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 10_000_000_000).unwrap();
    assert_hook_err(
        try_send(
            &mut svm,
            &mallory,
            update_config_ix(
                program_id,
                &mallory.pubkey(),
                &mint,
                RestrictionMode::KycGated,
                Some(registry),
                Some(registry),
            ),
        ),
        ERR_UNAUTHORIZED,
        "update by non-authority",
    );
    let cfg: TransferHookConfig = load(&svm, &config_pda, "config unchanged");
    assert_eq!(cfg.restriction_mode, RestrictionMode::Open);
    assert_eq!(cfg.version, 1);

    println!("transfer_hook OK — update by non-authority fails");
}

#[test]
fn escrow_routing_never_exempts_immutable_owner_requirement() {
    for marker_on_source in [false, true] {
        let (
            mut svm,
            payer,
            program_id,
            mint,
            registry,
            metas,
            config,
            source,
            destination,
            owner,
            entry,
        ) = marker_fixture();
        let marker_token = if marker_on_source {
            source
        } else {
            destination
        };
        let marker = token_owner_marker(&svm, &marker_token);
        install_escrow_marker(&mut svm, &marker, ASSET_REGISTRY_PROGRAM);
        let mut mutable_destination = svm.get_account(&destination).unwrap();
        mutable_destination.data.truncate(165); // valid base account, no ImmutableOwner
        svm.set_account(destination, mutable_destination).unwrap();
        let ix = build_kyc_execute_with_markers(
            program_id,
            mint,
            source,
            destination,
            owner,
            metas,
            block_entry_pda(&program_id, &owner),
            config,
            registry,
            entry,
            if marker_on_source {
                Pubkey::new_unique()
            } else {
                marker
            },
            if marker_on_source {
                marker
            } else {
                Pubkey::new_unique()
            },
        );
        assert_hook_err(
            try_send(&mut svm, &payer, ix),
            u32::from(transfer_hook::HookError::ImmutableOwnerRequired),
            "escrow routing cannot admit mutable owners",
        );
    }
}

#[test]
fn blocklist_authority_rotation_requires_live_proposal_and_recipient_consent() {
    let (mut svm, payer, program_id) = base_fixture();
    let first = Keypair::new();
    let next = Keypair::new();
    for key in [&first, &next] {
        svm.airdrop(&key.pubkey(), 100_000_000_000).unwrap();
    }
    let singleton =
        Pubkey::find_program_address(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED], &program_id).0;
    let transfer = Pubkey::find_program_address(
        &[transfer_hook::BLOCKLIST_AUTHORITY_TRANSFER_SEED],
        &program_id,
    )
    .0;
    let deployment_before = svm
        .get_account(&support::program_data(&program_id))
        .unwrap()
        .data;
    let propose = |authority, new_authority| {
        Instruction::new_with_bytes(
            program_id,
            &ixd::ProposeBlocklistAuthority { new_authority }.data(),
            acc::ProposeBlocklistAuthority {
                authority,
                blocklist_authority: singleton,
                transfer,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    };
    let accept = |new_authority| {
        Instruction::new_with_bytes(
            program_id,
            &ixd::AcceptBlocklistAuthority {}.data(),
            acc::AcceptBlocklistAuthority {
                new_authority,
                blocklist_authority: singleton,
                transfer,
            }
            .to_account_metas(None),
        )
    };
    assert!(
        try_send(&mut svm, &first, propose(first.pubkey(), next.pubkey()))
            .unwrap_err()
            .contains("Unauthorized")
    );
    assert!(
        try_send(&mut svm, &payer, propose(payer.pubkey(), Pubkey::default()))
            .unwrap_err()
            .contains("InvalidProposedAuthority")
    );
    send(
        &mut svm,
        &payer,
        propose(payer.pubkey(), first.pubkey()),
        "first authority proposal",
    );
    assert!(try_send(&mut svm, &next, accept(next.pubkey()))
        .unwrap_err()
        .contains("InvalidAuthorityTransfer"));
    send(
        &mut svm,
        &payer,
        propose(payer.pubkey(), next.pubkey()),
        "replace authority proposal",
    );
    assert!(try_send(&mut svm, &first, accept(first.pubkey()))
        .unwrap_err()
        .contains("InvalidAuthorityTransfer"));
    svm.expire_blockhash();
    send(
        &mut svm,
        &next,
        accept(next.pubkey()),
        "new authority accepts",
    );
    assert_eq!(
        load::<transfer_hook::BlocklistAuthority>(&svm, &singleton, "authority").authority,
        next.pubkey()
    );
    assert!(svm.get_account(&transfer).is_none_or(|a| a.data.is_empty()));
    let wallet = Pubkey::new_unique();
    let block_entry = block_entry_pda(&program_id, &wallet);
    let add = |authority| {
        Instruction::new_with_bytes(
            program_id,
            &ixd::AddToBlocklist { wallet }.data(),
            acc::AddToBlocklist {
                authority,
                blocklist_authority: singleton,
                block_entry,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    };
    assert!(try_send(&mut svm, &payer, add(payer.pubkey()))
        .unwrap_err()
        .contains("Unauthorized"));
    send(
        &mut svm,
        &next,
        add(next.pubkey()),
        "new authority manages sanctions",
    );
    let remove = |authority| {
        Instruction::new_with_bytes(
            program_id,
            &ixd::RemoveFromBlocklist { wallet }.data(),
            acc::RemoveFromBlocklist {
                authority,
                blocklist_authority: singleton,
                block_entry,
            }
            .to_account_metas(None),
        )
    };
    assert!(try_send(&mut svm, &payer, remove(payer.pubkey()))
        .unwrap_err()
        .contains("Unauthorized"));
    send(
        &mut svm,
        &next,
        remove(next.pubkey()),
        "new authority clears sanctions",
    );
    assert_eq!(
        svm.get_account(&support::program_data(&program_id))
            .unwrap()
            .data,
        deployment_before
    );
}

// ── update_transfer_hook_config: named-registry validation (2C-1) ───────────

const ERR_INVALID_KYC_REGISTRY: u32 = 6009;
const ERR_KYC_REGISTRY_NOT_ALLOWED: u32 = 6016;
/// `sha256("account:KycEntry")[0..8]` — a real registry-owned account that is
/// NOT a registry.
const KYC_ENTRY_DISCRIMINATOR: [u8; 8] = [43, 113, 165, 70, 7, 3, 232, 8];

/// Base fixture + an Open config and its 1-meta list for a fresh mint.
/// Returns `(svm, payer, program_id, mint, config_pda)`.
fn open_mint_fixture() -> (LiteSVM, Keypair, Pubkey, Pubkey, Pubkey) {
    let (mut svm, payer, program_id) = base_fixture();
    let mint = Keypair::new().pubkey();
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );
    let (extra_metas_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint.as_ref()],
        &program_id,
    );
    let share_class_kp = Keypair::new();
    install_fake_share_class(&mut svm, &share_class_kp.pubkey());
    send_signed(
        &mut svm,
        &[&payer, &share_class_kp],
        init_config_ix(
            program_id,
            &payer.pubkey(),
            &mint,
            &share_class_kp.pubkey(),
            &config_pda,
            RestrictionMode::Open,
            None,
        ),
        "initialize_transfer_hook_config",
    );
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeExtraAccountMetaList {}.data(),
            acc::InitializeExtraAccountMetaList {
                payer: payer.pubkey(),
                mint,
                config: config_pda,
                extra_account_meta_list: extra_metas_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_extra_account_meta_list",
    );
    (svm, payer, program_id, mint, config_pda)
}

/// Sends an update and asserts it failed with `code`, leaving the config
/// untouched (still Open, version 1, no registry).
fn assert_update_rejected(
    svm: &mut LiteSVM,
    payer: &Keypair,
    ix: Instruction,
    config_pda: &Pubkey,
    code: u32,
    label: &str,
) {
    svm.expire_blockhash();
    assert_hook_err(try_send(svm, payer, ix), code, label);
    let cfg: TransferHookConfig = load(svm, config_pda, "config unchanged");
    assert_eq!(cfg.restriction_mode, RestrictionMode::Open, "{label}");
    assert_eq!(cfg.kyc_registry, None, "{label}");
    assert_eq!(cfg.version, 1, "{label}");
}

#[test]
fn update_config_open_mode_rejects_a_named_registry() {
    let (mut svm, payer, program_id, mint, config_pda) = open_mint_fixture();
    let registry = Pubkey::new_unique();
    install_kyc_registry(&mut svm, &registry, ASSET_REGISTRY_PROGRAM);

    // Open + Some(arg) — even with the genuine account passed.
    let ix = update_config_ix(
        program_id,
        &payer.pubkey(),
        &mint,
        RestrictionMode::Open,
        Some(registry),
        Some(registry),
    );
    assert_update_rejected(
        &mut svm,
        &payer,
        ix,
        &config_pda,
        ERR_KYC_REGISTRY_NOT_ALLOWED,
        "Open + Some(registry)",
    );

    // Open + None arg, but a registry ACCOUNT passed anyway.
    let ix = update_config_ix(
        program_id,
        &payer.pubkey(),
        &mint,
        RestrictionMode::Open,
        None,
        Some(registry),
    );
    assert_update_rejected(
        &mut svm,
        &payer,
        ix,
        &config_pda,
        ERR_KYC_REGISTRY_NOT_ALLOWED,
        "Open + account passed",
    );
}

#[test]
fn update_config_kyc_gated_requires_a_genuine_matching_registry_account() {
    let (mut svm, payer, program_id, mint, config_pda) = open_mint_fixture();
    let registry = Pubkey::new_unique();
    install_kyc_registry(&mut svm, &registry, ASSET_REGISTRY_PROGRAM);
    let authority = payer.pubkey();
    let gated = |arg: Pubkey, account: Option<Pubkey>| {
        update_config_ix(
            program_id,
            &authority,
            &mint,
            RestrictionMode::KycGated,
            Some(arg),
            account,
        )
    };

    // No account at all.
    assert_update_rejected(
        &mut svm,
        &payer,
        gated(registry, None),
        &config_pda,
        ERR_INVALID_KYC_REGISTRY,
        "KycGated without the registry account",
    );

    // Account key differs from the argument (both genuine registries).
    let other = Pubkey::new_unique();
    install_kyc_registry(&mut svm, &other, ASSET_REGISTRY_PROGRAM);
    assert_update_rejected(
        &mut svm,
        &payer,
        gated(registry, Some(other)),
        &config_pda,
        ERR_INVALID_KYC_REGISTRY,
        "account key != argument",
    );

    // Wrong owner: registry-shaped bytes owned by some other program.
    let foreign = Pubkey::new_unique();
    install_kyc_registry(&mut svm, &foreign, Pubkey::new_unique());
    assert_update_rejected(
        &mut svm,
        &payer,
        gated(foreign, Some(foreign)),
        &config_pda,
        ERR_INVALID_KYC_REGISTRY,
        "wrong owner",
    );

    // Wrong discriminator: KycEntry bytes (registry-owned, not a registry),
    // padded to the registry length so only the discriminator differs.
    let entry_like = Pubkey::new_unique();
    let mut entry = kyc_entry_bytes(&registry, &Pubkey::new_unique(), 1, 222, i64::MAX);
    entry[..8].copy_from_slice(&KYC_ENTRY_DISCRIMINATOR);
    entry.resize(transfer_hook::KYC_REGISTRY_ACCOUNT_LEN, 0);
    install_raw_registry(&mut svm, &entry_like, ASSET_REGISTRY_PROGRAM, entry);
    assert_update_rejected(
        &mut svm,
        &payer,
        gated(entry_like, Some(entry_like)),
        &config_pda,
        ERR_INVALID_KYC_REGISTRY,
        "wrong discriminator",
    );

    // Truncated: right owner and discriminator, one byte short (305 B).
    let short = Pubkey::new_unique();
    let mut bytes = kyc_registry_bytes(&Pubkey::new_unique(), [0u8; 128], [0u8; 128]);
    bytes.truncate(transfer_hook::KYC_REGISTRY_ACCOUNT_LEN - 1);
    install_raw_registry(&mut svm, &short, ASSET_REGISTRY_PROGRAM, bytes);
    assert_update_rejected(
        &mut svm,
        &payer,
        gated(short, Some(short)),
        &config_pda,
        ERR_INVALID_KYC_REGISTRY,
        "305-byte registry",
    );

    // Nothing at the named key (a plain system address).
    let missing = Pubkey::new_unique();
    assert_update_rejected(
        &mut svm,
        &payer,
        gated(missing, Some(missing)),
        &config_pda,
        ERR_INVALID_KYC_REGISTRY,
        "registry account does not exist",
    );

    // The genuine registry, passed correctly, is accepted.
    svm.expire_blockhash();
    send(
        &mut svm,
        &payer,
        gated(registry, Some(registry)),
        "update_transfer_hook_config (genuine registry)",
    );
    let cfg: TransferHookConfig = load(&svm, &config_pda, "config after KycGated");
    assert_eq!(cfg.restriction_mode, RestrictionMode::KycGated);
    assert_eq!(cfg.kyc_registry, Some(registry));
}

#[test]
fn init_config_open_mode_rejects_a_named_registry() {
    let (mut svm, payer, program_id) = base_fixture();
    let mint = Keypair::new().pubkey();
    let (config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &program_id,
    );
    let share_class_kp = Keypair::new();
    install_fake_share_class(&mut svm, &share_class_kp.pubkey());
    assert_hook_err(
        try_send_signed(
            &mut svm,
            &[&payer, &share_class_kp],
            init_config_ix(
                program_id,
                &payer.pubkey(),
                &mint,
                &share_class_kp.pubkey(),
                &config_pda,
                RestrictionMode::Open,
                Some(Pubkey::new_unique()),
            ),
        ),
        ERR_KYC_REGISTRY_NOT_ALLOWED,
        "init Open + Some(registry)",
    );
    assert!(
        svm.get_account(&config_pda)
            .is_none_or(|a| a.data.is_empty()),
        "no config created"
    );
}

/// Gates the `open_mint_fixture` mint on a genuine registry `r1` and returns
/// the meta-list PDA.
fn gate_on(
    svm: &mut LiteSVM,
    payer: &Keypair,
    program_id: Pubkey,
    mint: &Pubkey,
    r1: Pubkey,
) -> Pubkey {
    install_kyc_registry(svm, &r1, ASSET_REGISTRY_PROGRAM);
    send(
        svm,
        payer,
        update_config_ix(
            program_id,
            &payer.pubkey(),
            mint,
            RestrictionMode::KycGated,
            Some(r1),
            Some(r1),
        ),
        "gate on R1",
    );
    Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint.as_ref()],
        &program_id,
    )
    .0
}

/// The lost-KYC-key recovery path: a KycGated mint moves from registry R1 to
/// a fresh R2 in one update (KycGated -> KycGated); the config and the meta
/// list both name R2 afterwards, and nothing names R1.
#[test]
fn update_config_re_points_a_kyc_gated_mint_to_another_registry() {
    let (mut svm, payer, program_id, mint, config_pda) = open_mint_fixture();
    let (r1, r2) = (Pubkey::new_unique(), Pubkey::new_unique());
    let extra_metas_pda = gate_on(&mut svm, &payer, program_id, &mint, r1);
    install_kyc_registry(&mut svm, &r2, ASSET_REGISTRY_PROGRAM);
    let gated_len = svm.get_account(&extra_metas_pda).unwrap().data.len();

    svm.expire_blockhash();
    send(
        &mut svm,
        &payer,
        update_config_ix(
            program_id,
            &payer.pubkey(),
            &mint,
            RestrictionMode::KycGated,
            Some(r2),
            Some(r2),
        ),
        "re-point R1 -> R2",
    );
    let cfg: TransferHookConfig = load(&svm, &config_pda, "config after re-point");
    assert_eq!(cfg.restriction_mode, RestrictionMode::KycGated);
    assert_eq!(cfg.kyc_registry, Some(r2));
    assert_eq!(cfg.version, 3, "Open -> R1 -> R2");
    let metas = svm.get_account(&extra_metas_pda).unwrap();
    assert_eq!(metas.data.len(), gated_len, "same 7-meta shape, no resize");
    assert_eq!(
        unpack_metas(&metas.data),
        expected_kyc_gated_metas(&r2),
        "meta list rebuilt around R2"
    );
    assert!(
        !metas.data.windows(32).any(|w| w == r1.as_ref()),
        "no meta still names R1"
    );
}

/// A re-point to anything that is not a genuine registry is refused and the
/// mint stays gated on R1 (config and meta list untouched). KycGated with no
/// registry argument is refused even when an account is passed.
#[test]
fn update_config_rejects_a_bad_re_point_and_keeps_r1() {
    let (mut svm, payer, program_id, mint, config_pda) = open_mint_fixture();
    let r1 = Pubkey::new_unique();
    let extra_metas_pda = gate_on(&mut svm, &payer, program_id, &mint, r1);
    let metas_before = svm.get_account(&extra_metas_pda).unwrap().data;

    let fake = Pubkey::new_unique();
    install_kyc_registry(&mut svm, &fake, Pubkey::new_unique());
    let cases = [
        (
            Some(fake),
            Some(fake),
            ERR_INVALID_KYC_REGISTRY,
            "foreign-owned registry bytes",
        ),
        (
            None,
            Some(r1),
            ERR_KYC_REGISTRY_REQUIRED,
            "KycGated, no argument, account passed",
        ),
    ];
    for (arg, account, code, label) in cases {
        svm.expire_blockhash();
        assert_hook_err(
            try_send(
                &mut svm,
                &payer,
                update_config_ix(
                    program_id,
                    &payer.pubkey(),
                    &mint,
                    RestrictionMode::KycGated,
                    arg,
                    account,
                ),
            ),
            code,
            label,
        );
        let cfg: TransferHookConfig = load(&svm, &config_pda, label);
        assert_eq!(cfg.restriction_mode, RestrictionMode::KycGated, "{label}");
        assert_eq!(cfg.kyc_registry, Some(r1), "{label}: still R1");
        assert_eq!(cfg.version, 2, "{label}");
        assert_eq!(
            svm.get_account(&extra_metas_pda).unwrap().data,
            metas_before,
            "{label}: meta list untouched"
        );
    }
}

/// An old client (pre-2C-1 IDL) builds `update_transfer_hook_config` without
/// the trailing optional `kyc_registry_account`. Pins what the new hook does
/// with it, which the rollout plan (hook upgraded before the front) relies on.
#[test]
fn update_config_from_an_old_client_without_the_trailing_account() {
    let (mut svm, payer, program_id, mint, config_pda) = open_mint_fixture();
    let registry = Pubkey::new_unique();
    install_kyc_registry(&mut svm, &registry, ASSET_REGISTRY_PROGRAM);
    let old_client = |mode: RestrictionMode, arg: Option<Pubkey>| {
        let mut ix = update_config_ix(program_id, &payer.pubkey(), &mint, mode, arg, None);
        // The new client encodes `None` as the program id placeholder; an old
        // client sends no account there at all.
        let last = ix.accounts.pop().expect("trailing optional account");
        assert_eq!(
            last.pubkey, program_id,
            "None placeholder is the program id"
        );
        ix
    };

    for (mode, arg, label) in [
        (
            RestrictionMode::KycGated,
            Some(registry),
            "old client: Open -> KycGated",
        ),
        (RestrictionMode::Open, None, "old client: Open -> Open"),
    ] {
        svm.expire_blockhash();
        assert_hook_err(
            try_send(&mut svm, &payer, old_client(mode, arg)),
            3005,
            label,
        );
        let cfg: TransferHookConfig = load(&svm, &config_pda, label);
        assert_eq!(cfg.restriction_mode, RestrictionMode::Open, "{label}");
        assert_eq!(cfg.version, 1, "{label}");
    }
}
