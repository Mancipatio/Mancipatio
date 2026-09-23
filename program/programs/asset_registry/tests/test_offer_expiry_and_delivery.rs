//! OTC offer expiry (`expires_at` / `expire_offer`) and DeliveryEscrow
//! return-to-beneficiary (`return_custody_vault`) — LiteSVM e2e tests.
//!
//! Boot mirrors test_happy_path.rs: platform → issuer → asset → share class →
//! hook-wired Token-2022 mint → transfer_hook config (Open mode) so real
//! `transfer_checked` legs run through the hook.
//!
//! 2C-3: boot also creates a KYC registry (payer = provider). Every
//! `DeliveryEscrow` opened here pins it (`open_vault_ix`), and its realize is
//! gated on the beneficiary's passport even though the mint is Open — the gate
//! does not depend on the hook mode.

#[path = "../../../tests/support/kyc_registry.rs"]
mod kyc_registry;
#[path = "../../../tests/support/pause.rs"]
mod pause;
#[path = "../../../tests/support/mod.rs"]
mod support;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    asset_registry::{
        accounts as acc, instruction as ixd, AssetType, CustodyVault, JurisdictionRules, Offer,
        OfferStatus, RealizeAction, ShareClassType, VaultState, VaultType, RIGHT_DIVIDEND,
        RIGHT_LIQ_PREF, RIGHT_VOTE,
    },
    litesvm::LiteSVM,
    solana_clock::Clock,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    spl_associated_token_account_interface::{
        address::get_associated_token_address_with_program_id, instruction as ata_ix,
    },
    spl_token_2022_interface::instruction as token_ix,
};

const TOKEN_2022: Pubkey = spl_token_2022_interface::id();

// ── Helpers (pattern from test_happy_path.rs / test_payout_vault.rs) ─────────

fn send(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction], label: &str) {
    svm.expire_blockhash();
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &bh);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).expect("sign");
    if let Err(e) = svm.send_transaction(tx) {
        panic!("[{label}] tx failed: {e:?}");
    }
}

fn try_send(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction]) -> Result<(), String> {
    svm.expire_blockhash();
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &bh);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).expect("sign");
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

fn load<T: AccountDeserialize>(svm: &LiteSVM, pda: &Pubkey) -> T {
    let a = svm.get_account(pda).expect("account missing");
    T::try_deserialize(&mut a.data.as_slice()).expect("deserialize")
}

fn warp_to(svm: &mut LiteSVM, unix_ts: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_ts;
    svm.set_sysvar(&clock);
}

fn create_ata(svm: &mut LiteSVM, payer: &Keypair, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    let ix = ata_ix::create_associated_token_account(&payer.pubkey(), owner, mint, &TOKEN_2022);
    send(svm, &[payer], &[ix], "create_ata");
    get_associated_token_address_with_program_id(owner, mint, &TOKEN_2022)
}

fn token_balance(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    let a = svm.get_account(ata).expect("ata missing");
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}

/// Everything the tests need after boot.
#[allow(dead_code)]
struct Ctx {
    program_id: Pubkey,
    hook_id: Pubkey,
    payer: Keypair,
    admin_pda: Pubkey,
    issuer_pda: Pubkey,
    asset_pda: Pubkey,
    share_class_pda: Pubkey,
    mint_pda: Pubkey,
    payment_mint: Pubkey,
    extra_metas_pda: Pubkey,
    /// Holder with share units in `holder_share_ata` (funded via mint_to_treasury).
    holder: Keypair,
    holder_share_ata: Pubkey,
    /// KYC registry created at boot (payer = provider); DeliveryEscrow vaults
    /// pin it.
    kyc_registry: Pubkey,
}

/// [source BlockEntry, ExtraAccountMetaList, hook program] for a hook transfer
/// whose source authority is `source_authority`.
fn hook_metas(ctx: &Ctx, source_authority: &Pubkey) -> [AccountMeta; 3] {
    let (block_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::BLOCK_ENTRY_SEED, source_authority.as_ref()],
        &ctx.hook_id,
    );
    [
        AccountMeta::new_readonly(block_pda, false),
        AccountMeta::new_readonly(ctx.extra_metas_pda, false),
        AccountMeta::new_readonly(ctx.hook_id, false),
    ]
}

