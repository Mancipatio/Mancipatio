//! Sale-approval fixtures for the asset_registry host tests (the
//! transfer_hook tests share `mod.rs` but do not link the registry crate).
//!
//! Every `open_sale` consumes an Admin `SaleApproval` for its exact
//! `(share_class, sale_id)`; tests call `approve_sale` first.
#![allow(dead_code)]
use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_program},
    InstructionData, ToAccountMetas,
};
use asset_registry::RaiseType;
use litesvm::LiteSVM;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

pub fn admin_pda(authority: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, authority.as_ref()],
        &asset_registry::ID,
    )
    .0
}

pub fn sale_pda(share_class: &Pubkey, sale_id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            asset_registry::SALE_SEED,
            share_class.as_ref(),
            &sale_id.to_le_bytes(),
        ],
        &asset_registry::ID,
    )
    .0
}

pub fn sale_approval_pda(share_class: &Pubkey, sale_id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            asset_registry::SALE_APPROVAL_SEED,
            share_class.as_ref(),
            &sale_id.to_le_bytes(),
        ],
        &asset_registry::ID,
    )
    .0
}

/// The approval's economic terms (everything but the accounts and sale id).
#[derive(Clone, Copy, Debug)]
pub struct Terms {
    pub max_gross_raise: u64,
    pub min_price_per_unit: u64,
    pub max_price_per_unit: u64,
    pub raise_type: RaiseType,
    pub expires_at: i64,
    pub application_hash: [u8; 32],
    /// The payout schedule the sale must use: 0/0 for Mature.
    pub cliff_months: u8,
    pub vesting_months: u8,
}

impl Terms {
    /// Exactly one price and exactly `price * total` gross, expiring one day
    /// after `now` (read from the SVM clock). Startup terms default to a
    /// 0-month cliff and 12 months of vesting (`with_schedule` changes it).
    pub fn covering(svm: &LiteSVM, price: u64, total: u64, raise_type: RaiseType) -> Self {
        let now = svm.get_sysvar::<Clock>().unix_timestamp;
        let (cliff_months, vesting_months) = match raise_type {
            RaiseType::Mature => (0, 0),
            RaiseType::Startup => (0, 12),
        };
        Self {
            max_gross_raise: price.checked_mul(total).expect("test terms overflow"),
            min_price_per_unit: price,
            max_price_per_unit: price,
            raise_type,
            expires_at: now + 86_400,
            application_hash: [7u8; 32],
            cliff_months,
            vesting_months,
        }
    }

    /// The same terms with another payout schedule.
    pub fn with_schedule(self, cliff_months: u8, vesting_months: u8) -> Self {
        Self {
            cliff_months,
            vesting_months,
            ..self
        }
    }
}

/// The `approve_sale` instruction signed and paid by `admin`.
#[allow(clippy::too_many_arguments)]
pub fn approve_sale_ix(
    admin: &Pubkey,
    issuer: &Pubkey,
    asset: &Pubkey,
    share_class: &Pubkey,
    payment_mint: &Pubkey,
    sale_id: u64,
    terms: Terms,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &asset_registry::instruction::ApproveSale {
            sale_id,
            max_gross_raise: terms.max_gross_raise,
            min_price_per_unit: terms.min_price_per_unit,
            max_price_per_unit: terms.max_price_per_unit,
            raise_type: terms.raise_type,
            expires_at: terms.expires_at,
            application_hash: terms.application_hash,
            cliff_months: terms.cliff_months,
            vesting_months: terms.vesting_months,
        }
        .data(),
        asset_registry::accounts::ApproveSale {
            authority: *admin,
            admin_record: admin_pda(admin),
            issuer: *issuer,
            asset: *asset,
            share_class: *share_class,
            payment_mint: *payment_mint,
            sale: sale_pda(share_class, sale_id),
            sale_approval: sale_approval_pda(share_class, sale_id),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn send_one(svm: &mut LiteSVM, signer: &Keypair, ix: Instruction) -> Result<(), String> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

/// `approve_sale` signed and paid by `admin`; returns the approval PDA.
#[allow(clippy::too_many_arguments)]
pub fn try_approve_sale(
    svm: &mut LiteSVM,
    admin: &Keypair,
    issuer: &Pubkey,
    asset: &Pubkey,
    share_class: &Pubkey,
    payment_mint: &Pubkey,
    sale_id: u64,
    terms: Terms,
) -> Result<Pubkey, String> {
    let ix = approve_sale_ix(
        &admin.pubkey(),
        issuer,
        asset,
        share_class,
        payment_mint,
        sale_id,
        terms,
    );
    send_one(svm, admin, ix).map(|_| sale_approval_pda(share_class, sale_id))
}

/// `approve_sale`, asserting success; returns the approval PDA.
#[allow(clippy::too_many_arguments)]
pub fn approve_sale(
    svm: &mut LiteSVM,
    admin: &Keypair,
    issuer: &Pubkey,
    asset: &Pubkey,
    share_class: &Pubkey,
    payment_mint: &Pubkey,
    sale_id: u64,
    terms: Terms,
) -> Pubkey {
    try_approve_sale(
        svm,
        admin,
        issuer,
        asset,
        share_class,
        payment_mint,
        sale_id,
        terms,
    )
    .expect("approve_sale")
}

pub fn revoke_sale_approval_ix(
    admin: &Pubkey,
    approval: &Pubkey,
    approved_by: &Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &asset_registry::instruction::RevokeSaleApproval {}.data(),
        asset_registry::accounts::RevokeSaleApproval {
            authority: *admin,
            admin_record: admin_pda(admin),
            sale_approval: *approval,
            approved_by: *approved_by,
        }
        .to_account_metas(None),
    )
}

/// `revoke_sale_approval` signed and paid by `admin`.
pub fn try_revoke_sale_approval(
    svm: &mut LiteSVM,
    admin: &Keypair,
    approval: &Pubkey,
    approved_by: &Pubkey,
) -> Result<(), String> {
    let ix = revoke_sale_approval_ix(&admin.pubkey(), approval, approved_by);
    send_one(svm, admin, ix)
}

/// Whether `address` holds no live account (never created or closed).
pub fn is_closed(svm: &LiteSVM, address: &Pubkey) -> bool {
    svm.get_account(address)
        .is_none_or(|a| a.lamports == 0 && a.data.is_empty())
}
