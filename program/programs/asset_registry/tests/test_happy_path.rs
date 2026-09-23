//! End-to-end happy path for the asset registry (docs/01 §11).
//!
//! initialize_platform -> register_issuer -> verify_issuer_kyb -> create_asset
//! -> add_share_class -> create_kyc_registry -> approve_holder
//!
//! One keypair plays platform admin, issuer authority and KYC-provider authority.

#[path = "../../../tests/support/pause.rs"]
mod pause;
#[path = "../../../tests/support/sale_approval.rs"]
mod sale_approval;
#[path = "../../../tests/support/mod.rs"]
mod support;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            system_instruction, system_program,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    asset_registry::{
        accounts as acc, instruction as ixd, util, Asset, AssetStatus, AssetType, CustodyVault,
        Issuer, JurisdictionRules, KybStatus, KycEntry, KycStatus, Offer, OfferStatus, Platform,
        Proposal, ProposalOutcome, ProposalStatus, RaiseType, RealizeAction, RightsIssuance, Sale,
        SaleStatus, ShareClass, ShareClassType, VaultState, VaultType, VestingMilestone,
        VoteChoice, RIGHT_DIVIDEND, RIGHT_LIQ_PREF, RIGHT_VOTE,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    spl_associated_token_account_interface::{
        address::get_associated_token_address_with_program_id, instruction as ata_ix,
    },
    spl_token_2022_interface::instruction as token_ix,
};

/// Sends a multi-instruction tx signed by `signers` (first = fee payer).
fn send_multi(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction], label: &str) {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &blockhash);
    let tx =
        VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).expect("sign tx");
    if let Err(e) = svm.send_transaction(tx) {
        panic!("[{label}] transaction failed: {e:?}");
    }
}

/// Creates a plain Token-2022 mint (no extensions) with `payer` as authority.
fn create_token_mint(
    svm: &mut LiteSVM,
    payer: &Keypair,
    decimals: u8,
    token_program: &Pubkey,
) -> Pubkey {
    let mint = Keypair::new();
    let space: usize = 82; // Token-2022 mint, no extensions
    let lamports = svm.minimum_balance_for_rent_exemption(space);
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        lamports,
        space as u64,
        token_program,
    );
    let init = token_ix::initialize_mint2(
        token_program,
        &mint.pubkey(),
        &payer.pubkey(),
        None,
        decimals,
    )
    .unwrap();
    send_multi(svm, &[payer, &mint], &[create, init], "create_token_mint");
    mint.pubkey()
}

/// Creates an associated token account and returns its address.
fn create_ata(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
    token_program: &Pubkey,
) -> Pubkey {
    let ix = ata_ix::create_associated_token_account(&payer.pubkey(), owner, mint, token_program);
    send_multi(svm, &[payer], &[ix], "create_ata");
    get_associated_token_address_with_program_id(owner, mint, token_program)
}

/// Mints `amount` tokens to `dest` (`payer` must be the mint authority).
fn mint_tokens(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    dest: &Pubkey,
    amount: u64,
    token_program: &Pubkey,
) {
    let ix = token_ix::mint_to(token_program, mint, dest, &payer.pubkey(), &[], amount).unwrap();
    send_multi(svm, &[payer], &[ix], "mint_tokens");
}

/// Builds, signs and sends a single-instruction transaction; panics on failure.
fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction, label: &str) {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let tx =
        VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).expect("sign tx");
    if let Err(e) = svm.send_transaction(tx) {
        panic!("[{label}] transaction failed: {e:?}");
    }
}

/// Like `send` but returns the outcome instead of panicking.
fn try_send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> Result<(), String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).expect("sign");
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

/// The `EscrowMarker` PDA for an escrow-authority PDA (deal / offer / vault /
/// distribution).
fn escrow_marker_of(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::ESCROW_MARKER_SEED, owner.as_ref()],
        &asset_registry::id(),
    )
    .0
}

/// Deserializes an Anchor account from the SVM, panicking if absent.
fn load<T: AccountDeserialize>(svm: &LiteSVM, pda: &Pubkey, label: &str) -> T {
    let account = svm
        .get_account(pda)
        .unwrap_or_else(|| panic!("[{label}] account not found"));
    T::try_deserialize(&mut account.data.as_slice())
        .unwrap_or_else(|e| panic!("[{label}] deserialize failed: {e:?}"))
}

