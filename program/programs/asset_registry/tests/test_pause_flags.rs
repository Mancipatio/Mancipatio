//! Emergency pause (`Platform.pause_flags`), protocol-treasury rotation and
//! security.txt — LiteSVM tests.
//!
//! * a fresh platform starts fully paused, in the same 85-byte layout;
//! * any Admin SETS bits (they combine), only the super admin CLEARS them;
//! * `set_pause(bool)` touches only the onboarding bit;
//! * the onboarding family is gated by bit0 and nothing else;
//! * legacy bytes (0 / 1, the old `paused: bool`) decode with the old meaning,
//!   and the rollback precondition (byte back to 0/1) is reachable;
//! * `set_protocol_treasury` is super-admin only and rejects the default key;
//! * both program binaries embed a security.txt.
//!
//! The per-domain matrices (primary / secondary / custody / distributions /
//! issuer proceeds, and every exit under 0x3F) live next to each domain's
//! existing tests.

#[path = "../../../tests/support/pause.rs"]
mod pause;
#[path = "../../../tests/support/mod.rs"]
mod support;

use {
    anchor_lang::{
        __private::base64::{engine::general_purpose::STANDARD, Engine as _},
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
    },
    asset_registry::{
        accounts as acc, instruction as ixd, AssetType, JurisdictionRules, PauseFlagsChanged,
        Platform, ProtocolTreasuryChanged, ShareClassType, PAUSE_CUSTODY_ENTRY,
        PAUSE_DISTRIBUTIONS, PAUSE_FLAGS_ALL, PAUSE_ISSUER_PROCEEDS, PAUSE_ONBOARDING,
        PAUSE_PRIMARY, PAUSE_SECONDARY, RIGHT_VOTE,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    spl_token_2022_interface::instruction as token_ix,
};

const TOKEN_2022: Pubkey = spl_token_2022_interface::id();
const LEGAL_ENTITY_ID: [u8; 32] = *b"PAUSE-FLAGS-ENTITY-0000000000001";
const ASSET_ID: &str = "pause-001";

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Sends and returns the program logs on success, the error string otherwise.
fn try_send_logs(
    svm: &mut LiteSVM,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<Vec<String>, String> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).expect("sign");
    svm.send_transaction(tx)
        .map(|meta| meta.logs)
        .map_err(|e| format!("{e:?}"))
}

fn try_send(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction]) -> Result<(), String> {
    try_send_logs(svm, signers, ixs).map(|_| ())
}

fn send(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction], label: &str) {
    if let Err(e) = try_send(svm, signers, ixs) {
        panic!("[{label}] tx failed: {e}");
    }
}

fn expect_code(result: Result<(), String>, code: u32, what: &str) {
    let err = result.expect_err(what);
    assert!(
        err.contains(&format!("Custom({code})")),
        "{what}: expected {code}, got {err}"
    );
}

/// Decodes every Anchor event of type `E` from `Program data:` log lines.
fn events<E: AnchorDeserialize + Discriminator>(logs: &[String]) -> Vec<E> {
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|b64| STANDARD.decode(b64).ok())
        .filter(|data| data.starts_with(E::DISCRIMINATOR))
        .map(|data| E::try_from_slice(&data[E::DISCRIMINATOR.len()..]).expect("event"))
        .collect()
}

fn load_platform(svm: &LiteSVM) -> Platform {
    let account = svm.get_account(&pause::platform_pda()).expect("Platform");
    Platform::try_deserialize(&mut account.data.as_slice()).expect("Platform decodes")
}

/// Overwrites the Platform's raw pause byte, as a devnet account would carry it.
fn write_pause_byte(svm: &mut LiteSVM, value: u8) {
    let mut account = svm.get_account(&pause::platform_pda()).unwrap();
    assert_eq!(account.data.len(), 85);
    account.data[74] = value;
    svm.set_account(pause::platform_pda(), account).unwrap();
}

fn load_programs() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(
        asset_registry::ID,
        include_bytes!("../../../target/deploy/asset_registry.so"),
    )
    .unwrap();
    svm.add_program(
        transfer_hook::ID,
        include_bytes!("../../../target/deploy/transfer_hook.so"),
    )
    .unwrap();
    svm
}