/// Boots the full stack and mints `holder_units` share units to the holder.
fn boot(holder_units: u64) -> (LiteSVM, Ctx) {
    let program_id = asset_registry::id();
    let hook_id = transfer_hook::id();
    let mut svm = LiteSVM::new();
    svm.add_program(
        program_id,
        include_bytes!("../../../target/deploy/asset_registry.so"),
    )
    .unwrap();
    svm.add_program(
        hook_id,
        include_bytes!("../../../target/deploy/transfer_hook.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    let holder = Keypair::new();
    svm.airdrop(&holder.pubkey(), 100_000_000_000).unwrap();

    let legal_entity_id: [u8; 32] = *b"RWA-DAO-PILOT-ENTITY-00000000001";
    let asset_id = "pilot-001";
    let class_index: u8 = 0;

    let (platform_pda, _) =
        Pubkey::find_program_address(&[asset_registry::PLATFORM_SEED], &program_id);
    let (admin_pda, _) = Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, payer.pubkey().as_ref()],
        &program_id,
    );
    let (issuer_pda, _) = Pubkey::find_program_address(
        &[asset_registry::ISSUER_SEED, legal_entity_id.as_ref()],
        &program_id,
    );
    let (asset_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::ASSET_SEED,
            issuer_pda.as_ref(),
            asset_id.as_bytes(),
        ],
        &program_id,
    );
    let (share_class_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::SHARE_CLASS_SEED,
            asset_pda.as_ref(),
            &[class_index],
        ],
        &program_id,
    );
    let (mint_pda, _) = Pubkey::find_program_address(
        &[asset_registry::SHARE_MINT_SEED, share_class_pda.as_ref()],
        &program_id,
    );

    support::set_upgrade_authority(&mut svm, &asset_registry::ID, Some(payer.pubkey()));
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::InitializePlatform {
                protocol_treasury: payer.pubkey(),
                protocol_fee_bps: 250,
            }
            .data(),
            acc::InitializePlatform {
                admin: payer.pubkey(),
                upgrade_authority: payer.pubkey(),
                program: asset_registry::ID,
                program_data: support::program_data(&asset_registry::ID),
                platform: platform_pda,
                super_admin_record: admin_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "initialize_platform",
    );
    pause::unpause_all(&mut svm, &payer);
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::RegisterIssuer {
                legal_entity_id,
                jurisdiction: 222,
                kyb_doc_hash: [9u8; 32],
            }
            .data(),
            acc::RegisterIssuer {
                authority: payer.pubkey(),
                platform: platform_pda,
                issuer: issuer_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "register_issuer",
    );
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::VerifyIssuerKyb { approved: true }.data(),
            acc::VerifyIssuerKyb {
                admin: payer.pubkey(),
                platform: platform_pda,
                issuer: issuer_pda,
            }
            .to_account_metas(None),
        )],
        "verify_issuer_kyb",
    );
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::CreateAsset {
                asset_id: asset_id.to_string(),
                asset_type: AssetType::Commodity,
                name: "Delivery Pilot".to_string(),
                symbol_prefix: "DLVR".to_string(),
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
                authority: payer.pubkey(),
                platform: platform_pda,
                issuer: issuer_pda,
                asset: asset_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "create_asset",
    );
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::AddShareClass {
                class_index,
                class_type: ShareClassType::Common,
                rights_bitfield: RIGHT_VOTE | RIGHT_DIVIDEND | RIGHT_LIQ_PREF,
                liq_pref_multiplier_bps: 10_000,
                liq_seniority: 0,
                voting_weight: 1,
                max_supply: None,
                mintable_post_launch: false,
            }
            .data(),
            acc::AddShareClass {
                authority: payer.pubkey(),
                platform: platform_pda,
                issuer: issuer_pda,
                asset: asset_pda,
                share_class: share_class_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "add_share_class",
    );
    // Hook config + meta list are auto-created via CPI inside
    // initialize_share_class_mint (init is registry-CPI-only now).
    let (hook_config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint_pda.as_ref()],
        &hook_id,
    );
    let (extra_metas_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint_pda.as_ref()],
        &hook_id,
    );
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::InitializeShareClassMint {}.data(),
            acc::InitializeShareClassMint {
                authority: payer.pubkey(),
                admin_record: admin_pda,
                issuer: issuer_pda,
                asset: asset_pda,
                share_class: share_class_pda,
                mint: mint_pda,
                hook_config: hook_config_pda,
                extra_account_meta_list: extra_metas_pda,
                transfer_hook_program: hook_id,
                token_program: TOKEN_2022,
                system_program: system_program::ID,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        )],
        "initialize_share_class_mint",
    );

    // activate_asset — minting requires an Active asset
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::ActivateAsset {}.data(),
            acc::ActivateAsset {
                authority: payer.pubkey(),
                admin_record: admin_pda,
                issuer: issuer_pda,
                asset: asset_pda,
            }
            .to_account_metas(None),
        )],
        "activate_asset",
    );

    // ── transfer_hook: blocklist authority (config + metas already live) ─────
    let (blocklist_authority_pda, _) =
        Pubkey::find_program_address(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED], &hook_id);
    support::set_upgrade_authority(&mut svm, &transfer_hook::ID, Some(payer.pubkey()));
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            hook_id,
            &transfer_hook::instruction::InitializeBlocklistAuthority {
                authority: payer.pubkey(),
            }
            .data(),
            transfer_hook::accounts::InitializeBlocklistAuthority {
                payer: payer.pubkey(),
                upgrade_authority: payer.pubkey(),
                program: transfer_hook::ID,
                program_data: support::program_data(&transfer_hook::ID),
                blocklist_authority: blocklist_authority_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "initialize_blocklist_authority",
    );

    // ── KYC registry (2C-3: DeliveryEscrow vaults pin it) ───────────────────
    let kyc_registry = kyc_registry::registry_pda(&payer.pubkey());
    send(
        &mut svm,
        &[&payer],
        &[kyc_registry::create_registry_ix(
            &payer.pubkey(),
            &payer.pubkey(),
            kyc_registry::bitmap(&[222]),
            [0u8; asset_registry::JURISDICTION_BITMAP_BYTES],
        )],
        "create_kyc_registry",
    );

    // ── payment mint + holder share units ────────────────────────────────────
    let payment_mint = {
        use anchor_lang::solana_program::system_instruction;
        let mint = Keypair::new();
        let lamports = svm.minimum_balance_for_rent_exemption(82);
        let create = system_instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            lamports,
            82,
            &TOKEN_2022,
        );
        let init =
            token_ix::initialize_mint2(&TOKEN_2022, &mint.pubkey(), &payer.pubkey(), None, 6)
                .unwrap();
        send(&mut svm, &[&payer, &mint], &[create, init], "payment_mint");
        mint.pubkey()
    };

    let holder_share_ata = create_ata(&mut svm, &payer, &mint_pda, &holder.pubkey());
    if holder_units > 0 {
        // Treasury-mint to the issuer authority's own ATA (mint_to_treasury
        // binds the destination to the authority), then a hook-checked
        // transfer to the holder.
        let payer_share_ata = create_ata(&mut svm, &payer, &mint_pda, &payer.pubkey());
        send(
            &mut svm,
            &[&payer],
            &[Instruction::new_with_bytes(
                program_id,
                &ixd::MintToTreasury {
                    amount: holder_units,
                }
                .data(),
                acc::MintToTreasury {
                    authority: payer.pubkey(),
                    admin_record: admin_pda,
                    issuer: issuer_pda,
                    asset: asset_pda,
                    share_class: share_class_pda,
                    mint: mint_pda,
                    destination: payer_share_ata,
                    token_program: TOKEN_2022,
                    platform: pause::platform_pda(),
                }
                .to_account_metas(None),
            )],
            "mint_to_treasury (issuer treasury)",
        );
        let (payer_block_pda, _) = Pubkey::find_program_address(
            &[transfer_hook::BLOCK_ENTRY_SEED, payer.pubkey().as_ref()],
            &hook_id,
        );
        let mut fund_holder = token_ix::transfer_checked(
            &TOKEN_2022,
            &payer_share_ata,
            &mint_pda,
            &holder_share_ata,
            &payer.pubkey(),
            &[],
            holder_units,
            0,
        )
        .unwrap();
        fund_holder.accounts.extend([
            AccountMeta::new_readonly(payer_block_pda, false),
            AccountMeta::new_readonly(extra_metas_pda, false),
            AccountMeta::new_readonly(hook_id, false),
        ]);
        send(
            &mut svm,
            &[&payer],
            &[fund_holder],
            "fund holder (hook transfer)",
        );
    }

    let ctx = Ctx {
        program_id,
        hook_id,
        payer,
        admin_pda,
        issuer_pda,
        asset_pda,
        share_class_pda,
        mint_pda,
        payment_mint,
        extra_metas_pda,
        holder,
        holder_share_ata,
        kyc_registry,
    };
    (svm, ctx)
}

// ── Offer helpers ────────────────────────────────────────────────────────────

/// The `EscrowMarker` PDA for an escrow-authority PDA.
fn escrow_marker_of(ctx: &Ctx, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::ESCROW_MARKER_SEED, owner.as_ref()],
        &ctx.program_id,
    )
    .0
}

fn offer_pdas(ctx: &Ctx, offer_id: u64) -> (Pubkey, Pubkey) {
    let (offer_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::OFFER_SEED,
            ctx.share_class_pda.as_ref(),
            &offer_id.to_le_bytes(),
        ],
        &ctx.program_id,
    );
    let (escrow_pda, _) = Pubkey::find_program_address(
        &[asset_registry::ESCROW_SEED, offer_pda.as_ref()],
        &ctx.program_id,
    );
    (offer_pda, escrow_pda)
}

fn create_offer_ix(
    ctx: &Ctx,
    offer_id: u64,
    amount: u64,
    price: u64,
    expires_at: i64,
) -> Instruction {
    let (offer_pda, escrow_pda) = offer_pdas(ctx, offer_id);
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::CreateOffer {
            offer_id,
            amount,
            price,
            expires_at,
        }
        .data(),
        acc::CreateOffer {
            maker: ctx.holder.pubkey(),
            share_class: ctx.share_class_pda,
            mint: ctx.mint_pda,
            payment_mint: ctx.payment_mint,
            offer: offer_pda,
            escrow: escrow_pda,
            escrow_marker: escrow_marker_of(ctx, &offer_pda),
            token_program: TOKEN_2022,
            system_program: system_program::ID,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
    )
}

/// Maker (holder) funds the offer escrow with `amount` units through
/// `deposit_to_offer_escrow` — the ledgered route (3-account Open-mode hook
/// tail here). A bare client-side `transfer_checked` still lands the tokens but
/// records nothing, and `take_offer` sells only what the ledger backs; see
/// `raw_fund_offer_escrow` below for that contrast.
fn deposit_to_offer_escrow(svm: &mut LiteSVM, ctx: &Ctx, offer_id: u64, amount: u64) {
    send(
        svm,
        &[&ctx.holder],
        &[deposit_to_offer_escrow_ix(ctx, offer_id, amount)],
        "deposit_to_offer_escrow",
    );
}

fn deposit_to_offer_escrow_ix(ctx: &Ctx, offer_id: u64, amount: u64) -> Instruction {
    let (offer_pda, escrow_pda) = offer_pdas(ctx, offer_id);
    let mut metas = acc::DepositToOfferEscrow {
        maker: ctx.holder.pubkey(),
        offer: offer_pda,
        mint: ctx.mint_pda,
        escrow: escrow_pda,
        maker_share_account: ctx.holder_share_ata,
        token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    metas.extend_from_slice(&hook_metas(ctx, &ctx.holder.pubkey()));
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::DepositToOfferEscrow { amount }.data(),
        metas,
    )
}

