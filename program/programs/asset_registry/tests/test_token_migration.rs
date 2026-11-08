//! Token migration, program V2 (LiteSVM, real SPL Token / Token-2022
//! transfers through the transfer hook).
//!
//! A legacy token that lives on Solana is swapped into share-class units with
//! no operator in the delivery path: the issuer funds a vault with exactly
//! `units_cap` units, holders deposit whole lots of the old token into an
//! escrow during the window, each depositor claims one unit per lot after it,
//! off-chain locks claim against one Merkle root, and the close returns every
//! unclaimed unit to `return_to`, burns the escrowed old tokens and closes the
//! vault, the escrow and the identity (rent to the creating Admin).
//!
//! Proven here, with exact balances on the escrow, the vault, the holders and
//! `return_to`:
//!   * the full lifecycle with an SPL Token old mint and with a Token-2022 old
//!     mint (permitted extensions), including the Merkle path;
//!   * a KycGated share class: the funding leg rides the vault's identity,
//!     claims are KYC-checked, a raw push into the vault reaches `return_to`
//!     only with its KYC (the escrow-release rule), the rest needs none;
//!   * every gate: signers and the double gate, terms and window bounds, the
//!     old-mint policy, the cap, whole lots, the window, the custody-entry
//!     pause (exits stay open), the holder blocklist, double claims, double
//!     proof claims, bad proofs, the root's total, claims before finalize,
//!     refunds without cancel, cancels after the window or a claim, and a
//!     close before the deadline or with deposits outstanding.
//!
//! Compute units of every instruction are printed (`--nocapture`, "CU").

#[path = "../../../tests/support/issuer.rs"]
mod issuer;
#[path = "../../../tests/support/migration.rs"]
mod migration;
#[path = "../../../tests/support/mod.rs"]
mod support;
#[path = "../../../tests/support/v1.rs"]
mod v1;

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        system_program,
    },
    InstructionData, ToAccountMetas,
};
use asset_registry::{
    util::{merkle_parent, snapshot_leaf},
    EscrowIdentity, Migration, MigrationClaimed, MigrationClosed, MigrationCreated,
    MigrationDeposit, MigrationDeposited, MigrationProofClaim, MigrationProofClaimed,
    MigrationStatus,
};
use issuer::*;
use migration::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use spl_token_2022_interface::instruction as token_ix;

const TREASURY: u64 = 10_000;

const E_PAUSED: u32 = 6000;
const E_UNAUTHORIZED: u32 = 6001;
const E_INVALID_MERKLE_PROOF: u32 = 6030;
const E_OVERFLOW: u32 = 6035;
const E_NOTHING_TO_CLAIM: u32 = 6047;
const E_RECEIVER_NOT_APPROVED: u32 = 6069;
const E_INVALID_DEPOSIT_AMOUNT: u32 = 6085;
const E_UNSUPPORTED_MINT_EXTENSION: u32 = 6115;
const E_PARTY_BLOCKLISTED: u32 = 6144;
const E_TERMS: u32 = 6156;
const E_WINDOW: u32 = 6157;
const E_STATUS: u32 = 6158;
const E_UNDERFUNDED: u32 = 6159;
const E_CAP_EXCEEDED: u32 = 6160;
const E_ALLOCATION_EXCEEDED: u32 = 6161;
const E_OUTSIDE_WINDOW: u32 = 6162;
const E_WINDOW_NOT_CLOSED: u32 = 6163;
const E_NOT_CANCELLABLE: u32 = 6164;
const E_NOT_CLOSABLE: u32 = 6165;
const E_DEPOSIT_SETTLED: u32 = 6166;
const E_ROOT_ALREADY_PUBLISHED: u32 = 6167;
const E_ROOT_MISSING: u32 = 6168;
const E_ROOT_EXCEEDED: u32 = 6169;
const E_CLAIM_DEADLINE_PASSED: u32 = 6170;
/// Anchor `AccountNotInitialized` (a missing Admin record or deposit).
const E_NOT_INITIALIZED: u32 = 3012;

// ── Fixture ──────────────────────────────────────────────────────────────────

/// A booted platform and an issuer whose authority (`issuer_key`, also a
/// platform Admin so it may mint to its own treasury) holds `TREASURY` units
/// of share class 0 in `treasury`. `w.admin` is the other key of the double
/// gate.
struct Setup {
    w: World,
    issuer_key: Keypair,
    fx: Fixture,
    treasury: Pubkey,
}

fn setup() -> Setup {
    let mut w = World::boot();
    let issuer_key = w.funded();
    w.grant_admin(&issuer_key);
    let fx = w.issuer_with_asset(&issuer_key, legal_id(1));
    let treasury = ata(&mut w, &fx.mint, &issuer_key.pubkey(), &TOKEN_2022);
    let mint = mint_to_treasury_ix(&issuer_key.pubkey(), &fx, &treasury, TREASURY);
    w.send(&[&issuer_key], &[mint], "mint_to_treasury");
    Setup {
        w,
        issuer_key,
        fx,
        treasury,
    }
}

struct Holder {
    key: Keypair,
    old: Pubkey,
    share: Pubkey,
}

/// A funded wallet with `old_amount` old tokens and an (empty) share account.
fn holder(s: &mut Setup, m: &Mig, old_amount: u64) -> Holder {
    let key = s.w.funded();
    let old = ata(&mut s.w, &m.old_mint, &key.pubkey(), &m.old_program);
    if old_amount > 0 {
        mint_old(&mut s.w, &m.old_mint, &m.old_program, &old, old_amount);
    }
    let share = ata(&mut s.w, &s.fx.mint, &key.pubkey(), &TOKEN_2022);
    Holder { key, old, share }
}

fn admin(s: &Setup) -> Keypair {
    s.w.admin.insecure_clone()
}

fn create(s: &mut Setup, t: &Terms, old_mint: Pubkey, old_program: Pubkey) -> Mig {
    let a = admin(s);
    let m = Mig::new(&s.fx, t, old_mint, old_program, a.pubkey());
    let ix = create_ix(
        &a.pubkey(),
        &s.issuer_key.pubkey(),
        &s.fx,
        &old_mint,
        &old_program,
        t,
    );
    s.w.send(&[&a, &s.issuer_key], &[ix], "create_migration");
    m
}

fn fund(s: &mut Setup, m: &Mig, units: u64) {
    let tail = open_tail(&s.fx.mint, &s.issuer_key.pubkey());
    let ix = fund_ix(&s.issuer_key.pubkey(), m, &s.treasury, units, tail);
    s.w.send(&[&s.issuer_key], &[ix], "fund_migration");
}

fn open(s: &mut Setup, m: &Mig) {
    let a = admin(s);
    s.w.send(&[&a], &[open_ix(&a.pubkey(), m)], "open_migration");
}

/// create + fund the whole cap + open.
fn launch(s: &mut Setup, t: &Terms, old_mint: Pubkey, old_program: Pubkey) -> Mig {
    let m = create(s, t, old_mint, old_program);
    fund(s, &m, t.units_cap);
    open(s, &m);
    m
}

fn deposit(s: &mut Setup, m: &Mig, h: &Holder, lots: u64) {
    let ix = deposit_ix(&h.key.pubkey(), m, &h.old, lots);
    s.w.send(&[&h.key], &[ix], "deposit_migration");
}

fn claim(s: &mut Setup, m: &Mig, h: &Holder) -> Result<Vec<String>, String> {
    let tail = open_tail(&s.fx.mint, &m.migration);
    let ix = claim_ix(&h.key.pubkey(), m, &h.share, tail);
    s.w.try_send(&[&h.key], &[ix])
}

fn state(s: &Setup, m: &Mig) -> Migration {
    s.w.load::<Migration>(&m.migration)
}

/// Rent of the three accounts the close returns (vault, escrow, identity).
fn closable_rent(s: &Setup, m: &Mig) -> u64 {
    s.w.lamports(&m.vault()) + s.w.lamports(&m.escrow()) + s.w.lamports(&m.identity())
}

fn report(label: &str, cu: u64) {
    println!("CU {label:<34} {cu:>7}");
    assert!(cu < 200_000, "{label}: {cu} CU");
}

fn expect_code(s: &mut Setup, signers: &[&Keypair], ixs: &[Instruction], code: u32, what: &str) {
    s.w.expect_code(signers, ixs, code, what);
}

/// A two-or-three-leaf sorted-pair tree: `(root, proofs)` for `(key, units)`.
fn tree(leaves: &[(Pubkey, u64)]) -> ([u8; 32], Vec<Vec<[u8; 32]>>) {
    let hashed: Vec<[u8; 32]> = leaves.iter().map(|(k, u)| snapshot_leaf(k, *u)).collect();
    match hashed.len() {
        2 => (
            merkle_parent(hashed[0], hashed[1]),
            vec![vec![hashed[1]], vec![hashed[0]]],
        ),
        3 => {
            let left = merkle_parent(hashed[0], hashed[1]);
            (
                merkle_parent(left, hashed[2]),
                vec![
                    vec![hashed[1], hashed[2]],
                    vec![hashed[0], hashed[2]],
                    vec![left],
                ],
            )
        }
        n => panic!("tree of {n} leaves"),
    }
}

// ── Happy paths ──────────────────────────────────────────────────────────────

