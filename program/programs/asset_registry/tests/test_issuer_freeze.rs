//! D1 — freeze the proceeds of one issuer, and the payee / payer blocklist on
//! the proceeds and primary-sale paths (design 8.3 §3, §8.1, §14.1, §14.2) —
//! LiteSVM over the real SBPF v3 build.
//!
//! * any Admin (or the super admin) freezes; only the super admin unfreezes,
//!   the rent back to the freezer; a second freeze fails; a lamports-only
//!   pre-fund of the address freezes nothing;
//! * a live freeze closes `close_sale`, `open_payout_vault`,
//!   `release_payout`, `claim_founder_yield`, `buy` and `open_sale` of THAT
//!   issuer (6143), after the pause (6000) and the chain checks (6001), and
//!   before the payee BlockEntry (6144);
//! * the payer / payee BlockEntry (`["blocked", wallet]` under the hook) must
//!   be unset: buyer, sale authority, proceeds destination owner, founder.

#[path = "../../../tests/support/issuer.rs"]
mod issuer;
#[path = "../../../tests/support/market.rs"]
mod market;
#[path = "../../../tests/support/sale_approval.rs"]
mod sale_approval;
#[path = "../../../tests/support/mod.rs"]
mod support;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize,
    },
    asset_registry::{
        IssuerFreeze, IssuerProceedsFrozen, IssuerProceedsUnfrozen, PayoutVault, RaiseType, Sale,
        SaleStatus,
    },
    issuer::*,
    market::*,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const ERR_PAUSED: u32 = 6000;
const ERR_FROZEN: u32 = 6143;
const ERR_BLOCKED: u32 = 6144;

/// A verified issuer A (authority `a`) with a market, a Mature sale (9) with
/// proceeds, a Startup sale (10) with proceeds, and a Startup payout vault
/// (sale 11) whose first tranche is due, update posted, with founder yield.
struct Proceeds {
    w: World,
    a: Keypair,
    fx: Fixture,
    m: Market,
    mature: Pubkey,
    startup: Pubkey,
    vault: Pubkey,
    a_dest: Pubkey,
}

fn proceeds() -> Proceeds {
    let mut w = World::boot();
    w.init_blocklist_authority();
    let a = w.funded();
    let fx = w.issuer_with_asset(&a, legal_id(1));
    let m = market(&mut w, &fx);
    let mature = sale(&mut w, &a, &fx, &m, 9, RaiseType::Mature, 50);
    let startup = sale(&mut w, &a, &fx, &m, 10, RaiseType::Startup, 50);
    let vaulted = sale(&mut w, &a, &fx, &m, 11, RaiseType::Startup, 120);
    w.send(
        &[&a],
        &[open_payout_vault_ix(&w, &a.pubkey(), &vaulted, &m)],
        "open vault 11",
    );
    let vault = payout_pda(&vaulted);
    w.send(&[&a], &[post_update_ix(&a.pubkey(), &vault)], "post_update");
    route_yield(&mut w, &vault, &m);
    let a_dest = ata(&mut w, &m.payment_mint, &a.pubkey());
    Proceeds {
        w,
        a,
        fx,
        m,
        mature,
        startup,
        vault,
        a_dest,
    }
}

fn frozen(w: &World, issuer: &Pubkey) -> IssuerFreeze {
    let account = w
        .svm
        .get_account(&issuer_freeze_pda(issuer))
        .expect("freeze");
    IssuerFreeze::try_deserialize(&mut account.data.as_slice()).expect("decode")
}

/// A second verified issuer B with its own Mature sale (1) carrying proceeds.
fn second_issuer(w: &mut World) -> (Keypair, Fixture, Market, Pubkey) {
    let b = w.funded();
    let fx = w.issuer_with_asset(&b, legal_id(2));
    let m = market(w, &fx);
    let s = sale(w, &b, &fx, &m, 1, RaiseType::Mature, 20);
    (b, fx, m, s)
}