/// A bare client-side `transfer_checked` into the offer escrow — lands the
/// tokens (destination-owner `EscrowMarker`) and credits NOTHING.
fn raw_fund_offer_escrow(svm: &mut LiteSVM, ctx: &Ctx, escrow_pda: &Pubkey, amount: u64) {
    let mut ix = token_ix::transfer_checked(
        &TOKEN_2022,
        &ctx.holder_share_ata,
        &ctx.mint_pda,
        escrow_pda,
        &ctx.holder.pubkey(),
        &[],
        amount,
        0,
    )
    .unwrap();
    ix.accounts
        .extend_from_slice(&hook_metas(ctx, &ctx.holder.pubkey()));
    send(svm, &[&ctx.holder], &[ix], "raw fund offer escrow");
}

fn expire_offer_ix(ctx: &Ctx, payer: &Pubkey, offer_id: u64) -> Instruction {
    let (offer_pda, escrow_pda) = offer_pdas(ctx, offer_id);
    let mut metas = acc::ExpireOffer {
        payer: *payer,
        offer: offer_pda,
        mint: ctx.mint_pda,
        escrow: escrow_pda,
        maker_share_account: ctx.holder_share_ata,
        escrow_marker: escrow_marker_of(ctx, &offer_pda),
        share_token_program: TOKEN_2022,
    }
    .to_account_metas(None);
    metas.extend_from_slice(&hook_metas(ctx, &offer_pda));
    Instruction::new_with_bytes(ctx.program_id, &ixd::ExpireOffer {}.data(), metas)
}

/// Builds the take_offer instruction for `taker` (payment + share ATAs must exist).
#[allow(clippy::too_many_arguments)]
fn take_offer_ix(
    ctx: &Ctx,
    offer_id: u64,
    taker: &Pubkey,
    taker_share_ata: &Pubkey,
    taker_payment_ata: &Pubkey,
    maker_payment_ata: &Pubkey,
) -> Instruction {
    let (offer_pda, escrow_pda) = offer_pdas(ctx, offer_id);
    let mut metas = acc::TakeOffer {
        taker: *taker,
        offer: offer_pda,
        mint: ctx.mint_pda,
        escrow: escrow_pda,
        taker_share_account: *taker_share_ata,
        payment_mint: ctx.payment_mint,
        taker_payment_account: *taker_payment_ata,
        maker_payment_account: *maker_payment_ata,
        escrow_marker: escrow_marker_of(ctx, &offer_pda),
        share_token_program: TOKEN_2022,
        payment_token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    metas.extend_from_slice(&hook_metas(ctx, &offer_pda));
    Instruction::new_with_bytes(ctx.program_id, &ixd::TakeOffer {}.data(), metas)
}

// ── Custody helpers ──────────────────────────────────────────────────────────

fn custody_pdas(ctx: &Ctx, vault_id: u64) -> (Pubkey, Pubkey) {
    let (custody_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::CUSTODY_SEED,
            ctx.share_class_pda.as_ref(),
            &vault_id.to_le_bytes(),
        ],
        &ctx.program_id,
    );
    let (escrow_pda, _) = Pubkey::find_program_address(
        &[asset_registry::ESCROW_SEED, custody_pda.as_ref()],
        &ctx.program_id,
    );
    (custody_pda, escrow_pda)
}

/// Opens a vault the way the front does: a `DeliveryEscrow` pins the boot
/// registry, every other type passes none.
fn open_vault_ix(
    ctx: &Ctx,
    vault_id: u64,
    vault_type: VaultType,
    amount: u64,
    deadline: i64,
    beneficiary: Pubkey,
) -> Instruction {
    let kyc_registry = (vault_type == VaultType::DeliveryEscrow).then_some(ctx.kyc_registry);
    open_vault_ix_with_registry(
        ctx,
        vault_id,
        vault_type,
        amount,
        deadline,
        beneficiary,
        kyc_registry,
    )
}

fn open_vault_ix_with_registry(
    ctx: &Ctx,
    vault_id: u64,
    vault_type: VaultType,
    amount: u64,
    deadline: i64,
    beneficiary: Pubkey,
    kyc_registry: Option<Pubkey>,
) -> Instruction {
    let (custody_pda, escrow_pda) = custody_pdas(ctx, vault_id);
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::OpenCustodyVault {
            vault_id,
            vault_type,
            realize_action: RealizeAction::BurnAndAttest,
            amount,
            deadline,
            metadata_hash: [7u8; 32],
            beneficiary,
        }
        .data(),
        acc::OpenCustodyVault {
            authority: ctx.payer.pubkey(),
            admin_record: ctx.admin_pda,
            share_class: ctx.share_class_pda,
            mint: ctx.mint_pda,
            custody_vault: custody_pda,
            escrow: escrow_pda,
            escrow_marker: escrow_marker_of(ctx, &custody_pda),
            token_program: TOKEN_2022,
            system_program: system_program::ID,
            platform: pause::platform_pda(),
            kyc_registry,
        }
        .to_account_metas(None),
    )
}

/// Holder deposits `amount` units into the vault escrow (hook-aware).
fn fund_vault_escrow(svm: &mut LiteSVM, ctx: &Ctx, escrow_pda: &Pubkey, amount: u64) {
    let mut ix = token_ix::transfer_checked(
        &TOKEN_2022,
        &ctx.holder_share_ata,
        &ctx.mint_pda,
        escrow_pda,
        &ctx.holder.pubkey(),
        &[],
        amount,
        0,
    )
    .unwrap();
    ix.accounts
        .extend_from_slice(&hook_metas(ctx, &ctx.holder.pubkey()));
    send(svm, &[&ctx.holder], &[ix], "fund vault escrow");
}

fn return_vault_ix(
    ctx: &Ctx,
    signer: &Pubkey,
    vault_id: u64,
    beneficiary_token_account: &Pubkey,
) -> Instruction {
    let (custody_pda, escrow_pda) = custody_pdas(ctx, vault_id);
    let mut metas = acc::ReturnCustodyVault {
        authority_admin_record: Pubkey::find_program_address(
            &[asset_registry::ADMIN_SEED, ctx.payer.pubkey().as_ref()],
            &asset_registry::ID,
        )
        .0,
        signer: *signer,
        share_class: ctx.share_class_pda,
        custody_vault: custody_pda,
        mint: ctx.mint_pda,
        escrow: escrow_pda,
        beneficiary_token_account: *beneficiary_token_account,
        escrow_marker: escrow_marker_of(ctx, &custody_pda),
        token_program: TOKEN_2022,
    }
    .to_account_metas(None);
    metas.extend_from_slice(&hook_metas(ctx, &custody_pda));
    Instruction::new_with_bytes(ctx.program_id, &ixd::ReturnCustodyVault {}.data(), metas)
}

// ── Tests: OTC offer expiry ──────────────────────────────────────────────────

#[test]
fn offer_with_future_expiry_can_be_taken() {
    let (mut svm, ctx) = boot(100);
    warp_to(&mut svm, 1_000);

    let offer_id = 1u64;
    let (offer_pda, _escrow_pda) = offer_pdas(&ctx, offer_id);
    send(
        &mut svm,
        &[&ctx.holder],
        &[create_offer_ix(&ctx, offer_id, 10, 5_000_000, 2_000)],
        "create_offer (future expiry)",
    );
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(offer.expires_at, 2_000);
    deposit_to_offer_escrow(&mut svm, &ctx, offer_id, 10);
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(offer.deposited, 10, "Open-mode deposit credits the ledger");

    // taker setup
    let taker = Keypair::new();
    svm.airdrop(&taker.pubkey(), 100_000_000_000).unwrap();
    let taker_payment_ata = create_ata(&mut svm, &ctx.payer, &ctx.payment_mint, &taker.pubkey());
    let mint_ix = token_ix::mint_to(
        &TOKEN_2022,
        &ctx.payment_mint,
        &taker_payment_ata,
        &ctx.payer.pubkey(),
        &[],
        10_000_000,
    )
    .unwrap();
    send(&mut svm, &[&ctx.payer], &[mint_ix], "mint payment to taker");
    let taker_share_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &taker.pubkey());
    let maker_payment_ata = create_ata(
        &mut svm,
        &ctx.payer,
        &ctx.payment_mint,
        &ctx.holder.pubkey(),
    );

    // still before expiry (now = 1000 <= 2000) — take succeeds
    send(
        &mut svm,
        &[&taker],
        &[take_offer_ix(
            &ctx,
            offer_id,
            &taker.pubkey(),
            &taker_share_ata,
            &taker_payment_ata,
            &maker_payment_ata,
        )],
        "take_offer before expiry",
    );
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(offer.status, OfferStatus::Filled);
    assert_eq!(token_balance(&svm, &taker_share_ata), 10);
}

