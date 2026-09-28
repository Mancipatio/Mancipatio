//! v1.0.0-rc fixtures (design 8.3) for the asset_registry host tests: the new
//! PDAs (hook BlockEntry, IssuerFreeze, PendingAdmin, AuthorityProposal,
//! PlatformRecovery), the timelocked admin grant, and the chain accounts the
//! D1 gates append (share class -> asset -> issuer).
//!
//! `grant_admin` runs the real two-step grant (`propose_admin` by the super
//! admin, `add_admin` signed by the new key). While the one-way bootstrap
//! window is open both go in one transaction; afterwards the clock is moved
//! to the eta for the `add_admin` and put back — an Admin record carries no
//! timestamp, so no other state depends on it. The timelock itself is
//! exercised in `test_admin_timelock.rs`.
#![allow(dead_code)]
use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_program},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use asset_registry::{accounts as acc, instruction as ixd};
use litesvm::LiteSVM;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

pub const ERR_ISSUER_PROCEEDS_FROZEN: u32 = 6143;
pub const ERR_PARTY_BLOCKLISTED: u32 = 6144;
pub const ERR_SALE_DURATION_INVALID: u32 = 6145;
pub const ERR_KYC_EXPIRY_TOO_FAR: u32 = 6146;
pub const ERR_VOTING_PERIOD_TOO_SHORT: u32 = 6147;
pub const ERR_DELIVERY_DEADLINE_OUT_OF_RANGE: u32 = 6148;
pub const ERR_DEAL_EXPIRY_OUT_OF_RANGE: u32 = 6149;
pub const ERR_TIMELOCK_ACTIVE: u32 = 6150;
pub const ERR_PROPOSAL_EXPIRED: u32 = 6151;
pub const ERR_INVALID_ADMIN_PROPOSAL: u32 = 6152;
pub const ERR_INVALID_PLATFORM_RECOVERY: u32 = 6153;
pub const ERR_PAYOUT_MODULES_CLEAR_NOT_EXPLICIT: u32 = 6154;

/// Everything but `PAUSE_PAYOUT_MODULES`: bits 0-5 and the bootstrap marker.
pub const CLEAR_ALL_BUT_MODULES: u8 = !asset_registry::PAUSE_PAYOUT_MODULES;

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &asset_registry::ID).0
}

/// The transfer hook's `["blocked", wallet]` BlockEntry PDA.
pub fn block_entry(wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::HOOK_BLOCK_ENTRY_SEED, wallet.as_ref()],
        &transfer_hook::ID,
    )
    .0
}

pub fn issuer_freeze(issuer: &Pubkey) -> Pubkey {
    pda(&[asset_registry::ISSUER_FREEZE_SEED, issuer.as_ref()])
}

pub fn pending_admin(new_admin: &Pubkey) -> Pubkey {
    pda(&[asset_registry::PENDING_ADMIN_SEED, new_admin.as_ref()])
}

pub fn authority_proposal(target: &Pubkey) -> Pubkey {
    pda(&[asset_registry::AUTHORITY_PROPOSAL_SEED, target.as_ref()])
}

pub fn platform_pda() -> Pubkey {
    pda(&[asset_registry::PLATFORM_SEED])
}

pub fn admin_pda(wallet: &Pubkey) -> Pubkey {
    pda(&[asset_registry::ADMIN_SEED, wallet.as_ref()])
}

pub fn platform_recovery() -> Pubkey {
    pda(&[
        asset_registry::PLATFORM_RECOVERY_SEED,
        platform_pda().as_ref(),
    ])
}

pub fn program_data(program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[program.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )
    .0
}

/// `(asset, issuer)` of a share class, read from chain.
pub fn chain_of(svm: &LiteSVM, share_class: &Pubkey) -> (Pubkey, Pubkey) {
    let sc = svm.get_account(share_class).expect("share class");
    let sc = asset_registry::ShareClass::try_deserialize(&mut sc.data.as_slice()).unwrap();
    let asset = svm.get_account(&sc.asset).expect("asset");
    let asset_state = asset_registry::Asset::try_deserialize(&mut asset.data.as_slice()).unwrap();
    (sc.asset, asset_state.issuer)
}

