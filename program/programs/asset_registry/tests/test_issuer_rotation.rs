//! Issuer authority rotation, timelocked recovery and sale / payout sync (2C-2)
//! — LiteSVM.
//!
//! * regular rotation: the current authority proposes, the new key accepts
//!   (`AuthorityTransfer` at `["authority_transfer", issuer]`); only
//!   `Issuer.authority` changes and the Issuer stays 117 B;
//! * every authority change closes the old `IssuerPermissions` grant; a
//!   regular accept carries the capabilities, a recovery carries none;
//! * recovery: the super admin proposes, the new key executes inside
//!   `[eta, expires_at)`, the current authority or the super admin cancels,
//!   and any change of the authority or the super admin makes it stale;
//! * `sync_sale_authority` / `sync_payout_founder` are permissionless and copy
//!   the live authority into the sale / vault snapshots;
//! * the existing `recover_issuer_registration` path (now with an event).

#[path = "../../../tests/support/issuer.rs"]
mod issuer;
#[path = "../../../tests/support/kyc_registry.rs"]
mod kyc;
#[path = "../../../tests/support/sale_approval.rs"]
mod sale_approval;
#[path = "../../../tests/support/mod.rs"]
mod support;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            system_instruction, system_program,
        },
        AccountSerialize, Discriminator, InstructionData, Space, ToAccountMetas,
    },
    asset_registry::{
        accounts as acc, error::RegistryError, instruction as ixd, legacy::LegacyShareClass,
        AuthorityTransfer, Issuer, IssuerAuthorityChangeKind, IssuerAuthorityChanged,
        IssuerAuthorityProposalCancelled, IssuerAuthorityProposed, IssuerPermissions,
        IssuerRecovery, IssuerRecoveryCancelled, IssuerRecoveryProposed, KybStatus,
        PayoutFounderSynced, PayoutVault, RaiseType, Sale, SaleAuthoritySynced,
    },
    issuer::*,
    solana_keypair::Keypair,
    solana_message::Message,
    solana_signer::Signer,
    spl_associated_token_account_interface::{
        address::get_associated_token_address_with_program_id, instruction as ata_ix,
    },
    spl_token_2022_interface::instruction as token_ix,
};

const ERR_PAUSED: u32 = 6000;
const ERR_NOT_FOUNDER: u32 = 6043;
const ERR_NOT_RECOVERABLE: u32 = 6110;
const ERR_INVALID_PROPOSED_AUTHORITY: u32 = 6112;
const ERR_INVALID_AUTHORITY_TRANSFER: u32 = 6113;
const ERR_TIMELOCK_ACTIVE: u32 = 6131;
const ERR_RECOVERY_EXPIRED: u32 = 6132;
const ERR_INVALID_RECOVERY: u32 = 6133;
const DELAY: i64 = asset_registry::ISSUER_RECOVERY_DELAY;
const WINDOW: i64 = asset_registry::ISSUER_RECOVERY_EXECUTION_WINDOW;
const CAPS: u8 =
    asset_registry::ISSUER_PERMISSION_MINT | asset_registry::ISSUER_PERMISSION_METADATA;

// ── Scene: one verified issuer (authority A, MINT|METADATA) with an asset ────

struct Scene {
    w: World,
    a: Keypair,
    b: Keypair,
    c: Keypair,
    fx: Fixture,
}

fn scene() -> Scene {
    let mut w = World::boot();
    let a = w.funded();
    let b = w.funded();
    let c = w.funded();
    let fx = w.issuer_with_asset(&a, legal_id(1));
    Scene { w, a, b, c, fx }
}

fn k(key: &Keypair) -> Keypair {
    key.insecure_clone()
}

// ── Market helpers (payment mint, ATAs, sales, payout vaults) ────────────────

struct Market {
    payment_mint: Pubkey,
    buyer: Keypair,
    buyer_pay: Pubkey,
    buyer_share: Pubkey,
}

fn ata(w: &mut World, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    let address = get_associated_token_address_with_program_id(owner, mint, &TOKEN_2022);
    if w.svm.get_account(&address).is_none() {
        let fees = k(&w.fees);
        let ix = ata_ix::create_associated_token_account(&fees.pubkey(), owner, mint, &TOKEN_2022);
        w.send(&[], &[ix], "create_ata");
    }
    address
}

fn balance(w: &World, token_account: &Pubkey) -> u64 {
    w.svm.get_account(token_account).map_or(0, |a| {
        u64::from_le_bytes(a.data[64..72].try_into().unwrap())
    })
}

/// A payment mint (authority = the fee payer) and a funded buyer.
fn market(w: &mut World, fx: &Fixture) -> Market {
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

fn mint_payment(w: &mut World, payment_mint: &Pubkey, to: &Pubkey, amount: u64) {
    let fees = k(&w.fees);
    let ix = token_ix::mint_to(&TOKEN_2022, payment_mint, to, &fees.pubkey(), &[], amount).unwrap();
    w.send(&[], &[ix], "mint payment");
}

fn schedule(raise_type: RaiseType) -> (u8, u8) {
    match raise_type {
        RaiseType::Mature => (0, 0),
        RaiseType::Startup => (0, 12),
    }
}

/// The super admin's `SaleApproval` for `(share class, sale_id)`.
fn approve(w: &mut World, fx: &Fixture, m: &Market, sale_id: u64, raise_type: RaiseType) {
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

fn open_sale_ix(
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
            end_ts: 0,
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
        }
        .to_account_metas(None),
    )
}

/// Approve + open by `authority` + buy `units`; returns the sale PDA.
fn sale(
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

fn buy(w: &mut World, fx: &Fixture, m: &Market, sale: &Pubkey, units: u64) {
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

fn close_sale_ix(
    authority: &Pubkey,
    sale: &Pubkey,
    m: &Market,
    destination: &Pubkey,
) -> Instruction {
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
        }
        .to_account_metas(None),
    )
}

fn open_payout_vault_ix(authority: &Pubkey, sale: &Pubkey, m: &Market) -> Instruction {
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
        }
        .to_account_metas(None),
    )
}

fn post_update_ix(founder: &Pubkey, vault: &Pubkey) -> Instruction {
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

fn release_ix(vault: &Pubkey, m: &Market, founder_account: &Pubkey) -> Instruction {
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
        }
        .to_account_metas(None),
    )
}

fn claim_founder_yield_ix(
    founder: &Pubkey,
    vault: &Pubkey,
    m: &Market,
    to: &Pubkey,
) -> Instruction {
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
        }
        .to_account_metas(None),
    )
}

/// `route_yield(300)` by the super admin: 100 to the founder's claimable.
fn route_yield(w: &mut World, vault: &Pubkey, m: &Market) {
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

// ── 1. Happy path ────────────────────────────────────────────────────────────

#[test]
fn rotation_changes_only_the_authority_and_refunds_the_acceptor() {
    let Scene {
        mut w, a, b, fx, ..
    } = scene();
    let before: Issuer = w.load(&fx.issuer);
    assert_eq!(w.data_len(&fx.issuer), 117, "Issuer layout frozen");
    let transfer = transfer_pda(&fx.issuer);

    let logs = w.send(
        &[&a],
        &[propose_issuer_authority_ix(
            &a.pubkey(),
            &fx.issuer,
            &b.pubkey(),
        )],
        "propose A -> B",
    );
    let proposed = events::<IssuerAuthorityProposed>(&logs);
    assert_eq!(proposed.len(), 1);
    assert_eq!(proposed[0].issuer, fx.issuer);
    assert_eq!(proposed[0].current_authority, a.pubkey());
    assert_eq!(proposed[0].new_authority, b.pubkey());
    let staged: AuthorityTransfer = w.load(&transfer);
    assert_eq!(staged.target, fx.issuer);
    assert_eq!(staged.current_authority, a.pubkey());
    assert_eq!(staged.new_authority, b.pubkey());
    assert_eq!(staged.proposed_by, a.pubkey());
    assert_eq!(
        w.load::<Issuer>(&fx.issuer).authority,
        a.pubkey(),
        "nothing moves on propose"
    );

    let transfer_rent = w.lamports(&transfer);
    let b_before = w.lamports(&b.pubkey());
    let logs = w.send(
        &[&b],
        &[accept_issuer_authority_ix(
            &b.pubkey(),
            &fx.issuer,
            &a.pubkey(),
        )],
        "accept by B",
    );
    let changed = events::<IssuerAuthorityChanged>(&logs);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].issuer, fx.issuer);
    assert_eq!(changed[0].old_authority, a.pubkey());
    assert_eq!(changed[0].new_authority, b.pubkey());
    assert_eq!(changed[0].kind, IssuerAuthorityChangeKind::Rotation);
    assert_eq!(changed[0].capabilities_carried, CAPS);
    assert!(changed[0].old_grant_closed);

    let after: Issuer = w.load(&fx.issuer);
    assert_eq!(after.authority, b.pubkey());
    assert_eq!(after.legal_entity_id, before.legal_entity_id);
    assert_eq!(after.jurisdiction, before.jurisdiction);
    assert_eq!(after.kyb_status, KybStatus::Verified);
    assert_eq!(after.kyb_doc_hash, before.kyb_doc_hash);
    assert_eq!(after.assets_count, before.assets_count);
    assert_eq!(after.version, before.version);
    assert_eq!(after.bump, before.bump);
    assert_eq!(w.data_len(&fx.issuer), 117, "Issuer layout frozen");
    assert!(w.is_closed(&transfer), "transfer closed on accept");
    // The old grant's rent pays the new grant's (same size); the transfer's
    // rent is the acceptor's net gain.
    assert_eq!(w.lamports(&b.pubkey()), b_before + transfer_rent);
}

