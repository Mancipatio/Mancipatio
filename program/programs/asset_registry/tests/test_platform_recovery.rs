//! D4 — recovery of a LOST super-admin key by the program upgrade authority
//! after 7 days (design 8.3 §7.1, §7.3, §14.7) — LiteSVM over the real SBPF
//! v3 build, with the super admin (`sa`) and the upgrade authority (`ua`) on
//! different keys.

#[path = "../../../tests/support/mod.rs"]
mod support;
#[path = "../../../tests/support/v1.rs"]
mod v1;

use {
    anchor_lang::{prelude::Pubkey, AccountDeserialize},
    asset_registry::{
        Admin, Platform, PlatformAdminChangeKind, PlatformAdminChanged, PlatformRecovery,
        PlatformRecoveryCancelled, PlatformRecoveryProposed, ADMIN_TIMELOCK_SECS,
        PLATFORM_RECOVERY_DELAY_SECS, PROPOSAL_WINDOW_SECS, SUPER_ADMIN_ROTATION_TIMELOCK_SECS,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_signer::Signer,
    v1::*,
};

const ERR_UNAUTHORIZED: u32 = 6001;
const ERR_INVALID_PROPOSED_AUTHORITY: u32 = 6112;
const ERR_INVALID_AUTHORITY_TRANSFER: u32 = 6113;
const ERR_PLATFORM_RECOVERY_PENDING: u32 = 6155;

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

fn registry_pd() -> Pubkey {
    program_data(&asset_registry::ID)
}

fn propose(svm: &mut LiteSVM, ua: &Keypair, new_admin: &Pubkey) -> Vec<String> {
    send(
        svm,
        &[ua],
        &[propose_platform_recovery_ix(
            &ua.pubkey(),
            new_admin,
            &registry_pd(),
        )],
    )
    .expect("propose_platform_recovery")
}

fn execute_ix(
    new_admin: &Pubkey,
    current: &Pubkey,
    ua: &Pubkey,
) -> anchor_lang::solana_program::instruction::Instruction {
    execute_platform_recovery_ix(new_admin, current, ua, &registry_pd())
}

// ── §14.7.1 ──────────────────────────────────────────────────────────────────

#[test]
fn only_the_upgrade_authority_proposes_through_this_programs_programdata() {
    let (mut svm, sa, ua) = boot_platform(true);
    let c = funded(&mut svm);
    assert_code(
        send(
            &mut svm,
            &[&sa],
            &[propose_platform_recovery_ix(
                &sa.pubkey(),
                &c.pubkey(),
                &registry_pd(),
            )],
        ),
        ERR_UNAUTHORIZED,
        "the super admin is not the upgrade authority",
    );
    // The hook's ProgramData has the same upgrade authority, but it is not
    // this program's.
    assert_code(
        send(
            &mut svm,
            &[&ua],
            &[propose_platform_recovery_ix(
                &ua.pubkey(),
                &c.pubkey(),
                &program_data(&transfer_hook::ID),
            )],
        ),
        ERR_UNAUTHORIZED,
        "another program's ProgramData",
    );
    for bad in [sa.pubkey(), Pubkey::default()] {
        assert_code(
            send(
                &mut svm,
                &[&ua],
                &[propose_platform_recovery_ix(
                    &ua.pubkey(),
                    &bad,
                    &registry_pd(),
                )],
            ),
            ERR_INVALID_PROPOSED_AUTHORITY,
            "the current super admin or the default key",
        );
    }
    let logs = propose(&mut svm, &ua, &c.pubkey());
    let rec: PlatformRecovery = load(&svm, &platform_recovery());
    assert_eq!(
        (
            rec.platform,
            rec.current_admin,
            rec.new_admin,
            rec.proposed_by
        ),
        (platform_pda(), sa.pubkey(), c.pubkey(), ua.pubkey())
    );
    assert_eq!(rec.proposed_at, T0);
    assert_eq!(rec.eta, T0 + PLATFORM_RECOVERY_DELAY_SECS);
    assert_eq!(rec.expires_at, rec.eta + PROPOSAL_WINDOW_SECS);
    assert_eq!(
        svm.get_account(&platform_recovery()).unwrap().data.len(),
        162
    );
    let ev = events::<PlatformRecoveryProposed>(&logs);
    assert_eq!((ev[0].new_admin, ev[0].eta), (c.pubkey(), rec.eta));
}

// ── §14.7.2 ──────────────────────────────────────────────────────────────────

#[test]
fn a_recovery_executes_after_seven_days_for_fourteen_and_swaps_the_records() {
    let (mut svm, sa, ua) = boot_platform(true);
    let c = funded(&mut svm);
    propose(&mut svm, &ua, &c.pubkey());
    let ix = execute_ix(&c.pubkey(), &sa.pubkey(), &ua.pubkey());
    warp_to(&mut svm, T0 + PLATFORM_RECOVERY_DELAY_SECS - 1);
    assert_code(
        send(&mut svm, &[&c], std::slice::from_ref(&ix)),
        ERR_TIMELOCK_ACTIVE,
        "one second early",
    );
    warp_to(&mut svm, T0 + PLATFORM_RECOVERY_DELAY_SECS);
    let rent = lamports(&svm, &platform_recovery());
    let ua_before = lamports(&svm, &ua.pubkey());
    let logs = send(&mut svm, &[&c], &[ix]).expect("at the eta");
    let platform: Platform = load(&svm, &platform_pda());
    assert_eq!(platform.admin, c.pubkey());
    assert!(
        gone(&svm, &admin_pda(&sa.pubkey())),
        "the lost key's record closed"
    );
    let record: Admin = load(&svm, &admin_pda(&c.pubkey()));
    assert_eq!((record.admin, record.added_by), (c.pubkey(), sa.pubkey()));
    assert!(gone(&svm, &platform_recovery()));
    assert_eq!(
        lamports(&svm, &ua.pubkey()),
        ua_before + rent,
        "rent to the proposer"
    );
    let ev = events::<PlatformAdminChanged>(&logs);
    assert_eq!(
        (ev[0].old_admin, ev[0].new_admin, ev[0].kind),
        (sa.pubkey(), c.pubkey(), PlatformAdminChangeKind::Recovery)
    );
}

#[test]
fn a_recovery_expires_fourteen_days_after_its_eta_and_bootstrap_waives_nothing() {
    // Bootstrap open: the recovery delay is NOT waived.
    let (mut svm, sa, ua) = boot_platform(false);
    assert!(bootstrap_open(&svm));
    let c = funded(&mut svm);
    propose(&mut svm, &ua, &c.pubkey());
    assert_code(
        send(
            &mut svm,
            &[&c],
            &[execute_ix(&c.pubkey(), &sa.pubkey(), &ua.pubkey())],
        ),
        ERR_TIMELOCK_ACTIVE,
        "no bootstrap waiver",
    );
    warp_to(
        &mut svm,
        T0 + PLATFORM_RECOVERY_DELAY_SECS + PROPOSAL_WINDOW_SECS,
    );
    assert_code(
        send(
            &mut svm,
            &[&c],
            &[execute_ix(&c.pubkey(), &sa.pubkey(), &ua.pubkey())],
        ),
        ERR_PROPOSAL_EXPIRED,
        "at expires_at",
    );
}

// ── §14.7.3 ──────────────────────────────────────────────────────────────────

#[test]
fn execute_is_bound_to_the_signer_the_live_super_admin_and_the_live_upgrade_authority() {
    let (mut svm, sa, ua) = boot_platform(true);
    let c = funded(&mut svm);
    let stranger = funded(&mut svm);
    propose(&mut svm, &ua, &c.pubkey());
    warp_to(&mut svm, T0 + PLATFORM_RECOVERY_DELAY_SECS);
    // Wrong signer.
    assert_code(
        send(
            &mut svm,
            &[&stranger],
            &[execute_ix(&stranger.pubkey(), &sa.pubkey(), &ua.pubkey())],
        ),
        ERR_INVALID_PLATFORM_RECOVERY,
        "not the proposed key",
    );
    // The hook's ProgramData (same upgrade authority) with the registry program.
    assert_code(
        send(
            &mut svm,
            &[&c],
            &[execute_platform_recovery_ix(
                &c.pubkey(),
                &sa.pubkey(),
                &ua.pubkey(),
                &program_data(&transfer_hook::ID),
            )],
        ),
        ERR_UNAUTHORIZED,
        "another program's ProgramData",
    );
    // The upgrade authority changed since the proposal.
    let new_ua = funded(&mut svm);
    set_upgrade_authority(&mut svm, &asset_registry::ID, Some(new_ua.pubkey()));
    assert_code(
        send(
            &mut svm,
            &[&c],
            &[execute_ix(&c.pubkey(), &sa.pubkey(), &ua.pubkey())],
        ),
        ERR_INVALID_PLATFORM_RECOVERY,
        "the upgrade authority moved",
    );
    set_upgrade_authority(&mut svm, &asset_registry::ID, Some(ua.pubkey()));

    // The super admin cannot rotate away from a live recovery: the accept is
    // refused (findings 1/8/23: otherwise a compromised super admin defeats
    // the incident build's recovery by rotating to a second key of its own).
    let b = funded(&mut svm);
    send(
        &mut svm,
        &[&sa],
        &[propose_platform_admin_ix(&sa.pubkey(), &b.pubkey())],
    )
    .unwrap();
    let t1 = now(&svm);
    warp_to(&mut svm, t1 + SUPER_ADMIN_ROTATION_TIMELOCK_SECS);
    assert_code(
        send(
            &mut svm,
            &[&b],
            &[accept_platform_admin_ix(&b.pubkey(), &sa.pubkey())],
        ),
        ERR_PLATFORM_RECOVERY_PENDING,
        "a rotation while a recovery is pending",
    );
    assert_eq!(
        load::<PlatformRecovery>(&svm, &platform_recovery()).current_admin,
        sa.pubkey(),
        "the recovery stays live"
    );
    assert_eq!(load::<Platform>(&svm, &platform_pda()).admin, sa.pubkey());

    // A recovery bound to another super admin (fabricated: no instruction can
    // produce one any more) is refused by the execute constraint ...
    let live = svm.get_account(&platform_recovery()).unwrap();
    let mut stale = live.clone();
    stale.data[40..72].copy_from_slice(b.pubkey().as_ref());
    svm.set_account(platform_recovery(), stale).unwrap();
    assert_code(
        send(
            &mut svm,
            &[&c],
            &[execute_ix(&c.pubkey(), &sa.pubkey(), &ua.pubkey())],
        ),
        ERR_INVALID_PLATFORM_RECOVERY,
        "a recovery against another super admin",
    );
    // ... and does not block a rotation (it is not live).
    let logs = send(
        &mut svm,
        &[&b],
        &[accept_platform_admin_ix(&b.pubkey(), &sa.pubkey())],
    )
    .expect("a stale recovery does not block the rotation");
    assert_eq!(
        events::<PlatformAdminChanged>(&logs)[0].kind,
        PlatformAdminChangeKind::Rotation
    );
    // Back B -> A: a recovery against B would never execute against A.
    send(
        &mut svm,
        &[&b],
        &[propose_platform_admin_ix(&b.pubkey(), &sa.pubkey())],
    )
    .unwrap();
    let t2 = now(&svm);
    warp_to(&mut svm, t2 + SUPER_ADMIN_ROTATION_TIMELOCK_SECS);
    assert_code(
        send(
            &mut svm,
            &[&sa],
            &[accept_platform_admin_ix(&sa.pubkey(), &b.pubkey())],
        ),
        ERR_PLATFORM_RECOVERY_PENDING,
        "the fabricated recovery is live against B",
    );
}

/// The holder of a key that was not lost cancels the recovery, then rotates.
#[test]
fn a_live_recovery_blocks_the_rotation_until_the_super_admin_cancels_it() {
    let (mut svm, sa, ua) = boot_platform(true);
    let c = funded(&mut svm);
    let b = funded(&mut svm);
    propose(&mut svm, &ua, &c.pubkey());
    send(
        &mut svm,
        &[&sa],
        &[propose_platform_admin_ix(&sa.pubkey(), &b.pubkey())],
    )
    .unwrap();
    warp_to(&mut svm, T0 + SUPER_ADMIN_ROTATION_TIMELOCK_SECS);
    assert_code(
        send(
            &mut svm,
            &[&b],
            &[accept_platform_admin_ix(&b.pubkey(), &sa.pubkey())],
        ),
        ERR_PLATFORM_RECOVERY_PENDING,
        "a rotation while a recovery is pending",
    );
    send(
        &mut svm,
        &[&sa],
        &[cancel_platform_recovery_ix(&sa.pubkey(), &ua.pubkey())],
    )
    .expect("the super admin cancels the recovery");
    send(
        &mut svm,
        &[&b],
        &[accept_platform_admin_ix(&b.pubkey(), &sa.pubkey())],
    )
    .expect("then the rotation goes through");
    assert_eq!(load::<Platform>(&svm, &platform_pda()).admin, b.pubkey());
}

/// While the bootstrap window is open the super admin could otherwise
/// propose + accept in ONE transaction; a live recovery refuses that too.
#[test]
fn a_live_recovery_blocks_a_bootstrap_rotation_in_one_transaction() {
    let (mut svm, sa, ua) = boot_platform(false);
    assert!(bootstrap_open(&svm));
    let c = funded(&mut svm);
    let b = funded(&mut svm);
    propose(&mut svm, &ua, &c.pubkey());
    assert_code(
        send(
            &mut svm,
            &[&sa, &b],
            &[
                propose_platform_admin_ix(&sa.pubkey(), &b.pubkey()),
                accept_platform_admin_ix(&b.pubkey(), &sa.pubkey()),
            ],
        ),
        ERR_PLATFORM_RECOVERY_PENDING,
        "propose + accept in one bootstrap transaction",
    );
    assert_eq!(load::<Platform>(&svm, &platform_pda()).admin, sa.pubkey());
}

// ── §14.7.4 ──────────────────────────────────────────────────────────────────

#[test]
fn a_recovery_retires_the_old_super_admins_pending_rotation_and_grants() {
    let (mut svm, sa, ua) = boot_platform(true);
    let c = funded(&mut svm);
    let d = funded(&mut svm);
    let x = funded(&mut svm);
    propose(&mut svm, &ua, &c.pubkey());
    // The (lost-key) super admin had staged a rotation and a grant.
    send(
        &mut svm,
        &[&sa],
        &[
            propose_platform_admin_ix(&sa.pubkey(), &d.pubkey()),
            propose_admin_ix(&sa.pubkey(), &x.pubkey()),
        ],
    )
    .unwrap();
    warp_to(&mut svm, T0 + PLATFORM_RECOVERY_DELAY_SECS);
    let logs = send(
        &mut svm,
        &[&c],
        &[execute_ix(&c.pubkey(), &sa.pubkey(), &ua.pubkey())],
    )
    .unwrap();
    assert!(logs
        .iter()
        .any(|l| l.contains("super-admin rotation retired")));
    assert_code(
        send(
            &mut svm,
            &[&d],
            &[accept_platform_admin_ix(&d.pubkey(), &c.pubkey())],
        ),
        ERR_INVALID_AUTHORITY_TRANSFER,
        "the retired rotation",
    );
    assert_code(
        send(&mut svm, &[&x], &[add_admin_ix(&x.pubkey(), &sa.pubkey())]),
        ERR_INVALID_ADMIN_PROPOSAL,
        "a grant of the old super admin",
    );
    // Proposed long before the recovery's 7 days: well past its 48 h.
    assert!(now(&svm) > T0 + ADMIN_TIMELOCK_SECS);
}

// ── §14.7.5 ──────────────────────────────────────────────────────────────────

#[test]
fn the_super_admin_or_the_proposer_cancels_and_the_rent_returns_to_the_proposer() {
    let (mut svm, sa, ua) = boot_platform(true);
    let c = funded(&mut svm);
    let stranger = funded(&mut svm);
    propose(&mut svm, &ua, &c.pubkey());
    assert_code(
        send(
            &mut svm,
            &[&stranger],
            &[cancel_platform_recovery_ix(
                &stranger.pubkey(),
                &ua.pubkey(),
            )],
        ),
        ERR_UNAUTHORIZED,
        "a random key",
    );
    assert_code(
        send(
            &mut svm,
            &[&sa],
            &[cancel_platform_recovery_ix(
                &sa.pubkey(),
                &stranger.pubkey(),
            )],
        ),
        ERR_INVALID_PLATFORM_RECOVERY,
        "the rent may only go to the proposer",
    );
    for canceller in [&sa, &ua] {
        if gone(&svm, &platform_recovery()) {
            propose(&mut svm, &ua, &c.pubkey());
        }
        let rent = lamports(&svm, &platform_recovery());
        let ua_before = lamports(&svm, &ua.pubkey());
        let logs = send(
            &mut svm,
            &[canceller],
            &[cancel_platform_recovery_ix(
                &canceller.pubkey(),
                &ua.pubkey(),
            )],
        )
        .expect("cancel");
        let fee = if canceller.pubkey() == ua.pubkey() {
            5_000
        } else {
            0
        };
        assert_eq!(lamports(&svm, &ua.pubkey()), ua_before + rent - fee);
        let ev = events::<PlatformRecoveryCancelled>(&logs);
        assert_eq!(
            (ev[0].cancelled_by, ev[0].new_admin),
            (canceller.pubkey(), c.pubkey())
        );
    }
}

// ── §14.7.6: Squads shape guards ─────────────────────────────────────────────

/// The Squads v4 `vault_transaction_create` a member sends to stage `inner`
/// (one instruction, the vault as its only signer): legacy transaction bytes
/// = 1 signature + header + the outer keys (multisig, transaction PDA,
/// creator = rent payer, system program, Squads program) + the instruction,
/// whose data is 8 (discriminator) + vault_index + ephemeral_signers + the
/// borsh `TransactionMessage` (u32 length prefix) + memo None. The message:
/// 3 header bytes, u8-counted keys, u8-counted instructions each with
/// program index, u8-counted account indexes and u16-counted data, and an
/// empty lookup-table list.
fn squads_create_tx_len(inner: &anchor_lang::solana_program::instruction::Instruction) -> usize {
    let mut keys: Vec<Pubkey> = Vec::new();
    for meta in &inner.accounts {
        if !keys.contains(&meta.pubkey) {
            keys.push(meta.pubkey);
        }
    }
    if !keys.contains(&inner.program_id) {
        keys.push(inner.program_id);
    }
    let message =
        3 + 1 + 32 * keys.len() + 1 + (1 + 1 + inner.accounts.len() + 2 + inner.data.len()) + 1;
    let data = 8 + 1 + 1 + 4 + message + 1;
    let outer_keys = 5;

    1 + 64 + 3 + 1 + 32 * outer_keys + 32 + 1 + (1 + 1 + 4 + 2 + data)
}

#[test]
fn every_recovery_step_fits_a_squads_vault_transaction() {
    let vault = Pubkey::new_unique();
    let sa = Pubkey::new_unique();
    let propose = propose_platform_recovery_ix(&vault, &sa, &registry_pd());
    assert!(
        propose.accounts.len() <= 7,
        "propose: {} metas",
        propose.accounts.len()
    );
    assert_eq!(propose.data.len(), 40, "propose data: discriminator + key");
    let cancel_grant = cancel_admin_proposal_ix(&vault, &Pubkey::new_unique(), &sa);
    assert_eq!(cancel_grant.accounts.len(), 7, "UA cancel of a grant");
    let cancel_rotation = cancel_platform_admin_transfer_ix(&vault, &sa, &registry_pd());
    assert_eq!(cancel_rotation.accounts.len(), 7, "UA cancel of a rotation");
    // The recovered super admin IS the Squads vault (the role map allows it).
    let execute = execute_platform_recovery_ix(&vault, &sa, &Pubkey::new_unique(), &registry_pd());
    assert_eq!(execute.accounts.len(), 10, "execute: 10 metas");
    for (label, ix) in [
        ("propose", &propose),
        ("cancel grant", &cancel_grant),
        ("cancel rotation", &cancel_rotation),
        ("execute", &execute),
    ] {
        let len = squads_create_tx_len(ix);
        assert!(len <= 1_232, "{label}: vault_transaction_create is {len} B");
    }
}

/// Finding 21: a re-proposal overwrites the recovery and restarts BOTH clocks.
#[test]
fn a_recovery_re_proposal_restarts_the_seven_day_clock() {
    let (mut svm, sa, ua) = boot_platform(true);
    let c = funded(&mut svm);
    let d = funded(&mut svm);
    propose(&mut svm, &ua, &c.pubkey());
    let t1 = T0 + PLATFORM_RECOVERY_DELAY_SECS - 3_600;
    warp_to(&mut svm, t1);
    propose(&mut svm, &ua, &d.pubkey());
    let rec: PlatformRecovery = load(&svm, &platform_recovery());
    assert_eq!(
        (rec.new_admin, rec.proposed_at, rec.eta, rec.expires_at),
        (
            d.pubkey(),
            t1,
            t1 + PLATFORM_RECOVERY_DELAY_SECS,
            t1 + PLATFORM_RECOVERY_DELAY_SECS + PROPOSAL_WINDOW_SECS
        )
    );
    warp_to(&mut svm, T0 + PLATFORM_RECOVERY_DELAY_SECS);
    assert_code(
        send(
            &mut svm,
            &[&d],
            &[execute_ix(&d.pubkey(), &sa.pubkey(), &ua.pubkey())],
        ),
        ERR_TIMELOCK_ACTIVE,
        "at the first proposal's eta",
    );
    assert_code(
        send(
            &mut svm,
            &[&c],
            &[execute_ix(&c.pubkey(), &sa.pubkey(), &ua.pubkey())],
        ),
        ERR_INVALID_PLATFORM_RECOVERY,
        "the overwritten key",
    );
    warp_to(&mut svm, t1 + PLATFORM_RECOVERY_DELAY_SECS);
    send(
        &mut svm,
        &[&d],
        &[execute_ix(&d.pubkey(), &sa.pubkey(), &ua.pubkey())],
    )
    .expect("at the re-proposal's eta");
    assert_eq!(load::<Platform>(&svm, &platform_pda()).admin, d.pubkey());
}
