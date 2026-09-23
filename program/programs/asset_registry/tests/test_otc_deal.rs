//! Bilateral (two-party) OTC escrow (`create_otc_deal` / `deposit_otc_asset` /
//! `deposit_otc_payment` / `expire_otc_deal` / `cancel_otc_deal`) — LiteSVM
//! e2e tests. business-doc §9: the platform opens the deal after the parties
//! agree; both deposit; both funded → atomic swap; otherwise expiry / cancel
//! refunds whichever side deposited.
//!
//! Boot mirrors test_offer_expiry_and_delivery.rs: platform → issuer → asset →
//! share class → hook-wired Token-2022 mint → transfer_hook config (Open mode)
//! so real `transfer_checked` legs run through the hook.

#[path = "../../../tests/support/kyc_registry.rs"]
mod kyc_registry;
#[path = "../../../tests/support/pause.rs"]
mod pause;
#[path = "../../../tests/support/reclaim.rs"]
mod reclaim;
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
        accounts as acc, instruction as ixd, AssetType, JurisdictionRules, OtcDeal, OtcDealStatus,
        ShareClassType, RIGHT_DIVIDEND, RIGHT_LIQ_PREF, RIGHT_VOTE,
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

const DEAL_AMOUNT: u64 = 10;
const DEAL_PRICE: u64 = 5_000_000;
const SELLER_UNITS: u64 = 100;
const BUYER_PAYMENT: u64 = 10_000_000;

// ── Helpers (pattern from test_offer_expiry_and_delivery.rs) ─────────────────

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
    /// Seller holds `SELLER_UNITS` share units; buyer holds `BUYER_PAYMENT`.
    seller: Keypair,
    seller_share_ata: Pubkey,
    seller_payment_ata: Pubkey,
    buyer: Keypair,
    buyer_share_ata: Pubkey,
    buyer_payment_ata: Pubkey,
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

/// Boots the full stack: seller gets share units, buyer gets payment units.
fn boot() -> (LiteSVM, Ctx) {
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
    let seller = Keypair::new();
    svm.airdrop(&seller.pubkey(), 100_000_000_000).unwrap();
    let buyer = Keypair::new();
    svm.airdrop(&buyer.pubkey(), 100_000_000_000).unwrap();

    let legal_entity_id: [u8; 32] = *b"OTC-DEAL-PILOT-ENTITY-0000000001";
    let asset_id = "otc-pilot-001";
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
                asset_type: AssetType::Equity,
                name: "OTC Deal Pilot".to_string(),
                symbol_prefix: "OTCD".to_string(),
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

    // ── payment mint + party token accounts ──────────────────────────────────
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

    let seller_share_ata = create_ata(&mut svm, &payer, &mint_pda, &seller.pubkey());
    let seller_payment_ata = create_ata(&mut svm, &payer, &payment_mint, &seller.pubkey());
    let buyer_share_ata = create_ata(&mut svm, &payer, &mint_pda, &buyer.pubkey());
    let buyer_payment_ata = create_ata(&mut svm, &payer, &payment_mint, &buyer.pubkey());

    // fund the seller with share units: treasury-mint to the issuer
    // authority's own ATA (mint_to_treasury binds the destination to the
    // authority), then a hook-checked transfer to the seller.
    let payer_share_ata = create_ata(&mut svm, &payer, &mint_pda, &payer.pubkey());
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::MintToTreasury {
                amount: SELLER_UNITS,
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
    let mut fund_seller = token_ix::transfer_checked(
        &TOKEN_2022,
        &payer_share_ata,
        &mint_pda,
        &seller_share_ata,
        &payer.pubkey(),
        &[],
        SELLER_UNITS,
        0,
    )
    .unwrap();
    fund_seller.accounts.extend([
        AccountMeta::new_readonly(payer_block_pda, false),
        AccountMeta::new_readonly(extra_metas_pda, false),
        AccountMeta::new_readonly(hook_id, false),
    ]);
    send(
        &mut svm,
        &[&payer],
        &[fund_seller],
        "fund seller (hook transfer)",
    );

    // fund the buyer with payment units
    let mint_ix = token_ix::mint_to(
        &TOKEN_2022,
        &payment_mint,
        &buyer_payment_ata,
        &payer.pubkey(),
        &[],
        BUYER_PAYMENT,
    )
    .unwrap();
    send(&mut svm, &[&payer], &[mint_ix], "mint payment to buyer");

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
        seller,
        seller_share_ata,
        seller_payment_ata,
        buyer,
        buyer_share_ata,
        buyer_payment_ata,
    };
    (svm, ctx)
}

// ── Deal helpers ─────────────────────────────────────────────────────────────

/// The `EscrowMarker` PDA for an escrow-authority PDA.
fn escrow_marker_of(ctx: &Ctx, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::ESCROW_MARKER_SEED, owner.as_ref()],
        &ctx.program_id,
    )
    .0
}

