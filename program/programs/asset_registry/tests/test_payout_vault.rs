//! End-to-end tests for the PayoutVault module (Faza 1–3).

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
        accounts as acc, instruction as ixd, state::*, util, RIGHT_DIVIDEND, RIGHT_LIQ_PREF,
        RIGHT_VOTE,
    },
    litesvm::LiteSVM,
    solana_clock::Clock,
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
#[allow(dead_code)]
fn warp_to(svm: &mut LiteSVM, unix_ts: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_ts;
    svm.set_sysvar(&clock);
}
fn create_mint(svm: &mut LiteSVM, payer: &Keypair, decimals: u8) -> Pubkey {
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
fn create_ata(svm: &mut LiteSVM, payer: &Keypair, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    let ix = ata_ix::create_associated_token_account(&payer.pubkey(), owner, mint, &TOKEN_2022);
    send(svm, &[payer], &[ix], "create_ata");
    get_associated_token_address_with_program_id(owner, mint, &TOKEN_2022)
}
#[allow(dead_code)]
fn mint_to(svm: &mut LiteSVM, payer: &Keypair, mint: &Pubkey, dest: &Pubkey, amount: u64) {
    let ix = token_ix::mint_to(&TOKEN_2022, mint, dest, &payer.pubkey(), &[], amount).unwrap();
    send(svm, &[payer], &[ix], "mint_to");
}
#[allow(dead_code)]
fn token_balance(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    let a = svm.get_account(ata).expect("ata missing");
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}
fn boot() -> (LiteSVM, Pubkey) {
    let program_id = asset_registry::id();
    let mut svm = LiteSVM::new();
    svm.add_program(
        program_id,
        include_bytes!("../../../target/deploy/asset_registry.so"),
    )
    .unwrap();
    svm.add_program(
        transfer_hook::id(),
        include_bytes!("../../../target/deploy/transfer_hook.so"),
    )
    .unwrap();
    (svm, program_id)
}

/// All keys needed by payout-vault tests. Built by `setup_sale`.
#[allow(dead_code)]
struct SaleCtx {
    payer: Keypair,
    buyer: Keypair,
    /// Yield distributor — distinct from founder (=payer) so its source ATA
    /// doesn't collide with the founder's payment ATA. Signs route_yield.
    distributor: Keypair,
    issuer: Pubkey,
    asset: Pubkey,
    share_class: Pubkey,
    mint: Pubkey,
    payment_mint: Pubkey,
    sale: Pubkey,
    proceeds: Pubkey,
    sale_id: u64,
    price_per_unit: u64,
    founder_payment_ata: Pubkey,
    buyer_payment_ata: Pubkey,
    buyer_share_ata: Pubkey,
    distributor_ata: Pubkey,
    platform_ata: Pubkey,
}

fn setup_sale(
    svm: &mut LiteSVM,
    raise_type: RaiseType,
    cliff_months: u8,
    vesting_months: u8,
) -> SaleCtx {
    let program_id = asset_registry::id();

    let payer = Keypair::new();
    let platform_owner = Pubkey::new_unique();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    // ── Fixtures (mirror test_happy_path.rs) ────────────────────────────────
    let legal_entity_id: [u8; 32] = *b"RWA-DAO-PILOT-ENTITY-00000000001";
    let asset_id = "pilot-001";
    let class_index: u8 = 0;
    let jurisdiction_rules = JurisdictionRules {
        allowed_countries: [0u8; 128],
        max_holders: 0,
        restricted_period_end: 0,
        allow_p2p: true,
    };

    // ── PDAs ────────────────────────────────────────────────────────────────
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

    // ── 1. initialize_platform ──────────────────────────────────────────────
    support::set_upgrade_authority(svm, &asset_registry::ID, Some(payer.pubkey()));
    send(
        svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::InitializePlatform {
                protocol_treasury: platform_owner,
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

    // ── 2. register_issuer ──────────────────────────────────────────────────
    send(
        svm,
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

    // ── 3. verify_issuer_kyb ────────────────────────────────────────────────
    send(
        svm,
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

    // ── 4. create_asset ─────────────────────────────────────────────────────
    send(
        svm,
        &[&payer],
        &[Instruction::new_with_bytes(
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
        )],
        "create_asset",
    );

    // ── 5. add_share_class ──────────────────────────────────────────────────
    send(
        svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::AddShareClass {
                class_index,
                class_type: ShareClassType::PreferredA,
                rights_bitfield: RIGHT_VOTE | RIGHT_DIVIDEND | RIGHT_LIQ_PREF,
                liq_pref_multiplier_bps: 15_000,
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

    // ── 6. initialize_share_class_mint ──────────────────────────────────────
    send(
        svm,
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

    // ── 6b. activate_asset (minting/sales require an Active asset) ───────────
    send(
        svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::ActivateAsset {}.data(),
            acc::ActivateAsset {
                authority: payer.pubkey(),
                admin_record: admin_pda,
                issuer: issuer_pda,
                asset: asset_pda,
            }
            .to_account_metas(None),
        )],
        "activate_asset",
    );

    // ── 7. mint_to_treasury — fund a treasury ATA for buyer distribution ────
    // Create a treasury ATA for the payer (founder) to hold minted shares.
    let founder_share_ata = create_ata(svm, &payer, &mint_pda, &payer.pubkey());
    send(
        svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::MintToTreasury { amount: 1_000_000 }.data(),
            acc::MintToTreasury {
                authority: payer.pubkey(),
                admin_record: admin_pda,
                issuer: issuer_pda,
                asset: asset_pda,
                share_class: share_class_pda,
                mint: mint_pda,
                destination: founder_share_ata,
                token_program: TOKEN_2022,
            }
            .to_account_metas(None),
        )],
        "mint_to_treasury",
    );

    // ── 8. Payment mint + ATAs ──────────────────────────────────────────────
    let payment_mint = create_mint(svm, &payer, 6);

    let founder_payment_ata = create_ata(svm, &payer, &payment_mint, &payer.pubkey());

    let buyer = Keypair::new();
    svm.airdrop(&buyer.pubkey(), 100_000_000_000).unwrap();

    let buyer_payment_ata = create_ata(svm, &payer, &payment_mint, &buyer.pubkey());
    // Fund the buyer's payment ATA so a later `buy` can pay.
    mint_to(svm, &payer, &payment_mint, &buyer_payment_ata, 100_000_000);

    let buyer_share_ata = create_ata(svm, &payer, &mint_pda, &buyer.pubkey());

    // distributor and platform ATAs (payment-mint) for later yield tests.
    // distributor is its own keypair (not payer/founder) so its source ATA is
    // distinct; it signs route_yield. platform_ata is receive-only.
    let distributor = Keypair::new();
    let distributor_ata = create_ata(svm, &payer, &payment_mint, &distributor.pubkey());
    let platform_ata = create_ata(svm, &payer, &payment_mint, &platform_owner);

    // ── 9. open_sale ────────────────────────────────────────────────────────
    let sale_id: u64 = 1;
    let price_per_unit: u64 = 1;
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

    send(
        svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::OpenSale {
                sale_id,
                price_per_unit,
                total_for_sale: 1_000_000,
                start_ts: 0,
                end_ts: 0,
                raise_type,
                cliff_months,
                vesting_months,
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
                payment_token_program: TOKEN_2022,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "open_sale",
    );

    SaleCtx {
        payer,
        buyer,
        distributor,
        issuer: issuer_pda,
        asset: asset_pda,
        share_class: share_class_pda,
        mint: mint_pda,
        payment_mint,
        sale: sale_pda,
        proceeds: proceeds_pda,
        sale_id,
        price_per_unit,
        founder_payment_ata,
        buyer_payment_ata,
        buyer_share_ata,
        distributor_ata,
        platform_ata,
    }
}

#[test]
fn open_sale_stores_raise_terms() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 2, 12);
    let sale: Sale = load(&svm, &ctx.sale);
    assert_eq!(sale.raise_type, RaiseType::Startup);
    assert_eq!(sale.cliff_months, 2);
    assert_eq!(sale.vesting_months, 12);
}

fn buy_units(svm: &mut LiteSVM, ctx: &SaleCtx, units: u64) {
    let program_id = asset_registry::id();
    // `buy` is fail-closed on receiver KYC — the ExtraAccountMetaList (in its
    // 1-meta Open shape) rides along as the on-chain Open-mode proof.
    let (extra_metas_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, ctx.mint.as_ref()],
        &transfer_hook::id(),
    );
    let mut metas = acc::Buy {
        asset: ctx.asset,
        issuer: ctx.issuer,
        buyer: ctx.buyer.pubkey(),
        sale: ctx.sale,
        share_class: ctx.share_class,
        mint: ctx.mint,
        buyer_share_account: ctx.buyer_share_ata,
        buyer_payment_account: ctx.buyer_payment_ata,
        payment_mint: ctx.payment_mint,
        proceeds: ctx.proceeds,
        share_token_program: TOKEN_2022,
        payment_token_program: TOKEN_2022,
    }
    .to_account_metas(None);
    metas.push(AccountMeta::new_readonly(extra_metas_pda, false));
    send(
        svm,
        &[&ctx.payer, &ctx.buyer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::Buy { amount: units }.data(),
            metas,
        )],
        "buy_units",
    );
}

fn open_payout_vault(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    metadata_hash: [u8; 32],
) -> (Pubkey, Pubkey) {
    let program_id = asset_registry::id();
    let vault_pda = Pubkey::find_program_address(
        &[asset_registry::PAYOUT_SEED, ctx.sale.as_ref()],
        &program_id,
    )
    .0;
    let escrow_pda = Pubkey::find_program_address(
        &[asset_registry::PAYOUT_ESCROW_SEED, vault_pda.as_ref()],
        &program_id,
    )
    .0;
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::OpenPayoutVault { metadata_hash }.data(),
            acc::OpenPayoutVault {
                authority: ctx.payer.pubkey(),
                sale: ctx.sale,
                proceeds: ctx.proceeds,
                payment_mint: ctx.payment_mint,
                vault: vault_pda,
                escrow: escrow_pda,
                payment_token_program: TOKEN_2022,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "open_payout_vault",
    );
    (vault_pda, escrow_pda)
}

#[test]
fn open_payout_vault_funds_and_schedules() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 2, 12);
    buy_units(&mut svm, &ctx, 100);
    let proceeds_before = token_balance(&svm, &ctx.proceeds);
    assert!(proceeds_before > 0);

    let (vault, escrow) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);

    let v: PayoutVault = load(&svm, &vault);
    assert_eq!(v.state, PayoutVaultState::Active);
    assert_eq!(v.total_amount, proceeds_before);
    assert_eq!(v.num_tranches, 10);
    assert_eq!(v.tranche_amount, proceeds_before / 10);
    assert_eq!(token_balance(&svm, &escrow), proceeds_before);
    assert_eq!(token_balance(&svm, &ctx.proceeds), 0);
    let sale: Sale = load(&svm, &ctx.sale);
    assert_eq!(sale.status, SaleStatus::Closed);
}

