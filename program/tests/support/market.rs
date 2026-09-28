//! Market fixtures on the `issuer::World` harness: a payment mint, ATAs,
//! approved primary sales (Mature and Startup), buys, `close_sale`, payout
//! vaults (open / post update / release / founder yield) and `route_yield`.
//! Extracted from `test_issuer_rotation.rs` (2C-2) so the v1 suites
//! (issuer freeze, blocklisted parties) share them; each builder reads the
//! D1 chain (share class -> asset -> issuer) from chain.
//!
//! The including test also declares `mod issuer`, `mod sale_approval` and
//! `mod support`.
#![allow(dead_code)]
use super::issuer::*;
use super::sale_approval;
use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        system_instruction, system_program,
    },
    InstructionData, ToAccountMetas,
};
use asset_registry::{accounts as acc, instruction as ixd, RaiseType};
use solana_keypair::Keypair;
use solana_signer::Signer;
use spl_associated_token_account_interface::{
    address::get_associated_token_address_with_program_id, instruction as ata_ix,
};
use spl_token_2022_interface::instruction as token_ix;

pub fn k(key: &Keypair) -> Keypair {
    key.insecure_clone()
}

// ── Market helpers (payment mint, ATAs, sales, payout vaults) ────────────────

pub struct Market {
    pub payment_mint: Pubkey,
    pub buyer: Keypair,
    pub buyer_pay: Pubkey,
    pub buyer_share: Pubkey,
}

pub fn ata(w: &mut World, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    let address = get_associated_token_address_with_program_id(owner, mint, &TOKEN_2022);
    if w.svm.get_account(&address).is_none() {
        let fees = k(&w.fees);
        let ix = ata_ix::create_associated_token_account(&fees.pubkey(), owner, mint, &TOKEN_2022);
        w.send(&[], &[ix], "create_ata");
    }
    address
}

pub fn balance(w: &World, token_account: &Pubkey) -> u64 {
    w.svm.get_account(token_account).map_or(0, |a| {
        u64::from_le_bytes(a.data[64..72].try_into().unwrap())
    })
}

/// A payment mint (authority = the fee payer) and a funded buyer.
pub fn market(w: &mut World, fx: &Fixture) -> Market {
    let fees = k(&w.fees);
    let mint = Keypair::new();
    let lamports = w.svm.minimum_balance_for_rent_exemption(82);
    let create = system_instruction::create_account(
        &fees.pubkey(),
        &mint.pubkey(),
        lamports,
        82,
        &TOKEN_2022,
    );
    let init =
        token_ix::initialize_mint2(&TOKEN_2022, &mint.pubkey(), &fees.pubkey(), None, 6).unwrap();
    w.send(&[&mint], &[create, init], "create payment mint");
    let payment_mint = mint.pubkey();
    let buyer = w.funded();
    let buyer_pay = ata(w, &payment_mint, &buyer.pubkey());
    mint_payment(w, &payment_mint, &buyer_pay, 100_000_000);
    let buyer_share = ata(w, &fx.mint, &buyer.pubkey());
    Market {
        payment_mint,
        buyer,
        buyer_pay,
        buyer_share,
    }
}

pub fn mint_payment(w: &mut World, payment_mint: &Pubkey, to: &Pubkey, amount: u64) {
    let fees = k(&w.fees);
    let ix = token_ix::mint_to(&TOKEN_2022, payment_mint, to, &fees.pubkey(), &[], amount).unwrap();
    w.send(&[], &[ix], "mint payment");
}

pub fn schedule(raise_type: RaiseType) -> (u8, u8) {
    match raise_type {
        RaiseType::Mature => (0, 0),
        RaiseType::Startup => (0, 12),
    }
}

/// The super admin's `SaleApproval` for `(share class, sale_id)`.
pub fn approve(w: &mut World, fx: &Fixture, m: &Market, sale_id: u64, raise_type: RaiseType) {
    let admin = k(&w.admin);
    let terms = sale_approval::Terms::covering(&w.svm, 1, 1_000_000, raise_type);
    let ix = sale_approval::approve_sale_ix(
        &admin.pubkey(),
        &fx.issuer,
        &fx.asset,
        &fx.share_class,
        &m.payment_mint,
        sale_id,
        terms,
    );
    w.send(&[&admin], &[ix], "approve_sale");
}

