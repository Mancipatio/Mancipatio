//! The owner's "one company wallet for every role" model (runbook §19; design
//! 8.3 O-10) on the v1.0.0-rc programs — LiteSVM over the real SBPF v3 build.
//!
//! One key holds the super admin (with its Admin record), the KYC registry
//! authority, the BlocklistAuthority and the protocol treasury; the program
//! upgrade authority (UA, the Squads vault) is a DIFFERENT key, and one more
//! Admin record belongs to a trusted person. Nothing in v1 forbids one key in
//! several roles (the key split is a role-map / inventory rule, never a
//! program check), so these tests pin that the model works end to end:
//!
//! * the devnet handover owner key -> company wallet under the v1 timelocks
//!   (the grant and the super-admin accept wait 48 h; the KYC registry,
//!   BlocklistAuthority and treasury moves stay instant);
//! * a LOST company wallet: the second Admin re-pauses at once, and the UA
//!   recovers both the super admin and the BlocklistAuthority to one new key
//!   after 7 days (the KYC registry follows the documented replacement
//!   procedure, `kyc_registry_authority.rs`);
//! * a COMPROMISED company wallet: it removes the second Admin at once, so
//!   the UA is the only veto left, and it cancels a release-build recovery
//!   (the answer is the `incident` build, `test_incident_build.rs`). This is
//!   why the UA must never be the company wallet or held by it.

#[path = "../../../tests/support/kyc_registry.rs"]
mod kyc;
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
    asset_registry::{
        accounts as acc, instruction as ixd, Admin, KycRegistry, Platform, ADMIN_TIMELOCK_SECS,
        PAUSE_FLAGS_ALL, PLATFORM_RECOVERY_DELAY_SECS, SUPER_ADMIN_ROTATION_TIMELOCK_SECS,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_signer::Signer,
    transfer_hook::BlocklistAuthority,
    v1::*,
};

const ERR_UNAUTHORIZED: u32 = 6001;
const ERR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;
const ERR_PAUSE_CLEAR_NOT_ALLOWED: u32 = 6119;
const HOOK_ERR_TIMELOCK_ACTIVE: u32 = 6018;
/// The pilot's first unpause (role-map `unpauseMask`).
const PILOT_BITS: u8 = 0x03;

fn load<D: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> D {
    let account = svm.get_account(key).expect("account");
    D::try_deserialize(&mut account.data.as_slice()).expect("decode")
}

fn gone(svm: &LiteSVM, key: &Pubkey) -> bool {
    svm.get_account(key)
        .is_none_or(|a| a.lamports == 0 && a.data.is_empty())
}

// ── Hook builders (BlocklistAuthority rotation, blocklist, recovery) ────────

fn hook_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &transfer_hook::ID).0
}

fn ba_pda() -> Pubkey {
    hook_pda(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED])
}

fn ba_proposal_pda() -> Pubkey {
    hook_pda(&[transfer_hook::BLOCKLIST_AUTHORITY_PROPOSAL_SEED])
}

fn ba_recovery_pda() -> Pubkey {
    hook_pda(&[transfer_hook::BLOCKLIST_RECOVERY_SEED])
}

fn blocklist_authority(svm: &LiteSVM) -> Pubkey {
    load::<BlocklistAuthority>(svm, &ba_pda()).authority
}

fn init_ba_ix(ua: &Pubkey, authority: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        transfer_hook::ID,
        &transfer_hook::instruction::InitializeBlocklistAuthority {
            authority: *authority,
        }
        .data(),
        transfer_hook::accounts::InitializeBlocklistAuthority {
            payer: *ua,
            blocklist_authority: ba_pda(),
            system_program: system_program::ID,
            upgrade_authority: *ua,
            program: transfer_hook::ID,
            program_data: program_data(&transfer_hook::ID),
        }
        .to_account_metas(None),
    )
}

