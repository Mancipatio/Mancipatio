//! The incident artifacts (design 8.3 §7.4, O-12; §14.11): the SAME source
//! built with `--features incident` (`bash scripts/build-sbf.sh --incident`,
//! into `target/deploy-incident/`) has a zero recovery delay, and only the
//! proposing upgrade authority may cancel a recovery — the case is a
//! COMPROMISED super admin / BlocklistAuthority, which must not be able to
//! block its own replacement. Never the deployed release and never on
//! devnet: program-ci and verifiable-build build, gate and test it with every
//! release, and the Release ships it beside the release bytes (O-12) for the
//! upgrade authority to deploy only in an incident.
//!
//! The artifacts are read at run time. Without them the tests report and
//! pass, unless `MANCI_REQUIRE_INCIDENT=1` (program-ci sets it right after
//! building them, so a missing artifact fails loudly there). An artifact
//! OLDER than any program source, manifest or the lockfile fails in every
//! mode: a stale incident build must never pass for a fresh one.
//!
//! The front-run cases (review findings 1/8/23): a compromised super admin /
//! BlocklistAuthority cannot cancel the recovery here, and it cannot rotate
//! to a second key of its own between the propose and the execute either —
//! the accept is refused while the recovery is live — so the recovery lands
//! even when propose and execute are separate transactions.

#[path = "../../../tests/support/mod.rs"]
mod support;
#[path = "../../../tests/support/v1.rs"]
mod v1;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_signer::Signer,
    v1::*,
};

/// The newest modification time among the inputs of an SBF build: every
/// file under `programs/*/src`, both program manifests, the workspace
/// manifest and the lockfile.
fn newest_source_mtime() -> std::time::SystemTime {
    fn walk(dir: &std::path::Path, newest: &mut std::time::SystemTime) {
        for entry in std::fs::read_dir(dir).expect("read_dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                walk(&path, newest);
            } else {
                let modified = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .expect("mtime");
                *newest = (*newest).max(modified);
            }
        }
    }
    let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut newest = std::time::SystemTime::UNIX_EPOCH;
    for program in ["asset_registry", "transfer_hook"] {
        walk(
            &workspace.join("programs").join(program).join("src"),
            &mut newest,
        );
        let manifest = workspace.join("programs").join(program).join("Cargo.toml");
        newest = newest.max(std::fs::metadata(manifest).unwrap().modified().unwrap());
    }
    for file in ["Cargo.toml", "Cargo.lock"] {
        newest = newest.max(
            std::fs::metadata(workspace.join(file))
                .unwrap()
                .modified()
                .unwrap(),
        );
    }
    newest
}

fn artifact(name: &str) -> Option<Vec<u8>> {
    let path = format!(
        "{}/../../target/deploy-incident/{name}.so",
        env!("CARGO_MANIFEST_DIR")
    );
    match std::fs::read(&path) {
        Ok(bytes) => {
            support::assert_sbpf_v3(&bytes);
            let built = std::fs::metadata(&path).unwrap().modified().unwrap();
            assert!(
                built >= newest_source_mtime(),
                "{path} is older than the program sources: rebuild it with \
                 `bash scripts/build-sbf.sh --incident`"
            );
            Some(bytes)
        }
        Err(_) if std::env::var("MANCI_REQUIRE_INCIDENT").is_ok_and(|v| v == "1") => {
            panic!("{path} missing: run `bash scripts/build-sbf.sh --incident`")
        }
        Err(_) => {
            eprintln!("skipped: {path} missing (bash scripts/build-sbf.sh --incident)");
            None
        }
    }
}

