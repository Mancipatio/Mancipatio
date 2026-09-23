//! `SaleApproval` (package 2B): an Admin approves exactly one sale
//! `(share_class, sale_id)` within a payment mint, price range, maximum gross
//! raise, raise type and expiry; `open_sale` consumes and closes it (rent to
//! the approver); any Admin may revoke an unused one. Also pins the
//! `mint_to_treasury` rule that closes the "mint, then sell OTC" bypass:
//! the treasury destination needs an Admin issuer key.

#[path = "../../../tests/support/pause.rs"]
mod pause;
#[path = "../../../tests/support/sale_approval.rs"]
mod sale_approval;
#[path = "../../../tests/support/mod.rs"]
mod support;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    asset_registry::{
        accounts as acc, instruction as ixd, state::*, RIGHT_DIVIDEND, RIGHT_VOTE,
        SALE_APPROVAL_MAX_TTL_SECS, SALE_STATE_VERSION,
    },
    litesvm::LiteSVM,
    sale_approval::{sale_approval_pda, sale_pda, Terms},
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
/// A fixed, comfortably non-zero chain time for every test.
const T0: i64 = 1_800_000_000;

fn send(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction], label: &str) {
    if let Err(e) = try_send(svm, signers, ixs) {
        panic!("[{label}] tx failed: {e}");
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
fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}
fn lamports(svm: &LiteSVM, key: &Pubkey) -> u64 {
    svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
}
fn token_balance(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    let a = svm.get_account(ata).expect("ata missing");
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}
/// The failure is the registry's custom error `code` with Anchor name `name`.
fn assert_error(result: Result<(), String>, code: u32, name: &str) {
    let err = result.expect_err(name);
    assert!(
        err.contains(&format!("Custom({code})")) && err.contains(&format!("Error Code: {name}")),
        "expected {name} ({code}), got {err}"
    );
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

/// Keys after boot. `payer` is the super admin (with an Admin record) AND the
/// issuer authority; `admin2` is a second Admin who is not the issuer.
struct Env {
    payer: Keypair,
    admin2: Keypair,
    stranger: Keypair,
    issuer: Pubkey,
    asset: Pubkey,
    share_class: Pubkey,
    mint: Pubkey,
    payment_mint: Pubkey,
}

fn platform() -> Pubkey {
    pause::platform_pda()
}

fn add_admin_ix(super_admin: &Pubkey, new_admin: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::AddAdmin {
            new_admin: *new_admin,
        }
        .data(),
        acc::AddAdmin {
            super_admin: *super_admin,
            platform: platform(),
            admin_record: pause::admin_pda(new_admin),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn remove_admin_ix(super_admin: &Pubkey, admin: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::RemoveAdmin { admin: *admin }.data(),
        acc::RemoveAdmin {
            super_admin: *super_admin,
            platform: platform(),
            admin_record: pause::admin_pda(admin),
        }
        .to_account_metas(None),
    )
}

fn verify_issuer_ix(admin: &Pubkey, issuer: &Pubkey, approved: bool) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::VerifyIssuerKyb { approved }.data(),
        acc::VerifyIssuerKyb {
            admin: *admin,
            platform: platform(),
            issuer: *issuer,
        }
        .to_account_metas(None),
    )
}

fn create_asset_ix(authority: &Pubkey, issuer: &Pubkey, asset_id: &str) -> (Instruction, Pubkey) {
    let asset = Pubkey::find_program_address(
        &[
            asset_registry::ASSET_SEED,
            issuer.as_ref(),
            asset_id.as_bytes(),
        ],
        &asset_registry::ID,
    )
    .0;
    let ix = Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::CreateAsset {
            asset_id: asset_id.to_string(),
            asset_type: AssetType::Equity,
            name: "Approval Test Round".to_string(),
            symbol_prefix: "APPR".to_string(),
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
            authority: *authority,
            platform: platform(),
            issuer: *issuer,
            asset,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    (ix, asset)
}

fn boot() -> (LiteSVM, Env) {
    let mut svm = LiteSVM::new();
    svm.add_program(
        asset_registry::ID,
        include_bytes!("../../../target/deploy/asset_registry.so"),
    )
    .unwrap();
    svm.add_program(
        transfer_hook::id(),
        include_bytes!("../../../target/deploy/transfer_hook.so"),
    )
    .unwrap();
    warp_to(&mut svm, T0);

    let payer = Keypair::new();
    let admin2 = Keypair::new();
    let stranger = Keypair::new();
    for k in [&payer, &admin2, &stranger] {
        svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    }
    let legal_entity_id: [u8; 32] = *b"SALE-APPROVAL-TEST-ENTITY-000001";
    let issuer = Pubkey::find_program_address(
        &[asset_registry::ISSUER_SEED, legal_entity_id.as_ref()],
        &asset_registry::ID,
    )
    .0;

    support::set_upgrade_authority(&mut svm, &asset_registry::ID, Some(payer.pubkey()));
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::InitializePlatform {
                protocol_treasury: Pubkey::new_unique(),
                protocol_fee_bps: 250,
            }
            .data(),
            acc::InitializePlatform {
                admin: payer.pubkey(),
                upgrade_authority: payer.pubkey(),
                program: asset_registry::ID,
                program_data: support::program_data(&asset_registry::ID),
                platform: platform(),
                super_admin_record: pause::admin_pda(&payer.pubkey()),
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
        &[add_admin_ix(&payer.pubkey(), &admin2.pubkey())],
        "add admin2",
    );

    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::RegisterIssuer {
                legal_entity_id,
                jurisdiction: 222,
                kyb_doc_hash: [9u8; 32],
            }
            .data(),
            acc::RegisterIssuer {
                authority: payer.pubkey(),
                platform: platform(),
                issuer,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "register_issuer",
    );
    send(
        &mut svm,
        &[&payer],
        &[verify_issuer_ix(&payer.pubkey(), &issuer, true)],
        "verify_issuer_kyb",
    );
    let (create, asset) = create_asset_ix(&payer.pubkey(), &issuer, "approval-001");
    send(&mut svm, &[&payer], &[create], "create_asset");

    let share_class = Pubkey::find_program_address(
        &[asset_registry::SHARE_CLASS_SEED, asset.as_ref(), &[0u8]],
        &asset_registry::ID,
    )
    .0;
    let mint = Pubkey::find_program_address(
        &[asset_registry::SHARE_MINT_SEED, share_class.as_ref()],
        &asset_registry::ID,
    )
    .0;
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::AddShareClass {
                class_index: 0,
                class_type: ShareClassType::Common,
                rights_bitfield: RIGHT_VOTE | RIGHT_DIVIDEND,
                liq_pref_multiplier_bps: 10_000,
                liq_seniority: 0,
                voting_weight: 1,
                max_supply: None,
                mintable_post_launch: false,
            }
            .data(),
            acc::AddShareClass {
                authority: payer.pubkey(),
                platform: platform(),
                issuer,
                asset,
                share_class,
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
            asset_registry::ID,
            &ixd::InitializeShareClassMint {}.data(),
            acc::InitializeShareClassMint {
                authority: payer.pubkey(),
                admin_record: pause::admin_pda(&payer.pubkey()),
                issuer,
                asset,
                share_class,
                mint,
                hook_config: Pubkey::find_program_address(
                    &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
                    &transfer_hook::id(),
                )
                .0,
                extra_account_meta_list: Pubkey::find_program_address(
                    &[transfer_hook::EXTRA_METAS_SEED, mint.as_ref()],
                    &transfer_hook::id(),
                )
                .0,
                transfer_hook_program: transfer_hook::id(),
                token_program: TOKEN_2022,
                system_program: system_program::ID,
                platform: platform(),
            }
            .to_account_metas(None),
        )],
        "initialize_share_class_mint",
    );
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::ActivateAsset {}.data(),
            acc::ActivateAsset {
                authority: payer.pubkey(),
                admin_record: pause::admin_pda(&payer.pubkey()),
                issuer,
                asset,
            }
            .to_account_metas(None),
        )],
        "activate_asset",
    );
    let payment_mint = create_mint(&mut svm, &payer, 6);

    (
        svm,
        Env {
            payer,
            admin2,
            stranger,
            issuer,
            asset,
            share_class,
            mint,
            payment_mint,
        },
    )
}