pub fn open_sale_ix(
    w: &World,
    authority: &Pubkey,
    fx: &Fixture,
    m: &Market,
    sale_id: u64,
    raise_type: RaiseType,
) -> Instruction {
    let (cliff_months, vesting_months) = schedule(raise_type);
    let sale = sale_pda(&fx.share_class, sale_id);
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::OpenSale {
            sale_id,
            price_per_unit: 1,
            total_for_sale: 1_000_000,
            start_ts: 0,
            end_ts: w.now() + asset_registry::MAX_SALE_DURATION_SECS,
            raise_type,
            cliff_months,
            vesting_months,
        }
        .data(),
        acc::OpenSale {
            authority: *authority,
            issuer: fx.issuer,
            asset: fx.asset,
            share_class: fx.share_class,
            mint: fx.mint,
            payment_mint: m.payment_mint,
            sale,
            proceeds: proceeds_pda(&sale),
            payment_token_program: TOKEN_2022,
            system_program: system_program::ID,
            sale_approval: sale_approval::sale_approval_pda(&fx.share_class, sale_id),
            approved_by: w.admin.pubkey(),
            approver_admin_record: admin_pda(&w.admin.pubkey()),
            platform: platform_pda(),
            issuer_freeze: issuer_freeze_pda(&fx.issuer),
        }
        .to_account_metas(None),
    )
}

/// Approve + open by `authority` + buy `units`; returns the sale PDA.
pub fn sale(
    w: &mut World,
    authority: &Keypair,
    fx: &Fixture,
    m: &Market,
    sale_id: u64,
    raise_type: RaiseType,
    units: u64,
) -> Pubkey {
    approve(w, fx, m, sale_id, raise_type);
    let ix = open_sale_ix(w, &authority.pubkey(), fx, m, sale_id, raise_type);
    w.send(&[authority], &[ix], "open_sale");
    let sale = sale_pda(&fx.share_class, sale_id);
    if units > 0 {
        buy(w, fx, m, &sale, units);
    }
    sale
}

pub fn buy(w: &mut World, fx: &Fixture, m: &Market, sale: &Pubkey, units: u64) {
    let extra_metas = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, fx.mint.as_ref()],
        &transfer_hook::id(),
    )
    .0;
    let mut metas = acc::Buy {
        asset: fx.asset,
        issuer: fx.issuer,
        buyer: m.buyer.pubkey(),
        sale: *sale,
        share_class: fx.share_class,
        mint: fx.mint,
        buyer_share_account: m.buyer_share,
        buyer_payment_account: m.buyer_pay,
        payment_mint: m.payment_mint,
        proceeds: proceeds_pda(sale),
        share_token_program: TOKEN_2022,
        payment_token_program: TOKEN_2022,
        platform: platform_pda(),
        buyer_block_entry: block_entry_pda(&m.buyer.pubkey()),
        issuer_freeze: issuer_freeze_pda(&fx.issuer),
    }
    .to_account_metas(None);
    metas.push(AccountMeta::new_readonly(extra_metas, false));
    let ix = Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::Buy { amount: units }.data(),
        metas,
    );
    let buyer = k(&m.buyer);
    w.send(&[&buyer], &[ix], "buy");
}

pub fn close_sale_ix(
    w: &World,
    authority: &Pubkey,
    sale: &Pubkey,
    m: &Market,
    destination: &Pubkey,
) -> Instruction {
    let share_class = w.load::<asset_registry::Sale>(sale).share_class;
    let (asset, issuer) = w.chain(&share_class);
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::CloseSale {}.data(),
        acc::CloseSale {
            authority: *authority,
            sale: *sale,
            proceeds: proceeds_pda(sale),
            payment_mint: m.payment_mint,
            destination: *destination,
            payment_token_program: TOKEN_2022,
            platform: platform_pda(),
            share_class,
            asset,
            issuer_freeze: issuer_freeze_pda(&issuer),
            authority_block_entry: block_entry_pda(authority),
            destination_block_entry: block_entry_pda(&w.token_owner(destination)),
        }
        .to_account_metas(None),
    )
}