fn deal_pdas(ctx: &Ctx, deal_id: u64) -> (Pubkey, Pubkey, Pubkey) {
    let (deal_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::OTC_DEAL_SEED,
            ctx.share_class_pda.as_ref(),
            &deal_id.to_le_bytes(),
        ],
        &ctx.program_id,
    );
    let (asset_escrow_pda, _) = Pubkey::find_program_address(
        &[asset_registry::OTC_ASSET_ESCROW_SEED, deal_pda.as_ref()],
        &ctx.program_id,
    );
    let (payment_escrow_pda, _) = Pubkey::find_program_address(
        &[asset_registry::OTC_PAYMENT_ESCROW_SEED, deal_pda.as_ref()],
        &ctx.program_id,
    );
    (deal_pda, asset_escrow_pda, payment_escrow_pda)
}

fn create_deal_ix(ctx: &Ctx, authority: &Pubkey, deal_id: u64, expires_at: i64) -> Instruction {
    create_deal_ix_with(
        ctx,
        authority,
        deal_id,
        expires_at,
        &ctx.payment_mint,
        &TOKEN_2022,
    )
}

/// `create_otc_deal` with an explicit payment mint and its token program.
fn create_deal_ix_with(
    ctx: &Ctx,
    authority: &Pubkey,
    deal_id: u64,
    expires_at: i64,
    payment_mint: &Pubkey,
    payment_program: &Pubkey,
) -> Instruction {
    let (deal_pda, asset_escrow_pda, payment_escrow_pda) = deal_pdas(ctx, deal_id);
    let (admin_record, _) = Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, authority.as_ref()],
        &ctx.program_id,
    );
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::CreateOtcDeal {
            deal_id,
            buyer: ctx.buyer.pubkey(),
            seller: ctx.seller.pubkey(),
            amount: DEAL_AMOUNT,
            price: DEAL_PRICE,
            payment_mint: *payment_mint,
            expires_at,
        }
        .data(),
        acc::CreateOtcDeal {
            authority: *authority,
            admin_record,
            share_class: ctx.share_class_pda,
            mint: ctx.mint_pda,
            payment_mint: *payment_mint,
            deal: deal_pda,
            asset_escrow: asset_escrow_pda,
            payment_escrow: payment_escrow_pda,
            escrow_marker: escrow_marker_of(ctx, &deal_pda),
            token_program: TOKEN_2022,
            payment_token_program: *payment_program,
            system_program: system_program::ID,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
    )
}

