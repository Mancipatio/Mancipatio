//! D3 — admin grants and super-admin rotation behind a 48 h timelock, the
//! veto (super admin, any Admin, program upgrade authority) and the one-way
//! bootstrap window (design 8.3 §5, §14.5) — LiteSVM over the real SBPF v3
//! build. The upgrade authority (UA) is a key of its own here.

#[path = "../../../tests/support/mod.rs"]
mod support;
#[path = "../../../tests/support/v1.rs"]
mod v1;

use {
    anchor_lang::{prelude::Pubkey, AccountDeserialize},
    asset_registry::{
        Admin, AdminAdded, AdminProposalCancelled, AdminProposed, AuthorityProposalCancelled,
        AuthorityProposalCreated, PendingAdmin, Platform, PlatformAdminChangeKind,
        PlatformAdminChanged, ADMIN_TIMELOCK_SECS, PROPOSAL_WINDOW_SECS,
        SUPER_ADMIN_ROTATION_TIMELOCK_SECS,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_signer::Signer,
    v1::*,
};

const ERR_UNAUTHORIZED: u32 = 6001;
const ERR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;
const ERR_INVALID_PROPOSED_AUTHORITY: u32 = 6112;
const ERR_INVALID_AUTHORITY_TRANSFER: u32 = 6113;

struct T {
    svm: LiteSVM,
    /// `Platform.admin`.
    sa: Keypair,
    /// `ProgramData.upgrade_authority_address` of the registry (and the hook).
    ua: Keypair,
}

/// `v1::boot_platform`: super admin `sa`, a separate upgrade authority `ua`.
fn boot(unpause: bool) -> T {
    let (svm, sa, ua) = boot_platform(unpause);
    T { svm, sa, ua }
}

fn load<D: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> D {
    let account = svm.get_account(key).expect("account");
    D::try_deserialize(&mut account.data.as_slice()).expect("decode")
}

fn gone(svm: &LiteSVM, key: &Pubkey) -> bool {
    svm.get_account(key)
        .is_none_or(|a| a.lamports == 0 && a.data.is_empty())
}

fn lamports(svm: &LiteSVM, key: &Pubkey) -> u64 {
    svm.get_account(key).map_or(0, |a| a.lamports)
}

// ── §14.5.1 ──────────────────────────────────────────────────────────────────

#[test]
fn only_the_super_admin_proposes_and_never_for_an_existing_or_default_key() {
    let mut t = boot(true);
    let x = funded(&mut t.svm);
    let stranger = funded(&mut t.svm);
    assert_code(
        send(
            &mut t.svm,
            &[&stranger],
            &[propose_admin_ix(&stranger.pubkey(), &x.pubkey())],
        ),
        ERR_UNAUTHORIZED,
        "a non-super-admin proposes",
    );
    // The super admin already holds an Admin record.
    assert_code(
        send(
            &mut t.svm,
            &[&t.sa],
            &[propose_admin_ix(&t.sa.pubkey(), &t.sa.pubkey())],
        ),
        ERR_INVALID_PROPOSED_AUTHORITY,
        "an existing Admin",
    );
    assert_code(
        send(
            &mut t.svm,
            &[&t.sa],
            &[propose_admin_ix(&t.sa.pubkey(), &Pubkey::default())],
        ),
        ERR_INVALID_PROPOSED_AUTHORITY,
        "the default key",
    );
}

// ── §14.5.2 ──────────────────────────────────────────────────────────────────

#[test]
fn a_grant_executes_from_48_hours_after_the_proposal_for_14_days() {
    let mut t = boot(true);
    let x = funded(&mut t.svm);
    let logs = send(
        &mut t.svm,
        &[&t.sa],
        &[propose_admin_ix(&t.sa.pubkey(), &x.pubkey())],
    )
    .unwrap();
    let ev = events::<AdminProposed>(&logs);
    assert_eq!(ev.len(), 1);
    assert_eq!(
        (ev[0].new_admin, ev[0].proposed_by, ev[0].proposed_at),
        (x.pubkey(), t.sa.pubkey(), T0)
    );
    assert_eq!(ev[0].eta, T0 + ADMIN_TIMELOCK_SECS);
    assert_eq!(
        ev[0].expires_at,
        T0 + ADMIN_TIMELOCK_SECS + PROPOSAL_WINDOW_SECS
    );
    assert!(!ev[0].bootstrap_open);
    let pending: PendingAdmin = load(&t.svm, &pending_admin(&x.pubkey()));
    assert_eq!(pending.eta, T0 + ADMIN_TIMELOCK_SECS);

    let add = add_admin_ix(&x.pubkey(), &t.sa.pubkey());
    warp_to(&mut t.svm, T0 + ADMIN_TIMELOCK_SECS - 1);
    assert_code(
        send(&mut t.svm, &[&x], std::slice::from_ref(&add)),
        ERR_TIMELOCK_ACTIVE,
        "one second early",
    );
    warp_to(&mut t.svm, T0 + ADMIN_TIMELOCK_SECS);
    let rent = lamports(&t.svm, &pending_admin(&x.pubkey()));
    let sa_before = lamports(&t.svm, &t.sa.pubkey());
    let logs = send(&mut t.svm, &[&x], &[add]).expect("at the eta");
    let record: Admin = load(&t.svm, &admin_pda(&x.pubkey()));
    assert_eq!((record.admin, record.added_by), (x.pubkey(), t.sa.pubkey()));
    assert!(gone(&t.svm, &pending_admin(&x.pubkey())));
    assert_eq!(
        lamports(&t.svm, &t.sa.pubkey()),
        sa_before + rent,
        "rent to the proposer"
    );
    let ev = events::<AdminAdded>(&logs);
    assert_eq!(
        (ev[0].admin, ev[0].added_by, ev[0].proposed_at),
        (x.pubkey(), t.sa.pubkey(), T0)
    );

    // The window closes 14 days after the eta.
    let y = funded(&mut t.svm);
    let t1 = now(&t.svm);
    send(
        &mut t.svm,
        &[&t.sa],
        &[propose_admin_ix(&t.sa.pubkey(), &y.pubkey())],
    )
    .unwrap();
    warp_to(&mut t.svm, t1 + ADMIN_TIMELOCK_SECS + PROPOSAL_WINDOW_SECS);
    assert_code(
        send(
            &mut t.svm,
            &[&y],
            &[add_admin_ix(&y.pubkey(), &t.sa.pubkey())],
        ),
        ERR_PROPOSAL_EXPIRED,
        "at expires_at",
    );
}

// ── §14.5.3-4 ────────────────────────────────────────────────────────────────

#[test]
fn add_admin_binds_the_signer_the_argument_and_the_live_super_admin() {
    let mut t = boot(true);
    let s = funded(&mut t.svm);
    let x = funded(&mut t.svm);
    send(
        &mut t.svm,
        &[&t.sa],
        &[propose_admin_ix(&t.sa.pubkey(), &x.pubkey())],
    )
    .unwrap();
    warp_to(&mut t.svm, T0 + ADMIN_TIMELOCK_SECS);
    // (a) signer S, arg X, pending = PDA(X) (exists): the first constraint.
    assert_code(
        send(
            &mut t.svm,
            &[&s],
            &[add_admin_ix_with(
                &s.pubkey(),
                &x.pubkey(),
                &pending_admin(&x.pubkey()),
                &t.sa.pubkey(),
            )],
        ),
        ERR_INVALID_ADMIN_PROPOSAL,
        "(a) signer is not the argument",
    );
    // (b) signer S, arg S, pending = PDA(S) (never proposed).
    assert_code(
        send(
            &mut t.svm,
            &[&s],
            &[add_admin_ix(&s.pubkey(), &t.sa.pubkey())],
        ),
        ERR_ACCOUNT_NOT_INITIALIZED,
        "(b) no proposal for the signer",
    );

    // The super admin rotates away before the grant executes: stale.
    let next = funded(&mut t.svm);
    send(
        &mut t.svm,
        &[&t.sa],
        &[propose_platform_admin_ix(&t.sa.pubkey(), &next.pubkey())],
    )
    .unwrap();
    warp_to(
        &mut t.svm,
        T0 + ADMIN_TIMELOCK_SECS + SUPER_ADMIN_ROTATION_TIMELOCK_SECS,
    );
    send(
        &mut t.svm,
        &[&next],
        &[accept_platform_admin_ix(&next.pubkey(), &t.sa.pubkey())],
    )
    .expect("rotate the super admin");
    assert_code(
        send(
            &mut t.svm,
            &[&x],
            &[add_admin_ix(&x.pubkey(), &t.sa.pubkey())],
        ),
        ERR_INVALID_ADMIN_PROPOSAL,
        "the proposer is no longer the super admin",
    );
}

// ── §14.5.5 ──────────────────────────────────────────────────────────────────

#[test]
fn the_super_admin_any_admin_or_the_upgrade_authority_cancels_a_grant() {
    let mut t = boot(true);
    let admin = funded(&mut t.svm);
    grant_admin(&mut t.svm, &t.sa, &admin).unwrap();
    let pd = program_data(&asset_registry::ID);
    let propose = |t: &mut T, x: &Pubkey| {
        send(&mut t.svm, &[&t.sa], &[propose_admin_ix(&t.sa.pubkey(), x)]).unwrap();
    };

    let x = funded(&mut t.svm);
    propose(&mut t, &x.pubkey());
    let stranger = funded(&mut t.svm);
    assert_code(
        send(
            &mut t.svm,
            &[&stranger],
            &[cancel_admin_proposal_ix(
                &stranger.pubkey(),
                &x.pubkey(),
                &t.sa.pubkey(),
            )],
        ),
        ERR_UNAUTHORIZED,
        "a random key",
    );
    // The UA with the HOOK's ProgramData: not bound to this program.
    assert_code(
        send(
            &mut t.svm,
            &[&t.ua],
            &[cancel_admin_proposal_ix_with(
                &t.ua.pubkey(),
                &x.pubkey(),
                &t.sa.pubkey(),
                &program_data(&transfer_hook::ID),
            )],
        ),
        ERR_UNAUTHORIZED,
        "another program's ProgramData",
    );
    for (who, canceller) in [
        ("an Admin", &admin),
        ("the super admin", &t.sa.insecure_clone()),
        ("the UA", &t.ua.insecure_clone()),
    ] {
        if gone(&t.svm, &pending_admin(&x.pubkey())) {
            propose(&mut t, &x.pubkey());
        }
        let rent = lamports(&t.svm, &pending_admin(&x.pubkey()));
        let sa_before = lamports(&t.svm, &t.sa.pubkey());
        let logs = send(
            &mut t.svm,
            &[canceller],
            &[cancel_admin_proposal_ix_with(
                &canceller.pubkey(),
                &x.pubkey(),
                &t.sa.pubkey(),
                &pd,
            )],
        )
        .unwrap_or_else(|e| panic!("{who} cancels: {e}"));
        assert!(gone(&t.svm, &pending_admin(&x.pubkey())), "{who}");
        let expected = if canceller.pubkey() == t.sa.pubkey() {
            // The super admin also paid this transaction's fee.
            sa_before + rent - 5_000
        } else {
            sa_before + rent
        };
        assert_eq!(
            lamports(&t.svm, &t.sa.pubkey()),
            expected,
            "{who}: rent to the proposer"
        );
        let ev = events::<AdminProposalCancelled>(&logs);
        assert_eq!(ev[0].cancelled_by, canceller.pubkey(), "{who}");
    }
    warp_to(&mut t.svm, T0 + ADMIN_TIMELOCK_SECS);
    assert_code(
        send(
            &mut t.svm,
            &[&x],
            &[add_admin_ix(&x.pubkey(), &t.sa.pubkey())],
        ),
        ERR_ACCOUNT_NOT_INITIALIZED,
        "add after a cancel",
    );
}

// ── §14.5.6 + §14.4.5-6: the one-way bootstrap window ───────────────────────

#[test]
fn bootstrap_waives_the_timelock_only_while_it_is_open_and_never_reopens() {
    let mut t = boot(false);
    assert!(bootstrap_open(&t.svm));
    // Open: propose + add in one transaction.
    let x = funded(&mut t.svm);
    send(
        &mut t.svm,
        &[&t.sa, &x],
        &[
            propose_admin_ix(&t.sa.pubkey(), &x.pubkey()),
            add_admin_ix(&x.pubkey(), &t.sa.pubkey()),
        ],
    )
    .expect("bootstrap grant");
    // Proposed while open, executed after the window closed: full eta.
    let y = funded(&mut t.svm);
    send(
        &mut t.svm,
        &[&t.sa],
        &[propose_admin_ix(&t.sa.pubkey(), &y.pubkey())],
    )
    .unwrap();
    // The bootstrap marker can never be SET.
    assert_code(
        send(
            &mut t.svm,
            &[&t.sa],
            &[set_pause_flags_ix(&t.sa.pubkey(), 0x80, 0)],
        ),
        6118,
        "set bit 7",
    );
    warp_to(&mut t.svm, T0 + 3_600);
    // Explicit close (after the last role step).
    let logs = send(
        &mut t.svm,
        &[&t.sa],
        &[set_pause_flags_ix(&t.sa.pubkey(), 0, 0x80)],
    )
    .unwrap();
    assert_eq!(pause_byte(&t.svm), 0x7F, "only the marker cleared");
    let changed = events::<asset_registry::PauseFlagsChanged>(&logs);
    assert_eq!((changed[0].old, changed[0].new), (0xFF, 0x7F));
    warp_to(&mut t.svm, T0 + 7_200);
    let add_y = add_admin_ix(&y.pubkey(), &t.sa.pubkey());
    assert_code(
        send(&mut t.svm, &[&y], std::slice::from_ref(&add_y)),
        ERR_TIMELOCK_ACTIVE,
        "a pre-staged proposal after the window closed",
    );
    warp_to(&mut t.svm, T0 + ADMIN_TIMELOCK_SECS);
    send(&mut t.svm, &[&y], &[add_y]).expect("at proposed_at + 48 h");
    // Nothing re-opens it.
    assert_code(
        send(
            &mut t.svm,
            &[&t.sa],
            &[set_pause_flags_ix(&t.sa.pubkey(), 0x80, 0)],
        ),
        6118,
        "re-set bit 7",
    );
    assert!(!bootstrap_open(&t.svm));
}

#[test]
fn the_first_unpause_or_set_pause_false_closes_the_bootstrap_window() {
    // The first clear of any pause bit closes it (the event shows it).
    let mut t = boot(false);
    let logs = send(
        &mut t.svm,
        &[&t.sa],
        &[set_pause_flags_ix(
            &t.sa.pubkey(),
            0,
            asset_registry::PAUSE_ONBOARDING,
        )],
    )
    .unwrap();
    let changed = events::<asset_registry::PauseFlagsChanged>(&logs);
    assert_eq!((changed[0].old, changed[0].new), (0xFF, 0x7E));
    // The legacy `set_pause(false)` closes it too.
    let mut t = boot(false);
    send(&mut t.svm, &[&t.sa], &[set_pause_ix(&t.sa.pubkey(), false)]).unwrap();
    assert_eq!(pause_byte(&t.svm), 0x7E);
    // `set_pause(true)` does not.
    let mut t = boot(false);
    send(&mut t.svm, &[&t.sa], &[set_pause_ix(&t.sa.pubkey(), true)]).unwrap();
    assert_eq!(pause_byte(&t.svm), 0xFF);
}

// ── §14.5.7: super-admin rotation ────────────────────────────────────────────

#[test]
fn super_admin_rotation_waits_48_hours_can_be_vetoed_and_expires() {
    let mut t = boot(true);
    let admin = funded(&mut t.svm);
    grant_admin(&mut t.svm, &t.sa, &admin).unwrap();
    let next = funded(&mut t.svm);
    let logs = send(
        &mut t.svm,
        &[&t.sa],
        &[propose_platform_admin_ix(&t.sa.pubkey(), &next.pubkey())],
    )
    .unwrap();
    let created = events::<AuthorityProposalCreated>(&logs);
    assert_eq!(
        created[0].kind,
        asset_registry::AUTHORITY_PROPOSAL_KIND_PLATFORM
    );
    assert_eq!(created[0].eta, T0 + SUPER_ADMIN_ROTATION_TIMELOCK_SECS);
    let accept = accept_platform_admin_ix(&next.pubkey(), &t.sa.pubkey());
    warp_to(&mut t.svm, T0 + SUPER_ADMIN_ROTATION_TIMELOCK_SECS - 1);
    assert_code(
        send(&mut t.svm, &[&next], std::slice::from_ref(&accept)),
        ERR_TIMELOCK_ACTIVE,
        "one second early",
    );
    warp_to(&mut t.svm, T0 + SUPER_ADMIN_ROTATION_TIMELOCK_SECS);
    let logs = send(&mut t.svm, &[&next], &[accept]).expect("at the eta");
    let platform: Platform = load(&t.svm, &platform_pda());
    assert_eq!(platform.admin, next.pubkey());
    assert!(
        gone(&t.svm, &admin_pda(&t.sa.pubkey())),
        "old record closed"
    );
    let record: Admin = load(&t.svm, &admin_pda(&next.pubkey()));
    assert_eq!(
        (record.admin, record.added_by),
        (next.pubkey(), t.sa.pubkey())
    );
    let changed = events::<PlatformAdminChanged>(&logs);
    assert_eq!(
        (changed[0].old_admin, changed[0].new_admin, changed[0].kind),
        (
            t.sa.pubkey(),
            next.pubkey(),
            PlatformAdminChangeKind::Rotation
        )
    );

    // Veto: an Admin, the UA; a random key cannot. Accept after a cancel: 3012.
    let pd = program_data(&asset_registry::ID);
    let third = funded(&mut t.svm);
    let stranger = funded(&mut t.svm);
    let propose = |t: &mut T| {
        send(
            &mut t.svm,
            &[&next],
            &[propose_platform_admin_ix(&next.pubkey(), &third.pubkey())],
        )
        .unwrap();
    };
    propose(&mut t);
    assert_code(
        send(
            &mut t.svm,
            &[&stranger],
            &[cancel_platform_admin_transfer_ix(
                &stranger.pubkey(),
                &next.pubkey(),
                &pd,
            )],
        ),
        ERR_UNAUTHORIZED,
        "a random key",
    );
    for canceller in [&admin, &t.ua.insecure_clone()] {
        if gone(&t.svm, &authority_proposal(&platform_pda())) {
            propose(&mut t);
        }
        let logs = send(
            &mut t.svm,
            &[canceller],
            &[cancel_platform_admin_transfer_ix(
                &canceller.pubkey(),
                &next.pubkey(),
                &pd,
            )],
        )
        .expect("veto");
        let ev = events::<AuthorityProposalCancelled>(&logs);
        assert_eq!(
            (ev[0].cancelled_by, ev[0].cancelled_new_authority),
            (canceller.pubkey(), third.pubkey())
        );
    }
    let later = now(&t.svm) + SUPER_ADMIN_ROTATION_TIMELOCK_SECS;
    warp_to(&mut t.svm, later);
    assert_code(
        send(
            &mut t.svm,
            &[&third],
            &[accept_platform_admin_ix(&third.pubkey(), &next.pubkey())],
        ),
        ERR_ACCOUNT_NOT_INITIALIZED,
        "accept after a cancel",
    );

    // Expiry: 14 days after the eta.
    let t2 = now(&t.svm);
    propose(&mut t);
    warp_to(
        &mut t.svm,
        t2 + SUPER_ADMIN_ROTATION_TIMELOCK_SECS + PROPOSAL_WINDOW_SECS,
    );
    assert_code(
        send(
            &mut t.svm,
            &[&third],
            &[accept_platform_admin_ix(&third.pubkey(), &next.pubkey())],
        ),
        ERR_PROPOSAL_EXPIRED,
        "at expires_at",
    );
    // The proposal of a different key is refused by the constraint first.
    assert_code(
        send(
            &mut t.svm,
            &[&stranger],
            &[accept_platform_admin_ix(&stranger.pubkey(), &next.pubkey())],
        ),
        ERR_INVALID_AUTHORITY_TRANSFER,
        "not the proposed key",
    );
}

#[test]
fn a_bootstrap_super_admin_rotation_runs_in_one_transaction() {
    let mut t = boot(false);
    let next = funded(&mut t.svm);
    send(
        &mut t.svm,
        &[&t.sa, &next],
        &[
            propose_platform_admin_ix(&t.sa.pubkey(), &next.pubkey()),
            accept_platform_admin_ix(&next.pubkey(), &t.sa.pubkey()),
        ],
    )
    .expect("Day-D rotation inside the bootstrap window");
    let platform: Platform = load(&t.svm, &platform_pda());
    assert_eq!(platform.admin, next.pubkey());
    assert!(platform.bootstrap_open(), "a rotation does not close it");
}

// ── §14.5.8: the compromised super admin ─────────────────────────────────────

#[test]
fn a_compromised_super_admin_cannot_seat_an_admin_past_the_upgrade_authority() {
    let mut t = boot(true);
    let honest = funded(&mut t.svm);
    grant_admin(&mut t.svm, &t.sa, &honest).unwrap();
    // The attacker holding the SA key removes every Admin and clears every
    // pause bit — 0x40 needs a separate, visible call …
    send(
        &mut t.svm,
        &[&t.sa],
        &[remove_admin_ix(&t.sa.pubkey(), &honest.pubkey())],
    )
    .expect("instant remove_admin");
    send(
        &mut t.svm,
        &[&t.sa],
        &[set_pause_flags_ix(
            &t.sa.pubkey(),
            asset_registry::PAUSE_FLAGS_ALL,
            0,
        )],
    )
    .unwrap();
    send(
        &mut t.svm,
        &[&t.sa],
        &[set_pause_flags_ix(&t.sa.pubkey(), 0, CLEAR_ALL_BUT_MODULES)],
    )
    .unwrap();
    send(
        &mut t.svm,
        &[&t.sa],
        &[set_pause_flags_ix(
            &t.sa.pubkey(),
            0,
            asset_registry::PAUSE_PAYOUT_MODULES,
        )],
    )
    .unwrap();
    // … and proposes a second attacker key as Admin.
    let attacker = funded(&mut t.svm);
    send(
        &mut t.svm,
        &[&t.sa],
        &[propose_admin_ix(&t.sa.pubkey(), &attacker.pubkey())],
    )
    .unwrap();
    // No Admin is left to veto; the upgrade authority still is.
    send(
        &mut t.svm,
        &[&t.ua],
        &[cancel_admin_proposal_ix(
            &t.ua.pubkey(),
            &attacker.pubkey(),
            &t.sa.pubkey(),
        )],
    )
    .expect("the UA vetoes");
    warp_to(&mut t.svm, T0 + ADMIN_TIMELOCK_SECS);
    assert_code(
        send(
            &mut t.svm,
            &[&attacker],
            &[add_admin_ix(&attacker.pubkey(), &t.sa.pubkey())],
        ),
        ERR_ACCOUNT_NOT_INITIALIZED,
        "the vetoed grant cannot execute",
    );
    assert!(gone(&t.svm, &admin_pda(&attacker.pubkey())));
}

// ── Review 8.3 findings 15b / 21 ────────────────────────────────────────────

/// A re-proposal overwrites the PendingAdmin and restarts the 48 h clock; an
/// `init_if_needed` that kept the old eta would let the super admin stretch
/// the execution window without a fresh notice.
#[test]
fn a_grant_re_proposal_restarts_the_48_hour_clock() {
    let mut t = boot(true);
    let x = funded(&mut t.svm);
    let t0 = now(&t.svm);
    send(
        &mut t.svm,
        &[&t.sa],
        &[propose_admin_ix(&t.sa.pubkey(), &x.pubkey())],
    )
    .unwrap();
    let t1 = t0 + ADMIN_TIMELOCK_SECS - 3_600; // T0 + 47 h
    warp_to(&mut t.svm, t1);
    send(
        &mut t.svm,
        &[&t.sa],
        &[propose_admin_ix(&t.sa.pubkey(), &x.pubkey())],
    )
    .expect("re-propose");
    let pending: PendingAdmin = load(&t.svm, &pending_admin(&x.pubkey()));
    assert_eq!(
        (pending.proposed_at, pending.eta, pending.expires_at),
        (
            t1,
            t1 + ADMIN_TIMELOCK_SECS,
            t1 + ADMIN_TIMELOCK_SECS + PROPOSAL_WINDOW_SECS
        )
    );
    warp_to(&mut t.svm, t0 + ADMIN_TIMELOCK_SECS);
    assert_code(
        send(
            &mut t.svm,
            &[&x],
            &[add_admin_ix(&x.pubkey(), &t.sa.pubkey())],
        ),
        ERR_TIMELOCK_ACTIVE,
        "at the first proposal's eta",
    );
    warp_to(&mut t.svm, t1 + ADMIN_TIMELOCK_SECS);
    send(
        &mut t.svm,
        &[&x],
        &[add_admin_ix(&x.pubkey(), &t.sa.pubkey())],
    )
    .expect("at the re-proposal's eta");
    assert_eq!(
        load::<Admin>(&t.svm, &admin_pda(&x.pubkey())).admin,
        x.pubkey()
    );
}

/// An Admin removed with `remove_admin` loses its veto at once: it can
/// cancel neither an admin grant nor a super-admin rotation.
#[test]
fn a_removed_admin_cannot_cancel_a_grant_or_a_rotation() {
    let mut t = boot(true);
    let d = funded(&mut t.svm);
    grant_admin(&mut t.svm, &t.sa, &d).unwrap();
    send(
        &mut t.svm,
        &[&t.sa],
        &[remove_admin_ix(&t.sa.pubkey(), &d.pubkey())],
    )
    .expect("remove_admin");
    let x = funded(&mut t.svm);
    let y = funded(&mut t.svm);
    send(
        &mut t.svm,
        &[&t.sa],
        &[
            propose_admin_ix(&t.sa.pubkey(), &x.pubkey()),
            propose_platform_admin_ix(&t.sa.pubkey(), &y.pubkey()),
        ],
    )
    .unwrap();
    assert_code(
        send(
            &mut t.svm,
            &[&d],
            &[cancel_admin_proposal_ix(
                &d.pubkey(),
                &x.pubkey(),
                &t.sa.pubkey(),
            )],
        ),
        ERR_UNAUTHORIZED,
        "a removed Admin cancels a grant",
    );
    assert_code(
        send(
            &mut t.svm,
            &[&d],
            &[cancel_platform_admin_transfer_ix(
                &d.pubkey(),
                &t.sa.pubkey(),
                &program_data(&asset_registry::ID),
            )],
        ),
        ERR_UNAUTHORIZED,
        "a removed Admin cancels a rotation",
    );
    assert!(!gone(&t.svm, &pending_admin(&x.pubkey())));
    assert!(!gone(&t.svm, &authority_proposal(&platform_pda())));
}

/// Finding 15b: the upgrade-authority veto is bound to THIS program's
/// ProgramData. The upgrade authority of any other program (here a ProgramData
/// the attacker controls) cannot veto a grant or a super-admin rotation.
#[test]
fn another_programs_upgrade_authority_cannot_veto() {
    let mut t = boot(true);
    let attacker = funded(&mut t.svm);
    let mut foreign = t
        .svm
        .get_account(&program_data(&asset_registry::ID))
        .unwrap();
    foreign.data[13..45].copy_from_slice(attacker.pubkey().as_ref());
    let foreign_pd = Pubkey::new_unique();
    t.svm.set_account(foreign_pd, foreign).unwrap();
    let x = funded(&mut t.svm);
    let y = funded(&mut t.svm);
    send(
        &mut t.svm,
        &[&t.sa],
        &[
            propose_admin_ix(&t.sa.pubkey(), &x.pubkey()),
            propose_platform_admin_ix(&t.sa.pubkey(), &y.pubkey()),
        ],
    )
    .unwrap();
    assert_code(
        send(
            &mut t.svm,
            &[&attacker],
            &[cancel_platform_admin_transfer_ix(
                &attacker.pubkey(),
                &t.sa.pubkey(),
                &foreign_pd,
            )],
        ),
        ERR_UNAUTHORIZED,
        "a foreign ProgramData vetoes a rotation",
    );
    assert_code(
        send(
            &mut t.svm,
            &[&attacker],
            &[cancel_admin_proposal_ix_with(
                &attacker.pubkey(),
                &x.pubkey(),
                &t.sa.pubkey(),
                &foreign_pd,
            )],
        ),
        ERR_UNAUTHORIZED,
        "a foreign ProgramData vetoes a grant",
    );
    assert!(!gone(&t.svm, &authority_proposal(&platform_pda())));
    assert!(!gone(&t.svm, &pending_admin(&x.pubkey())));
}