fn load<T: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> T {
    let account = svm
        .get_account(key)
        .unwrap_or_else(|| panic!("account {key} missing"));
    T::try_deserialize(&mut account.data.as_slice()).expect("decode")
}

/// The D1 chain behind a sale or payout vault: share class -> asset -> issuer.
pub struct Chain {
    pub share_class: Pubkey,
    pub asset: Pubkey,
    pub issuer: Pubkey,
}

fn chain(svm: &LiteSVM, share_class: Pubkey) -> Chain {
    let (asset, issuer) = chain_of(svm, &share_class);
    Chain {
        share_class,
        asset,
        issuer,
    }
}

pub fn sale_chain(svm: &LiteSVM, sale: &Pubkey) -> Chain {
    chain(svm, load::<asset_registry::Sale>(svm, sale).share_class)
}

pub fn vault_chain(svm: &LiteSVM, vault: &Pubkey) -> Chain {
    chain(
        svm,
        load::<asset_registry::PayoutVault>(svm, vault).share_class,
    )
}

pub fn vault_founder(svm: &LiteSVM, vault: &Pubkey) -> Pubkey {
    load::<asset_registry::PayoutVault>(svm, vault).founder
}

pub fn offer_maker(svm: &LiteSVM, offer: &Pubkey) -> Pubkey {
    load::<asset_registry::Offer>(svm, offer).maker
}

/// `(buyer, seller)` of an OTC deal.
pub fn deal_parties(svm: &LiteSVM, deal: &Pubkey) -> (Pubkey, Pubkey) {
    let d = load::<asset_registry::OtcDeal>(svm, deal);
    (d.buyer, d.seller)
}

/// The owner of an SPL / Token-2022 token account (bytes 32..64).
pub fn token_owner(svm: &LiteSVM, token_account: &Pubkey) -> Pubkey {
    let data = svm
        .get_account(token_account)
        .unwrap_or_else(|| panic!("token account {token_account} missing"))
        .data;
    Pubkey::new_from_array(data[32..64].try_into().unwrap())
}

/// The Platform's raw pause byte (offset 74), bit 7 included.
pub fn pause_byte(svm: &LiteSVM) -> u8 {
    svm.get_account(&platform_pda()).expect("Platform").data[74]
}

pub fn bootstrap_open(svm: &LiteSVM) -> bool {
    pause_byte(svm) & asset_registry::PLATFORM_BOOTSTRAP_OPEN != 0
}