fn deposit_asset_ix(ctx: &Ctx, signer: &Pubkey, deal_id: u64) -> Instruction {
    let (deal_pda, asset_escrow_pda, payment_escrow_pda) = deal_pdas(ctx, deal_id);
    let mut metas = acc::DepositOtcAsset {
        seller: *signer,
        deal: deal_pda,
        mint: ctx.mint_pda,
        seller_share_account: ctx.seller_share_ata,
        asset_escrow: asset_escrow_pda,
        payment_mint: ctx.payment_mint,
        payment_escrow: payment_escrow_pda,
        buyer_share_account: ctx.buyer_share_ata,
        seller_payment_account: ctx.seller_payment_ata,
        escrow_marker: escrow_marker_of(ctx, &deal_pda),
        share_token_program: TOKEN_2022,
        payment_token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    // deposit leg (source authority = seller) + settle leg (source authority = deal PDA)
    metas.extend_from_slice(&hook_metas(ctx, &ctx.seller.pubkey()));
    metas.extend_from_slice(&hook_metas(ctx, &deal_pda));
    Instruction::new_with_bytes(ctx.program_id, &ixd::DepositOtcAsset {}.data(), metas)
}

fn deposit_payment_ix(ctx: &Ctx, signer: &Pubkey, deal_id: u64) -> Instruction {
    let (deal_pda, asset_escrow_pda, payment_escrow_pda) = deal_pdas(ctx, deal_id);
    let mut metas = acc::DepositOtcPayment {
        buyer: *signer,
        deal: deal_pda,
        mint: ctx.mint_pda,
        payment_mint: ctx.payment_mint,
        buyer_payment_account: ctx.buyer_payment_ata,
        payment_escrow: payment_escrow_pda,
        asset_escrow: asset_escrow_pda,
        buyer_share_account: ctx.buyer_share_ata,
        seller_payment_account: ctx.seller_payment_ata,
        escrow_marker: escrow_marker_of(ctx, &deal_pda),
        share_token_program: TOKEN_2022,
        payment_token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    // settle leg (source authority = deal PDA) — unused if the asset is not in yet
    metas.extend_from_slice(&hook_metas(ctx, &deal_pda));
    Instruction::new_with_bytes(ctx.program_id, &ixd::DepositOtcPayment {}.data(), metas)
}

fn expire_deal_ix(ctx: &Ctx, payer: &Pubkey, deal_id: u64) -> Instruction {
    let (deal_pda, asset_escrow_pda, payment_escrow_pda) = deal_pdas(ctx, deal_id);
    let mut metas = acc::ExpireOtcDeal {
        payer: *payer,
        deal: deal_pda,
        mint: ctx.mint_pda,
        asset_escrow: asset_escrow_pda,
        seller_share_account: ctx.seller_share_ata,
        payment_mint: ctx.payment_mint,
        payment_escrow: payment_escrow_pda,
        buyer_payment_account: ctx.buyer_payment_ata,
        escrow_marker: escrow_marker_of(ctx, &deal_pda),
        share_token_program: TOKEN_2022,
        payment_token_program: TOKEN_2022,
    }
    .to_account_metas(None);
    metas.extend_from_slice(&hook_metas(ctx, &deal_pda));
    Instruction::new_with_bytes(ctx.program_id, &ixd::ExpireOtcDeal {}.data(), metas)
}

fn cancel_deal_ix(ctx: &Ctx, authority: &Pubkey, deal_id: u64) -> Instruction {
    cancel_deal_ix_with(
        ctx,
        authority,
        deal_id,
        (&ctx.payment_mint, &TOKEN_2022, &ctx.buyer_payment_ata),
    )
}

/// `cancel_otc_deal` with an explicit (payment mint, its token program, the
/// buyer's payment account).
fn cancel_deal_ix_with(
    ctx: &Ctx,
    authority: &Pubkey,
    deal_id: u64,
    (payment_mint, payment_program, buyer_payment): (&Pubkey, &Pubkey, &Pubkey),
) -> Instruction {
    let (deal_pda, asset_escrow_pda, payment_escrow_pda) = deal_pdas(ctx, deal_id);
    let (admin_record, _) = Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, authority.as_ref()],
        &ctx.program_id,
    );
    let mut metas = acc::CancelOtcDeal {
        authority: *authority,
        admin_record,
        deal: deal_pda,
        mint: ctx.mint_pda,
        asset_escrow: asset_escrow_pda,
        seller_share_account: ctx.seller_share_ata,
        payment_mint: *payment_mint,
        payment_escrow: payment_escrow_pda,
        buyer_payment_account: *buyer_payment,
        escrow_marker: escrow_marker_of(ctx, &deal_pda),
        share_token_program: TOKEN_2022,
        payment_token_program: *payment_program,
    }
    .to_account_metas(None);
    metas.extend_from_slice(&hook_metas(ctx, &deal_pda));
    Instruction::new_with_bytes(ctx.program_id, &ixd::CancelOtcDeal {}.data(), metas)
}

/// Asserts the settled end state: swap executed, escrows empty, deal Completed.
fn assert_settled(svm: &LiteSVM, ctx: &Ctx, deal_pda: &Pubkey, deal_id: u64) {
    let (_, asset_escrow_pda, payment_escrow_pda) = deal_pdas(ctx, deal_id);
    let deal: OtcDeal = load(svm, deal_pda);
    assert_eq!(deal.status, OtcDealStatus::Completed);
    assert!(deal.asset_deposited && deal.payment_deposited);
    assert_eq!(token_balance(svm, &ctx.buyer_share_ata), DEAL_AMOUNT);
    assert_eq!(token_balance(svm, &ctx.seller_payment_ata), DEAL_PRICE);
    assert_eq!(token_balance(svm, &asset_escrow_pda), 0);
    assert_eq!(token_balance(svm, &payment_escrow_pda), 0);
    assert_eq!(
        token_balance(svm, &ctx.seller_share_ata),
        SELLER_UNITS - DEAL_AMOUNT
    );
    assert_eq!(
        token_balance(svm, &ctx.buyer_payment_ata),
        BUYER_PAYMENT - DEAL_PRICE
    );
    // Terminal path — the escrow marker is closed.
    assert!(
        svm.get_account(&escrow_marker_of(ctx, deal_pda))
            .map(|a| a.data.is_empty() || a.lamports == 0)
            .unwrap_or(true),
        "escrow marker closed on settle"
    );
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn asset_first_swap_completes() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let deal_id = 1u64;
    let (deal_pda, asset_escrow_pda, _) = deal_pdas(&ctx, deal_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_deal_ix(&ctx, &ctx.payer.pubkey(), deal_id, 2_000)],
        "create_otc_deal",
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(deal.status, OtcDealStatus::Open);
    assert_eq!(deal.buyer, ctx.buyer.pubkey());
    assert_eq!(deal.seller, ctx.seller.pubkey());
    assert_eq!(deal.amount, DEAL_AMOUNT);
    assert_eq!(deal.price, DEAL_PRICE);
    assert_eq!(deal.expires_at, 2_000);
    assert!(
        svm.get_account(&escrow_marker_of(&ctx, &deal_pda))
            .is_some(),
        "escrow marker created with the deal"
    );

    // seller deposits the asset first — no settle yet
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, &ctx.seller.pubkey(), deal_id)],
        "deposit_otc_asset",
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(deal.status, OtcDealStatus::Open);
    assert!(deal.asset_deposited);
    assert!(!deal.payment_deposited);
    assert_eq!(token_balance(&svm, &asset_escrow_pda), DEAL_AMOUNT);
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        SELLER_UNITS - DEAL_AMOUNT
    );

    // buyer deposits the payment — swap settles atomically
    send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_payment_ix(&ctx, &ctx.buyer.pubkey(), deal_id)],
        "deposit_otc_payment",
    );
    assert_settled(&svm, &ctx, &deal_pda, deal_id);
}

