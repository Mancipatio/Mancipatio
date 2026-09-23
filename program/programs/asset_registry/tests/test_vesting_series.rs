//! End-to-end tests for the Vesting-series module (spec: "11. Vesting —
//! Mancipatio"): client-owned series, deposit-gated release, approval mode,
//! push/claim delivery, recovery, cancellation + pre-cliff, and the
//! unvested withdrawal cap.

#[path = "../../../tests/support/pause.rs"]
mod pause;
#[path = "../../../tests/support/mod.rs"]
mod support;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    asset_registry::{
        accounts as acc, instruction as ixd, state::*, VESTING_ESCROW_SEED, VESTING_POSITION_SEED,
        VESTING_SERIES_SEED,
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
fn mint_to(svm: &mut LiteSVM, payer: &Keypair, mint: &Pubkey, dest: &Pubkey, amount: u64) {
    let ix = token_ix::mint_to(&TOKEN_2022, mint, dest, &payer.pubkey(), &[], amount).unwrap();
    send(svm, &[payer], &[ix], "mint_to");
}
fn token_balance(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    let a = svm.get_account(ata).expect("ata missing");
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}
fn boot() -> (LiteSVM, Pubkey) {
    let (svm, program_id, _operator) = boot_with_operator();
    (svm, program_id)
}

/// Loads the registry and bootstraps the Platform (vesting funding reads its
/// emergency-pause flags), returning the super admin that can pause it.
fn boot_with_operator() -> (LiteSVM, Pubkey, Keypair) {
    let program_id = asset_registry::id();
    let mut svm = LiteSVM::new();
    svm.add_program(
        program_id,
        include_bytes!("../../../target/deploy/asset_registry.so"),
    )
    .unwrap();
    let operator = Keypair::new();
    svm.airdrop(&operator.pubkey(), 10_000_000_000).unwrap();
    support::set_upgrade_authority(&mut svm, &asset_registry::ID, Some(operator.pubkey()));
    send(
        &mut svm,
        &[&operator],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::InitializePlatform {
                protocol_treasury: operator.pubkey(),
                protocol_fee_bps: 250,
            }
            .data(),
            acc::InitializePlatform {
                admin: operator.pubkey(),
                upgrade_authority: operator.pubkey(),
                program: asset_registry::ID,
                program_data: support::program_data(&asset_registry::ID),
                platform: pause::platform_pda(),
                super_admin_record: pause::admin_pda(&operator.pubkey()),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "initialize_platform",
    );
    pause::unpause_all(&mut svm, &operator);
    (svm, program_id, operator)
}

struct SeriesCtx {
    client: Keypair,
    r0: Keypair,
    r1: Keypair,
    mint: Pubkey,
    series: Pubkey,
    escrow: Pubkey,
    pos0: Pubkey,
    pos1: Pubkey,
    client_ata: Pubkey,
    r0_ata: Pubkey,
    r1_ata: Pubkey,
}

fn series_pdas(program_id: &Pubkey, client: &Pubkey, series_id: u64) -> (Pubkey, Pubkey) {
    let (series, _) = Pubkey::find_program_address(
        &[
            VESTING_SERIES_SEED,
            client.as_ref(),
            &series_id.to_le_bytes(),
        ],
        program_id,
    );
    let (escrow, _) =
        Pubkey::find_program_address(&[VESTING_ESCROW_SEED, series.as_ref()], program_id);
    (series, escrow)
}
fn position_pda(program_id: &Pubkey, series: &Pubkey, index: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[VESTING_POSITION_SEED, series.as_ref(), &index.to_le_bytes()],
        program_id,
    )
    .0
}

/// Creates a series with tranches (100 @ 1000, 300 @ 2000) and positions
/// r0=100, r1=300 — schedule total (400) == total allocated (400).
#[allow(clippy::too_many_arguments)]
fn setup_draft_series(
    svm: &mut LiteSVM,
    timing: VestingTimingMode,
    delivery: VestingDeliveryMode,
    approval_window_secs: i64,
    recovery_enabled: bool,
    cancellation_enabled: bool,
    pre_cliff_bps: u16,
    series_id: u64,
) -> SeriesCtx {
    let program_id = asset_registry::id();
    let client = Keypair::new();
    let r0 = Keypair::new();
    let r1 = Keypair::new();
    svm.airdrop(&client.pubkey(), 100_000_000_000).unwrap();
    // Recipients pay their own claim fees.
    svm.airdrop(&r0.pubkey(), 1_000_000_000).unwrap();
    svm.airdrop(&r1.pubkey(), 1_000_000_000).unwrap();

    let mint = create_mint(svm, &client, 0);
    let client_ata = create_ata(svm, &client, &mint, &client.pubkey());
    let r0_ata = create_ata(svm, &client, &mint, &r0.pubkey());
    let r1_ata = create_ata(svm, &client, &mint, &r1.pubkey());
    mint_to(svm, &client, &mint, &client_ata, 400);

    let (series, escrow) = series_pdas(&program_id, &client.pubkey(), series_id);
    let tranches = vec![
        VestingTranche {
            unlock_ts: 1000,
            amount: 100,
        },
        VestingTranche {
            unlock_ts: 2000,
            amount: 300,
        },
    ];
    let ix = Instruction {
        program_id,
        accounts: acc::CreateVestingSeries {
            identity: Pubkey::find_program_address(
                &[asset_registry::ESCROW_MARKER_SEED, series.as_ref()],
                &asset_registry::ID,
            )
            .0,
            authority: client.pubkey(),
            token_mint: mint,
            series,
            escrow,
            token_program: TOKEN_2022,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ixd::CreateVestingSeries {
            series_id,
            tranches,
            timing_mode: timing,
            delivery_mode: delivery,
            approval_window_secs,
            recovery_enabled,
            cancellation_enabled,
            pre_cliff_bps,
        }
        .data(),
    };
    send(svm, &[&client], &[ix], "create_vesting_series");

    let mut ctx = SeriesCtx {
        pos0: Pubkey::default(),
        pos1: Pubkey::default(),
        client,
        r0,
        r1,
        mint,
        series,
        escrow,
        client_ata,
        r0_ata,
        r1_ata,
    };
    for (idx, (wallet, alloc)) in [(ctx.r0.pubkey(), 100u64), (ctx.r1.pubkey(), 300u64)]
        .iter()
        .enumerate()
    {
        let pos = position_pda(&program_id, &ctx.series, idx as u32);
        let ix = Instruction {
            program_id,
            accounts: acc::AddVestingPosition {
                authority: ctx.client.pubkey(),
                series: ctx.series,
                position: pos,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: ixd::AddVestingPosition {
                wallet: *wallet,
                allocation: *alloc,
            }
            .data(),
        };
        send(svm, &[&ctx.client], &[ix], "add_vesting_position");
        if idx == 0 {
            ctx.pos0 = pos;
        } else {
            ctx.pos1 = pos;
        }
    }
    ctx
}

fn finalize_series_ix(authority: Pubkey, series: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::FinalizeVestingSeries {}.data(),
        acc::FinalizeVestingSeries { authority, series }.to_account_metas(None),
    )
}

#[allow(clippy::too_many_arguments)]
fn setup_series(
    svm: &mut LiteSVM,
    timing: VestingTimingMode,
    delivery: VestingDeliveryMode,
    approval_window_secs: i64,
    recovery_enabled: bool,
    cancellation_enabled: bool,
    pre_cliff_bps: u16,
    series_id: u64,
) -> SeriesCtx {
    let ctx = setup_draft_series(
        svm,
        timing,
        delivery,
        approval_window_secs,
        recovery_enabled,
        cancellation_enabled,
        pre_cliff_bps,
        series_id,
    );
    send(
        svm,
        &[&ctx.client],
        &[finalize_series_ix(ctx.client.pubkey(), ctx.series)],
        "finalize vesting allocations",
    );
    ctx
}

fn deposit(svm: &mut LiteSVM, ctx: &SeriesCtx, amount: u64) {
    send(
        svm,
        &[&ctx.client],
        &[deposit_ix(ctx, amount)],
        "deposit_to_vesting_escrow",
    );
}

fn deposit_ix(ctx: &SeriesCtx, amount: u64) -> Instruction {
    let program_id = asset_registry::id();
    Instruction {
        program_id,
        accounts: acc::DepositToVestingEscrow {
            identity: Pubkey::find_program_address(
                &[asset_registry::ESCROW_MARKER_SEED, ctx.series.as_ref()],
                &asset_registry::ID,
            )
            .0,
            depositor: ctx.client.pubkey(),
            series: ctx.series,
            token_mint: ctx.mint,
            escrow: ctx.escrow,
            depositor_token_account: ctx.client_ata,
            token_program: TOKEN_2022,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
        data: ixd::DepositToVestingEscrow { amount }.data(),
    }
}

fn claim(svm: &mut LiteSVM, ctx: &SeriesCtx, signer: &Keypair, index: u32) -> Result<(), String> {
    let program_id = asset_registry::id();
    let (position, ata) = match index {
        0 => (ctx.pos0, ctx.r0_ata),
        _ => (ctx.pos1, ctx.r1_ata),
    };
    let ix = Instruction {
        program_id,
        accounts: acc::ClaimVested {
            recipient: signer.pubkey(),
            series: ctx.series,
            position,
            token_mint: ctx.mint,
            escrow: ctx.escrow,
            recipient_token_account: ata,
            token_program: TOKEN_2022,
        }
        .to_account_metas(None),
        data: ixd::ClaimVested {
            position_index: index,
        }
        .data(),
    };
    try_send(svm, &[signer], &[ix])
}

fn push(svm: &mut LiteSVM, ctx: &SeriesCtx, payer: &Keypair, index: u32) -> Result<(), String> {
    let program_id = asset_registry::id();
    let (position, ata) = match index {
        0 => (ctx.pos0, ctx.r0_ata),
        _ => (ctx.pos1, ctx.r1_ata),
    };
    let ix = Instruction {
        program_id,
        accounts: acc::PushVested {
            payer: payer.pubkey(),
            series: ctx.series,
            position,
            token_mint: ctx.mint,
            escrow: ctx.escrow,
            recipient_token_account: ata,
            token_program: TOKEN_2022,
        }
        .to_account_metas(None),
        data: ixd::PushVested {
            position_index: index,
        }
        .data(),
    };
    try_send(svm, &[payer], &[ix])
}

#[test]
fn auto_claim_happy_path_with_funding_gate() {
    let (mut svm, _pid) = boot();
    let ctx = setup_series(
        &mut svm,
        VestingTimingMode::Auto,
        VestingDeliveryMode::Claim,
        0,
        false,
        false,
        0,
        7,
    );

    // Deposit in TWO transactions (spec §11.1.7 — one or more deposits).
    deposit(&mut svm, &ctx, 250);
    warp_to(&mut svm, 1500);

    // Funding gate: 250 < 400 allocated ⇒ release blocked.
    assert!(claim(&mut svm, &ctx, &ctx.r0, 0).is_err());
    assert_eq!(token_balance(&svm, &ctx.r0_ata), 0);

    // Cover the rest → claims open. Tranche 1 = 100 of 400 cumulative.
    deposit(&mut svm, &ctx, 150);
    claim(&mut svm, &ctx, &ctx.r0, 0).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r0_ata), 25); // 100 * 100/400
    claim(&mut svm, &ctx, &ctx.r1, 1).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r1_ata), 75); // 300 * 100/400

    // Second claim with nothing new vested fails.
    assert!(claim(&mut svm, &ctx, &ctx.r0, 0).is_err());

    // After tranche 2 everything vests; positions take their full allocations.
    warp_to(&mut svm, 2500);
    claim(&mut svm, &ctx, &ctx.r0, 0).unwrap();
    claim(&mut svm, &ctx, &ctx.r1, 1).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r0_ata), 100);
    assert_eq!(token_balance(&svm, &ctx.r1_ata), 300);
    assert_eq!(token_balance(&svm, &ctx.escrow), 0);

    let series: VestingSeries = load(&svm, &ctx.series);
    assert_eq!(series.total_released, 400);
    assert_eq!(series.deposited, 400);
}

