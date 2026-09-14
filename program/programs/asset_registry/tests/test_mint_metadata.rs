//! Token-2022 on-chain metadata on share-class mints (business doc §10) —
//! LiteSVM e2e tests. `initialize_share_class_mint` derives name/symbol from
//! the asset and wires the MetadataPointer + TokenMetadata extensions;
//! `update_mint_metadata` may only change the `uri` field.

#[path = "../../../tests/support/mod.rs"]
mod support;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        token_2022::spl_token_2022::{
            extension::{BaseStateWithExtensions, StateWithExtensions},
            state::Mint as SplMint,
        },
        token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata,
    },
    asset_registry::{
        accounts as acc, instruction as ixd, AssetType, JurisdictionRules, ShareClassType,
        RIGHT_DIVIDEND, RIGHT_LIQ_PREF, RIGHT_VOTE,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const TOKEN_2022: Pubkey = spl_token_2022_interface::id();

// ── Helpers (pattern from test_otc_deal.rs) ──────────────────────────────────

fn send(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction], label: &str) {
    svm.expire_blockhash();
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &bh);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).expect("sign");
    if let Err(e) = svm.send_transaction(tx) {
        panic!("[{label}] tx failed: {e:?}");
    }
}

fn try_send(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction]) -> Result<(), String> {
    svm.expire_blockhash();
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &bh);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).expect("sign");
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

/// Reads the TokenMetadata TLV entry from a mint account.
fn read_metadata(svm: &LiteSVM, mint: &Pubkey) -> TokenMetadata {
    let a = svm.get_account(mint).expect("mint missing");
    let state = StateWithExtensions::<SplMint>::unpack(&a.data).expect("unpack mint");
    state
        .get_variable_len_extension::<TokenMetadata>()
        .expect("metadata tlv")
}

/// Everything the tests need after boot.
#[allow(dead_code)]
struct Ctx {
    program_id: Pubkey,
    payer: Keypair,
    admin_pda: Pubkey,
    issuer_pda: Pubkey,
    asset_pda: Pubkey,
    share_class_pda: Pubkey,
    mint_pda: Pubkey,
}

/// Boots platform → issuer → asset → share class → hook-wired mint with
/// on-chain metadata, using the given asset name / symbol prefix.
fn boot(asset_name: &str, symbol_prefix: &str) -> (LiteSVM, Ctx) {
    let program_id = asset_registry::id();
    let mut svm = LiteSVM::new();
    svm.add_program(
        program_id,
        include_bytes!("../../../target/deploy/asset_registry.so"),
    )
    .unwrap();
    // transfer_hook must be loaded too — initialize_share_class_mint CPIs into
    // it to auto-create the per-mint hook config + meta list.
    svm.add_program(
        transfer_hook::id(),
        include_bytes!("../../../target/deploy/transfer_hook.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    let legal_entity_id: [u8; 32] = *b"MINT-METADATA-ENTITY-00000000001";
    let asset_id = "metadata-001";
    let class_index: u8 = 0;

    let (platform_pda, _) =
        Pubkey::find_program_address(&[asset_registry::PLATFORM_SEED], &program_id);
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
    let (mint_pda, _) = Pubkey::find_program_address(
        &[asset_registry::SHARE_MINT_SEED, share_class_pda.as_ref()],
        &program_id,
    );

    support::set_upgrade_authority(&mut svm, &asset_registry::ID, Some(payer.pubkey()));
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
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
        )],
        "initialize_platform",
    );
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::RegisterIssuer {
                legal_entity_id,
                jurisdiction: 222,
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
        )],
        "register_issuer",
    );
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::VerifyIssuerKyb { approved: true }.data(),
            acc::VerifyIssuerKyb {
                admin: payer.pubkey(),
                platform: platform_pda,
                issuer: issuer_pda,
            }
            .to_account_metas(None),
        )],
        "verify_issuer_kyb",
    );
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::CreateAsset {
                asset_id: asset_id.to_string(),
                asset_type: AssetType::Equity,
                name: asset_name.to_string(),
                symbol_prefix: symbol_prefix.to_string(),
                legal_doc_hash: [3u8; 32],
                jurisdiction_rules: JurisdictionRules {
                    allowed_countries: [0u8; 128],
                    max_holders: 0,
                    restricted_period_end: 0,
                    allow_p2p: true,
                },
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
        )],
        "create_asset",
    );
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::AddShareClass {
                class_index,
                class_type: ShareClassType::Common,
                rights_bitfield: RIGHT_VOTE | RIGHT_DIVIDEND | RIGHT_LIQ_PREF,
                liq_pref_multiplier_bps: 10_000,
                liq_seniority: 0,
                voting_weight: 1,
                max_supply: None,
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
        )],
        "add_share_class",
    );
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeShareClassMint {}.data(),
            acc::InitializeShareClassMint {
                authority: payer.pubkey(),
                admin_record: admin_pda,
                issuer: issuer_pda,
                asset: asset_pda,
                share_class: share_class_pda,
                mint: mint_pda,
                hook_config: Pubkey::find_program_address(
                    &[transfer_hook::HOOK_CONFIG_SEED, mint_pda.as_ref()],
                    &transfer_hook::id(),
                )
                .0,
                extra_account_meta_list: Pubkey::find_program_address(
                    &[transfer_hook::EXTRA_METAS_SEED, mint_pda.as_ref()],
                    &transfer_hook::id(),
                )
                .0,
                transfer_hook_program: transfer_hook::id(),
                token_program: TOKEN_2022,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "initialize_share_class_mint",
    );

    let ctx = Ctx {
        program_id,
        payer,
        admin_pda,
        issuer_pda,
        asset_pda,
        share_class_pda,
        mint_pda,
    };
    (svm, ctx)
}