fn propose_ba_ix(authority: &Pubkey, new_authority: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        transfer_hook::ID,
        &transfer_hook::instruction::ProposeBlocklistAuthority {
            new_authority: *new_authority,
        }
        .data(),
        transfer_hook::accounts::ProposeBlocklistAuthority {
            authority: *authority,
            blocklist_authority: ba_pda(),
            transfer: ba_proposal_pda(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn accept_ba_ix(new_authority: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        transfer_hook::ID,
        &transfer_hook::instruction::AcceptBlocklistAuthority {}.data(),
        transfer_hook::accounts::AcceptBlocklistAuthority {
            new_authority: *new_authority,
            blocklist_authority: ba_pda(),
            transfer: ba_proposal_pda(),
            recovery: ba_recovery_pda(),
        }
        .to_account_metas(None),
    )
}

fn block_ix(authority: &Pubkey, wallet: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        transfer_hook::ID,
        &transfer_hook::instruction::AddToBlocklist { wallet: *wallet }.data(),
        transfer_hook::accounts::AddToBlocklist {
            authority: *authority,
            blocklist_authority: ba_pda(),
            block_entry: block_entry(wallet),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn propose_ba_recovery_ix(ua: &Pubkey, new_authority: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        transfer_hook::ID,
        &transfer_hook::instruction::ProposeBlocklistRecovery {
            new_authority: *new_authority,
        }
        .data(),
        transfer_hook::accounts::ProposeBlocklistRecovery {
            upgrade_authority: *ua,
            blocklist_authority: ba_pda(),
            recovery: ba_recovery_pda(),
            program: transfer_hook::ID,
            program_data: program_data(&transfer_hook::ID),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn execute_ba_recovery_ix(new_authority: &Pubkey, proposer: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        transfer_hook::ID,
        &transfer_hook::instruction::ExecuteBlocklistRecovery {}.data(),
        transfer_hook::accounts::ExecuteBlocklistRecovery {
            new_authority: *new_authority,
            blocklist_authority: ba_pda(),
            recovery: ba_recovery_pda(),
            proposer: *proposer,
            program: transfer_hook::ID,
            program_data: program_data(&transfer_hook::ID),
            transfer: ba_proposal_pda(),
        }
        .to_account_metas(None),
    )
}

fn set_protocol_treasury_ix(super_admin: &Pubkey, new_treasury: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::SetProtocolTreasury {
            new_treasury: *new_treasury,
        }
        .data(),
        acc::SetProtocolTreasury {
            super_admin: *super_admin,
            platform: platform_pda(),
        }
        .to_account_metas(None),
    )
}

/// Mainnet shape: the company wallet is the super admin from
/// `initialize_platform` and the BlocklistAuthority from its init, the UA a
/// key of its own; the second Admin is granted inside the bootstrap window
/// (one transaction, no wait), the window is closed explicitly after the
/// role steps (X1) and the pilot bits are cleared.
/// Returns `(svm, company, ua, second_admin)`.
fn boot_company() -> (LiteSVM, Keypair, Keypair, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program(
        asset_registry::ID,
        support::assert_sbpf_v3(include_bytes!("../../../target/deploy/asset_registry.so")),
    )
    .unwrap();
    svm.add_program(
        transfer_hook::ID,
        support::assert_sbpf_v3(include_bytes!("../../../target/deploy/transfer_hook.so")),
    )
    .unwrap();
    warp_to(&mut svm, T0);
    let company = funded(&mut svm);
    let ua = funded(&mut svm);
    set_upgrade_authority(&mut svm, &asset_registry::ID, Some(ua.pubkey()));
    set_upgrade_authority(&mut svm, &transfer_hook::ID, Some(ua.pubkey()));
    let init = Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::InitializePlatform {
            protocol_treasury: company.pubkey(),
            protocol_fee_bps: 250,
        }
        .data(),
        acc::InitializePlatform {
            admin: company.pubkey(),
            platform: platform_pda(),
            super_admin_record: admin_pda(&company.pubkey()),
            system_program: system_program::ID,
            upgrade_authority: ua.pubkey(),
            program: asset_registry::ID,
            program_data: program_data(&asset_registry::ID),
        }
        .to_account_metas(None),
    );
    send(
        &mut svm,
        &[&ua, &company],
        &[init, init_ba_ix(&ua.pubkey(), &company.pubkey())],
    )
    .expect("initialize_platform + initialize_blocklist_authority");
    assert!(bootstrap_open(&svm));
    let second = funded(&mut svm);
    grant_admin(&mut svm, &company, &second).expect("second Admin inside the bootstrap window");
    send(
        &mut svm,
        &[&company],
        &[set_pause_flags_ix(
            &company.pubkey(),
            0,
            asset_registry::PLATFORM_BOOTSTRAP_OPEN,
        )],
    )
    .expect("close the bootstrap window after X1");
    send(
        &mut svm,
        &[&company],
        &[set_pause_flags_ix(&company.pubkey(), 0, PILOT_BITS)],
    )
    .expect("pilot unpause");
    assert_eq!(pause_byte(&svm), PAUSE_FLAGS_ALL & !PILOT_BITS);
    let platform: Platform = load(&svm, &platform_pda());
    assert_eq!(
        (platform.admin, platform.protocol_treasury),
        (company.pubkey(), company.pubkey())
    );
    assert_eq!(blocklist_authority(&svm), company.pubkey());
    (svm, company, ua, second)
}

/// Runbook §19 on devnet under v1: the owner key hands every role to the
/// company wallet on a live platform (bootstrap closed long ago). Grant ->
/// KYC registry, BlocklistAuthority, treasury -> super admin last.
#[test]
fn the_company_wallet_takes_every_role_from_the_owner_key_under_the_v1_timelocks() {
    let (mut svm, owner, ua) = boot_platform(true);
    send(
        &mut svm,
        &[&ua],
        &[init_ba_ix(&ua.pubkey(), &owner.pubkey())],
    )
    .expect("BA = owner");
    send(
        &mut svm,
        &[&owner],
        &[kyc::create_registry_ix(
            &owner.pubkey(),
            &owner.pubkey(),
            kyc::bitmap(&[1]),
            kyc::bitmap(&[]),
        )],
    )
    .expect("the owner's KYC registry");
    let registry = kyc::registry_pda(&owner.pubkey());
    let cli = funded(&mut svm);
    grant_admin(&mut svm, &owner, &cli).expect("the CLI Admin the target keeps");
    let company = funded(&mut svm);
    assert_ne!(
        company.pubkey(),
        ua.pubkey(),
        "the UA is never the company wallet"
    );

    // Step 2, grant: 48 h between the proposal and the company's own add_admin.
    let t = now(&svm);
    send(
        &mut svm,
        &[&owner],
        &[propose_admin_ix(&owner.pubkey(), &company.pubkey())],
    )
    .expect("propose_admin(company)");
    let add = add_admin_ix(&company.pubkey(), &owner.pubkey());
    warp_to(&mut svm, t + ADMIN_TIMELOCK_SECS - 1);
    assert_code(
        send(&mut svm, &[&company], std::slice::from_ref(&add)),
        ERR_TIMELOCK_ACTIVE,
        "add_admin one second early",
    );
    warp_to(&mut svm, t + ADMIN_TIMELOCK_SECS);
    send(&mut svm, &[&company], &[add]).expect("add_admin at the eta");

    // Step 3, moves: the KYC registry authority (address unchanged), the
    // BlocklistAuthority and the treasury are instant.
    send(
        &mut svm,
        &[&owner],
        &[kyc::propose_ix(
            &owner.pubkey(),
            &registry,
            &company.pubkey(),
        )],
    )
    .expect("propose KYC registry authority");
    send(
        &mut svm,
        &[&company],
        &[kyc::accept_ix(&company.pubkey(), &registry)],
    )
    .expect("accept KYC registry authority");
    send(
        &mut svm,
        &[&owner],
        &[propose_ba_ix(&owner.pubkey(), &company.pubkey())],
    )
    .expect("propose BlocklistAuthority");
    send(&mut svm, &[&company], &[accept_ba_ix(&company.pubkey())])
        .expect("accept BlocklistAuthority");
    send(
        &mut svm,
        &[&owner],
        &[set_protocol_treasury_ix(&owner.pubkey(), &company.pubkey())],
    )
    .expect("treasury -> company");

    // Step 4, super admin last: 48 h, and the accept keeps the company's
    // existing Admin record (init_if_needed) while it closes the owner's.
    let t = now(&svm);
    send(
        &mut svm,
        &[&owner],
        &[propose_platform_admin_ix(
            &owner.pubkey(),
            &company.pubkey(),
        )],
    )
    .expect("propose_platform_admin(company)");
    let accept = accept_platform_admin_ix(&company.pubkey(), &owner.pubkey());
    warp_to(&mut svm, t + SUPER_ADMIN_ROTATION_TIMELOCK_SECS - 1);
    assert_code(
        send(&mut svm, &[&company], std::slice::from_ref(&accept)),
        ERR_TIMELOCK_ACTIVE,
        "accept one second early",
    );
    warp_to(&mut svm, t + SUPER_ADMIN_ROTATION_TIMELOCK_SECS);
    send(&mut svm, &[&company], &[accept]).expect("accept at the eta");

    let platform: Platform = load(&svm, &platform_pda());
    assert_eq!(
        (platform.admin, platform.protocol_treasury),
        (company.pubkey(), company.pubkey())
    );
    assert!(
        gone(&svm, &admin_pda(&owner.pubkey())),
        "owner record closed"
    );
    let record: Admin = load(&svm, &admin_pda(&company.pubkey()));
    assert_eq!(
        (record.admin, record.added_by),
        (company.pubkey(), owner.pubkey())
    );
    let kept: Admin = load(&svm, &admin_pda(&cli.pubkey()));
    assert_eq!(kept.admin, cli.pubkey(), "the CLI Admin stays");
    let reg: KycRegistry = load(&svm, &registry);
    assert_eq!(reg.authority, company.pubkey());
    assert_eq!(blocklist_authority(&svm), company.pubkey());

    // The one key now acts in every role …
    let holder = Pubkey::new_unique();
    send(
        &mut svm,
        &[&company],
        &[kyc::approve_ix(&company.pubkey(), &registry, &holder, 1)],
    )
    .expect("KYC decision by the company wallet");
    let wallet = Pubkey::new_unique();
    send(
        &mut svm,
        &[&company],
        &[block_ix(&company.pubkey(), &wallet)],
    )
    .expect("block by the company wallet");
    send(
        &mut svm,
        &[&company],
        &[set_pause_flags_ix(&company.pubkey(), PILOT_BITS, 0)],
    )
    .expect("pause by the company wallet");
    send(
        &mut svm,
        &[&company],
        &[set_pause_flags_ix(&company.pubkey(), 0, PILOT_BITS)],
    )
    .expect("unpause by the company wallet");
    // … and the owner key in none.
    assert_code(
        send(
            &mut svm,
            &[&owner],
            &[set_pause_flags_ix(&owner.pubkey(), PILOT_BITS, 0)],
        ),
        ERR_UNAUTHORIZED,
        "the owner holds no Admin record",
    );
    assert_code(
        send(
            &mut svm,
            &[&owner],
            &[kyc::approve_ix(
                &owner.pubkey(),
                &registry,
                &Pubkey::new_unique(),
                1,
            )],
        ),
        ERR_UNAUTHORIZED,
        "the owner is no longer the KYC authority",
    );
}

/// A lost company wallet: the second Admin holds the pause, and the UA
/// recovers the super admin AND the BlocklistAuthority to one new key after
/// 7 days, both proposals and both executes in one transaction each.
#[test]
fn a_lost_company_wallet_is_recovered_by_the_upgrade_authority_for_both_roles() {
    let (mut svm, company, ua, second) = boot_company();

    // The second Admin re-pauses at once; clearing stays with the super admin.
    send(
        &mut svm,
        &[&second],
        &[set_pause_flags_ix(&second.pubkey(), PILOT_BITS, 0)],
    )
    .expect("the second Admin pauses");
    assert_eq!(pause_byte(&svm), PAUSE_FLAGS_ALL);
    assert_code(
        send(
            &mut svm,
            &[&second],
            &[set_pause_flags_ix(&second.pubkey(), 0, PILOT_BITS)],
        ),
        ERR_PAUSE_CLEAR_NOT_ALLOWED,
        "an Admin cannot clear",
    );

    let successor = funded(&mut svm);
    let t = now(&svm);
    send(
        &mut svm,
        &[&ua],
        &[
            propose_platform_recovery_ix(
                &ua.pubkey(),
                &successor.pubkey(),
                &program_data(&asset_registry::ID),
            ),
            propose_ba_recovery_ix(&ua.pubkey(), &successor.pubkey()),
        ],
    )
    .expect("the UA proposes both recoveries");
    assert_eq!(
        transfer_hook::RECOVERY_DELAY_SECS,
        PLATFORM_RECOVERY_DELAY_SECS,
        "one 7-day window for both roles"
    );
    let execute_sa = execute_platform_recovery_ix(
        &successor.pubkey(),
        &company.pubkey(),
        &ua.pubkey(),
        &program_data(&asset_registry::ID),
    );
    let execute_ba = execute_ba_recovery_ix(&successor.pubkey(), &ua.pubkey());
    warp_to(&mut svm, t + PLATFORM_RECOVERY_DELAY_SECS - 1);
    assert_code(
        send(&mut svm, &[&successor], std::slice::from_ref(&execute_sa)),
        ERR_TIMELOCK_ACTIVE,
        "super-admin recovery one second early",
    );
    assert_code(
        send(&mut svm, &[&successor], std::slice::from_ref(&execute_ba)),
        HOOK_ERR_TIMELOCK_ACTIVE,
        "BlocklistAuthority recovery one second early",
    );
    warp_to(&mut svm, t + PLATFORM_RECOVERY_DELAY_SECS);
    send(&mut svm, &[&successor], &[execute_sa, execute_ba]).expect("both recoveries execute");

    let platform: Platform = load(&svm, &platform_pda());
    assert_eq!(platform.admin, successor.pubkey());
    assert!(
        gone(&svm, &admin_pda(&company.pubkey())),
        "the lost wallet's Admin record is closed"
    );
    let record: Admin = load(&svm, &admin_pda(&successor.pubkey()));
    assert_eq!(
        (record.admin, record.added_by),
        (successor.pubkey(), company.pubkey())
    );
    let kept: Admin = load(&svm, &admin_pda(&second.pubkey()));
    assert_eq!(kept.admin, second.pubkey(), "the second Admin stays");
    assert_eq!(blocklist_authority(&svm), successor.pubkey());
    assert!(gone(&svm, &platform_recovery()) && gone(&svm, &ba_recovery_pda()));

    // The successor runs the platform: it clears the pause and moves the
    // treasury off the lost key.
    send(
        &mut svm,
        &[&successor],
        &[
            set_pause_flags_ix(&successor.pubkey(), 0, PILOT_BITS),
            set_protocol_treasury_ix(&successor.pubkey(), &successor.pubkey()),
        ],
    )
    .expect("the successor unpauses and takes the treasury");
    let platform: Platform = load(&svm, &platform_pda());
    assert_eq!(platform.protocol_treasury, successor.pubkey());
    assert_eq!(pause_byte(&svm), PAUSE_FLAGS_ALL & !PILOT_BITS);
}

/// A compromised company wallet (design 8.3 risk 11, O-10): the second
/// Admin's veto dies with an instant `remove_admin`, so the UA is the only
/// independent veto; and the same key cancels a release-build recovery.
#[test]
fn with_one_key_in_every_role_the_upgrade_authority_is_the_only_independent_veto() {
    let (mut svm, company, ua, second) = boot_company();
    let attacker = funded(&mut svm);
    send(
        &mut svm,
        &[&company],
        &[
            remove_admin_ix(&company.pubkey(), &second.pubkey()),
            propose_admin_ix(&company.pubkey(), &attacker.pubkey()),
            propose_platform_admin_ix(&company.pubkey(), &attacker.pubkey()),
        ],
    )
    .expect("the compromised wallet removes the second Admin and stages its keys");
    let registry_pd = program_data(&asset_registry::ID);
    assert_code(
        send(
            &mut svm,
            &[&second],
            &[cancel_admin_proposal_ix(
                &second.pubkey(),
                &attacker.pubkey(),
                &company.pubkey(),
            )],
        ),
        ERR_UNAUTHORIZED,
        "the removed Admin cannot veto",
    );
    send(
        &mut svm,
        &[&ua],
        &[
            cancel_admin_proposal_ix(&ua.pubkey(), &attacker.pubkey(), &company.pubkey()),
            cancel_platform_admin_transfer_ix(&ua.pubkey(), &company.pubkey(), &registry_pd),
        ],
    )
    .expect("the UA vetoes both");
    let later = now(&svm) + SUPER_ADMIN_ROTATION_TIMELOCK_SECS;
    warp_to(&mut svm, later);
    assert_code(
        send(
            &mut svm,
            &[&attacker],
            &[add_admin_ix(&attacker.pubkey(), &company.pubkey())],
        ),
        ERR_ACCOUNT_NOT_INITIALIZED,
        "vetoed grant",
    );
    assert_code(
        send(
            &mut svm,
            &[&attacker],
            &[accept_platform_admin_ix(
                &attacker.pubkey(),
                &company.pubkey(),
            )],
        ),
        ERR_ACCOUNT_NOT_INITIALIZED,
        "vetoed rotation",
    );

    // The release build's recovery protects a LOST key only: the holder of
    // the compromised key cancels it (the incident build takes that right away).
    let successor = funded(&mut svm);
    send(
        &mut svm,
        &[&ua],
        &[propose_platform_recovery_ix(
            &ua.pubkey(),
            &successor.pubkey(),
            &registry_pd,
        )],
    )
    .expect("the UA proposes a recovery");
    send(
        &mut svm,
        &[&company],
        &[cancel_platform_recovery_ix(&company.pubkey(), &ua.pubkey())],
    )
    .expect("the compromised super admin cancels it in the release build");
    assert!(gone(&svm, &platform_recovery()));
}