#[test]
fn happy_path_registry_lifecycle() {
    let program_id = asset_registry::id();

    let mut svm = LiteSVM::new();
    let bytes = include_bytes!("../../../target/deploy/asset_registry.so");
    svm.add_program(program_id, bytes).unwrap();
    // transfer_hook must be loaded too — Token-2022 CPIs into it on every
    // share-token transfer (step 18+).
    svm.add_program(
        transfer_hook::id(),
        include_bytes!("../../../target/deploy/transfer_hook.so"),
    )
    .unwrap();

    // Single actor: platform admin + issuer authority + KYC-provider authority.
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    // ── Fixtures ─────────────────────────────────────────────────────────────
    let legal_entity_id: [u8; 32] = *b"RWA-DAO-PILOT-ENTITY-00000000001";
    let asset_id = "pilot-001";
    let class_index: u8 = 0;
    let holder = Keypair::new().pubkey();
    let jurisdiction_rules = JurisdictionRules {
        allowed_countries: [0u8; 128],
        max_holders: 0,
        restricted_period_end: 0,
        allow_p2p: true,
    };

    // ── PDAs ─────────────────────────────────────────────────────────────────
    let (platform_pda, _) =
        Pubkey::find_program_address(&[asset_registry::PLATFORM_SEED], &program_id);
    // `payer` is the super admin → admin #1; its Admin record gates every
    // privileged instruction.
    let (admin_pda, _) = Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, payer.pubkey().as_ref()],
        &program_id,
    );
    let (issuer_pda, _) = Pubkey::find_program_address(
        &[asset_registry::ISSUER_SEED, legal_entity_id.as_ref()],
        &program_id,
    );
    let (asset_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::ASSET_SEED,
            issuer_pda.as_ref(),
            asset_id.as_bytes(),
        ],
        &program_id,
    );
    let (share_class_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::SHARE_CLASS_SEED,
            asset_pda.as_ref(),
            &[class_index],
        ],
        &program_id,
    );
    let (kyc_registry_pda, _) = Pubkey::find_program_address(
        &[asset_registry::KYC_REGISTRY_SEED, payer.pubkey().as_ref()],
        &program_id,
    );
    let (kyc_entry_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::KYC_SEED,
            kyc_registry_pda.as_ref(),
            holder.as_ref(),
        ],
        &program_id,
    );

    // ── 1. initialize_platform ───────────────────────────────────────────────
    support::set_upgrade_authority(&mut svm, &asset_registry::ID, Some(payer.pubkey()));
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializePlatform {
                protocol_treasury: payer.pubkey(),
                protocol_fee_bps: 250,
            }
            .data(),
            acc::InitializePlatform {
                admin: payer.pubkey(),
                upgrade_authority: payer.pubkey(),
                program: asset_registry::ID,
                program_data: support::program_data(&asset_registry::ID),
                platform: platform_pda,
                super_admin_record: admin_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_platform",
    );
    let platform: Platform = load(&svm, &platform_pda, "platform");
    assert_eq!(platform.admin, payer.pubkey());
    assert_eq!(platform.protocol_fee_bps, 250);
    // A fresh platform starts fully paused; the bootstrap clears it.
    assert_eq!(platform.pause_flags, asset_registry::PAUSE_FLAGS_ALL);
    assert_eq!(platform.version, 1);
    pause::unpause_all(&mut svm, &payer);

    // ── 2. register_issuer ───────────────────────────────────────────────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::RegisterIssuer {
                legal_entity_id,
                jurisdiction: 222, // ISO-3166 numeric — El Salvador
                kyb_doc_hash: [9u8; 32],
            }
            .data(),
            acc::RegisterIssuer {
                authority: payer.pubkey(),
                platform: platform_pda,
                issuer: issuer_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "register_issuer",
    );
    let issuer: Issuer = load(&svm, &issuer_pda, "issuer");
    assert_eq!(issuer.kyb_status, KybStatus::Pending);
    assert_eq!(issuer.jurisdiction, 222);

    // ── 3. verify_issuer_kyb ─────────────────────────────────────────────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::VerifyIssuerKyb { approved: true }.data(),
            acc::VerifyIssuerKyb {
                admin: payer.pubkey(),
                platform: platform_pda,
                issuer: issuer_pda,
            }
            .to_account_metas(None),
        ),
        "verify_issuer_kyb",
    );
    let issuer: Issuer = load(&svm, &issuer_pda, "issuer");
    assert_eq!(issuer.kyb_status, KybStatus::Verified);

    // ── 4. create_asset ──────────────────────────────────────────────────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::CreateAsset {
                asset_id: asset_id.to_string(),
                asset_type: AssetType::Equity,
                name: "Pilot Equity Round".to_string(),
                symbol_prefix: "PILOT".to_string(),
                legal_doc_hash: [3u8; 32],
                jurisdiction_rules,
            }
            .data(),
            acc::CreateAsset {
                authority: payer.pubkey(),
                platform: platform_pda,
                issuer: issuer_pda,
                asset: asset_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "create_asset",
    );
    let asset: Asset = load(&svm, &asset_pda, "asset");
    assert_eq!(asset.status, AssetStatus::Draft);
    assert_eq!(asset.asset_id, asset_id);
    assert_eq!(asset.asset_type, AssetType::Equity);
    assert_eq!(asset.share_classes_count, 0);
    assert_eq!(asset.extra_kyc_registry, None);

    // ── 5. add_share_class ───────────────────────────────────────────────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::AddShareClass {
                class_index,
                class_type: ShareClassType::PreferredA,
                rights_bitfield: RIGHT_VOTE | RIGHT_DIVIDEND | RIGHT_LIQ_PREF,
                liq_pref_multiplier_bps: 15_000, // 1.5x
                liq_seniority: 0,
                voting_weight: 1,
                max_supply: Some(1_000_000),
                mintable_post_launch: false,
            }
            .data(),
            acc::AddShareClass {
                authority: payer.pubkey(),
                platform: platform_pda,
                issuer: issuer_pda,
                asset: asset_pda,
                share_class: share_class_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "add_share_class",
    );
    let share_class: ShareClass = load(&svm, &share_class_pda, "share_class");
    assert_eq!(share_class.class_index, 0);
    assert_eq!(share_class.class_type, ShareClassType::PreferredA);
    assert_eq!(share_class.liq_pref_multiplier_bps, 15_000);
    assert_eq!(share_class.max_supply, Some(1_000_000));
    assert!(!share_class.mintable_post_launch);
    assert!(!share_class.mint_initialized);
    assert_eq!(share_class.mint, Pubkey::default());
    let asset: Asset = load(&svm, &asset_pda, "asset");
    assert_eq!(asset.share_classes_count, 1);

    // ── 6. create_kyc_registry ───────────────────────────────────────────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::CreateKycRegistry {
                approved_jurisdictions: [0xFFu8; 128],
                blocked_jurisdictions: [0u8; 128],
            }
            .data(),
            acc::CreateKycRegistry {
                authority: payer.pubkey(),
                admin_authority: payer.pubkey(),
                admin_record: admin_pda,
                kyc_registry: kyc_registry_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "create_kyc_registry",
    );

    // ── 7. approve_holder ────────────────────────────────────────────────────
    // LiteSVM's Clock sysvar defaults to 0; a far-future expiry keeps the
    // `expiry > now` check satisfied without touching the sysvar.
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::ApproveHolder {
                holder,
                jurisdiction: 222,
                accreditation_level: 2,
                expiry: 4_102_444_800, // 2100-01-01
                provider_id: 1,
                external_ref_hash: [5u8; 32],
            }
            .data(),
            acc::ApproveHolder {
                authority: payer.pubkey(),
                kyc_registry: kyc_registry_pda,
                kyc_entry: kyc_entry_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "approve_holder",
    );
    let kyc_entry: KycEntry = load(&svm, &kyc_entry_pda, "kyc_entry");
    assert_eq!(kyc_entry.status, KycStatus::Approved);
    assert_eq!(kyc_entry.holder, holder);
    assert_eq!(kyc_entry.accreditation_level, 2);

    // ── 8. initialize_share_class_mint ───────────────────────────────────────
    let token_2022: Pubkey = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        .parse()
        .unwrap();
    let (mint_pda, _) = Pubkey::find_program_address(
        &[asset_registry::SHARE_MINT_SEED, share_class_pda.as_ref()],
        &program_id,
    );
    // The hook config + meta list are auto-created via CPI inside
    // initialize_share_class_mint (init is registry-CPI-only now).
    let hook_id = transfer_hook::id();
    let (hook_config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint_pda.as_ref()],
        &hook_id,
    );
    let (extra_metas_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint_pda.as_ref()],
        &hook_id,
    );
    // Griefing pre-fund: the metas PDA address is deterministic from public
    // data, so an attacker can land 1 lamport on it before the issuer calls
    // initialize_share_class_mint. Since CPI 2 (meta-list creation) is atomic
    // with the mint init, a raw create_account would permanently block this
    // share class — the hook must create over the pre-funded account.
    svm.airdrop(&extra_metas_pda, 1).unwrap();
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeShareClassMint {}.data(),
            acc::InitializeShareClassMint {
                authority: payer.pubkey(),
                admin_record: admin_pda,
                issuer: issuer_pda,
                asset: asset_pda,
                share_class: share_class_pda,
                mint: mint_pda,
                hook_config: hook_config_pda,
                extra_account_meta_list: extra_metas_pda,
                transfer_hook_program: hook_id,
                token_program: token_2022,
                system_program: system_program::ID,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        ),
        "initialize_share_class_mint",
    );
    let mint_account = svm
        .get_account(&mint_pda)
        .expect("mint account should exist");
    assert_eq!(mint_account.owner, token_2022, "mint owned by Token-2022");
    let share_class: ShareClass = load(&svm, &share_class_pda, "share_class");
    assert!(share_class.mint_initialized);
    assert_eq!(share_class.mint, mint_pda);

    // The hook's gate hardcodes the ShareClass discriminator — keep in sync.
    {
        use anchor_lang::Discriminator;
        assert_eq!(
            ShareClass::DISCRIMINATOR,
            &transfer_hook::SHARE_CLASS_DISCRIMINATOR[..],
            "transfer_hook::SHARE_CLASS_DISCRIMINATOR drifted from asset_registry::ShareClass"
        );
    }
    // Auto-created hook config: Open mode, bound to this share class.
    let hook_cfg: transfer_hook::TransferHookConfig =
        load(&svm, &hook_config_pda, "hook config (auto-created)");
    assert_eq!(hook_cfg.mint, mint_pda);
    assert_eq!(hook_cfg.share_class, share_class_pda);
    assert_eq!(
        hook_cfg.restriction_mode,
        transfer_hook::RestrictionMode::Open
    );
    assert_eq!(hook_cfg.kyc_registry, None);
    assert_eq!(
        hook_cfg.blocklist,
        Pubkey::find_program_address(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED], &hook_id).0,
        "CPI-encoded blocklist arg must land in the config's blocklist field"
    );
    // Auto-created meta list exists and is owned by the hook program.
    let metas_account = svm
        .get_account(&extra_metas_pda)
        .expect("ExtraAccountMetaList should be auto-created");
    assert_eq!(metas_account.owner, hook_id);
    assert!(!metas_account.data.is_empty());

    // ── 8b. activate_asset (minting/sales require an Active asset) ───────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::ActivateAsset {}.data(),
            acc::ActivateAsset {
                authority: payer.pubkey(),
                admin_record: admin_pda,
                issuer: issuer_pda,
                asset: asset_pda,
            }
            .to_account_metas(None),
        ),
        "activate_asset",
    );

    // ── 9. open_custody_vault ────────────────────────────────────────────────
    let vault_id: u64 = 1;
    let (custody_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::CUSTODY_SEED,
            share_class_pda.as_ref(),
            &vault_id.to_le_bytes(),
        ],
        &program_id,
    );
    let (escrow_pda, _) = Pubkey::find_program_address(
        &[asset_registry::ESCROW_SEED, custody_pda.as_ref()],
        &program_id,
    );
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::OpenCustodyVault {
                vault_id,
                vault_type: VaultType::Vesting,
                realize_action: RealizeAction::BurnAndAttest,
                amount: 1_000,
                deadline: 4_102_444_800,
                metadata_hash: [7u8; 32],
                beneficiary: Pubkey::default(),
            }
            .data(),
            acc::OpenCustodyVault {
                authority: payer.pubkey(),
                admin_record: admin_pda,
                share_class: share_class_pda,
                mint: mint_pda,
                custody_vault: custody_pda,
                escrow: escrow_pda,
                escrow_marker: escrow_marker_of(&custody_pda),
                token_program: token_2022,
                system_program: system_program::ID,
                platform: pause::platform_pda(),
                kyc_registry: None,
            }
            .to_account_metas(None),
        ),
        "open_custody_vault",
    );
    assert!(
        svm.get_account(&escrow_marker_of(&custody_pda)).is_some(),
        "escrow marker created with the vault"
    );
    let vault: CustodyVault = load(&svm, &custody_pda, "custody_vault");
    assert_eq!(vault.state, VaultState::Active);
    assert_eq!(vault.vault_type, VaultType::Vesting);

    // ── 10. mint_to_treasury — fund the escrow ───────────────────────────────
    // The destination is the custody escrow (owner = vault PDA), so the vault
    // PDA rides along in remaining accounts as the destination-binding proof.
    let mut fund_escrow_metas = acc::MintToTreasury {
        authority: payer.pubkey(),
        admin_record: admin_pda,
        issuer: issuer_pda,
        asset: asset_pda,
        share_class: share_class_pda,
        mint: mint_pda,
        destination: escrow_pda,
        token_program: token_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    fund_escrow_metas.push(AccountMeta::new_readonly(custody_pda, false));
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::MintToTreasury { amount: 1_000 }.data(),
            fund_escrow_metas,
        ),
        "mint_to_treasury",
    );
    let share_class: ShareClass = load(&svm, &share_class_pda, "share_class");
    assert_eq!(share_class.circulating_supply, 1_000);

    // ── 11. trigger_custody_vault ────────────────────────────────────────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::TriggerCustodyVault {}.data(),
            acc::TriggerCustodyVault {
                authority_admin_record: Pubkey::find_program_address(
                    &[asset_registry::ADMIN_SEED, payer.pubkey().as_ref()],
                    &asset_registry::ID,
                )
                .0,
                authority: payer.pubkey(),
                custody_vault: custody_pda,
            }
            .to_account_metas(None),
        ),
        "trigger_custody_vault",
    );
    let vault: CustodyVault = load(&svm, &custody_pda, "custody_vault");
    assert_eq!(vault.state, VaultState::Triggered);

    // ── 12. realize_custody_vault — burn escrow + attest ─────────────────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::RealizeCustodyVault {}.data(),
            acc::RealizeCustodyVault {
                authority_admin_record: Pubkey::find_program_address(
                    &[asset_registry::ADMIN_SEED, payer.pubkey().as_ref()],
                    &asset_registry::ID,
                )
                .0,
                authority: payer.pubkey(),
                share_class: share_class_pda,
                custody_vault: custody_pda,
                mint: mint_pda,
                escrow: escrow_pda,
                escrow_marker: escrow_marker_of(&custody_pda),
                token_program: token_2022,
                kyc_registry: None,
                kyc_entry: None,
            }
            .to_account_metas(None),
        ),
        "realize_custody_vault",
    );
    let vault: CustodyVault = load(&svm, &custody_pda, "custody_vault");
    assert_eq!(vault.state, VaultState::Realized);
    assert!(
        svm.get_account(&escrow_marker_of(&custody_pda))
            .map(|a| a.data.is_empty() || a.lamports == 0)
            .unwrap_or(true),
        "escrow marker closed on realize"
    );
    let share_class: ShareClass = load(&svm, &share_class_pda, "share_class");
    assert_eq!(
        share_class.circulating_supply, 0,
        "burned tokens left circulation"
    );

    // ── 13. revert_custody_vault — open a 2nd vault, fund it, revert it ───────
    let vault_id_2: u64 = 2;
    let (custody_pda_2, _) = Pubkey::find_program_address(
        &[
            asset_registry::CUSTODY_SEED,
            share_class_pda.as_ref(),
            &vault_id_2.to_le_bytes(),
        ],
        &program_id,
    );
    let (escrow_pda_2, _) = Pubkey::find_program_address(
        &[asset_registry::ESCROW_SEED, custody_pda_2.as_ref()],
        &program_id,
    );
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::OpenCustodyVault {
                vault_id: vault_id_2,
                vault_type: VaultType::Vesting,
                realize_action: RealizeAction::BurnAndAttest,
                amount: 50,
                deadline: 0, // already past (LiteSVM clock = 0) → revertable now
                metadata_hash: [8u8; 32],
                beneficiary: Pubkey::default(),
            }
            .data(),
            acc::OpenCustodyVault {
                authority: payer.pubkey(),
                admin_record: admin_pda,
                share_class: share_class_pda,
                mint: mint_pda,
                custody_vault: custody_pda_2,
                escrow: escrow_pda_2,
                escrow_marker: escrow_marker_of(&custody_pda_2),
                token_program: token_2022,
                system_program: system_program::ID,
                platform: pause::platform_pda(),
                kyc_registry: None,
            }
            .to_account_metas(None),
        ),
        "open_custody_vault #2",
    );
    let mut fund_escrow_2_metas = acc::MintToTreasury {
        authority: payer.pubkey(),
        admin_record: admin_pda,
        issuer: issuer_pda,
        asset: asset_pda,
        share_class: share_class_pda,
        mint: mint_pda,
        destination: escrow_pda_2,
        token_program: token_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    fund_escrow_2_metas.push(AccountMeta::new_readonly(custody_pda_2, false));
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::MintToTreasury { amount: 50 }.data(),
            fund_escrow_2_metas,
        ),
        "mint_to_treasury #2",
    );
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::RevertCustodyVault {}.data(),
            acc::RevertCustodyVault {
                authority_admin_record: Pubkey::find_program_address(
                    &[asset_registry::ADMIN_SEED, payer.pubkey().as_ref()],
                    &asset_registry::ID,
                )
                .0,
                payer: payer.pubkey(),
                share_class: share_class_pda,
                custody_vault: custody_pda_2,
                mint: mint_pda,
                escrow: escrow_pda_2,
                escrow_marker: escrow_marker_of(&custody_pda_2),
                token_program: token_2022,
            }
            .to_account_metas(None),
        ),
        "revert_custody_vault",
    );
    let vault: CustodyVault = load(&svm, &custody_pda_2, "custody_vault #2");
    assert_eq!(vault.state, VaultState::Reverted);
    let share_class: ShareClass = load(&svm, &share_class_pda, "share_class");
    assert_eq!(
        share_class.circulating_supply, 0,
        "reverted mint burned back"
    );

    // ── 14. Launchpad: payment-mint setup + open_sale ────────────────────────
    let payment_mint = create_token_mint(&mut svm, &payer, 6, &token_2022);
    let buyer = Keypair::new();
    svm.airdrop(&buyer.pubkey(), 100_000_000_000).unwrap();

    let buyer_payment_ata = create_ata(
        &mut svm,
        &payer,
        &payment_mint,
        &buyer.pubkey(),
        &token_2022,
    );
    mint_tokens(
        &mut svm,
        &payer,
        &payment_mint,
        &buyer_payment_ata,
        100_000_000,
        &token_2022,
    );
    let buyer_share_ata = create_ata(&mut svm, &payer, &mint_pda, &buyer.pubkey(), &token_2022);
    let issuer_payment_ata = create_ata(
        &mut svm,
        &payer,
        &payment_mint,
        &payer.pubkey(),
        &token_2022,
    );

    let sale_id: u64 = 1;
    let (sale_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::SALE_SEED,
            share_class_pda.as_ref(),
            &sale_id.to_le_bytes(),
        ],
        &program_id,
    );
    let (proceeds_pda, _) = Pubkey::find_program_address(
        &[asset_registry::PROCEEDS_SEED, sale_pda.as_ref()],
        &program_id,
    );
    // An Admin (here the super admin) approves the sale; open_sale consumes it.
    let approval_terms = sale_approval::Terms::covering(&svm, 1_000_000, 500, RaiseType::Mature);
    let approval = sale_approval::approve_sale(
        &mut svm,
        &payer,
        &issuer_pda,
        &asset_pda,
        &share_class_pda,
        &payment_mint,
        sale_id,
        approval_terms,
    );
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::OpenSale {
                sale_id,
                price_per_unit: 1_000_000, // 1 payment-token unit per share unit
                total_for_sale: 500,
                start_ts: 0,
                end_ts: 0,
                raise_type: RaiseType::Mature,
                cliff_months: 0,
                vesting_months: 0,
            }
            .data(),
            acc::OpenSale {
                authority: payer.pubkey(),
                issuer: issuer_pda,
                asset: asset_pda,
                share_class: share_class_pda,
                mint: mint_pda,
                payment_mint,
                sale: sale_pda,
                proceeds: proceeds_pda,
                payment_token_program: token_2022,
                system_program: system_program::ID,
                sale_approval: approval,
                approved_by: payer.pubkey(),
                approver_admin_record: sale_approval::admin_pda(&payer.pubkey()),
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        ),
        "open_sale",
    );
    assert!(
        sale_approval::is_closed(&svm, &approval),
        "approval consumed"
    );
    let opened: Sale = load(&svm, &sale_pda, "sale");
    assert_eq!(opened.sale_approval, approval);
    assert_eq!(opened.application_hash, approval_terms.application_hash);
    assert_eq!(opened.version, asset_registry::SALE_STATE_VERSION);

    // ── 15. buy — buyer pays, receives minted units ──────────────────────────
    // `buy` is fail-closed on receiver KYC: the mint's hook tail must ride
    // along so the restriction mode can be proven on-chain. Open mode ⇒ the
    // ExtraAccountMetaList (in its 1-meta Open shape) is the proof.
    let mut buy_metas = acc::Buy {
        asset: asset_pda,
        issuer: issuer_pda,
        buyer: buyer.pubkey(),
        sale: sale_pda,
        share_class: share_class_pda,
        mint: mint_pda,
        buyer_share_account: buyer_share_ata,
        buyer_payment_account: buyer_payment_ata,
        payment_mint,
        proceeds: proceeds_pda,
        share_token_program: token_2022,
        payment_token_program: token_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    buy_metas.push(AccountMeta::new_readonly(extra_metas_pda, false));
    send(
        &mut svm,
        &buyer,
        Instruction::new_with_bytes(program_id, &ixd::Buy { amount: 10 }.data(), buy_metas),
        "buy",
    );
    let sale: Sale = load(&svm, &sale_pda, "sale");
    assert_eq!(sale.sold, 10);
    let share_class: ShareClass = load(&svm, &share_class_pda, "share_class");
    assert_eq!(share_class.circulating_supply, 10);

    // ── 16. close_sale — sweep proceeds to the issuer ────────────────────────
    let close_sale_ix = Instruction::new_with_bytes(
        program_id,
        &ixd::CloseSale {}.data(),
        acc::CloseSale {
            authority: payer.pubkey(),
            sale: sale_pda,
            proceeds: proceeds_pda,
            payment_mint,
            destination: issuer_payment_ata,
            payment_token_program: token_2022,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
    );
    // Emergency pause: mature-sale proceeds to the issuer are bit5.
    pause::pause_only(&mut svm, &payer, asset_registry::PAUSE_ISSUER_PROCEEDS);
    pause::assert_paused(
        try_send(&mut svm, &payer, close_sale_ix.clone()),
        "close_sale under ISSUER_PROCEEDS",
    );
    pause::pause_only(
        &mut svm,
        &payer,
        asset_registry::PAUSE_FLAGS_ALL & !asset_registry::PAUSE_ISSUER_PROCEEDS,
    );
    send(&mut svm, &payer, close_sale_ix, "close_sale");
    pause::unpause_all(&mut svm, &payer);
    let sale: Sale = load(&svm, &sale_pda, "sale");
    assert_eq!(sale.status, SaleStatus::Closed);
    // 2D: the swept proceeds account is closed in the same instruction.
    assert!(
        svm.get_account(&proceeds_pda)
            .is_none_or(|a| a.lamports == 0 && a.data.is_empty()),
        "proceeds account closed by close_sale"
    );

    // ── 17. OTC: create_offer — the buyer lists units for secondary sale ─────
    let offer_id: u64 = 1;
    let (offer_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::OFFER_SEED,
            share_class_pda.as_ref(),
            &offer_id.to_le_bytes(),
        ],
        &program_id,
    );
    let (offer_escrow_pda, _) = Pubkey::find_program_address(
        &[asset_registry::ESCROW_SEED, offer_pda.as_ref()],
        &program_id,
    );
    send(
        &mut svm,
        &buyer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::CreateOffer {
                offer_id,
                amount: 5,
                price: 6_000_000,
                // future expiry (clock = 0) — take_offer below proves a
                // not-yet-expired offer still fills.
                expires_at: 4_102_444_800,
            }
            .data(),
            acc::CreateOffer {
                maker: buyer.pubkey(),
                share_class: share_class_pda,
                mint: mint_pda,
                payment_mint,
                offer: offer_pda,
                escrow: offer_escrow_pda,
                escrow_marker: escrow_marker_of(&offer_pda),
                token_program: token_2022,
                system_program: system_program::ID,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        ),
        "create_offer",
    );
    let offer: Offer = load(&svm, &offer_pda, "offer");
    assert_eq!(offer.status, OfferStatus::Open);
    assert_eq!(offer.maker, buyer.pubkey());
    assert_eq!(offer.amount, 5);
    assert_eq!(offer.price, 6_000_000);

    // ── 18. transfer_hook setup — blocklist authority only. The per-mint
    // config + meta list were auto-created by initialize_share_class_mint
    // (step 8); the manual init path is gone (registry-CPI-only).
    let (blocklist_authority_pda, _) =
        Pubkey::find_program_address(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED], &hook_id);
    support::set_upgrade_authority(&mut svm, &transfer_hook::ID, Some(payer.pubkey()));
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            hook_id,
            &transfer_hook::instruction::InitializeBlocklistAuthority {
                authority: payer.pubkey(),
            }
            .data(),
            transfer_hook::accounts::InitializeBlocklistAuthority {
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

    // ── 19. real transferChecked through the hook — clean sender passes
    // immediately (Open-mode 3-account tail, no manual config step) ──────────
    let holder_b = Keypair::new();
    let holder_b_ata = create_ata(&mut svm, &payer, &mint_pda, &holder_b.pubkey(), &token_2022);
    let (buyer_block_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::BLOCK_ENTRY_SEED, buyer.pubkey().as_ref()],
        &hook_id,
    );
    // transferChecked accounts = [source, mint, dest, authority] + hook accounts
    // [source BlockEntry, ExtraAccountMetaList, hook program] (docs/05 §5).
    let hook_metas = [
        AccountMeta::new_readonly(buyer_block_pda, false),
        AccountMeta::new_readonly(extra_metas_pda, false),
        AccountMeta::new_readonly(hook_id, false),
    ];
    let mut transfer_ix = token_ix::transfer_checked(
        &token_2022,
        &buyer_share_ata,
        &mint_pda,
        &holder_b_ata,
        &buyer.pubkey(),
        &[],
        3,
        0,
    )
    .unwrap();
    transfer_ix.accounts.extend_from_slice(&hook_metas);
    send(&mut svm, &buyer, transfer_ix, "transfer_checked (clean)");

    // ── 20. fund the OTC offer escrow — maker deposits the units through
    // `deposit_to_offer_escrow`, which CREDITS `offer.deposited`. A bare
    // client-side transfer into the escrow would still land the tokens, but it
    // records nothing — and `take_offer` sells only what the ledger backs.
    let mut fund_metas = acc::DepositToOfferEscrow {
        maker: buyer.pubkey(),
        offer: offer_pda,
        mint: mint_pda,
        escrow: offer_escrow_pda,
        maker_share_account: buyer_share_ata,
        token_program: token_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    fund_metas.extend_from_slice(&hook_metas);
    send(
        &mut svm,
        &buyer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::DepositToOfferEscrow { amount: 5 }.data(),
            fund_metas,
        ),
        "deposit_to_offer_escrow",
    );
    let offer: Offer = load(&svm, &offer_pda, "offer");
    assert_eq!(offer.deposited, 5, "deposit ledger credited");

    // ── 21. take_offer — a taker fills the OTC offer ─────────────────────────
    let taker = Keypair::new();
    svm.airdrop(&taker.pubkey(), 100_000_000_000).unwrap();
    let taker_payment_ata = create_ata(
        &mut svm,
        &payer,
        &payment_mint,
        &taker.pubkey(),
        &token_2022,
    );
    mint_tokens(
        &mut svm,
        &payer,
        &payment_mint,
        &taker_payment_ata,
        10_000_000,
        &token_2022,
    );
    let taker_share_ata = create_ata(&mut svm, &payer, &mint_pda, &taker.pubkey(), &token_2022);

    // remaining_accounts for the escrow→taker hook transfer — source authority
    // is the Offer PDA, so its BlockEntry; then ExtraAccountMetaList + program.
    let (offer_block_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::BLOCK_ENTRY_SEED, offer_pda.as_ref()],
        &hook_id,
    );
    let mut take_metas = acc::TakeOffer {
        taker: taker.pubkey(),
        offer: offer_pda,
        mint: mint_pda,
        escrow: offer_escrow_pda,
        taker_share_account: taker_share_ata,
        payment_mint,
        taker_payment_account: taker_payment_ata,
        maker_payment_account: buyer_payment_ata, // buyer is the maker
        escrow_marker: escrow_marker_of(&offer_pda),
        share_token_program: token_2022,
        payment_token_program: token_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    take_metas.push(AccountMeta::new_readonly(offer_block_pda, false));
    take_metas.push(AccountMeta::new_readonly(extra_metas_pda, false));
    take_metas.push(AccountMeta::new_readonly(hook_id, false));
    send(
        &mut svm,
        &taker,
        Instruction::new_with_bytes(program_id, &ixd::TakeOffer {}.data(), take_metas),
        "take_offer",
    );
    let offer: Offer = load(&svm, &offer_pda, "offer");
    assert_eq!(offer.status, OfferStatus::Filled);
    assert!(
        svm.get_account(&escrow_marker_of(&offer_pda))
            .map(|a| a.data.is_empty() || a.lamports == 0)
            .unwrap_or(true),
        "escrow marker closed on take_offer"
    );

    // ── 22. blocklist the sender ─────────────────────────────────────────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            hook_id,
            &transfer_hook::instruction::AddToBlocklist {
                wallet: buyer.pubkey(),
            }
            .data(),
            transfer_hook::accounts::AddToBlocklist {
                authority: payer.pubkey(),
                blocklist_authority: blocklist_authority_pda,
                block_entry: buyer_block_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "add_to_blocklist",
    );

    // ── 23. transferChecked again — blocklisted sender is rejected ───────────
    svm.expire_blockhash();
    let mut blocked_ix = token_ix::transfer_checked(
        &token_2022,
        &buyer_share_ata,
        &mint_pda,
        &holder_b_ata,
        &buyer.pubkey(),
        &[],
        1,
        0,
    )
    .unwrap();
    blocked_ix.accounts.extend_from_slice(&hook_metas);
    assert!(
        try_send(&mut svm, &buyer, blocked_ix).is_err(),
        "transferChecked must fail — sender is blocklisted"
    );

    // ── 24. governance: create_proposal ──────────────────────────────────────
    let proposal_id: u64 = 1;
    // Two-leaf voting snapshot — payer weight 100, buyer weight 60.
    let leaf_payer = util::snapshot_leaf(&payer.pubkey(), 100);
    let leaf_buyer = util::snapshot_leaf(&buyer.pubkey(), 60);
    let snapshot_root = util::merkle_parent(leaf_payer, leaf_buyer);

    let (proposal_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::PROPOSAL_SEED,
            share_class_pda.as_ref(),
            &proposal_id.to_le_bytes(),
        ],
        &program_id,
    );
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::CreateProposal {
                proposal_id,
                metadata_hash: [4u8; 32],
                snapshot_slot: 0,
                snapshot_root,
                start_ts: 0,
                end_ts: 1,
            }
            .data(),
            acc::CreateProposal {
                authority: payer.pubkey(),
                admin_record: admin_pda,
                share_class: share_class_pda,
                proposal: proposal_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "create_proposal",
    );

    // ── 25. cast_vote — payer votes For (weight 100) ─────────────────────────
    let (payer_vote_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::VOTE_SEED,
            proposal_pda.as_ref(),
            payer.pubkey().as_ref(),
        ],
        &program_id,
    );
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::CastVote {
                choice: VoteChoice::For,
                weight: 100,
                proof: vec![leaf_buyer],
            }
            .data(),
            acc::CastVote {
                voter: payer.pubkey(),
                proposal: proposal_pda,
                vote_record: payer_vote_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "cast_vote (payer)",
    );

    // ── 26. cast_vote — buyer votes Against (weight 60) ──────────────────────
    let (buyer_vote_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::VOTE_SEED,
            proposal_pda.as_ref(),
            buyer.pubkey().as_ref(),
        ],
        &program_id,
    );
    send(
        &mut svm,
        &buyer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::CastVote {
                choice: VoteChoice::Against,
                weight: 60,
                proof: vec![leaf_payer],
            }
            .data(),
            acc::CastVote {
                voter: buyer.pubkey(),
                proposal: proposal_pda,
                vote_record: buyer_vote_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "cast_vote (buyer)",
    );
    let proposal: Proposal = load(&svm, &proposal_pda, "proposal");
    assert_eq!(proposal.for_weight, 100);
    assert_eq!(proposal.against_weight, 60);

    // Exact end boundary: a new vote is closed while finalization is allowed.
    let mut clock: solana_clock::Clock = svm.get_sysvar();
    clock.unix_timestamp = 1;
    svm.set_sysvar(&clock);
    let outsider_vote = Pubkey::find_program_address(
        &[
            asset_registry::VOTE_SEED,
            proposal_pda.as_ref(),
            holder_b.pubkey().as_ref(),
        ],
        &program_id,
    )
    .0;
    svm.airdrop(&holder_b.pubkey(), 1_000_000_000).unwrap();
    let boundary_error = try_send(
        &mut svm,
        &holder_b,
        Instruction::new_with_bytes(
            program_id,
            &ixd::CastVote {
                choice: VoteChoice::For,
                weight: 1,
                proof: vec![],
            }
            .data(),
            acc::CastVote {
                voter: holder_b.pubkey(),
                proposal: proposal_pda,
                vote_record: outsider_vote,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
    )
    .unwrap_err();
    assert!(boundary_error.contains("VotingClosed"), "{boundary_error}");

    // ── 27. finalize_proposal — advisory outcome ─────────────────────────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::FinalizeProposal {}.data(),
            acc::FinalizeProposal {
                payer: payer.pubkey(),
                proposal: proposal_pda,
            }
            .to_account_metas(None),
        ),
        "finalize_proposal",
    );
    let proposal: Proposal = load(&svm, &proposal_pda, "proposal");
    assert_eq!(proposal.status, ProposalStatus::Finalized);
    assert_eq!(proposal.outcome, ProposalOutcome::Passed);

    // ── 28. OTC cancel_offer — holder_b opens, funds and cancels an offer ─────
    svm.airdrop(&holder_b.pubkey(), 100_000_000_000).unwrap();
    let offer2_id: u64 = 2;
    let (offer2_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::OFFER_SEED,
            share_class_pda.as_ref(),
            &offer2_id.to_le_bytes(),
        ],
        &program_id,
    );
    let (offer2_escrow_pda, _) = Pubkey::find_program_address(
        &[asset_registry::ESCROW_SEED, offer2_pda.as_ref()],
        &program_id,
    );
    send(
        &mut svm,
        &holder_b,
        Instruction::new_with_bytes(
            program_id,
            &ixd::CreateOffer {
                offer_id: offer2_id,
                amount: 2,
                price: 2_000_000,
                expires_at: 0, // never expires
            }
            .data(),
            acc::CreateOffer {
                maker: holder_b.pubkey(),
                share_class: share_class_pda,
                mint: mint_pda,
                payment_mint,
                offer: offer2_pda,
                escrow: offer2_escrow_pda,
                escrow_marker: escrow_marker_of(&offer2_pda),
                token_program: token_2022,
                system_program: system_program::ID,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        ),
        "create_offer #2",
    );
    // fund the escrow — holder_b (not blocklisted) deposits 2 units
    let (holder_b_block_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::BLOCK_ENTRY_SEED, holder_b.pubkey().as_ref()],
        &hook_id,
    );
    let mut fund2_metas = acc::DepositToOfferEscrow {
        maker: holder_b.pubkey(),
        offer: offer2_pda,
        mint: mint_pda,
        escrow: offer2_escrow_pda,
        maker_share_account: holder_b_ata,
        token_program: token_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    fund2_metas.extend_from_slice(&[
        AccountMeta::new_readonly(holder_b_block_pda, false),
        AccountMeta::new_readonly(extra_metas_pda, false),
        AccountMeta::new_readonly(hook_id, false),
    ]);
    send(
        &mut svm,
        &holder_b,
        Instruction::new_with_bytes(
            program_id,
            &ixd::DepositToOfferEscrow { amount: 2 }.data(),
            fund2_metas,
        ),
        "deposit_to_offer_escrow #2",
    );
    // cancel — escrow returns to holder_b (source authority = Offer PDA)
    let (offer2_block_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::BLOCK_ENTRY_SEED, offer2_pda.as_ref()],
        &hook_id,
    );
    let mut cancel_metas = acc::CancelOffer {
        maker: holder_b.pubkey(),
        offer: offer2_pda,
        mint: mint_pda,
        escrow: offer2_escrow_pda,
        maker_share_account: holder_b_ata,
        escrow_marker: escrow_marker_of(&offer2_pda),
        share_token_program: token_2022,
    }
    .to_account_metas(None);
    cancel_metas.push(AccountMeta::new_readonly(offer2_block_pda, false));
    cancel_metas.push(AccountMeta::new_readonly(extra_metas_pda, false));
    cancel_metas.push(AccountMeta::new_readonly(hook_id, false));
    send(
        &mut svm,
        &holder_b,
        Instruction::new_with_bytes(program_id, &ixd::CancelOffer {}.data(), cancel_metas),
        "cancel_offer",
    );
    let offer2: Offer = load(&svm, &offer2_pda, "offer #2");
    assert_eq!(offer2.status, OfferStatus::Cancelled);

    // ── 29. Rights Token: create_rights_issuance ─────────────────────────────
    let rt_issuance_id: u64 = 1;
    let (rights_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::RIGHTS_SEED,
            share_class_pda.as_ref(),
            &rt_issuance_id.to_le_bytes(),
        ],
        &program_id,
    );
    let (rights_escrow_pda, _) = Pubkey::find_program_address(
        &[asset_registry::ESCROW_SEED, rights_pda.as_ref()],
        &program_id,
    );
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::CreateRightsIssuance {
                issuance_id: rt_issuance_id,
            }
            .data(),
            acc::CreateRightsIssuance {
                identity: Pubkey::find_program_address(
                    &[asset_registry::ESCROW_MARKER_SEED, rights_pda.as_ref()],
                    &asset_registry::ID,
                )
                .0,
                authority: payer.pubkey(),
                admin_record: admin_pda,
                share_class: share_class_pda,
                underlying_mint: mint_pda,
                rights_issuance: rights_pda,
                escrow: rights_escrow_pda,
                token_program: token_2022,
                system_program: system_program::ID,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        ),
        "create_rights_issuance",
    );

    // ── 30. fund the rights escrow with underlying (mint_to_treasury) ────────
    // Destination owner = the RightsIssuance PDA — passed along as the
    // destination-binding proof.
    let mut fund_rights_metas = acc::MintToTreasury {
        authority: payer.pubkey(),
        admin_record: admin_pda,
        issuer: issuer_pda,
        asset: asset_pda,
        share_class: share_class_pda,
        mint: mint_pda,
        destination: rights_escrow_pda,
        token_program: token_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    fund_rights_metas.push(AccountMeta::new_readonly(rights_pda, false));
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::MintToTreasury { amount: 100 }.data(),
            fund_rights_metas,
        ),
        "fund rights escrow",
    );

    // ── 31. publish_milestone — single-leaf snapshot (holder_b entitled 40) ──
    let rt_milestone_index: u16 = 0;
    let claim_leaf = util::snapshot_leaf(&holder_b.pubkey(), 40);
    let (milestone_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::RT_MILESTONE_SEED,
            rights_pda.as_ref(),
            &rt_milestone_index.to_le_bytes(),
        ],
        &program_id,
    );
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::PublishMilestone {
                index: rt_milestone_index,
                merkle_root: claim_leaf, // single-leaf tree → root == leaf
                amount_pool: 40,
                unlock_ts: 0,
            }
            .data(),
            acc::PublishMilestone {
                authority: payer.pubkey(),
                admin_record: admin_pda,
                rights_issuance: rights_pda,
                milestone: milestone_pda,
                system_program: system_program::ID,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        ),
        "publish_milestone",
    );

    // ── 32. claim_milestone — holder_b claims 40 underlying ──────────────────
    let (rt_claim_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::RT_CLAIM_SEED,
            milestone_pda.as_ref(),
            holder_b.pubkey().as_ref(),
        ],
        &program_id,
    );
    let (rights_block_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::BLOCK_ENTRY_SEED, rights_pda.as_ref()],
        &hook_id,
    );
    let mut claim_metas = acc::ClaimMilestone {
        claimer: holder_b.pubkey(),
        rights_issuance: rights_pda,
        milestone: milestone_pda,
        claim: rt_claim_pda,
        underlying_mint: mint_pda,
        escrow: rights_escrow_pda,
        claimer_token_account: holder_b_ata,
        token_program: token_2022,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    claim_metas.push(AccountMeta::new_readonly(rights_block_pda, false));
    claim_metas.push(AccountMeta::new_readonly(extra_metas_pda, false));
    claim_metas.push(AccountMeta::new_readonly(hook_id, false));
    send(
        &mut svm,
        &holder_b,
        Instruction::new_with_bytes(
            program_id,
            &ixd::ClaimMilestone {
                amount: 40,
                proof: vec![],
            }
            .data(),
            claim_metas,
        ),
        "claim_milestone",
    );
    let milestone: VestingMilestone = load(&svm, &milestone_pda, "milestone");
    assert_eq!(milestone.claimed, 40);
    let rights: RightsIssuance = load(&svm, &rights_pda, "rights issuance");
    assert_eq!(rights.total_claimed, 40);

    // ── 33. lock_supply — close minting on the share class (audit M3) ────────
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &ixd::LockSupply {}.data(),
            acc::LockSupply {
                authority: payer.pubkey(),
                admin_record: admin_pda,
                share_class: share_class_pda,
            }
            .to_account_metas(None),
        ),
        "lock_supply",
    );

    // ── 34. mint_to_treasury must now fail — supply is locked ────────────────
    let locked_mint_ix = Instruction::new_with_bytes(
        program_id,
        &ixd::MintToTreasury { amount: 1 }.data(),
        acc::MintToTreasury {
            authority: payer.pubkey(),
            admin_record: admin_pda,
            issuer: issuer_pda,
            asset: asset_pda,
            share_class: share_class_pda,
            mint: mint_pda,
            destination: holder_b_ata,
            token_program: token_2022,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
    );
    assert!(
        try_send(&mut svm, &payer, locked_mint_ix).is_err(),
        "mint_to_treasury must fail — supply is locked"
    );

    println!("happy path OK — 34 steps incl. supply lock (audit M3 closed)");
}