#[test]
fn approval_mode_gates_timing_but_window_overrides() {
    let (mut svm, _pid) = boot();
    let ctx = setup_series(
        &mut svm,
        VestingTimingMode::Approval,
        VestingDeliveryMode::Claim,
        3_600, // approval window (program minimum: 1 hour)
        false,
        false,
        0,
        9,
    );
    deposit(&mut svm, &ctx, 400);
    let program_id = asset_registry::id();

    // Tranche 1 vested at 1000 but not approved and window (4600) not lapsed.
    warp_to(&mut svm, 1200);
    assert!(claim(&mut svm, &ctx, &ctx.r0, 0).is_err());

    // Client approves tranche 0 → deliverable immediately.
    let ix = Instruction {
        program_id,
        accounts: acc::ApproveVestingTranche {
            authority: ctx.client.pubkey(),
            series: ctx.series,
        }
        .to_account_metas(None),
        data: ixd::ApproveVestingTranche { tranche_index: 0 }.data(),
    };
    send(&mut svm, &[&ctx.client], &[ix], "approve_vesting_tranche");
    claim(&mut svm, &ctx, &ctx.r0, 0).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r0_ata), 25);

    // Tranche 2 (vests 2000, window 5600): at 2100 r1 may take only its
    // TRANCHE-1 share (75) — the tranche-2 share stays gated.
    warp_to(&mut svm, 2100);
    claim(&mut svm, &ctx, &ctx.r1, 1).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r1_ata), 75);
    // Nothing beyond that until the approval window lapses.
    assert!(claim(&mut svm, &ctx, &ctx.r1, 1).is_err());
    // …but at 5600 the window lapses ⇒ approval can never freeze a vested
    // tranche (spec §11.1.10).
    warp_to(&mut svm, 5600);
    claim(&mut svm, &ctx, &ctx.r1, 1).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r1_ata), 300);
}

