//! Push-based pro-rata revenue distribution (`create_distribution` /
//! `distribute_batch` / `close_distribution`) — LiteSVM e2e tests.
//! business-doc §2–§5: the issuer funds the escrow in one go; the pro-rata
//! per holder is computed off-chain from a holder snapshot; the program
//! executes and records the payouts.
//!
//! Boot mirrors test_otc_deal.rs minus the transfer-hook setup — the payment
//! token is hook-less, so no share-mint transfers ever run.

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
    asset_registry::{
        accounts as acc, instruction as ixd, AssetType, Distribution, DistributionStatus,
        JurisdictionRules, ShareClassType, RIGHT_DIVIDEND, RIGHT_LIQ_PREF, RIGHT_VOTE,
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

const TOTAL_AMOUNT: u64 = 1_000_000;
const SNAPSHOT_SUPPLY: u64 = 100;
const FUNDER_BALANCE: u64 = 10_000_000;

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

fn token_balance(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    let a = svm.get_account(ata).expect("ata missing");
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
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
    payment_mint: Pubkey,
    /// Funds the distributions; holds `FUNDER_BALANCE` payment units.
    funder: Keypair,
    funder_payment_ata: Pubkey,
}

/// Boots the full stack: platform → issuer → asset → share class → mint,
/// plus a payment mint and a funded funder account.
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
    let funder = Keypair::new();
    svm.airdrop(&funder.pubkey(), 100_000_000_000).unwrap();

    let legal_entity_id: [u8; 32] = *b"REVENUE-DIST-ENTITY-000000000001";
    let asset_id = "dist-pilot-001";
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
                asset_type: AssetType::RevenueShare,
                name: "Distribution Pilot".to_string(),
                symbol_prefix: "DIST".to_string(),
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
                class_type: ShareClassType::RevShareTier,
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

    // activate_asset — keeps the setup consistent with the asset lifecycle
    send(
        &mut svm,
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

    // ── payment mint + funded funder ─────────────────────────────────────────
    let payment_mint = create_mint(&mut svm, &payer, 6);
    let funder_payment_ata = create_ata(&mut svm, &payer, &payment_mint, &funder.pubkey());
    let mint_ix = token_ix::mint_to(
        &TOKEN_2022,
        &payment_mint,
        &funder_payment_ata,
        &payer.pubkey(),
        &[],
        FUNDER_BALANCE,
    )
    .unwrap();
    send(&mut svm, &[&payer], &[mint_ix], "mint payment to funder");

    let ctx = Ctx {
        program_id,
        payer,
        admin_pda,
        issuer_pda,
        asset_pda,
        share_class_pda,
        mint_pda,
        payment_mint,
        funder,
        funder_payment_ata,
    };
    (svm, ctx)
}

// ── Distribution helpers ─────────────────────────────────────────────────────

/// The `EscrowMarker` PDA for an escrow-authority PDA.
fn escrow_marker_of(ctx: &Ctx, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::ESCROW_MARKER_SEED, owner.as_ref()],
        &ctx.program_id,
    )
    .0
}

fn distribution_pdas(ctx: &Ctx, distribution_id: u64) -> (Pubkey, Pubkey) {
    let (distribution_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::DISTRIBUTION_SEED,
            ctx.share_class_pda.as_ref(),
            &distribution_id.to_le_bytes(),
        ],
        &ctx.program_id,
    );
    let (escrow_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::DISTRIBUTION_ESCROW_SEED,
            distribution_pda.as_ref(),
        ],
        &ctx.program_id,
    );
    (distribution_pda, escrow_pda)
}

fn admin_record_of(ctx: &Ctx, authority: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, authority.as_ref()],
        &ctx.program_id,
    )
    .0
}

fn create_distribution_ix(
    ctx: &Ctx,
    authority: &Pubkey,
    funder: &Pubkey,
    distribution_id: u64,
    total_amount: u64,
) -> Instruction {
    create_distribution_with_plan_ix(
        ctx,
        authority,
        funder,
        distribution_id,
        total_amount,
        [1; 32],
        1,
    )
}

