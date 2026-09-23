//! `activate_asset` + Active-status enforcement — LiteSVM e2e tests.
//!
//! Assets start `Draft`; only an admin may activate them, and
//! `mint_to_treasury` / `open_sale` require an `Active` asset. The boot stops
//! before activation so each test can drive the lifecycle itself.

#[path = "../../../tests/support/pause.rs"]
mod pause;
#[path = "../../../tests/support/mod.rs"]
mod support;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    asset_registry::{
        accounts as acc, instruction as ixd, Asset, AssetStatus, AssetType, JurisdictionRules,
        ShareClassType, RIGHT_DIVIDEND, RIGHT_LIQ_PREF, RIGHT_VOTE,
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

fn load<T: AccountDeserialize>(svm: &LiteSVM, pda: &Pubkey) -> T {
    let a = svm.get_account(pda).expect("account missing");
    T::try_deserialize(&mut a.data.as_slice()).expect("deserialize")
}

fn create_ata(svm: &mut LiteSVM, payer: &Keypair, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    let ix = ata_ix::create_associated_token_account(&payer.pubkey(), owner, mint, &TOKEN_2022);
    send(svm, &[payer], &[ix], "create_ata");
    get_associated_token_address_with_program_id(owner, mint, &TOKEN_2022)
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair, decimals: u8) -> Pubkey {
    use anchor_lang::solana_program::system_instruction;
    let mint = Keypair::new();
    let lamports = svm.minimum_balance_for_rent_exemption(82);
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        lamports,
        82,
        &TOKEN_2022,
    );
    let init =
        token_ix::initialize_mint2(&TOKEN_2022, &mint.pubkey(), &payer.pubkey(), None, decimals)
            .unwrap();
    send(svm, &[payer, &mint], &[create, init], "create_mint");
    mint.pubkey()
}

/// Everything the tests need after boot.
#[allow(dead_code)]
struct Ctx {
    program_id: Pubkey,
    payer: Keypair,
    admin_pda: Pubkey,
    platform_pda: Pubkey,
    issuer_pda: Pubkey,
    asset_pda: Pubkey,
    share_class_pda: Pubkey,
    mint_pda: Pubkey,
}

/// Boots platform → issuer → asset → share class → mint, stopping BEFORE
/// `activate_asset` — the asset stays `Draft`.
fn boot() -> (LiteSVM, Ctx) {
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

    let legal_entity_id: [u8; 32] = *b"ACTIVATE-ASSET-ENTITY-0000000001";
    let asset_id = "activate-001";
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
    pause::unpause_all(&mut svm, &payer);
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
                name: "Activation Pilot".to_string(),
                symbol_prefix: "ACTV".to_string(),
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
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        )],
        "initialize_share_class_mint",
    );

    let ctx = Ctx {
        program_id,
        payer,
        admin_pda,
        platform_pda,
        issuer_pda,
        asset_pda,
        share_class_pda,
        mint_pda,
    };
    (svm, ctx)
}

fn activate_ix(ctx: &Ctx, authority: &Pubkey) -> Instruction {
    let (admin_record, _) = Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, authority.as_ref()],
        &ctx.program_id,
    );
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::ActivateAsset {}.data(),
        acc::ActivateAsset {
            authority: *authority,
            admin_record,
            issuer: ctx.issuer_pda,
            asset: ctx.asset_pda,
        }
        .to_account_metas(None),
    )
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn activate_flips_status() {
    let (mut svm, ctx) = boot();

    let asset: Asset = load(&svm, &ctx.asset_pda);
    assert_eq!(asset.status, AssetStatus::Draft);

    send(
        &mut svm,
        &[&ctx.payer],
        &[activate_ix(&ctx, &ctx.payer.pubkey())],
        "activate_asset",
    );
    let asset: Asset = load(&svm, &ctx.asset_pda);
    assert_eq!(asset.status, AssetStatus::Active);
}