/// Every proceeds exit of issuer A plus `buy` / `open_sale`, as built right now.
fn exits(p: &mut Proceeds) -> Vec<(&'static str, Keypair, Instruction)> {
    let a = k(&p.a);
    let buy_ix = {
        // `buy` from the Mature sale (still open).
        let extra_metas = Pubkey::find_program_address(
            &[transfer_hook::EXTRA_METAS_SEED, p.fx.mint.as_ref()],
            &transfer_hook::id(),
        )
        .0;
        buy_ix(&p.fx, &p.m, &p.mature, 1, extra_metas)
    };
    if p.w
        .svm
        .get_account(&sale_approval::sale_approval_pda(&p.fx.share_class, 12))
        .is_none()
    {
        approve(&mut p.w, &p.fx, &p.m, 12, RaiseType::Mature);
    }
    vec![
        // `buy` first: the second pass closes the Mature sale right after.
        ("buy", k(&p.m.buyer), buy_ix),
        (
            "close_sale",
            k(&a),
            close_sale_ix(&p.w, &a.pubkey(), &p.mature, &p.m, &p.a_dest),
        ),
        (
            "open_payout_vault",
            k(&a),
            open_payout_vault_ix(&p.w, &a.pubkey(), &p.startup, &p.m),
        ),
        (
            "release_payout",
            k(&p.w.fees),
            release_ix(&p.w, &p.vault, &p.m, &p.a_dest),
        ),
        (
            "claim_founder_yield",
            k(&a),
            claim_founder_yield_ix(&p.w, &a.pubkey(), &p.vault, &p.m, &p.a_dest),
        ),
        (
            "open_sale",
            k(&a),
            open_sale_ix(&p.w, &a.pubkey(), &p.fx, &p.m, 12, RaiseType::Mature),
        ),
    ]
}