fn create_distribution_with_plan_ix(
    ctx: &Ctx,
    authority: &Pubkey,
    funder: &Pubkey,
    distribution_id: u64,
    total_amount: u64,
    batch_root: [u8; 32],
    batch_count: u32,
) -> Instruction {
    let (distribution_pda, escrow_pda) = distribution_pdas(ctx, distribution_id);
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::CreateDistribution {
            distribution_id,
            total_amount,
            snapshot_supply: SNAPSHOT_SUPPLY,
            batch_root,
            batch_count,
        }
        .data(),
        acc::CreateDistribution {
            plan: plan_address(distribution_pda),
            authority: *authority,
            admin_record: admin_record_of(ctx, authority),
            share_class: ctx.share_class_pda,
            mint: ctx.mint_pda,
            payment_mint: ctx.payment_mint,
            distribution: distribution_pda,
            escrow: escrow_pda,
            escrow_marker: escrow_marker_of(ctx, &distribution_pda),
            funder: *funder,
            funder_payment_account: ctx.funder_payment_ata,
            payment_token_program: TOKEN_2022,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn distribute_batch_ix(
    ctx: &Ctx,
    authority: &Pubkey,
    distribution_id: u64,
    amounts: Vec<u64>,
    recipients: &[Pubkey],
) -> Instruction {
    distribute_batch_proven_ix(
        ctx,
        authority,
        distribution_id,
        0,
        amounts,
        recipients,
        vec![],
    )
}

fn distribute_batch_proven_ix(
    ctx: &Ctx,
    authority: &Pubkey,
    distribution_id: u64,
    batch_id: u32,
    amounts: Vec<u64>,
    recipients: &[Pubkey],
    proof: Vec<[u8; 32]>,
) -> Instruction {
    let (distribution_pda, escrow_pda) = distribution_pdas(ctx, distribution_id);
    let mut metas = acc::DistributeBatch {
        plan: plan_address(distribution_pda),
        batch: Pubkey::find_program_address(
            &[
                asset_registry::DISTRIBUTION_BATCH_SEED,
                distribution_pda.as_ref(),
                &batch_id.to_le_bytes(),
            ],
            &ctx.program_id,
        )
        .0,
        system_program: system_program::ID,
        authority: *authority,
        admin_record: admin_record_of(ctx, authority),
        distribution: distribution_pda,
        payment_mint: ctx.payment_mint,
        escrow: escrow_pda,
        payment_token_program: TOKEN_2022,
    }
    .to_account_metas(None);
    for r in recipients {
        metas.push(AccountMeta::new(*r, false));
    }
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::DistributeBatch {
            distribution_id,
            batch_id,
            amounts,
            proof,
        }
        .data(),
        metas,
    )
}

fn close_distribution_ix(
    ctx: &Ctx,
    authority: &Pubkey,
    distribution_id: u64,
    refund_account: &Pubkey,
    escrow_rent_recipient: &Pubkey,
) -> Instruction {
    let (distribution_pda, escrow_pda) = distribution_pdas(ctx, distribution_id);
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::CloseDistribution {}.data(),
        acc::CloseDistribution {
            authority: *authority,
            admin_record: admin_record_of(ctx, authority),
            distribution: distribution_pda,
            payment_mint: ctx.payment_mint,
            escrow: escrow_pda,
            refund_account: *refund_account,
            escrow_rent_recipient: *escrow_rent_recipient,
            escrow_marker: escrow_marker_of(ctx, &distribution_pda),
            payment_token_program: TOKEN_2022,
        }
        .to_account_metas(None),
    )
}

/// Creates a distribution as the admin, funded by the funder.
fn setup_distribution(svm: &mut LiteSVM, ctx: &Ctx, distribution_id: u64) -> (Pubkey, Pubkey) {
    let pdas = distribution_pdas(ctx, distribution_id);
    send(
        svm,
        &[&ctx.payer, &ctx.funder],
        &[create_distribution_ix(
            ctx,
            &ctx.payer.pubkey(),
            &ctx.funder.pubkey(),
            distribution_id,
            TOTAL_AMOUNT,
        )],
        "create_distribution",
    );
    pdas
}

