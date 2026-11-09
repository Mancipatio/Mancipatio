//! `grant_admin` — the super admin's direct Admin grant (owner decision
//! 2026-11-09): no timelock, no signature of the new key, beside the D3
//! two-step grant (`test_admin_timelock.rs`) — LiteSVM over the real SBPF v3
//! build, with the bootstrap window closed (the 48 h of D3 would apply).

#[path = "../../../tests/support/mod.rs"]
mod support;
#[path = "../../../tests/support/v1.rs"]
mod v1;

use {
    anchor_lang::{prelude::Pubkey, AccountDeserialize},
    asset_registry::{Admin, AdminGranted, PAUSE_PRIMARY},
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_signer::Signer,
    v1::*,
};

const ERR_UNAUTHORIZED: u32 = 6001;
const ERR_INVALID_PROPOSED_AUTHORITY: u32 = 6112;
const ERR_ADMIN_GRANT_STAGED: u32 = 6156;
const ERR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;
/// System program `AccountAlreadyInUse`: the `init` of an existing record.
const ERR_ALREADY_IN_USE: u32 = 0;

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

/// A key that never signs anything and holds no SOL.
fn bare() -> Pubkey {
    Keypair::new().pubkey()
}

#[test]
fn the_super_admin_grants_at_once_without_the_new_key() {
    let (mut svm, sa, _ua) = boot_platform(true);
    assert!(!bootstrap_open(&svm));
    let x = Keypair::new();
    let logs = send(
        &mut svm,
        &[&sa],
        &[grant_admin_ix(&sa.pubkey(), &x.pubkey())],
    )
    .expect("grant_admin");

    let record: Admin = load(&svm, &admin_pda(&x.pubkey()));
    assert_eq!((record.admin, record.added_by), (x.pubkey(), sa.pubkey()));
    let ev = events::<AdminGranted>(&logs);
    assert_eq!(ev.len(), 1);
    assert_eq!(
        (ev[0].admin, ev[0].granted_by, ev[0].granted_at),
        (x.pubkey(), sa.pubkey(), now(&svm))
    );
    // Nothing was staged, and the new key never signed nor paid.
    assert!(gone(&svm, &pending_admin(&x.pubkey())));
    assert_eq!(lamports(&svm, &x.pubkey()), 0);

    // It is an Admin at once: it may set a pause bit (any Admin may).
    svm.airdrop(&x.pubkey(), 1_000_000_000).unwrap();
    send(
        &mut svm,
        &[&x],
        &[set_pause_flags_ix(&x.pubkey(), PAUSE_PRIMARY, 0)],
    )
    .expect("an Admin pauses");
    assert_eq!(pause_byte(&svm) & PAUSE_PRIMARY, PAUSE_PRIMARY);
}

#[test]
fn only_the_live_super_admin_grants() {
    let (mut svm, sa, ua) = boot_platform(true);
    let stranger = funded(&mut svm);
    assert_code(
        send(
            &mut svm,
            &[&stranger],
            &[grant_admin_ix(&stranger.pubkey(), &bare())],
        ),
        ERR_UNAUTHORIZED,
        "a stranger grants",
    );
    // An Admin is not enough, nor is the program upgrade authority.
    let admin = funded(&mut svm);
    send(
        &mut svm,
        &[&sa],
        &[grant_admin_ix(&sa.pubkey(), &admin.pubkey())],
    )
    .unwrap();
    assert_code(
        send(
            &mut svm,
            &[&admin],
            &[grant_admin_ix(&admin.pubkey(), &bare())],
        ),
        ERR_UNAUTHORIZED,
        "an Admin grants",
    );
    assert_code(
        send(&mut svm, &[&ua], &[grant_admin_ix(&ua.pubkey(), &bare())]),
        ERR_UNAUTHORIZED,
        "the upgrade authority grants",
    );
}

#[test]
fn never_twice_nor_to_the_default_key() {
    let (mut svm, sa, _ua) = boot_platform(true);
    let x = bare();
    send(&mut svm, &[&sa], &[grant_admin_ix(&sa.pubkey(), &x)]).unwrap();
    assert_code(
        send(&mut svm, &[&sa], &[grant_admin_ix(&sa.pubkey(), &x)]),
        ERR_ALREADY_IN_USE,
        "a second grant",
    );
    // The super admin already holds its own Admin record.
    assert_code(
        send(
            &mut svm,
            &[&sa],
            &[grant_admin_ix(&sa.pubkey(), &sa.pubkey())],
        ),
        ERR_ALREADY_IN_USE,
        "the super admin itself",
    );
    assert_code(
        send(
            &mut svm,
            &[&sa],
            &[grant_admin_ix(&sa.pubkey(), &Pubkey::default())],
        ),
        ERR_INVALID_PROPOSED_AUTHORITY,
        "the default key",
    );
}