fn send_post_update_with_hash(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    content_hash: [u8; 32],
) {
    let program_id = asset_registry::id();
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::PostUpdate { content_hash }.data(),
            acc::PostUpdate {
                founder: ctx.payer.pubkey(),
                vault: *vault,
            }
            .to_account_metas(None),
        )],
        "post_update",
    );
}

fn send_post_update(svm: &mut LiteSVM, ctx: &SaleCtx, vault: &Pubkey) {
    send_post_update_with_hash(svm, ctx, vault, [1u8; 32]);
}

fn try_send_post_update(svm: &mut LiteSVM, ctx: &SaleCtx, vault: &Pubkey) -> Result<(), String> {
    let program_id = asset_registry::id();
    try_send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::PostUpdate {
                content_hash: [1u8; 32],
            }
            .data(),
            acc::PostUpdate {
                founder: ctx.payer.pubkey(),
                vault: *vault,
            }
            .to_account_metas(None),
        )],
    )
}

fn send_release(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    escrow: &Pubkey,
    founder_ata: &Pubkey,
) {
    let program_id = asset_registry::id();
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::ReleasePayout {}.data(),
            acc::ReleasePayout {
                vault: *vault,
                escrow: *escrow,
                payment_mint: ctx.payment_mint,
                founder_account: *founder_ata,
                payment_token_program: TOKEN_2022,
            }
            .to_account_metas(None),
        )],
        "release_payout",
    );
}

fn try_send_release(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    escrow: &Pubkey,
    founder_ata: &Pubkey,
) -> Result<(), String> {
    let program_id = asset_registry::id();
    try_send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::ReleasePayout {}.data(),
            acc::ReleasePayout {
                vault: *vault,
                escrow: *escrow,
                payment_mint: ctx.payment_mint,
                founder_account: *founder_ata,
                payment_token_program: TOKEN_2022,
            }
            .to_account_metas(None),
        )],
    )
}

#[test]
fn release_payout_full_startup_lifecycle() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 3); // no cliff, 3 tranches
    buy_units(&mut svm, &ctx, 90);
    let (vault, escrow) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    let v0: PayoutVault = load(&svm, &vault);
    let founder_ata = ctx.founder_payment_ata;

    for i in 0..3i64 {
        warp_to(&mut svm, v0.start_ts + i * 2_592_000 + 1);
        // without an update for this period → release must fail
        assert!(try_send_release(&mut svm, &ctx, &vault, &escrow, &founder_ata).is_err());
        send_post_update(&mut svm, &ctx, &vault);
        send_release(&mut svm, &ctx, &vault, &escrow, &founder_ata);
    }
    let vf: PayoutVault = load(&svm, &vault);
    assert_eq!(vf.state, PayoutVaultState::Completed);
    assert_eq!(vf.tranches_released, 3);
    assert_eq!(token_balance(&svm, &founder_ata), v0.total_amount);
}

#[test]
fn release_payout_blocks_before_tranche_time() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 1, 4);
    buy_units(&mut svm, &ctx, 100);
    let (vault, escrow) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    // clock is 0, tranche[0].ts = start_ts = now0 + 1*MONTH (cliff) → in the future → TrancheNotDue
    assert!(try_send_release(&mut svm, &ctx, &vault, &escrow, &ctx.founder_payment_ata).is_err());
}

#[test]
fn post_update_gates_on_period_start() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 2, 12);
    buy_units(&mut svm, &ctx, 100);
    let (vault, _escrow) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    let v: PayoutVault = load(&svm, &vault);

    // clock is still 0; tranche[0].ts = start_ts (= now0 + 2*MONTH) is in the future → must fail
    assert!(
        try_send_post_update(&mut svm, &ctx, &vault).is_err(),
        "update before period 0 must fail"
    );

    // warp to the start of period 0
    warp_to(&mut svm, v.start_ts + 1);
    // use a different content_hash so the tx bytes differ from the failed try above
    send_post_update_with_hash(&mut svm, &ctx, &vault, [2u8; 32]);
    let v2: PayoutVault = load(&svm, &vault);
    assert_eq!(v2.updates_posted, 1);
}