#[test]
fn payment_first_swap_completes() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let deal_id = 1u64;
    let (deal_pda, _, payment_escrow_pda) = deal_pdas(&ctx, deal_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_deal_ix(&ctx, &ctx.payer.pubkey(), deal_id, 2_000)],
        "create_otc_deal",
    );

    // buyer deposits the payment first — no settle yet
    send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_payment_ix(&ctx, &ctx.buyer.pubkey(), deal_id)],
        "deposit_otc_payment",
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(deal.status, OtcDealStatus::Open);
    assert!(!deal.asset_deposited);
    assert!(deal.payment_deposited);
    assert_eq!(token_balance(&svm, &payment_escrow_pda), DEAL_PRICE);
    assert_eq!(
        token_balance(&svm, &ctx.buyer_payment_ata),
        BUYER_PAYMENT - DEAL_PRICE
    );

    // seller deposits the asset — swap settles atomically
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, &ctx.seller.pubkey(), deal_id)],
        "deposit_otc_asset",
    );
    assert_settled(&svm, &ctx, &deal_pda, deal_id);
}

#[test]
fn no_deposits_expire_flips_status_only() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let deal_id = 1u64;
    let (deal_pda, asset_escrow_pda, payment_escrow_pda) = deal_pdas(&ctx, deal_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_deal_ix(&ctx, &ctx.payer.pubkey(), deal_id, 2_000)],
        "create_otc_deal",
    );

    warp_to(&mut svm, 3_000); // past expiry

    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();
    send(
        &mut svm,
        &[&stranger],
        &[expire_deal_ix(&ctx, &stranger.pubkey(), deal_id)],
        "expire_otc_deal (permissionless)",
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(deal.status, OtcDealStatus::Expired);
    // nothing moved — nobody had deposited
    assert_eq!(token_balance(&svm, &ctx.seller_share_ata), SELLER_UNITS);
    assert_eq!(token_balance(&svm, &ctx.buyer_payment_ata), BUYER_PAYMENT);
    assert_eq!(token_balance(&svm, &asset_escrow_pda), 0);
    assert_eq!(token_balance(&svm, &payment_escrow_pda), 0);
}

#[test]
fn only_asset_deposited_expire_refunds_seller() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let deal_id = 1u64;
    let (deal_pda, asset_escrow_pda, _) = deal_pdas(&ctx, deal_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_deal_ix(&ctx, &ctx.payer.pubkey(), deal_id, 2_000)],
        "create_otc_deal",
    );
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, &ctx.seller.pubkey(), deal_id)],
        "deposit_otc_asset",
    );
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        SELLER_UNITS - DEAL_AMOUNT
    );

    warp_to(&mut svm, 3_000); // past expiry

    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();
    send(
        &mut svm,
        &[&stranger],
        &[expire_deal_ix(&ctx, &stranger.pubkey(), deal_id)],
        "expire_otc_deal",
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(deal.status, OtcDealStatus::Expired);
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        SELLER_UNITS,
        "asset refunded to the seller exactly"
    );
    assert_eq!(token_balance(&svm, &asset_escrow_pda), 0);
    assert_eq!(token_balance(&svm, &ctx.buyer_payment_ata), BUYER_PAYMENT);
}

#[test]
fn only_payment_deposited_expire_refunds_buyer() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let deal_id = 1u64;
    let (deal_pda, _, payment_escrow_pda) = deal_pdas(&ctx, deal_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_deal_ix(&ctx, &ctx.payer.pubkey(), deal_id, 2_000)],
        "create_otc_deal",
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_payment_ix(&ctx, &ctx.buyer.pubkey(), deal_id)],
        "deposit_otc_payment",
    );
    assert_eq!(
        token_balance(&svm, &ctx.buyer_payment_ata),
        BUYER_PAYMENT - DEAL_PRICE
    );

    warp_to(&mut svm, 3_000); // past expiry

    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();
    send(
        &mut svm,
        &[&stranger],
        &[expire_deal_ix(&ctx, &stranger.pubkey(), deal_id)],
        "expire_otc_deal",
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(deal.status, OtcDealStatus::Expired);
    assert_eq!(
        token_balance(&svm, &ctx.buyer_payment_ata),
        BUYER_PAYMENT,
        "payment refunded to the buyer exactly"
    );
    assert_eq!(token_balance(&svm, &payment_escrow_pda), 0);
    assert_eq!(token_balance(&svm, &ctx.seller_share_ata), SELLER_UNITS);
}