/// The whole lifecycle with an SPL Token old mint: creation (both keys),
/// funding in two parts, opening, deposits (one holder twice), the window
/// closing, claims, and the close after the claim deadline — unclaimed units
/// back to `return_to`, every escrowed old token burned, the three accounts
/// closed with their rent back to the creating Admin.
#[test]
fn spl_old_mint_full_lifecycle_with_exact_balances_and_rent() {
    let mut s = setup();
    let old_mint = spl_mint(&mut s.w, 6);
    let lot = 1_000_000; // one whole old token per unit
    let t = Terms::standard(1, lot, 1_000, 100, s.issuer_key.pubkey());
    let a = admin(&s);
    let m = Mig::new(&s.fx, &t, old_mint, SPL_TOKEN, a.pubkey());
    let admin_lamports = s.w.lamports(&a.pubkey());

    let ix = create_ix(
        &a.pubkey(),
        &s.issuer_key.pubkey(),
        &s.fx,
        &old_mint,
        &SPL_TOKEN,
        &t,
    );
    let (logs, cu) = send_cu(&mut s.w, &[&a, &s.issuer_key], &[ix]).unwrap();
    report("create_migration (SPL old mint)", cu);
    let created = events::<MigrationCreated>(&logs);
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].migration, m.migration);
    assert_eq!(created[0].issuer_authority, s.issuer_key.pubkey());
    assert_eq!((created[0].lot, created[0].units_cap), (lot, 1_000));
    let mig = state(&s, &m);
    assert_eq!(mig.status, MigrationStatus::Draft);
    assert_eq!(
        (mig.share_class, mig.mint, mig.issuer),
        (s.fx.share_class, s.fx.mint, s.fx.issuer)
    );
    assert_eq!(
        (mig.admin, mig.old_mint, mig.old_token_program),
        (a.pubkey(), old_mint, SPL_TOKEN)
    );
    assert_eq!((mig.return_to, mig.terms_hash), (t.return_to, t.terms_hash));
    assert_eq!(
        (mig.opens_at, mig.closes_at, mig.claim_deadline),
        (t.opens_at, t.closes_at, t.claim_deadline)
    );
    assert_eq!(mig.merkle_root, None);
    assert_eq!(mig.version, asset_registry::MIGRATION_STATE_VERSION);
    // Both escrows are owned by the Migration PDA; the old one is a plain
    // SPL account, the vault a Token-2022 account the hook accepts.
    assert_eq!(s.w.token_owner(&m.escrow()), m.migration);
    assert_eq!(s.w.token_owner(&m.vault()), m.migration);
    assert_eq!(s.w.data_len(&m.escrow()), 165);
    let identity = s.w.load::<EscrowIdentity>(&m.identity());
    assert_eq!(identity.refund_owner, t.return_to);
    assert_eq!((identity.own_deposited, identity.own_refunded), (0, 0));
    // The creating Admin paid every rent.
    let rent = closable_rent(&s, &m) + s.w.lamports(&m.migration);
    assert_eq!(s.w.lamports(&a.pubkey()), admin_lamports - rent);

    // Funding: two parts, up to the cap exactly.
    for (units, total) in [(600, 600), (400, 1_000)] {
        let tail = open_tail(&s.fx.mint, &s.issuer_key.pubkey());
        let ix = fund_ix(&s.issuer_key.pubkey(), &m, &s.treasury, units, tail);
        let (_, cu) = send_cu(&mut s.w, &[&s.issuer_key], &[ix]).unwrap();
        report("fund_migration (Open class)", cu);
        assert_eq!(state(&s, &m).units_funded, total);
    }
    assert_eq!(balance(&s.w, &s.treasury), TREASURY - 1_000);
    assert_eq!(balance(&s.w, &m.vault()), 1_000);
    // The funder is `return_to`: every unit is on its refund ledger.
    assert_eq!(
        s.w.load::<EscrowIdentity>(&m.identity()).own_deposited,
        1_000
    );

    let (_, cu) = send_cu(&mut s.w, &[&a], &[open_ix(&a.pubkey(), &m)]).unwrap();
    report("open_migration", cu);
    assert_eq!(state(&s, &m).status, MigrationStatus::Open);

    let ha = holder(&mut s, &m, 7 * lot + 123);
    let hb = holder(&mut s, &m, 10 * lot);
    let hc = holder(&mut s, &m, lot);
    s.w.warp_to(t.opens_at);
    let ix = deposit_ix(&ha.key.pubkey(), &m, &ha.old, 3);
    let (logs, cu) = send_cu(&mut s.w, &[&ha.key], &[ix]).unwrap();
    report("deposit_migration (first, SPL)", cu);
    let deposited = events::<MigrationDeposited>(&logs);
    assert_eq!(
        (
            deposited[0].lots,
            deposited[0].amount,
            deposited[0].holder_lots
        ),
        (3, 3 * lot, 3)
    );
    let ix = deposit_ix(&ha.key.pubkey(), &m, &ha.old, 2);
    let (_, cu) = send_cu(&mut s.w, &[&ha.key], &[ix]).unwrap();
    report("deposit_migration (top-up, SPL)", cu);
    deposit(&mut s, &m, &hb, 10);
    deposit(&mut s, &m, &hc, 1);
    let record = s.w.load::<MigrationDeposit>(&m.deposit(&ha.key.pubkey()));
    assert_eq!(
        (record.migration, record.holder, record.lots),
        (m.migration, ha.key.pubkey(), 5)
    );
    assert!(!record.claimed && !record.refunded);
    assert_eq!(balance(&s.w, &ha.old), 2 * lot + 123);
    assert_eq!(balance(&s.w, &hb.old), 0);
    assert_eq!(balance(&s.w, &m.escrow()), 16 * lot);
    let mig = state(&s, &m);
    assert_eq!(
        (mig.units_committed, mig.lots_deposited, mig.units_claimed),
        (16, 16, 0)
    );

    // The window closes; anyone finalizes.
    s.w.warp_to(t.closes_at);
    let (_, cu) = send_cu(&mut s.w, &[], &[finalize_ix(&m)]).unwrap();
    report("finalize_migration", cu);
    assert_eq!(state(&s, &m).status, MigrationStatus::Claimable);

    let tail = open_tail(&s.fx.mint, &m.migration);
    let (logs, cu) = send_cu(
        &mut s.w,
        &[&ha.key],
        &[claim_ix(&ha.key.pubkey(), &m, &ha.share, tail)],
    )
    .unwrap();
    report("claim_migration (Open class)", cu);
    let claimed = events::<MigrationClaimed>(&logs);
    assert_eq!((claimed[0].units, claimed[0].units_claimed), (5, 5));
    claim(&mut s, &m, &hb).unwrap();
    assert_eq!(balance(&s.w, &ha.share), 5);
    assert_eq!(balance(&s.w, &hb.share), 10);
    assert_eq!(balance(&s.w, &m.vault()), 985);
    assert!(
        s.w.load::<MigrationDeposit>(&m.deposit(&hb.key.pubkey()))
            .claimed
    );
    // hc never claims: its unit goes back at the close.

    s.w.warp_to(t.claim_deadline);
    let rent = closable_rent(&s, &m);
    let before = s.w.lamports(&a.pubkey());
    let old_supply = supply(&s.w, &old_mint);
    let tail = open_tail(&s.fx.mint, &m.migration);
    let ix = close_ix(&a.pubkey(), &m, &s.treasury, tail);
    let (logs, cu) = send_cu(&mut s.w, &[&a], &[ix]).unwrap();
    report("close_migration (Open class)", cu);
    let closed = events::<MigrationClosed>(&logs);
    assert_eq!(closed.len(), 1);
    assert_eq!(
        (closed[0].units_returned, closed[0].old_burned),
        (985, 16 * lot)
    );
    assert_eq!(
        (closed[0].return_to, closed[0].rent_to),
        (t.return_to, a.pubkey())
    );
    assert_eq!(balance(&s.w, &s.treasury), TREASURY - 15);
    assert_eq!(supply(&s.w, &old_mint), old_supply - 16 * lot);
    for account in [m.vault(), m.escrow(), m.identity()] {
        assert!(s.w.is_closed(&account), "{account} closed");
    }
    assert_eq!(s.w.lamports(&a.pubkey()), before + rent);
    let mig = state(&s, &m);
    assert_eq!(mig.status, MigrationStatus::Closed);
    assert_eq!((mig.units_claimed, mig.units_committed), (15, 16));
    // The unclaimed deposit stays on record, unclaimed.
    assert!(
        !s.w.load::<MigrationDeposit>(&m.deposit(&hc.key.pubkey()))
            .claimed
    );
    // A closed migration takes nothing more.
    let ix = deposit_ix(&hc.key.pubkey(), &m, &hc.old, 1);
    assert!(s.w.try_send(&[&hc.key], &[ix]).is_err());
}