// ── freeze_vault helpers ──────────────────────────────────────────────────────

fn send_freeze(svm: &mut LiteSVM, ctx: &SaleCtx, vault: &Pubkey) {
    let program_id = asset_registry::id();
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::FreezeVault {}.data(),
            acc::FreezeVault { vault: *vault }.to_account_metas(None),
        )],
        "freeze_vault",
    );
}

fn try_send_freeze(svm: &mut LiteSVM, ctx: &SaleCtx, vault: &Pubkey) -> Result<(), String> {
    let program_id = asset_registry::id();
    try_send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::FreezeVault {}.data(),
            acc::FreezeVault { vault: *vault }.to_account_metas(None),
        )],
    )
}

#[test]
fn freeze_requires_three_missed() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
    buy_units(&mut svm, &ctx, 120);
    let (vault, _e) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    let v: PayoutVault = load(&svm, &vault);

    // 1 period elapsed, 0 updates → overdue 1 < 3 → freeze fails
    warp_to(&mut svm, v.start_ts + 1);
    assert!(try_send_freeze(&mut svm, &ctx, &vault).is_err());

    // 3 periods elapsed, 0 updates → overdue 3 → freeze succeeds
    warp_to(&mut svm, v.start_ts + 2 * 2_592_000 + 1);
    send_freeze(&mut svm, &ctx, &vault);
    let vf: PayoutVault = load(&svm, &vault);
    assert_eq!(vf.state, PayoutVaultState::Frozen);
}

const MONTH: i64 = 2_592_000;

/// Runs the full investor exit on a Frozen vault — vote → cast(ReturnCapital)
/// → finalize → claim_refund — and asserts the sole investor gets `expected`.
fn exit_via_return_capital(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    escrow: &Pubkey,
    weight: u64,
    expected: u64,
) {
    let root = util::snapshot_leaf(&ctx.buyer.pubkey(), weight);
    let vote_pda = open_vote(svm, ctx, vault, root, weight, 604_800);
    send_cast(
        svm,
        ctx,
        vault,
        &vote_pda,
        weight,
        vec![],
        VaultVoteChoice::ReturnCapital,
    );
    let vote: VaultVote = load(svm, &vote_pda);
    warp_to(svm, vote.end_ts + 1);
    send_finalize(svm, ctx, vault, &vote_pda);
    assert_eq!(
        load::<PayoutVault>(svm, vault).state,
        PayoutVaultState::Cancelled
    );

    let before = token_balance(svm, &ctx.buyer_payment_ata);
    send_claim_refund(
        svm,
        ctx,
        vault,
        escrow,
        &ctx.buyer_payment_ata,
        weight,
        vec![],
    );
    let after = token_balance(svm, &ctx.buyer_payment_ata);
    assert_eq!(after - before, expected, "investor refund");
}

/// FINDING A: with `num_tranches < MISSED_FREEZE_THRESHOLD` the old
/// `min(periods_elapsed, num_tranches) - updates_posted` could never reach 3,
/// so a silent founder of a 2-tranche vault was unfreezable and the principal
/// was stranded. Overdue is now measured from the oldest unfulfilled update.
#[test]
fn freeze_reachable_for_short_schedule() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 2); // 2 tranches only
    buy_units(&mut svm, &ctx, 120);
    let (vault, escrow) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    let v0: PayoutVault = load(&svm, &vault);
    assert_eq!(v0.num_tranches, 2);

    // Founder never posts. Far past the schedule → freeze must be reachable.
    warp_to(&mut svm, v0.start_ts + 120 * MONTH);
    send_freeze(&mut svm, &ctx, &vault);
    assert_eq!(
        load::<PayoutVault>(&svm, &vault).state,
        PayoutVaultState::Frozen
    );

    // …and the exit is real: investors recover the whole untouched principal.
    exit_via_return_capital(&mut svm, &ctx, &vault, &escrow, 120, v0.total_amount);
}

/// FINDING A: on ANY schedule the last `MISSED_FREEZE_THRESHOLD - 1` tranches
/// were unfreezable under the capped formula (3 tranches, 2 posted → overdue
/// could never exceed 1). Ten years of silence must now freeze the vault.
#[test]
fn freeze_reachable_for_final_tranches() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 3);
    buy_units(&mut svm, &ctx, 90);
    let (vault, escrow) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    let v0: PayoutVault = load(&svm, &vault);
    let founder_ata = ctx.founder_payment_ata;

    // Founder is a model citizen for the first two tranches…
    for i in 0..2i64 {
        warp_to(&mut svm, v0.start_ts + i * MONTH + 1);
        send_post_update(&mut svm, &ctx, &vault);
        send_release(&mut svm, &ctx, &vault, &escrow, &founder_ata);
    }
    let v2: PayoutVault = load(&svm, &vault);
    assert_eq!(v2.updates_posted, 2);
    assert_eq!(v2.tranches_released, 2);
    assert!(v2.released < v2.total_amount);

    // …then vanishes. Third update due at start + 2 months; after 10 years the
    // oldest unfulfilled obligation is ~118 months overdue.
    warp_to(&mut svm, v0.start_ts + 120 * MONTH);
    send_freeze(&mut svm, &ctx, &vault);
    assert_eq!(
        load::<PayoutVault>(&svm, &vault).state,
        PayoutVaultState::Frozen
    );

    // Remaining principal (the un-released last tranche) goes back pro-rata.
    let remaining = v2.total_amount - v2.released;
    exit_via_return_capital(&mut svm, &ctx, &vault, &escrow, 90, remaining);
}

/// Negative side of the new rule: a founder who is CURRENT (every due update
/// posted) can never be frozen, however much time passes — on a short schedule
/// and on the 12-tranche one alike — and a gap of fewer than
/// `MISSED_FREEZE_THRESHOLD` months since the oldest unfulfilled update is not
/// enough either.
#[test]
fn freeze_rejected_when_founder_current_or_gap_under_threshold() {
    // (a) all updates posted → no unfulfilled obligation → unfreezable forever.
    for vesting in [2u8, 12u8] {
        let (mut svm, _pid) = boot();
        let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, vesting);
        buy_units(&mut svm, &ctx, 120);
        let (vault, _e) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
        let v0: PayoutVault = load(&svm, &vault);
        // Everything is due once the last period has started.
        warp_to(&mut svm, v0.start_ts + (vesting as i64 - 1) * MONTH + 1);
        for _ in 0..vesting {
            send_post_update(&mut svm, &ctx, &vault);
        }
        assert_eq!(
            load::<PayoutVault>(&svm, &vault).updates_posted,
            vesting as u32
        );
        // Nothing released yet — principal is still in the vault, but the
        // founder owes no update, so there is nothing to be overdue on.
        warp_to(&mut svm, v0.start_ts + 240 * MONTH);
        let err = try_send_freeze(&mut svm, &ctx, &vault).expect_err("current founder");
        assert!(err.contains("Custom(6038)"), "got: {err}");
        assert_eq!(
            load::<PayoutVault>(&svm, &vault).state,
            PayoutVaultState::Active
        );
    }

    // (b) mid-schedule gap: 5 of 12 posted, 6th due at start + 5 months.
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
    buy_units(&mut svm, &ctx, 120);
    let (vault, _e) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    let v0: PayoutVault = load(&svm, &vault);
    warp_to(&mut svm, v0.start_ts + 4 * MONTH + 1);
    for _ in 0..5 {
        send_post_update(&mut svm, &ctx, &vault);
    }
    let due6 = v0.start_ts + 5 * MONTH;
    // Just before the 6th is due: 0 overdue.
    warp_to(&mut svm, due6 - 1);
    assert!(try_send_freeze(&mut svm, &ctx, &vault).is_err());
    // Last second of the 2nd missed period: only 2 periods overdue.
    warp_to(&mut svm, due6 + 2 * MONTH - 1);
    assert!(try_send_freeze(&mut svm, &ctx, &vault).is_err());
    // First second of the 3rd missed period → freezable (same boundary as
    // `freeze_requires_three_missed`: start + 2 months from update 0).
    warp_to(&mut svm, due6 + 2 * MONTH);
    send_freeze(&mut svm, &ctx, &vault);
    assert_eq!(
        load::<PayoutVault>(&svm, &vault).state,
        PayoutVaultState::Frozen
    );
}