fn init_platform_ix(admin: &Pubkey, treasury: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::InitializePlatform {
            protocol_treasury: treasury,
            protocol_fee_bps: 250,
        }
        .data(),
        acc::InitializePlatform {
            admin: *admin,
            upgrade_authority: *admin,
            program: asset_registry::ID,
            program_data: support::program_data(&asset_registry::ID),
            platform: pause::platform_pda(),
            super_admin_record: pause::admin_pda(admin),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

struct Ctx {
    svm: LiteSVM,
    /// Super admin (`Platform.admin`), also the issuer authority.
    payer: Keypair,
    /// A second, ordinary Admin.
    admin: Keypair,
    /// Holds no role at all.
    outsider: Keypair,
    treasury: Pubkey,
}

/// Loads both programs and bootstraps a Platform — LEFT fully paused.
fn boot() -> Ctx {
    let mut svm = load_programs();
    let payer = Keypair::new();
    let admin = Keypair::new();
    let outsider = Keypair::new();
    for k in [&payer, &admin, &outsider] {
        svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    }
    let treasury = Pubkey::new_unique();
    support::set_upgrade_authority(&mut svm, &asset_registry::ID, Some(payer.pubkey()));
    send(
        &mut svm,
        &[&payer],
        &[init_platform_ix(&payer.pubkey(), treasury)],
        "initialize_platform",
    );
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::AddAdmin {
                new_admin: admin.pubkey(),
            }
            .data(),
            acc::AddAdmin {
                super_admin: payer.pubkey(),
                platform: pause::platform_pda(),
                admin_record: pause::admin_pda(&admin.pubkey()),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "add_admin",
    );
    Ctx {
        svm,
        payer,
        admin,
        outsider,
        treasury,
    }
}

fn set_pause_ix(admin: &Pubkey, paused: bool) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::SetPause { paused }.data(),
        acc::SetPause {
            admin: *admin,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
    )
}

fn set_treasury_ix(super_admin: &Pubkey, new_treasury: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::SetProtocolTreasury { new_treasury }.data(),
        acc::SetProtocolTreasury {
            super_admin: *super_admin,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
    )
}

// ── Onboarding instruction builders (payer = issuer authority) ──────────────

fn issuer_pda() -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::ISSUER_SEED, LEGAL_ENTITY_ID.as_ref()],
        &asset_registry::ID,
    )
    .0
}
fn asset_pda() -> Pubkey {
    Pubkey::find_program_address(
        &[
            asset_registry::ASSET_SEED,
            issuer_pda().as_ref(),
            ASSET_ID.as_bytes(),
        ],
        &asset_registry::ID,
    )
    .0
}
fn share_class_pda() -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::SHARE_CLASS_SEED, asset_pda().as_ref(), &[0]],
        &asset_registry::ID,
    )
    .0
}
fn mint_pda() -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::SHARE_MINT_SEED, share_class_pda().as_ref()],
        &asset_registry::ID,
    )
    .0
}