#[test]
fn push_mode_delivers_permissionlessly_and_claim_is_rejected() {
    let (mut svm, _pid) = boot();
    let ctx = setup_series(
        &mut svm,
        VestingTimingMode::Auto,
        VestingDeliveryMode::Push,
        0,
        false,
        false,
        0,
        11,
    );
    deposit(&mut svm, &ctx, 400);
    warp_to(&mut svm, 1500);

    // Claim is wrong-mode on a push series.
    assert!(claim(&mut svm, &ctx, &ctx.r0, 0).is_err());

    // A third party (the recipient's counterparty, a keeper, anyone) pushes.
    let crank = Keypair::new();
    svm.airdrop(&crank.pubkey(), 1_000_000_000).unwrap();
    push(&mut svm, &ctx, &crank, 0).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r0_ata), 25);
}

#[test]
fn recovery_repoints_the_position_and_zeroes_the_old_wallet() {
    let (mut svm, _pid) = boot();
    let ctx = setup_draft_series(
        &mut svm,
        VestingTimingMode::Auto,
        VestingDeliveryMode::Claim,
        0,
        true, // recovery ON
        false,
        0,
        13,
    );

    // Recovery re-points position 0 to a fresh wallet.
    let program_id = asset_registry::id();
    let new_wallet = Keypair::new();
    let new_ata = create_ata(&mut svm, &ctx.client, &ctx.mint, &new_wallet.pubkey());
    let ix = Instruction {
        program_id,
        accounts: acc::RecoverVestingPosition {
            authority: ctx.client.pubkey(),
            series: ctx.series,
            position: ctx.pos0,
        }
        .to_account_metas(None),
        data: ixd::RecoverVestingPosition {
            position_index: 0,
            new_wallet: new_wallet.pubkey(),
        }
        .data(),
    };
    assert_vesting_error(
        &try_send(&mut svm, &[&ctx.client], std::slice::from_ref(&ix)).unwrap_err(),
        asset_registry::error::RegistryError::VestingNotActive,
    );
    assert_eq!(
        load::<asset_registry::VestingPosition>(&svm, &ctx.pos0).wallet,
        ctx.r0.pubkey()
    );
    send(
        &mut svm,
        &[&ctx.client],
        &[finalize_series_ix(ctx.client.pubkey(), ctx.series)],
        "finalize reviewed recipient allocation",
    );
    deposit(&mut svm, &ctx, 400);
    warp_to(&mut svm, 1500);
    send(&mut svm, &[&ctx.client], &[ix], "recover_vesting_position");

    // Old wallet is zeroed — can no longer claim.
    assert!(claim(&mut svm, &ctx, &ctx.r0, 0).is_err());

    // New wallet claims the full position (claimable + future tranches).
    let ix = Instruction {
        program_id,
        accounts: acc::ClaimVested {
            recipient: new_wallet.pubkey(),
            series: ctx.series,
            position: ctx.pos0,
            token_mint: ctx.mint,
            escrow: ctx.escrow,
            recipient_token_account: new_ata,
            token_program: TOKEN_2022,
        }
        .to_account_metas(None),
        data: ixd::ClaimVested { position_index: 0 }.data(),
    };
    svm.airdrop(&new_wallet.pubkey(), 1_000_000_000).unwrap();
    try_send(&mut svm, &[&new_wallet], &[ix]).unwrap();
    assert_eq!(token_balance(&svm, &new_ata), 25);
}

#[test]
fn cancel_mid_schedule_keeps_vested_and_returns_only_unvested() {
    let (mut svm, _pid) = boot();
    let ctx = setup_series(
        &mut svm,
        VestingTimingMode::Auto,
        VestingDeliveryMode::Claim,
        0,
        false,
        true, // cancellation ON
        0,
        17,
    );
    deposit(&mut svm, &ctx, 400);
    warp_to(&mut svm, 1500);
    claim(&mut svm, &ctx, &ctx.r0, 0).unwrap(); // 25 out already

    let program_id = asset_registry::id();
    let ix = Instruction {
        program_id,
        accounts: acc::CancelVestingSeries {
            authority: ctx.client.pubkey(),
            series: ctx.series,
        }
        .to_account_metas(None),
        data: ixd::CancelVestingSeries {}.data(),
    };
    send(&mut svm, &[&ctx.client], &[ix], "cancel_vesting_series");

    // Recipient's vested entitlement (75) survives cancellation.
    claim(&mut svm, &ctx, &ctx.r1, 1).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r1_ata), 75);

    // Client withdraws ONLY the unvested remainder: 400 - 100 = 300.
    let ix = Instruction {
        program_id,
        accounts: acc::WithdrawUnvested {
            identity: Pubkey::find_program_address(
                &[asset_registry::ESCROW_MARKER_SEED, ctx.series.as_ref()],
                &asset_registry::ID,
            )
            .0,
            authority: ctx.client.pubkey(),
            series: ctx.series,
            token_mint: ctx.mint,
            escrow: ctx.escrow,
            authority_token_account: ctx.client_ata,
            token_program: TOKEN_2022,
        }
        .to_account_metas(None),
        data: ixd::WithdrawUnvested {}.data(),
    };
    send(
        &mut svm,
        &[&ctx.client],
        std::slice::from_ref(&ix),
        "withdraw_unvested",
    );
    assert_eq!(token_balance(&svm, &ctx.client_ata), 300);
    assert_eq!(token_balance(&svm, &ctx.escrow), 0);
    // Nothing left to withdraw.
    assert!(try_send(&mut svm, &[&ctx.client], &[ix]).is_err());
}

#[test]
fn pre_cliff_cancel_pays_the_fixed_percentage() {
    let (mut svm, _pid) = boot();
    let ctx = setup_series(
        &mut svm,
        VestingTimingMode::Auto,
        VestingDeliveryMode::Claim,
        0,
        false,
        true,
        1_000, // 10% pre-cliff
        19,
    );
    deposit(&mut svm, &ctx, 400);

    // Cancel BEFORE the first tranche (1000) — nothing vested.
    let program_id = asset_registry::id();
    let ix = Instruction {
        program_id,
        accounts: acc::CancelVestingSeries {
            authority: ctx.client.pubkey(),
            series: ctx.series,
        }
        .to_account_metas(None),
        data: ixd::CancelVestingSeries {}.data(),
    };
    send(&mut svm, &[&ctx.client], &[ix], "cancel_vesting_series");

    // Recipients keep 10% of their allocations; client takes the rest.
    claim(&mut svm, &ctx, &ctx.r0, 0).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r0_ata), 10);
    claim(&mut svm, &ctx, &ctx.r1, 1).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r1_ata), 30);

    let ix = Instruction {
        program_id,
        accounts: acc::WithdrawUnvested {
            identity: Pubkey::find_program_address(
                &[asset_registry::ESCROW_MARKER_SEED, ctx.series.as_ref()],
                &asset_registry::ID,
            )
            .0,
            authority: ctx.client.pubkey(),
            series: ctx.series,
            token_mint: ctx.mint,
            escrow: ctx.escrow,
            authority_token_account: ctx.client_ata,
            token_program: TOKEN_2022,
        }
        .to_account_metas(None),
        data: ixd::WithdrawUnvested {}.data(),
    };
    send(&mut svm, &[&ctx.client], &[ix], "withdraw_unvested");
    assert_eq!(token_balance(&svm, &ctx.client_ata), 360);
}

