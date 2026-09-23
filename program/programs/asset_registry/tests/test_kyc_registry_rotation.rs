//! KYC registry authority rotation and jurisdiction updates (2C-1) — LiteSVM.
//!
//! * the registry ADDRESS is permanent; `authority` rotates via propose/accept
//!   (the per-target `AuthorityTransfer` PDA, `["authority_transfer", registry]`);
//! * approve/revoke take the registry by address and are gated by
//!   `has_one = authority` alone, so a rotated authority keeps working on the
//!   same address and the old one is locked out (Unauthorized);
//! * only the current authority proposes / cancels, only the proposed
//!   authority accepts; there is no super-admin override;
//! * `update_kyc_registry_jurisdictions` replaces both bitmaps whole.
//!
//! The end-to-end checks on a KycGated mint (a jurisdiction block applied
//! live to buy + hook transfer, clawback after rotation) live next to the
//! KycGated fixture in `test_kyc_buy_and_clawback.rs`.

#[path = "../../../tests/support/kyc_registry.rs"]
mod kyc;
#[path = "../../../tests/support/mod.rs"]
mod support;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    asset_registry::{
        accounts as acc, instruction as ixd, AuthorityTransfer, KycEntry, KycRegistry,
        KycRegistryAuthorityChanged, KycRegistryAuthorityProposalCancelled,
        KycRegistryAuthorityProposed, KycRegistryJurisdictionsUpdated, KycStatus,
    },
    kyc::{bitmap, Bitmap},
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const ERR_UNAUTHORIZED: u32 = 6001;
const ERR_INVALID_PROPOSED_AUTHORITY: u32 = 6112;
const ERR_INVALID_AUTHORITY_TRANSFER: u32 = 6113;
const ERR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;
const ERR_CONSTRAINT_SEEDS: u32 = 2006;
const J: u16 = 222;

// ── Harness ──────────────────────────────────────────────────────────────────

struct World {
    svm: LiteSVM,
    /// Fee payer for every tx, so signer balances move only by rent.
    fees: Keypair,
    /// Platform super admin (co-signs `create_kyc_registry`).
    admin: Keypair,
    /// Creating KYC authority — the registry address derives from it.
    a: Keypair,
    b: Keypair,
    c: Keypair,
    registry: Pubkey,
}

fn funded(svm: &mut LiteSVM) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    k
}

fn try_send_logs(
    svm: &mut LiteSVM,
    fees: &Keypair,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<Vec<String>, String> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&fees.pubkey()), &svm.latest_blockhash());
    let mut all: Vec<&Keypair> = vec![fees];
    all.extend(
        signers
            .iter()
            .copied()
            .filter(|s| s.pubkey() != fees.pubkey()),
    );
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).expect("sign");
    svm.send_transaction(tx)
        .map(|meta| meta.logs)
        .map_err(|e| format!("{e:?}"))
}

impl World {
    fn try_send(&mut self, signer: &Keypair, ix: Instruction) -> Result<Vec<String>, String> {
        try_send_logs(&mut self.svm, &self.fees, &[signer], &[ix])
    }

    fn send(&mut self, signer: &Keypair, ix: Instruction, label: &str) -> Vec<String> {
        self.try_send(signer, ix)
            .unwrap_or_else(|e| panic!("[{label}] tx failed: {e}"))
    }

    fn expect_code(&mut self, signer: &Keypair, ix: Instruction, code: u32, what: &str) {
        let err = self.try_send(signer, ix).expect_err(what);
        assert!(
            err.contains(&format!("Custom({code})")),
            "{what}: expected {code}, got {err}"
        );
    }

    fn registry(&self) -> KycRegistry {
        load(&self.svm, &self.registry)
    }

    fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map_or(0, |a| a.lamports)
    }

    fn is_closed(&self, key: &Pubkey) -> bool {
        self.svm
            .get_account(key)
            .is_none_or(|a| a.lamports == 0 && a.data.is_empty())
    }

    fn approve(&mut self, who: &Keypair, holder: &Pubkey) -> Result<Vec<String>, String> {
        let registry = self.registry;
        self.try_send(who, kyc::approve_ix(&who.pubkey(), &registry, holder, J))
    }

    fn revoke(&mut self, who: &Keypair, holder: &Pubkey) -> Result<Vec<String>, String> {
        let registry = self.registry;
        self.try_send(who, kyc::revoke_ix(&who.pubkey(), &registry, holder))
    }

    /// Clones a keypair field so it can sign while `self` is borrowed mutably.
    fn key(k: &Keypair) -> Keypair {
        k.insecure_clone()
    }

    fn rotate(&mut self, from: &Keypair, to: &Keypair) {
        let registry = self.registry;
        self.send(
            from,
            kyc::propose_ix(&from.pubkey(), &registry, &to.pubkey()),
            "propose",
        );
        self.send(to, kyc::accept_ix(&to.pubkey(), &registry), "accept");
    }
}

