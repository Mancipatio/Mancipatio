//! Program hygiene (P2 W-D) — LiteSVM e2e tests.
//!
//! * `set_convertible_to` — admin + issuer-authority double gate; target must
//!   be an existing share class of the SAME asset and not the class itself;
//!   omitting the target account clears `convertible_to`.
//! * `add_share_class` — a `PhysicalGood` asset's share class must be
//!   hard-capped at exactly one unit (`max_supply == Some(1)`).

#[path = "../../../tests/support/mod.rs"]
mod support;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    asset_registry::{
        accounts as acc, instruction as ixd, AssetType, JurisdictionRules, ShareClass,
        ShareClassType, RIGHT_DIVIDEND, RIGHT_LIQ_PREF, RIGHT_VOTE,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

// ── Helpers (pattern from test_mint_metadata.rs) ─────────────────────────────

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

fn read_share_class(svm: &LiteSVM, pda: &Pubkey) -> ShareClass {
    let a = svm.get_account(pda).expect("share class missing");
    ShareClass::try_deserialize(&mut a.data.as_slice()).expect("deserialize ShareClass")
}

struct Ctx {
    program_id: Pubkey,
    payer: Keypair,
    platform_pda: Pubkey,
    issuer_pda: Pubkey,
}

fn asset_pda(ctx: &Ctx, asset_id: &str) -> Pubkey {
    Pubkey::find_program_address(
        &[
            asset_registry::ASSET_SEED,
            ctx.issuer_pda.as_ref(),
            asset_id.as_bytes(),
        ],
        &ctx.program_id,
    )
    .0
}

fn share_class_pda(ctx: &Ctx, asset: &Pubkey, class_index: u8) -> Pubkey {
    Pubkey::find_program_address(
        &[
            asset_registry::SHARE_CLASS_SEED,
            asset.as_ref(),
            &[class_index],
        ],
        &ctx.program_id,
    )
    .0
}

/// Boots platform → verified issuer. Assets/classes are added per test.
fn boot() -> (LiteSVM, Ctx) {
    let program_id = asset_registry::id();
    let mut svm = LiteSVM::new();
    svm.add_program(
        program_id,
        include_bytes!("../../../target/deploy/asset_registry.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    let legal_entity_id: [u8; 32] = *b"CONVERTIBLE-ENTITY-0000000000001";
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

    let ctx = Ctx {
        program_id,
        payer,
        platform_pda,
        issuer_pda,
    };
    (svm, ctx)
}

fn create_asset_ix(ctx: &Ctx, asset_id: &str, asset_type: AssetType) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::CreateAsset {
            asset_id: asset_id.to_string(),
            asset_type,
            name: format!("Asset {asset_id}"),
            symbol_prefix: "CNV".to_string(),
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
            authority: ctx.payer.pubkey(),
            platform: ctx.platform_pda,
            issuer: ctx.issuer_pda,
            asset: asset_pda(ctx, asset_id),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn add_share_class_ix(
    ctx: &Ctx,
    asset_id: &str,
    class_index: u8,
    max_supply: Option<u64>,
) -> Instruction {
    add_share_class_ix_full(ctx, asset_id, class_index, max_supply, false)
}

fn add_share_class_ix_full(
    ctx: &Ctx,
    asset_id: &str,
    class_index: u8,
    max_supply: Option<u64>,
    mintable_post_launch: bool,
) -> Instruction {
    let asset = asset_pda(ctx, asset_id);
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::AddShareClass {
            class_index,
            class_type: ShareClassType::Common,
            rights_bitfield: RIGHT_VOTE | RIGHT_DIVIDEND | RIGHT_LIQ_PREF,
            liq_pref_multiplier_bps: 10_000,
            liq_seniority: 0,
            voting_weight: 1,
            max_supply,
            mintable_post_launch,
        }
        .data(),
        acc::AddShareClass {
            authority: ctx.payer.pubkey(),
            platform: ctx.platform_pda,
            issuer: ctx.issuer_pda,
            asset,
            share_class: share_class_pda(ctx, &asset, class_index),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn set_convertible_ix(
    ctx: &Ctx,
    authority: &Pubkey,
    asset: &Pubkey,
    share_class: &Pubkey,
    target: Option<Pubkey>,
) -> Instruction {
    let (admin_record, _) = Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, authority.as_ref()],
        &ctx.program_id,
    );
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::SetConvertibleTo {}.data(),
        acc::SetConvertibleTo {
            authority: *authority,
            admin_record,
            issuer: ctx.issuer_pda,
            asset: *asset,
            share_class: *share_class,
            target_share_class: target,
        }
        .to_account_metas(None),
    )
}

/// Creates an Equity asset with `classes` uncapped share classes.
fn setup_equity_asset(svm: &mut LiteSVM, ctx: &Ctx, asset_id: &str, classes: u8) -> Pubkey {
    send(
        svm,
        &[&ctx.payer],
        &[create_asset_ix(ctx, asset_id, AssetType::Equity)],
        "create_asset",
    );
    for i in 0..classes {
        send(
            svm,
            &[&ctx.payer],
            &[add_share_class_ix(ctx, asset_id, i, None)],
            "add_share_class",
        );
    }
    asset_pda(ctx, asset_id)
}

// ── set_convertible_to ───────────────────────────────────────────────────────

#[test]
fn set_change_and_clear_convertible_target() {
    let (mut svm, ctx) = boot();
    let asset = setup_equity_asset(&mut svm, &ctx, "conv-001", 3);
    let class0 = share_class_pda(&ctx, &asset, 0);
    let class1 = share_class_pda(&ctx, &asset, 1);
    let class2 = share_class_pda(&ctx, &asset, 2);

    assert_eq!(read_share_class(&svm, &class0).convertible_to, None);

    // set → class1
    send(
        &mut svm,
        &[&ctx.payer],
        &[set_convertible_ix(
            &ctx,
            &ctx.payer.pubkey(),
            &asset,
            &class0,
            Some(class1),
        )],
        "set_convertible_to (class1)",
    );
    assert_eq!(read_share_class(&svm, &class0).convertible_to, Some(class1));

    // change → class2
    send(
        &mut svm,
        &[&ctx.payer],
        &[set_convertible_ix(
            &ctx,
            &ctx.payer.pubkey(),
            &asset,
            &class0,
            Some(class2),
        )],
        "set_convertible_to (class2)",
    );
    assert_eq!(read_share_class(&svm, &class0).convertible_to, Some(class2));

    // clear → None (target account omitted)
    send(
        &mut svm,
        &[&ctx.payer],
        &[set_convertible_ix(
            &ctx,
            &ctx.payer.pubkey(),
            &asset,
            &class0,
            None,
        )],
        "set_convertible_to (clear)",
    );
    assert_eq!(read_share_class(&svm, &class0).convertible_to, None);

    // other classes untouched
    assert_eq!(read_share_class(&svm, &class1).convertible_to, None);
    assert_eq!(read_share_class(&svm, &class2).convertible_to, None);
}

#[test]
fn rejects_self_target() {
    let (mut svm, ctx) = boot();
    let asset = setup_equity_asset(&mut svm, &ctx, "conv-002", 1);
    let class0 = share_class_pda(&ctx, &asset, 0);

    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[set_convertible_ix(
            &ctx,
            &ctx.payer.pubkey(),
            &asset,
            &class0,
            Some(class0),
        )],
    )
    .expect_err("self target must fail");
    assert!(err.contains("ConvertibleTargetInvalid"), "got: {err}");
    assert_eq!(read_share_class(&svm, &class0).convertible_to, None);
}

#[test]
fn rejects_target_from_another_asset() {
    let (mut svm, ctx) = boot();
    let asset_a = setup_equity_asset(&mut svm, &ctx, "conv-003a", 1);
    let asset_b = setup_equity_asset(&mut svm, &ctx, "conv-003b", 1);
    let a0 = share_class_pda(&ctx, &asset_a, 0);
    let b0 = share_class_pda(&ctx, &asset_b, 0);

    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[set_convertible_ix(
            &ctx,
            &ctx.payer.pubkey(),
            &asset_a,
            &a0,
            Some(b0),
        )],
    )
    .expect_err("foreign-asset target must fail");
    assert!(err.contains("ConvertibleTargetInvalid"), "got: {err}");
    assert_eq!(read_share_class(&svm, &a0).convertible_to, None);

    // a non-ShareClass account as target fails the discriminator check
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[set_convertible_ix(
            &ctx,
            &ctx.payer.pubkey(),
            &asset_a,
            &a0,
            Some(ctx.issuer_pda),
        )],
    )
    .expect_err("non-ShareClass target must fail");
    assert!(
        err.contains("AccountDiscriminator") || err.contains("AccountNotInitialized"),
        "got: {err}"
    );
}