#[test]
fn disable_cancellation_is_irreversible() {
    let (mut svm, _pid) = boot();
    let ctx = setup_series(
        &mut svm,
        VestingTimingMode::Auto,
        VestingDeliveryMode::Claim,
        0,
        false,
        true,
        0,
        23,
    );
    let program_id = asset_registry::id();
    let ix = Instruction {
        program_id,
        accounts: acc::DisableVestingCancellation {
            authority: ctx.client.pubkey(),
            series: ctx.series,
        }
        .to_account_metas(None),
        data: ixd::DisableVestingCancellation {}.data(),
    };
    send(
        &mut svm,
        &[&ctx.client],
        &[ix],
        "disable_vesting_cancellation",
    );

    // Cancellation is now refused — ON→OFF only, never the reverse.
    let ix = Instruction {
        program_id,
        accounts: acc::CancelVestingSeries {
            authority: ctx.client.pubkey(),
            series: ctx.series,
        }
        .to_account_metas(None),
        data: ixd::CancelVestingSeries {}.data(),
    };
    assert!(try_send(&mut svm, &[&ctx.client], &[ix]).is_err());
}

#[test]
fn invalid_schedules_and_settings_are_rejected() {
    let (mut svm, _pid) = boot();
    let client = Keypair::new();
    svm.airdrop(&client.pubkey(), 100_000_000_000).unwrap();
    let mint = create_mint(&mut svm, &client, 0);
    let program_id = asset_registry::id();

    let mut try_create = |series_id: u64,
                          tranches: Vec<VestingTranche>,
                          timing: VestingTimingMode,
                          window: i64,
                          pre_cliff: u16|
     -> Result<(), String> {
        let (series, escrow) = series_pdas(&program_id, &client.pubkey(), series_id);
        let ix = Instruction {
            program_id,
            accounts: acc::CreateVestingSeries {
                identity: Pubkey::find_program_address(
                    &[asset_registry::ESCROW_MARKER_SEED, series.as_ref()],
                    &asset_registry::ID,
                )
                .0,
                authority: client.pubkey(),
                token_mint: mint,
                series,
                escrow,
                token_program: TOKEN_2022,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: ixd::CreateVestingSeries {
                series_id,
                tranches,
                timing_mode: timing,
                delivery_mode: VestingDeliveryMode::Claim,
                approval_window_secs: window,
                recovery_enabled: false,
                cancellation_enabled: false,
                pre_cliff_bps: pre_cliff,
            }
            .data(),
        };
        try_send(&mut svm, &[&client], &[ix])
    };

    // Empty schedule.
    assert!(try_create(101, vec![], VestingTimingMode::Auto, 0, 0).is_err());
    // Zero amount.
    assert!(try_create(
        102,
        vec![VestingTranche {
            unlock_ts: 1000,
            amount: 0
        }],
        VestingTimingMode::Auto,
        0,
        0
    )
    .is_err());
    // Non-ascending unlock times.
    assert!(try_create(
        103,
        vec![
            VestingTranche {
                unlock_ts: 2000,
                amount: 1
            },
            VestingTranche {
                unlock_ts: 1000,
                amount: 1
            },
        ],
        VestingTimingMode::Auto,
        0,
        0
    )
    .is_err());
    // Approval series without a valid window.
    assert!(try_create(
        104,
        vec![VestingTranche {
            unlock_ts: 1000,
            amount: 1
        }],
        VestingTimingMode::Approval,
        0,
        0
    )
    .is_err());
    // Auto series must not carry a window.
    assert!(try_create(
        105,
        vec![VestingTranche {
            unlock_ts: 1000,
            amount: 1
        }],
        VestingTimingMode::Auto,
        3_600,
        0
    )
    .is_err());
    // Pre-cliff above 100%.
    assert!(try_create(
        106,
        vec![VestingTranche {
            unlock_ts: 1000,
            amount: 1
        }],
        VestingTimingMode::Auto,
        0,
        10_001
    )
    .is_err());
    // Valid one-off.
    assert!(try_create(
        107,
        vec![VestingTranche {
            unlock_ts: 1000,
            amount: 1
        }],
        VestingTimingMode::Auto,
        0,
        0
    )
    .is_ok());
    // Neither schedule amounts nor approval deadlines may wrap.
    assert_vesting_error(
        &try_create(
            109,
            vec![
                VestingTranche {
                    unlock_ts: 1000,
                    amount: u64::MAX,
                },
                VestingTranche {
                    unlock_ts: 2000,
                    amount: 1,
                },
            ],
            VestingTimingMode::Auto,
            0,
            0,
        )
        .unwrap_err(),
        asset_registry::error::RegistryError::InvalidVestingSchedule,
    );
    assert_vesting_error(
        &try_create(
            108,
            vec![VestingTranche {
                unlock_ts: i64::MAX,
                amount: 1,
            }],
            VestingTimingMode::Approval,
            3600,
            0,
        )
        .unwrap_err(),
        asset_registry::error::RegistryError::InvalidVestingSchedule,
    );
}

#[test]
fn legacy_spl_vesting_escrow_still_funds_and_delivers() {
    let (mut svm, program_id) = boot();
    let token_program = anchor_spl::token::ID;
    let client = Keypair::new();
    let recipient = Keypair::new();
    svm.airdrop(&client.pubkey(), 100_000_000_000).unwrap();
    svm.airdrop(&recipient.pubkey(), 1_000_000_000).unwrap();
    let mint = Keypair::new();
    let create = system_instruction::create_account(
        &client.pubkey(),
        &mint.pubkey(),
        svm.minimum_balance_for_rent_exemption(82),
        82,
        &token_program,
    );
    let init =
        token_ix::initialize_mint2(&token_program, &mint.pubkey(), &client.pubkey(), None, 0)
            .unwrap();
    send(&mut svm, &[&client, &mint], &[create, init], "legacy mint");
    let source = get_associated_token_address_with_program_id(
        &client.pubkey(),
        &mint.pubkey(),
        &token_program,
    );
    let destination = get_associated_token_address_with_program_id(
        &recipient.pubkey(),
        &mint.pubkey(),
        &token_program,
    );
    send(
        &mut svm,
        &[&client],
        &[
            ata_ix::create_associated_token_account(
                &client.pubkey(),
                &client.pubkey(),
                &mint.pubkey(),
                &token_program,
            ),
            ata_ix::create_associated_token_account(
                &client.pubkey(),
                &recipient.pubkey(),
                &mint.pubkey(),
                &token_program,
            ),
            token_ix::mint_to(
                &token_program,
                &mint.pubkey(),
                &source,
                &client.pubkey(),
                &[],
                100,
            )
            .unwrap(),
        ],
        "legacy accounts and funding",
    );
    let (series, escrow) = series_pdas(&program_id, &client.pubkey(), 908);
    let position = position_pda(&program_id, &series, 0);
    send(
        &mut svm,
        &[&client],
        &[
            Instruction::new_with_bytes(
                program_id,
                &ixd::CreateVestingSeries {
                    series_id: 908,
                    tranches: vec![VestingTranche {
                        unlock_ts: 1_000,
                        amount: 100,
                    }],
                    timing_mode: VestingTimingMode::Auto,
                    delivery_mode: VestingDeliveryMode::Claim,
                    approval_window_secs: 0,
                    recovery_enabled: false,
                    cancellation_enabled: true,
                    pre_cliff_bps: 0,
                }
                .data(),
                acc::CreateVestingSeries {
                    identity: Pubkey::find_program_address(
                        &[asset_registry::ESCROW_MARKER_SEED, series.as_ref()],
                        &asset_registry::ID,
                    )
                    .0,
                    authority: client.pubkey(),
                    token_mint: mint.pubkey(),
                    series,
                    escrow,
                    token_program,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
            ),
            Instruction::new_with_bytes(
                program_id,
                &ixd::AddVestingPosition {
                    wallet: recipient.pubkey(),
                    allocation: 100,
                }
                .data(),
                acc::AddVestingPosition {
                    authority: client.pubkey(),
                    series,
                    position,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
            ),
            finalize_series_ix(client.pubkey(), series),
            Instruction::new_with_bytes(
                program_id,
                &ixd::DepositToVestingEscrow { amount: 100 }.data(),
                acc::DepositToVestingEscrow {
                    identity: Pubkey::find_program_address(
                        &[asset_registry::ESCROW_MARKER_SEED, series.as_ref()],
                        &asset_registry::ID,
                    )
                    .0,
                    depositor: client.pubkey(),
                    series,
                    token_mint: mint.pubkey(),
                    escrow,
                    depositor_token_account: source,
                    token_program,
                    platform: pause::platform_pda(),
                }
                .to_account_metas(None),
            ),
        ],
        "legacy escrow create and deposit",
    );
    assert_eq!(
        svm.get_account(&escrow).unwrap().data.len(),
        165,
        "legacy SPL cannot carry Token-2022 extensions"
    );
    assert_eq!(token_balance(&svm, &escrow), 100);
    warp_to(&mut svm, 1_001);
    send(
        &mut svm,
        &[&recipient],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::ClaimVested { position_index: 0 }.data(),
            acc::ClaimVested {
                recipient: recipient.pubkey(),
                series,
                position,
                token_mint: mint.pubkey(),
                escrow,
                recipient_token_account: destination,
                token_program,
            }
            .to_account_metas(None),
        )],
        "legacy vesting claim",
    );
    assert_eq!(token_balance(&svm, &destination), 100);
    assert_eq!(token_balance(&svm, &escrow), 0);
}

fn cancel_series_ix(authority: Pubkey, series: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::CancelVestingSeries {}.data(),
        acc::CancelVestingSeries { authority, series }.to_account_metas(None),
    )
}
fn withdraw_series_ix(ctx: &SeriesCtx) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::WithdrawUnvested {}.data(),
        acc::WithdrawUnvested {
            identity: Pubkey::find_program_address(
                &[asset_registry::ESCROW_MARKER_SEED, ctx.series.as_ref()],
                &asset_registry::ID,
            )
            .0,
            authority: ctx.client.pubkey(),
            series: ctx.series,
            token_mint: ctx.mint,
            escrow: ctx.escrow,
            authority_token_account: ctx.client_ata,
            token_program: TOKEN_2022,
        }
        .to_account_metas(None),
    )
}
fn add_extra_position_ix(ctx: &SeriesCtx) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::AddVestingPosition {
            wallet: ctx.r0.pubkey(),
            allocation: 1,
        }
        .data(),
        acc::AddVestingPosition {
            authority: ctx.client.pubkey(),
            series: ctx.series,
            position: position_pda(&asset_registry::ID, &ctx.series, 2),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}