#[test]
fn deposit_after_expiry_fails() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let deal_id = 1u64;
    let (_, _, _) = deal_pdas(&ctx, deal_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_deal_ix(&ctx, &ctx.payer.pubkey(), deal_id, 2_000)],
        "create_otc_deal",
    );

    warp_to(&mut svm, 3_000); // past expiry

    let err = try_send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, &ctx.seller.pubkey(), deal_id)],
    )
    .expect_err("asset deposit after expiry must fail");
    assert!(err.contains("DealExpired"), "got: {err}");

    let err = try_send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_payment_ix(&ctx, &ctx.buyer.pubkey(), deal_id)],
    )
    .expect_err("payment deposit after expiry must fail");
    assert!(err.contains("DealExpired"), "got: {err}");
}

#[test]
fn expire_before_expiry_fails() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let deal_id = 1u64;
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_deal_ix(&ctx, &ctx.payer.pubkey(), deal_id, 2_000)],
        "create_otc_deal",
    );

    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();
    let err = try_send(
        &mut svm,
        &[&stranger],
        &[expire_deal_ix(&ctx, &stranger.pubkey(), deal_id)],
    )
    .expect_err("expire before expiry must fail");
    assert!(err.contains("DealNotExpired"), "got: {err}");
}

#[test]
fn non_admin_create_fails() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 100_000_000_000).unwrap();
    let err = try_send(
        &mut svm,
        &[&stranger],
        &[create_deal_ix(&ctx, &stranger.pubkey(), 1, 2_000)],
    )
    .expect_err("non-admin create_otc_deal must fail");
    // the stranger has no Admin PDA — Anchor rejects the missing account
    assert!(
        err.contains("AccountNotInitialized") || err.contains("AccountDiscriminator"),
        "got: {err}"
    );
}

#[test]
fn wrong_party_deposits_fail() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let deal_id = 1u64;
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_deal_ix(&ctx, &ctx.payer.pubkey(), deal_id, 2_000)],
        "create_otc_deal",
    );

    // the buyer cannot deposit the asset (seller-only)
    let err = try_send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_asset_ix(&ctx, &ctx.buyer.pubkey(), deal_id)],
    )
    .expect_err("buyer depositing the asset must fail");
    assert!(err.contains("WrongDealParty"), "got: {err}");

    // the seller cannot deposit the payment (buyer-only)
    let err = try_send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_payment_ix(&ctx, &ctx.seller.pubkey(), deal_id)],
    )
    .expect_err("seller depositing the payment must fail");
    assert!(err.contains("WrongDealParty"), "got: {err}");
}

#[test]
fn admin_cancel_refunds_and_blocks_deposits() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let deal_id = 1u64;
    let (deal_pda, asset_escrow_pda, _) = deal_pdas(&ctx, deal_id);
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_deal_ix(&ctx, &ctx.payer.pubkey(), deal_id, 2_000)],
        "create_otc_deal",
    );
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, &ctx.seller.pubkey(), deal_id)],
        "deposit_otc_asset",
    );
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        SELLER_UNITS - DEAL_AMOUNT
    );

    // admin cancels before expiry — the deposited asset returns to the seller
    send(
        &mut svm,
        &[&ctx.payer],
        &[cancel_deal_ix(&ctx, &ctx.payer.pubkey(), deal_id)],
        "cancel_otc_deal",
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(deal.status, OtcDealStatus::Cancelled);
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        SELLER_UNITS,
        "asset refunded to the seller exactly"
    );
    assert_eq!(token_balance(&svm, &asset_escrow_pda), 0);
    assert!(
        svm.get_account(&escrow_marker_of(&ctx, &deal_pda))
            .map(|a| a.data.is_empty() || a.lamports == 0)
            .unwrap_or(true),
        "escrow marker closed on cancel"
    );

    // further deposits are rejected — the escrow marker was closed with the
    // deal, so Anchor may reject the missing account before the status check
    let err = try_send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_payment_ix(&ctx, &ctx.buyer.pubkey(), deal_id)],
    )
    .expect_err("deposit after cancel must fail");
    assert!(
        err.contains("DealNotOpen") || err.contains("AccountNotInitialized"),
        "got: {err}"
    );
}

// ── Emergency pause (Platform.pause_flags) ───────────────────────────────────