#[test]
fn double_gate_rejects_non_admin_and_non_issuer_admin() {
    let (mut svm, ctx) = boot();
    let asset = setup_equity_asset(&mut svm, &ctx, "conv-004", 2);
    let class0 = share_class_pda(&ctx, &asset, 0);
    let class1 = share_class_pda(&ctx, &asset, 1);

    // Stranger with no Admin record — the admin_record PDA does not exist.
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();
    let err = try_send(
        &mut svm,
        &[&stranger],
        &[set_convertible_ix(
            &ctx,
            &stranger.pubkey(),
            &asset,
            &class0,
            Some(class1),
        )],
    )
    .expect_err("non-admin must fail");
    assert!(err.contains("Unauthorized"), "got: {err}");

    // A real admin who is NOT the issuer authority — has_one gate fires.
    let other_admin = Keypair::new();
    svm.airdrop(&other_admin.pubkey(), 100_000_000_000).unwrap();
    let (other_admin_pda, _) = Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, other_admin.pubkey().as_ref()],
        &ctx.program_id,
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::AddAdmin {
                new_admin: other_admin.pubkey(),
            }
            .data(),
            acc::AddAdmin {
                super_admin: ctx.payer.pubkey(),
                platform: ctx.platform_pda,
                admin_record: other_admin_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "add_admin",
    );
    let err = try_send(
        &mut svm,
        &[&other_admin],
        &[set_convertible_ix(
            &ctx,
            &other_admin.pubkey(),
            &asset,
            &class0,
            Some(class1),
        )],
    )
    .expect_err("admin who is not the issuer authority must fail");
    assert!(err.contains("Unauthorized"), "got: {err}");

    assert_eq!(read_share_class(&svm, &class0).convertible_to, None);
}