fn register_issuer_ix(authority: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::RegisterIssuer {
            legal_entity_id: LEGAL_ENTITY_ID,
            jurisdiction: 688,
            kyb_doc_hash: [9; 32],
        }
        .data(),
        acc::RegisterIssuer {
            authority: *authority,
            platform: pause::platform_pda(),
            issuer: issuer_pda(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}
fn verify_kyb_ix(admin: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::VerifyIssuerKyb { approved: true }.data(),
        acc::VerifyIssuerKyb {
            admin: *admin,
            platform: pause::platform_pda(),
            issuer: issuer_pda(),
        }
        .to_account_metas(None),
    )
}
fn create_asset_ix(authority: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::CreateAsset {
            asset_id: ASSET_ID.to_string(),
            asset_type: AssetType::Equity,
            name: "Pause Pilot".to_string(),
            symbol_prefix: "PAUS".to_string(),
            legal_doc_hash: [3; 32],
            jurisdiction_rules: JurisdictionRules {
                allowed_countries: [0; 128],
                max_holders: 0,
                restricted_period_end: 0,
                allow_p2p: true,
            },
        }
        .data(),
        acc::CreateAsset {
            authority: *authority,
            platform: pause::platform_pda(),
            issuer: issuer_pda(),
            asset: asset_pda(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}
fn add_share_class_ix(authority: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::AddShareClass {
            class_index: 0,
            class_type: ShareClassType::Common,
            rights_bitfield: RIGHT_VOTE,
            liq_pref_multiplier_bps: 10_000,
            liq_seniority: 0,
            voting_weight: 1,
            max_supply: None,
            mintable_post_launch: false,
        }
        .data(),
        acc::AddShareClass {
            authority: *authority,
            platform: pause::platform_pda(),
            issuer: issuer_pda(),
            asset: asset_pda(),
            share_class: share_class_pda(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}
fn init_mint_ix(authority: &Pubkey) -> Instruction {
    let mint = mint_pda();
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::InitializeShareClassMint {}.data(),
        acc::InitializeShareClassMint {
            authority: *authority,
            admin_record: pause::admin_pda(authority),
            issuer: issuer_pda(),
            asset: asset_pda(),
            share_class: share_class_pda(),
            mint,
            hook_config: Pubkey::find_program_address(
                &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
                &transfer_hook::ID,
            )
            .0,
            extra_account_meta_list: Pubkey::find_program_address(
                &[transfer_hook::EXTRA_METAS_SEED, mint.as_ref()],
                &transfer_hook::ID,
            )
            .0,
            transfer_hook_program: transfer_hook::ID,
            token_program: TOKEN_2022,
            system_program: system_program::ID,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
    )
}

/// A permissionless secondary-market entry (bit2) that needs only an
/// initialized share-class mint: an empty `create_offer`.
fn create_offer_ix(maker: &Pubkey, payment_mint: &Pubkey, offer_id: u64) -> Instruction {
    let offer = Pubkey::find_program_address(
        &[
            asset_registry::OFFER_SEED,
            share_class_pda().as_ref(),
            &offer_id.to_le_bytes(),
        ],
        &asset_registry::ID,
    )
    .0;
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::CreateOffer {
            offer_id,
            amount: 1,
            price: 1,
            expires_at: 0,
        }
        .data(),
        acc::CreateOffer {
            maker: *maker,
            share_class: share_class_pda(),
            mint: mint_pda(),
            payment_mint: *payment_mint,
            offer,
            escrow: Pubkey::find_program_address(
                &[asset_registry::ESCROW_SEED, offer.as_ref()],
                &asset_registry::ID,
            )
            .0,
            escrow_marker: Pubkey::find_program_address(
                &[asset_registry::ESCROW_MARKER_SEED, offer.as_ref()],
                &asset_registry::ID,
            )
            .0,
            token_program: TOKEN_2022,
            system_program: system_program::ID,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
    )
}

fn create_payment_mint(svm: &mut LiteSVM, payer: &Keypair) -> Pubkey {
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
        token_ix::initialize_mint2(&TOKEN_2022, &mint.pubkey(), &payer.pubkey(), None, 6).unwrap();
    send(svm, &[payer, &mint], &[create, init], "create payment mint");
    mint.pubkey()
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn fresh_platform_starts_fully_paused_in_the_old_layout() {
    let ctx = boot();
    let account = ctx.svm.get_account(&pause::platform_pda()).unwrap();
    assert_eq!(account.data.len(), 85, "no layout size change");
    assert_eq!(
        account.data[74], PAUSE_FLAGS_ALL,
        "byte 74 carries the flags"
    );
    assert_eq!(PAUSE_FLAGS_ALL, 0x3F);
    let platform = load_platform(&ctx.svm);
    assert_eq!(platform.pause_flags, 0x3F);
    assert_eq!(platform.protocol_treasury, ctx.treasury);
    assert_eq!(platform.admin, ctx.payer.pubkey());
}

#[test]
fn initialize_platform_rejects_a_default_treasury() {
    let mut svm = load_programs();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    support::set_upgrade_authority(&mut svm, &asset_registry::ID, Some(payer.pubkey()));
    expect_code(
        try_send(
            &mut svm,
            &[&payer],
            &[init_platform_ix(&payer.pubkey(), Pubkey::default())],
        ),
        6120,
        "default treasury",
    );
    assert!(svm.get_account(&pause::platform_pda()).is_none());
}

#[test]
fn admins_set_bits_that_combine_and_only_the_super_admin_clears() {
    let mut ctx = boot();
    pause::unpause_all(&mut ctx.svm, &ctx.payer);

    // Any Admin may SET; concurrent pauses combine instead of overwriting.
    pause::set_pause_flags(&mut ctx.svm, &ctx.admin, PAUSE_SECONDARY, 0).unwrap();
    assert_eq!(pause::pause_flags(&ctx.svm), 0x04);
    pause::set_pause_flags(&mut ctx.svm, &ctx.admin, PAUSE_CUSTODY_ENTRY, 0).unwrap();
    assert_eq!(
        pause::pause_flags(&ctx.svm),
        0x0C,
        "0x04 | 0x08: nothing wiped"
    );
    // Setting an already-set bit is an idempotent no-op.
    pause::set_pause_flags(&mut ctx.svm, &ctx.admin, PAUSE_SECONDARY, 0).unwrap();
    assert_eq!(pause::pause_flags(&ctx.svm), 0x0C);

    // An ordinary Admin may never CLEAR, not even with a set in the same call.
    expect_code(
        pause::set_pause_flags(&mut ctx.svm, &ctx.admin, 0, PAUSE_SECONDARY),
        6119,
        "admin clear",
    );
    expect_code(
        pause::set_pause_flags(&mut ctx.svm, &ctx.admin, PAUSE_PRIMARY, PAUSE_SECONDARY),
        6119,
        "admin set+clear",
    );
    assert_eq!(pause::pause_flags(&ctx.svm), 0x0C);

    // Someone else's record never stands in for the signer's own: the seeds
    // constraint (`["admin", authority]`) rejects it before the handler, for
    // an Admin borrowing the super admin's record and an outsider borrowing
    // an active Admin's record alike.
    let foreign_record = |signer: &Keypair, record_of: &Pubkey| {
        let mut ix = pause::set_pause_flags_ix(&signer.pubkey(), PAUSE_PRIMARY, 0);
        ix.accounts[1].pubkey = pause::admin_pda(record_of);
        ix
    };
    expect_code(
        try_send(
            &mut ctx.svm,
            &[&ctx.admin],
            &[foreign_record(&ctx.admin, &ctx.payer.pubkey())],
        ),
        2006,
        "admin with the super admin's record",
    );
    expect_code(
        try_send(
            &mut ctx.svm,
            &[&ctx.outsider],
            &[foreign_record(&ctx.outsider, &ctx.admin.pubkey())],
        ),
        2006,
        "outsider with an Admin's record",
    );
    assert_eq!(pause::pause_flags(&ctx.svm), 0x0C);

    // No Admin record at all → Unauthorized, for set and for clear.
    expect_code(
        pause::set_pause_flags(&mut ctx.svm, &ctx.outsider, PAUSE_PRIMARY, 0),
        6001,
        "outsider set",
    );
    expect_code(
        pause::set_pause_flags(&mut ctx.svm, &ctx.outsider, 0, PAUSE_SECONDARY),
        6001,
        "outsider clear",
    );

    // Undefined set bits, or a bit both set and cleared → InvalidPauseFlags.
    expect_code(
        pause::set_pause_flags(&mut ctx.svm, &ctx.payer, 0x40, 0),
        6118,
        "undefined set bit",
    );
    expect_code(
        pause::set_pause_flags(&mut ctx.svm, &ctx.admin, 0x80, 0),
        6118,
        "undefined set bit (admin)",
    );
    expect_code(
        pause::set_pause_flags(&mut ctx.svm, &ctx.payer, PAUSE_PRIMARY, PAUSE_PRIMARY),
        6118,
        "overlapping masks",
    );

    // The super admin clears — here one bit, leaving the other Admin's pause.
    let logs = try_send_logs(
        &mut ctx.svm,
        &[&ctx.payer],
        &[pause::set_pause_flags_ix(
            &ctx.payer.pubkey(),
            PAUSE_PRIMARY,
            PAUSE_SECONDARY,
        )],
    )
    .unwrap();
    assert_eq!(pause::pause_flags(&ctx.svm), 0x0A, "(0x0C | 0x02) & !0x04");
    let changed = events::<PauseFlagsChanged>(&logs);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].old, 0x0C);
    assert_eq!(changed[0].new, 0x0A);
    assert_eq!(changed[0].by, ctx.payer.pubkey());

    // An Admin's pause emits the event too.
    let logs = try_send_logs(
        &mut ctx.svm,
        &[&ctx.admin],
        &[pause::set_pause_flags_ix(
            &ctx.admin.pubkey(),
            PAUSE_DISTRIBUTIONS,
            0,
        )],
    )
    .unwrap();
    let changed = events::<PauseFlagsChanged>(&logs);
    assert_eq!(
        (changed[0].old, changed[0].new, changed[0].by),
        (0x0A, 0x1A, ctx.admin.pubkey())
    );

    // Undefined bits already in the byte (e.g. a future program's) gate
    // nothing and only the super admin can normalize them away.
    write_pause_byte(&mut ctx.svm, 0xCC);
    expect_code(
        pause::set_pause_flags(&mut ctx.svm, &ctx.admin, 0, 0xC0),
        6119,
        "admin cannot clear undefined bits",
    );
    pause::set_pause_flags(&mut ctx.svm, &ctx.payer, 0, 0xC0).unwrap();
    assert_eq!(pause::pause_flags(&ctx.svm), 0x0C);

    // A removed Admin loses the right to pause.
    send(
        &mut ctx.svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::RemoveAdmin {
                admin: ctx.admin.pubkey(),
            }
            .data(),
            acc::RemoveAdmin {
                super_admin: ctx.payer.pubkey(),
                platform: pause::platform_pda(),
                admin_record: pause::admin_pda(&ctx.admin.pubkey()),
            }
            .to_account_metas(None),
        )],
        "remove_admin",
    );
    expect_code(
        pause::set_pause_flags(&mut ctx.svm, &ctx.admin, PAUSE_PRIMARY, 0),
        6001,
        "removed admin",
    );

    // The super admin needs no Admin record of its own (Platform.admin is
    // checked first): drop its record and it still pauses and resumes.
    let super_record = pause::admin_pda(&ctx.payer.pubkey());
    let mut gone = ctx.svm.get_account(&super_record).unwrap();
    gone.lamports = 0;
    gone.data = vec![];
    gone.owner = system_program::ID;
    ctx.svm.set_account(super_record, gone).unwrap();
    pause::set_pause_flags(&mut ctx.svm, &ctx.payer, PAUSE_FLAGS_ALL, 0).unwrap();
    assert_eq!(pause::pause_flags(&ctx.svm), 0x3F);
    pause::unpause_all(&mut ctx.svm, &ctx.payer);
}

#[test]
fn set_pause_bool_touches_only_the_onboarding_bit() {
    let mut ctx = boot();
    pause::pause_only(&mut ctx.svm, &ctx.payer, 0x06);

    let logs = try_send_logs(
        &mut ctx.svm,
        &[&ctx.payer],
        &[set_pause_ix(&ctx.payer.pubkey(), true)],
    )
    .unwrap();
    assert_eq!(pause::pause_flags(&ctx.svm), 0x07);
    let changed = events::<PauseFlagsChanged>(&logs);
    assert_eq!((changed[0].old, changed[0].new), (0x06, 0x07));

    send(
        &mut ctx.svm,
        &[&ctx.payer],
        &[set_pause_ix(&ctx.payer.pubkey(), false)],
        "set_pause(false)",
    );
    assert_eq!(pause::pause_flags(&ctx.svm), 0x06, "other bits untouched");

    // Still super-admin only — an ordinary Admin gets Unauthorized.
    expect_code(
        try_send(
            &mut ctx.svm,
            &[&ctx.admin],
            &[set_pause_ix(&ctx.admin.pubkey(), true)],
        ),
        6001,
        "admin set_pause",
    );
    expect_code(
        try_send(
            &mut ctx.svm,
            &[&ctx.outsider],
            &[set_pause_ix(&ctx.outsider.pubkey(), false)],
        ),
        6001,
        "outsider set_pause",
    );
    assert_eq!(pause::pause_flags(&ctx.svm), 0x06);
}

#[test]
fn onboarding_is_gated_by_bit0_only() {
    let mut ctx = boot();
    let authority = ctx.payer.pubkey();
    let steps: [(&str, Instruction); 4] = [
        ("register_issuer", register_issuer_ix(&authority)),
        ("create_asset", create_asset_ix(&authority)),
        ("add_share_class", add_share_class_ix(&authority)),
        ("initialize_share_class_mint", init_mint_ix(&authority)),
    ];
    for (i, (label, ix)) in steps.iter().enumerate() {
        pause::pause_only(&mut ctx.svm, &ctx.payer, PAUSE_ONBOARDING);
        pause::assert_paused(
            try_send(&mut ctx.svm, &[&ctx.payer], std::slice::from_ref(ix)),
            label,
        );
        // Every OTHER bit paused: onboarding proceeds.
        pause::pause_only(
            &mut ctx.svm,
            &ctx.payer,
            PAUSE_FLAGS_ALL & !PAUSE_ONBOARDING,
        );
        send(&mut ctx.svm, &[&ctx.payer], std::slice::from_ref(ix), label);
        if i == 0 {
            // KYB review stays available during any pause.
            pause::pause_only(&mut ctx.svm, &ctx.payer, PAUSE_FLAGS_ALL);
            send(
                &mut ctx.svm,
                &[&ctx.payer],
                &[verify_kyb_ix(&authority)],
                "verify_issuer_kyb",
            );
        }
    }
    let platform = load_platform(&ctx.svm);
    assert_eq!(platform.issuers_count, 1);
    assert!(ctx.svm.get_account(&mint_pda()).is_some());
}

#[test]
fn legacy_pause_bytes_keep_their_meaning_and_rollback_is_reachable() {
    let mut ctx = boot();
    let authority = ctx.payer.pubkey();
    pause::unpause_all(&mut ctx.svm, &ctx.payer);
    for (label, ix) in [
        ("register_issuer", register_issuer_ix(&authority)),
        ("verify_issuer_kyb", verify_kyb_ix(&authority)),
        ("create_asset", create_asset_ix(&authority)),
        ("add_share_class", add_share_class_ix(&authority)),
        ("initialize_share_class_mint", init_mint_ix(&authority)),
    ] {
        send(&mut ctx.svm, &[&ctx.payer], &[ix], label);
    }
    let payment_mint = create_payment_mint(&mut ctx.svm, &ctx.payer);

    // Devnet-shaped account, byte 74 = 1 (the old `paused = true`): the new
    // program decodes it and gates ONLY onboarding.
    write_pause_byte(&mut ctx.svm, 1);
    assert_eq!(load_platform(&ctx.svm).pause_flags, 1);
    let second_issuer = Keypair::new();
    ctx.svm
        .airdrop(&second_issuer.pubkey(), 10_000_000_000)
        .unwrap();
    let mut second = register_issuer_ix(&second_issuer.pubkey());
    let other_id = *b"PAUSE-FLAGS-ENTITY-0000000000002";
    second.data = ixd::RegisterIssuer {
        legal_entity_id: other_id,
        jurisdiction: 688,
        kyb_doc_hash: [9; 32],
    }
    .data();
    second.accounts[2].pubkey = Pubkey::find_program_address(
        &[asset_registry::ISSUER_SEED, other_id.as_ref()],
        &asset_registry::ID,
    )
    .0;
    pause::assert_paused(
        try_send(&mut ctx.svm, &[&second_issuer], &[second.clone()]),
        "legacy byte 1 pauses onboarding",
    );
    send(
        &mut ctx.svm,
        &[&ctx.payer],
        &[create_offer_ix(&authority, &payment_mint, 1)],
        "legacy byte 1 leaves trading open",
    );

    // Byte 0 (today's devnet value): nothing paused.
    write_pause_byte(&mut ctx.svm, 0);
    send(&mut ctx.svm, &[&second_issuer], &[second], "legacy byte 0");

    // Rollback precondition: the OLD binary decodes `paused` as a borsh bool,
    // which rejects any byte above 1. After the super admin clears 0xFE the
    // byte is back to 0/1 and the old layout decodes again.
    #[derive(AnchorDeserialize)]
    #[allow(dead_code)]
    struct LegacyPlatform {
        admin: Pubkey,
        protocol_treasury: Pubkey,
        protocol_fee_bps: u16,
        paused: bool,
        issuers_count: u64,
        version: u8,
        bump: u8,
    }
    let legacy = |svm: &LiteSVM| {
        let data = svm.get_account(&pause::platform_pda()).unwrap().data;
        LegacyPlatform::try_from_slice(&data[8..])
    };
    pause::set_pause_flags(&mut ctx.svm, &ctx.admin, PAUSE_FLAGS_ALL, 0).unwrap();
    assert_eq!(pause::pause_flags(&ctx.svm), 0x3F);
    assert!(legacy(&ctx.svm).is_err(), "0x3F is not a borsh bool");
    pause::set_pause_flags(&mut ctx.svm, &ctx.payer, 0, 0xFE).unwrap();
    assert_eq!(pause::pause_flags(&ctx.svm), 0x01);
    let old = legacy(&ctx.svm).expect("old layout decodes after normalization");
    assert!(old.paused, "bit0 == the old onboarding pause");
    assert_eq!(old.issuers_count, 2);
}

#[test]
fn super_admin_rotates_the_protocol_treasury() {
    let mut ctx = boot();
    let new_treasury = Pubkey::new_unique();

    expect_code(
        try_send(
            &mut ctx.svm,
            &[&ctx.payer],
            &[set_treasury_ix(&ctx.payer.pubkey(), Pubkey::default())],
        ),
        6120,
        "default treasury",
    );
    expect_code(
        try_send(
            &mut ctx.svm,
            &[&ctx.admin],
            &[set_treasury_ix(&ctx.admin.pubkey(), new_treasury)],
        ),
        6001,
        "ordinary admin",
    );
    expect_code(
        try_send(
            &mut ctx.svm,
            &[&ctx.outsider],
            &[set_treasury_ix(&ctx.outsider.pubkey(), new_treasury)],
        ),
        6001,
        "outsider",
    );
    assert_eq!(load_platform(&ctx.svm).protocol_treasury, ctx.treasury);

    // Works during a full pause (administration is never gated).
    assert_eq!(pause::pause_flags(&ctx.svm), PAUSE_FLAGS_ALL);
    let logs = try_send_logs(
        &mut ctx.svm,
        &[&ctx.payer],
        &[set_treasury_ix(&ctx.payer.pubkey(), new_treasury)],
    )
    .unwrap();
    let platform = load_platform(&ctx.svm);
    assert_eq!(platform.protocol_treasury, new_treasury);
    assert_eq!(platform.pause_flags, PAUSE_FLAGS_ALL, "flags untouched");
    let changed = events::<ProtocolTreasuryChanged>(&logs);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].old, ctx.treasury);
    assert_eq!(changed[0].new, new_treasury);
    assert_eq!(changed[0].by, ctx.payer.pubkey());

    // Re-setting the same value is an idempotent success.
    send(
        &mut ctx.svm,
        &[&ctx.payer],
        &[set_treasury_ix(&ctx.payer.pubkey(), new_treasury)],
        "idempotent",
    );
}