// ── revoke_holder ─────────────────────────────────────────────────────────────

/// Boots a minimal SVM (just enough to test KYC), returns
/// `(svm, program_id, authority_keypair)`. The platform is initialised so the
/// authority also holds the super-admin record `create_kyc_registry` demands.
fn boot_kyc() -> (LiteSVM, Pubkey, Keypair) {
    let mut svm = LiteSVM::new();
    let program_id = asset_registry::id();
    svm.add_program(
        program_id,
        include_bytes!("../../../target/deploy/asset_registry.so"),
    )
    .unwrap();
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 100_000_000_000).unwrap();

    let (platform_pda, _) =
        Pubkey::find_program_address(&[asset_registry::PLATFORM_SEED], &program_id);
    support::set_upgrade_authority(&mut svm, &asset_registry::ID, Some(authority.pubkey()));
    send(
        &mut svm,
        &authority,
        Instruction::new_with_bytes(
            program_id,
            &ixd::InitializePlatform {
                protocol_treasury: authority.pubkey(),
                protocol_fee_bps: 250,
            }
            .data(),
            acc::InitializePlatform {
                admin: authority.pubkey(),
                upgrade_authority: authority.pubkey(),
                program: asset_registry::ID,
                program_data: support::program_data(&asset_registry::ID),
                platform: platform_pda,
                super_admin_record: admin_pda_of(program_id, &authority.pubkey()),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "initialize_platform (boot_kyc)",
    );
    pause::unpause_all(&mut svm, &authority);
    (svm, program_id, authority)
}

/// `["admin", wallet]` PDA.
fn admin_pda_of(program_id: Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[asset_registry::ADMIN_SEED, wallet.as_ref()], &program_id).0
}