/// Creates `n` recipient payment ATAs owned by fresh keypairs.
fn recipients(svm: &mut LiteSVM, ctx: &Ctx, n: usize) -> Vec<Pubkey> {
    (0..n)
        .map(|_| {
            let holder = Keypair::new();
            create_ata(svm, &ctx.payer, &ctx.payment_mint, &holder.pubkey())
        })
        .collect()
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn create_distribution_funds_escrow() {
    let (mut svm, ctx) = boot();

    let dist_id = 1u64;
    let (dist_pda, escrow_pda) = setup_distribution(&mut svm, &ctx, dist_id);

    let d: Distribution = load(&svm, &dist_pda);
    assert_eq!(d.status, DistributionStatus::Distributing);
    assert_eq!(d.admin, ctx.payer.pubkey());
    assert_eq!(d.funder, ctx.funder.pubkey(), "funder recorded");
    assert_eq!(d.share_class, ctx.share_class_pda);
    assert_eq!(d.mint, ctx.mint_pda);
    assert_eq!(d.payment_mint, ctx.payment_mint);
    assert_eq!(d.escrow, escrow_pda);
    assert_eq!(d.total_amount, TOTAL_AMOUNT);
    assert_eq!(d.snapshot_supply, SNAPSHOT_SUPPLY);
    assert_eq!(d.distributed_amount, 0);
    assert_eq!(d.paid_count, 0);
    assert_eq!(d.distribution_id, dist_id);

    // funding was atomic — escrow holds exactly total_amount
    assert_eq!(token_balance(&svm, &escrow_pda), TOTAL_AMOUNT);
    assert_eq!(
        token_balance(&svm, &ctx.funder_payment_ata),
        FUNDER_BALANCE - TOTAL_AMOUNT
    );
    assert!(
        svm.get_account(&escrow_marker_of(&ctx, &dist_pda))
            .is_some(),
        "escrow marker created with the distribution"
    );
}

#[test]
fn two_batches_distribute_pro_rata() {
    let (mut svm, ctx) = boot();

    let dist_id = 1u64;
    let recips = recipients(&mut svm, &ctx, 5);
    let (dist_pda, escrow_pda, proofs) = setup_committed_distribution(
        &mut svm,
        &ctx,
        dist_id,
        vec![
            vec![(recips[0], 400_000), (recips[1], 250_000)],
            vec![
                (recips[2], 150_000),
                (recips[3], 100_000),
                (recips[4], 100_000),
            ],
        ],
    );

    // batch 1: two payouts
    send(
        &mut svm,
        &[&ctx.payer],
        &[distribute_batch_proven_ix(
            &ctx,
            &ctx.payer.pubkey(),
            dist_id,
            0,
            vec![400_000, 250_000],
            &recips[0..2],
            proofs[0].clone(),
        )],
        "distribute_batch 1",
    );
    // batch 2: three payouts — together they drain the escrow exactly
    send(
        &mut svm,
        &[&ctx.payer],
        &[distribute_batch_proven_ix(
            &ctx,
            &ctx.payer.pubkey(),
            dist_id,
            1,
            vec![150_000, 100_000, 100_000],
            &recips[2..5],
            proofs[1].clone(),
        )],
        "distribute_batch 2",
    );

    assert_eq!(token_balance(&svm, &recips[0]), 400_000);
    assert_eq!(token_balance(&svm, &recips[1]), 250_000);
    assert_eq!(token_balance(&svm, &recips[2]), 150_000);
    assert_eq!(token_balance(&svm, &recips[3]), 100_000);
    assert_eq!(token_balance(&svm, &recips[4]), 100_000);

    let d: Distribution = load(&svm, &dist_pda);
    assert_eq!(d.distributed_amount, TOTAL_AMOUNT);
    assert_eq!(d.paid_count, 5);
    assert_eq!(d.status, DistributionStatus::Distributing);
    assert_eq!(token_balance(&svm, &escrow_pda), 0);
}

#[test]
fn batch_exceeding_total_fails() {
    let (mut svm, ctx) = boot();

    let dist_id = 1u64;
    let recips = recipients(&mut svm, &ctx, 2);
    let (dist_pda, escrow_pda, proofs) = setup_committed_distribution(
        &mut svm,
        &ctx,
        dist_id,
        vec![vec![(recips[0], 600_000)], vec![(recips[1], 500_000)]],
    );

    send(
        &mut svm,
        &[&ctx.payer],
        &[distribute_batch_proven_ix(
            &ctx,
            &ctx.payer.pubkey(),
            dist_id,
            0,
            vec![600_000],
            &recips[0..1],
            proofs[0].clone(),
        )],
        "distribute_batch 1",
    );

    // 600_000 + 500_000 > 1_000_000 total — rejected, nothing moves
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[distribute_batch_proven_ix(
            &ctx,
            &ctx.payer.pubkey(),
            dist_id,
            1,
            vec![500_000],
            &recips[1..2],
            proofs[1].clone(),
        )],
    )
    .expect_err("overdrawing batch must fail");
    assert!(err.contains("DistributionOverdraw"), "got: {err}");

    assert_eq!(token_balance(&svm, &recips[0]), 600_000);
    assert_eq!(token_balance(&svm, &recips[1]), 0);
    assert_eq!(token_balance(&svm, &escrow_pda), TOTAL_AMOUNT - 600_000);
    let d: Distribution = load(&svm, &dist_pda);
    assert_eq!(d.distributed_amount, 600_000);
    assert_eq!(d.paid_count, 1);
}