/// The incident registry + hook, a Platform (super admin `sa`) and a
/// BlocklistAuthority (`ba`), both programs upgraded by `ua`.
fn boot_incident() -> Option<(LiteSVM, Keypair, Keypair, Keypair)> {
    let registry = artifact("asset_registry")?;
    let hook = artifact("transfer_hook")?;
    let mut svm = LiteSVM::new();
    svm.add_program(asset_registry::ID, &registry).unwrap();
    svm.add_program(transfer_hook::ID, &hook).unwrap();
    warp_to(&mut svm, T0);
    let sa = funded(&mut svm);
    let ua = funded(&mut svm);
    let ba = funded(&mut svm);
    set_upgrade_authority(&mut svm, &asset_registry::ID, Some(ua.pubkey()));
    set_upgrade_authority(&mut svm, &transfer_hook::ID, Some(ua.pubkey()));
    let init = Instruction::new_with_bytes(
        asset_registry::ID,
        &asset_registry::instruction::InitializePlatform {
            protocol_treasury: Pubkey::new_unique(),
            protocol_fee_bps: 250,
        }
        .data(),
        asset_registry::accounts::InitializePlatform {
            admin: sa.pubkey(),
            platform: platform_pda(),
            super_admin_record: admin_pda(&sa.pubkey()),
            system_program: system_program::ID,
            upgrade_authority: ua.pubkey(),
            program: asset_registry::ID,
            program_data: program_data(&asset_registry::ID),
        }
        .to_account_metas(None),
    );
    let init_ba = Instruction::new_with_bytes(
        transfer_hook::ID,
        &transfer_hook::instruction::InitializeBlocklistAuthority {
            authority: ba.pubkey(),
        }
        .data(),
        transfer_hook::accounts::InitializeBlocklistAuthority {
            payer: ua.pubkey(),
            blocklist_authority: hook_pda(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED]),
            system_program: system_program::ID,
            upgrade_authority: ua.pubkey(),
            program: transfer_hook::ID,
            program_data: program_data(&transfer_hook::ID),
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[&ua, &sa], &[init, init_ba]).expect("init both");
    Some((svm, sa, ua, ba))
}

fn hook_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &transfer_hook::ID).0
}

#[test]
fn the_incident_registry_recovers_the_super_admin_at_once_and_only_the_ua_cancels() {
    let Some((mut svm, sa, ua, _ba)) = boot_incident() else {
        return;
    };
    assert_eq!(
        asset_registry::PLATFORM_RECOVERY_DELAY_SECS,
        604_800,
        "release constant here"
    );
    let c = funded(&mut svm);
    let pd = program_data(&asset_registry::ID);
    let propose = propose_platform_recovery_ix(&ua.pubkey(), &c.pubkey(), &pd);
    send(&mut svm, &[&ua], std::slice::from_ref(&propose)).expect("propose");
    let rec: asset_registry::PlatformRecovery = {
        let a = svm.get_account(&platform_recovery()).unwrap();
        asset_registry::PlatformRecovery::try_deserialize(&mut a.data.as_slice()).unwrap()
    };
    assert_eq!(rec.eta, rec.proposed_at, "zero delay");
    // The (compromised) super admin cannot cancel it …
    assert_code(
        send(
            &mut svm,
            &[&sa],
            &[cancel_platform_recovery_ix(&sa.pubkey(), &ua.pubkey())],
        ),
        6001,
        "the super admin cancels in the incident build",
    );
    // … the upgrade authority can, and re-propose …
    send(
        &mut svm,
        &[&ua],
        &[cancel_platform_recovery_ix(&ua.pubkey(), &ua.pubkey())],
    )
    .expect("the UA cancels");
    send(&mut svm, &[&ua], &[propose]).expect("re-propose");
    // … and the new key executes in the next transaction, same clock.
    send(
        &mut svm,
        &[&c],
        &[execute_platform_recovery_ix(
            &c.pubkey(),
            &sa.pubkey(),
            &ua.pubkey(),
            &pd,
        )],
    )
    .expect("execute at once");
    let platform: asset_registry::Platform = {
        let a = svm.get_account(&platform_pda()).unwrap();
        asset_registry::Platform::try_deserialize(&mut a.data.as_slice()).unwrap()
    };
    assert_eq!(platform.admin, c.pubkey());
}

