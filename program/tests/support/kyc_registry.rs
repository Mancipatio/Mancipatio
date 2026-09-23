//! KYC registry fixtures (2C-1): PDAs, instruction builders for the registry
//! lifecycle (create / approve / revoke / propose / accept / cancel /
//! jurisdictions) and Anchor event decoding.
//!
//! The registry is always passed BY ADDRESS: its address is fixed at creation
//! (`["kyc_registry", creating authority]`), its `authority` rotates.
#![allow(dead_code)]
use anchor_lang::{
    __private::base64::{engine::general_purpose::STANDARD, Engine as _},
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_program},
    AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
};
use asset_registry::{accounts as acc, instruction as ixd, JURISDICTION_BITMAP_BYTES};

pub type Bitmap = [u8; JURISDICTION_BITMAP_BYTES];

/// 2100-01-01 — a KYC expiry that never lapses in tests.
pub const FAR_FUTURE: i64 = 4_102_444_800;

pub fn platform_pda() -> Pubkey {
    Pubkey::find_program_address(&[asset_registry::PLATFORM_SEED], &asset_registry::ID).0
}

pub fn admin_pda(wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, wallet.as_ref()],
        &asset_registry::ID,
    )
    .0
}

/// `["kyc_registry", creating authority]` — valid only for the CREATOR, never
/// for a rotated authority.
pub fn registry_pda(creator: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::KYC_REGISTRY_SEED, creator.as_ref()],
        &asset_registry::ID,
    )
    .0
}

pub fn entry_pda(registry: &Pubkey, holder: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::KYC_SEED, registry.as_ref(), holder.as_ref()],
        &asset_registry::ID,
    )
    .0
}

/// `["authority_transfer", target]` — the per-target staged rotation.
pub fn transfer_pda(target: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::AUTHORITY_TRANSFER_SEED, target.as_ref()],
        &asset_registry::ID,
    )
    .0
}

/// A bitmap with exactly the given jurisdiction bits set.
pub fn bitmap(codes: &[u16]) -> Bitmap {
    let mut map = [0u8; JURISDICTION_BITMAP_BYTES];
    for &code in codes {
        map[usize::from(code / 8)] |= 1 << (code % 8);
    }
    map
}

pub fn create_registry_ix(
    authority: &Pubkey,
    admin: &Pubkey,
    approved: Bitmap,
    blocked: Bitmap,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::CreateKycRegistry {
            approved_jurisdictions: approved,
            blocked_jurisdictions: blocked,
        }
        .data(),
        acc::CreateKycRegistry {
            authority: *authority,
            admin_authority: *admin,
            admin_record: admin_pda(admin),
            kyc_registry: registry_pda(authority),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn approve_ix(
    authority: &Pubkey,
    registry: &Pubkey,
    holder: &Pubkey,
    jurisdiction: u16,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::ApproveHolder {
            holder: *holder,
            jurisdiction,
            accreditation_level: 1,
            expiry: FAR_FUTURE,
            provider_id: 1,
            external_ref_hash: [5u8; 32],
        }
        .data(),
        acc::ApproveHolder {
            authority: *authority,
            kyc_registry: *registry,
            kyc_entry: entry_pda(registry, holder),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn revoke_ix(authority: &Pubkey, registry: &Pubkey, holder: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::RevokeHolder { holder: *holder }.data(),
        acc::RevokeHolder {
            authority: *authority,
            kyc_registry: *registry,
            kyc_entry: entry_pda(registry, holder),
        }
        .to_account_metas(None),
    )
}

/// `transfer` defaults to the registry's own `["authority_transfer", registry]`.
pub fn propose_ix_with(
    authority: &Pubkey,
    registry: &Pubkey,
    new_authority: &Pubkey,
    transfer: Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::ProposeKycRegistryAuthority {
            new_authority: *new_authority,
        }
        .data(),
        acc::ProposeKycRegistryAuthority {
            authority: *authority,
            kyc_registry: *registry,
            transfer,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn propose_ix(authority: &Pubkey, registry: &Pubkey, new_authority: &Pubkey) -> Instruction {
    propose_ix_with(authority, registry, new_authority, transfer_pda(registry))
}

pub fn accept_ix_with(new_authority: &Pubkey, registry: &Pubkey, transfer: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::AcceptKycRegistryAuthority {}.data(),
        acc::AcceptKycRegistryAuthority {
            new_authority: *new_authority,
            kyc_registry: *registry,
            transfer,
        }
        .to_account_metas(None),
    )
}

pub fn accept_ix(new_authority: &Pubkey, registry: &Pubkey) -> Instruction {
    accept_ix_with(new_authority, registry, transfer_pda(registry))
}

pub fn cancel_ix(authority: &Pubkey, registry: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::CancelKycRegistryAuthorityTransfer {}.data(),
        acc::CancelKycRegistryAuthorityTransfer {
            authority: *authority,
            kyc_registry: *registry,
            transfer: transfer_pda(registry),
        }
        .to_account_metas(None),
    )
}

pub fn update_jurisdictions_ix(
    authority: &Pubkey,
    registry: &Pubkey,
    approved: Bitmap,
    blocked: Bitmap,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::UpdateKycRegistryJurisdictions {
            approved_jurisdictions: approved,
            blocked_jurisdictions: blocked,
        }
        .data(),
        acc::UpdateKycRegistryJurisdictions {
            authority: *authority,
            kyc_registry: *registry,
        }
        .to_account_metas(None),
    )
}

/// Decodes every Anchor event of type `E` from `Program data:` log lines.
pub fn events<E: AnchorDeserialize + Discriminator>(logs: &[String]) -> Vec<E> {
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|b64| STANDARD.decode(b64).ok())
        .filter(|data| data.starts_with(E::DISCRIMINATOR))
        .map(|data| E::try_from_slice(&data[E::DISCRIMINATOR.len()..]).expect("event"))
        .collect()
}
