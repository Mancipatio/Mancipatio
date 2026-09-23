//! `reclaim_rent` fixtures (2D): the instruction builder, tombstone checks and
//! the exact lamport expectation. Rent comes from the SVM's Rent sysvar
//! (`minimum_balance_for_rent_exemption`), never from literals: LiteSVM's
//! default rate differs from devnet's 5,080 lamports/B.
#![allow(dead_code)]
use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_program},
    InstructionData, ToAccountMetas,
};
use asset_registry::{accounts as acc, instruction as ixd, CLOSED_ACCOUNT_TAG};
use litesvm::LiteSVM;

/// Super admin grants the Admin role to `new_admin`.
pub fn add_admin_ix(super_admin: &Pubkey, new_admin: &Pubkey) -> Instruction {
    let pda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &asset_registry::ID).0;
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::AddAdmin {
            new_admin: *new_admin,
        }
        .data(),
        acc::AddAdmin {
            super_admin: *super_admin,
            platform: pda(&[asset_registry::PLATFORM_SEED]),
            admin_record: pda(&[asset_registry::ADMIN_SEED, new_admin.as_ref()]),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// `reclaim_rent`. `None` optional accounts go out as the program-id
/// placeholder (Anchor's encoding of an absent optional account).
pub fn reclaim_ix(
    caller: &Pubkey,
    owner: &Pubkey,
    target: &Pubkey,
    linked: &Pubkey,
    linked_b: Option<Pubkey>,
    token_program: Option<Pubkey>,
    token_program_b: Option<Pubkey>,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::ReclaimRent {}.data(),
        acc::ReclaimRent {
            caller: *caller,
            owner: *owner,
            target: *target,
            linked: *linked,
            linked_b,
            token_program,
            token_program_b,
        }
        .to_account_metas(None),
    )
}

pub fn lamports(svm: &LiteSVM, key: &Pubkey) -> u64 {
    svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
}

/// Rent minimum the tombstone keeps (8 bytes of data).
pub fn tombstone_minimum(svm: &LiteSVM) -> u64 {
    svm.minimum_balance_for_rent_exemption(CLOSED_ACCOUNT_TAG.len())
}

/// What the owner must receive from a tombstoning reclaim: every escrow's
/// lamports plus the parent's lamports above the 8-byte minimum. Read BEFORE
/// the reclaim.
pub fn expected_tombstone_refund(svm: &LiteSVM, target: &Pubkey, escrows: &[Pubkey]) -> u64 {
    escrows.iter().map(|e| lamports(svm, e)).sum::<u64>() + lamports(svm, target)
        - tombstone_minimum(svm)
}

/// The parent is 8 bytes, registry-owned, carries the tag and holds exactly
/// the 8-byte minimum.
pub fn assert_tombstone(svm: &LiteSVM, target: &Pubkey) {
    let account = svm.get_account(target).expect("tombstone stays allocated");
    assert_eq!(account.owner, asset_registry::ID, "still program-owned");
    assert_eq!(account.data, CLOSED_ACCOUNT_TAG.to_vec(), "8-byte tag");
    assert_eq!(account.lamports, tombstone_minimum(svm), "exact minimum");
}

/// The account no longer exists (closed or never created).
pub fn assert_gone(svm: &LiteSVM, key: &Pubkey) {
    assert!(
        svm.get_account(key)
            .is_none_or(|a| a.lamports == 0 && a.data.is_empty()),
        "{key} must be closed"
    );
}

/// The failure is the registry's custom error `code`.
pub fn assert_code(result: Result<(), String>, code: u32) {
    let err = result.expect_err("must fail");
    assert!(
        err.contains(&format!("Custom({code})")),
        "expected {code}, got {err}"
    );
}