// ── open_vault_vote helpers ───────────────────────────────────────────────────

fn open_vote(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    root: [u8; 32],
    total_weight: u64,
    voting_period: i64,
) -> Pubkey {
    let program_id = asset_registry::id();
    let round = load::<PayoutVault>(svm, vault).vote_round + 1;
    let vote_pda = Pubkey::find_program_address(
        &[
            asset_registry::VAULT_VOTE_SEED,
            vault.as_ref(),
            &round.to_le_bytes(),
        ],
        &program_id,
    )
    .0;
    let admin_record = Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, ctx.payer.pubkey().as_ref()],
        &asset_registry::id(),
    )
    .0;
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::OpenVaultVote {
                snapshot_root: root,
                total_weight,
                voting_period,
            }
            .data(),
            acc::OpenVaultVote {
                authority: ctx.payer.pubkey(),
                admin_record,
                vault: *vault,
                vote: vote_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "open_vault_vote",
    );
    vote_pda
}

fn try_open_vote(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    root: [u8; 32],
    total_weight: u64,
    voting_period: i64,
) -> Result<(), String> {
    let program_id = asset_registry::id();
    let round = load::<PayoutVault>(svm, vault).vote_round + 1;
    let vote_pda = Pubkey::find_program_address(
        &[
            asset_registry::VAULT_VOTE_SEED,
            vault.as_ref(),
            &round.to_le_bytes(),
        ],
        &program_id,
    )
    .0;
    let admin_record = Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, ctx.payer.pubkey().as_ref()],
        &asset_registry::id(),
    )
    .0;
    try_send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::OpenVaultVote {
                snapshot_root: root,
                total_weight,
                voting_period,
            }
            .data(),
            acc::OpenVaultVote {
                authority: ctx.payer.pubkey(),
                admin_record,
                vault: *vault,
                vote: vote_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
    )
}

#[test]
fn open_vault_vote_requires_frozen() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
    buy_units(&mut svm, &ctx, 120);
    let (vault, _e) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    let v: PayoutVault = load(&svm, &vault);
    let root = util::snapshot_leaf(&ctx.buyer.pubkey(), 120);

    // Active → fails
    assert!(try_open_vote(&mut svm, &ctx, &vault, root, 120, 604_800).is_err());

    // freeze then open
    warp_to(&mut svm, v.start_ts + 2 * 2_592_000 + 1);
    send_freeze(&mut svm, &ctx, &vault);
    let vote_pda = open_vote(&mut svm, &ctx, &vault, root, 120, 604_800);
    let vote: VaultVote = load(&svm, &vote_pda);
    assert_eq!(vote.outcome, VaultVoteOutcome::Pending);
    let vv: PayoutVault = load(&svm, &vault);
    assert_eq!(vv.total_weight, 120);
}

// ── cast_vault_vote helpers ───────────────────────────────────────────────────

fn send_cast(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    vote: &Pubkey,
    weight: u64,
    proof: Vec<[u8; 32]>,
    choice: VaultVoteChoice,
) {
    let program_id = asset_registry::id();
    let record = Pubkey::find_program_address(
        &[
            asset_registry::VAULT_VOTE_RECORD_SEED,
            vote.as_ref(),
            ctx.buyer.pubkey().as_ref(),
        ],
        &program_id,
    )
    .0;
    send(
        svm,
        &[&ctx.payer, &ctx.buyer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::CastVaultVote {
                weight,
                proof,
                choice,
            }
            .data(),
            acc::CastVaultVote {
                vault: *vault,
                voter: ctx.buyer.pubkey(),
                vote: *vote,
                record,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "cast_vault_vote",
    );
}

fn try_cast(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    vote: &Pubkey,
    weight: u64,
    proof: Vec<[u8; 32]>,
    choice: VaultVoteChoice,
) -> Result<(), String> {
    let program_id = asset_registry::id();
    let record = Pubkey::find_program_address(
        &[
            asset_registry::VAULT_VOTE_RECORD_SEED,
            vote.as_ref(),
            ctx.buyer.pubkey().as_ref(),
        ],
        &program_id,
    )
    .0;
    try_send(
        svm,
        &[&ctx.payer, &ctx.buyer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::CastVaultVote {
                weight,
                proof,
                choice,
            }
            .data(),
            acc::CastVaultVote {
                vault: *vault,
                voter: ctx.buyer.pubkey(),
                vote: *vote,
                record,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
    )
}

#[test]
fn cast_vault_vote_records_and_blocks_double() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
    buy_units(&mut svm, &ctx, 120);
    let (vault, _e) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    let v: PayoutVault = load(&svm, &vault);
    warp_to(&mut svm, v.start_ts + 2 * 2_592_000 + 1);
    send_freeze(&mut svm, &ctx, &vault);
    let root = util::snapshot_leaf(&ctx.buyer.pubkey(), 120);
    let vote_pda = open_vote(&mut svm, &ctx, &vault, root, 120, 604_800);

    // single-leaf tree: empty proof, weight 120
    send_cast(
        &mut svm,
        &ctx,
        &vault,
        &vote_pda,
        120,
        vec![],
        VaultVoteChoice::Extend,
    );
    let vote: VaultVote = load(&svm, &vote_pda);
    assert_eq!(vote.extend_weight, 120);

    // same voter votes again → record PDA already exists → fails
    assert!(try_cast(
        &mut svm,
        &ctx,
        &vault,
        &vote_pda,
        120,
        vec![],
        VaultVoteChoice::ReturnCapital
    )
    .is_err());
}

// ── finalize_vault_vote helpers ───────────────────────────────────────────────

fn send_finalize(svm: &mut LiteSVM, ctx: &SaleCtx, vault: &Pubkey, vote: &Pubkey) {
    let program_id = asset_registry::id();
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::FinalizeVaultVote {}.data(),
            acc::FinalizeVaultVote {
                vault: *vault,
                vote: *vote,
            }
            .to_account_metas(None),
        )],
        "finalize_vault_vote",
    );
}

fn try_finalize(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    vote: &Pubkey,
) -> Result<(), String> {
    let program_id = asset_registry::id();
    try_send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::FinalizeVaultVote {}.data(),
            acc::FinalizeVaultVote {
                vault: *vault,
                vote: *vote,
            }
            .to_account_metas(None),
        )],
    )
}