fn load<T: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> T {
    let account = svm.get_account(key).expect("account missing");
    T::try_deserialize(&mut account.data.as_slice()).expect("decode")
}

/// Program + platform (super admin) + one registry created by `a`.
fn boot() -> World {
    let mut svm = LiteSVM::new();
    svm.add_program(
        asset_registry::ID,
        include_bytes!("../../../target/deploy/asset_registry.so"),
    )
    .unwrap();
    let fees = funded(&mut svm);
    let admin = funded(&mut svm);
    let a = funded(&mut svm);
    let b = funded(&mut svm);
    let c = funded(&mut svm);

    support::set_upgrade_authority(&mut svm, &asset_registry::ID, Some(admin.pubkey()));
    let init = Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::InitializePlatform {
            protocol_treasury: admin.pubkey(),
            protocol_fee_bps: 250,
        }
        .data(),
        acc::InitializePlatform {
            admin: admin.pubkey(),
            upgrade_authority: admin.pubkey(),
            program: asset_registry::ID,
            program_data: support::program_data(&asset_registry::ID),
            platform: kyc::platform_pda(),
            super_admin_record: kyc::admin_pda(&admin.pubkey()),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    try_send_logs(&mut svm, &fees, &[&admin], &[init]).expect("initialize_platform");

    let create = kyc::create_registry_ix(&a.pubkey(), &admin.pubkey(), bitmap(&[J]), [0u8; 128]);
    try_send_logs(&mut svm, &fees, &[&a, &admin], &[create]).expect("create_kyc_registry");
    let registry = kyc::registry_pda(&a.pubkey());
    World {
        svm,
        fees,
        admin,
        a,
        b,
        c,
        registry,
    }
}

// ── 1. Happy path ────────────────────────────────────────────────────────────

#[test]
fn rotation_moves_only_the_authority_and_refunds_the_acceptor() {
    let mut w = boot();
    let (a, b) = (World::key(&w.a), World::key(&w.b));
    let h1 = Pubkey::new_unique();
    w.approve(&a, &h1).expect("A approves H1");
    let before = w.registry();
    let before_len = w.svm.get_account(&w.registry).unwrap().data.len();
    assert_eq!(before_len, 306);
    let transfer = kyc::transfer_pda(&w.registry);
    let registry = w.registry;

    let logs = w.send(
        &a,
        kyc::propose_ix(&a.pubkey(), &registry, &b.pubkey()),
        "propose A -> B",
    );
    let proposed = kyc::events::<KycRegistryAuthorityProposed>(&logs);
    assert_eq!(proposed.len(), 1);
    assert_eq!(proposed[0].registry, registry);
    assert_eq!(proposed[0].current_authority, a.pubkey());
    assert_eq!(proposed[0].new_authority, b.pubkey());
    let staged: AuthorityTransfer = load(&w.svm, &transfer);
    assert_eq!(staged.target, registry);
    assert_eq!(staged.current_authority, a.pubkey());
    assert_eq!(staged.new_authority, b.pubkey());
    assert_eq!(staged.proposed_by, a.pubkey());
    assert_eq!(
        w.registry().authority,
        a.pubkey(),
        "nothing moves on propose"
    );

    let rent = w.lamports(&transfer);
    let b_before = w.lamports(&b.pubkey());
    let logs = w.send(&b, kyc::accept_ix(&b.pubkey(), &registry), "accept by B");
    let changed = kyc::events::<KycRegistryAuthorityChanged>(&logs);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].registry, registry);
    assert_eq!(changed[0].old_authority, a.pubkey());
    assert_eq!(changed[0].new_authority, b.pubkey());

    let after = w.registry();
    assert_eq!(after.authority, b.pubkey());
    assert_eq!(after.approved_jurisdictions, before.approved_jurisdictions);
    assert_eq!(after.blocked_jurisdictions, before.blocked_jurisdictions);
    assert_eq!(after.entries_count, before.entries_count);
    assert_eq!(after.version, before.version);
    assert_eq!(after.bump, before.bump, "bump of the ORIGINAL seeds kept");
    assert_eq!(
        w.svm.get_account(&registry).unwrap().data.len(),
        306,
        "layout unchanged"
    );
    assert_eq!(
        registry,
        kyc::registry_pda(&a.pubkey()),
        "address unchanged"
    );
    assert_ne!(registry, kyc::registry_pda(&b.pubkey()));
    assert!(w.is_closed(&transfer), "transfer closed on accept");
    assert_eq!(
        w.lamports(&b.pubkey()),
        b_before + rent,
        "transfer rent goes to the acceptor"
    );
}