pub fn open_payout_vault_ix(
    w: &World,
    authority: &Pubkey,
    sale: &Pubkey,
    m: &Market,
) -> Instruction {
    let share_class = w.load::<asset_registry::Sale>(sale).share_class;
    let (asset, issuer) = w.chain(&share_class);
    let vault = payout_pda(sale);
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::OpenPayoutVault {
            metadata_hash: [7u8; 32],
        }
        .data(),
        acc::OpenPayoutVault {
            authority: *authority,
            sale: *sale,
            proceeds: proceeds_pda(sale),
            payment_mint: m.payment_mint,
            vault,
            escrow: payout_escrow_pda(&vault),
            payment_token_program: TOKEN_2022,
            system_program: system_program::ID,
            share_class,
            asset,
            issuer_freeze: issuer_freeze_pda(&issuer),
        }
        .to_account_metas(None),
    )
}

pub fn post_update_ix(founder: &Pubkey, vault: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::PostUpdate {
            content_hash: [1u8; 32],
        }
        .data(),
        acc::PostUpdate {
            founder: *founder,
            vault: *vault,
        }
        .to_account_metas(None),
    )
}

pub fn release_ix(w: &World, vault: &Pubkey, m: &Market, founder_account: &Pubkey) -> Instruction {
    let v = w.load::<asset_registry::PayoutVault>(vault);
    let (asset, issuer) = w.chain(&v.share_class);
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::ReleasePayout {}.data(),
        acc::ReleasePayout {
            vault: *vault,
            escrow: payout_escrow_pda(vault),
            payment_mint: m.payment_mint,
            founder_account: *founder_account,
            payment_token_program: TOKEN_2022,
            platform: platform_pda(),
            share_class: v.share_class,
            asset,
            issuer_freeze: issuer_freeze_pda(&issuer),
            founder_block_entry: block_entry_pda(&v.founder),
        }
        .to_account_metas(None),
    )
}

pub fn claim_founder_yield_ix(
    w: &World,
    founder: &Pubkey,
    vault: &Pubkey,
    m: &Market,
    to: &Pubkey,
) -> Instruction {
    let v = w.load::<asset_registry::PayoutVault>(vault);
    let (asset, issuer) = w.chain(&v.share_class);
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::ClaimFounderYield {}.data(),
        acc::ClaimFounderYield {
            founder: *founder,
            vault: *vault,
            escrow: payout_escrow_pda(vault),
            payment_mint: m.payment_mint,
            founder_account: *to,
            payment_token_program: TOKEN_2022,
            platform: platform_pda(),
            share_class: v.share_class,
            asset,
            issuer_freeze: issuer_freeze_pda(&issuer),
            founder_block_entry: block_entry_pda(&v.founder),
        }
        .to_account_metas(None),
    )
}

/// `route_yield(300)` by the super admin: 100 to the founder's claimable.
pub fn route_yield(w: &mut World, vault: &Pubkey, m: &Market) {
    let admin = k(&w.admin);
    let source = ata(w, &m.payment_mint, &admin.pubkey());
    mint_payment(w, &m.payment_mint, &source, 300);
    let treasury = w.treasury;
    let treasury_ata = ata(w, &m.payment_mint, &treasury);
    let ix = Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::RouteYield {
            amount: 300,
            investor_root: [4u8; 32],
            total_weight: 100,
        }
        .data(),
        acc::RouteYield {
            authority: admin.pubkey(),
            admin_record: admin_pda(&admin.pubkey()),
            vault: *vault,
            source,
            escrow: payout_escrow_pda(vault),
            platform_treasury: treasury_ata,
            payment_mint: m.payment_mint,
            payment_token_program: TOKEN_2022,
            platform: platform_pda(),
        }
        .to_account_metas(None),
    );
    w.send(&[&admin], &[ix], "route_yield");
}
