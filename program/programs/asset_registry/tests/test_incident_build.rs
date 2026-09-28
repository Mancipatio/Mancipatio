//! The incident artifacts (design 8.3 §7.4, O-12; §14.11): the SAME source
//! built with `--features incident` (`bash scripts/build-sbf.sh --incident`,
//! into `target/deploy-incident/`) has a zero recovery delay, and only the
//! proposing upgrade authority may cancel a recovery — the case is a
//! COMPROMISED super admin / BlocklistAuthority, which must not be able to
//! block its own replacement. Never a release, devnet or CI-test artifact.
//!
//! The artifacts are read at run time. Without them the tests report and
//! pass, unless `MANCI_REQUIRE_INCIDENT=1` (set it wherever the incident
//! build runs, so a missing artifact fails loudly there).

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

fn artifact(name: &str) -> Option<Vec<u8>> {
    let path = format!(
        "{}/../../target/deploy-incident/{name}.so",
        env!("CARGO_MANIFEST_DIR")
    );
    match std::fs::read(&path) {
        Ok(bytes) => {
            support::assert_sbpf_v3(&bytes);
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