fn buy_ix(fx: &Fixture, m: &Market, sale: &Pubkey, units: u64, extra_metas: Pubkey) -> Instruction {
    use anchor_lang::{solana_program::instruction::AccountMeta, InstructionData, ToAccountMetas};
    let mut metas = asset_registry::accounts::Buy {
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
    Instruction::new_with_bytes(
        asset_registry::ID,
        &asset_registry::instruction::Buy { amount: units }.data(),
        metas,
    )
}

/// `ix` with every account meta keyed `from` re-pointed at `to`.
fn swap(mut ix: Instruction, from: &Pubkey, to: &Pubkey) -> Instruction {
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

// ── §14.1.1-2: who freezes, the account, the event ──────────────────────────

#[test]
fn any_admin_or_the_super_admin_freezes_once_and_the_event_names_it() {
    let mut w = World::boot();
    let a = w.funded();
    let fx = w.issuer_with_asset(&a, legal_id(1));
    let stranger = w.funded();
    let err = w.try_freeze(&stranger, &fx.issuer).unwrap_err();
    assert!(err.contains("Custom(6001)"), "a random key: {err}");

    let admin = w.funded();
    w.grant_admin(&admin);
    let logs = w.try_freeze(&admin, &fx.issuer).expect("an Admin freezes");
    assert_eq!(w.data_len(&issuer_freeze_pda(&fx.issuer)), 114);
    let f = frozen(&w, &fx.issuer);
    assert_eq!(f.issuer, fx.issuer);
    assert_eq!(f.frozen_by, admin.pubkey());
    assert_eq!(f.frozen_at, w.now());
    assert_eq!(f.reason_hash, [5u8; 32]);
    let ev = events::<IssuerProceedsFrozen>(&logs);
    assert_eq!(ev.len(), 1);
    assert_eq!(
        (ev[0].issuer, ev[0].frozen_by, ev[0].reason_hash),
        (fx.issuer, admin.pubkey(), [5u8; 32])
    );

    // A second freeze never overwrites the first freezer or reason.
    let super_admin = w.admin.insecure_clone();
    let err = w.try_freeze(&super_admin, &fx.issuer).unwrap_err();
    assert!(err.contains("Custom(0)"), "account already in use: {err}");
    assert_eq!(frozen(&w, &fx.issuer).frozen_by, admin.pubkey());

    // The super admin needs no Admin record of its own.
    let b = w.funded();
    let fx_b = w.issuer_with_asset(&b, legal_id(2));
    let record = admin_pda(&super_admin.pubkey());
    let mut gone = w.svm.get_account(&record).unwrap();
    gone.lamports = 0;
    gone.data = vec![];
    gone.owner = system_program::ID;
    w.svm.set_account(record, gone).unwrap();
    w.try_freeze(&super_admin, &fx_b.issuer)
        .expect("the super admin freezes without an Admin record");
    assert_eq!(frozen(&w, &fx_b.issuer).frozen_by, super_admin.pubkey());
}

// ── §14.1.3-4, 6: every exit of the frozen issuer only; unfreeze reopens ────

#[test]
fn a_freeze_closes_every_proceeds_exit_of_that_issuer_only_until_the_super_admin_unfreezes() {
    let mut p = proceeds();
    let (b, _fx_b, m_b, sale_b) = second_issuer(&mut p.w);
    let b_dest = ata(&mut p.w, &m_b.payment_mint, &b.pubkey());
    let admin = p.w.funded();
    p.w.grant_admin(&admin);
    p.w.try_freeze(&admin, &p.fx.issuer).expect("freeze A");

    for (label, signer, ix) in exits(&mut p) {
        p.w.expect_code(&[&signer], &[ix], ERR_FROZEN, label);
    }
    // Issuer B is untouched.
    let close_b = close_sale_ix(&p.w, &b.pubkey(), &sale_b, &m_b, &b_dest);
    p.w.send(&[&b], &[close_b], "B's close_sale");
    assert_eq!(p.w.load::<Sale>(&sale_b).status, SaleStatus::Closed);

    // Only the super admin unfreezes; the rent goes back to the freezer.
    let unfreeze = unfreeze_issuer_ix(&admin.pubkey(), &p.fx.issuer, &admin.pubkey());
    p.w.expect_code(&[&admin], &[unfreeze], 6001, "an Admin unfreezes");
    let rent = p.w.lamports(&issuer_freeze_pda(&p.fx.issuer));
    let freezer_before = p.w.lamports(&admin.pubkey());
    let super_admin = p.w.admin.insecure_clone();
    let logs = p.w.send(
        &[&super_admin],
        &[unfreeze_issuer_ix(
            &super_admin.pubkey(),
            &p.fx.issuer,
            &admin.pubkey(),
        )],
        "unfreeze",
    );
    assert!(p.w.is_closed(&issuer_freeze_pda(&p.fx.issuer)));
    assert_eq!(p.w.lamports(&admin.pubkey()), freezer_before + rent);
    let ev = events::<IssuerProceedsUnfrozen>(&logs);
    assert_eq!(
        (ev[0].issuer, ev[0].unfrozen_by, ev[0].frozen_by),
        (p.fx.issuer, super_admin.pubkey(), admin.pubkey())
    );

    // Every exit works again.
    for (label, signer, ix) in exits(&mut p) {
        p.w.send(&[&signer], &[ix], label);
    }
    assert_eq!(p.w.load::<Sale>(&p.mature).status, SaleStatus::Closed);
    assert_eq!(p.w.load::<PayoutVault>(&p.vault).tranches_released, 1);
}

// ── §14.1.5, 7, 8: addresses, pre-fund, order ────────────────────────────────

#[test]
fn the_freeze_address_is_pinned_a_prefund_freezes_nothing_and_the_pause_comes_first() {
    let mut p = proceeds();
    let (_b, fx_b, _m_b, _sale_b) = second_issuer(&mut p.w);
    let a = k(&p.a);

    // Another issuer's freeze PDA -> seeds constraint.
    let close = close_sale_ix(&p.w, &a.pubkey(), &p.mature, &p.m, &p.a_dest);
    let foreign = swap(
        close.clone(),
        &issuer_freeze_pda(&p.fx.issuer),
        &issuer_freeze_pda(&fx_b.issuer),
    );
    p.w.expect_code(
        &[&a],
        &[foreign],
        ERR_CONSTRAINT_SEEDS,
        "foreign freeze PDA",
    );
    // A share class other than the sale's -> Unauthorized (address constraint).
    let other_class = swap(close.clone(), &p.fx.share_class, &fx_b.share_class);
    p.w.expect_code(&[&a], &[other_class], 6001, "foreign share class");

    // A lamports-only pre-fund of the freeze PDA freezes nothing …
    let freeze = issuer_freeze_pda(&p.fx.issuer);
    let grief = p.w.svm.minimum_balance_for_rent_exemption(0);
    p.w.svm.airdrop(&freeze, grief).unwrap();
    let release = release_ix(&p.w, &p.vault, &p.m, &p.a_dest);
    p.w.send(&[], &[release], "release with a pre-funded freeze PDA");
    // … and a later freeze still initializes over it.
    let super_admin = p.w.admin.insecure_clone();
    p.w.try_freeze(&super_admin, &p.fx.issuer)
        .expect("freeze over a pre-fund");
    assert_eq!(p.w.data_len(&freeze), 114);

    // Order: the pause (6000) before the freeze (6143).
    p.w.set_pause(asset_registry::PAUSE_ISSUER_PROCEEDS, 0);
    p.w.expect_code(&[&a], &[close], ERR_PAUSED, "paused and frozen");
}

// ── §14.1.9 + §14.2.4-5: payee / payer BlockEntries on the proceeds paths ───

#[test]
fn blocked_payees_are_refused_on_every_proceeds_exit_and_the_freeze_is_checked_first() {
    let mut p = proceeds();
    let a = k(&p.a);
    // Founder A blocked: release_payout / claim_founder_yield / close_sale.
    p.w.block(&a.pubkey());
    let release = release_ix(&p.w, &p.vault, &p.m, &p.a_dest);
    p.w.expect_code(
        &[],
        std::slice::from_ref(&release),
        ERR_BLOCKED,
        "release to a blocked founder",
    );
    let claim = claim_founder_yield_ix(&p.w, &a.pubkey(), &p.vault, &p.m, &p.a_dest);
    p.w.expect_code(
        &[&a],
        std::slice::from_ref(&claim),
        ERR_BLOCKED,
        "blocked founder claims",
    );
    let close = close_sale_ix(&p.w, &a.pubkey(), &p.mature, &p.m, &p.a_dest);
    p.w.expect_code(
        &[&a],
        std::slice::from_ref(&close),
        ERR_BLOCKED,
        "blocked sale authority",
    );

    // Frozen AND blocked: the freeze answers first.
    let super_admin = p.w.admin.insecure_clone();
    p.w.try_freeze(&super_admin, &p.fx.issuer).unwrap();
    p.w.expect_code(
        &[],
        std::slice::from_ref(&release),
        ERR_FROZEN,
        "freeze before BlockEntry",
    );
    p.w.send(
        &[&super_admin],
        &[unfreeze_issuer_ix(
            &super_admin.pubkey(),
            &p.fx.issuer,
            &super_admin.pubkey(),
        )],
        "unfreeze",
    );

    // Unblocked: both exits pay again.
    p.w.unblock(&a.pubkey());
    p.w.send(&[], &[release], "release after unblock");
    p.w.send(&[&a], &[claim], "claim after unblock");

    // close_sale: the destination OWNER is checked too, not only the signer.
    let other = p.w.funded();
    let other_dest = ata(&mut p.w, &p.m.payment_mint, &other.pubkey());
    p.w.block(&other.pubkey());
    let to_blocked = close_sale_ix(&p.w, &a.pubkey(), &p.mature, &p.m, &other_dest);
    p.w.expect_code(
        &[&a],
        &[to_blocked],
        ERR_BLOCKED,
        "blocked destination owner",
    );
    p.w.send(&[&a], &[close], "close to A");
}

#[test]
fn a_blocked_buyer_cannot_buy_and_the_payment_account_is_the_buyers_own() {
    let mut w = World::boot();
    w.init_blocklist_authority();
    let a = w.funded();
    let fx = w.issuer_with_asset(&a, legal_id(1));
    let m = market(&mut w, &fx);
    let s = sale(&mut w, &a, &fx, &m, 1, RaiseType::Mature, 0);
    let extra = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, fx.mint.as_ref()],
        &transfer_hook::id(),
    )
    .0;
    let buyer = k(&m.buyer);
    let ix = buy_ix(&fx, &m, &s, 1, extra);

    w.block(&buyer.pubkey());
    w.expect_code(
        &[&buyer],
        std::slice::from_ref(&ix),
        ERR_BLOCKED,
        "blocked buyer",
    );
    // A wrong BlockEntry address: seeds constraint.
    let wrong = swap(
        ix.clone(),
        &block_entry_pda(&buyer.pubkey()),
        &block_entry_pda(&a.pubkey()),
    );
    w.expect_code(
        &[&buyer],
        &[wrong],
        ERR_CONSTRAINT_SEEDS,
        "wrong BlockEntry PDA",
    );
    w.unblock(&buyer.pubkey());
    w.send(&[&buyer], std::slice::from_ref(&ix), "buy after unblock");

    // A lamports-only pre-fund of a BlockEntry blocks nobody.
    let fresh = w.funded();
    let fresh_pay = ata(&mut w, &m.payment_mint, &fresh.pubkey());
    mint_payment(&mut w, &m.payment_mint, &fresh_pay, 1_000);
    let fresh_share = ata(&mut w, &fx.mint, &fresh.pubkey());
    let grief = w.svm.minimum_balance_for_rent_exemption(0);
    w.svm
        .airdrop(&block_entry_pda(&fresh.pubkey()), grief)
        .unwrap();
    let fm = Market {
        payment_mint: m.payment_mint,
        buyer: k(&fresh),
        buyer_pay: fresh_pay,
        buyer_share: fresh_share,
    };
    w.send(
        &[&fresh],
        &[buy_ix(&fx, &fm, &s, 1, extra)],
        "pre-funded BlockEntry",
    );

    // O-8: the payment account must be the buyer's own.
    let foreign_pay = Market {
        payment_mint: m.payment_mint,
        buyer: k(&fresh),
        buyer_pay: m.buyer_pay,
        buyer_share: fresh_share,
    };
    w.expect_code(
        &[&fresh],
        &[buy_ix(&fx, &foreign_pay, &s, 1, extra)],
        6001,
        "somebody else's payment account",
    );
}