/// Default terms: 100 units at exactly 10 base units each, Mature, 1 day.
fn terms(svm: &LiteSVM) -> Terms {
    Terms::covering(svm, 10, 100, RaiseType::Mature)
}

fn approve(
    svm: &mut LiteSVM,
    env: &Env,
    admin: &Keypair,
    sale_id: u64,
    t: Terms,
) -> Result<Pubkey, String> {
    sale_approval::try_approve_sale(
        svm,
        admin,
        &env.issuer,
        &env.asset,
        &env.share_class,
        &env.payment_mint,
        sale_id,
        t,
    )
}

/// Everything `open_sale` needs beyond the id and the economic arguments.
struct OpenArgs {
    sale_id: u64,
    price: u64,
    total: u64,
    raise_type: RaiseType,
    payment_mint: Pubkey,
    approval: Pubkey,
    approved_by: Pubkey,
}

impl OpenArgs {
    fn new(env: &Env, sale_id: u64, price: u64, total: u64, approved_by: &Keypair) -> Self {
        Self {
            sale_id,
            price,
            total,
            raise_type: RaiseType::Mature,
            payment_mint: env.payment_mint,
            approval: sale_approval_pda(&env.share_class, sale_id),
            approved_by: approved_by.pubkey(),
        }
    }
}