#[test]
fn take_after_expiry_fails_and_expire_offer_refunds_maker() {
    let (mut svm, ctx) = boot(100);
    warp_to(&mut svm, 1_000);

    let offer_id = 1u64;
    let (offer_pda, escrow_pda) = offer_pdas(&ctx, offer_id);
    send(
        &mut svm,
        &[&ctx.holder],
        &[create_offer_ix(&ctx, offer_id, 10, 5_000_000, 2_000)],
        "create_offer",
    );
    deposit_to_offer_escrow(&mut svm, &ctx, offer_id, 10);
    assert_eq!(token_balance(&svm, &ctx.holder_share_ata), 90);

    // expire_offer BEFORE expiry — must fail with OfferNotExpired
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();
    let err = try_send(
        &mut svm,
        &[&stranger],
        &[expire_offer_ix(&ctx, &stranger.pubkey(), offer_id)],
    )
    .expect_err("expire before expiry must fail");
    assert!(err.contains("OfferNotExpired"), "got: {err}");

    // warp past expiry
    warp_to(&mut svm, 3_000);

    // take AFTER expiry — must fail with OfferExpired
    let taker = Keypair::new();
    svm.airdrop(&taker.pubkey(), 100_000_000_000).unwrap();
    let taker_payment_ata = create_ata(&mut svm, &ctx.payer, &ctx.payment_mint, &taker.pubkey());
    let mint_ix = token_ix::mint_to(
        &TOKEN_2022,
        &ctx.payment_mint,
        &taker_payment_ata,
        &ctx.payer.pubkey(),
        &[],
        10_000_000,
    )
    .unwrap();
    send(&mut svm, &[&ctx.payer], &[mint_ix], "mint payment to taker");
    let taker_share_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &taker.pubkey());
    let maker_payment_ata = create_ata(
        &mut svm,
        &ctx.payer,
        &ctx.payment_mint,
        &ctx.holder.pubkey(),
    );
    let err = try_send(
        &mut svm,
        &[&taker],
        &[take_offer_ix(
            &ctx,
            offer_id,
            &taker.pubkey(),
            &taker_share_ata,
            &taker_payment_ata,
            &maker_payment_ata,
        )],
    )
    .expect_err("take after expiry must fail");
    assert!(err.contains("OfferExpired"), "got: {err}");

    // expire_offer AFTER expiry — permissionless; refunds escrow to maker
    send(
        &mut svm,
        &[&stranger],
        &[expire_offer_ix(&ctx, &stranger.pubkey(), offer_id)],
        "expire_offer",
    );
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(offer.status, OfferStatus::Expired);
    assert_eq!(
        token_balance(&svm, &ctx.holder_share_ata),
        100,
        "escrow refunded to maker"
    );
    assert_eq!(token_balance(&svm, &escrow_pda), 0);
    assert!(
        svm.get_account(&escrow_marker_of(&ctx, &offer_pda))
            .map(|a| a.data.is_empty() || a.lamports == 0)
            .unwrap_or(true),
        "escrow marker closed on expire_offer"
    );
}

#[test]
fn create_offer_with_past_expiry_fails() {
    let (mut svm, ctx) = boot(10);
    warp_to(&mut svm, 5_000);
    let err = try_send(
        &mut svm,
        &[&ctx.holder],
        &[create_offer_ix(&ctx, 1, 5, 1_000_000, 4_000)],
    )
    .expect_err("past expiry must fail");
    assert!(err.contains("InvalidExpiry"), "got: {err}");
}

// ── Tests: DeliveryEscrow return ─────────────────────────────────────────────

#[test]
fn delivery_vault_requires_beneficiary() {
    let (mut svm, ctx) = boot(0);
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            1,
            VaultType::DeliveryEscrow,
            10,
            4_102_444_800,
            Pubkey::default(),
        )],
    )
    .expect_err("DeliveryEscrow without beneficiary must fail");
    assert!(err.contains("BeneficiaryRequired"), "got: {err}");
}

/// The deposit instructions on an **Open** mint (3-account hook tail) — the
/// shape the KycGated suite never exercises. Both credit their ledger, and the
/// ledger is what `take_offer` keys on: an escrow that was only ever raw-funded
/// is NOT fillable, even in Open mode where no KYC question arises at all. The
/// maker is not stuck with it either — `expire_offer` still hands the balance
/// back, because in Open mode the receiver check resolves to "not gated".
#[test]
fn open_mode_deposit_ledgers_and_raw_funding() {
    let (mut svm, ctx) = boot(100);
    warp_to(&mut svm, 1_000);

    // ── offer escrow ─────────────────────────────────────────────────────────
    let offer_id = 1u64;
    let (offer_pda, offer_escrow) = offer_pdas(&ctx, offer_id);
    send(
        &mut svm,
        &[&ctx.holder],
        &[create_offer_ix(&ctx, offer_id, 10, 5_000_000, 2_000)],
        "create_offer",
    );
    // Raw funding lands the tokens but records nothing.
    raw_fund_offer_escrow(&mut svm, &ctx, &offer_escrow, 10);
    assert_eq!(token_balance(&svm, &offer_escrow), 10);
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(offer.deposited, 0, "a raw transfer credits no deposit");

    // …so the offer is not fillable.
    let taker = Keypair::new();
    svm.airdrop(&taker.pubkey(), 100_000_000_000).unwrap();
    let taker_payment_ata = create_ata(&mut svm, &ctx.payer, &ctx.payment_mint, &taker.pubkey());
    let mint_ix = token_ix::mint_to(
        &TOKEN_2022,
        &ctx.payment_mint,
        &taker_payment_ata,
        &ctx.payer.pubkey(),
        &[],
        10_000_000,
    )
    .unwrap();
    send(&mut svm, &[&ctx.payer], &[mint_ix], "mint payment to taker");
    let taker_share_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &taker.pubkey());
    let maker_payment_ata = create_ata(
        &mut svm,
        &ctx.payer,
        &ctx.payment_mint,
        &ctx.holder.pubkey(),
    );
    let err = try_send(
        &mut svm,
        &[&taker],
        &[take_offer_ix(
            &ctx,
            offer_id,
            &taker.pubkey(),
            &taker_share_ata,
            &taker_payment_ata,
            &maker_payment_ata,
        )],
    )
    .expect_err("an offer with an empty ledger must not be fillable");
    assert!(err.contains("OfferNotFunded"), "got: {err}");

    // The ledgered deposit makes it fillable.
    deposit_to_offer_escrow(&mut svm, &ctx, offer_id, 10);
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(offer.deposited, 10);
    send(
        &mut svm,
        &[&taker],
        &[take_offer_ix(
            &ctx,
            offer_id,
            &taker.pubkey(),
            &taker_share_ata,
            &taker_payment_ata,
            &maker_payment_ata,
        )],
        "take_offer",
    );
    assert_eq!(token_balance(&svm, &taker_share_ata), 10);
    // The raw-funded 10 that was NOT sold stays in the escrow.
    assert_eq!(token_balance(&svm, &offer_escrow), 10);

    // ── custody escrow ───────────────────────────────────────────────────────
    let vault_id = 1u64;
    let (custody_pda, vault_escrow) = custody_pdas(&ctx, vault_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            vault_id,
            VaultType::DeliveryEscrow,
            30,
            0,
            ctx.holder.pubkey(),
        )],
        "open delivery vault",
    );
    let mut metas = acc::DepositToCustodyVault {
        depositor: ctx.holder.pubkey(),
        share_class: ctx.share_class_pda,
        custody_vault: custody_pda,
        mint: ctx.mint_pda,
        escrow: vault_escrow,
        depositor_share_account: ctx.holder_share_ata,
        token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    metas.extend_from_slice(&hook_metas(&ctx, &ctx.holder.pubkey()));
    send(
        &mut svm,
        &[&ctx.holder],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::DepositToCustodyVault { amount: 30 }.data(),
            metas,
        )],
        "deposit_to_custody_vault (Open mint)",
    );
    let vault: CustodyVault = load(&svm, &custody_pda);
    assert_eq!(vault.deposited, 30, "Open-mode deposit credits the ledger");
    assert_eq!(token_balance(&svm, &vault_escrow), 30);

    let before = token_balance(&svm, &ctx.holder_share_ata);
    send(
        &mut svm,
        &[&ctx.payer],
        &[return_vault_ix(
            &ctx,
            &ctx.payer.pubkey(),
            vault_id,
            &ctx.holder_share_ata,
        )],
        "return_custody_vault (Open mint)",
    );
    assert_eq!(token_balance(&svm, &ctx.holder_share_ata), before + 30);
    let vault: CustodyVault = load(&svm, &custody_pda);
    assert_eq!(vault.state, VaultState::Returned);
    assert_eq!(vault.deposited, 0, "ledger consumed by the refund");
}