pub fn propose_admin_ix(super_admin: &Pubkey, new_admin: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::ProposeAdmin {
            new_admin: *new_admin,
        }
        .data(),
        acc::ProposeAdmin {
            super_admin: *super_admin,
            platform: platform_pda(),
            new_admin_record: admin_pda(new_admin),
            pending_admin: pending_admin(new_admin),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// `add_admin` signed by `signer` for the proposal of `arg` (normally the
/// same key), refunding `proposer`.
pub fn add_admin_ix_with(
    signer: &Pubkey,
    arg: &Pubkey,
    pending: &Pubkey,
    proposer: &Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::AddAdmin { new_admin: *arg }.data(),
        acc::AddAdmin {
            new_admin: *signer,
            platform: platform_pda(),
            pending_admin: *pending,
            proposer: *proposer,
            admin_record: admin_pda(signer),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn add_admin_ix(new_admin: &Pubkey, proposer: &Pubkey) -> Instruction {
    add_admin_ix_with(new_admin, new_admin, &pending_admin(new_admin), proposer)
}

pub fn cancel_admin_proposal_ix(
    canceller: &Pubkey,
    new_admin: &Pubkey,
    proposer: &Pubkey,
) -> Instruction {
    cancel_admin_proposal_ix_with(
        canceller,
        new_admin,
        proposer,
        &program_data(&asset_registry::ID),
    )
}

pub fn cancel_admin_proposal_ix_with(
    canceller: &Pubkey,
    new_admin: &Pubkey,
    proposer: &Pubkey,
    program_data: &Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::CancelAdminProposal {}.data(),
        acc::CancelAdminProposal {
            canceller: *canceller,
            canceller_admin_record: admin_pda(canceller),
            platform: platform_pda(),
            pending_admin: pending_admin(new_admin),
            proposer: *proposer,
            program: asset_registry::ID,
            program_data: *program_data,
        }
        .to_account_metas(None),
    )
}

/// Sends `ixs` paid by the first signer.
pub fn send(
    svm: &mut LiteSVM,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<Vec<String>, String> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &svm.latest_blockhash());
    let mut unique: Vec<&Keypair> = Vec::new();
    for s in signers {
        if !unique.iter().any(|k| k.pubkey() == s.pubkey()) {
            unique.push(s);
        }
    }
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &unique)
        .map_err(|e| format!("sign: {e:?}"))?;
    svm.send_transaction(tx)
        .map(|meta| meta.logs)
        .map_err(|e| format!("{e:?}"))
}

/// The v1 two-step admin grant (see the module doc). The new key pays its
/// Admin record's rent, so it is topped up first when it holds too little.
pub fn grant_admin(
    svm: &mut LiteSVM,
    super_admin: &Keypair,
    new_admin: &Keypair,
) -> Result<(), String> {
    if svm.get_balance(&new_admin.pubkey()).unwrap_or(0) < 10_000_000 {
        svm.airdrop(&new_admin.pubkey(), 1_000_000_000)
            .map_err(|e| format!("airdrop: {e:?}"))?;
    }
    let propose = propose_admin_ix(&super_admin.pubkey(), &new_admin.pubkey());
    let add = add_admin_ix(&new_admin.pubkey(), &super_admin.pubkey());
    if bootstrap_open(svm) {
        return send(svm, &[super_admin, new_admin], &[propose, add]).map(|_| ());
    }
    send(svm, &[super_admin], &[propose])?;
    let clock: Clock = svm.get_sysvar();
    let mut at_eta = clock.clone();
    at_eta.unix_timestamp = clock
        .unix_timestamp
        .checked_add(asset_registry::ADMIN_TIMELOCK_SECS)
        .unwrap();
    svm.set_sysvar(&at_eta);
    let result = send(svm, &[new_admin], &[add]).map(|_| ());
    svm.set_sysvar(&clock);
    result
}

/// Clears every pause bit and the bootstrap marker the v1 way: bits 0-5 and
/// bit 7 in one call, then `PAUSE_PAYOUT_MODULES` in a call of its own.
pub fn unpause_everything(svm: &mut LiteSVM, super_admin: &Keypair) -> Result<(), String> {
    let set = |svm: &mut LiteSVM, clear: u8| {
        send(
            svm,
            &[super_admin],
            &[Instruction::new_with_bytes(
                asset_registry::ID,
                &ixd::SetPauseFlags {
                    set_mask: 0,
                    clear_mask: clear,
                }
                .data(),
                acc::SetPauseFlags {
                    authority: super_admin.pubkey(),
                    admin_record: admin_pda(&super_admin.pubkey()),
                    platform: platform_pda(),
                }
                .to_account_metas(None),
            )],
        )
    };
    set(svm, CLEAR_ALL_BUT_MODULES)?;
    if pause_byte(svm) & asset_registry::PAUSE_PAYOUT_MODULES != 0 {
        set(svm, asset_registry::PAUSE_PAYOUT_MODULES)?;
    }
    assert_eq!(pause_byte(svm), 0, "fully unpaused");
    Ok(())
}

/// Writes the hook `BlockEntry` of `wallet` exactly as `add_to_blocklist`
/// leaves it (hook-owned, discriminator, wallet, added_by, bump): the state
/// the registry's party checks read. For suites without a BlocklistAuthority;
/// `issuer::World::block` runs the real hook instruction.
pub fn fabricate_block_entry(svm: &mut LiteSVM, wallet: &Pubkey) {
    let mut data = asset_registry::HOOK_BLOCK_ENTRY_DISCRIMINATOR.to_vec();
    data.extend_from_slice(wallet.as_ref());
    data.extend_from_slice(Pubkey::new_unique().as_ref());
    data.push(255);
    assert_eq!(data.len(), asset_registry::HOOK_BLOCK_ENTRY_LEN);
    // Any live account as the template: every field is overwritten.
    let mut account = svm.get_account(&platform_pda()).expect("Platform");
    account.lamports = svm.minimum_balance_for_rent_exemption(data.len());
    account.data = data;
    account.owner = transfer_hook::ID;
    account.executable = false;
    svm.set_account(block_entry(wallet), account).unwrap();
}

/// The state `remove_from_blocklist` leaves: no account (closed).
pub fn clear_block_entry(svm: &mut LiteSVM, wallet: &Pubkey) {
    let mut account = svm.get_account(&platform_pda()).expect("Platform");
    account.lamports = 0;
    account.data = vec![];
    account.owner = system_program::ID;
    account.executable = false;
    svm.set_account(block_entry(wallet), account).unwrap();
}

/// `freeze_issuer_proceeds` signed by `authority` (an Admin or the super admin).
pub fn freeze_issuer_ix(authority: &Pubkey, issuer: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::FreezeIssuerProceeds {
            reason_hash: [5u8; 32],
        }
        .data(),
        acc::FreezeIssuerProceeds {
            authority: *authority,
            admin_record: admin_pda(authority),
            platform: platform_pda(),
            issuer: *issuer,
            issuer_freeze: issuer_freeze(issuer),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// The v1 test clock start.
pub const T0: i64 = 1_000_000;

pub fn funded(svm: &mut LiteSVM) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    k
}

/// Both programs at clock `T0` and a Platform whose super admin (`sa`) and
/// program upgrade authority (`ua`, also the hook's) are different keys;
/// `unpause` runs the first unpause (closing the bootstrap window).
/// Returns `(svm, sa, ua)`. The including test declares `mod support`.
pub fn boot_platform(unpause: bool) -> (LiteSVM, Keypair, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program(
        asset_registry::ID,
        super::support::assert_sbpf_v3(include_bytes!("../../target/deploy/asset_registry.so")),
    )
    .unwrap();
    svm.add_program(
        transfer_hook::ID,
        super::support::assert_sbpf_v3(include_bytes!("../../target/deploy/transfer_hook.so")),
    )
    .unwrap();
    warp_to(&mut svm, T0);
    let sa = funded(&mut svm);
    let ua = funded(&mut svm);
    set_upgrade_authority(&mut svm, &asset_registry::ID, Some(ua.pubkey()));
    set_upgrade_authority(&mut svm, &transfer_hook::ID, Some(ua.pubkey()));
    let init = Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::InitializePlatform {
            protocol_treasury: Pubkey::new_unique(),
            protocol_fee_bps: 250,
        }
        .data(),
        acc::InitializePlatform {
            admin: sa.pubkey(),
            platform: platform_pda(),
            super_admin_record: admin_pda(&sa.pubkey()),
            system_program: system_program::ID,
            upgrade_authority: ua.pubkey(),
            program: asset_registry::ID,
            program_data: program_data(&asset_registry::ID),
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[&sa, &ua], &[init]).expect("initialize_platform");
    assert_eq!(pause_byte(&svm), 0xFF);
    if unpause {
        unpause_everything(&mut svm, &sa).unwrap();
    }
    (svm, sa, ua)
}

// ── Super-admin rotation (D3) and recovery (D4) builders ────────────────────

pub fn propose_platform_admin_ix(super_admin: &Pubkey, new_admin: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::ProposePlatformAdmin {
            new_admin: *new_admin,
        }
        .data(),
        acc::ProposePlatformAdmin {
            authority: *super_admin,
            platform: platform_pda(),
            transfer: authority_proposal(&platform_pda()),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn accept_platform_admin_ix(new_admin: &Pubkey, current: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::AcceptPlatformAdmin {}.data(),
        acc::AcceptPlatformAdmin {
            new_admin: *new_admin,
            platform: platform_pda(),
            transfer: authority_proposal(&platform_pda()),
            old_admin_record: admin_pda(current),
            new_admin_record: admin_pda(new_admin),
            system_program: system_program::ID,
            recovery: platform_recovery(),
        }
        .to_account_metas(None),
    )
}

pub fn cancel_platform_admin_transfer_ix(
    canceller: &Pubkey,
    proposer: &Pubkey,
    program_data: &Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::CancelPlatformAdminTransfer {}.data(),
        acc::CancelPlatformAdminTransfer {
            canceller: *canceller,
            canceller_admin_record: admin_pda(canceller),
            platform: platform_pda(),
            transfer: authority_proposal(&platform_pda()),
            proposer: *proposer,
            program: asset_registry::ID,
            program_data: *program_data,
        }
        .to_account_metas(None),
    )
}

pub fn propose_platform_recovery_ix(
    upgrade_authority: &Pubkey,
    new_admin: &Pubkey,
    program_data: &Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::ProposePlatformRecovery {
            new_admin: *new_admin,
        }
        .data(),
        acc::ProposePlatformRecovery {
            upgrade_authority: *upgrade_authority,
            platform: platform_pda(),
            recovery: platform_recovery(),
            program: asset_registry::ID,
            program_data: *program_data,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn cancel_platform_recovery_ix(canceller: &Pubkey, proposer: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::CancelPlatformRecovery {}.data(),
        acc::CancelPlatformRecovery {
            canceller: *canceller,
            platform: platform_pda(),
            recovery: platform_recovery(),
            proposer: *proposer,
        }
        .to_account_metas(None),
    )
}

pub fn execute_platform_recovery_ix(
    new_admin: &Pubkey,
    current: &Pubkey,
    proposer: &Pubkey,
    program_data: &Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::ExecutePlatformRecovery {}.data(),
        acc::ExecutePlatformRecovery {
            new_admin: *new_admin,
            platform: platform_pda(),
            recovery: platform_recovery(),
            proposer: *proposer,
            program: asset_registry::ID,
            program_data: *program_data,
            old_admin_record: admin_pda(current),
            new_admin_record: admin_pda(new_admin),
            transfer: authority_proposal(&platform_pda()),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn remove_admin_ix(super_admin: &Pubkey, admin: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::RemoveAdmin { admin: *admin }.data(),
        acc::RemoveAdmin {
            super_admin: *super_admin,
            platform: platform_pda(),
            admin_record: admin_pda(admin),
        }
        .to_account_metas(None),
    )
}

pub fn set_pause_flags_ix(authority: &Pubkey, set_mask: u8, clear_mask: u8) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::SetPauseFlags {
            set_mask,
            clear_mask,
        }
        .data(),
        acc::SetPauseFlags {
            authority: *authority,
            admin_record: admin_pda(authority),
            platform: platform_pda(),
        }
        .to_account_metas(None),
    )
}

pub fn set_pause_ix(super_admin: &Pubkey, paused: bool) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::SetPause { paused }.data(),
        acc::SetPause {
            admin: *super_admin,
            platform: platform_pda(),
        }
        .to_account_metas(None),
    )
}