fn assert_vesting_error(err: &str, error: asset_registry::error::RegistryError) {
    let code: u32 = error.into();
    assert!(
        err.contains(&format!("Custom({code})")),
        "expected {code}: {err}"
    );
}

#[test]
fn draft_never_grants_rights_and_always_returns_deposits_after_missed_start() {
    use asset_registry::{error::RegistryError, VestingSeriesStatus};
    for cancellable in [false, true] {
        let (mut svm, _) = boot();
        let ctx = setup_draft_series(
            &mut svm,
            VestingTimingMode::Approval,
            VestingDeliveryMode::Claim,
            3600,
            false,
            cancellable,
            2500,
            991,
        );
        assert_eq!(
            load::<VestingSeries>(&svm, &ctx.series).status,
            VestingSeriesStatus::Draft
        );
        deposit(&mut svm, &ctx, 100);
        let approval = Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::ApproveVestingTranche { tranche_index: 0 }.data(),
            acc::ApproveVestingTranche {
                authority: ctx.client.pubkey(),
                series: ctx.series,
            }
            .to_account_metas(None),
        );
        assert_vesting_error(
            &try_send(&mut svm, &[&ctx.client], &[approval]).unwrap_err(),
            RegistryError::VestingNotActive,
        );
        warp_to(&mut svm, 1_000); // Exact first-unlock boundary, no approval yet.
        assert_vesting_error(
            &try_send(
                &mut svm,
                &[&ctx.client],
                &[finalize_series_ix(ctx.client.pubkey(), ctx.series)],
            )
            .unwrap_err(),
            RegistryError::VestingStartReached,
        );
        assert_vesting_error(
            &claim(&mut svm, &ctx, &ctx.r0, 0).unwrap_err(),
            RegistryError::VestingNotActive,
        );
        send(
            &mut svm,
            &[&ctx.client],
            &[
                cancel_series_ix(ctx.client.pubkey(), ctx.series),
                withdraw_series_ix(&ctx),
            ],
            "abort expired draft and recover deposits",
        );
        let series: VestingSeries = load(&svm, &ctx.series);
        assert_eq!(series.status, VestingSeriesStatus::Cancelled);
        assert_eq!(
            series.final_cumulative, 0,
            "Draft has no pre-cliff or timed entitlement"
        );
        assert_eq!(token_balance(&svm, &ctx.client_ata), 400);
        assert_eq!(token_balance(&svm, &ctx.escrow), 0);
        assert_eq!(token_balance(&svm, &ctx.r0_ata), 0);
    }
}