fn open_sale_ix(env: &Env, a: &OpenArgs) -> Instruction {
    let sale = sale_pda(&env.share_class, a.sale_id);
    let (cliff_months, vesting_months) = match a.raise_type {
        RaiseType::Mature => (0, 0),
        RaiseType::Startup => (0, 12),
    };
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::OpenSale {
            sale_id: a.sale_id,
            price_per_unit: a.price,
            total_for_sale: a.total,
            start_ts: 0,
            end_ts: 0,
            raise_type: a.raise_type,
            cliff_months,
            vesting_months,
        }
        .data(),
        acc::OpenSale {
            authority: env.payer.pubkey(),
            issuer: env.issuer,
            asset: env.asset,
            share_class: env.share_class,
            mint: env.mint,
            payment_mint: a.payment_mint,
            sale,
            proceeds: Pubkey::find_program_address(
                &[asset_registry::PROCEEDS_SEED, sale.as_ref()],
                &asset_registry::ID,
            )
            .0,
            payment_token_program: TOKEN_2022,
            system_program: system_program::ID,
            sale_approval: a.approval,
            approved_by: a.approved_by,
            platform: platform(),
        }
        .to_account_metas(None),
    )
}

fn try_open(svm: &mut LiteSVM, env: &Env, a: &OpenArgs) -> Result<(), String> {
    try_send(svm, &[&env.payer], &[open_sale_ix(env, a)])
}

// ── approve_sale: authorization ─────────────────────────────────────────────

#[test]
fn approve_requires_a_live_admin_record() {
    let (mut svm, env) = boot();
    let t = terms(&svm);

    // A stranger has no Admin record at all.
    let err = approve(&mut svm, &env, &env.stranger, 1, t).unwrap_err();
    assert!(err.contains("Custom(3012)"), "non-admin: {err}");

    // A removed Admin is no longer one.
    let admin3 = Keypair::new();
    svm.airdrop(&admin3.pubkey(), 10_000_000_000).unwrap();
    send(
        &mut svm,
        &[&env.payer],
        &[add_admin_ix(&env.payer.pubkey(), &admin3.pubkey())],
        "add admin3",
    );
    send(
        &mut svm,
        &[&env.payer],
        &[remove_admin_ix(&env.payer.pubkey(), &admin3.pubkey())],
        "remove admin3",
    );
    let err = approve(&mut svm, &env, &admin3, 1, t).unwrap_err();
    assert!(err.contains("Custom(3012)"), "removed admin: {err}");
    assert!(sale_approval::is_closed(
        &svm,
        &sale_approval_pda(&env.share_class, 1)
    ));

    // Any Admin (not only the super admin, and not the issuer) may approve.
    let approval = approve(&mut svm, &env, &env.admin2, 1, t).expect("admin2 approves");
    let stored: SaleApproval = load(&svm, &approval);
    assert_eq!(stored.share_class, env.share_class);
    assert_eq!(stored.sale_id, 1);
    assert_eq!(stored.issuer, env.issuer);
    assert_eq!(stored.payment_mint, env.payment_mint);
    assert_eq!(stored.max_gross_raise, 1_000);
    assert_eq!(stored.min_price_per_unit, 10);
    assert_eq!(stored.max_price_per_unit, 10);
    assert_eq!(stored.raise_type, RaiseType::Mature);
    assert_eq!(stored.expires_at, t.expires_at);
    assert_eq!(stored.application_hash, [7u8; 32]);
    assert_eq!(stored.approved_by, env.admin2.pubkey());
    assert_eq!(stored.version, asset_registry::STATE_VERSION);
    // The launchpad lists approvals by memcmp(issuer @ 48) and dataSize 211.
    let raw = svm.get_account(&approval).unwrap();
    assert_eq!(raw.data.len(), 211);
    assert_eq!(&raw.data[48..80], env.issuer.as_ref());
}