fn update_metadata_ix(ctx: &Ctx, authority: &Pubkey, field: &str, value: &str) -> Instruction {
    let (admin_record, _) = Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, authority.as_ref()],
        &ctx.program_id,
    );
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::UpdateMintMetadata {
            field: field.to_string(),
            value: value.to_string(),
        }
        .data(),
        acc::UpdateMintMetadata {
            authority: *authority,
            admin_record,
            issuer: ctx.issuer_pda,
            asset: ctx.asset_pda,
            share_class: ctx.share_class_pda,
            mint: ctx.mint_pda,
            token_program: TOKEN_2022,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn mint_carries_onchain_metadata() {
    let (svm, ctx) = boot("Metadata Pilot", "META");

    let md = read_metadata(&svm, &ctx.mint_pda);
    assert_eq!(md.name, "Metadata Pilot · Class 0");
    assert_eq!(md.symbol, "META0");
    assert_eq!(md.uri, "");
    assert_eq!(md.mint, ctx.mint_pda);
    assert_eq!(
        Option::<Pubkey>::from(md.update_authority),
        Some(ctx.share_class_pda),
        "ShareClass PDA is the metadata update authority"
    );
}

#[test]
fn update_uri_works_and_other_fields_rejected() {
    let (mut svm, ctx) = boot("Metadata Pilot", "META");

    // uri update — allowed
    let uri = "https://mancipatio.example/assets/metadata-001.json";
    send(
        &mut svm,
        &[&ctx.payer],
        &[update_metadata_ix(&ctx, &ctx.payer.pubkey(), "uri", uri)],
        "update_mint_metadata (uri)",
    );
    let md = read_metadata(&svm, &ctx.mint_pda);
    assert_eq!(md.uri, uri);
    // name/symbol untouched
    assert_eq!(md.name, "Metadata Pilot · Class 0");
    assert_eq!(md.symbol, "META0");

    // a longer uri — grows the TLV entry (rent top-up inside the instruction)
    let longer = "https://mancipatio.example/assets/metadata-001.json?v=2&class=common";
    send(
        &mut svm,
        &[&ctx.payer],
        &[update_metadata_ix(&ctx, &ctx.payer.pubkey(), "uri", longer)],
        "update_mint_metadata (longer uri)",
    );
    assert_eq!(read_metadata(&svm, &ctx.mint_pda).uri, longer);

    // name update — rejected by the whitelist
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[update_metadata_ix(
            &ctx,
            &ctx.payer.pubkey(),
            "name",
            "Hijacked",
        )],
    )
    .expect_err("name update must fail");
    assert!(err.contains("InvalidMetadataField"), "got: {err}");
}

#[test]
fn non_privileged_update_rejected() {
    let (mut svm, ctx) = boot("Metadata Pilot", "META");
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();

    let err = try_send(
        &mut svm,
        &[&stranger],
        &[update_metadata_ix(
            &ctx,
            &stranger.pubkey(),
            "uri",
            "https://evil.example",
        )],
    )
    .expect_err("non-admin update must fail");
    // The signer is not this issuer; authority binding rejects before the optional role proof.
    assert!(err.contains("Unauthorized"), "got: {err}");
    assert_eq!(read_metadata(&svm, &ctx.mint_pda).uri, "");
}

#[test]
fn long_asset_name_truncated() {
    // 40-char asset name → metadata name capped at 32 bytes; 10-char symbol
    // prefix + class index → symbol capped at 10 bytes.
    let (svm, ctx) = boot(&"A".repeat(40), "SYMBOLPREF");

    let md = read_metadata(&svm, &ctx.mint_pda);
    assert_eq!(md.name, "A".repeat(32));
    assert!(md.name.len() <= 32);
    assert_eq!(md.symbol, "SYMBOLPREF");
    assert!(md.symbol.len() <= 10);
}