#[test]
fn a_granted_admin_is_removed_at_once_and_the_rent_returns() {
    let (mut svm, sa, _ua) = boot_platform(true);
    let x = bare();
    let record = admin_pda(&x);
    let before = lamports(&svm, &sa.pubkey());
    send(&mut svm, &[&sa], &[grant_admin_ix(&sa.pubkey(), &x)]).unwrap();
    let rent = lamports(&svm, &record);
    assert!(rent > 0);
    send(&mut svm, &[&sa], &[remove_admin_ix(&sa.pubkey(), &x)]).expect("remove_admin");
    assert!(gone(&svm, &record));
    // Only the two fees are spent: the record's rent came back.
    let fees = before - lamports(&svm, &sa.pubkey());
    assert!(fees < 20_000, "fees {fees}");
}

#[test]
fn a_staged_grant_for_the_same_key_is_cancelled_in_the_same_transaction() {
    let (mut svm, sa, _ua) = boot_platform(true);
    let x = funded(&mut svm);
    send(
        &mut svm,
        &[&sa],
        &[propose_admin_ix(&sa.pubkey(), &x.pubkey())],
    )
    .unwrap();
    send(
        &mut svm,
        &[&sa],
        &[
            cancel_admin_proposal_ix(&sa.pubkey(), &x.pubkey(), &sa.pubkey()),
            grant_admin_ix(&sa.pubkey(), &x.pubkey()),
        ],
    )
    .expect("cancel + grant");
    assert!(gone(&svm, &pending_admin(&x.pubkey())));
    let record: Admin = load(&svm, &admin_pda(&x.pubkey()));
    assert_eq!(record.added_by, sa.pubkey());
}

/// Review finding: a proposal left next to a directly granted record would
/// let the key re-create its role with `add_admin` after a `remove_admin`.
/// The direct grant is refused while a grant is staged, so a revoke sticks.
#[test]
fn a_staged_grant_blocks_the_direct_grant_until_cancelled_so_a_revoke_sticks() {
    let (mut svm, sa, _ua) = boot_platform(true);
    let x = funded(&mut svm);
    send(
        &mut svm,
        &[&sa],
        &[propose_admin_ix(&sa.pubkey(), &x.pubkey())],
    )
    .unwrap();
    assert_code(
        send(
            &mut svm,
            &[&sa],
            &[grant_admin_ix(&sa.pubkey(), &x.pubkey())],
        ),
        ERR_ADMIN_GRANT_STAGED,
        "a direct grant next to a staged one",
    );
    assert!(gone(&svm, &admin_pda(&x.pubkey())));
    // Cancelled first in the same transaction, the grant lands.
    send(
        &mut svm,
        &[&sa],
        &[
            cancel_admin_proposal_ix(&sa.pubkey(), &x.pubkey(), &sa.pubkey()),
            grant_admin_ix(&sa.pubkey(), &x.pubkey()),
        ],
    )
    .expect("cancel + grant");
    // Revoked, the key has nothing left to execute, even inside the old window.
    send(
        &mut svm,
        &[&sa],
        &[remove_admin_ix(&sa.pubkey(), &x.pubkey())],
    )
    .expect("remove_admin");
    let eta = now(&svm) + asset_registry::ADMIN_TIMELOCK_SECS;
    warp_to(&mut svm, eta);
    assert_code(
        send(&mut svm, &[&x], &[add_admin_ix(&x.pubkey(), &sa.pubkey())]),
        ERR_ACCOUNT_NOT_INITIALIZED,
        "the revoked key re-adds itself",
    );
    assert!(gone(&svm, &admin_pda(&x.pubkey())));
}

#[test]
fn a_former_super_admin_no_longer_grants() {
    let (mut svm, sa, _ua) = boot_platform(true);
    let next = funded(&mut svm);
    send(
        &mut svm,
        &[&sa],
        &[propose_platform_admin_ix(&sa.pubkey(), &next.pubkey())],
    )
    .unwrap();
    let eta = now(&svm) + asset_registry::SUPER_ADMIN_ROTATION_TIMELOCK_SECS;
    warp_to(&mut svm, eta);
    send(
        &mut svm,
        &[&next],
        &[accept_platform_admin_ix(&next.pubkey(), &sa.pubkey())],
    )
    .expect("rotation accepted");
    assert_code(
        send(&mut svm, &[&sa], &[grant_admin_ix(&sa.pubkey(), &bare())]),
        ERR_UNAUTHORIZED,
        "the former super admin grants",
    );
    send(
        &mut svm,
        &[&next],
        &[grant_admin_ix(&next.pubkey(), &bare())],
    )
    .expect("the new super admin grants");
}