#[test]
fn finalization_requires_complete_allocations_and_incomplete_draft_can_abort() {
    use asset_registry::error::RegistryError;
    let (mut svm, _) = boot();
    let ctx = setup_draft_series(
        &mut svm,
        VestingTimingMode::Auto,
        VestingDeliveryMode::Claim,
        0,
        false,
        false,
        0,
        992,
    );
    send(
        &mut svm,
        &[&ctx.client],
        &[add_extra_position_ix(&ctx)],
        "add Draft position",
    );
    deposit(&mut svm, &ctx, 100);
    assert_vesting_error(
        &try_send(
            &mut svm,
            &[&ctx.client],
            &[finalize_series_ix(ctx.client.pubkey(), ctx.series)],
        )
        .unwrap_err(),
        RegistryError::VestingAllocationMismatch,
    );
    send(
        &mut svm,
        &[&ctx.client],
        &[
            cancel_series_ix(ctx.client.pubkey(), ctx.series),
            withdraw_series_ix(&ctx),
        ],
        "abort mismatched draft",
    );
    assert_eq!(token_balance(&svm, &ctx.client_ata), 400);
}

#[test]
fn finalized_composition_is_locked_before_release_and_cancellation_preserves_entitlements() {
    use asset_registry::error::RegistryError;
    let (mut svm, _) = boot();
    let ctx = setup_series(
        &mut svm,
        VestingTimingMode::Approval,
        VestingDeliveryMode::Claim,
        3600,
        false,
        true,
        0,
        993,
    );
    deposit(&mut svm, &ctx, 400);
    assert_vesting_error(
        &try_send(&mut svm, &[&ctx.client], &[add_extra_position_ix(&ctx)]).unwrap_err(),
        RegistryError::VestingNotDraft,
    );
    warp_to(&mut svm, 1_500); // Vested, still awaiting approval, nothing released.
    svm.expire_blockhash();
    assert_vesting_error(
        &try_send(&mut svm, &[&ctx.client], &[add_extra_position_ix(&ctx)]).unwrap_err(),
        RegistryError::VestingNotDraft,
    );
    assert_vesting_error(
        &claim(&mut svm, &ctx, &ctx.r0, 0).unwrap_err(),
        RegistryError::VestingNothingToClaim,
    );
    send(
        &mut svm,
        &[&ctx.client],
        &[cancel_series_ix(ctx.client.pubkey(), ctx.series)],
        "cancel finalized allocation",
    );
    assert_eq!(
        load::<VestingSeries>(&svm, &ctx.series).final_cumulative,
        100
    );
    svm.expire_blockhash();
    claim(&mut svm, &ctx, &ctx.r0, 0).unwrap();
    claim(&mut svm, &ctx, &ctx.r1, 1).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r0_ata), 25);
    assert_eq!(token_balance(&svm, &ctx.r1_ata), 75);
    send(
        &mut svm,
        &[&ctx.client],
        &[withdraw_series_ix(&ctx)],
        "withdraw only unvested remainder",
    );
    assert_eq!(token_balance(&svm, &ctx.client_ata), 300);
}

#[test]
fn unsupported_fee_scaled_interest_and_external_hook_mints_are_rejected_before_escrow_creation() {
    use spl_token_2022_interface::{
        extension::{self, ExtensionType},
        state::Mint,
    };
    for kind in [
        ExtensionType::TransferFeeConfig,
        ExtensionType::InterestBearingConfig,
        ExtensionType::ScaledUiAmount,
        ExtensionType::TransferHook,
        ExtensionType::NonTransferable,
        ExtensionType::Pausable,
        ExtensionType::DefaultAccountState,
    ] {
        let (mut svm, _) = boot();
        let client = Keypair::new();
        let mint = Keypair::new();
        svm.airdrop(&client.pubkey(), 100_000_000_000).unwrap();
        let space = ExtensionType::try_calculate_account_len::<Mint>(&[kind]).unwrap();
        let create = system_instruction::create_account(
            &client.pubkey(),
            &mint.pubkey(),
            svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            &TOKEN_2022,
        );
        let ext = match kind {
            ExtensionType::TransferFeeConfig => {
                extension::transfer_fee::instruction::initialize_transfer_fee_config(
                    &TOKEN_2022,
                    &mint.pubkey(),
                    Some(&client.pubkey()),
                    Some(&client.pubkey()),
                    100,
                    100,
                )
                .unwrap()
            }
            ExtensionType::InterestBearingConfig => {
                extension::interest_bearing_mint::instruction::initialize(
                    &TOKEN_2022,
                    &mint.pubkey(),
                    Some(client.pubkey()),
                    100,
                )
                .unwrap()
            }
            ExtensionType::ScaledUiAmount => extension::scaled_ui_amount::instruction::initialize(
                &TOKEN_2022,
                &mint.pubkey(),
                Some(client.pubkey()),
                2.0,
            )
            .unwrap(),
            ExtensionType::TransferHook => extension::transfer_hook::instruction::initialize(
                &TOKEN_2022,
                &mint.pubkey(),
                Some(client.pubkey()),
                Some(transfer_hook::ID),
            )
            .unwrap(),
            ExtensionType::NonTransferable => {
                token_ix::initialize_non_transferable_mint(&TOKEN_2022, &mint.pubkey()).unwrap()
            }
            ExtensionType::Pausable => extension::pausable::instruction::initialize(
                &TOKEN_2022,
                &mint.pubkey(),
                &client.pubkey(),
            )
            .unwrap(),
            ExtensionType::DefaultAccountState => {
                extension::default_account_state::instruction::initialize_default_account_state(
                    &TOKEN_2022,
                    &mint.pubkey(),
                    &spl_token_2022_interface::state::AccountState::Initialized,
                )
                .unwrap()
            }
            _ => unreachable!(),
        };
        let init =
            token_ix::initialize_mint2(&TOKEN_2022, &mint.pubkey(), &client.pubkey(), None, 0)
                .unwrap();
        send(
            &mut svm,
            &[&client, &mint],
            &[create, ext, init],
            "initialize real external extension mint",
        );
        let (series, escrow) = series_pdas(&asset_registry::ID, &client.pubkey(), 2007);
        let identity = Pubkey::find_program_address(
            &[asset_registry::ESCROW_MARKER_SEED, series.as_ref()],
            &asset_registry::ID,
        )
        .0;
        let create_series = Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::CreateVestingSeries {
                series_id: 2007,
                tranches: vec![VestingTranche {
                    unlock_ts: 1_000,
                    amount: 100,
                }],
                timing_mode: VestingTimingMode::Auto,
                delivery_mode: VestingDeliveryMode::Claim,
                approval_window_secs: 0,
                recovery_enabled: false,
                cancellation_enabled: true,
                pre_cliff_bps: 0,
            }
            .data(),
            acc::CreateVestingSeries {
                authority: client.pubkey(),
                token_mint: mint.pubkey(),
                series,
                escrow,
                token_program: TOKEN_2022,
                system_program: system_program::ID,
                identity,
            }
            .to_account_metas(None),
        );
        let err = try_send(&mut svm, &[&client], &[create_series]).unwrap_err();
        assert!(err.contains("UnsupportedMintExtension"), "{kind:?}: {err}");
        assert!(svm.get_account(&escrow).is_none());
        assert!(svm.get_account(&series).is_none());
    }
}

fn withdraw_surplus_ix(ctx: &SeriesCtx) -> Instruction {
    let mut instruction = withdraw_series_ix(ctx);
    instruction.data = ixd::WithdrawVestingSurplus {}.data();
    instruction
}

