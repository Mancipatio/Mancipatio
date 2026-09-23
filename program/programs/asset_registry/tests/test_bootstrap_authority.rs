//! Defensive bootstrap authorization: an operational payer/admin cannot claim
//! either singleton without the deployed program's actual upgrade authority.
#[path = "../../../tests/support/mod.rs"]
mod support;
use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_program},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

fn init_ix(registry: bool, payer: Pubkey, upgrader: Pubkey, program_data: Pubkey) -> Instruction {
    if registry {
        Instruction::new_with_bytes(
            asset_registry::ID,
            &asset_registry::instruction::InitializePlatform {
                protocol_treasury: payer,
                protocol_fee_bps: 100,
            }
            .data(),
            asset_registry::accounts::InitializePlatform {
                admin: payer,
                platform: Pubkey::find_program_address(
                    &[asset_registry::PLATFORM_SEED],
                    &asset_registry::ID,
                )
                .0,
                super_admin_record: Pubkey::find_program_address(
                    &[asset_registry::ADMIN_SEED, payer.as_ref()],
                    &asset_registry::ID,
                )
                .0,
                system_program: system_program::ID,
                upgrade_authority: upgrader,
                program: asset_registry::ID,
                program_data,
            }
            .to_account_metas(None),
        )
    } else {
        Instruction::new_with_bytes(
            transfer_hook::ID,
            &transfer_hook::instruction::InitializeBlocklistAuthority { authority: payer }.data(),
            transfer_hook::accounts::InitializeBlocklistAuthority {
                payer,
                blocklist_authority: Pubkey::find_program_address(
                    &[transfer_hook::BLOCKLIST_AUTHORITY_SEED],
                    &transfer_hook::ID,
                )
                .0,
                system_program: system_program::ID,
                upgrade_authority: upgrader,
                program: transfer_hook::ID,
                program_data,
            }
            .to_account_metas(None),
        )
    }
}

fn send(svm: &mut LiteSVM, signers: &[&Keypair], ix: Instruction) -> Result<(), String> {
    let msg =
        Message::new_with_blockhash(&[ix], Some(&signers[0].pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

fn verify_bootstrap(registry: bool) {
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
    let payer = Keypair::new();
    let upgrader = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    svm.airdrop(&upgrader.pubkey(), 1_000_000).unwrap();
    let (program, foreign) = if registry {
        (asset_registry::ID, transfer_hook::ID)
    } else {
        (transfer_hook::ID, asset_registry::ID)
    };
    let data = support::program_data(&program);
    let singleton = init_ix(registry, payer.pubkey(), upgrader.pubkey(), data).accounts[1].pubkey;
    support::set_upgrade_authority(&mut svm, &program, Some(upgrader.pubkey()));
    support::set_upgrade_authority(&mut svm, &foreign, Some(upgrader.pubkey()));

    let err = send(
        &mut svm,
        &[&payer],
        init_ix(registry, payer.pubkey(), payer.pubkey(), data),
    )
    .unwrap_err();
    let expected = if registry {
        "Custom(6001)"
    } else {
        "Custom(6004)"
    };
    assert!(err.contains(expected), "unauthorized bootstrap: {err}");
    assert!(
        svm.get_account(&singleton).is_none(),
        "failed bootstrap must be atomic"
    );

    let err = send(
        &mut svm,
        &[&payer, &upgrader],
        init_ix(
            registry,
            payer.pubkey(),
            upgrader.pubkey(),
            support::program_data(&foreign),
        ),
    )
    .unwrap_err();
    assert!(
        err.contains(expected),
        "another program's ProgramData is not authority proof: {err}"
    );

    let mut unsigned = init_ix(registry, payer.pubkey(), upgrader.pubkey(), data);
    unsigned.accounts[if registry { 4 } else { 3 }].is_signer = false;
    let err = send(&mut svm, &[&payer], unsigned).unwrap_err();
    assert!(
        err.contains("Custom(3010)"),
        "upgrade authority must sign: {err}"
    );

    // An immutable deployed program has deliberately surrendered this authority.
    support::set_upgrade_authority(&mut svm, &program, None);
    let err = send(
        &mut svm,
        &[&payer, &upgrader],
        init_ix(registry, payer.pubkey(), upgrader.pubkey(), data),
    )
    .unwrap_err();
    assert!(
        err.contains(expected),
        "no deployment authority must fail closed: {err}"
    );
    assert!(svm.get_account(&singleton).is_none());

    support::set_upgrade_authority(&mut svm, &program, Some(upgrader.pubkey()));
    svm.expire_blockhash();
    send(
        &mut svm,
        &[&payer, &upgrader],
        init_ix(registry, payer.pubkey(), upgrader.pubkey(), data),
    )
    .unwrap();
    let account = svm.get_account(&singleton).unwrap();
    if registry {
        let state =
            asset_registry::Platform::try_deserialize(&mut account.data.as_slice()).unwrap();
        assert_eq!(
            state.admin,
            payer.pubkey(),
            "operational admin may differ from upgrader"
        );
        assert_eq!(
            state.pause_flags,
            asset_registry::PAUSE_FLAGS_ALL,
            "a fresh platform starts fully paused"
        );
        assert_eq!(account.data.len(), 85);
        assert_eq!(account.data[74], 0x3F);
    } else {
        let state =
            transfer_hook::BlocklistAuthority::try_deserialize(&mut account.data.as_slice())
                .unwrap();
        assert_eq!(
            state.authority,
            payer.pubkey(),
            "blocklist admin may differ from upgrader"
        );
    }
    svm.expire_blockhash();
    assert!(
        send(
            &mut svm,
            &[&payer, &upgrader],
            init_ix(registry, payer.pubkey(), upgrader.pubkey(), data)
        )
        .is_err(),
        "authorized bootstrap remains one-shot"
    );
}

#[test]
fn platform_bootstrap_requires_its_signed_deployment_authority() {
    verify_bootstrap(true);
}
#[test]
fn blocklist_bootstrap_requires_its_signed_deployment_authority() {
    verify_bootstrap(false);
}