#[test]
fn finalize_extend_resumes_and_shifts_schedule() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
    buy_units(&mut svm, &ctx, 120);
    let (vault, _e) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    let v0: PayoutVault = load(&svm, &vault);
    warp_to(&mut svm, v0.start_ts + 2 * 2_592_000 + 1);
    send_freeze(&mut svm, &ctx, &vault);
    let root = util::snapshot_leaf(&ctx.buyer.pubkey(), 120);
    let vote_pda = open_vote(&mut svm, &ctx, &vault, root, 120, 604_800);
    send_cast(
        &mut svm,
        &ctx,
        &vault,
        &vote_pda,
        120,
        vec![],
        VaultVoteChoice::Extend,
    );

    // before end_ts → fails
    assert!(try_finalize(&mut svm, &ctx, &vault, &vote_pda).is_err());
    let vote: VaultVote = load(&svm, &vote_pda);
    warp_to(&mut svm, vote.end_ts + 1);
    send_finalize(&mut svm, &ctx, &vault, &vote_pda);

    let vf: PayoutVault = load(&svm, &vault);
    assert_eq!(vf.state, PayoutVaultState::Active);
    assert!(vf.start_ts > v0.start_ts); // schedule shifted forward
}

/// Runs one Extend round on a Frozen vault (open_vote → cast(Extend) →
/// finalize) and returns the vault as left by finalize.
fn extend_round(svm: &mut LiteSVM, ctx: &SaleCtx, vault: &Pubkey, weight: u64) -> PayoutVault {
    let root = util::snapshot_leaf(&ctx.buyer.pubkey(), weight);
    let vote_pda = open_vote(svm, ctx, vault, root, weight, 604_800);
    send_cast(
        svm,
        ctx,
        vault,
        &vote_pda,
        weight,
        vec![],
        VaultVoteChoice::Extend,
    );
    let vote: VaultVote = load(svm, &vote_pda);
    warp_to(svm, vote.end_ts + 1);
    send_finalize(svm, ctx, vault, &vote_pda);
    load(svm, vault)
}

/// After an Extend the vault must NOT be re-freezable in the very next
/// transaction: the shift has to use the same uncapped overdue measure as
/// `freeze_vault` (both are permissionless, so a smaller shift would let a
/// griefer bundle finalize + freeze and keep the vault Frozen through every
/// Extend round). Asserts that `now < start_ts' + updates_posted * MONTH`
/// (zero overdue), that the founder can actually resume from the new
/// schedule, and — as a control — that the in-schedule 12-tranche case keeps
/// the historical 3-month shift.
#[test]
fn extend_shift_matches_freeze_rule_so_vault_is_not_immediately_refreezable() {
    // (i) 2-tranche vault, founder silent, frozen 10 years past schedule end.
    {
        let (mut svm, _pid) = boot();
        let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 2);
        buy_units(&mut svm, &ctx, 120);
        let (vault, escrow) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
        let v0: PayoutVault = load(&svm, &vault);
        warp_to(&mut svm, v0.start_ts + 120 * MONTH);
        send_freeze(&mut svm, &ctx, &vault);

        let vf = extend_round(&mut svm, &ctx, &vault, 120);
        assert_eq!(vf.state, PayoutVaultState::Active);
        let now = svm.get_sysvar::<Clock>().unix_timestamp;
        // Finalize ran ~7 days after the freeze, still inside period 121 of the
        // original schedule → oldest (0th) update was 121 periods overdue.
        assert_eq!(vf.start_ts, v0.start_ts + 121 * MONTH, "shift = overdue");
        assert!(now < vf.start_ts + (vf.updates_posted as i64) * MONTH);

        // Immediate re-freeze in the next transaction must fail (UpdateRequired).
        let err = try_send_freeze(&mut svm, &ctx, &vault).expect_err("re-freeze");
        assert!(err.contains("Custom(6038)"), "got: {err}");
        assert_eq!(
            load::<PayoutVault>(&svm, &vault).state,
            PayoutVaultState::Active
        );
        // Still not freezable 2 months into the new schedule (2 overdue)…
        warp_to(&mut svm, vf.start_ts + 2 * MONTH - 1);
        assert!(try_send_freeze(&mut svm, &ctx, &vault).is_err());
        // …and the founder can resume from the new schedule.
        warp_to(&mut svm, vf.start_ts + 1);
        send_post_update(&mut svm, &ctx, &vault);
        send_release(&mut svm, &ctx, &vault, &escrow, &ctx.founder_payment_ata);
        let v1: PayoutVault = load(&svm, &vault);
        assert_eq!(v1.updates_posted, 1);
        assert_eq!(v1.tranches_released, 1);
    }

    // (ii) 12-tranche, 10 updates posted, frozen at start + 14 months — only
    // freezable under the uncapped rule (capped: min(15,12) - 10 = 2 < 3).
    {
        let (mut svm, _pid) = boot();
        let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
        buy_units(&mut svm, &ctx, 120);
        let (vault, _e) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
        let v0: PayoutVault = load(&svm, &vault);
        warp_to(&mut svm, v0.start_ts + 9 * MONTH + 1);
        for _ in 0..10 {
            send_post_update(&mut svm, &ctx, &vault);
        }
        warp_to(&mut svm, v0.start_ts + 14 * MONTH);
        send_freeze(&mut svm, &ctx, &vault);

        let vf = extend_round(&mut svm, &ctx, &vault, 120);
        assert_eq!(vf.state, PayoutVaultState::Active);
        assert_eq!(vf.updates_posted, 10);
        let now = svm.get_sysvar::<Clock>().unix_timestamp;
        // 11th update was due at start + 10M; at start + 14M (+7d) that is 5
        // periods overdue → shift 5 months (the capped formula gave 2).
        assert_eq!(vf.start_ts, v0.start_ts + 5 * MONTH, "shift = overdue");
        assert!(now < vf.start_ts + 10 * MONTH);

        let err = try_send_freeze(&mut svm, &ctx, &vault).expect_err("re-freeze");
        assert!(err.contains("Custom(6038)"), "got: {err}");
        assert_eq!(
            load::<PayoutVault>(&svm, &vault).state,
            PayoutVaultState::Active
        );
        // Founder resumes with the 11th update once its new period starts.
        warp_to(&mut svm, vf.start_ts + 10 * MONTH);
        send_post_update(&mut svm, &ctx, &vault);
        assert_eq!(load::<PayoutVault>(&svm, &vault).updates_posted, 11);
    }

    // (iii) Control: in-schedule 12-tranche freeze at start + 2M + 1 — the
    // historical case — still shifts by exactly 3 months and is likewise not
    // re-freezable.
    {
        let (mut svm, _pid) = boot();
        let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
        buy_units(&mut svm, &ctx, 120);
        let (vault, _e) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
        let v0: PayoutVault = load(&svm, &vault);
        warp_to(&mut svm, v0.start_ts + 2 * MONTH + 1);
        send_freeze(&mut svm, &ctx, &vault);

        let vf = extend_round(&mut svm, &ctx, &vault, 120);
        assert_eq!(vf.state, PayoutVaultState::Active);
        assert_eq!(vf.start_ts, v0.start_ts + 3 * MONTH, "historical shift");
        let err = try_send_freeze(&mut svm, &ctx, &vault).expect_err("re-freeze");
        assert!(err.contains("Custom(6038)"), "got: {err}");
    }
}

#[test]
fn finalize_return_capital_cancels() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
    buy_units(&mut svm, &ctx, 120);
    let (vault, _e) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    let v0: PayoutVault = load(&svm, &vault);
    warp_to(&mut svm, v0.start_ts + 2 * 2_592_000 + 1);
    send_freeze(&mut svm, &ctx, &vault);
    let root = util::snapshot_leaf(&ctx.buyer.pubkey(), 120);
    let vote_pda = open_vote(&mut svm, &ctx, &vault, root, 120, 604_800);
    send_cast(
        &mut svm,
        &ctx,
        &vault,
        &vote_pda,
        120,
        vec![],
        VaultVoteChoice::ReturnCapital,
    );
    let vote: VaultVote = load(&svm, &vote_pda);
    warp_to(&mut svm, vote.end_ts + 1);
    send_finalize(&mut svm, &ctx, &vault, &vote_pda);
    let vf: PayoutVault = load(&svm, &vault);
    assert_eq!(vf.state, PayoutVaultState::Cancelled);
}