/// bit2 gates every deal ENTRY — create, the first deposit and the settling
/// deposit on either side; `cancel_otc_deal` / `expire_otc_deal` refund by
/// ledger under 0x3F.
#[test]
fn secondary_pause_gates_deal_entries_including_the_settling_deposit() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);
    let payer = ctx.payer.pubkey();
    let seller = ctx.seller.pubkey();
    let buyer = ctx.buyer.pubkey();
    let all_but = asset_registry::PAUSE_FLAGS_ALL & !asset_registry::PAUSE_SECONDARY;

    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_SECONDARY);
    pause::assert_paused(
        try_send(
            &mut svm,
            &[&ctx.payer],
            &[create_deal_ix(&ctx, &payer, 1, 2_000)],
        ),
        "create_otc_deal under SECONDARY",
    );
    pause::pause_only(&mut svm, &ctx.payer, all_but);
    for deal_id in 1..=3 {
        send(
            &mut svm,
            &[&ctx.payer],
            &[create_deal_ix(&ctx, &payer, deal_id, 2_000)],
            "create_otc_deal",
        );
    }

    // Deal 1 — asset first, then the settling payment.
    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_SECONDARY);
    pause::assert_paused(
        try_send(
            &mut svm,
            &[&ctx.seller],
            &[deposit_asset_ix(&ctx, &seller, 1)],
        ),
        "deposit_otc_asset under SECONDARY",
    );
    pause::pause_only(&mut svm, &ctx.payer, all_but);
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, &seller, 1)],
        "deposit_otc_asset",
    );
    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_SECONDARY);
    pause::assert_paused(
        try_send(
            &mut svm,
            &[&ctx.buyer],
            &[deposit_payment_ix(&ctx, &buyer, 1)],
        ),
        "settling deposit_otc_payment under SECONDARY",
    );
    pause::pause_only(&mut svm, &ctx.payer, all_but);
    send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_payment_ix(&ctx, &buyer, 1)],
        "settling deposit_otc_payment",
    );
    assert_settled(&svm, &ctx, &deal_pdas(&ctx, 1).0, 1);

    // Deal 2 — payment first; the settling asset deposit is gated too.
    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_SECONDARY);
    pause::assert_paused(
        try_send(
            &mut svm,
            &[&ctx.buyer],
            &[deposit_payment_ix(&ctx, &buyer, 2)],
        ),
        "deposit_otc_payment under SECONDARY",
    );
    pause::pause_only(&mut svm, &ctx.payer, all_but);
    send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_payment_ix(&ctx, &buyer, 2)],
        "deposit_otc_payment",
    );
    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_SECONDARY);
    pause::assert_paused(
        try_send(
            &mut svm,
            &[&ctx.seller],
            &[deposit_asset_ix(&ctx, &seller, 2)],
        ),
        "settling deposit_otc_asset under SECONDARY",
    );

    // Deal 3 — the seller funds it, then the deal lapses.
    pause::pause_only(&mut svm, &ctx.payer, all_but);
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, &seller, 3)],
        "deposit_otc_asset (deal 3)",
    );

    // Full pause: the admin cancels deal 2 (buyer refunded) and anyone
    // expires deal 3 (seller refunded).
    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_FLAGS_ALL);
    let buyer_before = token_balance(&svm, &ctx.buyer_payment_ata);
    send(
        &mut svm,
        &[&ctx.payer],
        &[cancel_deal_ix(&ctx, &payer, 2)],
        "cancel_otc_deal under 0x3F",
    );
    assert_eq!(
        token_balance(&svm, &ctx.buyer_payment_ata) - buyer_before,
        DEAL_PRICE
    );
    warp_to(&mut svm, 3_000);
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    send(
        &mut svm,
        &[&stranger],
        &[expire_deal_ix(&ctx, &stranger.pubkey(), 3)],
        "expire_otc_deal under 0x3F",
    );
    assert_eq!(
        load::<OtcDeal>(&svm, &deal_pdas(&ctx, 3).0).status,
        OtcDealStatus::Expired
    );
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        SELLER_UNITS - DEAL_AMOUNT,
        "deal 3 refunded to the seller"
    );
}

// ── 2D: reclaim_rent — OtcDeal arm ───────────────────────────────────────────

fn funded_wallet(svm: &mut LiteSVM) -> Keypair {
    let wallet = Keypair::new();
    svm.airdrop(&wallet.pubkey(), 10_000_000_000).unwrap();
    wallet
}

fn reclaim_deal_ix(
    ctx: &Ctx,
    caller: &Pubkey,
    owner: &Pubkey,
    deal_id: u64,
    payment_program: Option<Pubkey>,
) -> Instruction {
    let (deal_pda, asset_escrow, payment_escrow) = deal_pdas(ctx, deal_id);
    reclaim::reclaim_ix(
        caller,
        owner,
        &deal_pda,
        &asset_escrow,
        Some(payment_escrow),
        Some(TOKEN_2022),
        payment_program,
    )
}