#[test]
fn return_by_authority_sends_escrow_to_beneficiary() {
    let (mut svm, ctx) = boot(50);
    warp_to(&mut svm, 1_000);

    // The holder who deposits is the beneficiary (typical delivery flow).
    let vault_id = 1u64;
    let (custody_pda, escrow_pda) = custody_pdas(&ctx, vault_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            vault_id,
            VaultType::DeliveryEscrow,
            30,
            4_102_444_800, // far-future deadline
            ctx.holder.pubkey(),
        )],
        "open delivery vault",
    );
    let vault: CustodyVault = load(&svm, &custody_pda);
    assert_eq!(vault.beneficiary, ctx.holder.pubkey());
    assert_eq!(vault.state, VaultState::Active);

    fund_vault_escrow(&mut svm, &ctx, &escrow_pda, 30);
    assert_eq!(token_balance(&svm, &ctx.holder_share_ata), 20);
    assert_eq!(token_balance(&svm, &escrow_pda), 30);

    // a stranger BEFORE the deadline — must fail with ReturnNotAllowed
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();
    let err = try_send(
        &mut svm,
        &[&stranger],
        &[return_vault_ix(
            &ctx,
            &stranger.pubkey(),
            vault_id,
            &ctx.holder_share_ata,
        )],
    )
    .expect_err("stranger before deadline must fail");
    assert!(err.contains("ReturnNotAllowed"), "got: {err}");

    // the vault authority — allowed at any time; tokens return, not burn
    send(
        &mut svm,
        &[&ctx.payer],
        &[return_vault_ix(
            &ctx,
            &ctx.payer.pubkey(),
            vault_id,
            &ctx.holder_share_ata,
        )],
        "return_custody_vault (authority)",
    );
    let vault: CustodyVault = load(&svm, &custody_pda);
    assert_eq!(vault.state, VaultState::Returned);
    assert_eq!(
        token_balance(&svm, &ctx.holder_share_ata),
        50,
        "full escrow returned to the beneficiary — nothing burned"
    );
    assert_eq!(token_balance(&svm, &escrow_pda), 0);
}

#[test]
fn return_by_anyone_after_deadline() {
    let (mut svm, ctx) = boot(20);
    warp_to(&mut svm, 1_000);

    let vault_id = 1u64;
    let (custody_pda, escrow_pda) = custody_pdas(&ctx, vault_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            vault_id,
            VaultType::DeliveryEscrow,
            20,
            2_000, // deadline soon
            ctx.holder.pubkey(),
        )],
        "open delivery vault",
    );
    fund_vault_escrow(&mut svm, &ctx, &escrow_pda, 20);

    warp_to(&mut svm, 3_000); // past deadline — permissionless

    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();
    send(
        &mut svm,
        &[&stranger],
        &[return_vault_ix(
            &ctx,
            &stranger.pubkey(),
            vault_id,
            &ctx.holder_share_ata,
        )],
        "return_custody_vault (permissionless)",
    );
    let vault: CustodyVault = load(&svm, &custody_pda);
    assert_eq!(vault.state, VaultState::Returned);
    assert_eq!(token_balance(&svm, &ctx.holder_share_ata), 20);
}

#[test]
fn deadline_zero_disables_permissionless_return() {
    let (mut svm, ctx) = boot(30);
    warp_to(&mut svm, 1_000);

    let vault_id = 1u64;
    let (custody_pda, escrow_pda) = custody_pdas(&ctx, vault_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            vault_id,
            VaultType::DeliveryEscrow,
            20,
            0, // deadline 0 — no permissionless return, ever
            ctx.holder.pubkey(),
        )],
        "open delivery vault (deadline 0)",
    );
    fund_vault_escrow(&mut svm, &ctx, &escrow_pda, 20);

    // A stranger can never return a deadline-0 vault, no matter the clock.
    warp_to(&mut svm, 4_102_444_800);
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();
    let err = try_send(
        &mut svm,
        &[&stranger],
        &[return_vault_ix(
            &ctx,
            &stranger.pubkey(),
            vault_id,
            &ctx.holder_share_ata,
        )],
    )
    .expect_err("permissionless return with deadline 0 must fail");
    assert!(err.contains("ReturnNotAllowed"), "got: {err}");

    // The vault authority still exits at any time.
    send(
        &mut svm,
        &[&ctx.payer],
        &[return_vault_ix(
            &ctx,
            &ctx.payer.pubkey(),
            vault_id,
            &ctx.holder_share_ata,
        )],
        "return_custody_vault (authority, deadline 0)",
    );
    let vault: CustodyVault = load(&svm, &custody_pda);
    assert_eq!(vault.state, VaultState::Returned);
    assert_eq!(token_balance(&svm, &ctx.holder_share_ata), 30);
}

#[test]
fn triggered_blocks_permissionless_return_before_deadline_only() {
    let (mut svm, ctx) = boot(50);
    warp_to(&mut svm, 1_000);

    // ── Vault 1: Triggered, deadline NOT yet passed ──────────────────────────
    // The permissionless branch is blocked (the vault authority's decision is
    // pending) but the authority itself is not.
    let vault_id = 1u64;
    let (custody_pda, escrow_pda) = custody_pdas(&ctx, vault_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            vault_id,
            VaultType::DeliveryEscrow,
            20,
            2_000,
            ctx.holder.pubkey(),
        )],
        "open delivery vault 1",
    );
    fund_vault_escrow(&mut svm, &ctx, &escrow_pda, 20);

    // Authority triggers the vault (its decision pending).
    send(
        &mut svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::TriggerCustodyVault {}.data(),
            acc::TriggerCustodyVault {
                authority_admin_record: Pubkey::find_program_address(
                    &[asset_registry::ADMIN_SEED, ctx.payer.pubkey().as_ref()],
                    &asset_registry::ID,
                )
                .0,
                authority: ctx.payer.pubkey(),
                custody_vault: custody_pda,
            }
            .to_account_metas(None),
        )],
        "trigger_custody_vault 1",
    );
    let vault: CustodyVault = load(&svm, &custody_pda);
    assert_eq!(vault.state, VaultState::Triggered);

    // Deadline (2_000) has not passed — a stranger must fail.
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();
    let err = try_send(
        &mut svm,
        &[&stranger],
        &[return_vault_ix(
            &ctx,
            &stranger.pubkey(),
            vault_id,
            &ctx.holder_share_ata,
        )],
    )
    .expect_err("permissionless return on Triggered before the deadline must fail");
    assert!(err.contains("ReturnNotAllowed"), "got: {err}");

    // The authority is not blocked by Triggered.
    send(
        &mut svm,
        &[&ctx.payer],
        &[return_vault_ix(
            &ctx,
            &ctx.payer.pubkey(),
            vault_id,
            &ctx.holder_share_ata,
        )],
        "return_custody_vault (authority, Triggered)",
    );
    let vault: CustodyVault = load(&svm, &custody_pda);
    assert_eq!(vault.state, VaultState::Returned);
    assert_eq!(token_balance(&svm, &ctx.holder_share_ata), 50);

    // ── Vault 2: Triggered AND deadline passed ───────────────────────────────
    // The permissionless branch must work — it is the recovery path for the
    // beneficiary's deposit when the authority key is lost after a trigger
    // (trigger/realize are authority-only; revert is banned for
    // DeliveryEscrow, so no other exit exists).
    let vault_id2 = 2u64;
    let (custody_pda2, escrow_pda2) = custody_pdas(&ctx, vault_id2);
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            vault_id2,
            VaultType::DeliveryEscrow,
            20,
            2_000,
            ctx.holder.pubkey(),
        )],
        "open delivery vault 2",
    );
    fund_vault_escrow(&mut svm, &ctx, &escrow_pda2, 20);
    send(
        &mut svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::TriggerCustodyVault {}.data(),
            acc::TriggerCustodyVault {
                authority_admin_record: Pubkey::find_program_address(
                    &[asset_registry::ADMIN_SEED, ctx.payer.pubkey().as_ref()],
                    &asset_registry::ID,
                )
                .0,
                authority: ctx.payer.pubkey(),
                custody_vault: custody_pda2,
            }
            .to_account_metas(None),
        )],
        "trigger_custody_vault 2",
    );

    warp_to(&mut svm, 3_000); // deadline passed
    send(
        &mut svm,
        &[&stranger],
        &[return_vault_ix(
            &ctx,
            &stranger.pubkey(),
            vault_id2,
            &ctx.holder_share_ata,
        )],
        "return_custody_vault (permissionless, Triggered after deadline)",
    );
    let vault2: CustodyVault = load(&svm, &custody_pda2);
    assert_eq!(vault2.state, VaultState::Returned);
    assert_eq!(token_balance(&svm, &ctx.holder_share_ata), 50);
}