// ── 2. Approve / revoke after rotation ──────────────────────────────────────

#[test]
fn old_authority_is_locked_out_and_new_authority_works_on_the_same_address() {
    let mut w = boot();
    let (a, b) = (World::key(&w.a), World::key(&w.b));
    let (h1, h2) = (Pubkey::new_unique(), Pubkey::new_unique());
    w.approve(&a, &h1).expect("A approves H1");
    w.rotate(&a, &b);
    let registry = w.registry;

    w.expect_code(
        &a,
        kyc::approve_ix(&a.pubkey(), &registry, &h2, J),
        ERR_UNAUTHORIZED,
        "old authority approve",
    );
    w.expect_code(
        &a,
        kyc::revoke_ix(&a.pubkey(), &registry, &h1),
        ERR_UNAUTHORIZED,
        "old authority revoke",
    );

    w.approve(&b, &h2)
        .expect("B approves H2 on the same registry");
    assert_eq!(w.registry().entries_count, 2);
    let entry: KycEntry = load(&w.svm, &kyc::entry_pda(&registry, &h2));
    assert_eq!(entry.registry, registry);
    assert_eq!(entry.status, KycStatus::Approved);

    w.revoke(&b, &h1).expect("B revokes H1");
    let entry: KycEntry = load(&w.svm, &kyc::entry_pda(&registry, &h1));
    assert_eq!(entry.status, KycStatus::Revoked);
}

// ── 3. Propose failures ─────────────────────────────────────────────────────

#[test]
fn only_the_current_authority_proposes_a_different_nonzero_key() {
    let mut w = boot();
    let (a, b, c) = (World::key(&w.a), World::key(&w.b), World::key(&w.c));
    let admin = World::key(&w.admin);
    let registry = w.registry;
    w.expect_code(
        &c,
        kyc::propose_ix(&c.pubkey(), &registry, &b.pubkey()),
        ERR_UNAUTHORIZED,
        "non-authority propose",
    );
    w.expect_code(
        &admin,
        kyc::propose_ix(&admin.pubkey(), &registry, &b.pubkey()),
        ERR_UNAUTHORIZED,
        "super admin has no registry power",
    );
    w.expect_code(
        &a,
        kyc::propose_ix(&a.pubkey(), &registry, &Pubkey::default()),
        ERR_INVALID_PROPOSED_AUTHORITY,
        "propose the default key",
    );
    w.expect_code(
        &a,
        kyc::propose_ix(&a.pubkey(), &registry, &a.pubkey()),
        ERR_INVALID_PROPOSED_AUTHORITY,
        "propose self",
    );
    assert!(w.is_closed(&kyc::transfer_pda(&registry)));
}

// ── 4. Accept failures ──────────────────────────────────────────────────────

#[test]
fn accept_requires_a_live_proposal_to_the_signer() {
    let mut w = boot();
    let (a, b, c) = (World::key(&w.a), World::key(&w.b), World::key(&w.c));
    let registry = w.registry;
    w.expect_code(
        &b,
        kyc::accept_ix(&b.pubkey(), &registry),
        ERR_ACCOUNT_NOT_INITIALIZED,
        "accept with no proposal",
    );
    w.send(
        &a,
        kyc::propose_ix(&a.pubkey(), &registry, &b.pubkey()),
        "propose A -> B",
    );
    w.expect_code(
        &c,
        kyc::accept_ix(&c.pubkey(), &registry),
        ERR_INVALID_AUTHORITY_TRANSFER,
        "accept by the wrong signer",
    );
    assert_eq!(w.registry().authority, a.pubkey());
}