/// A Token-2022 old mint with every permitted extension (metadata pointer,
/// DefaultAccountState Initialized, mint close authority), and the off-chain
/// path: the root is published (both keys) once the window closed, two
/// lockers claim with proofs, a depositor claims, and the close returns the
/// rest.
#[test]
fn token2022_old_mint_lifecycle_with_the_merkle_path() {
    let mut s = setup();
    let old_mint = t22_mint(
        &mut s.w,
        9,
        &[
            Ext::MetadataPointer,
            Ext::DefaultInitialized,
            Ext::MintCloseAuthority,
        ],
    );
    let lot = 2_500;
    let t = Terms::standard(7, lot, 500, 0, s.issuer_key.pubkey());
    let m = launch(&mut s, &t, old_mint, TOKEN_2022);
    // The old-token escrow is a Token-2022 account with ImmutableOwner.
    assert_eq!(s.w.data_len(&m.escrow()), 170);

    let depositor = holder(&mut s, &m, 100 * lot);
    let ix = deposit_ix(&depositor.key.pubkey(), &m, &depositor.old, 100);
    let (_, cu) = send_cu(&mut s.w, &[&depositor.key], &[ix]).unwrap();
    report("deposit_migration (first, T22)", cu);
    assert_eq!(balance(&s.w, &m.escrow()), 100 * lot);

    s.w.warp_to(t.closes_at);
    s.w.send(&[], &[finalize_ix(&m)], "finalize_migration");

    let l1 = s.w.funded();
    let l2 = s.w.funded();
    let l1_share = ata(&mut s.w, &s.fx.mint, &l1.pubkey(), &TOKEN_2022);
    let l2_share = ata(&mut s.w, &s.fx.mint, &l2.pubkey(), &TOKEN_2022);
    let (root, proofs) = tree(&[(l1.pubkey(), 40), (l2.pubkey(), 60)]);
    let a = admin(&s);
    let ix = publish_ix(&a.pubkey(), &s.issuer_key.pubkey(), &m, root, 100);
    let (_, cu) = send_cu(&mut s.w, &[&a, &s.issuer_key], &[ix]).unwrap();
    report("publish_migration_root", cu);
    let mig = state(&s, &m);
    assert_eq!(
        (mig.merkle_root, mig.merkle_total, mig.units_committed),
        (Some(root), 100, 200)
    );

    let tail = open_tail(&s.fx.mint, &m.migration);
    let ix = claim_proof_ix(
        &l1.pubkey(),
        &m,
        &l1_share,
        40,
        proofs[0].clone(),
        tail.clone(),
    );
    let (logs, cu) = send_cu(&mut s.w, &[&l1], &[ix]).unwrap();
    report("claim_migration_proof (Open class)", cu);
    let claimed = events::<MigrationProofClaimed>(&logs);
    assert_eq!(
        (
            claimed[0].units,
            claimed[0].merkle_claimed,
            claimed[0].units_claimed
        ),
        (40, 40, 40)
    );
    let record =
        s.w.load::<MigrationProofClaim>(&mig_claim_pda(&m.migration, &l1.pubkey()));
    assert_eq!(
        (record.migration, record.claimer, record.units),
        (m.migration, l1.pubkey(), 40)
    );
    let ix = claim_proof_ix(&l2.pubkey(), &m, &l2_share, 60, proofs[1].clone(), tail);
    s.w.send(&[&l2], &[ix], "second proof claim");
    claim(&mut s, &m, &depositor).unwrap();
    assert_eq!(balance(&s.w, &l1_share), 40);
    assert_eq!(balance(&s.w, &l2_share), 60);
    assert_eq!(balance(&s.w, &depositor.share), 100);
    assert_eq!(balance(&s.w, &m.vault()), 300);
    let mig = state(&s, &m);
    assert_eq!((mig.merkle_claimed, mig.units_claimed), (100, 200));

    s.w.warp_to(t.claim_deadline);
    let old_supply = supply(&s.w, &old_mint);
    let tail = open_tail(&s.fx.mint, &m.migration);
    s.w.send(
        &[&a],
        &[close_ix(&a.pubkey(), &m, &s.treasury, tail)],
        "close_migration",
    );
    assert_eq!(balance(&s.w, &s.treasury), TREASURY - 200);
    assert_eq!(supply(&s.w, &old_mint), old_supply - 100 * lot);
    assert!(s.w.is_closed(&m.escrow()) && s.w.is_closed(&m.vault()));
    assert_eq!(state(&s, &m).status, MigrationStatus::Closed);
}

// ── KycGated share class ─────────────────────────────────────────────────────