// ── 2-4. Propose / accept / cancel guards ────────────────────────────────────

#[test]
fn only_the_current_authority_proposes_a_different_nonzero_key() {
    let Scene { mut w, a, b, c, fx } = scene();
    w.expect_code(
        &[&c],
        &[propose_issuer_authority_ix(
            &c.pubkey(),
            &fx.issuer,
            &b.pubkey(),
        )],
        ERR_UNAUTHORIZED,
        "a non-authority proposes",
    );
    w.expect_code(
        &[&a],
        &[propose_issuer_authority_ix(
            &a.pubkey(),
            &fx.issuer,
            &Pubkey::default(),
        )],
        ERR_INVALID_PROPOSED_AUTHORITY,
        "default key",
    );
    w.expect_code(
        &[&a],
        &[propose_issuer_authority_ix(
            &a.pubkey(),
            &fx.issuer,
            &a.pubkey(),
        )],
        ERR_INVALID_PROPOSED_AUTHORITY,
        "same key",
    );
    assert!(w.is_closed(&transfer_pda(&fx.issuer)));
}

#[test]
fn accept_requires_a_live_proposal_to_the_signer() {
    let Scene { mut w, a, b, c, fx } = scene();
    w.expect_code(
        &[&b],
        &[accept_issuer_authority_ix(
            &b.pubkey(),
            &fx.issuer,
            &a.pubkey(),
        )],
        ERR_ACCOUNT_NOT_INITIALIZED,
        "accept with no transfer",
    );
    w.send(
        &[&a],
        &[propose_issuer_authority_ix(
            &a.pubkey(),
            &fx.issuer,
            &b.pubkey(),
        )],
        "propose",
    );
    w.expect_code(
        &[&c],
        &[accept_issuer_authority_ix(
            &c.pubkey(),
            &fx.issuer,
            &a.pubkey(),
        )],
        ERR_INVALID_AUTHORITY_TRANSFER,
        "the wrong signer accepts",
    );
    w.send(
        &[&a],
        &[cancel_issuer_authority_transfer_ix(&a.pubkey(), &fx.issuer)],
        "cancel",
    );
    w.expect_code(
        &[&b],
        &[accept_issuer_authority_ix(
            &b.pubkey(),
            &fx.issuer,
            &a.pubkey(),
        )],
        ERR_ACCOUNT_NOT_INITIALIZED,
        "accept after cancel",
    );
    assert_eq!(w.load::<Issuer>(&fx.issuer).authority, a.pubkey());
}

#[test]
fn a_re_proposal_replaces_the_pending_one_and_only_the_authority_cancels() {
    let Scene { mut w, a, b, c, fx } = scene();
    let transfer = transfer_pda(&fx.issuer);
    w.send(
        &[&a],
        &[propose_issuer_authority_ix(
            &a.pubkey(),
            &fx.issuer,
            &b.pubkey(),
        )],
        "propose B",
    );
    w.send(
        &[&a],
        &[propose_issuer_authority_ix(
            &a.pubkey(),
            &fx.issuer,
            &c.pubkey(),
        )],
        "re-propose C",
    );
    assert_eq!(
        w.load::<AuthorityTransfer>(&transfer).new_authority,
        c.pubkey()
    );
    w.expect_code(
        &[&b],
        &[accept_issuer_authority_ix(
            &b.pubkey(),
            &fx.issuer,
            &a.pubkey(),
        )],
        ERR_INVALID_AUTHORITY_TRANSFER,
        "the replaced proposal",
    );
    w.expect_code(
        &[&c],
        &[cancel_issuer_authority_transfer_ix(&c.pubkey(), &fx.issuer)],
        ERR_UNAUTHORIZED,
        "the proposed key cancels",
    );
    let rent = w.lamports(&transfer);
    let a_before = w.lamports(&a.pubkey());
    let logs = w.send(
        &[&a],
        &[cancel_issuer_authority_transfer_ix(&a.pubkey(), &fx.issuer)],
        "cancel",
    );
    let cancelled = events::<IssuerAuthorityProposalCancelled>(&logs);
    assert_eq!(cancelled.len(), 1);
    assert_eq!(cancelled[0].authority, a.pubkey());
    assert_eq!(cancelled[0].cancelled_new_authority, c.pubkey());
    assert!(w.is_closed(&transfer));
    assert_eq!(
        w.lamports(&a.pubkey()),
        a_before + rent,
        "rent back to the proposer"
    );
}

// ── 5. The old key is locked out; approvals survive rotation (2B) ────────────

#[test]
fn old_key_is_refused_and_the_new_key_opens_a_pre_rotation_approval() {
    let Scene {
        mut w, a, b, fx, ..
    } = scene();
    let m = market(&mut w, &fx);
    approve(&mut w, &fx, &m, 7, RaiseType::Mature);
    w.rotate(&fx.issuer, &a, &b);

    w.expect_code(
        &[&a],
        &[create_asset_ix(&a.pubkey(), &fx.issuer, "rot-002")],
        ERR_UNAUTHORIZED,
        "old key create_asset",
    );
    w.send(
        &[&b],
        &[create_asset_ix(&b.pubkey(), &fx.issuer, "rot-002")],
        "new key create_asset",
    );
    let draft = asset_pda(&fx.issuer, "rot-002");
    w.expect_code(
        &[&a],
        &[add_share_class_ix(&a.pubkey(), &fx.issuer, &draft)],
        ERR_UNAUTHORIZED,
        "old key add_share_class",
    );
    w.send(
        &[&b],
        &[add_share_class_ix(&b.pubkey(), &fx.issuer, &draft)],
        "new key add_share_class",
    );
    let ix = open_sale_ix(&w, &a.pubkey(), &fx, &m, 7, RaiseType::Mature);
    w.expect_code(&[&a], &[ix], ERR_UNAUTHORIZED, "old key open_sale");
    let ix = open_sale_ix(&w, &b.pubkey(), &fx, &m, 7, RaiseType::Mature);
    w.send(&[&b], &[ix], "new key opens with the pre-rotation approval");
    let sale: Sale = w.load(&sale_pda(&fx.share_class, 7));
    assert_eq!(sale.authority, b.pubkey());
}

// ── 6-7. Grant migration ─────────────────────────────────────────────────────

#[test]
fn rotation_moves_the_grant_and_a_round_trip_never_resurrects_it() {
    let Scene {
        mut w, a, b, fx, ..
    } = scene();
    let grant_a = permissions_pda(&fx.issuer, &a.pubkey());
    let grant_b = permissions_pda(&fx.issuer, &b.pubkey());
    let admin = w.admin.pubkey();
    w.send(
        &[&a],
        &[update_uri_ix(&a.pubkey(), &fx, "https://a")],
        "A metadata",
    );

    w.rotate(&fx.issuer, &a, &b);
    assert!(w.is_closed(&grant_a), "A's grant closed");
    let moved: IssuerPermissions = w.load(&grant_b);
    assert_eq!(moved.issuer, fx.issuer);
    assert_eq!(moved.authority, b.pubkey());
    assert_eq!(moved.capabilities, CAPS);
    assert_eq!(moved.updated_by, admin);
    assert_eq!(moved.version, 1);
    w.send(
        &[&b],
        &[update_uri_ix(&b.pubkey(), &fx, "https://b")],
        "B metadata",
    );
    w.expect_code(
        &[&a],
        &[update_uri_ix(&a.pubkey(), &fx, "https://a2")],
        ERR_UNAUTHORIZED,
        "A after rotation",
    );

    // The super admin revokes B, then B hands the issuer back to A.
    w.grant(&fx.issuer, 0);
    let logs = w.rotate(&fx.issuer, &b, &a);
    let changed = events::<IssuerAuthorityChanged>(&logs);
    assert_eq!(changed[0].capabilities_carried, 0);
    assert!(changed[0].old_grant_closed);
    assert!(w.is_closed(&grant_b));
    let back: IssuerPermissions = w.load(&grant_a);
    assert_eq!(
        back.capabilities, 0,
        "A's old MINT|METADATA grant did not come back"
    );
    w.expect_code(
        &[&a],
        &[update_uri_ix(&a.pubkey(), &fx, "https://a3")],
        ERR_UNAUTHORIZED,
        "A with a zero grant",
    );
}

#[test]
fn rotating_an_issuer_without_a_grant_writes_a_zero_record() {
    let mut w = World::boot();
    let c = w.funded();
    let b = w.funded();
    let issuer = w.register(&c, legal_id(2));
    w.set_kyb(&issuer, true);
    let fx = w.asset_under(&c, &issuer, ASSET_ID);
    let logs = w.rotate(&issuer, &c, &b);
    let changed = events::<IssuerAuthorityChanged>(&logs);
    assert_eq!(changed[0].capabilities_carried, 0);
    assert!(!changed[0].old_grant_closed);
    let record: IssuerPermissions = w.load(&permissions_pda(&issuer, &b.pubkey()));
    assert_eq!(record.capabilities, 0);
    assert_eq!(record.updated_by, Pubkey::default());
    w.expect_code(
        &[&b],
        &[init_mint_ix(&b.pubkey(), &fx)],
        ERR_UNAUTHORIZED,
        "B with a zero record",
    );
}