// ── approve_sale: validation ────────────────────────────────────────────────

#[test]
fn approve_validates_terms() {
    let (mut svm, env) = boot();
    let base = terms(&svm);
    let t_now = now(&svm);
    let bad = |f: &dyn Fn(&mut Terms)| {
        let mut t = base;
        f(&mut t);
        t
    };
    let invalid = [
        ("expiry now", bad(&|t| t.expires_at = t_now)),
        ("expiry past", bad(&|t| t.expires_at = t_now - 1)),
        (
            "expiry over 90 days",
            bad(&|t| t.expires_at = t_now + SALE_APPROVAL_MAX_TTL_SECS + 1),
        ),
        ("min price 0", bad(&|t| t.min_price_per_unit = 0)),
        (
            "min > max",
            bad(&|t| {
                t.min_price_per_unit = 11;
                t.max_price_per_unit = 10;
            }),
        ),
        ("max gross 0", bad(&|t| t.max_gross_raise = 0)),
        ("zero hash", bad(&|t| t.application_hash = [0u8; 32])),
    ];
    for (what, t) in invalid {
        let err = approve(&mut svm, &env, &env.payer, 1, t).unwrap_err();
        assert!(
            err.contains("Custom(6126)") && err.contains("InvalidSaleApproval"),
            "{what}: {err}"
        );
    }
    // Exactly 90 days is allowed.
    approve(
        &mut svm,
        &env,
        &env.payer,
        1,
        bad(&|t| t.expires_at = t_now + SALE_APPROVAL_MAX_TTL_SECS),
    )
    .expect("90 days exactly");

    // The same PDA cannot be approved twice while the first one lives.
    let err = approve(&mut svm, &env, &env.admin2, 1, base).unwrap_err();
    assert!(err.contains("already in use"), "second approval: {err}");
}

#[test]
fn approve_rejects_unverified_issuer_foreign_share_class_and_unsupported_mint() {
    let (mut svm, env) = boot();
    let t = terms(&svm);

    // Unverified issuer.
    send(
        &mut svm,
        &[&env.payer],
        &[verify_issuer_ix(&env.payer.pubkey(), &env.issuer, false)],
        "revoke KYB",
    );
    assert_error(
        approve(&mut svm, &env, &env.payer, 1, t).map(|_| ()),
        6002,
        "IssuerNotVerified",
    );
    send(
        &mut svm,
        &[&env.payer],
        &[verify_issuer_ix(&env.payer.pubkey(), &env.issuer, true)],
        "restore KYB",
    );

    // A share class of another asset: the share-class seeds use `asset`.
    let (create, other_asset) = create_asset_ix(&env.payer.pubkey(), &env.issuer, "approval-002");
    send(&mut svm, &[&env.payer], &[create], "second asset");
    let err = sale_approval::try_approve_sale(
        &mut svm,
        &env.payer,
        &env.issuer,
        &other_asset,
        &env.share_class,
        &env.payment_mint,
        1,
        t,
    )
    .unwrap_err();
    assert!(
        err.contains("ConstraintSeeds") || err.contains("Unauthorized"),
        "foreign share class: {err}"
    );

    // A payment mint the sale could never use: the share mint itself
    // (TransferHook + PermanentDelegate are refused on a payment leg).
    let err = sale_approval::try_approve_sale(
        &mut svm,
        &env.payer,
        &env.issuer,
        &env.asset,
        &env.share_class,
        &env.mint,
        1,
        t,
    )
    .unwrap_err();
    assert!(
        err.contains("UnsupportedMintExtension"),
        "unsupported payment mint: {err}"
    );
    assert!(sale_approval::is_closed(
        &svm,
        &sale_approval_pda(&env.share_class, 1)
    ));
}

// ── consumption ─────────────────────────────────────────────────────────────