/// Sets the ProgramData upgrade authority of `program` (LiteSVM loads
/// programs with none).
pub fn set_upgrade_authority(svm: &mut LiteSVM, program: &Pubkey, authority: Option<Pubkey>) {
    let address = program_data(program);
    let mut account = svm.get_account(&address).expect("loaded ProgramData");
    account.data[12] = u8::from(authority.is_some());
    account.data[13..45].fill(0);
    if let Some(authority) = authority {
        account.data[13..45].copy_from_slice(authority.as_ref());
    }
    svm.set_account(address, account)
        .expect("set upgrade authority");
}

pub fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

pub fn warp_to(svm: &mut LiteSVM, unix_ts: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_ts;
    svm.set_sysvar(&clock);
}

/// Every Anchor event of type `E` in `logs`.
pub fn events<E: anchor_lang::AnchorDeserialize + anchor_lang::Discriminator>(
    logs: &[String],
) -> Vec<E> {
    use anchor_lang::__private::base64::{engine::general_purpose::STANDARD, Engine as _};
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|b64| STANDARD.decode(b64).ok())
        .filter(|data| data.starts_with(E::DISCRIMINATOR))
        .map(|data| E::try_from_slice(&data[E::DISCRIMINATOR.len()..]).expect("event"))
        .collect()
}

pub fn assert_code(result: Result<Vec<String>, String>, code: u32, what: &str) {
    let err = result.expect_err(what);
    assert!(
        err.contains(&format!("Custom({code})")),
        "{what}: expected {code}, got {err}"
    );
}