// ── claim_refund helpers ──────────────────────────────────────────────────────

fn send_claim_refund(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    escrow: &Pubkey,
    investor_ata: &Pubkey,
    weight: u64,
    proof: Vec<[u8; 32]>,
) {
    let program_id = asset_registry::id();
    let round = load::<PayoutVault>(svm, vault).vote_round;
    let vote = Pubkey::find_program_address(
        &[
            asset_registry::VAULT_VOTE_SEED,
            vault.as_ref(),
            &round.to_le_bytes(),
        ],
        &program_id,
    )
    .0;
    let claim = Pubkey::find_program_address(
        &[
            asset_registry::PAYOUT_CLAIM_SEED,
            vault.as_ref(),
            &[0u8], // ClaimKind::Refund
            ctx.buyer.pubkey().as_ref(),
        ],
        &program_id,
    )
    .0;
    send(
        svm,
        &[&ctx.payer, &ctx.buyer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::ClaimRefund { weight, proof }.data(),
            acc::ClaimRefund {
                investor: ctx.buyer.pubkey(),
                vault: *vault,
                vote,
                claim,
                escrow: *escrow,
                payment_mint: ctx.payment_mint,
                investor_account: *investor_ata,
                payment_token_program: TOKEN_2022,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "claim_refund",
    );
}

fn try_claim_refund(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    escrow: &Pubkey,
    investor_ata: &Pubkey,
    weight: u64,
    proof: Vec<[u8; 32]>,
) -> Result<(), String> {
    let program_id = asset_registry::id();
    let round = load::<PayoutVault>(svm, vault).vote_round;
    let vote = Pubkey::find_program_address(
        &[
            asset_registry::VAULT_VOTE_SEED,
            vault.as_ref(),
            &round.to_le_bytes(),
        ],
        &program_id,
    )
    .0;
    let claim = Pubkey::find_program_address(
        &[
            asset_registry::PAYOUT_CLAIM_SEED,
            vault.as_ref(),
            &[0u8], // ClaimKind::Refund
            ctx.buyer.pubkey().as_ref(),
        ],
        &program_id,
    )
    .0;
    try_send(
        svm,
        &[&ctx.payer, &ctx.buyer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::ClaimRefund { weight, proof }.data(),
            acc::ClaimRefund {
                investor: ctx.buyer.pubkey(),
                vault: *vault,
                vote,
                claim,
                escrow: *escrow,
                payment_mint: ctx.payment_mint,
                investor_account: *investor_ata,
                payment_token_program: TOKEN_2022,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
    )
}

#[test]
fn claim_refund_pro_rata_after_cancel() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
    buy_units(&mut svm, &ctx, 120);
    let (vault, escrow) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    let v0: PayoutVault = load(&svm, &vault);
    warp_to(&mut svm, v0.start_ts + 2 * 2_592_000 + 1);
    send_freeze(&mut svm, &ctx, &vault);
    let root = util::snapshot_leaf(&ctx.buyer.pubkey(), 120);
    let vote_pda = open_vote(&mut svm, &ctx, &vault, root, 120, 604_800);
    send_cast(
        &mut svm,
        &ctx,
        &vault,
        &vote_pda,
        120,
        vec![],
        VaultVoteChoice::ReturnCapital,
    );
    let vote: VaultVote = load(&svm, &vote_pda);
    warp_to(&mut svm, vote.end_ts + 1);
    send_finalize(&mut svm, &ctx, &vault, &vote_pda);

    // sole investor (weight 120 == total_weight) reclaims the full remaining principal
    let before = token_balance(&svm, &ctx.buyer_payment_ata);
    send_claim_refund(
        &mut svm,
        &ctx,
        &vault,
        &escrow,
        &ctx.buyer_payment_ata,
        120,
        vec![],
    );
    let after = token_balance(&svm, &ctx.buyer_payment_ata);
    assert_eq!(after - before, v0.total_amount); // nothing was released pre-cancel

    // second claim → nothing left to draw → fails
    assert!(try_claim_refund(
        &mut svm,
        &ctx,
        &vault,
        &escrow,
        &ctx.buyer_payment_ata,
        120,
        vec![]
    )
    .is_err());
}

// ── route_yield helpers ───────────────────────────────────────────────────────

fn send_route_yield(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    escrow: &Pubkey,
    amount: u64,
    investor_root: [u8; 32],
    total_weight: u64,
) {
    let program_id = asset_registry::id();
    let admin_record = Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, ctx.payer.pubkey().as_ref()],
        &program_id,
    )
    .0;
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::RouteYield {
                amount,
                investor_root,
                total_weight,
            }
            .data(),
            acc::RouteYield {
                platform: Pubkey::find_program_address(
                    &[asset_registry::PLATFORM_SEED],
                    &asset_registry::ID,
                )
                .0,
                authority: ctx.payer.pubkey(),
                admin_record,
                vault: *vault,
                source: ctx.founder_payment_ata,
                escrow: *escrow,
                platform_treasury: ctx.platform_ata,
                payment_mint: ctx.payment_mint,
                payment_token_program: TOKEN_2022,
            }
            .to_account_metas(None),
        )],
        "route_yield",
    );
}

#[test]
fn route_yield_splits_three_ways() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
    buy_units(&mut svm, &ctx, 120);
    let (vault, escrow) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);

    // fund the admin's source ATA (founder_payment_ata is payer-owned)
    mint_to(
        &mut svm,
        &ctx.payer,
        &ctx.payment_mint,
        &ctx.founder_payment_ata,
        300,
    );
    let root = util::snapshot_leaf(&ctx.buyer.pubkey(), 120);

    let plat_before = token_balance(&svm, &ctx.platform_ata);
    let escrow_before = token_balance(&svm, &escrow);
    send_route_yield(&mut svm, &ctx, &vault, &escrow, 300, root, 120);

    let v: PayoutVault = load(&svm, &vault);
    assert_eq!(v.founder_yield_claimable, 100);
    assert_eq!(v.investor_yield_pool, 100);
    assert_eq!(v.investor_yield_root, root);
    assert_eq!(v.total_weight, 120);
    assert_eq!(token_balance(&svm, &ctx.platform_ata) - plat_before, 100); // platform paid immediately
    assert_eq!(token_balance(&svm, &escrow) - escrow_before, 200); // founder+investor stay in escrow
}

// ── claim_founder_yield helpers ───────────────────────────────────────────────

fn send_claim_founder_yield(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    escrow: &Pubkey,
    founder_ata: &Pubkey,
) {
    let program_id = asset_registry::id();
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::ClaimFounderYield {}.data(),
            acc::ClaimFounderYield {
                founder: ctx.payer.pubkey(),
                vault: *vault,
                escrow: *escrow,
                payment_mint: ctx.payment_mint,
                founder_account: *founder_ata,
                payment_token_program: TOKEN_2022,
            }
            .to_account_metas(None),
        )],
        "claim_founder_yield",
    );
}