// ── 8. Other transfers cannot stand in ───────────────────────────────────────

#[test]
fn a_platform_or_kyc_registry_transfer_cannot_stand_in_for_the_issuer_transfer() {
    let Scene { mut w, a, b, c, fx } = scene();
    let admin = w.admin.insecure_clone();
    let platform_transfer = transfer_pda(&platform_pda());
    w.send(
        &[&admin],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::ProposePlatformAdmin {
                new_admin: b.pubkey(),
            }
            .data(),
            acc::ProposePlatformAdmin {
                authority: admin.pubkey(),
                platform: platform_pda(),
                transfer: platform_transfer,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "propose platform admin -> B",
    );
    w.expect_code(
        &[&b],
        &[accept_issuer_authority_ix_with(
            &b.pubkey(),
            &fx.issuer,
            &a.pubkey(),
            platform_transfer,
        )],
        ERR_CONSTRAINT_SEEDS,
        "accept the issuer with the platform transfer",
    );
    w.expect_code(
        &[&a],
        &[propose_issuer_authority_ix_with(
            &a.pubkey(),
            &fx.issuer,
            &b.pubkey(),
            platform_transfer,
        )],
        ERR_CONSTRAINT_SEEDS,
        "propose into the platform transfer",
    );

    // A KYC registry transfer C -> B.
    let create = kyc::create_registry_ix(
        &c.pubkey(),
        &admin.pubkey(),
        kyc::bitmap(&[222]),
        [0u8; 128],
    );
    w.send(&[&c, &admin], &[create], "create_kyc_registry");
    let registry = kyc::registry_pda(&c.pubkey());
    w.send(
        &[&c],
        &[kyc::propose_ix(&c.pubkey(), &registry, &b.pubkey())],
        "propose KYC -> B",
    );
    w.expect_code(
        &[&b],
        &[accept_issuer_authority_ix_with(
            &b.pubkey(),
            &fx.issuer,
            &a.pubkey(),
            kyc::transfer_pda(&registry),
        )],
        ERR_CONSTRAINT_SEEDS,
        "accept the issuer with the KYC transfer",
    );
    assert_eq!(w.load::<Issuer>(&fx.issuer).authority, a.pubkey());
    assert_eq!(
        w.load::<AuthorityTransfer>(&platform_transfer).target,
        platform_pda()
    );
}

// ── 9-12. Recovery ───────────────────────────────────────────────────────────

#[test]
fn only_the_super_admin_proposes_a_recovery_and_eta_is_seven_days_out() {
    let Scene { mut w, a, b, c, fx } = scene();
    let admin = w.admin.insecure_clone();
    // C becomes an ordinary Admin: still not the super admin.
    w.send(
        &[&admin],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::AddAdmin {
                new_admin: c.pubkey(),
            }
            .data(),
            acc::AddAdmin {
                super_admin: admin.pubkey(),
                platform: platform_pda(),
                admin_record: admin_pda(&c.pubkey()),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "add_admin C",
    );
    w.expect_code(
        &[&c],
        &[propose_issuer_recovery_ix(
            &c.pubkey(),
            &fx.issuer,
            &b.pubkey(),
        )],
        ERR_UNAUTHORIZED,
        "an Admin proposes",
    );
    w.expect_code(
        &[&a],
        &[propose_issuer_recovery_ix(
            &a.pubkey(),
            &fx.issuer,
            &b.pubkey(),
        )],
        ERR_UNAUTHORIZED,
        "the issuer proposes",
    );
    w.expect_code(
        &[&admin],
        &[propose_issuer_recovery_ix(
            &admin.pubkey(),
            &fx.issuer,
            &a.pubkey(),
        )],
        ERR_INVALID_PROPOSED_AUTHORITY,
        "recover to the current authority",
    );
    w.expect_code(
        &[&admin],
        &[propose_issuer_recovery_ix(
            &admin.pubkey(),
            &fx.issuer,
            &Pubkey::default(),
        )],
        ERR_INVALID_PROPOSED_AUTHORITY,
        "recover to the default key",
    );

    let now = w.now();
    let logs = w.propose_recovery(&fx.issuer, &b.pubkey());
    let recovery: IssuerRecovery = w.load(&recovery_pda(&fx.issuer));
    assert_eq!(recovery.issuer, fx.issuer);
    assert_eq!(recovery.current_authority, a.pubkey());
    assert_eq!(recovery.new_authority, b.pubkey());
    assert_eq!(recovery.proposed_by, admin.pubkey());
    assert_eq!(recovery.proposed_at, now);
    assert_eq!(recovery.eta, now + 604_800);
    assert_eq!(recovery.expires_at, now + 604_800 + 1_209_600);
    assert_eq!(recovery.version, 1);
    assert_eq!(w.data_len(&recovery_pda(&fx.issuer)), 162);
    let proposed = events::<IssuerRecoveryProposed>(&logs);
    assert_eq!(proposed.len(), 1);
    assert_eq!(proposed[0].eta, recovery.eta);
    assert_eq!(proposed[0].expires_at, recovery.expires_at);
    assert_eq!(proposed[0].proposed_by, admin.pubkey());
    assert_eq!(
        w.load::<Issuer>(&fx.issuer).authority,
        a.pubkey(),
        "nothing moves on propose"
    );
}

#[test]
fn execute_is_bounded_by_eta_and_expiry_and_a_re_proposal_resets_eta() {
    let Scene {
        mut w, a, b, fx, ..
    } = scene();
    let admin = w.admin.pubkey();
    let execute = |b: &Pubkey| execute_issuer_recovery_ix(b, &fx.issuer, &a.pubkey(), &admin);
    let t0 = w.now();
    w.propose_recovery(&fx.issuer, &b.pubkey());
    w.expect_code(
        &[&b],
        &[execute(&b.pubkey())],
        ERR_TIMELOCK_ACTIVE,
        "right away",
    );
    w.warp_to(t0 + DELAY - 1);
    w.expect_code(
        &[&b],
        &[execute(&b.pubkey())],
        ERR_TIMELOCK_ACTIVE,
        "eta - 1",
    );

    // Re-proposal one day later restarts the timelock.
    let t1 = t0 + 86_400;
    w.warp_to(t1);
    w.propose_recovery(&fx.issuer, &b.pubkey());
    assert_eq!(
        w.load::<IssuerRecovery>(&recovery_pda(&fx.issuer)).eta,
        t1 + DELAY
    );
    w.warp_to(t0 + DELAY);
    w.expect_code(
        &[&b],
        &[execute(&b.pubkey())],
        ERR_TIMELOCK_ACTIVE,
        "the old eta",
    );

    w.warp_to(t1 + DELAY + WINDOW);
    w.expect_code(
        &[&b],
        &[execute(&b.pubkey())],
        ERR_RECOVERY_EXPIRED,
        "at expires_at",
    );
    w.warp_to(t1 + DELAY + WINDOW + 86_400);
    w.expect_code(
        &[&b],
        &[execute(&b.pubkey())],
        ERR_RECOVERY_EXPIRED,
        "after expires_at",
    );

    w.warp_to(t1 + DELAY);
    let logs = w.send(&[&b], &[execute(&b.pubkey())], "execute at eta");
    let changed = events::<IssuerAuthorityChanged>(&logs);
    assert_eq!(changed.len(), 1);
    assert_eq!(
        changed[0].kind,
        IssuerAuthorityChangeKind::TimelockedRecovery
    );
    assert_eq!(changed[0].old_authority, a.pubkey());
    assert_eq!(changed[0].new_authority, b.pubkey());
    assert_eq!(w.load::<Issuer>(&fx.issuer).authority, b.pubkey());
    assert_eq!(w.data_len(&fx.issuer), 117);
    assert!(w.is_closed(&recovery_pda(&fx.issuer)));
}

#[test]
fn only_the_proposed_key_executes() {
    let Scene { mut w, a, b, c, fx } = scene();
    let admin = w.admin.pubkey();
    let t0 = w.now();
    w.propose_recovery(&fx.issuer, &b.pubkey());
    w.warp_to(t0 + DELAY);
    w.expect_code(
        &[&c],
        &[execute_issuer_recovery_ix(
            &c.pubkey(),
            &fx.issuer,
            &a.pubkey(),
            &admin,
        )],
        ERR_INVALID_RECOVERY,
        "a different key executes",
    );
    w.expect_code(
        &[&b],
        &[execute_issuer_recovery_ix(
            &b.pubkey(),
            &fx.issuer,
            &a.pubkey(),
            &c.pubkey(),
        )],
        ERR_INVALID_RECOVERY,
        "a forged proposer",
    );
    assert_eq!(w.load::<Issuer>(&fx.issuer).authority, a.pubkey());
}

#[test]
fn the_current_authority_or_the_super_admin_cancels_and_rent_returns_to_the_proposer() {
    let Scene { mut w, a, b, c, fx } = scene();
    let admin = w.admin.insecure_clone();
    let recovery = recovery_pda(&fx.issuer);

    w.propose_recovery(&fx.issuer, &b.pubkey());
    w.expect_code(
        &[&c],
        &[cancel_issuer_recovery_ix(
            &c.pubkey(),
            &fx.issuer,
            &admin.pubkey(),
        )],
        ERR_UNAUTHORIZED,
        "a third party cancels",
    );
    w.expect_code(
        &[&b],
        &[cancel_issuer_recovery_ix(
            &b.pubkey(),
            &fx.issuer,
            &admin.pubkey(),
        )],
        ERR_UNAUTHORIZED,
        "the proposed key cancels",
    );
    w.expect_code(
        &[&a],
        &[cancel_issuer_recovery_ix(
            &a.pubkey(),
            &fx.issuer,
            &a.pubkey(),
        )],
        ERR_INVALID_RECOVERY,
        "the rent redirected",
    );
    let rent = w.lamports(&recovery);
    let admin_before = w.lamports(&admin.pubkey());
    let logs = w.send(
        &[&a],
        &[cancel_issuer_recovery_ix(
            &a.pubkey(),
            &fx.issuer,
            &admin.pubkey(),
        )],
        "the current authority cancels",
    );
    let cancelled = events::<IssuerRecoveryCancelled>(&logs);
    assert_eq!(cancelled.len(), 1);
    assert_eq!(cancelled[0].cancelled_by, a.pubkey());
    assert_eq!(cancelled[0].new_authority, b.pubkey());
    assert!(w.is_closed(&recovery));
    assert_eq!(w.lamports(&admin.pubkey()), admin_before + rent);

    w.propose_recovery(&fx.issuer, &b.pubkey());
    let admin_before = w.lamports(&admin.pubkey());
    w.send(
        &[&admin],
        &[cancel_issuer_recovery_ix(
            &admin.pubkey(),
            &fx.issuer,
            &admin.pubkey(),
        )],
        "the super admin cancels",
    );
    assert!(w.is_closed(&recovery));
    assert_eq!(w.lamports(&admin.pubkey()), admin_before + rent);
}

// ── 13. Staleness ────────────────────────────────────────────────────────────

#[test]
fn a_rotation_or_a_super_admin_change_makes_a_recovery_stale() {
    let Scene { mut w, a, b, c, fx } = scene();
    let old_admin = w.admin.insecure_clone();
    let recovery = recovery_pda(&fx.issuer);
    let t0 = w.now();

    // (1) A regular rotation A -> C inside the window.
    w.propose_recovery(&fx.issuer, &b.pubkey());
    w.rotate(&fx.issuer, &a, &c);
    w.warp_to(t0 + DELAY);
    w.expect_code(
        &[&b],
        &[execute_issuer_recovery_ix(
            &b.pubkey(),
            &fx.issuer,
            &c.pubkey(),
            &old_admin.pubkey(),
        )],
        ERR_INVALID_RECOVERY,
        "stale after a rotation",
    );
    w.send(
        &[&c],
        &[cancel_issuer_recovery_ix(
            &c.pubkey(),
            &fx.issuer,
            &old_admin.pubkey(),
        )],
        "the new authority cancels",
    );
    assert!(w.is_closed(&recovery));

    // (2) The super admin rotates to D inside the window.
    let d = w.funded();
    let t1 = w.now();
    w.propose_recovery(&fx.issuer, &b.pubkey());
    let platform_transfer = transfer_pda(&platform_pda());
    w.send(
        &[&old_admin],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::ProposePlatformAdmin {
                new_admin: d.pubkey(),
            }
            .data(),
            acc::ProposePlatformAdmin {
                authority: old_admin.pubkey(),
                platform: platform_pda(),
                transfer: platform_transfer,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "propose platform admin -> D",
    );
    w.send(
        &[&d],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &ixd::AcceptPlatformAdmin {}.data(),
            acc::AcceptPlatformAdmin {
                new_admin: d.pubkey(),
                platform: platform_pda(),
                transfer: platform_transfer,
                old_admin_record: admin_pda(&old_admin.pubkey()),
                new_admin_record: admin_pda(&d.pubkey()),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "accept platform admin D",
    );
    w.warp_to(t1 + DELAY);
    w.expect_code(
        &[&b],
        &[execute_issuer_recovery_ix(
            &b.pubkey(),
            &fx.issuer,
            &c.pubkey(),
            &old_admin.pubkey(),
        )],
        ERR_INVALID_RECOVERY,
        "stale after a super-admin rotation",
    );
    w.expect_code(
        &[&old_admin],
        &[cancel_issuer_recovery_ix(
            &old_admin.pubkey(),
            &fx.issuer,
            &old_admin.pubkey(),
        )],
        ERR_UNAUTHORIZED,
        "the former super admin cancels",
    );
    let rent = w.lamports(&recovery);
    let old_before = w.lamports(&old_admin.pubkey());
    w.send(
        &[&d],
        &[cancel_issuer_recovery_ix(
            &d.pubkey(),
            &fx.issuer,
            &old_admin.pubkey(),
        )],
        "the new super admin cancels",
    );
    assert!(w.is_closed(&recovery));
    assert_eq!(
        w.lamports(&old_admin.pubkey()),
        old_before + rent,
        "rent back to the proposer that paid it"
    );
    assert_eq!(w.load::<Issuer>(&fx.issuer).authority, c.pubkey());
}

// ── 14. Recovery and grants ──────────────────────────────────────────────────

#[test]
fn a_recovery_closes_the_old_grant_carries_nothing_and_the_super_admin_re_grants() {
    let Scene {
        mut w, a, b, fx, ..
    } = scene();
    let admin = w.admin.pubkey();
    let grant_a = permissions_pda(&fx.issuer, &a.pubkey());
    let grant_b = permissions_pda(&fx.issuer, &b.pubkey());
    let t0 = w.now();
    w.propose_recovery(&fx.issuer, &b.pubkey());
    w.warp_to(t0 + DELAY);
    let refund = w.lamports(&grant_a) + w.lamports(&recovery_pda(&fx.issuer));
    let admin_before = w.lamports(&admin);
    let logs = w.send(
        &[&b],
        &[execute_issuer_recovery_ix(
            &b.pubkey(),
            &fx.issuer,
            &a.pubkey(),
            &admin,
        )],
        "execute",
    );
    let changed = events::<IssuerAuthorityChanged>(&logs);
    assert_eq!(changed[0].capabilities_carried, 0);
    assert!(changed[0].old_grant_closed);
    assert!(w.is_closed(&grant_a), "the lost key's grant is closed");
    assert!(w.is_closed(&grant_b), "no grant is carried");
    assert_eq!(
        w.lamports(&admin),
        admin_before + refund,
        "both rents to the proposer"
    );
    w.expect_code(
        &[&b],
        &[update_uri_ix(&b.pubkey(), &fx, "https://b")],
        ERR_UNAUTHORIZED,
        "B before the re-grant",
    );
    w.grant(&fx.issuer, asset_registry::ISSUER_PERMISSION_METADATA);
    w.send(
        &[&b],
        &[update_uri_ix(&b.pubkey(), &fx, "https://b")],
        "B after the re-grant",
    );
}

#[test]
fn a_recovery_closes_a_leftover_grant_of_the_recovered_key() {
    // B registers, is verified and granted MINT, then KYB is rejected and the
    // registration recovered to A: B's grant is left behind (that path's
    // accounts are frozen). A later recovery back to B must not revive it.
    let mut w = World::boot();
    let a = w.funded();
    let b = w.funded();
    let admin = w.admin.insecure_clone();
    let issuer = w.register(&b, legal_id(3));
    w.set_kyb(&issuer, true);
    w.grant(&issuer, asset_registry::ISSUER_PERMISSION_MINT);
    w.set_kyb(&issuer, false);
    w.send(
        &[&admin, &a],
        &[recover_registration_ix(
            &admin.pubkey(),
            &issuer,
            &a.pubkey(),
        )],
        "recover_issuer_registration -> A",
    );
    let leftover = permissions_pda(&issuer, &b.pubkey());
    assert_eq!(
        w.load::<IssuerPermissions>(&leftover).capabilities,
        asset_registry::ISSUER_PERMISSION_MINT
    );
    w.set_kyb(&issuer, true);

    let t0 = w.now();
    w.propose_recovery(&issuer, &b.pubkey());
    w.warp_to(t0 + DELAY);
    let logs = w.send(
        &[&b],
        &[execute_issuer_recovery_ix(
            &b.pubkey(),
            &issuer,
            &a.pubkey(),
            &admin.pubkey(),
        )],
        "execute -> B",
    );
    assert!(
        !events::<IssuerAuthorityChanged>(&logs)[0].old_grant_closed,
        "A had no grant"
    );
    assert!(w.is_closed(&leftover), "B's leftover MINT grant is closed");
    assert_eq!(w.load::<Issuer>(&issuer).authority, b.pubkey());
}

// ── 15. Pause flags ──────────────────────────────────────────────────────────

#[test]
fn every_new_instruction_works_while_fully_paused_and_payout_exits_stay_gated() {
    let Scene { mut w, a, b, c, fx } = scene();
    let admin = w.admin.pubkey();
    let m = market(&mut w, &fx);
    let mature = sale(&mut w, &a, &fx, &m, 1, RaiseType::Mature, 100);
    let startup = sale(&mut w, &a, &fx, &m, 2, RaiseType::Startup, 100);
    w.send(
        &[&a],
        &[open_payout_vault_ix(&a.pubkey(), &startup, &m)],
        "open vault",
    );
    let vault = payout_pda(&startup);
    w.set_pause(asset_registry::PAUSE_FLAGS_ALL, 0);

    let propose = propose_issuer_authority_ix(&a.pubkey(), &fx.issuer, &b.pubkey());
    w.send(&[&a], std::slice::from_ref(&propose), "propose (paused)");
    w.send(
        &[&a],
        &[cancel_issuer_authority_transfer_ix(&a.pubkey(), &fx.issuer)],
        "cancel (paused)",
    );
    w.send(&[&a], &[propose], "re-propose (paused)");
    w.send(
        &[&b],
        &[accept_issuer_authority_ix(
            &b.pubkey(),
            &fx.issuer,
            &a.pubkey(),
        )],
        "accept (paused)",
    );
    w.send(
        &[],
        &[sync_sale_authority_ix(&mature, &fx)],
        "sync sale (paused)",
    );
    w.send(
        &[],
        &[sync_payout_founder_ix(&vault, &fx)],
        "sync vault (paused)",
    );
    w.propose_recovery(&fx.issuer, &c.pubkey());
    w.send(
        &[&b],
        &[cancel_issuer_recovery_ix(&b.pubkey(), &fx.issuer, &admin)],
        "cancel recovery (paused)",
    );
    let t0 = w.now();
    w.propose_recovery(&fx.issuer, &c.pubkey());
    w.warp_to(t0 + DELAY);
    w.send(
        &[&c],
        &[execute_issuer_recovery_ix(
            &c.pubkey(),
            &fx.issuer,
            &b.pubkey(),
            &admin,
        )],
        "execute recovery (paused)",
    );
    w.send(
        &[],
        &[sync_sale_authority_ix(&mature, &fx)],
        "re-sync (paused)",
    );
    assert_eq!(w.load::<Sale>(&mature).authority, c.pubkey());

    let dest = ata(&mut w, &m.payment_mint, &c.pubkey());
    w.expect_code(
        &[&c],
        &[close_sale_ix(&c.pubkey(), &mature, &m, &dest)],
        ERR_PAUSED,
        "close_sale stays paused",
    );
    let b_dest = ata(&mut w, &m.payment_mint, &b.pubkey());
    w.expect_code(
        &[],
        &[release_ix(&vault, &m, &b_dest)],
        ERR_PAUSED,
        "release stays paused",
    );
}

// ── 16-17. Sync ──────────────────────────────────────────────────────────────

#[test]
fn close_sale_follows_the_synced_authority() {
    let Scene {
        mut w, a, b, fx, ..
    } = scene();
    let m = market(&mut w, &fx);
    let first = sale(&mut w, &a, &fx, &m, 1, RaiseType::Mature, 100);
    let second = sale(&mut w, &a, &fx, &m, 2, RaiseType::Mature, 100);
    w.rotate(&fx.issuer, &a, &b);
    let a_dest = ata(&mut w, &m.payment_mint, &a.pubkey());
    let b_dest = ata(&mut w, &m.payment_mint, &b.pubkey());

    // The residual window: before a sync the old key still closes a sale.
    w.send(
        &[&a],
        &[close_sale_ix(&a.pubkey(), &first, &m, &a_dest)],
        "old key closes an unsynced sale",
    );
    assert_eq!(balance(&w, &a_dest), 100);
    w.expect_code(
        &[&b],
        &[close_sale_ix(&b.pubkey(), &second, &m, &b_dest)],
        ERR_UNAUTHORIZED,
        "new key before sync",
    );

    let logs = w.send(
        &[],
        &[sync_sale_authority_ix(&second, &fx)],
        "sync (fee payer only)",
    );
    let synced = events::<SaleAuthoritySynced>(&logs);
    assert_eq!(synced.len(), 1);
    assert_eq!(synced[0].sale, second);
    assert_eq!(synced[0].issuer, fx.issuer);
    assert_eq!(synced[0].old_authority, a.pubkey());
    assert_eq!(synced[0].new_authority, b.pubkey());
    w.expect_code(
        &[&a],
        &[close_sale_ix(&a.pubkey(), &second, &m, &a_dest)],
        ERR_UNAUTHORIZED,
        "old key after sync",
    );
    w.send(
        &[&b],
        &[close_sale_ix(&b.pubkey(), &second, &m, &b_dest)],
        "new key closes",
    );
    assert_eq!(
        balance(&w, &b_dest),
        100,
        "proceeds in the new key's account"
    );
}

#[test]
fn payout_vaults_follow_the_synced_founder() {
    let Scene {
        mut w, a, b, fx, ..
    } = scene();
    let m = market(&mut w, &fx);
    let unvaulted = sale(&mut w, &a, &fx, &m, 3, RaiseType::Startup, 100);
    let vaulted = sale(&mut w, &a, &fx, &m, 4, RaiseType::Startup, 100);
    w.send(
        &[&a],
        &[open_payout_vault_ix(&a.pubkey(), &vaulted, &m)],
        "A opens vault 4",
    );
    let vault = payout_pda(&vaulted);
    w.rotate(&fx.issuer, &a, &b);

    // open_payout_vault: the sale's authority snapshot decides.
    w.expect_code(
        &[&b],
        &[open_payout_vault_ix(&b.pubkey(), &unvaulted, &m)],
        ERR_UNAUTHORIZED,
        "new key before the sale sync",
    );
    w.send(
        &[],
        &[sync_sale_authority_ix(&unvaulted, &fx)],
        "sync sale 3",
    );
    w.send(
        &[&b],
        &[open_payout_vault_ix(&b.pubkey(), &unvaulted, &m)],
        "B opens vault 3",
    );
    assert_eq!(
        w.load::<PayoutVault>(&payout_pda(&unvaulted)).founder,
        b.pubkey()
    );

    // A vault opened before the rotation: sync the founder.
    w.expect_code(
        &[&b],
        &[post_update_ix(&b.pubkey(), &vault)],
        ERR_NOT_FOUNDER,
        "B before sync",
    );
    let logs = w.send(&[], &[sync_payout_founder_ix(&vault, &fx)], "sync vault 4");
    let synced = events::<PayoutFounderSynced>(&logs);
    assert_eq!(synced.len(), 1);
    assert_eq!(synced[0].vault, vault);
    assert_eq!(synced[0].old_founder, a.pubkey());
    assert_eq!(synced[0].new_founder, b.pubkey());
    assert_eq!(w.load::<PayoutVault>(&vault).founder, b.pubkey());

    w.expect_code(
        &[&a],
        &[post_update_ix(&a.pubkey(), &vault)],
        ERR_NOT_FOUNDER,
        "A post_update",
    );
    w.send(
        &[&b],
        &[post_update_ix(&b.pubkey(), &vault)],
        "B post_update",
    );
    let a_dest = ata(&mut w, &m.payment_mint, &a.pubkey());
    let b_dest = ata(&mut w, &m.payment_mint, &b.pubkey());
    w.expect_code(
        &[],
        &[release_ix(&vault, &m, &a_dest)],
        ERR_NOT_FOUNDER,
        "release to A",
    );
    let tranche = w.load::<PayoutVault>(&vault).tranche_amount;
    w.send(
        &[],
        &[release_ix(&vault, &m, &b_dest)],
        "release to B (permissionless)",
    );
    assert_eq!(balance(&w, &b_dest), tranche);

    route_yield(&mut w, &vault, &m);
    let claimable = w.load::<PayoutVault>(&vault).founder_yield_claimable;
    assert!(claimable > 0);
    w.expect_code(
        &[&a],
        &[claim_founder_yield_ix(&a.pubkey(), &vault, &m, &a_dest)],
        ERR_NOT_FOUNDER,
        "A claims",
    );
    w.send(
        &[&b],
        &[claim_founder_yield_ix(&b.pubkey(), &vault, &m, &b_dest)],
        "B claims",
    );
    assert_eq!(balance(&w, &b_dest), tranche + claimable);
}

// ── 18. Sync guards ──────────────────────────────────────────────────────────

#[test]
fn sync_refuses_a_foreign_or_forged_chain_is_idempotent_and_reads_legacy_share_classes() {
    let Scene { mut w, a, b, c, fx } = scene();
    let other = {
        let issuer = w.register(&c, legal_id(9));
        w.set_kyb(&issuer, true);
        w.asset_under(&c, &issuer, "other-001")
    };
    let m = market(&mut w, &fx);
    let s = sale(&mut w, &a, &fx, &m, 1, RaiseType::Mature, 0);

    // In sync: a no-op with no event.
    let logs = w.send(&[], &[sync_sale_authority_ix(&s, &fx)], "in sync");
    assert!(events::<SaleAuthoritySynced>(&logs).is_empty());

    w.rotate(&fx.issuer, &a, &b);
    for (what, share_class, asset, issuer) in [
        (
            "foreign share class",
            other.share_class,
            fx.asset,
            fx.issuer,
        ),
        ("foreign asset", fx.share_class, other.asset, fx.issuer),
        ("foreign issuer", fx.share_class, fx.asset, other.issuer),
        ("issuer as asset", fx.share_class, fx.issuer, fx.issuer),
    ] {
        let ix = sync_sale_authority_ix_with(&s, &share_class, &asset, &issuer);
        w.expect_code(&[], &[ix], ERR_UNAUTHORIZED, what);
    }

    // Forged owner on the real share-class address.
    let real = w.svm.get_account(&fx.share_class).unwrap();
    let mut forged = real.clone();
    forged.owner = system_program::ID;
    w.svm.set_account(fx.share_class, forged).unwrap();
    w.expect_code(
        &[],
        &[sync_sale_authority_ix(&s, &fx)],
        ERR_UNAUTHORIZED,
        "forged owner",
    );
    w.svm.set_account(fx.share_class, real.clone()).unwrap();

    // Forged discriminator on the real asset address.
    let real_asset = w.svm.get_account(&fx.asset).unwrap();
    let mut forged = real_asset.clone();
    forged.data[..8].copy_from_slice(Issuer::DISCRIMINATOR);
    w.svm.set_account(fx.asset, forged).unwrap();
    w.expect_code(
        &[],
        &[sync_sale_authority_ix(&s, &fx)],
        ERR_UNAUTHORIZED,
        "forged discriminator",
    );
    w.svm.set_account(fx.asset, real_asset).unwrap();
    assert_eq!(w.load::<Sale>(&s).authority, a.pubkey(), "nothing written");

    // A legacy v1 share class (shorter layout, `asset` still at byte 8).
    let mut legacy = real.clone();
    legacy.data.truncate(8 + LegacyShareClass::INIT_SPACE);
    w.svm.set_account(fx.share_class, legacy).unwrap();
    let logs = w.send(
        &[],
        &[sync_sale_authority_ix(&s, &fx)],
        "sync via a v1 share class",
    );
    assert_eq!(events::<SaleAuthoritySynced>(&logs).len(), 1);
    assert_eq!(w.load::<Sale>(&s).authority, b.pubkey());
    let logs = w.send(&[], &[sync_sale_authority_ix(&s, &fx)], "second sync");
    assert!(
        events::<SaleAuthoritySynced>(&logs).is_empty(),
        "idempotent"
    );
}

// ── 19. Atomic bundle ────────────────────────────────────────────────────────

#[test]
fn accept_and_every_sync_fit_in_one_atomic_transaction() {
    let Scene {
        mut w, a, b, fx, ..
    } = scene();
    let m = market(&mut w, &fx);
    // 120 units: a Startup vault needs at least one unit per tranche (12).
    let open = sale(&mut w, &a, &fx, &m, 5, RaiseType::Startup, 120);
    let mut vaults = Vec::new();
    for id in 6..=8 {
        let s = sale(&mut w, &a, &fx, &m, id, RaiseType::Startup, 120);
        w.send(
            &[&a],
            &[open_payout_vault_ix(&a.pubkey(), &s, &m)],
            "open vault",
        );
        vaults.push(payout_pda(&s));
    }
    w.send(
        &[&a],
        &[propose_issuer_authority_ix(
            &a.pubkey(),
            &fx.issuer,
            &b.pubkey(),
        )],
        "propose",
    );
    let mut bundle = vec![
        accept_issuer_authority_ix(&b.pubkey(), &fx.issuer, &a.pubkey()),
        sync_sale_authority_ix(&open, &fx),
    ];
    bundle.extend(vaults.iter().map(|v| sync_payout_founder_ix(v, &fx)));
    let message = Message::new(&bundle, Some(&w.fees.pubkey()));
    let size =
        1 + 64 * usize::from(message.header.num_required_signatures) + message.serialize().len();
    assert!(
        size <= 1232,
        "bundle of {} instructions is {size} B",
        bundle.len()
    );
    w.send(&[&b], &bundle, "accept + syncs");
    assert_eq!(w.load::<Issuer>(&fx.issuer).authority, b.pubkey());
    assert_eq!(w.load::<Sale>(&open).authority, b.pubkey());
    for v in &vaults {
        assert_eq!(w.load::<PayoutVault>(v).founder, b.pubkey());
    }
}

// ── 20. recover_issuer_registration ──────────────────────────────────────────

#[test]
fn recover_issuer_registration_paths() {
    let mut w = World::boot();
    let admin = w.admin.insecure_clone();
    let a = w.funded();
    let b = w.funded();
    let c = w.funded();
    let pending = w.register(&c, legal_id(5));

    w.expect_code(
        &[&a, &b],
        &[recover_registration_ix(&a.pubkey(), &pending, &b.pubkey())],
        ERR_UNAUTHORIZED,
        "not the super admin",
    );
    let mut unsigned = recover_registration_ix(&admin.pubkey(), &pending, &b.pubkey());
    unsigned.accounts[3].is_signer = false;
    w.expect_code(
        &[&admin],
        &[unsigned],
        ERR_ACCOUNT_NOT_SIGNER,
        "new key did not sign",
    );

    let logs = w.send(
        &[&admin, &b],
        &[recover_registration_ix(
            &admin.pubkey(),
            &pending,
            &b.pubkey(),
        )],
        "recover",
    );
    let recovered: Issuer = w.load(&pending);
    assert_eq!(recovered.authority, b.pubkey());
    assert_eq!(recovered.jurisdiction, 191);
    assert_eq!(recovered.kyb_doc_hash, [5u8; 32]);
    assert_eq!(recovered.kyb_status, KybStatus::Pending);
    assert_eq!(recovered.legal_entity_id, legal_id(5));
    let changed = events::<IssuerAuthorityChanged>(&logs);
    assert_eq!(changed.len(), 1);
    assert_eq!(
        changed[0].kind,
        IssuerAuthorityChangeKind::RegistrationRecovery
    );
    assert_eq!(changed[0].old_authority, c.pubkey());
    assert_eq!(changed[0].new_authority, b.pubkey());
    assert_eq!(changed[0].capabilities_carried, 0);
    assert!(!changed[0].old_grant_closed);

    // Verified: refused.
    w.set_kyb(&pending, true);
    w.expect_code(
        &[&admin, &a],
        &[recover_registration_ix(
            &admin.pubkey(),
            &pending,
            &a.pubkey(),
        )],
        ERR_NOT_RECOVERABLE,
        "verified issuer",
    );
    // Rejected but with an asset: refused.
    w.asset_under(&b, &pending, ASSET_ID);
    w.set_kyb(&pending, false);
    w.expect_code(
        &[&admin, &a],
        &[recover_registration_ix(
            &admin.pubkey(),
            &pending,
            &a.pubkey(),
        )],
        ERR_NOT_RECOVERABLE,
        "issuer with an asset",
    );
}

// ── 21. Layout and error positions ───────────────────────────────────────────

#[test]
fn layouts_and_error_codes_are_positional() {
    assert_eq!(IssuerRecovery::INIT_SPACE, 154);
    assert_eq!(8 + Issuer::INIT_SPACE, 117);
    assert_eq!(8 + AuthorityTransfer::INIT_SPACE, 137);
    assert_eq!(
        u32::from(RegistryError::SaleStartsAfterApprovalExpiry),
        6130
    );
    assert_eq!(u32::from(RegistryError::IssuerRecoveryTimelockActive), 6131);
    assert_eq!(u32::from(RegistryError::IssuerRecoveryExpired), 6132);
    assert_eq!(u32::from(RegistryError::InvalidIssuerRecovery), 6133);

    let record = IssuerRecovery {
        issuer: Pubkey::new_from_array([1; 32]),
        current_authority: Pubkey::new_from_array([2; 32]),
        new_authority: Pubkey::new_from_array([3; 32]),
        proposed_by: Pubkey::new_from_array([4; 32]),
        proposed_at: 5,
        eta: 6,
        expires_at: 7,
        version: 8,
        bump: 9,
    };
    let mut bytes = Vec::new();
    record.try_serialize(&mut bytes).unwrap();
    assert_eq!(bytes.len(), 162);
    assert_eq!(&bytes[8..40], &[1; 32]);
    assert_eq!(&bytes[40..72], &[2; 32]);
    assert_eq!(
        &bytes[72..104],
        &[3; 32],
        "new_authority at 72 (front memcmp)"
    );
    assert_eq!(&bytes[104..136], &[4; 32]);
    assert_eq!(i64::from_le_bytes(bytes[136..144].try_into().unwrap()), 5);
    assert_eq!(i64::from_le_bytes(bytes[144..152].try_into().unwrap()), 6);
    assert_eq!(i64::from_le_bytes(bytes[152..160].try_into().unwrap()), 7);
    assert_eq!((bytes[160], bytes[161]), (8, 9));

    let transfer = AuthorityTransfer {
        target: Pubkey::default(),
        current_authority: Pubkey::default(),
        new_authority: Pubkey::new_from_array([3; 32]),
        proposed_by: Pubkey::default(),
        bump: 0,
    };
    let mut bytes = Vec::new();
    transfer.try_serialize(&mut bytes).unwrap();
    assert_eq!(
        &bytes[72..104],
        &[3; 32],
        "AuthorityTransfer.new_authority at 72 too"
    );
}

// ── 22. Review round: Admin keys, retired proposals, foreign accounts ────────

fn add_admin_ix(super_admin: &Pubkey, new_admin: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::AddAdmin {
            new_admin: *new_admin,
        }
        .data(),
        acc::AddAdmin {
            super_admin: *super_admin,
            platform: platform_pda(),
            admin_record: admin_pda(new_admin),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// `ix` with every account meta keyed `from` re-pointed at `to`.
fn swap_account(mut ix: Instruction, from: &Pubkey, to: &Pubkey) -> Instruction {
    let mut hit = false;
    for meta in &mut ix.accounts {
        if meta.pubkey == *from {
            meta.pubkey = *to;
            hit = true;
        }
    }
    assert!(hit, "account {from} is not in the instruction");
    ix
}

#[test]
fn a_plain_issuer_key_never_rotates_or_recovers_onto_a_global_admin_key() {
    let Scene { mut w, a, b, c, fx } = scene();
    let admin = w.admin.insecure_clone();
    w.send(
        &[&admin],
        &[add_admin_ix(&admin.pubkey(), &b.pubkey())],
        "add_admin B",
    );

    // A (plain key, MINT|METADATA grant) -> B (Admin): refused at accept,
    // since an Admin skips the per-issuer grant.
    w.send(
        &[&a],
        &[propose_issuer_authority_ix(
            &a.pubkey(),
            &fx.issuer,
            &b.pubkey(),
        )],
        "propose -> Admin B",
    );
    w.expect_code(
        &[&b],
        &[accept_issuer_authority_ix(
            &b.pubkey(),
            &fx.issuer,
            &a.pubkey(),
        )],
        ERR_INVALID_PROPOSED_AUTHORITY,
        "accept by an Admin key",
    );
    let hidden = swap_account(
        accept_issuer_authority_ix(&b.pubkey(), &fx.issuer, &a.pubkey()),
        &admin_pda(&b.pubkey()),
        &admin_pda(&c.pubkey()),
    );
    w.expect_code(
        &[&b],
        &[hidden],
        ERR_CONSTRAINT_SEEDS,
        "accept with another key's Admin PDA",
    );
    w.send(
        &[&a],
        &[cancel_issuer_authority_transfer_ix(&a.pubkey(), &fx.issuer)],
        "cancel",
    );

    // A recovery never lands on an Admin key.
    let t0 = w.now();
    w.propose_recovery(&fx.issuer, &b.pubkey());
    w.warp_to(t0 + DELAY);
    w.expect_code(
        &[&b],
        &[execute_issuer_recovery_ix(
            &b.pubkey(),
            &fx.issuer,
            &a.pubkey(),
            &admin.pubkey(),
        )],
        ERR_INVALID_RECOVERY,
        "execute by an Admin key",
    );
    let hidden = swap_account(
        execute_issuer_recovery_ix(&b.pubkey(), &fx.issuer, &a.pubkey(), &admin.pubkey()),
        &admin_pda(&b.pubkey()),
        &admin_pda(&c.pubkey()),
    );
    w.expect_code(
        &[&b],
        &[hidden],
        ERR_CONSTRAINT_SEEDS,
        "execute with another key's Admin PDA",
    );
    assert_eq!(w.load::<Issuer>(&fx.issuer).authority, a.pubkey());
    w.send(
        &[&admin],
        &[cancel_issuer_recovery_ix(
            &admin.pubkey(),
            &fx.issuer,
            &admin.pubkey(),
        )],
        "cancel recovery",
    );

    // Admin -> Admin gains nothing and stays possible.
    w.send(
        &[&admin],
        &[add_admin_ix(&admin.pubkey(), &a.pubkey())],
        "add_admin A",
    );
    w.rotate(&fx.issuer, &a, &b);
    assert_eq!(w.load::<Issuer>(&fx.issuer).authority, b.pubkey());
}

#[test]
fn a_rotation_retires_a_pending_recovery_so_a_round_trip_cannot_revive_it() {
    let Scene { mut w, a, b, c, fx } = scene();
    let admin = w.admin.insecure_clone();
    let recovery = recovery_pda(&fx.issuer);
    let t0 = w.now();
    w.propose_recovery(&fx.issuer, &c.pubkey());
    let logs = w.rotate(&fx.issuer, &a, &b);
    assert!(logs.iter().any(|l| l.contains("pending recovery retired")));
    let retired = w.load::<IssuerRecovery>(&recovery);
    assert_eq!(retired.current_authority, Pubkey::default());
    assert_eq!(retired.new_authority, c.pubkey());

    // B hands the key back to A inside the execution window.
    w.rotate(&fx.issuer, &b, &a);
    w.warp_to(t0 + DELAY);
    w.expect_code(
        &[&c],
        &[execute_issuer_recovery_ix(
            &c.pubkey(),
            &fx.issuer,
            &a.pubkey(),
            &admin.pubkey(),
        )],
        ERR_INVALID_RECOVERY,
        "a recovery revived by A -> B -> A",
    );
    let rent = w.lamports(&recovery);
    let before = w.lamports(&admin.pubkey());
    w.send(
        &[&a],
        &[cancel_issuer_recovery_ix(
            &a.pubkey(),
            &fx.issuer,
            &admin.pubkey(),
        )],
        "A cancels the retired recovery",
    );
    assert!(w.is_closed(&recovery));
    assert_eq!(w.lamports(&admin.pubkey()), before + rent);
    assert_eq!(w.load::<Issuer>(&fx.issuer).authority, a.pubkey());
}

/// A (about to lose its key) stages a rotation to C; the super admin recovers
/// the issuer to B.
fn recovered_with_a_pending_rotation(s: &mut Scene) {
    let admin = s.w.admin.insecure_clone();
    s.w.send(
        &[&s.a],
        &[propose_issuer_authority_ix(
            &s.a.pubkey(),
            &s.fx.issuer,
            &s.c.pubkey(),
        )],
        "A proposes C",
    );
    let t0 = s.w.now();
    s.w.propose_recovery(&s.fx.issuer, &s.b.pubkey());
    s.w.warp_to(t0 + DELAY);
    let logs = s.w.send(
        &[&s.b],
        &[execute_issuer_recovery_ix(
            &s.b.pubkey(),
            &s.fx.issuer,
            &s.a.pubkey(),
            &admin.pubkey(),
        )],
        "recover -> B",
    );
    assert!(logs
        .iter()
        .any(|l| l.contains("pending authority transfer retired")));
    let transfer = s.w.load::<AuthorityTransfer>(&transfer_pda(&s.fx.issuer));
    assert_eq!(transfer.current_authority, Pubkey::default());
    assert_eq!(transfer.new_authority, s.c.pubkey());
}

#[test]
fn a_recovery_retires_a_pending_rotation_and_the_recovered_key_cancels_it() {
    let mut s = scene();
    recovered_with_a_pending_rotation(&mut s);
    let Scene {
        mut w, b, c, fx, ..
    } = s;
    let transfer = transfer_pda(&fx.issuer);
    w.expect_code(
        &[&c],
        &[accept_issuer_authority_ix(
            &c.pubkey(),
            &fx.issuer,
            &b.pubkey(),
        )],
        ERR_INVALID_AUTHORITY_TRANSFER,
        "C accepts the lost key's proposal",
    );
    let rent = w.lamports(&transfer);
    let before = w.lamports(&b.pubkey());
    w.send(
        &[&b],
        &[cancel_issuer_authority_transfer_ix(&b.pubkey(), &fx.issuer)],
        "B cancels the stale proposal",
    );
    assert!(w.is_closed(&transfer));
    assert_eq!(w.lamports(&b.pubkey()), before + rent);
}

#[test]
fn a_round_trip_back_to_the_proposing_key_cannot_revive_a_retired_rotation() {
    let mut s = scene();
    recovered_with_a_pending_rotation(&mut s);
    let Scene { mut w, a, b, c, fx } = s;
    let admin = w.admin.insecure_clone();
    let t1 = w.now();
    w.propose_recovery(&fx.issuer, &a.pubkey());
    w.warp_to(t1 + DELAY);
    w.send(
        &[&a],
        &[execute_issuer_recovery_ix(
            &a.pubkey(),
            &fx.issuer,
            &b.pubkey(),
            &admin.pubkey(),
        )],
        "recover back -> A",
    );
    assert_eq!(w.load::<Issuer>(&fx.issuer).authority, a.pubkey());
    w.expect_code(
        &[&c],
        &[accept_issuer_authority_ix(
            &c.pubkey(),
            &fx.issuer,
            &a.pubkey(),
        )],
        ERR_INVALID_AUTHORITY_TRANSFER,
        "C accepts once A is back",
    );
    w.send(
        &[&a],
        &[cancel_issuer_authority_transfer_ix(&a.pubkey(), &fx.issuer)],
        "A cancels",
    );
}

#[test]
fn another_issuers_proposals_and_wrong_grant_pdas_are_refused() {
    let Scene { mut w, a, b, c, fx } = scene();
    let admin = w.admin.insecure_clone();
    let y = w.register(&c, legal_id(9));
    w.set_kyb(&y, true);
    w.send(
        &[&c],
        &[propose_issuer_authority_ix(&c.pubkey(), &y, &b.pubkey())],
        "Y proposes B",
    );
    let t0 = w.now();
    w.propose_recovery(&y, &b.pubkey());
    w.warp_to(t0 + DELAY);

    // Y's proposals replayed against issuer X.
    w.expect_code(
        &[&b],
        &[accept_issuer_authority_ix_with(
            &b.pubkey(),
            &fx.issuer,
            &a.pubkey(),
            transfer_pda(&y),
        )],
        ERR_CONSTRAINT_SEEDS,
        "accept X with Y's transfer",
    );
    let replay = swap_account(
        execute_issuer_recovery_ix(&b.pubkey(), &fx.issuer, &a.pubkey(), &admin.pubkey()),
        &recovery_pda(&fx.issuer),
        &recovery_pda(&y),
    );
    w.expect_code(
        &[&b],
        &[replay],
        ERR_CONSTRAINT_SEEDS,
        "execute X with Y's recovery",
    );
    let replay = swap_account(
        cancel_issuer_recovery_ix(&a.pubkey(), &fx.issuer, &admin.pubkey()),
        &recovery_pda(&fx.issuer),
        &recovery_pda(&y),
    );
    w.expect_code(
        &[&a],
        &[replay],
        ERR_CONSTRAINT_SEEDS,
        "X's authority cancels Y's recovery",
    );
    let replay = swap_account(
        cancel_issuer_authority_transfer_ix(&a.pubkey(), &fx.issuer),
        &transfer_pda(&fx.issuer),
        &transfer_pda(&y),
    );
    w.expect_code(
        &[&a],
        &[replay],
        ERR_CONSTRAINT_SEEDS,
        "X's authority cancels Y's transfer",
    );

    // Wrong grant / Admin / proposal PDAs on X's own live proposals.
    w.send(
        &[&a],
        &[propose_issuer_authority_ix(
            &a.pubkey(),
            &fx.issuer,
            &b.pubkey(),
        )],
        "X proposes B",
    );
    let x_old = permissions_pda(&fx.issuer, &a.pubkey());
    let x_new = permissions_pda(&fx.issuer, &b.pubkey());
    let x_other = permissions_pda(&fx.issuer, &c.pubkey());
    for (what, from, to) in [
        ("old grant of another key", x_old, x_other),
        ("new grant of another key", x_new, x_other),
        (
            "Y's grant as the old grant",
            x_old,
            permissions_pda(&y, &c.pubkey()),
        ),
        (
            "old Admin PDA of another key",
            admin_pda(&a.pubkey()),
            admin_pda(&c.pubkey()),
        ),
        ("Y's recovery", recovery_pda(&fx.issuer), recovery_pda(&y)),
    ] {
        let ix = swap_account(
            accept_issuer_authority_ix(&b.pubkey(), &fx.issuer, &a.pubkey()),
            &from,
            &to,
        );
        w.expect_code(&[&b], &[ix], ERR_CONSTRAINT_SEEDS, what);
    }
    w.send(
        &[&a],
        &[cancel_issuer_authority_transfer_ix(&a.pubkey(), &fx.issuer)],
        "cancel",
    );
    let t1 = w.now();
    w.propose_recovery(&fx.issuer, &b.pubkey());
    w.warp_to(t1 + DELAY);
    for (what, from, to) in [
        ("old grant of another key", x_old, x_other),
        ("new grant of another key", x_new, x_other),
        (
            "Y's grant as the new grant",
            x_new,
            permissions_pda(&y, &b.pubkey()),
        ),
        ("Y's transfer", transfer_pda(&fx.issuer), transfer_pda(&y)),
    ] {
        let ix = swap_account(
            execute_issuer_recovery_ix(&b.pubkey(), &fx.issuer, &a.pubkey(), &admin.pubkey()),
            &from,
            &to,
        );
        w.expect_code(&[&b], &[ix], ERR_CONSTRAINT_SEEDS, what);
    }
    w.send(
        &[&b],
        &[execute_issuer_recovery_ix(
            &b.pubkey(),
            &fx.issuer,
            &a.pubkey(),
            &admin.pubkey(),
        )],
        "the real execute",
    );
    assert_eq!(w.load::<Issuer>(&fx.issuer).authority, b.pubkey());
    // Y's own proposals are untouched.
    assert_eq!(
        w.load::<AuthorityTransfer>(&transfer_pda(&y))
            .current_authority,
        c.pubkey()
    );
    assert_eq!(
        w.load::<IssuerRecovery>(&recovery_pda(&y))
            .current_authority,
        c.pubkey()
    );
}

#[test]
fn sync_payout_founder_refuses_a_foreign_or_forged_chain_and_is_idempotent() {
    let Scene { mut w, a, b, c, fx } = scene();
    let other = {
        let issuer = w.register(&c, legal_id(9));
        w.set_kyb(&issuer, true);
        w.asset_under(&c, &issuer, "other-001")
    };
    let m = market(&mut w, &fx);
    let s = sale(&mut w, &a, &fx, &m, 2, RaiseType::Startup, 120);
    w.send(
        &[&a],
        &[open_payout_vault_ix(&a.pubkey(), &s, &m)],
        "open vault",
    );
    let vault = payout_pda(&s);
    let logs = w.send(&[], &[sync_payout_founder_ix(&vault, &fx)], "in sync");
    assert!(events::<PayoutFounderSynced>(&logs).is_empty());

    w.rotate(&fx.issuer, &a, &b);
    for (what, share_class, asset, issuer) in [
        (
            "foreign share class",
            other.share_class,
            fx.asset,
            fx.issuer,
        ),
        ("foreign asset", fx.share_class, other.asset, fx.issuer),
        ("foreign issuer", fx.share_class, fx.asset, other.issuer),
        ("issuer as asset", fx.share_class, fx.issuer, fx.issuer),
        (
            "the other issuer's whole chain",
            other.share_class,
            other.asset,
            other.issuer,
        ),
    ] {
        let ix = sync_payout_founder_ix_with(&vault, &share_class, &asset, &issuer);
        w.expect_code(&[], &[ix], ERR_UNAUTHORIZED, what);
    }

    let real = w.svm.get_account(&fx.share_class).unwrap();
    let mut forged = real.clone();
    forged.owner = system_program::ID;
    w.svm.set_account(fx.share_class, forged).unwrap();
    w.expect_code(
        &[],
        &[sync_payout_founder_ix(&vault, &fx)],
        ERR_UNAUTHORIZED,
        "forged owner",
    );
    w.svm.set_account(fx.share_class, real).unwrap();
    let real_asset = w.svm.get_account(&fx.asset).unwrap();
    let mut forged = real_asset.clone();
    forged.data[..8].copy_from_slice(Issuer::DISCRIMINATOR);
    w.svm.set_account(fx.asset, forged).unwrap();
    w.expect_code(
        &[],
        &[sync_payout_founder_ix(&vault, &fx)],
        ERR_UNAUTHORIZED,
        "forged discriminator",
    );
    w.svm.set_account(fx.asset, real_asset).unwrap();
    assert_eq!(w.load::<PayoutVault>(&vault).founder, a.pubkey());

    let logs = w.send(&[], &[sync_payout_founder_ix(&vault, &fx)], "sync");
    assert_eq!(events::<PayoutFounderSynced>(&logs).len(), 1);
    assert_eq!(w.load::<PayoutVault>(&vault).founder, b.pubkey());
    let logs = w.send(&[], &[sync_payout_founder_ix(&vault, &fx)], "again");
    assert!(events::<PayoutFounderSynced>(&logs).is_empty());
}

#[test]
fn registration_recovery_is_the_documented_timelock_gap_for_issuers_without_assets() {
    // A Verified issuer with NO asset: the super admin alone flips KYB and
    // re-assigns the registration at once (no 7-day notice), and a dormant
    // grant revives when the registration returns to its key. Both are the
    // super-admin trust assumption documented on `recover_issuer_registration`.
    let mut w = World::boot();
    let a = w.funded();
    let c = w.funded();
    let admin = w.admin.insecure_clone();
    let issuer = w.register(&a, legal_id(4));
    w.set_kyb(&issuer, true);
    w.grant(&issuer, asset_registry::ISSUER_PERMISSION_MINT);
    w.set_kyb(&issuer, false);
    w.send(
        &[&admin, &c],
        &[recover_registration_ix(
            &admin.pubkey(),
            &issuer,
            &c.pubkey(),
        )],
        "-> C without a timelock",
    );
    assert_eq!(w.load::<Issuer>(&issuer).authority, c.pubkey());
    w.send(
        &[&admin, &a],
        &[recover_registration_ix(
            &admin.pubkey(),
            &issuer,
            &a.pubkey(),
        )],
        "-> A without a timelock",
    );
    assert_eq!(
        w.load::<IssuerPermissions>(&permissions_pda(&issuer, &a.pubkey()))
            .capabilities,
        asset_registry::ISSUER_PERMISSION_MINT,
        "A's dormant grant is live again: the super admin must re-check it"
    );

    // With an asset the same flip cannot move the key: only the timelock can.
    let Scene { mut w, b, fx, .. } = scene();
    let admin = w.admin.insecure_clone();
    w.set_kyb(&fx.issuer, false);
    w.expect_code(
        &[&admin, &b],
        &[recover_registration_ix(
            &admin.pubkey(),
            &fx.issuer,
            &b.pubkey(),
        )],
        ERR_NOT_RECOVERABLE,
        "registration recovery of an issuer with an asset",
    );
}
