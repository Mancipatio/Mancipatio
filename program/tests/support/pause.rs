//! Emergency-pause fixtures for the asset_registry host tests (the
//! transfer_hook tests share `mod.rs` but do not link the registry crate).
//!
//! A fresh `initialize_platform` starts fully paused (`PAUSE_FLAGS_ALL`), so
//! every boot calls `unpause_all` right after it, as the real bootstrap does.
#![allow(dead_code)]
use anchor_lang::{
    prelude::Pubkey, solana_program::instruction::Instruction, InstructionData, ToAccountMetas,
};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

pub fn platform_pda() -> Pubkey {
    Pubkey::find_program_address(&[asset_registry::PLATFORM_SEED], &asset_registry::ID).0
}

pub fn admin_pda(authority: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, authority.as_ref()],
        &asset_registry::ID,
    )
    .0
}

/// The Platform's raw pause byte (offset 74).
pub fn pause_flags(svm: &LiteSVM) -> u8 {
    svm.get_account(&platform_pda()).expect("Platform").data[74]
}

pub fn set_pause_flags_ix(authority: &Pubkey, set_mask: u8, clear_mask: u8) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &asset_registry::instruction::SetPauseFlags {
            set_mask,
            clear_mask,
        }
        .data(),
        asset_registry::accounts::SetPauseFlags {
            authority: *authority,
            admin_record: admin_pda(authority),
            platform: platform_pda(),
        }
        .to_account_metas(None),
    )
}

/// `set_pause_flags(set_mask, clear_mask)` signed (and paid) by `signer`.
pub fn set_pause_flags(
    svm: &mut LiteSVM,
    signer: &Keypair,
    set_mask: u8,
    clear_mask: u8,
) -> Result<(), String> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(
        &[set_pause_flags_ix(&signer.pubkey(), set_mask, clear_mask)],
        Some(&signer.pubkey()),
        &svm.latest_blockhash(),
    );
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

/// Clears every pause bit (super admin), asserting the result.
pub fn unpause_all(svm: &mut LiteSVM, super_admin: &Keypair) {
    set_pause_flags(svm, super_admin, 0, asset_registry::PAUSE_FLAGS_ALL)
        .expect("super admin clears the initial pause");
    assert_eq!(pause_flags(svm), 0);
}

/// Pauses exactly `flags`, clearing every other bit (super admin).
pub fn pause_only(svm: &mut LiteSVM, super_admin: &Keypair, flags: u8) {
    set_pause_flags(svm, super_admin, flags, !flags).expect("super admin sets the pause");
    assert_eq!(pause_flags(svm), flags);
}

/// Asserts a failed transaction reverted with the registry's `PlatformPaused`
/// (6000). The code alone is ambiguous: transfer_hook's first error,
/// `KycRegistryRequired`, is also 6000 and surfaces as the outer instruction's
/// error on every hook-CPI instruction (take_offer, OTC and custody deposits).
/// The Anchor error NAME in the logs (the failure's Debug output carries them)
/// pins the registry's pause check.
pub fn assert_paused(result: Result<(), String>, what: &str) {
    let err = result.expect_err(what);
    assert!(
        err.contains("Custom(6000)") && err.contains("Error Code: PlatformPaused"),
        "{what}: expected PlatformPaused (6000), got {err}"
    );
    assert!(
        !err.contains("Error Code: KycRegistryRequired"),
        "{what}: the hook failed, not the pause: {err}"
    );
}
