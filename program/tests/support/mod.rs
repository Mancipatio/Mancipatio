//! Explicit local deployment fixtures. LiteSVM loads upgradeable programs with
//! no upgrade authority; tests set this loader-owned header before bootstrap.
#![allow(dead_code)]
use anchor_lang::{prelude::Pubkey, solana_program::bpf_loader_upgradeable};
use litesvm::LiteSVM;

pub fn program_data(program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program.as_ref()], &bpf_loader_upgradeable::ID).0
}

pub fn set_upgrade_authority(svm: &mut LiteSVM, program: &Pubkey, authority: Option<Pubkey>) {
    let address = program_data(program);
    let mut account = svm.get_account(&address).expect("loaded ProgramData");
    assert_eq!(account.owner, bpf_loader_upgradeable::ID);
    assert_eq!(&account.data[..4], &3u32.to_le_bytes()); // ProgramData variant
    account.data[12] = u8::from(authority.is_some());
    account.data[13..45].fill(0);
    if let Some(authority) = authority {
        account.data[13..45].copy_from_slice(authority.as_ref());
    }
    svm.set_account(address, account)
        .expect("set local deployment authority");
}