/// Asserts a reclaim by `deal.admin` (the boot payer) pays it exactly both
/// escrows' rent plus the deal's rent above the tombstone minimum.
fn reclaim_deal_and_check(
    svm: &mut LiteSVM,
    ctx: &Ctx,
    fee: &Keypair,
    deal_id: u64,
    payment_program: Pubkey,
) {
    let admin = ctx.payer.pubkey();
    let (deal_pda, asset_escrow, payment_escrow) = deal_pdas(ctx, deal_id);
    let expected =
        reclaim::expected_tombstone_refund(svm, &deal_pda, &[asset_escrow, payment_escrow]);
    let before = reclaim::lamports(svm, &admin);
    svm.expire_blockhash();
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(
        &[reclaim_deal_ix(
            ctx,
            &admin,
            &admin,
            deal_id,
            Some(payment_program),
        )],
        Some(&fee.pubkey()),
        &bh,
    );
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[fee, &ctx.payer])
        .expect("sign");
    let meta = svm
        .send_transaction(tx)
        .unwrap_or_else(|e| panic!("reclaim deal {deal_id}: {e:?}"));
    assert_eq!(
        reclaim::lamports(svm, &admin),
        before + expected,
        "deal {deal_id}: all rent to deal.admin"
    );
    reclaim::assert_tombstone(svm, &deal_pda);
    reclaim::assert_gone(svm, &asset_escrow);
    reclaim::assert_gone(svm, &payment_escrow);
    let events = kyc_registry::events::<asset_registry::RentReclaimed>(&meta.logs);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, asset_registry::RECLAIM_OTC);
    assert_eq!(events[0].owner, admin);
    assert_eq!(events[0].lamports, expected);
}

/// Completed, Cancelled and Expired deals (Token-2022 payment leg) and a
/// Cancelled deal with a legacy SPL payment leg: both escrows close, the deal
/// is tombstoned and every lamport goes to `deal.admin`.
#[test]
fn otc_reclaim_after_completed_cancelled_and_expired() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);
    let admin = ctx.payer.pubkey();
    let fee = funded_wallet(&mut svm);
    for id in 1..=3u64 {
        send(
            &mut svm,
            &[&ctx.payer],
            &[create_deal_ix(&ctx, &admin, id, 2_000)],
            "create_otc_deal",
        );
    }
    // 1: both sides deposit → Completed.
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, &ctx.seller.pubkey(), 1)],
        "deposit asset",
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_payment_ix(&ctx, &ctx.buyer.pubkey(), 1)],
        "deposit payment",
    );
    // 2: the seller deposits, the admin cancels (refund) → Cancelled.
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, &ctx.seller.pubkey(), 2)],
        "deposit asset 2",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[cancel_deal_ix(&ctx, &admin, 2)],
        "cancel 2",
    );
    // 3: nobody deposits, it expires → Expired.
    warp_to(&mut svm, 3_000);
    send(
        &mut svm,
        &[&fee],
        &[expire_deal_ix(&ctx, &fee.pubkey(), 3)],
        "expire 3",
    );
    for (id, status) in [
        (1u64, OtcDealStatus::Completed),
        (2, OtcDealStatus::Cancelled),
        (3, OtcDealStatus::Expired),
    ] {
        assert_eq!(load::<OtcDeal>(&svm, &deal_pdas(&ctx, id).0).status, status);
        reclaim_deal_and_check(&mut svm, &ctx, &fee, id, TOKEN_2022);
    }

    // 4: a legacy SPL payment mint.
    let spl = anchor_spl::token::ID;
    let spl_mint = {
        use anchor_lang::solana_program::system_instruction;
        let mint = Keypair::new();
        let lamports = svm.minimum_balance_for_rent_exemption(82);
        let create = system_instruction::create_account(&admin, &mint.pubkey(), lamports, 82, &spl);
        let init = token_ix::initialize_mint2(&spl, &mint.pubkey(), &admin, None, 6).unwrap();
        send(&mut svm, &[&ctx.payer, &mint], &[create, init], "spl mint");
        mint.pubkey()
    };
    send(
        &mut svm,
        &[&ctx.payer],
        &[ata_ix::create_associated_token_account(
            &admin,
            &ctx.buyer.pubkey(),
            &spl_mint,
            &spl,
        )],
        "buyer spl ata",
    );
    let buyer_spl =
        get_associated_token_address_with_program_id(&ctx.buyer.pubkey(), &spl_mint, &spl);
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_deal_ix_with(&ctx, &admin, 4, 0, &spl_mint, &spl)],
        "create spl deal",
    );
    let (_, _, spl_payment_escrow) = deal_pdas(&ctx, 4);
    assert_eq!(svm.get_account(&spl_payment_escrow).unwrap().owner, spl);
    send(
        &mut svm,
        &[&ctx.payer],
        &[cancel_deal_ix_with(
            &ctx,
            &admin,
            4,
            (&spl_mint, &spl, &buyer_spl),
        )],
        "cancel spl deal",
    );
    // The payment program must be the SPL one (the escrow's owner).
    reclaim::assert_code(
        try_send(
            &mut svm,
            &[&ctx.payer],
            &[reclaim_deal_ix(&ctx, &admin, &admin, 4, Some(TOKEN_2022))],
        ),
        6001,
    );
    reclaim_deal_and_check(&mut svm, &ctx, &fee, 4, spl);
}