#[test]
fn open_vault_with_negative_deadline_fails() {
    let (mut svm, ctx) = boot(0);
    warp_to(&mut svm, 1_000);

    // A negative deadline would mean "already expired" to revert_custody_vault
    // but "permissionless return disabled forever" to return_custody_vault —
    // open_custody_vault must reject it outright.
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            1,
            VaultType::DeliveryEscrow,
            10,
            -1,
            ctx.holder.pubkey(),
        )],
    )
    .expect_err("negative deadline must fail");
    assert!(err.contains("InvalidDeadline"), "got: {err}");
}

#[test]
fn revert_on_delivery_vault_fails() {
    let (mut svm, ctx) = boot(10);
    warp_to(&mut svm, 1_000);

    let vault_id = 1u64;
    let (_, escrow_pda) = custody_pdas(&ctx, vault_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            vault_id,
            VaultType::DeliveryEscrow,
            10,
            2_000,
            ctx.holder.pubkey(),
        )],
        "open delivery vault",
    );
    fund_vault_escrow(&mut svm, &ctx, &escrow_pda, 10);

    warp_to(&mut svm, 3_000); // past deadline — revert would otherwise be legal

    let (custody_pda, _) = custody_pdas(&ctx, vault_id);
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::RevertCustodyVault {}.data(),
            acc::RevertCustodyVault {
                authority_admin_record: Pubkey::find_program_address(
                    &[asset_registry::ADMIN_SEED, ctx.payer.pubkey().as_ref()],
                    &asset_registry::ID,
                )
                .0,
                payer: ctx.payer.pubkey(),
                share_class: ctx.share_class_pda,
                custody_vault: custody_pda,
                mint: ctx.mint_pda,
                escrow: escrow_pda,
                escrow_marker: escrow_marker_of(&ctx, &custody_pda),
                token_program: TOKEN_2022,
            }
            .to_account_metas(None),
        )],
    )
    .expect_err("revert on DeliveryEscrow must fail");
    assert!(err.contains("DeliveryVaultUseReturn"), "got: {err}");
}

// ── Tests: revert authorization ──────────────────────────────────────────────

fn revert_vault_ix(ctx: &Ctx, payer: &Pubkey, vault_id: u64) -> Instruction {
    let (custody_pda, escrow_pda) = custody_pdas(ctx, vault_id);
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::RevertCustodyVault {}.data(),
        acc::RevertCustodyVault {
            authority_admin_record: Pubkey::find_program_address(
                &[asset_registry::ADMIN_SEED, ctx.payer.pubkey().as_ref()],
                &asset_registry::ID,
            )
            .0,
            payer: *payer,
            share_class: ctx.share_class_pda,
            custody_vault: custody_pda,
            mint: ctx.mint_pda,
            escrow: escrow_pda,
            escrow_marker: escrow_marker_of(ctx, &custody_pda),
            token_program: TOKEN_2022,
        }
        .to_account_metas(None),
    )
}

/// `deadline == 0` (the quarantine default of `clawback_from_holder`) means "no
/// permissionless revert": only the vault authority may burn. Otherwise any
/// stranger could destroy seized units on sight — and, worse, flip a still
/// EMPTY vault to `Reverted` (closing its `EscrowMarker`), which bricks it for
/// every later clawback, since `clawback_from_holder` requires `state ==
/// Active`.
#[test]
fn revert_without_deadline_is_authority_only() {
    let (mut svm, ctx) = boot(10);
    warp_to(&mut svm, 1_000);

    let vault_id = 1u64;
    let (custody_pda, escrow_pda) = custody_pdas(&ctx, vault_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            vault_id,
            VaultType::RedemptionQueue,
            10,
            0, // no deadline — the quarantine shape
            Pubkey::default(),
        )],
        "open quarantine vault",
    );
    fund_vault_escrow(&mut svm, &ctx, &escrow_pda, 10);

    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 10_000_000_000).unwrap();
    let err = try_send(
        &mut svm,
        &[&mallory],
        &[revert_vault_ix(&ctx, &mallory.pubkey(), vault_id)],
    )
    .expect_err("a stranger must not revert a vault with no deadline");
    assert!(err.contains("RevertNotAllowed"), "got: {err}");
    assert_eq!(token_balance(&svm, &escrow_pda), 10, "escrow untouched");
    let vault: CustodyVault = load(&svm, &custody_pda);
    assert_eq!(vault.state, VaultState::Active, "vault still usable");
    assert!(
        svm.get_account(&escrow_marker_of(&ctx, &custody_pda))
            .map(|a| !a.data.is_empty() && a.lamports > 0)
            .unwrap_or(false),
        "escrow marker still alive — clawbacks keep working"
    );

    // The authority still burns whenever it wants — the vault is not stuck.
    send(
        &mut svm,
        &[&ctx.payer],
        &[revert_vault_ix(&ctx, &ctx.payer.pubkey(), vault_id)],
        "revert (vault authority)",
    );
    assert_eq!(token_balance(&svm, &escrow_pda), 0, "escrow burned");
    let vault: CustodyVault = load(&svm, &custody_pda);
    assert_eq!(vault.state, VaultState::Reverted);
}

/// The escape hatch survives where it was opted into: a POSITIVE deadline that
/// has passed still lets anyone revert (so provisional mints can never be
/// stranded by a lost authority key) — and nobody may revert before it.
#[test]
fn revert_after_positive_deadline_stays_permissionless() {
    let (mut svm, ctx) = boot(10);
    warp_to(&mut svm, 1_000);

    let vault_id = 1u64;
    let (custody_pda, escrow_pda) = custody_pdas(&ctx, vault_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            vault_id,
            VaultType::ConversionPending,
            10,
            2_000,
            Pubkey::default(),
        )],
        "open vault with deadline",
    );
    fund_vault_escrow(&mut svm, &ctx, &escrow_pda, 10);

    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 10_000_000_000).unwrap();
    let err = try_send(
        &mut svm,
        &[&mallory],
        &[revert_vault_ix(&ctx, &mallory.pubkey(), vault_id)],
    )
    .expect_err("revert before the deadline must fail");
    assert!(err.contains("VaultNotExpired"), "got: {err}");

    warp_to(&mut svm, 3_000);
    send(
        &mut svm,
        &[&mallory],
        &[revert_vault_ix(&ctx, &mallory.pubkey(), vault_id)],
        "revert (permissionless, deadline passed)",
    );
    assert_eq!(token_balance(&svm, &escrow_pda), 0, "escrow burned");
    let vault: CustodyVault = load(&svm, &custody_pda);
    assert_eq!(vault.state, VaultState::Reverted);
}

