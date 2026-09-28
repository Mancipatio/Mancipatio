//! Explicit local deployment fixtures. LiteSVM loads upgradeable programs with
//! no upgrade authority; tests set this loader-owned header before bootstrap.
#![allow(dead_code)]
use anchor_lang::{prelude::Pubkey, solana_program::bpf_loader_upgradeable};
use litesvm::LiteSVM;

/// Every fixture loads the freshly built release `.so`; it must be SBPF v3
/// (ELF64 LE, `e_machine` EM_BPF, `e_flags` 3). A v0 build no longer
/// deploys once SIMD-0500 activates, and LiteSVM would happily run one.
pub fn assert_sbpf_v3(so: &[u8]) -> &[u8] {
    assert_eq!(&so[..4], b"\x7fELF", "not an ELF file");
    assert_eq!((so[4], so[5]), (2, 1), "not ELF64 little-endian");
    assert_eq!(
        u16::from_le_bytes([so[18], so[19]]),
        0xF7,
        "e_machine != EM_BPF"
    );
    assert_eq!(
        u32::from_le_bytes([so[48], so[49], so[50], so[51]]),
        3,
        "e_flags != 3: rebuild with `cargo build-sbf --arch v3` (scripts/build-sbf.sh)"
    );
    so
}

/// The feature gates active on mainnet-beta on 2026-09-28
/// (`tests/fixtures/mainnet-active-features-2026-09-28.txt`), at their
/// activation slots. Ids this VM does not know simply gate nothing.
pub fn mainnet_feature_set_2026_09_28() -> agave_feature_set::FeatureSet {
    use std::str::FromStr;
    let mut features = agave_feature_set::FeatureSet::default();
    let list = include_str!("../fixtures/mainnet-active-features-2026-09-28.txt");
    let mut count = 0;
    for line in list
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
    {
        let (id, slot) = line.split_once(' ').expect("<id> <slot>");
        let id = Pubkey::from_str(id).expect("feature id");
        features.activate(&id, slot.parse().expect("activation slot"));
        count += 1;
    }
    assert_eq!(count, 250, "fixture lists 250 active features");
    let v3 = Pubkey::from_str("5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC").unwrap();
    assert!(features.is_active(&v3), "SBPF v3 must be active");
    features
}

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