/// KYC registry + BlocklistAuthority (both the super admin), then the class
/// flips to KycGated. Returns the registry.
fn kyc_gate(s: &mut Setup) -> Pubkey {
    let a = admin(s);
    s.w.init_blocklist_authority();
    let registry = Pubkey::find_program_address(
        &[asset_registry::KYC_REGISTRY_SEED, a.pubkey().as_ref()],
        &asset_registry::ID,
    )
    .0;
    s.w.send(
        &[&a],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &asset_registry::instruction::CreateKycRegistry {
                approved_jurisdictions: [0xFF; 128],
                blocked_jurisdictions: [0; 128],
            }
            .data(),
            asset_registry::accounts::CreateKycRegistry {
                authority: a.pubkey(),
                admin_authority: a.pubkey(),
                admin_record: admin_pda(&a.pubkey()),
                kyc_registry: registry,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "create_kyc_registry",
    );
    let mint = s.fx.mint;
    s.w.send(
        &[&a],
        &[Instruction::new_with_bytes(
            transfer_hook::ID,
            &transfer_hook::instruction::UpdateTransferHookConfig {
                restriction_mode: transfer_hook::RestrictionMode::KycGated,
                kyc_registry: Some(registry),
            }
            .data(),
            transfer_hook::accounts::UpdateTransferHookConfig {
                authority: a.pubkey(),
                blocklist_authority: blocklist_authority_pda(),
                mint,
                config: hook_config_pda(&mint),
                extra_account_meta_list: extra_metas_pda(&mint),
                system_program: system_program::ID,
                kyc_registry_account: Some(registry),
            }
            .to_account_metas(None),
        )],
        "flip the class to KycGated",
    );
    registry
}

fn approve(s: &mut Setup, registry: &Pubkey, wallet: &Pubkey) {
    let a = admin(s);
    s.w.send(
        &[&a],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &asset_registry::instruction::ApproveHolder {
                holder: *wallet,
                jurisdiction: 222,
                accreditation_level: 1,
                expiry: asset_registry::MAX_KYC_VALIDITY_SECS,
                provider_id: 1,
                external_ref_hash: [5u8; 32],
            }
            .data(),
            asset_registry::accounts::ApproveHolder {
                authority: a.pubkey(),
                kyc_registry: *registry,
                kyc_entry: kyc_entry_pda(registry, wallet),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "approve_holder",
    );
}

/// A KycGated class: the funding leg is exempt through the vault's identity
/// (the vault holds no KYC), a claim needs the holder's KYC (refused without
/// it, paid once approved), and at the close the units `return_to` funded
/// itself go back with no KYC while a unit somebody pushed into the vault
/// raw is a delivery: the close fails with the KYC error until `return_to`
/// is approved, then returns everything.
#[test]
fn kyc_gated_class_claims_need_kyc_and_a_raw_surplus_needs_return_to_kyc() {
    let mut s = setup();
    let registry = kyc_gate(&mut s);
    let old_mint = spl_mint(&mut s.w, 0);
    let t = Terms::standard(3, 1, 300, 0, s.issuer_key.pubkey());
    let m = create(&mut s, &t, old_mint, SPL_TOKEN);
    let tail = kyc_tail(&s.fx.mint, &registry, &s.issuer_key.pubkey(), &m.migration);
    let ix = fund_ix(&s.issuer_key.pubkey(), &m, &s.treasury, 300, tail);
    let (_, cu) = send_cu(&mut s.w, &[&s.issuer_key], &[ix]).unwrap();
    report("fund_migration (KycGated class)", cu);
    assert_eq!(balance(&s.w, &m.vault()), 300);
    open(&mut s, &m);

    let approved = holder(&mut s, &m, 50);
    let unapproved = holder(&mut s, &m, 50);
    approve(&mut s, &registry, &approved.key.pubkey());
    // Depositing needs no KYC (holding needs none).
    deposit(&mut s, &m, &approved, 50);
    deposit(&mut s, &m, &unapproved, 20);
    s.w.warp_to(t.closes_at);
    s.w.send(&[], &[finalize_ix(&m)], "finalize_migration");

    let mint = s.fx.mint;
    let kyc_claim = |h: &Holder| {
        let tail = kyc_tail(&mint, &registry, &m.migration, &h.key.pubkey());
        claim_ix(&h.key.pubkey(), &m, &h.share, tail)
    };
    let ix = kyc_claim(&approved);
    let (_, cu) = send_cu(&mut s.w, &[&approved.key], &[ix]).unwrap();
    report("claim_migration (KycGated class)", cu);
    assert_eq!(balance(&s.w, &approved.share), 50);
    let ix = kyc_claim(&unapproved);
    let err = s.w.try_send(&[&unapproved.key], &[ix]).unwrap_err();
    assert!(
        err.contains(&format!("Custom({E_RECEIVER_NOT_APPROVED})"))
            && err.contains("ReceiverNotApproved"),
        "the registry refuses a claimer without KYC: {err}"
    );
    assert_eq!(balance(&s.w, &unapproved.share), 0);
    approve(&mut s, &registry, &unapproved.key.pubkey());
    let ix = kyc_claim(&unapproved);
    s.w.send(&[&unapproved.key], &[ix], "claim once approved");
    assert_eq!(balance(&s.w, &unapproved.share), 20);
    assert_eq!(balance(&s.w, &m.vault()), 230);

    // A KYC'd holder pushes one unit into the vault with a raw transfer (the
    // vault's identity exempts the inbound leg).
    let mut push = token_ix::transfer_checked(
        &TOKEN_2022,
        &approved.share,
        &s.fx.mint,
        &m.vault(),
        &approved.key.pubkey(),
        &[],
        1,
        0,
    )
    .unwrap();
    push.accounts.extend(kyc_tail(
        &s.fx.mint,
        &registry,
        &approved.key.pubkey(),
        &m.migration,
    ));
    s.w.send(&[&approved.key], &[push], "raw push into the vault");
    assert_eq!(balance(&s.w, &m.vault()), 231);

    s.w.warp_to(t.claim_deadline);
    let a = admin(&s);
    let close = |s: &Setup| {
        let tail = kyc_tail(&s.fx.mint, &registry, &m.migration, &s.issuer_key.pubkey());
        close_ix(&a.pubkey(), &m, &s.treasury, tail)
    };
    let ix = close(&s);
    let err = s.w.try_send(&[&a], &[ix]).unwrap_err();
    assert!(
        err.contains(&format!("Custom({E_RECEIVER_NOT_APPROVED})")),
        "the raw surplus needs return_to's KYC: {err}"
    );
    assert_eq!(balance(&s.w, &m.vault()), 231, "nothing moved");
    let issuer_wallet = s.issuer_key.pubkey();
    approve(&mut s, &registry, &issuer_wallet);
    let ix = close(&s);
    let (logs, cu) = send_cu(&mut s.w, &[&a], &[ix]).unwrap();
    report("close_migration (KycGated class)", cu);
    assert_eq!(events::<MigrationClosed>(&logs)[0].units_returned, 231);
    assert_eq!(balance(&s.w, &s.treasury), TREASURY - 300 + 231);
    assert!(s.w.is_closed(&m.vault()));
}

/// On a KycGated class the close needs no KYC at all for units `return_to`
/// funded itself and nobody claimed: its own deposit comes back even without
/// a KycEntry (a lapsed passport never strands it).
#[test]
fn kyc_gated_close_returns_return_tos_own_funding_without_kyc() {
    let mut s = setup();
    let registry = kyc_gate(&mut s);
    let old_mint = spl_mint(&mut s.w, 0);
    let t = Terms::standard(4, 1, 100, 0, s.issuer_key.pubkey());
    let m = create(&mut s, &t, old_mint, SPL_TOKEN);
    let tail = kyc_tail(&s.fx.mint, &registry, &s.issuer_key.pubkey(), &m.migration);
    let ix = fund_ix(&s.issuer_key.pubkey(), &m, &s.treasury, 100, tail);
    s.w.send(&[&s.issuer_key], &[ix], "fund");
    open(&mut s, &m);
    s.w.warp_to(t.claim_deadline);
    let a = admin(&s);
    let tail = kyc_tail(&s.fx.mint, &registry, &m.migration, &s.issuer_key.pubkey());
    s.w.send(
        &[&a],
        &[close_ix(&a.pubkey(), &m, &s.treasury, tail)],
        "close without KYC",
    );
    assert_eq!(balance(&s.w, &s.treasury), TREASURY);
}

// ── Creation gates ───────────────────────────────────────────────────────────

/// The double gate: an Admin record AND the share class's live issuer
/// authority. A key without an Admin record, a wrong issuer authority, or an
/// Admin signing for both roles without being the issuer authority are all
/// refused; a pause of custody entry stops the creation.
#[test]
fn create_needs_an_admin_and_the_issuer_authority() {
    let mut s = setup();
    let old_mint = spl_mint(&mut s.w, 0);
    let t = Terms::standard(1, 1, 10, 0, s.issuer_key.pubkey());
    let a = admin(&s);
    let issuer_key = s.issuer_key.insecure_clone();
    let outsider = s.w.funded();
    let ix = create_ix(
        &outsider.pubkey(),
        &issuer_key.pubkey(),
        &s.fx,
        &old_mint,
        &SPL_TOKEN,
        &t,
    );
    expect_code(
        &mut s,
        &[&outsider, &issuer_key],
        &[ix],
        E_NOT_INITIALIZED,
        "no Admin record",
    );
    let ix = create_ix(
        &a.pubkey(),
        &outsider.pubkey(),
        &s.fx,
        &old_mint,
        &SPL_TOKEN,
        &t,
    );
    expect_code(
        &mut s,
        &[&a, &outsider],
        &[ix],
        E_UNAUTHORIZED,
        "not the issuer authority",
    );
    let ix = create_ix(&a.pubkey(), &a.pubkey(), &s.fx, &old_mint, &SPL_TOKEN, &t);
    expect_code(&mut s, &[&a], &[ix], E_UNAUTHORIZED, "the Admin alone");
    s.w.set_pause(asset_registry::PAUSE_CUSTODY_ENTRY, 0);
    let ix = create_ix(
        &a.pubkey(),
        &issuer_key.pubkey(),
        &s.fx,
        &old_mint,
        &SPL_TOKEN,
        &t,
    );
    expect_code(
        &mut s,
        &[&a, &issuer_key],
        &[ix],
        E_PAUSED,
        "custody entry paused",
    );
    s.w.set_pause(0, asset_registry::PAUSE_CUSTODY_ENTRY);
    let m = create(&mut s, &t, old_mint, SPL_TOKEN);
    // The id is used: a second creation under it fails.
    let ix = create_ix(
        &a.pubkey(),
        &issuer_key.pubkey(),
        &s.fx,
        &old_mint,
        &SPL_TOKEN,
        &t,
    );
    assert!(s.w.try_send(&[&a, &issuer_key], &[ix]).is_err());
    assert_eq!(state(&s, &m).status, MigrationStatus::Draft);
}

/// Terms and window bounds, each refused with no account created.
#[test]
fn create_refuses_bad_terms_and_windows() {
    let mut s = setup();
    let old_mint = spl_mint(&mut s.w, 0);
    s.w.warp_to(10 * DAY);
    let now = s.w.now();
    let base = Terms::standard(1, 1, 10, now, s.issuer_key.pubkey());
    let a = admin(&s);
    let issuer_key = s.issuer_key.insecure_clone();
    let own_pda = migration_pda(&s.fx.share_class, base.id);
    let window = |days: i64| Terms {
        closes_at: base.opens_at + days * DAY,
        claim_deadline: base.opens_at + (days + 30) * DAY,
        ..base
    };
    let back = Terms {
        opens_at: now - DAY - 1,
        closes_at: now - DAY - 1 + 75 * DAY,
        claim_deadline: now - DAY - 1 + 105 * DAY,
        ..base
    };
    let short_claim = Terms {
        claim_deadline: base.closes_at + 30 * DAY - 1,
        ..base
    };
    let cases = [
        (Terms { lot: 0, ..base }, E_TERMS, "lot 0"),
        (
            Terms {
                units_cap: 0,
                ..base
            },
            E_TERMS,
            "cap 0",
        ),
        (
            Terms {
                terms_hash: [0; 32],
                ..base
            },
            E_TERMS,
            "terms hash 0",
        ),
        (
            Terms {
                return_to: Pubkey::default(),
                ..base
            },
            E_TERMS,
            "no return_to",
        ),
        (
            Terms {
                return_to: own_pda,
                ..base
            },
            E_TERMS,
            "return_to = the Migration PDA (the vault's owner)",
        ),
        (window(29), E_WINDOW, "29-day window"),
        (window(181), E_WINDOW, "181-day window"),
        (short_claim, E_WINDOW, "claim period under 30 days"),
        (back, E_WINDOW, "opens more than a day ago"),
    ];
    for (t, code, what) in cases {
        let ix = create_ix(
            &a.pubkey(),
            &issuer_key.pubkey(),
            &s.fx,
            &old_mint,
            &SPL_TOKEN,
            &t,
        );
        expect_code(&mut s, &[&a, &issuer_key], &[ix], code, what);
        assert!(s
            .w
            .svm
            .get_account(&migration_pda(&s.fx.share_class, t.id))
            .is_none());
    }
    // The bounds themselves pass: exactly 30 / 180 days, a day back, 30 days to claim.
    for (id, days) in [(11u64, 30i64), (12, 180)] {
        let t = Terms { id, ..window(days) };
        create(&mut s, &t, old_mint, SPL_TOKEN);
    }
    let t = Terms {
        id: 13,
        opens_at: now - DAY,
        closes_at: now - DAY + 75 * DAY,
        claim_deadline: now - DAY + 105 * DAY,
        ..base
    };
    create(&mut s, &t, old_mint, SPL_TOKEN);
    // The share class's own mint is not a legacy token (its transfer hook
    // fails the old-mint policy before the handler's own check).
    let share_mint = s.fx.mint;
    let ix = create_ix(
        &a.pubkey(),
        &issuer_key.pubkey(),
        &s.fx,
        &share_mint,
        &TOKEN_2022,
        &Terms { id: 14, ..base },
    );
    expect_code(
        &mut s,
        &[&a, &issuer_key],
        &[ix],
        E_UNSUPPORTED_MINT_EXTENSION,
        "the share mint itself",
    );
}

/// The old-mint policy: every extension that charges, rescales, runs code,
/// moves, freezes or pauses balances is `UnsupportedMintExtension`, the
/// native mint is refused, and the permitted ones pass.
#[test]
fn create_refuses_unsupported_old_mint_extensions() {
    let mut s = setup();
    let a = admin(&s);
    let issuer_key = s.issuer_key.insecure_clone();
    let refused = [
        Ext::TransferFee,
        Ext::TransferHook,
        Ext::NonTransferable,
        Ext::PermanentDelegate,
        Ext::ConfidentialTransfer,
        Ext::DefaultFrozen,
        Ext::InterestBearing,
        Ext::ScaledUiAmount,
        Ext::Pausable,
    ];
    for (i, ext) in refused.into_iter().enumerate() {
        let old_mint = t22_mint(&mut s.w, 6, &[ext]);
        let t = Terms::standard(100 + i as u64, 1, 10, 0, issuer_key.pubkey());
        let ix = create_ix(
            &a.pubkey(),
            &issuer_key.pubkey(),
            &s.fx,
            &old_mint,
            &TOKEN_2022,
            &t,
        );
        expect_code(
            &mut s,
            &[&a, &issuer_key],
            &[ix],
            E_UNSUPPORTED_MINT_EXTENSION,
            &format!("{ext:?}"),
        );
        let m = migration_pda(&s.fx.share_class, t.id);
        assert!(
            s.w.svm.get_account(&m).is_none(),
            "{ext:?}: nothing created"
        );
        assert!(s.w.svm.get_account(&mig_escrow_pda(&m)).is_none());
    }
    // A Token-2022 old mint passed with the SPL Token program is refused.
    let t22 = t22_mint(&mut s.w, 6, &[]);
    let t = Terms::standard(200, 1, 10, 0, issuer_key.pubkey());
    let ix = create_ix(
        &a.pubkey(),
        &issuer_key.pubkey(),
        &s.fx,
        &t22,
        &SPL_TOKEN,
        &t,
    );
    assert!(s.w.try_send(&[&a, &issuer_key], &[ix]).is_err());
    // The native mint (wrapped SOL cannot be burned).
    let native = Pubkey::from_str_const("So11111111111111111111111111111111111111112");
    let template = spl_mint(&mut s.w, 9);
    let account = s.w.svm.get_account(&template).unwrap();
    s.w.svm.set_account(native, account).unwrap();
    let t = Terms::standard(201, 1, 10, 0, issuer_key.pubkey());
    let ix = create_ix(
        &a.pubkey(),
        &issuer_key.pubkey(),
        &s.fx,
        &native,
        &SPL_TOKEN,
        &t,
    );
    expect_code(&mut s, &[&a, &issuer_key], &[ix], E_TERMS, "native mint");
    // Permitted: a plain Token-2022 mint, and the pointer / close / default-state set.
    for (id, exts) in [
        (300u64, vec![]),
        (
            301,
            vec![
                Ext::MetadataPointer,
                Ext::MintCloseAuthority,
                Ext::DefaultInitialized,
            ],
        ),
    ] {
        let old_mint = t22_mint(&mut s.w, 6, &exts);
        let t = Terms::standard(id, 1, 10, 0, issuer_key.pubkey());
        create(&mut s, &t, old_mint, TOKEN_2022);
    }
}

// ── Funding and opening ──────────────────────────────────────────────────────

#[test]
fn fund_and_open_gates() {
    let mut s = setup();
    let old_mint = spl_mint(&mut s.w, 0);
    let t = Terms::standard(1, 1, 100, 0, s.issuer_key.pubkey());
    let m = create(&mut s, &t, old_mint, SPL_TOKEN);
    let a = admin(&s);
    let issuer_key = s.issuer_key.insecure_clone();

    // Only the live issuer authority funds, from its own account.
    let outsider = s.w.funded();
    let outsider_units = ata(&mut s.w, &s.fx.mint, &outsider.pubkey(), &TOKEN_2022);
    let ix = fund_ix(
        &outsider.pubkey(),
        &m,
        &outsider_units,
        1,
        open_tail(&s.fx.mint, &outsider.pubkey()),
    );
    expect_code(
        &mut s,
        &[&outsider],
        &[ix],
        E_UNAUTHORIZED,
        "not the issuer authority",
    );
    let ix = fund_ix(
        &issuer_key.pubkey(),
        &m,
        &outsider_units,
        1,
        open_tail(&s.fx.mint, &issuer_key.pubkey()),
    );
    expect_code(
        &mut s,
        &[&issuer_key],
        &[ix],
        E_UNAUTHORIZED,
        "someone else's account",
    );
    let ix = fund_ix(
        &issuer_key.pubkey(),
        &m,
        &s.treasury,
        0,
        open_tail(&s.fx.mint, &issuer_key.pubkey()),
    );
    expect_code(
        &mut s,
        &[&issuer_key],
        &[ix],
        E_INVALID_DEPOSIT_AMOUNT,
        "zero units",
    );
    let ix = fund_ix(
        &issuer_key.pubkey(),
        &m,
        &s.treasury,
        101,
        open_tail(&s.fx.mint, &issuer_key.pubkey()),
    );
    expect_code(
        &mut s,
        &[&issuer_key],
        &[ix],
        E_CAP_EXCEEDED,
        "over the cap",
    );

    fund(&mut s, &m, 99);
    expect_code(
        &mut s,
        &[&a],
        &[open_ix(&a.pubkey(), &m)],
        E_UNDERFUNDED,
        "99 of 100",
    );
    let ix = fund_ix(
        &issuer_key.pubkey(),
        &m,
        &s.treasury,
        2,
        open_tail(&s.fx.mint, &issuer_key.pubkey()),
    );
    expect_code(
        &mut s,
        &[&issuer_key],
        &[ix],
        E_CAP_EXCEEDED,
        "past the cap by one",
    );
    fund(&mut s, &m, 1);
    expect_code(
        &mut s,
        &[&outsider],
        &[open_ix(&outsider.pubkey(), &m)],
        E_NOT_INITIALIZED,
        "open by a non-Admin",
    );
    s.w.set_pause(asset_registry::PAUSE_CUSTODY_ENTRY, 0);
    expect_code(
        &mut s,
        &[&a],
        &[open_ix(&a.pubkey(), &m)],
        E_PAUSED,
        "open while custody entry is paused",
    );
    let ix = fund_ix(
        &issuer_key.pubkey(),
        &m,
        &s.treasury,
        1,
        open_tail(&s.fx.mint, &issuer_key.pubkey()),
    );
    expect_code(&mut s, &[&issuer_key], &[ix], E_PAUSED, "fund while paused");
    s.w.set_pause(0, asset_registry::PAUSE_CUSTODY_ENTRY);
    open(&mut s, &m);
    // Funding is a Draft-only step; a second open is refused.
    let ix = fund_ix(
        &issuer_key.pubkey(),
        &m,
        &s.treasury,
        1,
        open_tail(&s.fx.mint, &issuer_key.pubkey()),
    );
    expect_code(&mut s, &[&issuer_key], &[ix], E_STATUS, "fund after open");
    expect_code(
        &mut s,
        &[&a],
        &[open_ix(&a.pubkey(), &m)],
        E_STATUS,
        "open twice",
    );
    assert_eq!(balance(&s.w, &m.vault()), 100);

    // A Draft cannot be opened at or after closes_at (cancel it instead).
    let late = Terms::standard(2, 1, 5, 0, s.issuer_key.pubkey());
    let m2 = create(&mut s, &late, old_mint, SPL_TOKEN);
    fund(&mut s, &m2, 5);
    s.w.warp_to(late.closes_at);
    expect_code(
        &mut s,
        &[&a],
        &[open_ix(&a.pubkey(), &m2)],
        E_OUTSIDE_WINDOW,
        "open after the window",
    );
}

// ── Deposits ─────────────────────────────────────────────────────────────────

#[test]
fn deposit_gates_window_cap_lots_pause_and_blocklist() {
    let mut s = setup();
    let old_mint = spl_mint(&mut s.w, 0);
    let lot = 10;
    let t = Terms::standard(1, lot, 5, 1_000, s.issuer_key.pubkey());
    let m = create(&mut s, &t, old_mint, SPL_TOKEN);
    let h = holder(&mut s, &m, 1_000);
    let hk = h.key.insecure_clone();
    let dep = |lots: u64| deposit_ix(&hk.pubkey(), &m, &h.old, lots);
    expect_code(&mut s, &[&hk], &[dep(1)], E_STATUS, "deposit into a Draft");
    fund(&mut s, &m, 5);
    open(&mut s, &m);
    expect_code(
        &mut s,
        &[&hk],
        &[dep(1)],
        E_OUTSIDE_WINDOW,
        "before opens_at",
    );
    s.w.warp_to(t.opens_at);
    expect_code(
        &mut s,
        &[&hk],
        &[dep(0)],
        E_INVALID_DEPOSIT_AMOUNT,
        "zero lots",
    );
    expect_code(
        &mut s,
        &[&hk],
        &[dep(6)],
        E_ALLOCATION_EXCEEDED,
        "more lots than funded units",
    );
    expect_code(
        &mut s,
        &[&hk],
        &[dep(u64::MAX / 2)],
        E_OVERFLOW,
        "lots * lot overflows",
    );
    // Someone else's old-token account.
    let other = holder(&mut s, &m, 100);
    let ix = deposit_ix(&hk.pubkey(), &m, &other.old, 1);
    expect_code(
        &mut s,
        &[&hk],
        &[ix],
        E_UNAUTHORIZED,
        "another holder's account",
    );
    // Custody entry paused.
    s.w.set_pause(asset_registry::PAUSE_CUSTODY_ENTRY, 0);
    expect_code(&mut s, &[&hk], &[dep(1)], E_PAUSED, "custody entry paused");
    s.w.set_pause(0, asset_registry::PAUSE_CUSTODY_ENTRY);
    // A blocklisted holder (live hook BlockEntry).
    v1::fabricate_block_entry(&mut s.w.svm, &hk.pubkey());
    let err = s.w.try_send(&[&hk], &[dep(1)]).unwrap_err();
    assert!(
        err.contains(&format!("Custom({E_PARTY_BLOCKLISTED})")) && err.contains("PartyBlocklisted"),
        "{err}"
    );
    v1::clear_block_entry(&mut s.w.svm, &hk.pubkey());

    // Exactly the funded units can be committed.
    s.w.send(&[&hk], &[dep(4)], "four lots");
    let o = other.key.insecure_clone();
    s.w.send(
        &[&o],
        &[deposit_ix(&o.pubkey(), &m, &other.old, 1)],
        "the last lot",
    );
    expect_code(
        &mut s,
        &[&hk],
        &[dep(1)],
        E_ALLOCATION_EXCEEDED,
        "nothing left",
    );
    assert_eq!(balance(&s.w, &m.escrow()), 5 * lot);
    assert_eq!(balance(&s.w, &h.old), 1_000 - 4 * lot);
    // The window closes at closes_at exactly.
    s.w.warp_to(t.closes_at);
    expect_code(
        &mut s,
        &[&o],
        &[deposit_ix(&o.pubkey(), &m, &other.old, 1)],
        E_OUTSIDE_WINDOW,
        "at closes_at",
    );
}

// ── Finalize and claims ──────────────────────────────────────────────────────

#[test]
fn finalize_and_claim_gates() {
    let mut s = setup();
    let old_mint = spl_mint(&mut s.w, 0);
    let t = Terms::standard(1, 1, 50, 0, s.issuer_key.pubkey());
    let m = launch(&mut s, &t, old_mint, SPL_TOKEN);
    let h = holder(&mut s, &m, 10);
    let stranger = holder(&mut s, &m, 0);
    deposit(&mut s, &m, &h, 10);

    let err = claim(&mut s, &m, &h).unwrap_err();
    assert!(
        err.contains(&format!("Custom({E_STATUS})")),
        "claim while Open: {err}"
    );
    expect_code(
        &mut s,
        &[],
        &[finalize_ix(&m)],
        E_WINDOW_NOT_CLOSED,
        "finalize inside the window",
    );
    s.w.warp_to(t.closes_at - 1);
    expect_code(
        &mut s,
        &[],
        &[finalize_ix(&m)],
        E_WINDOW_NOT_CLOSED,
        "one second early",
    );
    s.w.warp_to(t.closes_at);
    s.w.send(&[], &[finalize_ix(&m)], "finalize at closes_at");
    expect_code(&mut s, &[], &[finalize_ix(&m)], E_STATUS, "finalize twice");

    // Units only to the depositor's own account.
    let tail = open_tail(&s.fx.mint, &m.migration);
    let hk = h.key.insecure_clone();
    let ix = claim_ix(&hk.pubkey(), &m, &stranger.share, tail);
    expect_code(
        &mut s,
        &[&hk],
        &[ix],
        E_UNAUTHORIZED,
        "into another's account",
    );
    // A wallet that never deposited has no record.
    let err = claim(&mut s, &m, &stranger).unwrap_err();
    assert!(
        err.contains(&format!("Custom({E_NOT_INITIALIZED})")),
        "{err}"
    );
    // Exits ignore the pause: every bit set, the claim still pays.
    s.w.set_pause(asset_registry::PAUSE_FLAGS_ALL, 0);
    claim(&mut s, &m, &h).unwrap();
    s.w.set_pause(
        0,
        asset_registry::PAUSE_FLAGS_ALL & !asset_registry::PAUSE_PAYOUT_MODULES,
    );
    s.w.set_pause(0, asset_registry::PAUSE_PAYOUT_MODULES);
    assert_eq!(balance(&s.w, &h.share), 10);
    let err = claim(&mut s, &m, &h).unwrap_err();
    assert!(
        err.contains(&format!("Custom({E_DEPOSIT_SETTLED})")),
        "double claim: {err}"
    );
    assert_eq!(balance(&s.w, &h.share), 10);
    assert_eq!(balance(&s.w, &m.vault()), 40);
}

/// A holder blocked AFTER depositing still claims: the units land frozen in
/// the blocked wallet (the hook refuses every transfer out of it) instead of
/// being forfeited to return_to at the deadline.
#[test]
fn a_holder_blocked_after_depositing_claims_into_a_frozen_wallet() {
    let mut s = setup();
    s.w.init_blocklist_authority();
    let old_mint = spl_mint(&mut s.w, 0);
    let t = Terms::standard(1, 1, 10, 0, s.issuer_key.pubkey());
    let m = launch(&mut s, &t, old_mint, SPL_TOKEN);
    let h = holder(&mut s, &m, 3);
    deposit(&mut s, &m, &h, 3);
    s.w.block(&h.key.pubkey());
    s.w.warp_to(t.closes_at);
    s.w.send(&[], &[finalize_ix(&m)], "finalize");
    claim(&mut s, &m, &h).unwrap();
    assert_eq!(balance(&s.w, &h.share), 3);
    let other = s.w.funded();
    let other_share = ata(&mut s.w, &s.fx.mint, &other.pubkey(), &TOKEN_2022);
    let mut out = token_ix::transfer_checked(
        &TOKEN_2022,
        &h.share,
        &s.fx.mint,
        &other_share,
        &h.key.pubkey(),
        &[],
        1,
        0,
    )
    .unwrap();
    out.accounts.extend(open_tail(&s.fx.mint, &h.key.pubkey()));
    assert!(
        s.w.try_send(&[&h.key], &[out]).is_err(),
        "frozen by the hook"
    );
}

// ── Cancellation, refunds and the close ──────────────────────────────────────

/// Cancel while Open: every deposit is refunded exactly (permissionless, to
/// the depositor's own account), a second refund is refused, the close waits
/// for the last refund, then returns every funded unit, burns the raw
/// old-token surplus and closes everything.
#[test]
fn cancel_refund_and_close_paths() {
    let mut s = setup();
    let old_mint = spl_mint(&mut s.w, 3);
    let lot = 1_000;
    let t = Terms::standard(1, lot, 20, 0, s.issuer_key.pubkey());
    let m = launch(&mut s, &t, old_mint, SPL_TOKEN);
    let ha = holder(&mut s, &m, 5 * lot);
    let hb = holder(&mut s, &m, 3 * lot);
    deposit(&mut s, &m, &ha, 5);
    deposit(&mut s, &m, &hb, 3);
    // Someone pushes old tokens into the escrow with a raw transfer.
    let pusher = holder(&mut s, &m, 7);
    let raw = token_ix::transfer_checked(
        &SPL_TOKEN,
        &pusher.old,
        &old_mint,
        &m.escrow(),
        &pusher.key.pubkey(),
        &[],
        7,
        3,
    )
    .unwrap();
    s.w.send(&[&pusher.key], &[raw], "raw push into the escrow");
    assert_eq!(balance(&s.w, &m.escrow()), 8 * lot + 7);

    let a = admin(&s);
    let refund_a = refund_ix(&m, &ha.key.pubkey(), &ha.old);
    expect_code(
        &mut s,
        &[],
        std::slice::from_ref(&refund_a),
        E_STATUS,
        "refund without cancel",
    );
    let outsider = s.w.funded();
    expect_code(
        &mut s,
        &[&outsider],
        &[cancel_ix(&outsider.pubkey(), &m)],
        E_NOT_INITIALIZED,
        "cancel by a non-Admin",
    );
    // Exits ignore the pause.
    s.w.set_pause(asset_registry::PAUSE_FLAGS_ALL, 0);
    let (_, cu) = send_cu(&mut s.w, &[&a], &[cancel_ix(&a.pubkey(), &m)]).unwrap();
    report("cancel_migration", cu);
    assert_eq!(state(&s, &m).status, MigrationStatus::Cancelled);
    expect_code(
        &mut s,
        &[&a],
        &[cancel_ix(&a.pubkey(), &m)],
        E_NOT_CANCELLABLE,
        "cancel twice",
    );
    // Refund to someone else's account is refused; to the depositor's it is
    // paid with no signature of any party (the fee payer is a stranger).
    let wrong = refund_ix(&m, &ha.key.pubkey(), &hb.old);
    expect_code(
        &mut s,
        &[],
        &[wrong],
        E_UNAUTHORIZED,
        "refund into another's account",
    );
    let (_, cu) = send_cu(&mut s.w, &[], std::slice::from_ref(&refund_a)).unwrap();
    report("refund_migration_deposit", cu);
    assert_eq!(balance(&s.w, &ha.old), 5 * lot);
    assert!(
        s.w.load::<MigrationDeposit>(&m.deposit(&ha.key.pubkey()))
            .refunded
    );
    expect_code(&mut s, &[], &[refund_a], E_DEPOSIT_SETTLED, "double refund");
    // A deposit refunded is not claimable either (and claims need Claimable).
    let err = claim(&mut s, &m, &ha).unwrap_err();
    assert!(err.contains(&format!("Custom({E_STATUS})")), "{err}");
    // The close waits for the last refund.
    let tail = open_tail(&s.fx.mint, &m.migration);
    let close = close_ix(&a.pubkey(), &m, &s.treasury, tail);
    expect_code(
        &mut s,
        &[&a],
        std::slice::from_ref(&close),
        E_NOT_CLOSABLE,
        "deposits outstanding",
    );
    s.w.send(&[], &[refund_ix(&m, &hb.key.pubkey(), &hb.old)], "refund b");
    assert_eq!(balance(&s.w, &hb.old), 3 * lot);
    assert_eq!(balance(&s.w, &m.escrow()), 7, "only the raw push is left");
    let mig = state(&s, &m);
    assert_eq!((mig.lots_deposited, mig.lots_refunded), (8, 8));
    let old_supply = supply(&s.w, &old_mint);
    let rent = closable_rent(&s, &m);
    let before = s.w.lamports(&a.pubkey());
    s.w.send(&[&a], &[close], "close after every refund (paused)");
    assert_eq!(
        balance(&s.w, &s.treasury),
        TREASURY,
        "every funded unit back"
    );
    assert_eq!(
        supply(&s.w, &old_mint),
        old_supply - 7,
        "the raw push is burned"
    );
    assert_eq!(s.w.lamports(&a.pubkey()), before + rent);
    assert_eq!(state(&s, &m).status, MigrationStatus::Closed);
}

/// A Draft is cancellable at any time — also one never opened before
/// closes_at, whose funded units would otherwise be stranded — and closes at
/// once (no deposits). An Open migration is not cancellable from closes_at
/// on, nor after any claim.
#[test]
fn cancel_bounds_draft_any_time_open_only_early_and_before_claims() {
    let mut s = setup();
    let old_mint = spl_mint(&mut s.w, 0);
    let a = admin(&s);
    // A Draft past its window.
    let t = Terms::standard(1, 1, 10, 0, s.issuer_key.pubkey());
    let m = create(&mut s, &t, old_mint, SPL_TOKEN);
    fund(&mut s, &m, 4);
    s.w.warp_to(t.claim_deadline + DAY);
    s.w.send(&[&a], &[cancel_ix(&a.pubkey(), &m)], "cancel a stale Draft");
    s.w.send(
        &[&a],
        &[close_ix(
            &a.pubkey(),
            &m,
            &s.treasury,
            open_tail(&s.fx.mint, &m.migration),
        )],
        "close it",
    );
    assert_eq!(balance(&s.w, &s.treasury), TREASURY);

    // Open, past closes_at.
    let now = s.w.now();
    let t2 = Terms::standard(2, 1, 10, now, s.issuer_key.pubkey());
    let m2 = launch(&mut s, &t2, old_mint, SPL_TOKEN);
    s.w.warp_to(t2.closes_at);
    expect_code(
        &mut s,
        &[&a],
        &[cancel_ix(&a.pubkey(), &m2)],
        E_NOT_CANCELLABLE,
        "at closes_at",
    );

    // Open, before closes_at but after a root claim.
    let now = s.w.now();
    let t3 = Terms::standard(3, 1, 10, now, s.issuer_key.pubkey());
    let m3 = launch(&mut s, &t3, old_mint, SPL_TOKEN);
    let locker = s.w.funded();
    let locker_share = ata(&mut s.w, &s.fx.mint, &locker.pubkey(), &TOKEN_2022);
    let (root, proofs) = tree(&[(locker.pubkey(), 2), (Pubkey::new_unique(), 3)]);
    let issuer_key = s.issuer_key.insecure_clone();
    s.w.send(
        &[&a, &issuer_key],
        &[publish_ix(&a.pubkey(), &issuer_key.pubkey(), &m3, root, 5)],
        "publish while Open",
    );
    let ix = claim_proof_ix(
        &locker.pubkey(),
        &m3,
        &locker_share,
        2,
        proofs[0].clone(),
        open_tail(&s.fx.mint, &m3.migration),
    );
    s.w.send(&[&locker], &[ix], "a root claim while Open");
    expect_code(
        &mut s,
        &[&a],
        &[cancel_ix(&a.pubkey(), &m3)],
        E_NOT_CANCELLABLE,
        "after a claim",
    );
    // Claimable is never cancellable.
    s.w.warp_to(t3.closes_at);
    s.w.send(&[], &[finalize_ix(&m3)], "finalize");
    expect_code(
        &mut s,
        &[&a],
        &[cancel_ix(&a.pubkey(), &m3)],
        E_NOT_CANCELLABLE,
        "Claimable",
    );
}

#[test]
fn close_gates_deadline_admin_rent_recipient_and_return_to() {
    let mut s = setup();
    let old_mint = spl_mint(&mut s.w, 0);
    let t = Terms::standard(1, 1, 10, 0, s.issuer_key.pubkey());
    let m = launch(&mut s, &t, old_mint, SPL_TOKEN);
    let h = holder(&mut s, &m, 2);
    deposit(&mut s, &m, &h, 2);
    let a = admin(&s);
    let mint = s.fx.mint;
    let tail = || open_tail(&mint, &m.migration);
    let close = close_ix(&a.pubkey(), &m, &s.treasury, tail());
    expect_code(
        &mut s,
        &[&a],
        std::slice::from_ref(&close),
        E_NOT_CLOSABLE,
        "inside the window",
    );
    s.w.warp_to(t.claim_deadline - 1);
    s.w.send(&[], &[finalize_ix(&m)], "finalize");
    expect_code(
        &mut s,
        &[&a],
        std::slice::from_ref(&close),
        E_NOT_CLOSABLE,
        "one second before the deadline",
    );
    s.w.warp_to(t.claim_deadline);
    // Any Admin may close, the rent always goes to the creator.
    let outsider = s.w.funded();
    let ix = close_ix(&outsider.pubkey(), &m, &s.treasury, tail());
    expect_code(
        &mut s,
        &[&outsider],
        &[ix],
        E_NOT_INITIALIZED,
        "a non-Admin",
    );
    let mut wrong_rent = close.clone();
    wrong_rent.accounts[3].pubkey = outsider.pubkey();
    expect_code(
        &mut s,
        &[&a],
        &[wrong_rent],
        E_UNAUTHORIZED,
        "rent to someone else",
    );
    let other_units = ata(&mut s.w, &s.fx.mint, &outsider.pubkey(), &TOKEN_2022);
    let ix = close_ix(&a.pubkey(), &m, &other_units, tail());
    expect_code(
        &mut s,
        &[&a],
        &[ix],
        E_UNAUTHORIZED,
        "units to someone other than return_to",
    );
    // Claims stay open until the close, also after the deadline.
    claim(&mut s, &m, &h).unwrap();
    s.w.send(&[&a], &[close], "close");
    assert_eq!(balance(&s.w, &s.treasury), TREASURY - 2);
    let again = close_ix(&a.pubkey(), &m, &s.treasury, tail());
    assert!(s.w.try_send(&[&a], &[again]).is_err(), "close twice");
}

// ── The root ─────────────────────────────────────────────────────────────────

#[test]
fn root_gates_publication_proofs_double_claims_and_total() {
    let mut s = setup();
    let old_mint = spl_mint(&mut s.w, 0);
    let t = Terms::standard(1, 1, 100, 0, s.issuer_key.pubkey());
    let m = create(&mut s, &t, old_mint, SPL_TOKEN);
    let a = admin(&s);
    let issuer_key = s.issuer_key.insecure_clone();
    let l1 = s.w.funded();
    let l2 = s.w.funded();
    let l3 = s.w.funded();
    let shares: Vec<Pubkey> = [&l1, &l2, &l3]
        .iter()
        .map(|k| ata(&mut s.w, &s.fx.mint, &k.pubkey(), &TOKEN_2022))
        .collect();
    // Leaves sum to 70 while the root declares 60: the total caps the claims.
    let (root, proofs) = tree(&[(l1.pubkey(), 30), (l2.pubkey(), 20), (l3.pubkey(), 20)]);
    let publish =
        |root: [u8; 32], total: u64| publish_ix(&a.pubkey(), &issuer_key.pubkey(), &m, root, total);
    expect_code(
        &mut s,
        &[&a, &issuer_key],
        &[publish(root, 60)],
        E_STATUS,
        "publish in Draft",
    );
    fund(&mut s, &m, 100);
    open(&mut s, &m);
    // Both keys: an Admin alone (signing as the issuer too) is refused.
    expect_code(
        &mut s,
        &[&a],
        &[publish_ix(&a.pubkey(), &a.pubkey(), &m, root, 60)],
        E_UNAUTHORIZED,
        "Admin alone",
    );
    let outsider = s.w.funded();
    let ix = publish_ix(&outsider.pubkey(), &issuer_key.pubkey(), &m, root, 60);
    expect_code(
        &mut s,
        &[&outsider, &issuer_key],
        &[ix],
        E_NOT_INITIALIZED,
        "issuer alone",
    );
    expect_code(
        &mut s,
        &[&a, &issuer_key],
        &[publish([0; 32], 60)],
        E_TERMS,
        "zero root",
    );
    expect_code(
        &mut s,
        &[&a, &issuer_key],
        &[publish(root, 0)],
        E_TERMS,
        "zero total",
    );
    expect_code(
        &mut s,
        &[&a, &issuer_key],
        &[publish(root, 101)],
        E_ALLOCATION_EXCEEDED,
        "over the funded units",
    );
    s.w.set_pause(asset_registry::PAUSE_CUSTODY_ENTRY, 0);
    expect_code(
        &mut s,
        &[&a, &issuer_key],
        &[publish(root, 60)],
        E_PAUSED,
        "custody entry paused",
    );
    s.w.set_pause(0, asset_registry::PAUSE_CUSTODY_ENTRY);
    // No root yet.
    let mint = s.fx.mint;
    let tail = || open_tail(&mint, &m.migration);
    let ix = claim_proof_ix(&l1.pubkey(), &m, &shares[0], 30, proofs[0].clone(), tail());
    expect_code(&mut s, &[&l1], &[ix], E_ROOT_MISSING, "no root");
    // A deposit commits units: the root may only take the rest.
    let h = holder(&mut s, &m, 50);
    deposit(&mut s, &m, &h, 50);
    expect_code(
        &mut s,
        &[&a, &issuer_key],
        &[publish(root, 51)],
        E_ALLOCATION_EXCEEDED,
        "deposits + root over funded",
    );
    s.w.send(&[&a, &issuer_key], &[publish(root, 50)], "publish");
    expect_code(
        &mut s,
        &[&a, &issuer_key],
        &[publish(root, 1)],
        E_ROOT_ALREADY_PUBLISHED,
        "a second root",
    );
    // ... and no further deposit fits.
    let h2 = holder(&mut s, &m, 1);
    let ix = deposit_ix(&h2.key.pubkey(), &m, &h2.old, 1);
    expect_code(
        &mut s,
        &[&h2.key],
        &[ix],
        E_ALLOCATION_EXCEEDED,
        "deposit after the root filled the cap",
    );

    let claim_proof = |k: &Keypair, share: &Pubkey, units: u64, proof: Vec<[u8; 32]>| {
        claim_proof_ix(&k.pubkey(), &m, share, units, proof, tail())
    };
    expect_code(
        &mut s,
        &[&l1],
        &[claim_proof(&l1, &shares[0], 31, proofs[0].clone())],
        E_INVALID_MERKLE_PROOF,
        "wrong amount",
    );
    expect_code(
        &mut s,
        &[&l1],
        &[claim_proof(&l1, &shares[0], 20, proofs[1].clone())],
        E_INVALID_MERKLE_PROOF,
        "another leaf's proof",
    );
    expect_code(
        &mut s,
        &[&l1],
        &[claim_proof(&l1, &shares[0], 0, proofs[0].clone())],
        E_NOTHING_TO_CLAIM,
        "zero units",
    );
    expect_code(
        &mut s,
        &[&l1],
        &[claim_proof(&l1, &shares[1], 30, proofs[0].clone())],
        E_UNAUTHORIZED,
        "into another's account",
    );
    s.w.send(
        &[&l1],
        &[claim_proof(&l1, &shares[0], 30, proofs[0].clone())],
        "l1 claims 30",
    );
    let err =
        s.w.try_send(
            &[&l1],
            &[claim_proof(&l1, &shares[0], 30, proofs[0].clone())],
        )
        .unwrap_err();
    assert!(
        err.contains("Custom(0)") || err.contains("already in use"),
        "double proof claim: {err}"
    );
    s.w.send(
        &[&l2],
        &[claim_proof(&l2, &shares[1], 20, proofs[1].clone())],
        "l2 claims 20",
    );
    // l3's leaf is valid, but the declared total (50) is spent.
    expect_code(
        &mut s,
        &[&l3],
        &[claim_proof(&l3, &shares[2], 20, proofs[2].clone())],
        E_ROOT_EXCEEDED,
        "past the root total",
    );
    assert_eq!(balance(&s.w, &shares[0]), 30);
    assert_eq!(balance(&s.w, &shares[1]), 20);
    assert_eq!(balance(&s.w, &shares[2]), 0);
    // The depositor's units were never at risk.
    s.w.warp_to(t.closes_at);
    s.w.send(&[], &[finalize_ix(&m)], "finalize");
    claim(&mut s, &m, &h).unwrap();
    assert_eq!(balance(&s.w, &m.vault()), 0);
    // Publication closes at the claim deadline.
    let t2 = Terms::standard(2, 1, 10, s.w.now(), issuer_key.pubkey());
    let m2 = launch(&mut s, &t2, old_mint, SPL_TOKEN);
    s.w.warp_to(t2.claim_deadline);
    let ix = publish_ix(&a.pubkey(), &issuer_key.pubkey(), &m2, root, 5);
    expect_code(
        &mut s,
        &[&a, &issuer_key],
        &[ix],
        E_CLAIM_DEADLINE_PASSED,
        "after the claim deadline",
    );
}

/// Exits never read the pause bits: with every bit set, finalize, claims,
/// proof claims, cancel, refunds and the close all run; every entry
/// (create, fund, open, deposit, publish) is refused.
#[test]
fn exits_ignore_the_pause_and_entries_honour_it() {
    let mut s = setup();
    let old_mint = spl_mint(&mut s.w, 0);
    let t = Terms::standard(1, 1, 10, 0, s.issuer_key.pubkey());
    let m = launch(&mut s, &t, old_mint, SPL_TOKEN);
    let h = holder(&mut s, &m, 5);
    deposit(&mut s, &m, &h, 2);
    let a = admin(&s);
    let issuer_key = s.issuer_key.insecure_clone();
    let locker = s.w.funded();
    let locker_share = ata(&mut s.w, &s.fx.mint, &locker.pubkey(), &TOKEN_2022);
    let (root, proofs) = tree(&[(locker.pubkey(), 3), (Pubkey::new_unique(), 1)]);
    s.w.send(
        &[&a, &issuer_key],
        &[publish_ix(&a.pubkey(), &issuer_key.pubkey(), &m, root, 4)],
        "publish",
    );

    s.w.set_pause(asset_registry::PAUSE_FLAGS_ALL, 0);
    let ix = deposit_ix(&h.key.pubkey(), &m, &h.old, 1);
    expect_code(
        &mut s,
        &[&h.key.insecure_clone()],
        &[ix],
        E_PAUSED,
        "deposit",
    );
    let t2 = Terms::standard(2, 1, 10, s.w.now(), issuer_key.pubkey());
    let ix = create_ix(
        &a.pubkey(),
        &issuer_key.pubkey(),
        &s.fx,
        &old_mint,
        &SPL_TOKEN,
        &t2,
    );
    expect_code(&mut s, &[&a, &issuer_key], &[ix], E_PAUSED, "create");

    s.w.warp_to(t.closes_at);
    s.w.send(&[], &[finalize_ix(&m)], "finalize while paused");
    claim(&mut s, &m, &h).unwrap();
    let ix = claim_proof_ix(
        &locker.pubkey(),
        &m,
        &locker_share,
        3,
        proofs[0].clone(),
        open_tail(&s.fx.mint, &m.migration),
    );
    s.w.send(&[&locker], &[ix], "proof claim while paused");
    s.w.warp_to(t.claim_deadline);
    let ix = close_ix(
        &a.pubkey(),
        &m,
        &s.treasury,
        open_tail(&s.fx.mint, &m.migration),
    );
    s.w.send(&[&a], &[ix], "close while paused");
    assert_eq!(balance(&s.w, &h.share), 2);
    assert_eq!(balance(&s.w, &locker_share), 3);
    assert_eq!(balance(&s.w, &s.treasury), TREASURY - 5);
}

/// The vault carries the registry's escrow identity: no clawback can target
/// the Migration PDA as a "holder" (`ClawbackTargetIsEscrow`, 6087), and the
/// identity names `return_to` as its only refund route.
#[test]
fn the_vault_is_registry_custody_and_no_clawback_can_target_it() {
    let mut s = setup();
    s.w.init_blocklist_authority();
    let old_mint = spl_mint(&mut s.w, 0);
    let t = Terms::standard(1, 1, 10, 0, s.issuer_key.pubkey());
    let m = launch(&mut s, &t, old_mint, SPL_TOKEN);
    // Even with the Migration PDA on the hook blocklist (both keys), the
    // two-key clawback refuses it as a target.
    s.w.block(&m.migration);
    let a = admin(&s);
    let vault_id = 9u64;
    let custody = Pubkey::find_program_address(
        &[
            asset_registry::CUSTODY_SEED,
            s.fx.share_class.as_ref(),
            &vault_id.to_le_bytes(),
        ],
        &asset_registry::ID,
    )
    .0;
    let escrow = Pubkey::find_program_address(
        &[asset_registry::ESCROW_SEED, custody.as_ref()],
        &asset_registry::ID,
    )
    .0;
    s.w.send(
        &[&a],
        &[Instruction::new_with_bytes(
            asset_registry::ID,
            &asset_registry::instruction::OpenCustodyVault {
                vault_id,
                vault_type: asset_registry::VaultType::RedemptionQueue,
                realize_action: asset_registry::RealizeAction::BurnAndAttest,
                amount: 0,
                deadline: 0,
                metadata_hash: [1; 32],
                beneficiary: Pubkey::default(),
            }
            .data(),
            asset_registry::accounts::OpenCustodyVault {
                authority: a.pubkey(),
                admin_record: admin_pda(&a.pubkey()),
                share_class: s.fx.share_class,
                mint: s.fx.mint,
                custody_vault: custody,
                escrow,
                escrow_marker: marker_pda(&custody),
                token_program: TOKEN_2022,
                system_program: system_program::ID,
                platform: platform_pda(),
                kyc_registry: None,
            }
            .to_account_metas(None),
        )],
        "open the quarantine vault",
    );
    let mut metas = asset_registry::accounts::ClawbackBlocklistedHolder {
        authority: a.pubkey(),
        admin_record: admin_pda(&a.pubkey()),
        share_class: s.fx.share_class,
        mint: s.fx.mint,
        holder_share_account: m.vault(),
        holder_escrow_marker: m.identity(),
        block_entry: block_entry_pda(&m.migration),
        destination: escrow,
        custody_vault: custody,
        hook_config: hook_config_pda(&s.fx.mint),
        token_program: TOKEN_2022,
    }
    .to_account_metas(None);
    metas.extend([
        AccountMeta::new_readonly(block_entry_pda(&m.migration), false),
        AccountMeta::new_readonly(extra_metas_pda(&s.fx.mint), false),
        AccountMeta::new_readonly(transfer_hook::ID, false),
    ]);
    let ix = Instruction::new_with_bytes(
        asset_registry::ID,
        &asset_registry::instruction::ClawbackBlocklistedHolder {
            holder: m.migration,
            amount: 0,
        }
        .data(),
        metas,
    );
    expect_code(&mut s, &[&a], &[ix], 6087, "the vault is not a holder");
    assert_eq!(balance(&s.w, &m.vault()), 10);
}