/// Open → 6140; another Admin, a non-signing owner, a missing payment escrow
/// or program → 6001; payment dust → 6139. A tombstoned deal id can never be
/// re-created and the deposits fail with 3002.
#[test]
fn otc_reclaim_refusals_and_the_tombstone_is_permanent() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);
    let admin = ctx.payer.pubkey();
    let other = funded_wallet(&mut svm);
    send(
        &mut svm,
        &[&ctx.payer],
        &[reclaim::add_admin_ix(&admin, &other.pubkey())],
        "second admin",
    );
    for id in 1..=2u64 {
        send(
            &mut svm,
            &[&ctx.payer],
            &[create_deal_ix(&ctx, &admin, id, 0)],
            "create_otc_deal",
        );
    }
    let t22 = Some(TOKEN_2022);
    reclaim::assert_code(
        try_send(
            &mut svm,
            &[&ctx.payer],
            &[reclaim_deal_ix(&ctx, &admin, &admin, 1, t22)],
        ),
        6140,
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[cancel_deal_ix(&ctx, &admin, 1)],
        "cancel 1",
    );
    let (deal_1, asset_escrow_1, _) = deal_pdas(&ctx, 1);
    for (signer, ix) in [
        // Another Admin, for itself or naming deal.admin as the owner.
        (
            &other,
            reclaim_deal_ix(&ctx, &other.pubkey(), &other.pubkey(), 1, t22),
        ),
        (
            &other,
            reclaim_deal_ix(&ctx, &other.pubkey(), &admin, 1, t22),
        ),
        // deal.admin, but the rent sent elsewhere.
        (
            &ctx.payer,
            reclaim_deal_ix(&ctx, &admin, &other.pubkey(), 1, t22),
        ),
        // Missing payment program / payment escrow.
        (&ctx.payer, reclaim_deal_ix(&ctx, &admin, &admin, 1, None)),
        (
            &ctx.payer,
            reclaim::reclaim_ix(&admin, &admin, &deal_1, &asset_escrow_1, None, t22, t22),
        ),
    ] {
        reclaim::assert_code(try_send(&mut svm, &[signer], &[ix]), 6001);
    }
    // Payment dust (the payment mint has no hook) keeps the deal unclosable.
    let (_, _, payment_escrow_1) = deal_pdas(&ctx, 1);
    let dust = token_ix::transfer_checked(
        &TOKEN_2022,
        &ctx.buyer_payment_ata,
        &ctx.payment_mint,
        &payment_escrow_1,
        &ctx.buyer.pubkey(),
        &[],
        1,
        6,
    )
    .unwrap();
    send(&mut svm, &[&ctx.buyer], &[dust], "payment dust");
    reclaim::assert_code(
        try_send(
            &mut svm,
            &[&ctx.payer],
            &[reclaim_deal_ix(&ctx, &admin, &admin, 1, t22)],
        ),
        6139,
    );

    // Deal 2: reclaimed, then every reuse fails.
    send(
        &mut svm,
        &[&ctx.payer],
        &[cancel_deal_ix(&ctx, &admin, 2)],
        "cancel 2",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[reclaim_deal_ix(&ctx, &admin, &admin, 2, t22)],
        "reclaim 2",
    );
    let (deal_2, _, _) = deal_pdas(&ctx, 2);
    reclaim::assert_tombstone(&svm, &deal_2);
    reclaim::assert_code(
        try_send(
            &mut svm,
            &[&ctx.payer],
            &[reclaim_deal_ix(&ctx, &admin, &admin, 2, t22)],
        ),
        6001,
    );
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[create_deal_ix(&ctx, &admin, 2, 0)],
    )
    .expect_err("a tombstoned deal id cannot be re-created");
    assert!(err.contains("already in use"), "got: {err}");
    for (signer, ix) in [
        (&ctx.seller, deposit_asset_ix(&ctx, &ctx.seller.pubkey(), 2)),
        (&ctx.buyer, deposit_payment_ix(&ctx, &ctx.buyer.pubkey(), 2)),
    ] {
        reclaim::assert_code(try_send(&mut svm, &[signer], &[ix]), 3002);
    }
    reclaim::assert_tombstone(&svm, &deal_2);
}