/// Creates a `KycRegistry` owned by `authority` (who also co-signs as admin)
/// and returns its PDA.
fn create_kyc_registry_for(svm: &mut LiteSVM, program_id: Pubkey, authority: &Keypair) -> Pubkey {
    let (kyc_registry_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::KYC_REGISTRY_SEED,
            authority.pubkey().as_ref(),
        ],
        &program_id,
    );
    send(
        svm,
        authority,
        Instruction::new_with_bytes(
            program_id,
            &ixd::CreateKycRegistry {
                approved_jurisdictions: [0xFFu8; 128],
                blocked_jurisdictions: [0u8; 128],
            }
            .data(),
            acc::CreateKycRegistry {
                authority: authority.pubkey(),
                admin_authority: authority.pubkey(),
                admin_record: admin_pda_of(program_id, &authority.pubkey()),
                kyc_registry: kyc_registry_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "create_kyc_registry",
    );
    kyc_registry_pda
}

/// Calls `approve_holder` and returns the `kyc_entry` PDA.
fn approve_holder_for(
    svm: &mut LiteSVM,
    program_id: Pubkey,
    authority: &Keypair,
    kyc_registry_pda: Pubkey,
    holder: Pubkey,
) -> Pubkey {
    let (kyc_entry_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::KYC_SEED,
            kyc_registry_pda.as_ref(),
            holder.as_ref(),
        ],
        &program_id,
    );
    send(
        svm,
        authority,
        Instruction::new_with_bytes(
            program_id,
            &ixd::ApproveHolder {
                holder,
                jurisdiction: 111,
                accreditation_level: 1,
                expiry: 4_102_444_800, // 2100-01-01
                provider_id: 1,
                external_ref_hash: [7u8; 32],
            }
            .data(),
            acc::ApproveHolder {
                authority: authority.pubkey(),
                kyc_registry: kyc_registry_pda,
                kyc_entry: kyc_entry_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "approve_holder",
    );
    kyc_entry_pda
}

#[test]
fn revoke_holder_flips_status_to_revoked() {
    let (mut svm, program_id, authority) = boot_kyc();
    let holder = Keypair::new().pubkey();

    let kyc_registry_pda = create_kyc_registry_for(&mut svm, program_id, &authority);
    let kyc_entry_pda =
        approve_holder_for(&mut svm, program_id, &authority, kyc_registry_pda, holder);

    // Precondition: entry is Approved.
    let before: KycEntry = load(&svm, &kyc_entry_pda, "kyc_entry before revoke");
    assert_eq!(before.status, KycStatus::Approved);

    // Act: revoke_holder.
    send(
        &mut svm,
        &authority,
        Instruction::new_with_bytes(
            program_id,
            &ixd::RevokeHolder { holder }.data(),
            acc::RevokeHolder {
                authority: authority.pubkey(),
                kyc_registry: kyc_registry_pda,
                kyc_entry: kyc_entry_pda,
            }
            .to_account_metas(None),
        ),
        "revoke_holder",
    );

    // Assert: entry flipped to Revoked.
    let after: KycEntry = load(&svm, &kyc_entry_pda, "kyc_entry after revoke");
    assert_eq!(after.status, KycStatus::Revoked);
    assert_eq!(after.holder, holder, "holder field unchanged");
}

#[test]
fn revoke_holder_rejects_non_authority() {
    let (mut svm, program_id, authority) = boot_kyc();
    let holder = Keypair::new().pubkey();
    let intruder = Keypair::new();
    svm.airdrop(&intruder.pubkey(), 100_000_000_000).unwrap();

    let kyc_registry_pda = create_kyc_registry_for(&mut svm, program_id, &authority);
    let kyc_entry_pda =
        approve_holder_for(&mut svm, program_id, &authority, kyc_registry_pda, holder);

    // The intruder passes the real registry (taken by address, no seeds), so
    // it is `has_one = authority` that must reject: Unauthorized (6001).
    let result = try_send(
        &mut svm,
        &intruder,
        Instruction::new_with_bytes(
            program_id,
            &ixd::RevokeHolder { holder }.data(),
            acc::RevokeHolder {
                authority: intruder.pubkey(),
                kyc_registry: kyc_registry_pda, // real registry, wrong authority
                kyc_entry: kyc_entry_pda,
            }
            .to_account_metas(None),
        ),
    );
    let err = result.expect_err("non-authority must not revoke");
    assert!(
        err.contains("Custom(6001)"),
        "expected Unauthorized, got {err}"
    );
}

// ── approve_holder re-approval (init_if_needed) ──────────────────────────────

/// Builds an `approve_holder` instruction with explicit field values.
#[allow(clippy::too_many_arguments)]
fn approve_holder_ix(
    program_id: Pubkey,
    authority: &Pubkey,
    kyc_registry_pda: Pubkey,
    kyc_entry_pda: Pubkey,
    holder: Pubkey,
    jurisdiction: u16,
    accreditation_level: u8,
    expiry: i64,
    provider_id: u16,
    external_ref_hash: [u8; 32],
) -> Instruction {
    Instruction::new_with_bytes(
        program_id,
        &ixd::ApproveHolder {
            holder,
            jurisdiction,
            accreditation_level,
            expiry,
            provider_id,
            external_ref_hash,
        }
        .data(),
        acc::ApproveHolder {
            authority: *authority,
            kyc_registry: kyc_registry_pda,
            kyc_entry: kyc_entry_pda,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

#[test]
fn approve_holder_reapproves_after_revoke() {
    let (mut svm, program_id, authority) = boot_kyc();
    let holder = Keypair::new().pubkey();

    let kyc_registry_pda = create_kyc_registry_for(&mut svm, program_id, &authority);
    let kyc_entry_pda =
        approve_holder_for(&mut svm, program_id, &authority, kyc_registry_pda, holder);
    let before: KycEntry = load(&svm, &kyc_entry_pda, "entry after first approval");
    let original_bump = before.bump;
    let reg: asset_registry::KycRegistry = load(&svm, &kyc_registry_pda, "registry");
    assert_eq!(reg.entries_count, 1);

    // revoke
    send(
        &mut svm,
        &authority,
        Instruction::new_with_bytes(
            program_id,
            &ixd::RevokeHolder { holder }.data(),
            acc::RevokeHolder {
                authority: authority.pubkey(),
                kyc_registry: kyc_registry_pda,
                kyc_entry: kyc_entry_pda,
            }
            .to_account_metas(None),
        ),
        "revoke_holder",
    );
    let revoked: KycEntry = load(&svm, &kyc_entry_pda, "entry after revoke");
    assert_eq!(revoked.status, KycStatus::Revoked);

    // re-approve with entirely fresh fields — must succeed (init_if_needed)
    send(
        &mut svm,
        &authority,
        approve_holder_ix(
            program_id,
            &authority.pubkey(),
            kyc_registry_pda,
            kyc_entry_pda,
            holder,
            222,           // new jurisdiction
            3,             // new accreditation tier
            4_133_980_800, // new expiry (2101-01-01)
            9,             // new provider
            [9u8; 32],     // new dossier hash
        ),
        "approve_holder (re-approval after revoke)",
    );
    let after: KycEntry = load(&svm, &kyc_entry_pda, "entry after re-approval");
    assert_eq!(after.status, KycStatus::Approved, "status refreshed");
    assert_eq!(after.jurisdiction, 222, "jurisdiction overwritten");
    assert_eq!(after.accreditation_level, 3, "tier overwritten");
    assert_eq!(after.expiry, 4_133_980_800, "expiry overwritten");
    assert_eq!(after.provider_id, 9, "provider overwritten");
    assert_eq!(
        after.external_ref_hash, [9u8; 32],
        "dossier hash overwritten"
    );
    assert_eq!(after.holder, holder, "holder unchanged");
    assert_eq!(after.bump, original_bump, "bump kept");

    // entries_count counts holders, not approvals — unchanged on re-approval
    let reg: asset_registry::KycRegistry = load(&svm, &kyc_registry_pda, "registry");
    assert_eq!(reg.entries_count, 1, "re-approval must not double-count");
}

#[test]
fn approve_holder_refreshes_expired_entry() {
    let (mut svm, program_id, authority) = boot_kyc();
    let holder = Keypair::new().pubkey();

    let kyc_registry_pda = create_kyc_registry_for(&mut svm, program_id, &authority);
    let (kyc_entry_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::KYC_SEED,
            kyc_registry_pda.as_ref(),
            holder.as_ref(),
        ],
        &program_id,
    );

    // now = 1_000; approve with a short expiry (1_500)
    let mut clock: solana_clock::Clock = svm.get_sysvar();
    clock.unix_timestamp = 1_000;
    svm.set_sysvar(&clock);
    send(
        &mut svm,
        &authority,
        approve_holder_ix(
            program_id,
            &authority.pubkey(),
            kyc_registry_pda,
            kyc_entry_pda,
            holder,
            111,
            1,
            1_500,
            1,
            [7u8; 32],
        ),
        "approve_holder (short expiry)",
    );

    // warp past the expiry — the entry is now stale
    let mut clock: solana_clock::Clock = svm.get_sysvar();
    clock.unix_timestamp = 2_000;
    svm.set_sysvar(&clock);

    // re-approve refreshes the expiry in place
    send(
        &mut svm,
        &authority,
        approve_holder_ix(
            program_id,
            &authority.pubkey(),
            kyc_registry_pda,
            kyc_entry_pda,
            holder,
            111,
            1,
            3_000,
            1,
            [7u8; 32],
        ),
        "approve_holder (refresh after expiry)",
    );
    let after: KycEntry = load(&svm, &kyc_entry_pda, "entry after refresh");
    assert_eq!(after.status, KycStatus::Approved);
    assert_eq!(after.expiry, 3_000, "expiry refreshed");

    // an expiry not in the future is still rejected on re-approval
    let err = try_send(
        &mut svm,
        &authority,
        approve_holder_ix(
            program_id,
            &authority.pubkey(),
            kyc_registry_pda,
            kyc_entry_pda,
            holder,
            111,
            1,
            1_999, // <= now
            1,
            [7u8; 32],
        ),
    );
    assert!(err.is_err(), "past expiry must fail on re-approval too");
}
