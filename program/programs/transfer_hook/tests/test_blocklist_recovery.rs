//! BlocklistAuthority rotation expiry / cancel and its D4 recovery by the
//! program upgrade authority after 7 days (design 8.3 §6, §7.2, §14.8) —
//! LiteSVM over the real SBPF v3 hook build.

#[path = "../../../tests/support/mod.rs"]
mod support;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_clock::Clock,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    transfer_hook::{
        accounts as acc, instruction as ixd, BlocklistAuthority, BlocklistAuthorityProposal,
        BlocklistAuthorityTransfer, BlocklistRecovery, PROPOSAL_WINDOW_SECS, RECOVERY_DELAY_SECS,
    },
};

const T0: i64 = 1_000_000;
const ERR_UNAUTHORIZED: u32 = 6004;
const ERR_INVALID_PROPOSED_AUTHORITY: u32 = 6014;
const ERR_INVALID_AUTHORITY_TRANSFER: u32 = 6015;
const ERR_PROPOSAL_EXPIRED: u32 = 6017;
const ERR_TIMELOCK_ACTIVE: u32 = 6018;
const ERR_INVALID_RECOVERY: u32 = 6019;
const ERR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &transfer_hook::ID).0
}
fn ba_pda() -> Pubkey {
    pda(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED])
}
fn proposal_pda() -> Pubkey {
    pda(&[transfer_hook::BLOCKLIST_AUTHORITY_PROPOSAL_SEED])
}
fn recovery_pda() -> Pubkey {
    pda(&[transfer_hook::BLOCKLIST_RECOVERY_SEED])
}
fn hook_pd() -> Pubkey {
    support::program_data(&transfer_hook::ID)
}

struct T {
    svm: LiteSVM,
    /// The BlocklistAuthority.
    ba: Keypair,
    /// The hook's upgrade authority.
    ua: Keypair,
}

fn funded(svm: &mut LiteSVM) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    k
}

fn send(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction]) -> Result<(), String> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).expect("sign");
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

fn code(result: Result<(), String>, code: u32, what: &str) {
    let err = result.expect_err(what);
    assert!(
        err.contains(&format!("Custom({code})")),
        "{what}: expected {code}, got {err}"
    );
}

fn warp_to(svm: &mut LiteSVM, ts: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = ts;
    svm.set_sysvar(&clock);
}

fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

fn load<D: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> D {
    let account = svm.get_account(key).expect("account");
    D::try_deserialize(&mut account.data.as_slice()).expect("decode")
}

fn gone(svm: &LiteSVM, key: &Pubkey) -> bool {
    svm.get_account(key)
        .is_none_or(|a| a.lamports == 0 && a.data.is_empty())
}