#[test]
fn open_sale_consumes_the_approval_and_refunds_the_approver() {
    let (mut svm, env) = boot();
    let t = terms(&svm);
    let approval = approve(&mut svm, &env, &env.admin2, 1, t).unwrap();
    let rent = lamports(&svm, &approval);
    assert_eq!(rent, svm.minimum_balance_for_rent_exemption(211));
    let admin2_before = lamports(&svm, &env.admin2.pubkey());

    send(
        &mut svm,
        &[&env.payer],
        &[open_sale_ix(
            &env,
            &OpenArgs::new(&env, 1, 10, 100, &env.admin2),
        )],
        "open_sale",
    );
    assert!(sale_approval::is_closed(&svm, &approval), "used up");
    assert_eq!(
        lamports(&svm, &env.admin2.pubkey()),
        admin2_before + rent,
        "the approver (not the issuer) gets exactly the approval's rent"
    );
    let sale: Sale = load(&svm, &sale_pda(&env.share_class, 1));
    assert_eq!(sale.sale_approval, approval);
    assert_eq!(sale.application_hash, t.application_hash);
    assert_eq!(sale.version, SALE_STATE_VERSION);
    assert_eq!(sale.version, 2);
    assert_eq!(sale.price_per_unit, 10);
    assert_eq!(sale.total_for_sale, 100);
    assert_eq!(
        svm.get_account(&sale_pda(&env.share_class, 1))
            .unwrap()
            .data
            .len(),
        286
    );

    // The id is spent: it can never be approved again.
    assert_error(
        approve(&mut svm, &env, &env.payer, 1, t).map(|_| ()),
        6127,
        "SaleIdAlreadyUsed",
    );
}

#[test]
fn issuer_admin_may_be_its_own_approver() {
    // `authority` and `approved_by` may be the same key (Signer and
    // UncheckedAccount are exempt from Anchor's duplicate-mutable check).
    let (mut svm, env) = boot();
    let t = terms(&svm);
    approve(&mut svm, &env, &env.payer, 3, t).unwrap();
    send(
        &mut svm,
        &[&env.payer],
        &[open_sale_ix(
            &env,
            &OpenArgs::new(&env, 3, 10, 100, &env.payer),
        )],
        "self-approved open_sale",
    );
    assert!(sale_approval::is_closed(
        &svm,
        &sale_approval_pda(&env.share_class, 3)
    ));
}

#[test]
fn open_sale_requires_an_approval_for_its_own_id() {
    let (mut svm, env) = boot();
    let t = terms(&svm);

    // No approval at all.
    let err = try_open(&mut svm, &env, &OpenArgs::new(&env, 1, 10, 100, &env.payer)).unwrap_err();
    assert!(
        err.contains("Custom(3012)") && err.contains("sale_approval"),
        "no approval: {err}"
    );

    // An approval for another sale id.
    let approval_5 = approve(&mut svm, &env, &env.payer, 5, t).unwrap();
    let mut args = OpenArgs::new(&env, 6, 10, 100, &env.payer);
    args.approval = approval_5;
    let err = try_open(&mut svm, &env, &args).unwrap_err();
    assert!(err.contains("ConstraintSeeds"), "wrong id: {err}");
    assert!(!sale_approval::is_closed(&svm, &approval_5));
}

#[test]
fn open_sale_enforces_expiry_boundary() {
    let (mut svm, env) = boot();
    let t = terms(&svm);
    approve(&mut svm, &env, &env.payer, 1, t).unwrap();
    let args = OpenArgs::new(&env, 1, 10, 100, &env.payer);

    warp_to(&mut svm, t.expires_at + 1);
    assert_error(try_open(&mut svm, &env, &args), 6122, "SaleApprovalExpired");

    warp_to(&mut svm, t.expires_at);
    try_open(&mut svm, &env, &args).expect("open exactly at expires_at");
}