#[test]
fn every_defined_bit_is_distinct() {
    let bits = [
        PAUSE_ONBOARDING,
        PAUSE_PRIMARY,
        PAUSE_SECONDARY,
        PAUSE_CUSTODY_ENTRY,
        PAUSE_DISTRIBUTIONS,
        PAUSE_ISSUER_PROCEEDS,
    ];
    let mut all = 0u8;
    for bit in bits {
        assert_eq!(bit.count_ones(), 1);
        assert_eq!(all & bit, 0);
        all |= bit;
    }
    assert_eq!(all, PAUSE_FLAGS_ALL);
}

#[test]
fn both_programs_embed_security_txt() {
    const MARKER: &[u8] = b"=======BEGIN SECURITY.TXT V1=======\0";
    for (name, so) in [
        (
            "asset_registry",
            &include_bytes!("../../../target/deploy/asset_registry.so")[..],
        ),
        (
            "transfer_hook",
            &include_bytes!("../../../target/deploy/transfer_hook.so")[..],
        ),
    ] {
        let at = so
            .windows(MARKER.len())
            .position(|w| w == MARKER)
            .unwrap_or_else(|| panic!("{name}.so carries no security.txt"));
        let body = &so[at..(at + 1024).min(so.len())];
        let text = String::from_utf8_lossy(body);
        assert!(text.contains("security@mancipatio.io"), "{name}: contact");
        assert!(
            text.contains("https://www.manci.io/security"),
            "{name}: policy"
        );
        assert!(text.contains(&format!("Manci {name}")), "{name}: name");
    }
}