fn donate_to_series(svm: &mut LiteSVM, ctx: &SeriesCtx, amount: u64) {
    mint_to(svm, &ctx.client, &ctx.mint, &ctx.client_ata, amount);
    send(
        svm,
        &[&ctx.client],
        &[token_ix::transfer_checked(
            &TOKEN_2022,
            &ctx.client_ata,
            &ctx.mint,
            &ctx.escrow,
            &ctx.client.pubkey(),
            &[],
            amount,
            0,
        )
        .unwrap()],
        "raw donation does not credit funding ledger",
    );
}

#[test]
fn draft_and_active_funding_caps_reject_excess_before_transfer_or_ledger_credit() {
    use asset_registry::error::RegistryError;
    for finalized in [false, true] {
        let (mut svm, _) = boot();
        let ctx = setup_draft_series(
            &mut svm,
            VestingTimingMode::Auto,
            VestingDeliveryMode::Claim,
            0,
            false,
            false,
            0,
            2101,
        );
        if finalized {
            send(
                &mut svm,
                &[&ctx.client],
                &[finalize_series_ix(ctx.client.pubkey(), ctx.series)],
                "finalize before funding",
            );
        }
        deposit(&mut svm, &ctx, 250);
        mint_to(&mut svm, &ctx.client, &ctx.mint, &ctx.client_ata, 1);
        let identity = Pubkey::find_program_address(
            &[asset_registry::ESCROW_MARKER_SEED, ctx.series.as_ref()],
            &asset_registry::ID,
        )
        .0;
        let series_before = svm.get_account(&ctx.series).unwrap().data;
        let identity_before = svm.get_account(&identity).unwrap().data;
        assert_vesting_error(
            &try_send(&mut svm, &[&ctx.client], &[deposit_ix(&ctx, 151)]).unwrap_err(),
            RegistryError::VestingFundingExceedsSchedule,
        );
        assert_eq!(token_balance(&svm, &ctx.escrow), 250);
        assert_eq!(token_balance(&svm, &ctx.client_ata), 151);
        assert_eq!(svm.get_account(&ctx.series).unwrap().data, series_before);
        assert_eq!(svm.get_account(&identity).unwrap().data, identity_before);
        deposit(&mut svm, &ctx, 150);
        assert_eq!(load::<VestingSeries>(&svm, &ctx.series).deposited, 400);
        assert_vesting_error(
            &try_send(&mut svm, &[&ctx.client], &[deposit_ix(&ctx, 1)]).unwrap_err(),
            RegistryError::VestingFundingExceedsSchedule,
        );
        assert_eq!(token_balance(&svm, &ctx.escrow), 400);
        assert_eq!(token_balance(&svm, &ctx.client_ata), 1);
    }
}

#[test]
fn active_surplus_preserves_all_unpaid_allocations_and_requires_authority_and_finalization() {
    use asset_registry::error::RegistryError;
    let (mut svm, _) = boot();
    let ctx = setup_draft_series(
        &mut svm,
        VestingTimingMode::Auto,
        VestingDeliveryMode::Claim,
        0,
        false,
        false,
        0,
        2102,
    );
    deposit(&mut svm, &ctx, 400);
    donate_to_series(&mut svm, &ctx, 100);
    assert_vesting_error(
        &try_send(&mut svm, &[&ctx.client], &[withdraw_surplus_ix(&ctx)]).unwrap_err(),
        RegistryError::VestingNotActive,
    );
    send(
        &mut svm,
        &[&ctx.client],
        &[finalize_series_ix(ctx.client.pubkey(), ctx.series)],
        "finalize full allocation",
    );
    let mut unauthorized = withdraw_surplus_ix(&ctx);
    unauthorized.accounts[0].pubkey = ctx.r0.pubkey();
    unauthorized.accounts[4].pubkey = ctx.r0_ata;
    assert_vesting_error(
        &try_send(&mut svm, &[&ctx.r0], &[unauthorized]).unwrap_err(),
        RegistryError::Unauthorized,
    );
    assert_vesting_error(
        &try_send(&mut svm, &[&ctx.client], &[withdraw_series_ix(&ctx)]).unwrap_err(),
        RegistryError::VestingNotCancelled,
    );
    send(
        &mut svm,
        &[&ctx.client],
        &[withdraw_surplus_ix(&ctx)],
        "only genuine active excess returns",
    );
    assert_eq!(token_balance(&svm, &ctx.client_ata), 100);
    assert_eq!(token_balance(&svm, &ctx.escrow), 400);
    assert_vesting_error(
        &try_send(&mut svm, &[&ctx.client], &[withdraw_surplus_ix(&ctx)]).unwrap_err(),
        RegistryError::VestingNothingToWithdraw,
    );
    warp_to(&mut svm, 1_000);
    claim(&mut svm, &ctx, &ctx.r0, 0).unwrap(); // 25 of 100 allocation released.
    assert_eq!(token_balance(&svm, &ctx.escrow), 375);
    donate_to_series(&mut svm, &ctx, 60);
    send(
        &mut svm,
        &[&ctx.client],
        &[withdraw_surplus_ix(&ctx)],
        "reserve decreases only by actual recipient releases",
    );
    assert_eq!(token_balance(&svm, &ctx.client_ata), 160);
    assert_eq!(token_balance(&svm, &ctx.escrow), 375);
    warp_to(&mut svm, 2_000);
    claim(&mut svm, &ctx, &ctx.r0, 0).unwrap();
    claim(&mut svm, &ctx, &ctx.r1, 1).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r0_ata), 100);
    assert_eq!(token_balance(&svm, &ctx.r1_ata), 300);
    assert_eq!(token_balance(&svm, &ctx.escrow), 0);
    let series: VestingSeries = load(&svm, &ctx.series);
    assert_eq!((series.deposited, series.total_released), (400, 400));
}