// ── Emergency pause (Platform.pause_flags) ───────────────────────────────────

fn cancel_offer_ix(ctx: &Ctx, offer_id: u64) -> Instruction {
    let (offer_pda, escrow_pda) = offer_pdas(ctx, offer_id);
    let mut metas = acc::CancelOffer {
        maker: ctx.holder.pubkey(),
        offer: offer_pda,
        mint: ctx.mint_pda,
        escrow: escrow_pda,
        maker_share_account: ctx.holder_share_ata,
        escrow_marker: escrow_marker_of(ctx, &offer_pda),
        share_token_program: TOKEN_2022,
    }
    .to_account_metas(None);
    metas.extend_from_slice(&hook_metas(ctx, &offer_pda));
    Instruction::new_with_bytes(ctx.program_id, &ixd::CancelOffer {}.data(), metas)
}

fn deposit_to_custody_ix(ctx: &Ctx, vault_id: u64, amount: u64) -> Instruction {
    let (custody_pda, escrow_pda) = custody_pdas(ctx, vault_id);
    let mut metas = acc::DepositToCustodyVault {
        depositor: ctx.holder.pubkey(),
        share_class: ctx.share_class_pda,
        custody_vault: custody_pda,
        mint: ctx.mint_pda,
        escrow: escrow_pda,
        depositor_share_account: ctx.holder_share_ata,
        token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    metas.extend_from_slice(&hook_metas(ctx, &ctx.holder.pubkey()));
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::DepositToCustodyVault { amount }.data(),
        metas,
    )
}

/// bit2 gates the offer ENTRIES (create, fund, take); the maker's exits
/// (`cancel_offer`, the permissionless `expire_offer`) stay open under 0x3F.
#[test]
fn secondary_pause_gates_offer_entries_while_cancel_and_expire_stay_open() {
    let (mut svm, ctx) = boot(100);
    warp_to(&mut svm, 1_000);
    let all_but = asset_registry::PAUSE_FLAGS_ALL & !asset_registry::PAUSE_SECONDARY;

    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_SECONDARY);
    pause::assert_paused(
        try_send(
            &mut svm,
            &[&ctx.holder],
            &[create_offer_ix(&ctx, 1, 10, 5_000_000, 0)],
        ),
        "create_offer under SECONDARY",
    );

    pause::pause_only(&mut svm, &ctx.payer, all_but);
    for (offer_id, expires_at) in [(1u64, 0i64), (2, 0), (3, 2_000)] {
        send(
            &mut svm,
            &[&ctx.holder],
            &[create_offer_ix(&ctx, offer_id, 10, 5_000_000, expires_at)],
            "create_offer",
        );
    }

    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_SECONDARY);
    pause::assert_paused(
        try_send(
            &mut svm,
            &[&ctx.holder],
            &[deposit_to_offer_escrow_ix(&ctx, 1, 10)],
        ),
        "deposit_to_offer_escrow under SECONDARY",
    );
    pause::pause_only(&mut svm, &ctx.payer, all_but);
    for offer_id in 1..=3 {
        deposit_to_offer_escrow(&mut svm, &ctx, offer_id, 10);
    }
    assert_eq!(token_balance(&svm, &ctx.holder_share_ata), 70);

    let taker = Keypair::new();
    svm.airdrop(&taker.pubkey(), 100_000_000_000).unwrap();
    let taker_payment_ata = create_ata(&mut svm, &ctx.payer, &ctx.payment_mint, &taker.pubkey());
    let mint_ix = token_ix::mint_to(
        &TOKEN_2022,
        &ctx.payment_mint,
        &taker_payment_ata,
        &ctx.payer.pubkey(),
        &[],
        10_000_000,
    )
    .unwrap();
    send(&mut svm, &[&ctx.payer], &[mint_ix], "mint payment to taker");
    let taker_share_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &taker.pubkey());
    let maker_payment_ata = create_ata(
        &mut svm,
        &ctx.payer,
        &ctx.payment_mint,
        &ctx.holder.pubkey(),
    );
    let take = take_offer_ix(
        &ctx,
        1,
        &taker.pubkey(),
        &taker_share_ata,
        &taker_payment_ata,
        &maker_payment_ata,
    );
    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_SECONDARY);
    pause::assert_paused(
        try_send(&mut svm, &[&taker], std::slice::from_ref(&take)),
        "take_offer under SECONDARY",
    );
    pause::pause_only(&mut svm, &ctx.payer, all_but);
    send(&mut svm, &[&taker], &[take], "take_offer");
    assert_eq!(token_balance(&svm, &taker_share_ata), 10);

    // Full pause: the maker cancels, and anyone expires a lapsed offer.
    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_FLAGS_ALL);
    send(
        &mut svm,
        &[&ctx.holder],
        &[cancel_offer_ix(&ctx, 2)],
        "cancel_offer under 0x3F",
    );
    assert_eq!(
        load::<Offer>(&svm, &offer_pdas(&ctx, 2).0).status,
        OfferStatus::Cancelled
    );
    warp_to(&mut svm, 3_000);
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    send(
        &mut svm,
        &[&stranger],
        &[expire_offer_ix(&ctx, &stranger.pubkey(), 3)],
        "expire_offer under 0x3F",
    );
    assert_eq!(
        load::<Offer>(&svm, &offer_pdas(&ctx, 3).0).status,
        OfferStatus::Expired
    );
    assert_eq!(token_balance(&svm, &ctx.holder_share_ata), 90);
}

/// bit3 gates `deposit_to_custody_vault` (and non-quarantine opens); the
/// DeliveryEscrow refund (`return_custody_vault`) and the burn exit
/// (`revert_custody_vault`) stay open under 0x3F.
#[test]
fn custody_entry_pause_gates_deposits_while_return_and_revert_stay_open() {
    let (mut svm, ctx) = boot(100);
    warp_to(&mut svm, 1_000);
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            1,
            VaultType::DeliveryEscrow,
            30,
            0,
            ctx.holder.pubkey(),
        )],
        "open delivery vault",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            2,
            VaultType::RedemptionQueue,
            0,
            0,
            Pubkey::default(),
        )],
        "open redemption vault",
    );

    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_CUSTODY_ENTRY);
    pause::assert_paused(
        try_send(
            &mut svm,
            &[&ctx.holder],
            &[deposit_to_custody_ix(&ctx, 1, 30)],
        ),
        "deposit_to_custody_vault under CUSTODY_ENTRY",
    );
    pause::assert_paused(
        try_send(
            &mut svm,
            &[&ctx.payer],
            &[open_vault_ix(
                &ctx,
                3,
                VaultType::DeliveryEscrow,
                1,
                0,
                ctx.holder.pubkey(),
            )],
        ),
        "DeliveryEscrow open under CUSTODY_ENTRY",
    );
    // The pause check runs before the registry pin check: a DeliveryEscrow
    // without its registry is still refused as a paused entry, not 6134.
    pause::assert_paused(
        try_send(
            &mut svm,
            &[&ctx.payer],
            &[open_vault_ix_with_registry(
                &ctx,
                3,
                VaultType::DeliveryEscrow,
                1,
                0,
                ctx.holder.pubkey(),
                None,
            )],
        ),
        "DeliveryEscrow open without registry under CUSTODY_ENTRY",
    );

    pause::pause_only(
        &mut svm,
        &ctx.payer,
        asset_registry::PAUSE_FLAGS_ALL & !asset_registry::PAUSE_CUSTODY_ENTRY,
    );
    send(
        &mut svm,
        &[&ctx.holder],
        &[deposit_to_custody_ix(&ctx, 1, 30)],
        "deposit_to_custody_vault",
    );
    let (_, escrow_2) = custody_pdas(&ctx, 2);
    fund_vault_escrow(&mut svm, &ctx, &escrow_2, 5);
    assert_eq!(token_balance(&svm, &ctx.holder_share_ata), 65);

    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_FLAGS_ALL);
    send(
        &mut svm,
        &[&ctx.payer],
        &[return_vault_ix(
            &ctx,
            &ctx.payer.pubkey(),
            1,
            &ctx.holder_share_ata,
        )],
        "return_custody_vault under 0x3F",
    );
    assert_eq!(token_balance(&svm, &ctx.holder_share_ata), 95);
    send(
        &mut svm,
        &[&ctx.payer],
        &[revert_vault_ix(&ctx, &ctx.payer.pubkey(), 2)],
        "revert_custody_vault under 0x3F",
    );
    assert_eq!(token_balance(&svm, &escrow_2), 0, "escrow burned");
    assert_eq!(
        load::<CustodyVault>(&svm, &custody_pdas(&ctx, 2).0).state,
        VaultState::Reverted
    );
}

