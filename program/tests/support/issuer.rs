//! Issuer fixtures (2C-2) for the asset_registry host tests: a booted platform
//! with a separate super admin and fee payer, PDAs, and instruction builders
//! for the issuer lifecycle (register / verify / grant / asset / share class /
//! mint / activate) and the issuer authority rotation, recovery and sync
//! instructions. Extracted from `test_payout_vault.rs::setup_sale`, with the
//! issuer authority decoupled from the super admin.
//!
//! The including test also declares `mod support` (`tests/support/mod.rs`).
#![allow(dead_code)]
use anchor_lang::{
    __private::base64::{engine::general_purpose::STANDARD, Engine as _},
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_program},
    AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
};
use asset_registry::{
    accounts as acc, instruction as ixd, AssetType, JurisdictionRules, ShareClassType,
    RIGHT_DIVIDEND, RIGHT_VOTE,
};
use litesvm::LiteSVM;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

pub const TOKEN_2022: Pubkey = spl_token_2022_interface::id();
pub const ERR_UNAUTHORIZED: u32 = 6001;
pub const ERR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;
pub const ERR_ACCOUNT_NOT_SIGNER: u32 = 3010;
pub const ERR_CONSTRAINT_SEEDS: u32 = 2006;
pub const ASSET_ID: &str = "rot-001";