#[test]
fn recipient_wrong_mint_fails() {
    let (mut svm, ctx) = boot();

    let dist_id = 1u64;
    let (dist_pda, escrow_pda) = setup_distribution(&mut svm, &ctx, dist_id);

    // recipient on a different mint
    let other_mint = create_mint(&mut svm, &ctx.payer, 6);
    let wrong_recip = create_ata(&mut svm, &ctx.payer, &other_mint, &Keypair::new().pubkey());

    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[distribute_batch_ix(
            &ctx,
            &ctx.payer.pubkey(),
            dist_id,
            vec![1_000],
            &[wrong_recip],
        )],
    )
    .expect_err("wrong-mint recipient must fail");
    assert!(err.contains("InvalidDistributionRecipient"), "got: {err}");

    assert_eq!(token_balance(&svm, &escrow_pda), TOTAL_AMOUNT);
    let d: Distribution = load(&svm, &dist_pda);
    assert_eq!(d.distributed_amount, 0);
    assert_eq!(d.paid_count, 0);
}

#[test]
fn non_admin_calls_fail() {
    let (mut svm, ctx) = boot();

    let dist_id = 1u64;
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();

    // create as a non-admin (the stranger has no Admin PDA)
    let err = try_send(
        &mut svm,
        &[&stranger, &ctx.funder],
        &[create_distribution_ix(
            &ctx,
            &stranger.pubkey(),
            &ctx.funder.pubkey(),
            dist_id,
            TOTAL_AMOUNT,
        )],
    )
    .expect_err("non-admin create_distribution must fail");
    assert!(
        err.contains("AccountNotInitialized") || err.contains("AccountDiscriminator"),
        "got: {err}"
    );

    let (dist_pda, _) = setup_distribution(&mut svm, &ctx, dist_id);
    let recips = recipients(&mut svm, &ctx, 1);

    // distribute as a non-admin
    let err = try_send(
        &mut svm,
        &[&stranger],
        &[distribute_batch_ix(
            &ctx,
            &stranger.pubkey(),
            dist_id,
            vec![1_000],
            &recips,
        )],
    )
    .expect_err("non-admin distribute_batch must fail");
    assert!(
        err.contains("AccountNotInitialized") || err.contains("AccountDiscriminator"),
        "got: {err}"
    );

    // close as a non-admin
    let err = try_send(
        &mut svm,
        &[&stranger],
        &[close_distribution_ix(
            &ctx,
            &stranger.pubkey(),
            dist_id,
            &ctx.funder_payment_ata,
            &ctx.funder.pubkey(),
        )],
    )
    .expect_err("non-admin close_distribution must fail");
    assert!(
        err.contains("AccountNotInitialized") || err.contains("AccountDiscriminator"),
        "got: {err}"
    );

    // distribution untouched
    let d: Distribution = load(&svm, &dist_pda);
    assert_eq!(d.status, DistributionStatus::Distributing);
    assert_eq!(d.distributed_amount, 0);
}