// ── 5. Re-propose overwrites ────────────────────────────────────────────────

#[test]
fn a_re_proposal_replaces_the_pending_one() {
    let mut w = boot();
    let (a, b, c) = (World::key(&w.a), World::key(&w.b), World::key(&w.c));
    let registry = w.registry;
    w.send(
        &a,
        kyc::propose_ix(&a.pubkey(), &registry, &b.pubkey()),
        "propose A -> B",
    );
    w.send(
        &a,
        kyc::propose_ix(&a.pubkey(), &registry, &c.pubkey()),
        "re-propose A -> C",
    );
    w.expect_code(
        &b,
        kyc::accept_ix(&b.pubkey(), &registry),
        ERR_INVALID_AUTHORITY_TRANSFER,
        "superseded B cannot accept",
    );
    w.send(&c, kyc::accept_ix(&c.pubkey(), &registry), "C accepts");
    assert_eq!(w.registry().authority, c.pubkey());
}

// ── 6. Cancel ───────────────────────────────────────────────────────────────

#[test]
fn only_the_current_authority_cancels_and_is_refunded() {
    let mut w = boot();
    let (a, b) = (World::key(&w.a), World::key(&w.b));
    let admin = World::key(&w.admin);
    let registry = w.registry;
    let transfer = kyc::transfer_pda(&registry);
    w.send(
        &a,
        kyc::propose_ix(&a.pubkey(), &registry, &b.pubkey()),
        "propose A -> B",
    );
    w.expect_code(
        &b,
        kyc::cancel_ix(&b.pubkey(), &registry),
        ERR_UNAUTHORIZED,
        "the proposed authority cannot cancel",
    );
    w.expect_code(
        &admin,
        kyc::cancel_ix(&admin.pubkey(), &registry),
        ERR_UNAUTHORIZED,
        "no super-admin cancel",
    );

    let rent = w.lamports(&transfer);
    let a_before = w.lamports(&a.pubkey());
    let logs = w.send(&a, kyc::cancel_ix(&a.pubkey(), &registry), "A cancels");
    let cancelled = kyc::events::<KycRegistryAuthorityProposalCancelled>(&logs);
    assert_eq!(cancelled.len(), 1);
    assert_eq!(cancelled[0].registry, registry);
    assert_eq!(cancelled[0].authority, a.pubkey());
    assert_eq!(cancelled[0].cancelled_new_authority, b.pubkey());
    assert!(w.is_closed(&transfer));
    assert_eq!(w.lamports(&a.pubkey()), a_before + rent, "rent back to A");

    w.expect_code(
        &b,
        kyc::accept_ix(&b.pubkey(), &registry),
        ERR_ACCOUNT_NOT_INITIALIZED,
        "accept after cancel",
    );
    assert_eq!(w.registry().authority, a.pubkey());
}

// ── 7. Round trip (init_if_needed after close) ──────────────────────────────

#[test]
fn round_trip_a_to_b_to_a() {
    let mut w = boot();
    let (a, b) = (World::key(&w.a), World::key(&w.b));
    w.rotate(&a, &b);
    w.rotate(&b, &a);
    assert_eq!(w.registry().authority, a.pubkey());
    assert!(w.is_closed(&kyc::transfer_pda(&w.registry)));
    let h = Pubkey::new_unique();
    w.approve(&a, &h).expect("A is the authority again");
    w.approve(&b, &h)
        .expect_err("B was rotated away and is locked out again");
}

// ── 8. Transfer-PDA isolation ───────────────────────────────────────────────