// ── PhysicalGood supply-1 ────────────────────────────────────────────────────

#[test]
fn physical_good_share_class_requires_unit_supply() {
    let (mut svm, ctx) = boot();
    let asset_id = "phys-001";
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_asset_ix(&ctx, asset_id, AssetType::PhysicalGood)],
        "create_asset (physical)",
    );

    // uncapped — rejected
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[add_share_class_ix(&ctx, asset_id, 0, None)],
    )
    .expect_err("uncapped PhysicalGood class must fail");
    assert!(err.contains("PhysicalGoodRequiresUnitSupply"), "got: {err}");

    // capped at 5 — rejected
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[add_share_class_ix(&ctx, asset_id, 0, Some(5))],
    )
    .expect_err("supply-5 PhysicalGood class must fail");
    assert!(err.contains("PhysicalGoodRequiresUnitSupply"), "got: {err}");

    // supply-1 — accepted
    send(
        &mut svm,
        &[&ctx.payer],
        &[add_share_class_ix(&ctx, asset_id, 0, Some(1))],
        "add_share_class (supply-1)",
    );
    let asset = asset_pda(&ctx, asset_id);
    let sc = read_share_class(&svm, &share_class_pda(&ctx, &asset, 0));
    assert_eq!(sc.max_supply, Some(1));
    assert_eq!(sc.class_index, 0);
}

#[test]
fn non_physical_assets_stay_uncapped() {
    // Equity classes with max_supply = None keep working (regression guard).
    let (mut svm, ctx) = boot();
    let asset = setup_equity_asset(&mut svm, &ctx, "conv-005", 1);
    let sc = read_share_class(&svm, &share_class_pda(&ctx, &asset, 0));
    assert_eq!(sc.max_supply, None);
}

#[test]
fn physical_good_asset_rejects_second_share_class() {
    // Supply-1 must hold per ASSET, not merely per class: a second supply-1
    // class would mint a second "the item" token for the same unique good.
    let (mut svm, ctx) = boot();
    let asset_id = "phys-002";
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_asset_ix(&ctx, asset_id, AssetType::PhysicalGood)],
        "create_asset (physical)",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[add_share_class_ix(&ctx, asset_id, 0, Some(1))],
        "add_share_class (first)",
    );

    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[add_share_class_ix(&ctx, asset_id, 1, Some(1))],
    )
    .expect_err("second PhysicalGood class must fail");
    assert!(err.contains("PhysicalGoodSingleClass"), "got: {err}");

    // Equity assets still take multiple classes (regression guard).
    let equity = setup_equity_asset(&mut svm, &ctx, "conv-006", 2);
    assert_eq!(
        read_share_class(&svm, &share_class_pda(&ctx, &equity, 1)).class_index,
        1
    );
}

#[test]
fn physical_good_share_class_rejects_post_launch_minting() {
    // A realize burn resets circulating_supply to 0; mintable_post_launch
    // would then allow re-minting the "unique" unit. Must be rejected at
    // class creation.
    let (mut svm, ctx) = boot();
    let asset_id = "phys-003";
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_asset_ix(&ctx, asset_id, AssetType::PhysicalGood)],
        "create_asset (physical)",
    );

    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[add_share_class_ix_full(&ctx, asset_id, 0, Some(1), true)],
    )
    .expect_err("mintable_post_launch PhysicalGood class must fail");
    assert!(err.contains("PhysicalGoodPostLaunchMint"), "got: {err}");

    // Non-mintable supply-1 class is accepted.
    send(
        &mut svm,
        &[&ctx.payer],
        &[add_share_class_ix_full(&ctx, asset_id, 0, Some(1), false)],
        "add_share_class (non-mintable)",
    );
    let asset = asset_pda(&ctx, asset_id);
    let sc = read_share_class(&svm, &share_class_pda(&ctx, &asset, 0));
    assert!(!sc.mintable_post_launch);
}