#[test]
fn close_sweeps_remainder_and_blocks_further_ops() {
    let (mut svm, ctx) = boot();

    let dist_id = 1u64;
    let recips = recipients(&mut svm, &ctx, 1);
    let (dist_pda, escrow_pda, proofs) =
        setup_committed_distribution(&mut svm, &ctx, dist_id, vec![vec![(recips[0], 300_000)]]);

    send(
        &mut svm,
        &[&ctx.payer],
        &[distribute_batch_proven_ix(
            &ctx,
            &ctx.payer.pubkey(),
            dist_id,
            0,
            vec![300_000],
            &recips,
            proofs[0].clone(),
        )],
        "distribute_batch",
    );
    assert_eq!(
        token_balance(&svm, &ctx.funder_payment_ata),
        FUNDER_BALANCE - TOTAL_AMOUNT
    );

    // refund to a NON-funder-owned account is rejected first
    let outsider_ata = create_ata(
        &mut svm,
        &ctx.payer,
        &ctx.payment_mint,
        &Keypair::new().pubkey(),
    );
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[close_distribution_ix(
            &ctx,
            &ctx.payer.pubkey(),
            dist_id,
            &outsider_ata,
            &ctx.funder.pubkey(),
        )],
    )
    .expect_err("refund to a non-funder account must fail");
    assert!(err.contains("RefundNotFunderOwned"), "got: {err}");

    // ... and so is directing the escrow rent to a non-funder wallet
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[close_distribution_ix(
            &ctx,
            &ctx.payer.pubkey(),
            dist_id,
            &ctx.funder_payment_ata,
            &ctx.payer.pubkey(),
        )],
    )
    .expect_err("escrow rent to a non-funder wallet must fail");
    assert!(err.contains("RefundNotFunderOwned"), "got: {err}");

    // close — the 700_000 remainder returns to the funder
    let funder_lamports_before = svm.get_account(&ctx.funder.pubkey()).unwrap().lamports;
    send(
        &mut svm,
        &[&ctx.payer],
        &[close_distribution_ix(
            &ctx,
            &ctx.payer.pubkey(),
            dist_id,
            &ctx.funder_payment_ata,
            &ctx.funder.pubkey(),
        )],
        "close_distribution",
    );
    let d: Distribution = load(&svm, &dist_pda);
    assert_eq!(d.status, DistributionStatus::Closed);
    assert_eq!(
        token_balance(&svm, &ctx.funder_payment_ata),
        FUNDER_BALANCE - 300_000,
        "exact remainder swept to the refund account"
    );
    // escrow token account is CLOSED — its rent went to the funder
    assert!(
        svm.get_account(&escrow_pda)
            .map(|a| a.data.is_empty() || a.lamports == 0)
            .unwrap_or(true),
        "escrow token account closed"
    );
    assert!(
        svm.get_account(&ctx.funder.pubkey()).unwrap().lamports > funder_lamports_before,
        "escrow rent refunded to the funder"
    );
    // escrow marker closed too
    assert!(
        svm.get_account(&escrow_marker_of(&ctx, &dist_pda))
            .map(|a| a.data.is_empty() || a.lamports == 0)
            .unwrap_or(true),
        "escrow marker closed on close_distribution"
    );

    // second close rejected
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[close_distribution_ix(
            &ctx,
            &ctx.payer.pubkey(),
            dist_id,
            &ctx.funder_payment_ata,
            &ctx.funder.pubkey(),
        )],
    )
    .expect_err("second close must fail");
    assert!(
        err.contains("DistributionNotActive")
            || err.contains("AccountNotInitialized")
            || err.contains("InvalidDistributionPlan"),
        "got: {err}"
    );

    // distribute after close rejected — the escrow token account no longer
    // exists (closed above), so Anchor rejects it before the status constraint
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[distribute_batch_ix(
            &ctx,
            &ctx.payer.pubkey(),
            dist_id,
            vec![1_000],
            &recips,
        )],
    )
    .expect_err("distribute after close must fail");
    assert!(
        err.contains("DistributionNotActive")
            || err.contains("AccountNotInitialized")
            || err.contains("InvalidDistributionPlan"),
        "got: {err}"
    );
}