fn boot() -> T {
    let mut svm = LiteSVM::new();
    svm.add_program(
        transfer_hook::ID,
        support::assert_sbpf_v3(include_bytes!("../../../target/deploy/transfer_hook.so")),
    )
    .unwrap();
    warp_to(&mut svm, T0);
    let ba = funded(&mut svm);
    let ua = funded(&mut svm);
    support::set_upgrade_authority(&mut svm, &transfer_hook::ID, Some(ua.pubkey()));
    let init = Instruction::new_with_bytes(
        transfer_hook::ID,
        &ixd::InitializeBlocklistAuthority {
            authority: ba.pubkey(),
        }
        .data(),
        acc::InitializeBlocklistAuthority {
            payer: ua.pubkey(),
            blocklist_authority: ba_pda(),
            system_program: system_program::ID,
            upgrade_authority: ua.pubkey(),
            program: transfer_hook::ID,
            program_data: hook_pd(),
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[&ua], &[init]).expect("initialize_blocklist_authority");
    T { svm, ba, ua }
}

fn propose_ix(authority: &Pubkey, new_authority: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        transfer_hook::ID,
        &ixd::ProposeBlocklistAuthority {
            new_authority: *new_authority,
        }
        .data(),
        acc::ProposeBlocklistAuthority {
            authority: *authority,
            blocklist_authority: ba_pda(),
            transfer: proposal_pda(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn accept_ix(new_authority: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        transfer_hook::ID,
        &ixd::AcceptBlocklistAuthority {}.data(),
        acc::AcceptBlocklistAuthority {
            new_authority: *new_authority,
            blocklist_authority: ba_pda(),
            transfer: proposal_pda(),
            recovery: recovery_pda(),
        }
        .to_account_metas(None),
    )
}

fn cancel_ix(authority: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        transfer_hook::ID,
        &ixd::CancelBlocklistAuthorityTransfer {}.data(),
        acc::CancelBlocklistAuthorityTransfer {
            authority: *authority,
            blocklist_authority: ba_pda(),
            transfer: proposal_pda(),
        }
        .to_account_metas(None),
    )
}

fn propose_recovery_ix(
    upgrade_authority: &Pubkey,
    new_authority: &Pubkey,
    program_data: &Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        transfer_hook::ID,
        &ixd::ProposeBlocklistRecovery {
            new_authority: *new_authority,
        }
        .data(),
        acc::ProposeBlocklistRecovery {
            upgrade_authority: *upgrade_authority,
            blocklist_authority: ba_pda(),
            recovery: recovery_pda(),
            program: transfer_hook::ID,
            program_data: *program_data,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn cancel_recovery_ix(canceller: &Pubkey, proposer: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        transfer_hook::ID,
        &ixd::CancelBlocklistRecovery {}.data(),
        acc::CancelBlocklistRecovery {
            canceller: *canceller,
            blocklist_authority: ba_pda(),
            recovery: recovery_pda(),
            proposer: *proposer,
        }
        .to_account_metas(None),
    )
}

fn execute_recovery_ix(
    new_authority: &Pubkey,
    proposer: &Pubkey,
    program_data: &Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        transfer_hook::ID,
        &ixd::ExecuteBlocklistRecovery {}.data(),
        acc::ExecuteBlocklistRecovery {
            new_authority: *new_authority,
            blocklist_authority: ba_pda(),
            recovery: recovery_pda(),
            proposer: *proposer,
            program: transfer_hook::ID,
            program_data: *program_data,
            transfer: proposal_pda(),
        }
        .to_account_metas(None),
    )
}

fn authority(svm: &LiteSVM) -> Pubkey {
    load::<BlocklistAuthority>(svm, &ba_pda()).authority
}

// ── §14.8.5: layout pins ─────────────────────────────────────────────────────

#[test]
fn proposal_and_recovery_layouts_are_pinned() {
    assert_eq!(8 + BlocklistAuthorityProposal::INIT_SPACE, 89);
    assert_eq!(8 + BlocklistRecovery::INIT_SPACE, 129);
    assert_eq!(8 + BlocklistAuthorityTransfer::INIT_SPACE, 73);
    let key = |b: u8| Pubkey::new_from_array([b; 32]);
    let mut data = Vec::new();
    BlocklistAuthorityProposal {
        current_authority: key(1),
        new_authority: key(2),
        proposed_at: 3,
        expires_at: 4,
        bump: 5,
    }
    .try_serialize(&mut data)
    .unwrap();
    assert_eq!(data.len(), 89);
    assert_eq!(data[8..40], [1; 32]);
    assert_eq!(
        data[40..72],
        [2; 32],
        "new_authority at 40 (the legacy offset)"
    );
    assert_eq!(data[72..80], 3i64.to_le_bytes());
    assert_eq!(data[80..88], 4i64.to_le_bytes());
    assert_eq!(data[88], 5);
    let mut data = Vec::new();
    BlocklistRecovery {
        current_authority: key(1),
        new_authority: key(2),
        proposed_by: key(3),
        proposed_at: 4,
        eta: 5,
        expires_at: 6,
        bump: 7,
    }
    .try_serialize(&mut data)
    .unwrap();
    assert_eq!(data.len(), 129);
    assert_eq!(data[8..40], [1; 32]);
    assert_eq!(data[40..72], [2; 32]);
    assert_eq!(data[72..104], [3; 32]);
    assert_eq!(data[104..112], 4i64.to_le_bytes());
    assert_eq!(data[112..120], 5i64.to_le_bytes());
    assert_eq!(data[120..128], 6i64.to_le_bytes());
    assert_eq!(data[128], 7);
}

#[test]
fn v1_hook_error_codes_are_appended() {
    use transfer_hook::HookError as E;
    let c = |e: E| 6000 + e as u32;
    assert_eq!(c(E::Unauthorized), 6004);
    assert_eq!(c(E::InvalidProposedAuthority), 6014);
    assert_eq!(c(E::InvalidAuthorityTransfer), 6015);
    assert_eq!(c(E::KycRegistryNotAllowed), 6016);
    assert_eq!(c(E::ProposalExpired), 6017);
    assert_eq!(c(E::TimelockActive), 6018);
    assert_eq!(c(E::InvalidRecovery), 6019);
}

// ── §14.8.1-2: rotation expiry, cancel, the legacy account ──────────────────

#[test]
fn a_rotation_expires_after_fourteen_days_and_the_current_authority_cancels() {
    let mut t = boot();
    let b = funded(&mut t.svm);
    let stranger = funded(&mut t.svm);
    send(
        &mut t.svm,
        &[&t.ba],
        &[propose_ix(&t.ba.pubkey(), &b.pubkey())],
    )
    .unwrap();
    let staged: BlocklistAuthorityProposal = load(&t.svm, &proposal_pda());
    assert_eq!(
        (staged.proposed_at, staged.expires_at),
        (T0, T0 + PROPOSAL_WINDOW_SECS)
    );
    warp_to(&mut t.svm, T0 + PROPOSAL_WINDOW_SECS);
    code(
        send(&mut t.svm, &[&b], &[accept_ix(&b.pubkey())]),
        ERR_PROPOSAL_EXPIRED,
        "at expires_at",
    );
    code(
        send(&mut t.svm, &[&stranger], &[cancel_ix(&stranger.pubkey())]),
        ERR_UNAUTHORIZED,
        "another key cancels",
    );
    send(&mut t.svm, &[&t.ba], &[cancel_ix(&t.ba.pubkey())]).expect("the BA cancels");
    assert!(gone(&t.svm, &proposal_pda()));
    code(
        send(&mut t.svm, &[&b], &[accept_ix(&b.pubkey())]),
        ERR_ACCOUNT_NOT_INITIALIZED,
        "accept after a cancel",
    );
    // One second before the expiry it is still acceptable.
    let t1 = now(&t.svm);
    send(
        &mut t.svm,
        &[&t.ba],
        &[propose_ix(&t.ba.pubkey(), &b.pubkey())],
    )
    .unwrap();
    warp_to(&mut t.svm, t1 + PROPOSAL_WINDOW_SECS - 1);
    send(&mut t.svm, &[&b], &[accept_ix(&b.pubkey())]).expect("inside the window");
    assert_eq!(authority(&t.svm), b.pubkey());
}

#[test]
fn a_legacy_rc_x_transfer_account_is_ignored() {
    let mut t = boot();
    let b = funded(&mut t.svm);
    let legacy = pda(&[transfer_hook::BLOCKLIST_AUTHORITY_TRANSFER_SEED]);
    let mut data = Vec::new();
    BlocklistAuthorityTransfer {
        current_authority: t.ba.pubkey(),
        new_authority: b.pubkey(),
        bump: 255,
    }
    .try_serialize(&mut data)
    .unwrap();
    let mut account = t.svm.get_account(&ba_pda()).unwrap();
    account.data = data;
    account.lamports = t.svm.minimum_balance_for_rent_exemption(73);
    t.svm.set_account(legacy, account).unwrap();
    code(
        send(&mut t.svm, &[&b], &[accept_ix(&b.pubkey())]),
        ERR_ACCOUNT_NOT_INITIALIZED,
        "a legacy transfer is never accepted",
    );
    assert_eq!(authority(&t.svm), t.ba.pubkey());
}

// ── §14.8.3: recovery ────────────────────────────────────────────────────────

#[test]
fn only_the_upgrade_authority_proposes_a_recovery_of_a_different_key() {
    let mut t = boot();
    let c = funded(&mut t.svm);
    code(
        send(
            &mut t.svm,
            &[&t.ba],
            &[propose_recovery_ix(&t.ba.pubkey(), &c.pubkey(), &hook_pd())],
        ),
        ERR_UNAUTHORIZED,
        "the BA is not the upgrade authority",
    );
    for bad in [t.ba.pubkey(), Pubkey::default()] {
        code(
            send(
                &mut t.svm,
                &[&t.ua],
                &[propose_recovery_ix(&t.ua.pubkey(), &bad, &hook_pd())],
            ),
            ERR_INVALID_PROPOSED_AUTHORITY,
            "the current BA or the default key",
        );
    }
    send(
        &mut t.svm,
        &[&t.ua],
        &[propose_recovery_ix(&t.ua.pubkey(), &c.pubkey(), &hook_pd())],
    )
    .expect("propose");
    let rec: BlocklistRecovery = load(&t.svm, &recovery_pda());
    assert_eq!(
        (rec.current_authority, rec.new_authority, rec.proposed_by),
        (t.ba.pubkey(), c.pubkey(), t.ua.pubkey())
    );
    assert_eq!(rec.eta, T0 + RECOVERY_DELAY_SECS);
    assert_eq!(rec.expires_at, rec.eta + PROPOSAL_WINDOW_SECS);
}

#[test]
fn a_recovery_executes_after_seven_days_and_retires_a_pending_rotation() {
    let mut t = boot();
    let c = funded(&mut t.svm);
    let d = funded(&mut t.svm);
    send(
        &mut t.svm,
        &[&t.ua],
        &[propose_recovery_ix(&t.ua.pubkey(), &c.pubkey(), &hook_pd())],
    )
    .unwrap();
    // The (lost-key) BA had staged a rotation to D.
    send(
        &mut t.svm,
        &[&t.ba],
        &[propose_ix(&t.ba.pubkey(), &d.pubkey())],
    )
    .unwrap();
    let execute = execute_recovery_ix(&c.pubkey(), &t.ua.pubkey(), &hook_pd());
    warp_to(&mut t.svm, T0 + RECOVERY_DELAY_SECS - 1);
    code(
        send(&mut t.svm, &[&c], std::slice::from_ref(&execute)),
        ERR_TIMELOCK_ACTIVE,
        "one second early",
    );
    warp_to(&mut t.svm, T0 + RECOVERY_DELAY_SECS);
    send(&mut t.svm, &[&c], &[execute]).expect("at the eta");
    assert_eq!(authority(&t.svm), c.pubkey());
    assert!(gone(&t.svm, &recovery_pda()));
    assert_eq!(
        load::<BlocklistAuthorityProposal>(&t.svm, &proposal_pda()).current_authority,
        Pubkey::default(),
        "the pending rotation is retired"
    );
    code(
        send(&mut t.svm, &[&d], &[accept_ix(&d.pubkey())]),
        ERR_INVALID_AUTHORITY_TRANSFER,
        "the retired rotation",
    );
}

#[test]
fn a_recovery_expires_and_is_bound_to_the_signer_the_ba_and_the_upgrade_authority() {
    let mut t = boot();
    let c = funded(&mut t.svm);
    let stranger = funded(&mut t.svm);
    send(
        &mut t.svm,
        &[&t.ua],
        &[propose_recovery_ix(&t.ua.pubkey(), &c.pubkey(), &hook_pd())],
    )
    .unwrap();
    warp_to(&mut t.svm, T0 + RECOVERY_DELAY_SECS);
    code(
        send(
            &mut t.svm,
            &[&stranger],
            &[execute_recovery_ix(
                &stranger.pubkey(),
                &t.ua.pubkey(),
                &hook_pd(),
            )],
        ),
        ERR_INVALID_RECOVERY,
        "not the proposed key",
    );
    // Another program's ProgramData (the registry's, same upgrade authority).
    let mut svm_pd = t.svm.get_account(&hook_pd()).unwrap();
    let registry_pd = Pubkey::new_unique();
    svm_pd.data[13..45].copy_from_slice(t.ua.pubkey().as_ref());
    t.svm.set_account(registry_pd, svm_pd).unwrap();
    code(
        send(
            &mut t.svm,
            &[&c],
            &[execute_recovery_ix(
                &c.pubkey(),
                &t.ua.pubkey(),
                &registry_pd,
            )],
        ),
        ERR_UNAUTHORIZED,
        "a ProgramData not bound to the hook",
    );
    // The upgrade authority moved.
    let new_ua = funded(&mut t.svm);
    support::set_upgrade_authority(&mut t.svm, &transfer_hook::ID, Some(new_ua.pubkey()));
    code(
        send(
            &mut t.svm,
            &[&c],
            &[execute_recovery_ix(&c.pubkey(), &t.ua.pubkey(), &hook_pd())],
        ),
        ERR_INVALID_RECOVERY,
        "the upgrade authority changed",
    );
    support::set_upgrade_authority(&mut t.svm, &transfer_hook::ID, Some(t.ua.pubkey()));
    // Expiry.
    warp_to(&mut t.svm, T0 + RECOVERY_DELAY_SECS + PROPOSAL_WINDOW_SECS);
    code(
        send(
            &mut t.svm,
            &[&c],
            &[execute_recovery_ix(&c.pubkey(), &t.ua.pubkey(), &hook_pd())],
        ),
        ERR_PROPOSAL_EXPIRED,
        "at expires_at",
    );
}

#[test]
fn a_rotation_retires_a_pending_recovery_so_a_round_trip_cannot_revive_it() {
    let mut t = boot();
    let b = funded(&mut t.svm);
    let c = funded(&mut t.svm);
    send(
        &mut t.svm,
        &[&t.ua],
        &[propose_recovery_ix(&t.ua.pubkey(), &c.pubkey(), &hook_pd())],
    )
    .unwrap();
    // BA -> B -> BA.
    send(
        &mut t.svm,
        &[&t.ba],
        &[propose_ix(&t.ba.pubkey(), &b.pubkey())],
    )
    .unwrap();
    send(&mut t.svm, &[&b], &[accept_ix(&b.pubkey())]).unwrap();
    assert_eq!(
        load::<BlocklistRecovery>(&t.svm, &recovery_pda()).current_authority,
        Pubkey::default()
    );
    send(
        &mut t.svm,
        &[&b],
        &[propose_ix(&b.pubkey(), &t.ba.pubkey())],
    )
    .unwrap();
    send(&mut t.svm, &[&t.ba], &[accept_ix(&t.ba.pubkey())]).unwrap();
    warp_to(&mut t.svm, T0 + RECOVERY_DELAY_SECS);
    code(
        send(
            &mut t.svm,
            &[&c],
            &[execute_recovery_ix(&c.pubkey(), &t.ua.pubkey(), &hook_pd())],
        ),
        ERR_INVALID_RECOVERY,
        "a retired recovery after a round trip",
    );
}

#[test]
fn the_ba_or_the_upgrade_authority_cancels_a_recovery() {
    let mut t = boot();
    let c = funded(&mut t.svm);
    let stranger = funded(&mut t.svm);
    let propose = |t: &mut T| {
        send(
            &mut t.svm,
            &[&t.ua],
            &[propose_recovery_ix(&t.ua.pubkey(), &c.pubkey(), &hook_pd())],
        )
        .unwrap();
    };
    propose(&mut t);
    code(
        send(
            &mut t.svm,
            &[&stranger],
            &[cancel_recovery_ix(&stranger.pubkey(), &t.ua.pubkey())],
        ),
        ERR_UNAUTHORIZED,
        "another key",
    );
    code(
        send(
            &mut t.svm,
            &[&t.ba],
            &[cancel_recovery_ix(&t.ba.pubkey(), &stranger.pubkey())],
        ),
        ERR_INVALID_RECOVERY,
        "the rent may only go to the proposer",
    );
    send(
        &mut t.svm,
        &[&t.ba],
        &[cancel_recovery_ix(&t.ba.pubkey(), &t.ua.pubkey())],
    )
    .expect("the BA cancels");
    assert!(gone(&t.svm, &recovery_pda()));
    propose(&mut t);
    send(
        &mut t.svm,
        &[&t.ua],
        &[cancel_recovery_ix(&t.ua.pubkey(), &t.ua.pubkey())],
    )
    .expect("the upgrade authority cancels");
    assert!(gone(&t.svm, &recovery_pda()));
}