#[test]
fn double_activate_rejected() {
    let (mut svm, ctx) = boot();
    send(
        &mut svm,
        &[&ctx.payer],
        &[activate_ix(&ctx, &ctx.payer.pubkey())],
        "activate_asset",
    );
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[activate_ix(&ctx, &ctx.payer.pubkey())],
    )
    .expect_err("second activate must fail");
    assert!(err.contains("AssetNotDraft"), "got: {err}");
}

#[test]
fn mint_on_draft_rejected() {
    let (mut svm, ctx) = boot();
    let destination = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &ctx.payer.pubkey());

    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::MintToTreasury { amount: 100 }.data(),
            acc::MintToTreasury {
                authority: ctx.payer.pubkey(),
                admin_record: ctx.admin_pda,
                issuer: ctx.issuer_pda,
                asset: ctx.asset_pda,
                share_class: ctx.share_class_pda,
                mint: ctx.mint_pda,
                destination,
                token_program: TOKEN_2022,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        )],
    )
    .expect_err("mint_to_treasury on a Draft asset must fail");
    assert!(err.contains("AssetNotActive"), "got: {err}");

    // after activation it works
    send(
        &mut svm,
        &[&ctx.payer],
        &[activate_ix(&ctx, &ctx.payer.pubkey())],
        "activate_asset",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::MintToTreasury { amount: 100 }.data(),
            acc::MintToTreasury {
                authority: ctx.payer.pubkey(),
                admin_record: ctx.admin_pda,
                issuer: ctx.issuer_pda,
                asset: ctx.asset_pda,
                share_class: ctx.share_class_pda,
                mint: ctx.mint_pda,
                destination,
                token_program: TOKEN_2022,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        )],
        "mint_to_treasury after activation",
    );
}

#[test]
fn open_sale_on_draft_rejected() {
    let (mut svm, ctx) = boot();
    let payment_mint = create_mint(&mut svm, &ctx.payer, 6);
    let sale_id = 1u64;
    let (sale_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::SALE_SEED,
            ctx.share_class_pda.as_ref(),
            &sale_id.to_le_bytes(),
        ],
        &ctx.program_id,
    );
    let (proceeds_pda, _) = Pubkey::find_program_address(
        &[asset_registry::PROCEEDS_SEED, sale_pda.as_ref()],
        &ctx.program_id,
    );

    let open_sale_ix = || {
        Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::OpenSale {
                sale_id,
                price_per_unit: 1,
                total_for_sale: 100,
                start_ts: 0,
                end_ts: 0,
                raise_type: asset_registry::RaiseType::Mature,
                cliff_months: 0,
                vesting_months: 0,
            }
            .data(),
            acc::OpenSale {
                authority: ctx.payer.pubkey(),
                issuer: ctx.issuer_pda,
                asset: ctx.asset_pda,
                share_class: ctx.share_class_pda,
                mint: ctx.mint_pda,
                payment_mint,
                sale: sale_pda,
                proceeds: proceeds_pda,
                payment_token_program: TOKEN_2022,
                system_program: system_program::ID,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        )
    };

    let err = try_send(&mut svm, &[&ctx.payer], &[open_sale_ix()])
        .expect_err("open_sale on a Draft asset must fail");
    assert!(err.contains("AssetNotActive"), "got: {err}");

    // after activation it works
    send(
        &mut svm,
        &[&ctx.payer],
        &[activate_ix(&ctx, &ctx.payer.pubkey())],
        "activate_asset",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_sale_ix()],
        "open_sale after activation",
    );
}

#[test]
fn non_admin_activate_rejected() {
    let (mut svm, ctx) = boot();
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();

    let err = try_send(
        &mut svm,
        &[&stranger],
        &[activate_ix(&ctx, &stranger.pubkey())],
    )
    .expect_err("non-admin activate must fail");
    // the stranger has no Admin PDA — Anchor rejects the missing account
    assert!(
        err.contains("AccountNotInitialized") || err.contains("AccountDiscriminator"),
        "got: {err}"
    );
    let asset: Asset = load(&svm, &ctx.asset_pda);
    assert_eq!(asset.status, AssetStatus::Draft);
}