#[test]
fn zero_amount_entry_rejected() {
    let (mut svm, ctx) = boot();

    let dist_id = 1u64;
    let (dist_pda, escrow_pda) = setup_distribution(&mut svm, &ctx, dist_id);
    let recips = recipients(&mut svm, &ctx, 2);

    // a zero-amount entry is rejected (documented choice — keeps paid_count
    // a true payout counter)
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[distribute_batch_ix(
            &ctx,
            &ctx.payer.pubkey(),
            dist_id,
            vec![100_000, 0],
            &recips,
        )],
    )
    .expect_err("zero-amount entry must fail");
    assert!(err.contains("InvalidDistributionParams"), "got: {err}");

    // an empty batch is rejected too
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[distribute_batch_ix(
            &ctx,
            &ctx.payer.pubkey(),
            dist_id,
            vec![],
            &[],
        )],
    )
    .expect_err("empty batch must fail");
    assert!(err.contains("InvalidDistributionParams"), "got: {err}");

    assert_eq!(token_balance(&svm, &escrow_pda), TOTAL_AMOUNT);
    let d: Distribution = load(&svm, &dist_pda);
    assert_eq!(d.distributed_amount, 0);
    assert_eq!(d.paid_count, 0);
}

fn plan_address(distribution: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            asset_registry::DISTRIBUTION_PLAN_SEED,
            distribution.as_ref(),
        ],
        &asset_registry::ID,
    )
    .0
}
fn setup_committed_distribution(
    svm: &mut LiteSVM,
    ctx: &Ctx,
    id: u64,
    batches: Vec<Vec<(Pubkey, u64)>>,
) -> (Pubkey, Pubkey, Vec<Vec<[u8; 32]>>) {
    let (distribution, escrow) = distribution_pdas(ctx, id);
    let leaves: Vec<_> = batches
        .iter()
        .enumerate()
        .map(|(i, entries)| {
            let entries: Vec<_> = entries
                .iter()
                .map(|(account, amount)| {
                    let token = svm.get_account(account).unwrap();
                    let owner = Pubkey::new_from_array(token.data[32..64].try_into().unwrap());
                    (*account, owner, *amount)
                })
                .collect();
            asset_registry::util::distribution_batch_leaf(&distribution, i as u32, &entries)
        })
        .collect();
    assert!((1..=2).contains(&leaves.len()));
    let (root, proofs) = if leaves.len() == 1 {
        (leaves[0], vec![vec![]])
    } else {
        (
            asset_registry::util::merkle_parent(leaves[0], leaves[1]),
            vec![vec![leaves[1]], vec![leaves[0]]],
        )
    };
    send(
        svm,
        &[&ctx.payer, &ctx.funder],
        &[create_distribution_with_plan_ix(
            ctx,
            &ctx.payer.pubkey(),
            &ctx.funder.pubkey(),
            id,
            TOTAL_AMOUNT,
            root,
            batches.len() as u32,
        )],
        "fund reviewed immutable plan",
    );
    (distribution, escrow, proofs)
}