fn try_send_claim_founder_yield(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    escrow: &Pubkey,
    founder_ata: &Pubkey,
) -> Result<(), String> {
    let program_id = asset_registry::id();
    try_send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::ClaimFounderYield {}.data(),
            acc::ClaimFounderYield {
                founder: ctx.payer.pubkey(),
                vault: *vault,
                escrow: *escrow,
                payment_mint: ctx.payment_mint,
                founder_account: *founder_ata,
                payment_token_program: TOKEN_2022,
            }
            .to_account_metas(None),
        )],
    )
}

#[test]
fn claim_founder_yield_withdraws_and_resets() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
    buy_units(&mut svm, &ctx, 120);
    let (vault, escrow) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    mint_to(
        &mut svm,
        &ctx.payer,
        &ctx.payment_mint,
        &ctx.founder_payment_ata,
        300,
    );
    let root = util::snapshot_leaf(&ctx.buyer.pubkey(), 120);
    send_route_yield(&mut svm, &ctx, &vault, &escrow, 300, root, 120);

    let before = token_balance(&svm, &ctx.founder_payment_ata);
    send_claim_founder_yield(&mut svm, &ctx, &vault, &escrow, &ctx.founder_payment_ata);
    assert_eq!(token_balance(&svm, &ctx.founder_payment_ata) - before, 100);
    let v: PayoutVault = load(&svm, &vault);
    assert_eq!(v.founder_yield_claimable, 0);

    // second claim → nothing to claim
    assert!(try_send_claim_founder_yield(
        &mut svm,
        &ctx,
        &vault,
        &escrow,
        &ctx.founder_payment_ata
    )
    .is_err());
}

// ── claim_investor_yield helpers ──────────────────────────────────────────────

fn send_claim_investor_yield(
    svm: &mut LiteSVM,
    ctx: &SaleCtx,
    vault: &Pubkey,
    escrow: &Pubkey,
    investor_ata: &Pubkey,
    weight: u64,
    proof: Vec<[u8; 32]>,
) {
    let program_id = asset_registry::id();
    let claim = Pubkey::find_program_address(
        &[
            asset_registry::PAYOUT_CLAIM_SEED,
            vault.as_ref(),
            &[1u8], // ClaimKind::InvestorYield
            ctx.buyer.pubkey().as_ref(),
        ],
        &program_id,
    )
    .0;
    send(
        svm,
        &[&ctx.payer, &ctx.buyer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::ClaimInvestorYield { weight, proof }.data(),
            acc::ClaimInvestorYield {
                investor: ctx.buyer.pubkey(),
                vault: *vault,
                claim,
                escrow: *escrow,
                payment_mint: ctx.payment_mint,
                investor_account: *investor_ata,
                payment_token_program: TOKEN_2022,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "claim_investor_yield",
    );
}

#[test]
fn claim_investor_yield_cumulative() {
    let (mut svm, _pid) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
    buy_units(&mut svm, &ctx, 120);
    let (vault, escrow) = open_payout_vault(&mut svm, &ctx, [7u8; 32]);
    mint_to(
        &mut svm,
        &ctx.payer,
        &ctx.payment_mint,
        &ctx.founder_payment_ata,
        600,
    );
    let root = util::snapshot_leaf(&ctx.buyer.pubkey(), 120);

    // first route: investor_pool = 100
    send_route_yield(&mut svm, &ctx, &vault, &escrow, 300, root, 120);
    let b0 = token_balance(&svm, &ctx.buyer_payment_ata);
    send_claim_investor_yield(
        &mut svm,
        &ctx,
        &vault,
        &escrow,
        &ctx.buyer_payment_ata,
        120,
        vec![],
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_payment_ata) - b0, 100);

    // second route: pool = 200 → re-claim draws another 100
    send_route_yield(&mut svm, &ctx, &vault, &escrow, 300, root, 120);
    let b1 = token_balance(&svm, &ctx.buyer_payment_ata);
    send_claim_investor_yield(
        &mut svm,
        &ctx,
        &vault,
        &escrow,
        &ctx.buyer_payment_ata,
        120,
        vec![],
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_payment_ata) - b1, 100);
}