// ── PDAs ─────────────────────────────────────────────────────────────────────

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &asset_registry::ID).0
}
pub fn platform_pda() -> Pubkey {
    pda(&[asset_registry::PLATFORM_SEED])
}
pub fn admin_pda(wallet: &Pubkey) -> Pubkey {
    pda(&[asset_registry::ADMIN_SEED, wallet.as_ref()])
}
pub fn issuer_pda(legal_entity_id: &[u8; 32]) -> Pubkey {
    pda(&[asset_registry::ISSUER_SEED, legal_entity_id])
}
pub fn asset_pda(issuer: &Pubkey, asset_id: &str) -> Pubkey {
    pda(&[
        asset_registry::ASSET_SEED,
        issuer.as_ref(),
        asset_id.as_bytes(),
    ])
}
pub fn share_class_pda(asset: &Pubkey, class_index: u8) -> Pubkey {
    pda(&[
        asset_registry::SHARE_CLASS_SEED,
        asset.as_ref(),
        &[class_index],
    ])
}
pub fn share_mint_pda(share_class: &Pubkey) -> Pubkey {
    pda(&[asset_registry::SHARE_MINT_SEED, share_class.as_ref()])
}
pub fn permissions_pda(issuer: &Pubkey, authority: &Pubkey) -> Pubkey {
    pda(&[
        asset_registry::ISSUER_PERMISSIONS_SEED,
        issuer.as_ref(),
        authority.as_ref(),
    ])
}
pub fn transfer_pda(target: &Pubkey) -> Pubkey {
    pda(&[asset_registry::AUTHORITY_TRANSFER_SEED, target.as_ref()])
}
pub fn recovery_pda(issuer: &Pubkey) -> Pubkey {
    pda(&[asset_registry::ISSUER_RECOVERY_SEED, issuer.as_ref()])
}
pub fn sale_pda(share_class: &Pubkey, sale_id: u64) -> Pubkey {
    pda(&[
        asset_registry::SALE_SEED,
        share_class.as_ref(),
        &sale_id.to_le_bytes(),
    ])
}
pub fn proceeds_pda(sale: &Pubkey) -> Pubkey {
    pda(&[asset_registry::PROCEEDS_SEED, sale.as_ref()])
}
pub fn payout_pda(sale: &Pubkey) -> Pubkey {
    pda(&[asset_registry::PAYOUT_SEED, sale.as_ref()])
}
pub fn payout_escrow_pda(vault: &Pubkey) -> Pubkey {
    pda(&[asset_registry::PAYOUT_ESCROW_SEED, vault.as_ref()])
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

// ── Harness ──────────────────────────────────────────────────────────────────

pub struct World {
    pub svm: LiteSVM,
    /// Pays every fee, so signer balances move only by rent.
    pub fees: Keypair,
    /// `Platform.admin` (the super admin, with an Admin record).
    pub admin: Keypair,
    /// `Platform.protocol_treasury` (receives the platform's yield share).
    pub treasury: Pubkey,
}

impl World {
    /// Both programs, a platform whose super admin is `admin`, unpaused.
    pub fn boot() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(
            asset_registry::ID,
            include_bytes!("../../target/deploy/asset_registry.so"),
        )
        .unwrap();
        svm.add_program(
            transfer_hook::id(),
            include_bytes!("../../target/deploy/transfer_hook.so"),
        )
        .unwrap();
        let fees = Keypair::new();
        svm.airdrop(&fees.pubkey(), 1_000_000_000_000).unwrap();
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
        let treasury = Pubkey::new_unique();
        let mut world = Self {
            svm,
            fees,
            admin,
            treasury,
        };
        super::support::set_upgrade_authority(
            &mut world.svm,
            &asset_registry::ID,
            Some(world.admin.pubkey()),
        );
        let admin = world.admin.insecure_clone();
        world.send(
            &[&admin],
            &[Instruction::new_with_bytes(
                asset_registry::ID,
                &ixd::InitializePlatform {
                    protocol_treasury: world.treasury,
                    protocol_fee_bps: 250,
                }
                .data(),
                acc::InitializePlatform {
                    admin: admin.pubkey(),
                    upgrade_authority: admin.pubkey(),
                    program: asset_registry::ID,
                    program_data: super::support::program_data(&asset_registry::ID),
                    platform: platform_pda(),
                    super_admin_record: admin_pda(&admin.pubkey()),
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
            )],
            "initialize_platform",
        );
        world.set_pause(0, asset_registry::PAUSE_FLAGS_ALL);
        world
    }

    pub fn funded(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        k
    }

    pub fn try_send(
        &mut self,
        signers: &[&Keypair],
        ixs: &[Instruction],
    ) -> Result<Vec<String>, String> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(
            ixs,
            Some(&self.fees.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let mut all: Vec<&Keypair> = vec![&self.fees];
        for s in signers {
            if !all.iter().any(|k| k.pubkey() == s.pubkey()) {
                all.push(s);
            }
        }
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all)
            .map_err(|e| format!("sign: {e:?}"))?;
        self.svm
            .send_transaction(tx)
            .map(|meta| meta.logs)
            .map_err(|e| format!("{e:?}"))
    }

    pub fn send(&mut self, signers: &[&Keypair], ixs: &[Instruction], label: &str) -> Vec<String> {
        self.try_send(signers, ixs)
            .unwrap_or_else(|e| panic!("[{label}] tx failed: {e}"))
    }

    pub fn expect_code(
        &mut self,
        signers: &[&Keypair],
        ixs: &[Instruction],
        code: u32,
        what: &str,
    ) {
        let err = self.try_send(signers, ixs).expect_err(what);
        assert!(
            err.contains(&format!("Custom({code})")),
            "{what}: expected {code}, got {err}"
        );
    }

    pub fn load<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let account = self.svm.get_account(key).expect("account missing");
        T::try_deserialize(&mut account.data.as_slice()).expect("decode")
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map_or(0, |a| a.lamports)
    }

    pub fn data_len(&self, key: &Pubkey) -> usize {
        self.svm.get_account(key).map_or(0, |a| a.data.len())
    }

    pub fn is_closed(&self, key: &Pubkey) -> bool {
        self.svm
            .get_account(key)
            .is_none_or(|a| a.lamports == 0 && a.data.is_empty())
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn warp_to(&mut self, unix_ts: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix_ts;
        self.svm.set_sysvar(&clock);
    }

    /// `set_pause_flags` by the super admin.
    pub fn set_pause(&mut self, set_mask: u8, clear_mask: u8) {
        let admin = self.admin.insecure_clone();
        self.send(
            &[&admin],
            &[Instruction::new_with_bytes(
                asset_registry::ID,
                &ixd::SetPauseFlags {
                    set_mask,
                    clear_mask,
                }
                .data(),
                acc::SetPauseFlags {
                    authority: admin.pubkey(),
                    admin_record: admin_pda(&admin.pubkey()),
                    platform: platform_pda(),
                }
                .to_account_metas(None),
            )],
            "set_pause_flags",
        );
    }

    /// Registers an issuer (signed by `authority`), leaving KYB Pending.
    pub fn register(&mut self, authority: &Keypair, legal_entity_id: [u8; 32]) -> Pubkey {
        self.send(
            &[authority],
            &[register_issuer_ix(&authority.pubkey(), legal_entity_id)],
            "register_issuer",
        );
        issuer_pda(&legal_entity_id)
    }

    /// `verify_issuer_kyb(approved)` by the super admin.
    pub fn set_kyb(&mut self, issuer: &Pubkey, approved: bool) {
        let admin = self.admin.insecure_clone();
        self.send(
            &[&admin],
            &[verify_kyb_ix(&admin.pubkey(), issuer, approved)],
            "verify_issuer_kyb",
        );
    }

    /// `set_issuer_permissions(capabilities)` by the super admin for the
    /// issuer's LIVE authority.
    pub fn grant(&mut self, issuer: &Pubkey, capabilities: u8) {
        let admin = self.admin.insecure_clone();
        let authority = self.load::<asset_registry::Issuer>(issuer).authority;
        self.send(
            &[&admin],
            &[set_permissions_ix(
                &admin.pubkey(),
                issuer,
                &authority,
                capabilities,
            )],
            "set_issuer_permissions",
        );
    }

    /// Verified issuer owned by `authority` with a MINT|METADATA grant, one
    /// asset (`ASSET_ID`) with share class 0 and its mint, activated.
    pub fn issuer_with_asset(&mut self, authority: &Keypair, legal_entity_id: [u8; 32]) -> Fixture {
        let issuer = self.register(authority, legal_entity_id);
        self.set_kyb(&issuer, true);
        self.grant(
            &issuer,
            asset_registry::ISSUER_PERMISSION_MINT | asset_registry::ISSUER_PERMISSION_METADATA,
        );
        let fx = self.asset_under(authority, &issuer, ASSET_ID);
        self.init_mint(authority, &fx);
        self.activate(&fx);
        fx
    }

    /// `create_asset` + `add_share_class(0)` signed by `authority`.
    pub fn asset_under(&mut self, authority: &Keypair, issuer: &Pubkey, asset_id: &str) -> Fixture {
        let fx = Fixture::new(*issuer, asset_id);
        self.send(
            &[authority],
            &[create_asset_ix(&authority.pubkey(), issuer, asset_id)],
            "create_asset",
        );
        self.send(
            &[authority],
            &[add_share_class_ix(&authority.pubkey(), issuer, &fx.asset)],
            "add_share_class",
        );
        fx
    }

    pub fn init_mint(&mut self, authority: &Keypair, fx: &Fixture) {
        self.send(
            &[authority],
            &[init_mint_ix(&authority.pubkey(), fx)],
            "initialize_share_class_mint",
        );
    }

    pub fn activate(&mut self, fx: &Fixture) {
        let admin = self.admin.insecure_clone();
        self.send(
            &[&admin],
            &[Instruction::new_with_bytes(
                asset_registry::ID,
                &ixd::ActivateAsset {}.data(),
                acc::ActivateAsset {
                    authority: admin.pubkey(),
                    admin_record: admin_pda(&admin.pubkey()),
                    issuer: fx.issuer,
                    asset: fx.asset,
                }
                .to_account_metas(None),
            )],
            "activate_asset",
        );
    }

    /// propose (by `from`) + accept (by `to`), asserting success.
    pub fn rotate(&mut self, issuer: &Pubkey, from: &Keypair, to: &Keypair) -> Vec<String> {
        self.send(
            &[from],
            &[propose_issuer_authority_ix(
                &from.pubkey(),
                issuer,
                &to.pubkey(),
            )],
            "propose_issuer_authority",
        );
        let ix = accept_issuer_authority_ix(&to.pubkey(), issuer, &from.pubkey());
        self.send(&[to], &[ix], "accept_issuer_authority")
    }

    /// `propose_issuer_recovery` by the super admin.
    pub fn propose_recovery(&mut self, issuer: &Pubkey, new_authority: &Pubkey) -> Vec<String> {
        let admin = self.admin.insecure_clone();
        self.send(
            &[&admin],
            &[propose_issuer_recovery_ix(
                &admin.pubkey(),
                issuer,
                new_authority,
            )],
            "propose_issuer_recovery",
        )
    }
}

/// One issuer's asset, share class 0 and its mint.
#[derive(Clone, Copy, Debug)]
pub struct Fixture {
    pub issuer: Pubkey,
    pub asset: Pubkey,
    pub share_class: Pubkey,
    pub mint: Pubkey,
}

impl Fixture {
    pub fn new(issuer: Pubkey, asset_id: &str) -> Self {
        let asset = asset_pda(&issuer, asset_id);
        let share_class = share_class_pda(&asset, 0);
        Self {
            issuer,
            asset,
            share_class,
            mint: share_mint_pda(&share_class),
        }
    }
}

pub fn legal_id(tag: u8) -> [u8; 32] {
    let mut id = *b"ROTATION-TEST-ENTITY-00000000000";
    id[31] = tag;
    id
}

// ── Lifecycle builders ───────────────────────────────────────────────────────

fn ix(
    data: Vec<u8>,
    metas: Vec<anchor_lang::solana_program::instruction::AccountMeta>,
) -> Instruction {
    Instruction::new_with_bytes(asset_registry::ID, &data, metas)
}

pub fn register_issuer_ix(authority: &Pubkey, legal_entity_id: [u8; 32]) -> Instruction {
    ix(
        ixd::RegisterIssuer {
            legal_entity_id,
            jurisdiction: 222,
            kyb_doc_hash: [9u8; 32],
        }
        .data(),
        acc::RegisterIssuer {
            authority: *authority,
            platform: platform_pda(),
            issuer: issuer_pda(&legal_entity_id),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn verify_kyb_ix(admin: &Pubkey, issuer: &Pubkey, approved: bool) -> Instruction {
    ix(
        ixd::VerifyIssuerKyb { approved }.data(),
        acc::VerifyIssuerKyb {
            admin: *admin,
            platform: platform_pda(),
            issuer: *issuer,
        }
        .to_account_metas(None),
    )
}

pub fn set_permissions_ix(
    super_admin: &Pubkey,
    issuer: &Pubkey,
    authority: &Pubkey,
    capabilities: u8,
) -> Instruction {
    ix(
        ixd::SetIssuerPermissions { capabilities }.data(),
        acc::SetIssuerPermissions {
            super_admin: *super_admin,
            platform: platform_pda(),
            issuer: *issuer,
            permissions: permissions_pda(issuer, authority),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn recover_registration_ix(
    super_admin: &Pubkey,
    issuer: &Pubkey,
    new_authority: &Pubkey,
) -> Instruction {
    ix(
        ixd::RecoverIssuerRegistration {
            jurisdiction: 191,
            kyb_doc_hash: [5u8; 32],
        }
        .data(),
        acc::RecoverIssuerRegistration {
            super_admin: *super_admin,
            platform: platform_pda(),
            issuer: *issuer,
            new_authority: *new_authority,
        }
        .to_account_metas(None),
    )
}

pub fn create_asset_ix(authority: &Pubkey, issuer: &Pubkey, asset_id: &str) -> Instruction {
    ix(
        ixd::CreateAsset {
            asset_id: asset_id.to_string(),
            asset_type: AssetType::Equity,
            name: "Rotation Equity".to_string(),
            symbol_prefix: "ROT".to_string(),
            legal_doc_hash: [3u8; 32],
            jurisdiction_rules: JurisdictionRules {
                allowed_countries: [0u8; 128],
                max_holders: 0,
                restricted_period_end: 0,
                allow_p2p: true,
            },
        }
        .data(),
        acc::CreateAsset {
            authority: *authority,
            platform: platform_pda(),
            issuer: *issuer,
            asset: asset_pda(issuer, asset_id),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn add_share_class_ix(authority: &Pubkey, issuer: &Pubkey, asset: &Pubkey) -> Instruction {
    ix(
        ixd::AddShareClass {
            class_index: 0,
            class_type: ShareClassType::Common,
            rights_bitfield: RIGHT_VOTE | RIGHT_DIVIDEND,
            liq_pref_multiplier_bps: 10_000,
            liq_seniority: 0,
            voting_weight: 1,
            max_supply: None,
            mintable_post_launch: false,
        }
        .data(),
        acc::AddShareClass {
            authority: *authority,
            platform: platform_pda(),
            issuer: *issuer,
            asset: *asset,
            share_class: share_class_pda(asset, 0),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn init_mint_ix(authority: &Pubkey, fx: &Fixture) -> Instruction {
    ix(
        ixd::InitializeShareClassMint {}.data(),
        acc::InitializeShareClassMint {
            authority: *authority,
            admin_record: permissions_pda(&fx.issuer, authority),
            issuer: fx.issuer,
            asset: fx.asset,
            share_class: fx.share_class,
            mint: fx.mint,
            hook_config: Pubkey::find_program_address(
                &[transfer_hook::HOOK_CONFIG_SEED, fx.mint.as_ref()],
                &transfer_hook::id(),
            )
            .0,
            extra_account_meta_list: Pubkey::find_program_address(
                &[transfer_hook::EXTRA_METAS_SEED, fx.mint.as_ref()],
                &transfer_hook::id(),
            )
            .0,
            transfer_hook_program: transfer_hook::id(),
            token_program: TOKEN_2022,
            system_program: system_program::ID,
            platform: platform_pda(),
        }
        .to_account_metas(None),
    )
}

/// `update_mint_metadata("uri", value)` proving the METADATA capability with
/// `authority`'s grant PDA.
pub fn update_uri_ix(authority: &Pubkey, fx: &Fixture, value: &str) -> Instruction {
    ix(
        ixd::UpdateMintMetadata {
            field: "uri".to_string(),
            value: value.to_string(),
        }
        .data(),
        acc::UpdateMintMetadata {
            authority: *authority,
            admin_record: permissions_pda(&fx.issuer, authority),
            issuer: fx.issuer,
            asset: fx.asset,
            share_class: fx.share_class,
            mint: fx.mint,
            token_program: TOKEN_2022,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

// ── 2C-2 builders ────────────────────────────────────────────────────────────

pub fn propose_issuer_authority_ix(
    authority: &Pubkey,
    issuer: &Pubkey,
    new_authority: &Pubkey,
) -> Instruction {
    propose_issuer_authority_ix_with(authority, issuer, new_authority, transfer_pda(issuer))
}

pub fn propose_issuer_authority_ix_with(
    authority: &Pubkey,
    issuer: &Pubkey,
    new_authority: &Pubkey,
    transfer: Pubkey,
) -> Instruction {
    ix(
        ixd::ProposeIssuerAuthority {
            new_authority: *new_authority,
        }
        .data(),
        acc::ProposeIssuerAuthority {
            authority: *authority,
            issuer: *issuer,
            transfer,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// `accept_issuer_authority`; `current` is the live authority (it seeds the
/// old grant PDA).
pub fn accept_issuer_authority_ix(
    new_authority: &Pubkey,
    issuer: &Pubkey,
    current: &Pubkey,
) -> Instruction {
    accept_issuer_authority_ix_with(new_authority, issuer, current, transfer_pda(issuer))
}

pub fn accept_issuer_authority_ix_with(
    new_authority: &Pubkey,
    issuer: &Pubkey,
    current: &Pubkey,
    transfer: Pubkey,
) -> Instruction {
    ix(
        ixd::AcceptIssuerAuthority {}.data(),
        acc::AcceptIssuerAuthority {
            new_authority: *new_authority,
            issuer: *issuer,
            transfer,
            old_permissions: permissions_pda(issuer, current),
            new_permissions: permissions_pda(issuer, new_authority),
            old_admin_record: admin_pda(current),
            new_admin_record: admin_pda(new_authority),
            recovery: recovery_pda(issuer),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn cancel_issuer_authority_transfer_ix(authority: &Pubkey, issuer: &Pubkey) -> Instruction {
    ix(
        ixd::CancelIssuerAuthorityTransfer {}.data(),
        acc::CancelIssuerAuthorityTransfer {
            authority: *authority,
            issuer: *issuer,
            transfer: transfer_pda(issuer),
        }
        .to_account_metas(None),
    )
}

pub fn propose_issuer_recovery_ix(
    super_admin: &Pubkey,
    issuer: &Pubkey,
    new_authority: &Pubkey,
) -> Instruction {
    ix(
        ixd::ProposeIssuerRecovery {
            new_authority: *new_authority,
        }
        .data(),
        acc::ProposeIssuerRecovery {
            super_admin: *super_admin,
            platform: platform_pda(),
            issuer: *issuer,
            recovery: recovery_pda(issuer),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn cancel_issuer_recovery_ix(
    canceller: &Pubkey,
    issuer: &Pubkey,
    proposer: &Pubkey,
) -> Instruction {
    ix(
        ixd::CancelIssuerRecovery {}.data(),
        acc::CancelIssuerRecovery {
            canceller: *canceller,
            platform: platform_pda(),
            issuer: *issuer,
            recovery: recovery_pda(issuer),
            proposer: *proposer,
        }
        .to_account_metas(None),
    )
}

/// `execute_issuer_recovery`; `current` is the live authority, `proposer` the
/// recovery's `proposed_by`.
pub fn execute_issuer_recovery_ix(
    new_authority: &Pubkey,
    issuer: &Pubkey,
    current: &Pubkey,
    proposer: &Pubkey,
) -> Instruction {
    ix(
        ixd::ExecuteIssuerRecovery {}.data(),
        acc::ExecuteIssuerRecovery {
            new_authority: *new_authority,
            platform: platform_pda(),
            issuer: *issuer,
            recovery: recovery_pda(issuer),
            proposer: *proposer,
            old_permissions: permissions_pda(issuer, current),
            new_permissions: permissions_pda(issuer, new_authority),
            new_admin_record: admin_pda(new_authority),
            transfer: transfer_pda(issuer),
        }
        .to_account_metas(None),
    )
}

pub fn sync_sale_authority_ix(sale: &Pubkey, fx: &Fixture) -> Instruction {
    sync_sale_authority_ix_with(sale, &fx.share_class, &fx.asset, &fx.issuer)
}

pub fn sync_sale_authority_ix_with(
    sale: &Pubkey,
    share_class: &Pubkey,
    asset: &Pubkey,
    issuer: &Pubkey,
) -> Instruction {
    ix(
        ixd::SyncSaleAuthority {}.data(),
        acc::SyncSaleAuthority {
            sale: *sale,
            share_class: *share_class,
            asset: *asset,
            issuer: *issuer,
        }
        .to_account_metas(None),
    )
}

pub fn sync_payout_founder_ix(vault: &Pubkey, fx: &Fixture) -> Instruction {
    sync_payout_founder_ix_with(vault, &fx.share_class, &fx.asset, &fx.issuer)
}

pub fn sync_payout_founder_ix_with(
    vault: &Pubkey,
    share_class: &Pubkey,
    asset: &Pubkey,
    issuer: &Pubkey,
) -> Instruction {
    ix(
        ixd::SyncPayoutFounder {}.data(),
        acc::SyncPayoutFounder {
            vault: *vault,
            share_class: *share_class,
            asset: *asset,
            issuer: *issuer,
        }
        .to_account_metas(None),
    )
}