#[test]
fn open_sale_rejects_mismatched_mint_raise_type_and_rent_recipient() {
    let (mut svm, env) = boot();
    let t = terms(&svm);
    approve(&mut svm, &env, &env.admin2, 1, t).unwrap();

    let other_mint = create_mint(&mut svm, &env.payer, 6);
    let mut args = OpenArgs::new(&env, 1, 10, 100, &env.admin2);
    args.payment_mint = other_mint;
    assert_error(
        try_open(&mut svm, &env, &args),
        6123,
        "SaleApprovalMismatch",
    );

    let mut args = OpenArgs::new(&env, 1, 10, 100, &env.admin2);
    args.raise_type = RaiseType::Startup;
    assert_error(
        try_open(&mut svm, &env, &args),
        6123,
        "SaleApprovalMismatch",
    );

    let args = OpenArgs::new(&env, 1, 10, 100, &env.payer);
    assert_error(
        try_open(&mut svm, &env, &args),
        6123,
        "SaleApprovalMismatch",
    );

    try_open(
        &mut svm,
        &env,
        &OpenArgs::new(&env, 1, 10, 100, &env.admin2),
    )
    .expect("matching terms open");
}

#[test]
fn open_sale_enforces_the_price_range() {
    let (mut svm, env) = boot();
    let t = Terms {
        max_gross_raise: 1_000_000,
        min_price_per_unit: 10,
        max_price_per_unit: 20,
        ..terms(&svm)
    };
    for id in 1..=4 {
        approve(&mut svm, &env, &env.payer, id, t).unwrap();
    }
    assert_error(
        try_open(&mut svm, &env, &OpenArgs::new(&env, 1, 9, 100, &env.payer)),
        6124,
        "SalePriceOutsideApproval",
    );
    assert_error(
        try_open(&mut svm, &env, &OpenArgs::new(&env, 1, 21, 100, &env.payer)),
        6124,
        "SalePriceOutsideApproval",
    );
    // A zero price still fails with the 2A check (6121), before the range.
    assert_error(
        try_open(&mut svm, &env, &OpenArgs::new(&env, 1, 0, 100, &env.payer)),
        6121,
        "InvalidSalePrice",
    );
    try_open(&mut svm, &env, &OpenArgs::new(&env, 1, 10, 100, &env.payer)).expect("min price");
    try_open(&mut svm, &env, &OpenArgs::new(&env, 2, 20, 100, &env.payer)).expect("max price");
}

#[test]
fn open_sale_enforces_the_gross_raise_cap() {
    let (mut svm, env) = boot();
    let t = Terms {
        max_gross_raise: 1_000,
        min_price_per_unit: 1,
        max_price_per_unit: u64::MAX,
        ..terms(&svm)
    };
    approve(&mut svm, &env, &env.payer, 1, t).unwrap();
    // 7 * 143 = 1_001 = max + 1.
    assert_error(
        try_open(&mut svm, &env, &OpenArgs::new(&env, 1, 7, 143, &env.payer)),
        6125,
        "SaleExceedsApprovedRaise",
    );
    // A product past u64::MAX is reported as over the cap, not as Overflow.
    assert_error(
        try_open(
            &mut svm,
            &env,
            &OpenArgs::new(&env, 1, u64::MAX, 2, &env.payer),
        ),
        6125,
        "SaleExceedsApprovedRaise",
    );
    // 8 * 125 = 1_000 = max.
    try_open(&mut svm, &env, &OpenArgs::new(&env, 1, 8, 125, &env.payer)).expect("gross == max");
}

// ── revoke_sale_approval ────────────────────────────────────────────────────

#[test]
fn revoke_by_any_admin_refunds_the_approver() {
    let (mut svm, env) = boot();
    let t = terms(&svm);
    let approval = approve(&mut svm, &env, &env.admin2, 1, t).unwrap();
    let rent = lamports(&svm, &approval);

    // A non-admin cannot revoke.
    let err = sale_approval::try_revoke_sale_approval(
        &mut svm,
        &env.stranger,
        &approval,
        &env.admin2.pubkey(),
    )
    .unwrap_err();
    assert!(err.contains("Custom(3012)"), "non-admin revoke: {err}");

    // The rent recipient is fixed: `approved_by`.
    assert_error(
        sale_approval::try_revoke_sale_approval(
            &mut svm,
            &env.payer,
            &approval,
            &env.payer.pubkey(),
        ),
        6123,
        "SaleApprovalMismatch",
    );

    // Another Admin (the super admin here) revokes admin2's approval, even
    // after it expired.
    warp_to(&mut svm, t.expires_at + 10);
    let admin2_before = lamports(&svm, &env.admin2.pubkey());
    sale_approval::try_revoke_sale_approval(&mut svm, &env.payer, &approval, &env.admin2.pubkey())
        .expect("other admin revokes");
    assert!(sale_approval::is_closed(&svm, &approval));
    assert_eq!(lamports(&svm, &env.admin2.pubkey()), admin2_before + rent);

    // Nothing left to consume.
    warp_to(&mut svm, T0);
    let err = try_open(
        &mut svm,
        &env,
        &OpenArgs::new(&env, 1, 10, 100, &env.admin2),
    )
    .unwrap_err();
    assert!(err.contains("Custom(3012)"), "open after revoke: {err}");

    // The id is free again: it can be re-approved after a revoke.
    let fresh = terms(&svm);
    approve(&mut svm, &env, &env.payer, 1, fresh).expect("re-approve after revoke");
}