#[test]
fn repeated_freeze_uses_new_vote_round_and_old_outcomes_cannot_finalize_or_refund() {
    let (mut svm, _) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
    buy_units(&mut svm, &ctx, 120);
    let (vault, escrow) = open_payout_vault(&mut svm, &ctx, [8u8; 32]);
    let first_start = load::<PayoutVault>(&svm, &vault).start_ts;
    let root = util::snapshot_leaf(&ctx.buyer.pubkey(), 120);
    warp_to(&mut svm, first_start + 2 * 2_592_000 + 1);
    send_freeze(&mut svm, &ctx, &vault);
    let first = open_vote(&mut svm, &ctx, &vault, root, 120, 100);
    let err = try_open_vote(&mut svm, &ctx, &vault, root, 120, 101).unwrap_err();
    assert!(
        err.contains("VaultVoteAlreadyOpen"),
        "only one pending round: {err}"
    );
    send_cast(
        &mut svm,
        &ctx,
        &vault,
        &first,
        120,
        vec![],
        VaultVoteChoice::Extend,
    );
    let end = load::<VaultVote>(&svm, &first).end_ts;
    warp_to(&mut svm, end);
    send_finalize(&mut svm, &ctx, &vault, &first);
    let after_first: PayoutVault = load(&svm, &vault);
    assert_eq!(after_first.vote_round, 1);
    assert!(!after_first.vote_pending);
    svm.expire_blockhash();
    assert!(try_finalize(&mut svm, &ctx, &vault, &first).is_err());

    warp_to(&mut svm, after_first.start_ts + 2 * 2_592_000 + 1);
    send_freeze(&mut svm, &ctx, &vault);
    let before = load::<PayoutVault>(&svm, &vault).start_ts;
    svm.expire_blockhash();
    assert!(try_finalize(&mut svm, &ctx, &vault, &first).is_err());
    assert_eq!(load::<PayoutVault>(&svm, &vault).start_ts, before);
    let second = open_vote(&mut svm, &ctx, &vault, root, 120, 100);
    assert_ne!(first, second);
    assert_eq!(load::<VaultVote>(&svm, &second).round, 2);
    svm.expire_blockhash();
    assert!(try_finalize(&mut svm, &ctx, &vault, &first).is_err());
    // Same investor can vote in the new round; its record is bound to this vote.
    send_cast(
        &mut svm,
        &ctx,
        &vault,
        &second,
        120,
        vec![],
        VaultVoteChoice::ReturnCapital,
    );
    let end = load::<VaultVote>(&svm, &second).end_ts;
    warp_to(&mut svm, end);
    send_finalize(&mut svm, &ctx, &vault, &second);
    assert_eq!(
        load::<PayoutVault>(&svm, &vault).state,
        PayoutVaultState::Cancelled
    );
    let investor_ata = ctx.buyer_payment_ata;
    let claim = Pubkey::find_program_address(
        &[
            asset_registry::PAYOUT_CLAIM_SEED,
            vault.as_ref(),
            &[0],
            ctx.buyer.pubkey().as_ref(),
        ],
        &asset_registry::ID,
    )
    .0;
    let stale_refund = Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::ClaimRefund {
            weight: 120,
            proof: vec![],
        }
        .data(),
        acc::ClaimRefund {
            investor: ctx.buyer.pubkey(),
            vault,
            vote: first,
            claim,
            escrow,
            payment_mint: ctx.payment_mint,
            investor_account: investor_ata,
            payment_token_program: TOKEN_2022,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let err = try_send(&mut svm, &[&ctx.buyer], &[stale_refund]).unwrap_err();
    assert!(
        err.contains("InvalidVaultVoteRound"),
        "refund must use terminal round: {err}"
    );
    send_claim_refund(&mut svm, &ctx, &vault, &escrow, &investor_ata, 120, vec![]);
    svm.expire_blockhash();
    assert!(try_claim_refund(&mut svm, &ctx, &vault, &escrow, &investor_ata, 120, vec![]).is_err());
}

#[test]
fn original_v1_terminal_payout_and_vote_keep_refund_entitlement_after_size_only_preparation() {
    use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator, Space};
    use asset_registry::legacy::{LegacyPayoutVault, LegacyVaultVote};
    let (mut svm, _) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
    buy_units(&mut svm, &ctx, 120);
    let (vault, escrow) = open_payout_vault(&mut svm, &ctx, [7; 32]);
    let initial: PayoutVault = load(&svm, &vault);
    warp_to(&mut svm, initial.start_ts + 2 * 2_592_000 + 1);
    send_freeze(&mut svm, &ctx, &vault);
    let root = util::snapshot_leaf(&ctx.buyer.pubkey(), 120);
    let vote = open_vote(&mut svm, &ctx, &vault, root, 120, 604_800);
    send_cast(
        &mut svm,
        &ctx,
        &vault,
        &vote,
        120,
        vec![],
        VaultVoteChoice::ReturnCapital,
    );
    let vote_state: VaultVote = load(&svm, &vote);
    warp_to(&mut svm, vote_state.end_ts + 1);
    send_finalize(&mut svm, &ctx, &vault, &vote);
    let mut vault_account = svm.get_account(&vault).unwrap();
    let mut legacy_vault = LegacyPayoutVault::deserialize(&mut &vault_account.data[8..]).unwrap();
    legacy_vault.version = 1;
    let mut original_vault = PayoutVault::DISCRIMINATOR.to_vec();
    legacy_vault.serialize(&mut original_vault).unwrap();
    assert_eq!(original_vault.len(), 8 + LegacyPayoutVault::INIT_SPACE);
    vault_account.data = original_vault.clone();
    vault_account.lamports = svm.minimum_balance_for_rent_exemption(original_vault.len());
    svm.set_account(vault, vault_account).unwrap();
    let mut vote_account = svm.get_account(&vote).unwrap();
    let mut legacy_vote = LegacyVaultVote::deserialize(&mut &vote_account.data[8..]).unwrap();
    let (old_vote, old_bump) = Pubkey::find_program_address(
        &[asset_registry::VAULT_VOTE_SEED, vault.as_ref()],
        &asset_registry::ID,
    );
    legacy_vote.version = 1;
    legacy_vote.bump = old_bump;
    let mut original_vote = VaultVote::DISCRIMINATOR.to_vec();
    legacy_vote.serialize(&mut original_vote).unwrap();
    assert_eq!(original_vote.len(), 8 + LegacyVaultVote::INIT_SPACE);
    vote_account.data = original_vote.clone();
    vote_account.lamports = svm.minimum_balance_for_rent_exemption(original_vote.len());
    svm.set_account(old_vote, vote_account).unwrap();
    let claim = Pubkey::find_program_address(
        &[
            asset_registry::PAYOUT_CLAIM_SEED,
            vault.as_ref(),
            &[0],
            ctx.buyer.pubkey().as_ref(),
        ],
        &asset_registry::ID,
    )
    .0;
    let refund = Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::ClaimRefund {
            weight: 120,
            proof: vec![],
        }
        .data(),
        acc::ClaimRefund {
            investor: ctx.buyer.pubkey(),
            vault,
            vote: old_vote,
            claim,
            escrow,
            payment_mint: ctx.payment_mint,
            investor_account: ctx.buyer_payment_ata,
            payment_token_program: TOKEN_2022,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(
        try_send(&mut svm, &[&ctx.buyer], std::slice::from_ref(&refund))
            .unwrap_err()
            .contains("AccountDidNotDeserialize")
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[
            prepare_legacy_ix(ctx.buyer.pubkey(), vault),
            prepare_legacy_ix(ctx.buyer.pubkey(), old_vote),
        ],
        "prepare original fixed-size v1 allocations",
    );
    assert_eq!(
        &svm.get_account(&vault).unwrap().data[..original_vault.len()],
        original_vault.as_slice()
    );
    assert_eq!(
        &svm.get_account(&old_vote).unwrap().data[..original_vote.len()],
        original_vote.as_slice()
    );
    assert_eq!(load::<PayoutVault>(&svm, &vault).version, 1);
    assert_eq!(load::<VaultVote>(&svm, &old_vote).version, 1);
    let before = token_balance(&svm, &ctx.buyer_payment_ata);
    send(
        &mut svm,
        &[&ctx.buyer],
        std::slice::from_ref(&refund),
        "legacy terminal claim preserves original PDA and entitlement",
    );
    assert_eq!(
        token_balance(&svm, &ctx.buyer_payment_ata) - before,
        initial.total_amount
    );
    svm.expire_blockhash();
    assert!(try_send(&mut svm, &[&ctx.buyer], &[refund])
        .unwrap_err()
        .contains("AlreadyClaimed"));
}

#[test]
fn yield_rejects_redirected_treasury_and_zero_root_before_moving_funds() {
    let (mut svm, _) = boot();
    let ctx = setup_sale(&mut svm, RaiseType::Startup, 0, 12);
    buy_units(&mut svm, &ctx, 120);
    let (vault, escrow) = open_payout_vault(&mut svm, &ctx, [7; 32]);
    mint_to(
        &mut svm,
        &ctx.payer,
        &ctx.payment_mint,
        &ctx.founder_payment_ata,
        300,
    );
    let make_ix = |treasury, root| {
        Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::RouteYield {
                amount: 300,
                investor_root: root,
                total_weight: 120,
            }
            .data(),
            acc::RouteYield {
                authority: ctx.payer.pubkey(),
                admin_record: Pubkey::find_program_address(
                    &[asset_registry::ADMIN_SEED, ctx.payer.pubkey().as_ref()],
                    &asset_registry::ID,
                )
                .0,
                vault,
                source: ctx.founder_payment_ata,
                escrow,
                platform_treasury: treasury,
                payment_mint: ctx.payment_mint,
                payment_token_program: TOKEN_2022,
                platform: Pubkey::find_program_address(
                    &[asset_registry::PLATFORM_SEED],
                    &asset_registry::ID,
                )
                .0,
            }
            .to_account_metas(None),
        )
    };
    let source_before = token_balance(&svm, &ctx.founder_payment_ata);
    let escrow_before = token_balance(&svm, &escrow);
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[make_ix(
            ctx.buyer_payment_ata,
            util::snapshot_leaf(&ctx.buyer.pubkey(), 120)
        )]
    )
    .unwrap_err()
    .contains("Unauthorized"));
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[make_ix(ctx.platform_ata, [0; 32])]
    )
    .unwrap_err()
    .contains("InvalidRaiseParams"));
    assert_eq!(token_balance(&svm, &ctx.founder_payment_ata), source_before);
    assert_eq!(token_balance(&svm, &escrow), escrow_before);
    assert_eq!(
        load::<PayoutVault>(&svm, &vault).investor_yield_root,
        [0; 32]
    );
}

pub fn prepare_legacy_ix(payer: Pubkey, legacy_account: Pubkey) -> Instruction {
    use anchor_lang::{InstructionData, ToAccountMetas};
    Instruction::new_with_bytes(
        asset_registry::ID,
        &asset_registry::instruction::PrepareLegacyAccount {}.data(),
        asset_registry::accounts::PrepareLegacyAccount {
            payer,
            legacy_account,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    )
}