// ── 2C-3: DeliveryEscrow KYC registry pin (Open mint) ────────────────────────

fn trigger_vault_ix(ctx: &Ctx, vault_id: u64) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::TriggerCustodyVault {}.data(),
        acc::TriggerCustodyVault {
            authority_admin_record: ctx.admin_pda,
            authority: ctx.payer.pubkey(),
            custody_vault: custody_pdas(ctx, vault_id).0,
        }
        .to_account_metas(None),
    )
}

fn realize_vault_ix(
    ctx: &Ctx,
    vault_id: u64,
    kyc_registry: Option<Pubkey>,
    kyc_entry: Option<Pubkey>,
) -> Instruction {
    let (custody_pda, escrow_pda) = custody_pdas(ctx, vault_id);
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::RealizeCustodyVault {}.data(),
        acc::RealizeCustodyVault {
            authority: ctx.payer.pubkey(),
            share_class: ctx.share_class_pda,
            custody_vault: custody_pda,
            mint: ctx.mint_pda,
            escrow: escrow_pda,
            escrow_marker: escrow_marker_of(ctx, &custody_pda),
            token_program: TOKEN_2022,
            authority_admin_record: ctx.admin_pda,
            kyc_registry,
            kyc_entry,
        }
        .to_account_metas(None),
    )
}

/// A DeliveryEscrow must pin a registry (6134) — and it must be a real
/// `KycRegistry` account, not any account the caller likes.
#[test]
fn delivery_vault_open_requires_kyc_registry() {
    let (mut svm, ctx) = boot(0);
    warp_to(&mut svm, 1_000);
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix_with_registry(
            &ctx,
            1,
            VaultType::DeliveryEscrow,
            10,
            0,
            ctx.holder.pubkey(),
            None,
        )],
    )
    .expect_err("DeliveryEscrow without a registry must fail");
    assert!(err.contains("Custom(6134)"), "got: {err}");

    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix_with_registry(
            &ctx,
            1,
            VaultType::DeliveryEscrow,
            10,
            0,
            ctx.holder.pubkey(),
            Some(pause::platform_pda()),
        )],
    )
    .expect_err("a non-registry account must not pass as the pin");
    assert!(
        err.contains("AccountDiscriminatorMismatch") || err.contains("Custom(3002)"),
        "got: {err}"
    );
}

/// Only a DeliveryEscrow may pin a registry: every other type passes none —
/// the clawback quarantine (RedemptionQueue) keeps its exact old shape.
#[test]
fn non_delivery_vault_open_rejects_kyc_registry() {
    let (mut svm, ctx) = boot(0);
    warp_to(&mut svm, 1_000);
    for (id, vault_type) in [
        (1u64, VaultType::RedemptionQueue),
        (2, VaultType::ConversionPending),
        (3, VaultType::Vesting),
    ] {
        let err = try_send(
            &mut svm,
            &[&ctx.payer],
            &[open_vault_ix_with_registry(
                &ctx,
                id,
                vault_type,
                10,
                0,
                Pubkey::default(),
                Some(ctx.kyc_registry),
            )],
        )
        .expect_err("a non-delivery vault must not pin a registry");
        assert!(err.contains("Custom(6135)"), "{vault_type:?}: got {err}");
        // …and the same open without a registry succeeds.
        send(
            &mut svm,
            &[&ctx.payer],
            &[open_vault_ix(
                &ctx,
                id,
                vault_type,
                10,
                0,
                Pubkey::default(),
            )],
            "non-delivery open without a registry",
        );
    }
}

/// The gate is independent of the hook mode: on an Open mint (no receiver KYC
/// anywhere) the DeliveryEscrow realize still needs the beneficiary's passport.
#[test]
fn open_mode_delivery_realize_requires_beneficiary_kyc() {
    let (mut svm, ctx) = boot(50);
    warp_to(&mut svm, 1_000);
    let holder_pk = ctx.holder.pubkey();
    let (vault_pda, escrow_pda) = custody_pdas(&ctx, 1);
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            1,
            VaultType::DeliveryEscrow,
            20,
            0,
            holder_pk,
        )],
        "open delivery vault",
    );
    send(
        &mut svm,
        &[&ctx.holder],
        &[deposit_to_custody_ix(&ctx, 1, 20)],
        "deposit_to_custody_vault (no KYC asked)",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[trigger_vault_ix(&ctx, 1)],
        "trigger",
    );

    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[realize_vault_ix(&ctx, 1, Some(ctx.kyc_registry), None)],
    )
    .expect_err("realize without a passport must fail on an Open mint too");
    assert!(err.contains("Custom(6069)"), "got: {err}");
    assert_eq!(token_balance(&svm, &escrow_pda), 20);

    send(
        &mut svm,
        &[&ctx.payer],
        &[kyc_registry::approve_ix(
            &ctx.payer.pubkey(),
            &ctx.kyc_registry,
            &holder_pk,
            222,
        )],
        "approve_holder",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[realize_vault_ix(
            &ctx,
            1,
            Some(ctx.kyc_registry),
            Some(kyc_registry::entry_pda(&ctx.kyc_registry, &holder_pk)),
        )],
        "realize with the beneficiary's passport",
    );
    assert_eq!(token_balance(&svm, &escrow_pda), 0);
    let vault: CustodyVault = load(&svm, &vault_pda);
    assert_eq!(vault.state, VaultState::Realized);
}

/// v2 layout: `kyc_registry` appended after `deposited` (bytes 237..269),
/// `version == CUSTODY_STATE_VERSION (2)`; default for non-delivery types.
#[test]
fn delivery_vault_pins_registry_v2_layout() {
    let (mut svm, ctx) = boot(0);
    warp_to(&mut svm, 1_000);
    send(
        &mut svm,
        &[&ctx.payer],
        &[
            open_vault_ix(
                &ctx,
                1,
                VaultType::DeliveryEscrow,
                10,
                0,
                ctx.holder.pubkey(),
            ),
            open_vault_ix(&ctx, 2, VaultType::RedemptionQueue, 0, 0, Pubkey::default()),
        ],
        "open delivery + redemption vaults",
    );
    assert_eq!(asset_registry::CUSTODY_STATE_VERSION, 2);
    for (id, pinned) in [(1u64, ctx.kyc_registry), (2, Pubkey::default())] {
        let pda = custody_pdas(&ctx, id).0;
        let vault: CustodyVault = load(&svm, &pda);
        assert_eq!(vault.kyc_registry, pinned);
        assert_eq!(vault.version, 2);
        let raw = svm.get_account(&pda).unwrap().data;
        assert_eq!(raw.len(), 269);
        assert_eq!(&raw[237..269], pinned.as_ref());
    }
}

/// Non-delivery realize ignores the KYC accounts entirely: a ConversionPending
/// vault (no beneficiary) realizes with None / None.
#[test]
fn non_delivery_realize_needs_no_kyc_accounts() {
    let (mut svm, ctx) = boot(20);
    warp_to(&mut svm, 1_000);
    let (_, escrow_pda) = custody_pdas(&ctx, 1);
    send(
        &mut svm,
        &[&ctx.payer],
        &[open_vault_ix(
            &ctx,
            1,
            VaultType::ConversionPending,
            5,
            0,
            Pubkey::default(),
        )],
        "open conversion-pending vault",
    );
    send(
        &mut svm,
        &[&ctx.holder],
        &[deposit_to_custody_ix(&ctx, 1, 5)],
        "deposit",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[
            trigger_vault_ix(&ctx, 1),
            realize_vault_ix(&ctx, 1, None, None),
        ],
        "trigger + realize (no KYC accounts)",
    );
    assert_eq!(token_balance(&svm, &escrow_pda), 0);
}