// ── emergency pause ─────────────────────────────────────────────────────────

#[test]
fn approve_and_revoke_ignore_the_pause() {
    let (mut svm, env) = boot();
    let payer = env.payer.insecure_clone();
    pause::pause_only(&mut svm, &payer, asset_registry::PAUSE_FLAGS_ALL);
    let t = terms(&svm);
    let approval = approve(&mut svm, &env, &env.admin2, 1, t).expect("approve under full pause");
    // open_sale itself is PRIMARY-gated (the approval exists, so the error is
    // the pause and not AccountNotInitialized).
    pause::assert_paused(
        try_open(
            &mut svm,
            &env,
            &OpenArgs::new(&env, 1, 10, 100, &env.admin2),
        ),
        "open_sale under full pause",
    );
    assert!(!sale_approval::is_closed(&svm, &approval));
    sale_approval::try_revoke_sale_approval(&mut svm, &env.admin2, &approval, &env.admin2.pubkey())
        .expect("revoke under full pause");
    assert!(sale_approval::is_closed(&svm, &approval));
}

// ── mint_to_treasury: the treasury destination needs an Admin issuer key ────

fn treasury_mint_ix(
    env: &Env,
    authority: &Pubkey,
    proof: Pubkey,
    destination: Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::MintToTreasury { amount: 5 }.data(),
        acc::MintToTreasury {
            authority: *authority,
            admin_record: proof,
            issuer: env.issuer,
            asset: env.asset,
            share_class: env.share_class,
            mint: env.mint,
            destination,
            token_program: TOKEN_2022,
            platform: platform(),
        }
        .to_account_metas(None),
    )
}

#[test]
fn admin_issuer_treasury_mint_still_succeeds_but_mint_permission_alone_does_not() {
    let (mut svm, env) = boot();
    let treasury = create_ata(&mut svm, &env.payer, &env.mint, &env.payer.pubkey());
    // The issuer authority holds an Admin record: treasury mint allowed.
    send(
        &mut svm,
        &[&env.payer],
        &[treasury_mint_ix(
            &env,
            &env.payer.pubkey(),
            pause::admin_pda(&env.payer.pubkey()),
            treasury,
        )],
        "admin issuer treasury mint",
    );
    assert_eq!(token_balance(&svm, &treasury), 5);

    // Passing the issuer-permissions PDA instead of the Admin record (with no
    // grant) is still the old Unauthorized, before the treasury rule.
    let permissions = Pubkey::find_program_address(
        &[
            asset_registry::ISSUER_PERMISSIONS_SEED,
            env.issuer.as_ref(),
            env.payer.pubkey().as_ref(),
        ],
        &asset_registry::ID,
    )
    .0;
    let err = try_send(
        &mut svm,
        &[&env.payer],
        &[treasury_mint_ix(
            &env,
            &env.payer.pubkey(),
            permissions,
            treasury,
        )],
    )
    .unwrap_err();
    assert!(err.contains("Unauthorized"), "{err}");

    // With a MINT grant (and no Admin proof), the treasury is refused: 6128.
    send(
        &mut svm,
        &[&env.payer],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::SetIssuerPermissions {
                capabilities: asset_registry::ISSUER_PERMISSION_MINT,
            }
            .data(),
            acc::SetIssuerPermissions {
                super_admin: env.payer.pubkey(),
                platform: platform(),
                issuer: env.issuer,
                permissions,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "grant MINT",
    );
    assert_error(
        try_send(
            &mut svm,
            &[&env.payer],
            &[treasury_mint_ix(
                &env,
                &env.payer.pubkey(),
                permissions,
                treasury,
            )],
        ),
        6128,
        "TreasuryMintRequiresAdmin",
    );
    assert_eq!(token_balance(&svm, &treasury), 5);
}