#[test]
fn legacy_overfunded_active_series_can_attach_and_recover_excess_without_rewriting_entitlements() {
    use anchor_lang::AccountSerialize;
    use asset_registry::error::RegistryError;
    let (mut svm, _) = boot();
    let ctx = setup_series(
        &mut svm,
        VestingTimingMode::Auto,
        VestingDeliveryMode::Claim,
        0,
        false,
        false,
        0,
        2103,
    );
    deposit(&mut svm, &ctx, 400);
    donate_to_series(&mut svm, &ctx, 100);
    // Original VestingSeries has the same layout and Active enum tag. Restore
    // a pre-cap 500-unit historical ledger and remove the later identity PDA.
    let mut series: VestingSeries = load(&svm, &ctx.series);
    series.version = 1;
    series.deposited = 500;
    let mut account = svm.get_account(&ctx.series).unwrap();
    series
        .try_serialize(&mut account.data.as_mut_slice())
        .unwrap();
    svm.set_account(ctx.series, account).unwrap();
    let original = svm.get_account(&ctx.series).unwrap().data;
    let identity = Pubkey::find_program_address(
        &[asset_registry::ESCROW_MARKER_SEED, ctx.series.as_ref()],
        &asset_registry::ID,
    )
    .0;
    let mut absent = svm.get_account(&identity).unwrap();
    absent.owner = system_program::ID;
    absent.lamports = 0;
    absent.data.clear();
    svm.set_account(identity, absent).unwrap();
    send(
        &mut svm,
        &[&ctx.r0],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::RegisterVestingEscrowIdentity {}.data(),
            acc::RegisterVestingEscrowIdentity {
                payer: ctx.r0.pubkey(),
                series: ctx.series,
                identity,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "permissionless legacy identity attachment",
    );
    let recorded: EscrowIdentity = load(&svm, &identity);
    assert_eq!((recorded.own_deposited, recorded.own_refunded), (0, 0));
    assert_eq!(svm.get_account(&ctx.series).unwrap().data, original);
    assert_vesting_error(
        &try_send(&mut svm, &[&ctx.client], &[deposit_ix(&ctx, 1)]).unwrap_err(),
        RegistryError::VestingFundingExceedsSchedule,
    );
    send(
        &mut svm,
        &[&ctx.client],
        &[withdraw_surplus_ix(&ctx)],
        "recover historical surplus without cancellation",
    );
    assert_eq!(token_balance(&svm, &ctx.client_ata), 100);
    assert_eq!(token_balance(&svm, &ctx.escrow), 400);
    assert_eq!(svm.get_account(&ctx.series).unwrap().data, original);
    assert_vesting_error(
        &try_send(&mut svm, &[&ctx.client], &[withdraw_surplus_ix(&ctx)]).unwrap_err(),
        RegistryError::VestingNothingToWithdraw,
    );
    warp_to(&mut svm, 2_000);
    claim(&mut svm, &ctx, &ctx.r0, 0).unwrap();
    claim(&mut svm, &ctx, &ctx.r1, 1).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r0_ata), 100);
    assert_eq!(token_balance(&svm, &ctx.r1_ata), 300);
    assert_eq!(token_balance(&svm, &ctx.escrow), 0);
    assert_eq!(load::<VestingSeries>(&svm, &ctx.series).deposited, 500);
    assert_eq!(load::<EscrowIdentity>(&svm, &identity).own_refunded, 0);
}

// ── Emergency pause (Platform.pause_flags) ───────────────────────────────────

/// bit4 gates ONLY `deposit_to_vesting_escrow`. Creating a series stays open
/// (it moves no value and its 48-tranche wallet transaction has no room for
/// the Platform account); every setup step and every exit — add, finalize,
/// approve, claim, recover, cancel, both withdrawals — runs under 0x3F.
#[test]
fn distribution_pause_gates_vesting_funding_while_setup_and_exits_stay_open() {
    let (mut svm, _pid, operator) = boot_with_operator();
    pause::pause_only(&mut svm, &operator, asset_registry::PAUSE_FLAGS_ALL);

    // create_vesting_series + add_vesting_position ×2 + finalize, all paused.
    let ctx = setup_series(
        &mut svm,
        VestingTimingMode::Approval,
        VestingDeliveryMode::Claim,
        3_600,
        true, // recovery ON
        true, // cancellation ON
        0,
        41,
    );

    pause::pause_only(&mut svm, &operator, asset_registry::PAUSE_DISTRIBUTIONS);
    pause::assert_paused(
        try_send(&mut svm, &[&ctx.client], &[deposit_ix(&ctx, 400)]),
        "deposit_to_vesting_escrow under DISTRIBUTIONS",
    );
    assert_eq!(token_balance(&svm, &ctx.escrow), 0);
    pause::pause_only(
        &mut svm,
        &operator,
        asset_registry::PAUSE_FLAGS_ALL & !asset_registry::PAUSE_DISTRIBUTIONS,
    );
    deposit(&mut svm, &ctx, 400);

    pause::pause_only(&mut svm, &operator, asset_registry::PAUSE_FLAGS_ALL);
    // Surplus withdrawal (a raw donation above the schedule).
    donate_to_series(&mut svm, &ctx, 100);
    send(
        &mut svm,
        &[&ctx.client],
        &[withdraw_surplus_ix(&ctx)],
        "withdraw_vesting_surplus under 0x3F",
    );
    assert_eq!(token_balance(&svm, &ctx.client_ata), 100);

    // Approve + claim.
    warp_to(&mut svm, 1_200);
    send(
        &mut svm,
        &[&ctx.client],
        &[Instruction {
            program_id: asset_registry::ID,
            accounts: acc::ApproveVestingTranche {
                authority: ctx.client.pubkey(),
                series: ctx.series,
            }
            .to_account_metas(None),
            data: ixd::ApproveVestingTranche { tranche_index: 0 }.data(),
        }],
        "approve_vesting_tranche under 0x3F",
    );
    claim(&mut svm, &ctx, &ctx.r0, 0).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r0_ata), 25);

    // Recover position 1 to a fresh wallet.
    let new_wallet = Keypair::new();
    send(
        &mut svm,
        &[&ctx.client],
        &[Instruction {
            program_id: asset_registry::ID,
            accounts: acc::RecoverVestingPosition {
                authority: ctx.client.pubkey(),
                series: ctx.series,
                position: ctx.pos1,
            }
            .to_account_metas(None),
            data: ixd::RecoverVestingPosition {
                position_index: 1,
                new_wallet: new_wallet.pubkey(),
            }
            .data(),
        }],
        "recover_vesting_position under 0x3F",
    );

    // Cancel, then withdraw the unvested remainder.
    send(
        &mut svm,
        &[&ctx.client],
        &[cancel_series_ix(ctx.client.pubkey(), ctx.series)],
        "cancel_vesting_series under 0x3F",
    );
    let before = token_balance(&svm, &ctx.client_ata);
    send(
        &mut svm,
        &[&ctx.client],
        &[withdraw_series_ix(&ctx)],
        "withdraw_unvested under 0x3F",
    );
    assert!(token_balance(&svm, &ctx.client_ata) > before);
    assert_eq!(pause::pause_flags(&svm), asset_registry::PAUSE_FLAGS_ALL);
}

/// Push delivery is a recipient exit: a keeper pushes under 0x3F.
#[test]
fn vesting_push_delivery_stays_open_under_full_pause() {
    let (mut svm, _pid, operator) = boot_with_operator();
    let ctx = setup_series(
        &mut svm,
        VestingTimingMode::Auto,
        VestingDeliveryMode::Push,
        0,
        false,
        false,
        0,
        42,
    );
    deposit(&mut svm, &ctx, 400);
    pause::pause_only(&mut svm, &operator, asset_registry::PAUSE_FLAGS_ALL);
    warp_to(&mut svm, 1_500);
    let crank = Keypair::new();
    svm.airdrop(&crank.pubkey(), 1_000_000_000).unwrap();
    push(&mut svm, &ctx, &crank, 0).unwrap();
    push(&mut svm, &ctx, &crank, 1).unwrap();
    assert_eq!(token_balance(&svm, &ctx.r0_ata), 25);
    assert_eq!(token_balance(&svm, &ctx.r1_ata), 75);
}