#[test]
fn the_incident_hook_recovers_the_blocklist_authority_at_once_and_only_the_ua_cancels() {
    let Some((mut svm, _sa, ua, ba)) = boot_incident() else {
        return;
    };
    let c = funded(&mut svm);
    let ba_pda = hook_pda(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED]);
    let recovery = hook_pda(&[transfer_hook::BLOCKLIST_RECOVERY_SEED]);
    let proposal = hook_pda(&[transfer_hook::BLOCKLIST_AUTHORITY_PROPOSAL_SEED]);
    let pd = program_data(&transfer_hook::ID);
    let propose = Instruction::new_with_bytes(
        transfer_hook::ID,
        &transfer_hook::instruction::ProposeBlocklistRecovery {
            new_authority: c.pubkey(),
        }
        .data(),
        transfer_hook::accounts::ProposeBlocklistRecovery {
            upgrade_authority: ua.pubkey(),
            blocklist_authority: ba_pda,
            recovery,
            program: transfer_hook::ID,
            program_data: pd,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let cancel = |canceller: &Pubkey| {
        Instruction::new_with_bytes(
            transfer_hook::ID,
            &transfer_hook::instruction::CancelBlocklistRecovery {}.data(),
            transfer_hook::accounts::CancelBlocklistRecovery {
                canceller: *canceller,
                blocklist_authority: ba_pda,
                recovery,
                proposer: ua.pubkey(),
            }
            .to_account_metas(None),
        )
    };
    send(&mut svm, &[&ua], std::slice::from_ref(&propose)).expect("propose");
    assert_code(
        send(&mut svm, &[&ba], &[cancel(&ba.pubkey())]),
        6004,
        "the BlocklistAuthority cancels in the incident build",
    );
    send(&mut svm, &[&ua], &[cancel(&ua.pubkey())]).expect("the UA cancels");
    send(&mut svm, &[&ua], &[propose]).expect("re-propose");
    let execute = Instruction::new_with_bytes(
        transfer_hook::ID,
        &transfer_hook::instruction::ExecuteBlocklistRecovery {}.data(),
        transfer_hook::accounts::ExecuteBlocklistRecovery {
            new_authority: c.pubkey(),
            blocklist_authority: ba_pda,
            recovery,
            proposer: ua.pubkey(),
            program: transfer_hook::ID,
            program_data: pd,
            transfer: proposal,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[&c], &[execute]).expect("execute at once");
    let ba_state: transfer_hook::BlocklistAuthority = {
        let a = svm.get_account(&ba_pda).unwrap();
        transfer_hook::BlocklistAuthority::try_deserialize(&mut a.data.as_slice()).unwrap()
    };
    assert_eq!(ba_state.authority, c.pubkey());
}

/// Findings 1/8/23: the compromised BlocklistAuthority front-runs the
/// execute with a rotation to a second key of its own (propose + accept in
/// ONE transaction). The accept is refused while the recovery is live, so
/// the recovery still executes in the next transaction.
#[test]
fn a_compromised_ba_cannot_rotate_away_from_the_incident_recovery() {
    let Some((mut svm, _sa, ua, ba)) = boot_incident() else {
        return;
    };
    let n = funded(&mut svm);
    let k2 = funded(&mut svm);
    let ba_pda = hook_pda(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED]);
    let recovery = hook_pda(&[transfer_hook::BLOCKLIST_RECOVERY_SEED]);
    let proposal = hook_pda(&[transfer_hook::BLOCKLIST_AUTHORITY_PROPOSAL_SEED]);
    let pd = program_data(&transfer_hook::ID);
    let propose_recovery = Instruction::new_with_bytes(
        transfer_hook::ID,
        &transfer_hook::instruction::ProposeBlocklistRecovery {
            new_authority: n.pubkey(),
        }
        .data(),
        transfer_hook::accounts::ProposeBlocklistRecovery {
            upgrade_authority: ua.pubkey(),
            blocklist_authority: ba_pda,
            recovery,
            program: transfer_hook::ID,
            program_data: pd,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let rotate = [
        Instruction::new_with_bytes(
            transfer_hook::ID,
            &transfer_hook::instruction::ProposeBlocklistAuthority {
                new_authority: k2.pubkey(),
            }
            .data(),
            transfer_hook::accounts::ProposeBlocklistAuthority {
                authority: ba.pubkey(),
                blocklist_authority: ba_pda,
                transfer: proposal,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        Instruction::new_with_bytes(
            transfer_hook::ID,
            &transfer_hook::instruction::AcceptBlocklistAuthority {}.data(),
            transfer_hook::accounts::AcceptBlocklistAuthority {
                new_authority: k2.pubkey(),
                blocklist_authority: ba_pda,
                transfer: proposal,
                recovery,
            }
            .to_account_metas(None),
        ),
    ];
    send(&mut svm, &[&ua], &[propose_recovery]).expect("the UA proposes");
    assert_code(
        send(&mut svm, &[&ba, &k2], &rotate),
        6020,
        "the compromised BA rotates to its own second key",
    );
    // Only the rotation's propose half on its own lands (it moves nothing).
    send(&mut svm, &[&ba], &rotate[..1]).expect("a staged rotation");
    assert_code(
        send(&mut svm, &[&k2], &rotate[1..]),
        6020,
        "the staged rotation's accept",
    );
    let execute = Instruction::new_with_bytes(
        transfer_hook::ID,
        &transfer_hook::instruction::ExecuteBlocklistRecovery {}.data(),
        transfer_hook::accounts::ExecuteBlocklistRecovery {
            new_authority: n.pubkey(),
            blocklist_authority: ba_pda,
            recovery,
            proposer: ua.pubkey(),
            program: transfer_hook::ID,
            program_data: pd,
            transfer: proposal,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[&n], &[execute]).expect("the recovery executes");
    let ba_state: transfer_hook::BlocklistAuthority = {
        let a = svm.get_account(&ba_pda).unwrap();
        transfer_hook::BlocklistAuthority::try_deserialize(&mut a.data.as_slice()).unwrap()
    };
    assert_eq!(ba_state.authority, n.pubkey());
    // The staged rotation was retired by the execute: K2 cannot take it now.
    assert_code(
        send(&mut svm, &[&k2], &rotate[1..]),
        6015,
        "the retired rotation",
    );
}

/// Findings 1/8/23 for the registry: the compromised super admin tries to
/// rotate to a second key of its own while the bootstrap window is open
/// (propose + accept in one transaction, no timelock), and with a matured
/// pre-staged proposal after it closed. Both accepts are refused while the
/// recovery is live; the recovery executes.
#[test]
fn a_compromised_super_admin_cannot_rotate_away_from_the_incident_recovery() {
    let Some((mut svm, sa, ua, _ba)) = boot_incident() else {
        return;
    };
    assert!(bootstrap_open(&svm), "bootstrap window open after init");
    let n = funded(&mut svm);
    let k2 = funded(&mut svm);
    let pd = program_data(&asset_registry::ID);
    send(
        &mut svm,
        &[&ua],
        &[propose_platform_recovery_ix(&ua.pubkey(), &n.pubkey(), &pd)],
    )
    .expect("the UA proposes");
    let rotate = [
        propose_platform_admin_ix(&sa.pubkey(), &k2.pubkey()),
        accept_platform_admin_ix(&k2.pubkey(), &sa.pubkey()),
    ];
    assert_code(
        send(&mut svm, &[&sa, &k2], &rotate),
        6155,
        "propose + accept in one bootstrap transaction",
    );
    // After the bootstrap window closed: a matured pre-staged proposal.
    send(&mut svm, &[&sa], &rotate[..1]).expect("a staged rotation");
    send(
        &mut svm,
        &[&sa],
        &[set_pause_flags_ix(&sa.pubkey(), 0, 0x80)],
    )
    .expect("close the bootstrap window");
    let t = now(&svm);
    warp_to(
        &mut svm,
        t + asset_registry::SUPER_ADMIN_ROTATION_TIMELOCK_SECS,
    );
    assert_code(
        send(&mut svm, &[&k2], &rotate[1..]),
        6155,
        "a matured proposal while the recovery is live",
    );
    send(
        &mut svm,
        &[&n],
        &[execute_platform_recovery_ix(
            &n.pubkey(),
            &sa.pubkey(),
            &ua.pubkey(),
            &pd,
        )],
    )
    .expect("the recovery executes");
    let platform: asset_registry::Platform = {
        let a = svm.get_account(&platform_pda()).unwrap();
        asset_registry::Platform::try_deserialize(&mut a.data.as_slice()).unwrap()
    };
    assert_eq!(platform.admin, n.pubkey());
    // The staged rotation was retired by the execute.
    assert_code(
        send(&mut svm, &[&k2], &rotate[1..]),
        6113,
        "the retired rotation",
    );
}