#[test]
fn committed_batch_retries_are_noops_and_modified_payloads_cannot_spend_again() {
    let (mut svm, ctx) = boot();
    let recipients = recipients(&mut svm, &ctx, 2);
    let (distribution, escrow, proofs) = setup_committed_distribution(
        &mut svm,
        &ctx,
        2005,
        vec![
            vec![(recipients[0], 100_000)],
            vec![(recipients[1], 200_000)],
        ],
    );
    let first = distribute_batch_proven_ix(
        &ctx,
        &ctx.payer.pubkey(),
        2005,
        0,
        vec![100_000],
        &recipients[..1],
        proofs[0].clone(),
    );
    let altered = distribute_batch_proven_ix(
        &ctx,
        &ctx.payer.pubkey(),
        2005,
        0,
        vec![100_001],
        &recipients[..1],
        proofs[0].clone(),
    );
    assert!(try_send(&mut svm, &[&ctx.payer], &[altered.clone()])
        .unwrap_err()
        .contains("InvalidMerkleProof"));
    send(
        &mut svm,
        &[&ctx.payer],
        &[first.clone()],
        "pay committed first batch",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[first.clone()],
        "same-payload retry is a no-op",
    );
    assert_eq!(token_balance(&svm, &recipients[0]), 100_000);
    assert_eq!(load::<Distribution>(&svm, &distribution).paid_count, 1);
    assert!(try_send(&mut svm, &[&ctx.payer], &[altered])
        .unwrap_err()
        .contains("InvalidDistributionPlan"));
    let wrong_recipient = distribute_batch_proven_ix(
        &ctx,
        &ctx.payer.pubkey(),
        2005,
        1,
        vec![200_000],
        &recipients[..1],
        proofs[1].clone(),
    );
    assert!(try_send(&mut svm, &[&ctx.payer], &[wrong_recipient])
        .unwrap_err()
        .contains("InvalidMerkleProof"));
    assert_eq!(token_balance(&svm, &escrow), TOTAL_AMOUNT - 100_000);
    send(
        &mut svm,
        &[&ctx.payer],
        &[close_distribution_ix(
            &ctx,
            &ctx.payer.pubkey(),
            2005,
            &ctx.funder_payment_ata,
            &ctx.funder.pubkey(),
        )],
        "close preserves receipt",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[first],
        "receipt retry after escrow close is still a no-op",
    );
    assert_eq!(token_balance(&svm, &recipients[0]), 100_000);
    let unpaid = distribute_batch_proven_ix(
        &ctx,
        &ctx.payer.pubkey(),
        2005,
        1,
        vec![200_000],
        &recipients[1..],
        proofs[1].clone(),
    );
    assert!(try_send(&mut svm, &[&ctx.payer], &[unpaid])
        .unwrap_err()
        .contains("DistributionNotActive"));
}

#[test]
fn legacy_distribution_retains_funder_close_refund_without_a_new_plan() {
    use anchor_lang::{AccountSerialize, Space};
    let (mut svm, ctx) = boot();
    let (distribution, escrow) = setup_distribution(&mut svm, &ctx, 2006);
    let mut state: Distribution = load(&svm, &distribution);
    state.version = 1;
    let mut account = svm.get_account(&distribution).unwrap();
    account.data = vec![0; 8 + Distribution::INIT_SPACE];
    state
        .try_serialize(&mut account.data.as_mut_slice())
        .unwrap();
    svm.set_account(distribution, account).unwrap();
    let mut plan = svm.get_account(&plan_address(distribution)).unwrap();
    plan.lamports = 0;
    plan.data.clear();
    plan.owner = system_program::ID;
    svm.set_account(plan_address(distribution), plan).unwrap();
    send(
        &mut svm,
        &[&ctx.payer],
        &[close_distribution_ix(
            &ctx,
            &ctx.payer.pubkey(),
            2006,
            &ctx.funder_payment_ata,
            &ctx.funder.pubkey(),
        )],
        "legacy distribution close without plan",
    );
    assert_eq!(token_balance(&svm, &ctx.funder_payment_ata), FUNDER_BALANCE);
    assert!(svm.get_account(&escrow).is_none_or(|a| a.data.is_empty()));
    assert_eq!(load::<Distribution>(&svm, &distribution).version, 1);
}