#[test]
fn a_platform_admin_transfer_cannot_stand_in_for_the_registry_transfer() {
    let mut w = boot();
    let (a, b) = (World::key(&w.a), World::key(&w.b));
    let admin = World::key(&w.admin);
    let registry = w.registry;
    let platform_transfer = kyc::transfer_pda(&kyc::platform_pda());

    // Stage a real platform-admin transfer to B.
    w.send(
        &admin,
        Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::ProposePlatformAdmin {
                new_admin: b.pubkey(),
            }
            .data(),
            acc::ProposePlatformAdmin {
                authority: admin.pubkey(),
                platform: kyc::platform_pda(),
                transfer: platform_transfer,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        "propose platform admin -> B",
    );

    w.expect_code(
        &b,
        kyc::accept_ix_with(&b.pubkey(), &registry, platform_transfer),
        ERR_CONSTRAINT_SEEDS,
        "accept the registry with the platform transfer",
    );
    w.expect_code(
        &a,
        kyc::propose_ix_with(&a.pubkey(), &registry, &b.pubkey(), platform_transfer),
        ERR_CONSTRAINT_SEEDS,
        "propose into the platform transfer",
    );
    assert_eq!(w.registry().authority, a.pubkey());
    let staged: AuthorityTransfer = load(&w.svm, &platform_transfer);
    assert_eq!(
        staged.target,
        kyc::platform_pda(),
        "platform transfer intact"
    );
}

// ── 9. Jurisdictions ────────────────────────────────────────────────────────

#[test]
fn authority_replaces_both_jurisdiction_maps() {
    let mut w = boot();
    let (a, b, c) = (World::key(&w.a), World::key(&w.b), World::key(&w.c));
    let registry = w.registry;
    let before = w.registry();
    let approved: Bitmap = bitmap(&[J, 40, 688, 999]);
    let blocked: Bitmap = bitmap(&[643]);

    w.expect_code(
        &c,
        kyc::update_jurisdictions_ix(&c.pubkey(), &registry, approved, blocked),
        ERR_UNAUTHORIZED,
        "non-authority update",
    );

    let logs = w.send(
        &a,
        kyc::update_jurisdictions_ix(&a.pubkey(), &registry, approved, blocked),
        "A updates jurisdictions",
    );
    let updated = kyc::events::<KycRegistryJurisdictionsUpdated>(&logs);
    assert_eq!(updated.len(), 1);
    assert_eq!(updated[0].registry, registry);
    assert_eq!(updated[0].authority, a.pubkey());
    assert_eq!(updated[0].approved_jurisdictions, approved);
    assert_eq!(updated[0].blocked_jurisdictions, blocked);
    let after = w.registry();
    assert_eq!(after.approved_jurisdictions, approved);
    assert_eq!(after.blocked_jurisdictions, blocked);
    assert_eq!(after.authority, before.authority);
    assert_eq!(after.entries_count, before.entries_count);
    assert_eq!(after.version, before.version);
    assert_eq!(after.bump, before.bump);

    // After rotation the old authority loses the power, the new one has it.
    w.rotate(&a, &b);
    w.expect_code(
        &a,
        kyc::update_jurisdictions_ix(&a.pubkey(), &registry, [0u8; 128], [0u8; 128]),
        ERR_UNAUTHORIZED,
        "old authority update",
    );
    w.send(
        &b,
        kyc::update_jurisdictions_ix(&b.pubkey(), &registry, [0u8; 128], [0xFF; 128]),
        "B updates jurisdictions",
    );
    let after = w.registry();
    assert_eq!(after.approved_jurisdictions, [0u8; 128]);
    assert_eq!(after.blocked_jurisdictions, [0xFF; 128]);
}

// ── 11. Registry creation after rotation ────────────────────────────────────

#[test]
fn rotated_away_creator_cannot_create_again_but_the_new_authority_can() {
    let mut w = boot();
    let (a, b) = (World::key(&w.a), World::key(&w.b));
    let admin = World::key(&w.admin);
    w.rotate(&a, &b);

    // B may still create its own registry at ["kyc_registry", B].
    let fees = World::key(&w.fees);
    try_send_logs(
        &mut w.svm,
        &fees,
        &[&b, &admin],
        &[kyc::create_registry_ix(
            &b.pubkey(),
            &admin.pubkey(),
            bitmap(&[J]),
            [0u8; 128],
        )],
    )
    .expect("B creates R2");
    let r2: KycRegistry = load(&w.svm, &kyc::registry_pda(&b.pubkey()));
    assert_eq!(r2.authority, b.pubkey());
    assert_ne!(kyc::registry_pda(&b.pubkey()), w.registry);

    // A's seed address is occupied by R1 (now B's) — A can never create again.
    let err = try_send_logs(
        &mut w.svm,
        &fees,
        &[&a, &admin],
        &[kyc::create_registry_ix(
            &a.pubkey(),
            &admin.pubkey(),
            bitmap(&[J]),
            [0u8; 128],
        )],
    )
    .expect_err("A cannot re-create at its occupied seed address");
    assert!(err.contains("already in use"), "got {err}");
    assert_eq!(w.registry().authority, b.pubkey(), "R1 untouched");
}
