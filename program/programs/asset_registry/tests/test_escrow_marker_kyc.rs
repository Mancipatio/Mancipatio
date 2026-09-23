//! EscrowMarker + KycGated end-to-end (LiteSVM, real Token-2022 transfers).
//!
//! The mint is flipped to `KycGated` via `update_transfer_hook_config`, so
//! every share-token `transfer_checked` runs the full 7-meta hook tail:
//!   [BlockEntry(src auth), TransferHookConfig, KycRegistry, asset_registry
//!    program, KycEntry(dest owner), EscrowMarker(dest owner),
//!    EscrowMarker(src owner)] + ExtraAccountMetaList + hook program.
//!
//! The dividing line proven here: the escrow-marker exemption is what lets
//! units move INTO an escrow and BACK to whoever deposited them. It is NOT a
//! licence to DELIVER units out of an escrow to an arbitrary wallet — every
//! delivery leg re-derives the receiver's KYC in `asset_registry` itself.
//!
//! Proven here:
//!   * deposit into a deal escrow succeeds with NO KYC for the escrow —
//!     the destination-owner EscrowMarker exempts the leg;
//!   * settle escrow→KYC'd buyer succeeds (source marker + valid entry);
//!   * settle escrow→NON-KYC'd buyer FAILS. This used to pass "by design"
//!     (the platform vets the parties off-chain before opening the deal) —
//!     but `create_otc_deal` is admin-gated and the admin picks BOTH
//!     `deal.buyer` and `deal.seller`, so that argument reduced to trusting
//!     one key: mint to treasury → open a deal selling to a non-KYC wallet →
//!     deposit both sides → settle. `settle_otc_deal` now calls
//!     `require_receiver_kyc` on the buyer leg (see `util.rs`);
//!   * refund escrow→revoked-KYC seller still succeeds, on both the cancel
//!     and the expire path (source marker; a refund to the depositor must
//!     never be blocked by a lapsed passport);
//!   * custody: `return_custody_vault` refunds a beneficiary's OWN recorded
//!     deposit even with a revoked passport, but refuses to hand over units
//!     the beneficiary never deposited unless the receiver's KYC passes —
//!     which closes the two-hop `mint_to_treasury` → raw transfer into a
//!     `DeliveryEscrow` → `return` laundering route;
//!   * direct wallet→wallet to a non-KYC'd receiver still fails (no markers);
//!   * the marker is closed after the terminal path (settle / cancel).

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
        OfferStatus, OtcDeal, OtcDealStatus, RealizeAction, ShareClassType, VaultState, VaultType,
        RIGHT_DIVIDEND, RIGHT_LIQ_PREF, RIGHT_VOTE,
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
/// Jurisdiction used for every KYC approval here (bit set in the registry).
const JURISDICTION: u16 = 222;
const FAR_FUTURE: i64 = 4_102_444_800; // 2100-01-01

// ── Helpers (pattern from test_otc_deal.rs) ──────────────────────────────────

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

fn account_closed(svm: &LiteSVM, pda: &Pubkey) -> bool {
    svm.get_account(pda)
        .map(|a| a.data.is_empty() || a.lamports == 0)
        .unwrap_or(true)
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
    hook_config_pda: Pubkey,
    kyc_registry_pda: Pubkey,
    seller: Keypair,
    seller_share_ata: Pubkey,
    seller_payment_ata: Pubkey,
    buyer: Keypair,
    buyer_share_ata: Pubkey,
    buyer_payment_ata: Pubkey,
}

fn escrow_marker_of(ctx: &Ctx, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::ESCROW_MARKER_SEED, owner.as_ref()],
        &ctx.program_id,
    )
    .0
}

/// The full KycGated hook tail for one `transfer_checked` leg, in meta-list
/// order, plus the ExtraAccountMetaList + hook program (Token-2022 finds each
/// resolved meta among the outer instruction accounts).
fn kyc_hook_metas(
    ctx: &Ctx,
    source_authority: &Pubkey,
    src_owner: &Pubkey,
    dest_owner: &Pubkey,
) -> Vec<AccountMeta> {
    let (block_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::BLOCK_ENTRY_SEED, source_authority.as_ref()],
        &ctx.hook_id,
    );
    let kyc_entry = Pubkey::find_program_address(
        &[
            asset_registry::KYC_SEED,
            ctx.kyc_registry_pda.as_ref(),
            dest_owner.as_ref(),
        ],
        &ctx.program_id,
    )
    .0;
    vec![
        AccountMeta::new_readonly(block_pda, false),
        AccountMeta::new_readonly(ctx.hook_config_pda, false),
        AccountMeta::new_readonly(ctx.kyc_registry_pda, false),
        AccountMeta::new_readonly(ctx.program_id, false), // asset_registry program
        AccountMeta::new_readonly(kyc_entry, false),
        AccountMeta::new_readonly(escrow_marker_of(ctx, dest_owner), false),
        AccountMeta::new_readonly(escrow_marker_of(ctx, src_owner), false),
        AccountMeta::new_readonly(ctx.extra_metas_pda, false),
        AccountMeta::new_readonly(ctx.hook_id, false),
    ]
}

/// Approves `holder` in the boot registry (payer is the KYC authority).
fn approve_kyc(svm: &mut LiteSVM, ctx: &Ctx, holder: &Pubkey) {
    let kyc_entry = Pubkey::find_program_address(
        &[
            asset_registry::KYC_SEED,
            ctx.kyc_registry_pda.as_ref(),
            holder.as_ref(),
        ],
        &ctx.program_id,
    )
    .0;
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::ApproveHolder {
                holder: *holder,
                jurisdiction: JURISDICTION,
                accreditation_level: 1,
                expiry: FAR_FUTURE,
                provider_id: 1,
                external_ref_hash: [5u8; 32],
            }
            .data(),
            acc::ApproveHolder {
                authority: ctx.payer.pubkey(),
                kyc_registry: ctx.kyc_registry_pda,
                kyc_entry,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "approve_holder",
    );
}

/// Revokes `holder` in the boot registry.
fn revoke_kyc(svm: &mut LiteSVM, ctx: &Ctx, holder: &Pubkey) {
    let kyc_entry = Pubkey::find_program_address(
        &[
            asset_registry::KYC_SEED,
            ctx.kyc_registry_pda.as_ref(),
            holder.as_ref(),
        ],
        &ctx.program_id,
    )
    .0;
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::RevokeHolder { holder: *holder }.data(),
            acc::RevokeHolder {
                authority: ctx.payer.pubkey(),
                kyc_registry: ctx.kyc_registry_pda,
                kyc_entry,
            }
            .to_account_metas(None),
        )],
        "revoke_holder",
    );
}

/// Boots the full stack with the mint in **KycGated** mode: platform → issuer
/// → asset → share class → hook-wired mint (Open) → KYC registry → seller
/// funded while still Open (treasury mint + hook transfer) →
/// `update_transfer_hook_config` (Open → KycGated, meta list grows to 7).
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

    let legal_entity_id: [u8; 32] = *b"ESCROW-MARKER-ENTITY-00000000001";
    let asset_id = "marker-pilot-001";
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
    let (hook_config_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint_pda.as_ref()],
        &hook_id,
    );
    let (extra_metas_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint_pda.as_ref()],
        &hook_id,
    );
    let (kyc_registry_pda, _) = Pubkey::find_program_address(
        &[asset_registry::KYC_REGISTRY_SEED, payer.pubkey().as_ref()],
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
                jurisdiction: JURISDICTION,
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
                name: "Escrow Marker Pilot".to_string(),
                symbol_prefix: "MRKR".to_string(),
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

    // blocklist authority (payer) — required by update_transfer_hook_config
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

    // KYC registry: all jurisdictions approved, none blocked (payer = provider)
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::CreateKycRegistry {
                approved_jurisdictions: [0xFFu8; 128],
                blocked_jurisdictions: [0u8; 128],
            }
            .data(),
            acc::CreateKycRegistry {
                authority: payer.pubkey(),
                admin_authority: payer.pubkey(),
                admin_record: admin_pda,
                kyc_registry: kyc_registry_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "create_kyc_registry",
    );

    // payment mint + party token accounts
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

    // fund the seller with share units while the mint is still Open:
    // treasury-mint to the issuer authority's own ATA (mint_to_treasury binds
    // the destination to the authority), then a hook-checked transfer to the
    // seller (3-account Open tail).
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
        "fund seller (Open transfer)",
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

    // Flip the mint Open → KycGated (meta list grows 1 → 7 metas)
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            hook_id,
            &transfer_hook::instruction::UpdateTransferHookConfig {
                restriction_mode: transfer_hook::RestrictionMode::KycGated,
                kyc_registry: Some(kyc_registry_pda),
            }
            .data(),
            transfer_hook::accounts::UpdateTransferHookConfig {
                authority: payer.pubkey(),
                blocklist_authority: blocklist_authority_pda,
                mint: mint_pda,
                config: hook_config_pda,
                extra_account_meta_list: extra_metas_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "update_transfer_hook_config (Open -> KycGated)",
    );

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
        hook_config_pda,
        kyc_registry_pda,
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

fn create_deal(svm: &mut LiteSVM, ctx: &Ctx, deal_id: u64) -> Pubkey {
    create_deal_with_expiry(svm, ctx, deal_id, 0)
}

fn create_deal_with_expiry(svm: &mut LiteSVM, ctx: &Ctx, deal_id: u64, expires_at: i64) -> Pubkey {
    let (deal_pda, asset_escrow_pda, payment_escrow_pda) = deal_pdas(ctx, deal_id);
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::CreateOtcDeal {
                deal_id,
                buyer: ctx.buyer.pubkey(),
                seller: ctx.seller.pubkey(),
                amount: DEAL_AMOUNT,
                price: DEAL_PRICE,
                payment_mint: ctx.payment_mint,
                expires_at,
            }
            .data(),
            acc::CreateOtcDeal {
                authority: ctx.payer.pubkey(),
                admin_record: ctx.admin_pda,
                share_class: ctx.share_class_pda,
                mint: ctx.mint_pda,
                payment_mint: ctx.payment_mint,
                deal: deal_pda,
                asset_escrow: asset_escrow_pda,
                payment_escrow: payment_escrow_pda,
                escrow_marker: escrow_marker_of(ctx, &deal_pda),
                token_program: TOKEN_2022,
                payment_token_program: TOKEN_2022,
                system_program: system_program::ID,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        )],
        "create_otc_deal",
    );
    deal_pda
}

/// `deposit_otc_asset` — the hook-aware seller → asset-escrow leg. If the
/// payment is already in, appends the settle leg's tail too.
fn deposit_asset_ix(ctx: &Ctx, deal_id: u64, with_settle: bool) -> Instruction {
    let (deal_pda, asset_escrow_pda, payment_escrow_pda) = deal_pdas(ctx, deal_id);
    let mut metas = acc::DepositOtcAsset {
        seller: ctx.seller.pubkey(),
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
    // deposit leg: seller ATA (owner seller) → escrow (owner deal PDA)
    metas.extend(kyc_hook_metas(
        ctx,
        &ctx.seller.pubkey(),
        &ctx.seller.pubkey(),
        &deal_pda,
    ));
    if with_settle {
        // settle leg: escrow (owner deal PDA) → buyer ATA (owner buyer)
        metas.extend(kyc_hook_metas(
            ctx,
            &deal_pda,
            &deal_pda,
            &ctx.buyer.pubkey(),
        ));
    }
    Instruction::new_with_bytes(ctx.program_id, &ixd::DepositOtcAsset {}.data(), metas)
}

/// `deposit_otc_payment` — plain-CPI payment deposit; when the asset is
/// already in, the settle leg (escrow → buyer) runs with its hook tail.
fn deposit_payment_ix(ctx: &Ctx, deal_id: u64, with_settle: bool) -> Instruction {
    let (deal_pda, asset_escrow_pda, payment_escrow_pda) = deal_pdas(ctx, deal_id);
    let mut metas = acc::DepositOtcPayment {
        buyer: ctx.buyer.pubkey(),
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
    if with_settle {
        metas.extend(kyc_hook_metas(
            ctx,
            &deal_pda,
            &deal_pda,
            &ctx.buyer.pubkey(),
        ));
    }
    Instruction::new_with_bytes(ctx.program_id, &ixd::DepositOtcPayment {}.data(), metas)
}

fn cancel_deal_ix(ctx: &Ctx, deal_id: u64) -> Instruction {
    let (deal_pda, asset_escrow_pda, payment_escrow_pda) = deal_pdas(ctx, deal_id);
    let mut metas = acc::CancelOtcDeal {
        authority: ctx.payer.pubkey(),
        admin_record: ctx.admin_pda,
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
    // refund leg: escrow (owner deal PDA) → seller ATA (owner seller)
    metas.extend(kyc_hook_metas(
        ctx,
        &deal_pda,
        &deal_pda,
        &ctx.seller.pubkey(),
    ));
    Instruction::new_with_bytes(ctx.program_id, &ixd::CancelOtcDeal {}.data(), metas)
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
    // refund leg: escrow (owner deal PDA) → seller ATA (owner seller)
    metas.extend(kyc_hook_metas(
        ctx,
        &deal_pda,
        &deal_pda,
        &ctx.seller.pubkey(),
    ));
    Instruction::new_with_bytes(ctx.program_id, &ixd::ExpireOtcDeal {}.data(), metas)
}

/// Builds a direct wallet→wallet `transfer_checked` (seller → `dest_ata`
/// owned by `dest_owner`) with the full KycGated tail.
fn direct_transfer_ix(
    ctx: &Ctx,
    dest_ata: &Pubkey,
    dest_owner: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut ix = token_ix::transfer_checked(
        &TOKEN_2022,
        &ctx.seller_share_ata,
        &ctx.mint_pda,
        dest_ata,
        &ctx.seller.pubkey(),
        &[],
        amount,
        0,
    )
    .unwrap();
    ix.accounts.extend(kyc_hook_metas(
        ctx,
        &ctx.seller.pubkey(),
        &ctx.seller.pubkey(),
        dest_owner,
    ));
    ix
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn kyc_gated_deal_deposit_and_settle_to_kycd_buyer() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);
    approve_kyc(&mut svm, &ctx, &ctx.buyer.pubkey());

    let deal_id = 1u64;
    let deal_pda = create_deal(&mut svm, &ctx, deal_id);
    let (_, asset_escrow_pda, _) = deal_pdas(&ctx, deal_id);
    assert!(
        svm.get_account(&escrow_marker_of(&ctx, &deal_pda))
            .is_some(),
        "escrow marker created with the deal"
    );

    // Deposit into the deal escrow: the escrow owner (deal PDA) has NO
    // KycEntry — only the DESTINATION-owner marker lets this leg through.
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, deal_id, false)],
        "deposit_otc_asset (KycGated, dest marker)",
    );
    assert_eq!(token_balance(&svm, &asset_escrow_pda), DEAL_AMOUNT);

    // Settle escrow → KYC'd buyer (source marker + valid receiver KYC).
    send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_payment_ix(&ctx, deal_id, true)],
        "deposit_otc_payment settles (KycGated)",
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(deal.status, OtcDealStatus::Completed);
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), DEAL_AMOUNT);
    assert_eq!(token_balance(&svm, &ctx.seller_payment_ata), DEAL_PRICE);
    assert!(
        account_closed(&svm, &escrow_marker_of(&ctx, &deal_pda)),
        "escrow marker closed after settle"
    );
}

/// ATTACK — admin-created OTC deal as a delivery channel to a wallet with no
/// `KycEntry`. The settle leg's SOURCE is the deal escrow (owner = deal PDA,
/// which carries an `EscrowMarker`), so the hook's source-marker exemption
/// fires and the hook waves the leg through. The only thing standing between
/// a privileged signer and a non-KYC'd buyer is `settle_otc_deal`'s own
/// `require_receiver_kyc` call.
///
/// MUTATION PROOF: delete that call from `util::settle_otc_deal` and this test
/// fails at the first `expect_err` — the settle goes through and
/// `buyer_share_ata` ends up holding `DEAL_AMOUNT`, i.e. the attack succeeds.
/// (Its previous incarnation, `..._passes_by_design`, asserted exactly that.)
#[test]
fn kyc_gated_settle_to_non_kycd_buyer_is_rejected() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);
    // NOTE: the buyer is deliberately never KYC-approved.

    let deal_id = 1u64;
    let deal_pda = create_deal(&mut svm, &ctx, deal_id);
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, deal_id, false)],
        "deposit_otc_asset",
    );
    let (_, asset_escrow_pda, _) = deal_pdas(&ctx, deal_id);

    // The settle attempt fails — ReceiverNotApproved from asset_registry.
    let err = try_send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_payment_ix(&ctx, deal_id, true)],
    )
    .expect_err("settle to a buyer with no KycEntry must be rejected");
    assert!(
        err.contains("Custom(6069)"),
        "expected ReceiverNotApproved (6069), got: {err}"
    );
    assert_eq!(
        token_balance(&svm, &ctx.buyer_share_ata),
        0,
        "no units leaked to the non-KYC'd buyer"
    );
    assert_eq!(
        token_balance(&svm, &asset_escrow_pda),
        DEAL_AMOUNT,
        "escrow untouched after the rejected settle"
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(deal.status, OtcDealStatus::Open, "deal still open");

    // POSITIVE CONTROL — approve the buyer and the very same settle succeeds.
    approve_kyc(&mut svm, &ctx, &ctx.buyer.pubkey());
    send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_payment_ix(&ctx, deal_id, true)],
        "deposit_otc_payment settles to a KYC'd buyer",
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(deal.status, OtcDealStatus::Completed);
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), DEAL_AMOUNT);
    assert!(account_closed(&svm, &escrow_marker_of(&ctx, &deal_pda)));
}

/// The refund direction of the SAME escrow stays exempt — and must, or a
/// passport that lapses while a deposit sits in escrow would confiscate it.
/// Here the permissionless `expire_otc_deal` path is exercised (its sibling
/// `cancel_otc_deal` is covered above).
#[test]
fn kyc_gated_expire_refunds_revoked_seller() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);
    approve_kyc(&mut svm, &ctx, &ctx.seller.pubkey());

    let deal_id = 7u64;
    let deal_pda = create_deal_with_expiry(&mut svm, &ctx, deal_id, 2_000);
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, deal_id, false)],
        "deposit_otc_asset",
    );

    // Passport revoked while the units sit in escrow, then the deal expires.
    revoke_kyc(&mut svm, &ctx, &ctx.seller.pubkey());
    warp_to(&mut svm, 3_000);

    // Permissionless expiry by a complete stranger — still refunds the seller.
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    send(
        &mut svm,
        &[&stranger],
        &[expire_deal_ix(&ctx, &stranger.pubkey(), deal_id)],
        "expire_otc_deal refunds a revoked seller",
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(deal.status, OtcDealStatus::Expired);
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        SELLER_UNITS,
        "revoked seller still got the refund (source marker, refund direction)"
    );
}

#[test]
fn kyc_gated_cancel_refunds_revoked_seller() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);
    approve_kyc(&mut svm, &ctx, &ctx.seller.pubkey());

    let deal_id = 1u64;
    let deal_pda = create_deal(&mut svm, &ctx, deal_id);
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, deal_id, false)],
        "deposit_otc_asset",
    );
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        SELLER_UNITS - DEAL_AMOUNT
    );

    // The seller's KYC is revoked while their units sit in escrow…
    revoke_kyc(&mut svm, &ctx, &ctx.seller.pubkey());

    // …the admin cancel still refunds them: the refund leg's source is the
    // escrow (owner = deal PDA, marker) ⇒ exemption ⇒ no stranded funds.
    send(
        &mut svm,
        &[&ctx.payer],
        &[cancel_deal_ix(&ctx, deal_id)],
        "cancel_otc_deal refunds a revoked seller",
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(deal.status, OtcDealStatus::Cancelled);
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        SELLER_UNITS,
        "revoked seller still got the refund (source marker)"
    );
    assert!(
        account_closed(&svm, &escrow_marker_of(&ctx, &deal_pda)),
        "escrow marker closed after cancel"
    );
}

#[test]
fn kyc_gated_direct_transfer_stays_gated() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let receiver = Keypair::new().pubkey();
    let receiver_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &receiver);

    // Direct wallet→wallet to a NON-KYC'd receiver: both markers unresolved
    // (system-owned) ⇒ no exemption ⇒ ReceiverNotApproved (Custom(6005)).
    let err = try_send(
        &mut svm,
        &[&ctx.seller],
        &[direct_transfer_ix(&ctx, &receiver_ata, &receiver, 3)],
    )
    .expect_err("direct transfer to a non-KYC'd receiver must fail");
    assert!(err.contains("Custom(6005)"), "got: {err}");
    assert_eq!(token_balance(&svm, &receiver_ata), 0);

    // Approve the receiver — the same transfer now passes.
    approve_kyc(&mut svm, &ctx, &receiver);
    send(
        &mut svm,
        &[&ctx.seller],
        &[direct_transfer_ix(&ctx, &receiver_ata, &receiver, 3)],
        "direct transfer to a KYC'd receiver",
    );
    assert_eq!(token_balance(&svm, &receiver_ata), 3);
}

// ── Offer helpers ─────────────────────────────────────────────────────────────

const OFFER_AMOUNT: u64 = 10;
const OFFER_PRICE: u64 = 5_000_000;

/// ATTACK (OTC refund leg) — `create_otc_deal` is admin-gated and the admin
/// names BOTH parties, so the same laundering shape works through the refund
/// path: open a deal whose `seller` is a wallet with no valid `KycEntry`, have
/// it deposit the token amount so `asset_deposited` flips, then raw-push a pile
/// of (freshly minted) units into the asset escrow and cancel. The refund used
/// to sweep `asset_escrow.amount`.
///
/// The refund is now capped at `deal.asset_deposited_amount`.
///
/// MUTATION PROOF: in `util::refund_otc_deposits` transfer
/// `asset_escrow.amount` instead of `asset.payout` and this test fails at the
/// escrow assertion — the seller receives DEAL_AMOUNT + LAUNDERED.
#[test]
fn kyc_gated_cancel_deal_refuses_units_the_seller_never_deposited() {
    const LAUNDERED: u64 = 20;
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    // The seller is NOT KYC-approved (boot leaves everyone unapproved).
    let deal_id = 20u64;
    let (deal_pda, asset_escrow, _) = deal_pdas(&ctx, deal_id);
    create_deal(&mut svm, &ctx, deal_id);
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, deal_id, false)],
        "deposit_otc_asset",
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(deal.asset_deposited_amount, DEAL_AMOUNT, "ledger credited");

    // The un-ledgered pile.
    raw_fund_escrow(&mut svm, &ctx, &asset_escrow, &deal_pda, LAUNDERED);
    assert_eq!(token_balance(&svm, &asset_escrow), DEAL_AMOUNT + LAUNDERED);
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(
        deal.asset_deposited_amount, DEAL_AMOUNT,
        "a raw transfer credits no deposit"
    );

    let before = token_balance(&svm, &ctx.seller_share_ata);
    send(
        &mut svm,
        &[&ctx.payer],
        &[cancel_deal_ix(&ctx, deal_id)],
        "cancel_otc_deal (non-KYC seller, over-funded escrow)",
    );
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        before + DEAL_AMOUNT,
        "only the recorded deposit is refunded"
    );
    assert_eq!(
        token_balance(&svm, &asset_escrow),
        LAUNDERED,
        "the un-deposited surplus stays in the escrow"
    );
    let deal: OtcDeal = load(&svm, &deal_pda);
    assert_eq!(
        deal.status,
        OtcDealStatus::Cancelled,
        "the deal still closes — an admin path must not be brickable"
    );

    // POSITIVE CONTROL — with the seller KYC-approved the identical sequence
    // hands over the surplus too, proving the receiver check is the gate.
    approve_kyc(&mut svm, &ctx, &ctx.seller.pubkey());
    let deal2_id = 21u64;
    let (deal2_pda, asset_escrow2, _) = deal_pdas(&ctx, deal2_id);
    create_deal(&mut svm, &ctx, deal2_id);
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_asset_ix(&ctx, deal2_id, false)],
        "deposit_otc_asset #2",
    );
    raw_fund_escrow(&mut svm, &ctx, &asset_escrow2, &deal2_pda, LAUNDERED);
    let before = token_balance(&svm, &ctx.seller_share_ata);
    send(
        &mut svm,
        &[&ctx.payer],
        &[cancel_deal_ix(&ctx, deal2_id)],
        "cancel_otc_deal (KYC'd seller)",
    );
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        before + DEAL_AMOUNT + LAUNDERED
    );
    assert_eq!(token_balance(&svm, &asset_escrow2), 0);
}

// ── Offer helpers (the permissionless escrow→wallet exit) ────────────────────

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

/// `create_offer` for an arbitrary maker — permissionless, no KYC, no units,
/// and it opens an EMPTY escrow. This is the attack primitive of finding #1.
fn create_offer_by(
    svm: &mut LiteSVM,
    ctx: &Ctx,
    maker: &Keypair,
    offer_id: u64,
    amount: u64,
    expires_at: i64,
) -> (Pubkey, Pubkey) {
    let (offer_pda, escrow_pda) = offer_pdas(ctx, offer_id);
    send(
        svm,
        &[maker],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::CreateOffer {
                offer_id,
                amount,
                price: OFFER_PRICE,
                expires_at,
            }
            .data(),
            acc::CreateOffer {
                maker: maker.pubkey(),
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
        )],
        "create_offer",
    );
    (offer_pda, escrow_pda)
}

/// `deposit_to_offer_escrow` — the ONLY route that credits `offer.deposited`.
fn deposit_to_offer_ix(
    ctx: &Ctx,
    offer_id: u64,
    maker: &Pubkey,
    maker_share_ata: &Pubkey,
    amount: u64,
) -> Instruction {
    let (offer_pda, escrow_pda) = offer_pdas(ctx, offer_id);
    let mut metas = acc::DepositToOfferEscrow {
        maker: *maker,
        offer: offer_pda,
        mint: ctx.mint_pda,
        escrow: escrow_pda,
        maker_share_account: *maker_share_ata,
        token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    // deposit leg: maker ATA (owner maker) → escrow (owner offer PDA)
    metas.extend(kyc_hook_metas(ctx, maker, maker, &offer_pda));
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::DepositToOfferEscrow { amount }.data(),
        metas,
    )
}

/// The seller (maker) opens an offer and funds its escrow with `OFFER_AMOUNT`
/// units THROUGH the ledgered instruction. The funding leg's destination is the
/// offer PDA (has a dest marker) so it is exempt even in KycGated mode.
fn create_and_fund_offer(svm: &mut LiteSVM, ctx: &Ctx, offer_id: u64) -> (Pubkey, Pubkey) {
    let seller_pk = ctx.seller.pubkey();
    let (offer_pda, escrow_pda) = create_offer_by(svm, ctx, &ctx.seller, offer_id, OFFER_AMOUNT, 0);
    send(
        svm,
        &[&ctx.seller],
        &[deposit_to_offer_ix(
            ctx,
            offer_id,
            &seller_pk,
            &ctx.seller_share_ata,
            OFFER_AMOUNT,
        )],
        "deposit_to_offer_escrow",
    );
    (offer_pda, escrow_pda)
}

/// `cancel_offer` for `maker`, refunding into `maker_share_ata`.
fn cancel_offer_ix(
    ctx: &Ctx,
    offer_id: u64,
    maker: &Pubkey,
    maker_share_ata: &Pubkey,
) -> Instruction {
    let (offer_pda, escrow_pda) = offer_pdas(ctx, offer_id);
    let mut metas = acc::CancelOffer {
        maker: *maker,
        offer: offer_pda,
        mint: ctx.mint_pda,
        escrow: escrow_pda,
        maker_share_account: *maker_share_ata,
        escrow_marker: escrow_marker_of(ctx, &offer_pda),
        share_token_program: TOKEN_2022,
    }
    .to_account_metas(None);
    // refund leg: escrow (owner offer PDA) → maker ATA
    metas.extend(kyc_hook_metas(ctx, &offer_pda, &offer_pda, maker));
    Instruction::new_with_bytes(ctx.program_id, &ixd::CancelOffer {}.data(), metas)
}

/// `expire_offer` — permissionless; `payer` may be anybody.
fn expire_offer_ix(
    ctx: &Ctx,
    offer_id: u64,
    payer: &Pubkey,
    maker: &Pubkey,
    maker_share_ata: &Pubkey,
) -> Instruction {
    let (offer_pda, escrow_pda) = offer_pdas(ctx, offer_id);
    let mut metas = acc::ExpireOffer {
        payer: *payer,
        offer: offer_pda,
        mint: ctx.mint_pda,
        escrow: escrow_pda,
        maker_share_account: *maker_share_ata,
        escrow_marker: escrow_marker_of(ctx, &offer_pda),
        share_token_program: TOKEN_2022,
    }
    .to_account_metas(None);
    metas.extend(kyc_hook_metas(ctx, &offer_pda, &offer_pda, maker));
    Instruction::new_with_bytes(ctx.program_id, &ixd::ExpireOffer {}.data(), metas)
}

/// Builds a `take_offer` for `taker`, receiving into `taker_share_ata` and
/// paying from `taker_payment_ata`, with the full KycGated escrow→taker tail.
fn take_offer_ix(
    ctx: &Ctx,
    offer_id: u64,
    taker: &Pubkey,
    taker_share_ata: &Pubkey,
    taker_payment_ata: &Pubkey,
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
        maker_payment_account: ctx.seller_payment_ata,
        escrow_marker: escrow_marker_of(ctx, &offer_pda),
        share_token_program: TOKEN_2022,
        payment_token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    // escrow (owner offer PDA) → taker ATA (owner taker)
    metas.extend(kyc_hook_metas(ctx, &offer_pda, &offer_pda, taker));
    Instruction::new_with_bytes(ctx.program_id, &ixd::TakeOffer {}.data(), metas)
}

#[test]
fn kyc_gated_take_offer_requires_taker_kyc() {
    // Offers are permissionless (no admin creates or vets them), so the taker
    // is NOT platform-mediated. On a KycGated mint the hook's source-marker
    // exemption (offer PDA) would skip the receiver check — `take_offer` now
    // enforces the taker's KYC on-chain instead. Contrast the admin-created
    // deal path above, which is exempt by design.
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let offer_id = 1u64;
    let (offer_pda, escrow_pda) = create_and_fund_offer(&mut svm, &ctx, offer_id);
    assert_eq!(token_balance(&svm, &escrow_pda), OFFER_AMOUNT);
    assert!(
        svm.get_account(&escrow_marker_of(&ctx, &offer_pda))
            .is_some(),
        "escrow marker created with the offer"
    );

    // Non-KYC taker (buyer) → rejected on-chain even though the exemption fires.
    let err = try_send(
        &mut svm,
        &[&ctx.buyer],
        &[take_offer_ix(
            &ctx,
            offer_id,
            &ctx.buyer.pubkey(),
            &ctx.buyer_share_ata,
            &ctx.buyer_payment_ata,
        )],
    )
    .expect_err("non-KYC taker must be rejected by take_offer");
    assert!(
        err.contains("Custom("),
        "expected a program error, got: {err}"
    );
    assert_eq!(
        token_balance(&svm, &ctx.buyer_share_ata),
        0,
        "no units leaked to the non-KYC taker"
    );
    assert_eq!(
        token_balance(&svm, &escrow_pda),
        OFFER_AMOUNT,
        "escrow untouched after the rejected take"
    );

    // Approve the taker — the same take now settles.
    approve_kyc(&mut svm, &ctx, &ctx.buyer.pubkey());
    send(
        &mut svm,
        &[&ctx.buyer],
        &[take_offer_ix(
            &ctx,
            offer_id,
            &ctx.buyer.pubkey(),
            &ctx.buyer_share_ata,
            &ctx.buyer_payment_ata,
        )],
        "take_offer (KYC'd taker)",
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), OFFER_AMOUNT);
    assert_eq!(token_balance(&svm, &ctx.seller_payment_ata), OFFER_PRICE);
    assert!(
        account_closed(&svm, &escrow_marker_of(&ctx, &offer_pda)),
        "escrow marker closed after take"
    );
}

#[test]
fn kyc_gated_take_offer_rejects_third_party_destination() {
    // The taker cannot redirect the shares into an arbitrary account: the
    // destination must be owned by the taker signer (owner constraint).
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);
    approve_kyc(&mut svm, &ctx, &ctx.buyer.pubkey());

    let offer_id = 2u64;
    create_and_fund_offer(&mut svm, &ctx, offer_id);

    // A share account owned by someone OTHER than the taker (the seller here).
    let err = try_send(
        &mut svm,
        &[&ctx.buyer],
        &[take_offer_ix(
            &ctx,
            offer_id,
            &ctx.buyer.pubkey(),
            &ctx.seller_share_ata, // owner = seller, not the taker
            &ctx.buyer_payment_ata,
        )],
    )
    .expect_err("take into a non-taker-owned account must fail");
    assert!(
        err.contains("Custom("),
        "expected a program error, got: {err}"
    );
}

/// ATTACK (offer laundry, NO privileged signer at all) — the cheapest version
/// of the escrow→wallet hole:
///   1. Mallory — zero units, zero KYC, never approved by anyone — calls the
///      PERMISSIONLESS `create_offer`. She pays rent in SOL and nothing else;
///      the escrow is born empty and gets an `EscrowMarker`;
///   2. any holder of the mint pushes units into that escrow with a RAW
///      `transfer_checked` (the destination-owner marker exempts the leg — an
///      issuer treasury sitting on freshly minted units does just as well);
///   3. Mallory calls `cancel_offer`, whose destination is pinned to
///      `offer.maker` = Mallory and which used to sweep the FULL escrow
///      balance with the hook looking away (source marker).
///
/// End state before the fix: KycGated units in a wallet with no `KycEntry`,
/// obtained for the price of one rent-exempt account. The refund is now capped
/// at `offer.deposited` — which is 0, because Mallory never deposited anything
/// through `deposit_to_offer_escrow`.
///
/// MUTATION PROOF: in `cancel_offer.rs` replace the `split_escrow_release`
/// call's payout with `ctx.accounts.escrow.amount` and this test fails at the
/// first balance assertion — Mallory walks away with all `LAUNDERED` units.
#[test]
fn kyc_gated_cancel_offer_refuses_units_the_maker_never_deposited() {
    const LAUNDERED: u64 = 7;
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 100_000_000_000).unwrap();
    let mallory_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &mallory.pubkey());

    // 1. permissionless offer, empty escrow, empty ledger.
    let offer_id = 10u64;
    let (offer_pda, escrow_pda) = create_offer_by(&mut svm, &ctx, &mallory, offer_id, 1, 0);
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(offer.deposited, 0, "ledger starts empty");

    // 2. somebody else's units land in the escrow — allowed, but unledgered.
    raw_fund_escrow(&mut svm, &ctx, &escrow_pda, &offer_pda, LAUNDERED);
    assert_eq!(token_balance(&svm, &escrow_pda), LAUNDERED);
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(offer.deposited, 0, "a raw transfer credits no deposit");

    // 3. the cancel SUCCEEDS (cleanup must never brick) but pays out nothing.
    send(
        &mut svm,
        &[&mallory],
        &[cancel_offer_ix(
            &ctx,
            offer_id,
            &mallory.pubkey(),
            &mallory_ata,
        )],
        "cancel_offer (non-KYC maker, un-deposited escrow)",
    );
    assert_eq!(
        token_balance(&svm, &mallory_ata),
        0,
        "no units leaked to a maker who deposited nothing"
    );
    assert_eq!(
        token_balance(&svm, &escrow_pda),
        LAUNDERED,
        "the un-releasable surplus stays in the escrow"
    );
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(
        offer.status,
        OfferStatus::Cancelled,
        "the offer still closes — it must not stay takeable"
    );

    // POSITIVE CONTROL — the receiver check is what blocked it, nothing else:
    // repeat the identical sequence with Mallory KYC-approved and the surplus
    // IS released to her.
    approve_kyc(&mut svm, &ctx, &mallory.pubkey());
    let offer2_id = 11u64;
    let (offer2_pda, escrow2_pda) = create_offer_by(&mut svm, &ctx, &mallory, offer2_id, 1, 0);
    raw_fund_escrow(&mut svm, &ctx, &escrow2_pda, &offer2_pda, LAUNDERED);
    send(
        &mut svm,
        &[&mallory],
        &[cancel_offer_ix(
            &ctx,
            offer2_id,
            &mallory.pubkey(),
            &mallory_ata,
        )],
        "cancel_offer (KYC'd maker)",
    );
    assert_eq!(token_balance(&svm, &mallory_ata), LAUNDERED);
    assert_eq!(token_balance(&svm, &escrow2_pda), 0);
}

/// The permissionless half of the same attack: `expire_offer` needs no
/// signature from the maker at all, so anybody could have pushed the escrow
/// out to an unvetted maker. Same cap, and — because this path is the cleanup
/// path — it still succeeds and still expires the offer.
///
/// MUTATION PROOF: swap `release.payout` back to `ctx.accounts.escrow.amount`
/// in `expire_offer.rs` and the first balance assertion fails.
#[test]
fn kyc_gated_expire_offer_refuses_units_the_maker_never_deposited() {
    const LAUNDERED: u64 = 4;
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 100_000_000_000).unwrap();
    let mallory_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &mallory.pubkey());

    let offer_id = 12u64;
    let (offer_pda, escrow_pda) = create_offer_by(&mut svm, &ctx, &mallory, offer_id, 1, 2_000);
    raw_fund_escrow(&mut svm, &ctx, &escrow_pda, &offer_pda, LAUNDERED);

    // Anybody may expire it — here the boot payer, not the maker.
    warp_to(&mut svm, 3_000);
    send(
        &mut svm,
        &[&ctx.payer],
        &[expire_offer_ix(
            &ctx,
            offer_id,
            &ctx.payer.pubkey(),
            &mallory.pubkey(),
            &mallory_ata,
        )],
        "expire_offer (permissionless)",
    );
    assert_eq!(token_balance(&svm, &mallory_ata), 0, "nothing leaked");
    assert_eq!(token_balance(&svm, &escrow_pda), LAUNDERED);
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(
        offer.status,
        OfferStatus::Expired,
        "the permissionless cleanup path must never be brickable"
    );
}

/// The legitimate flow, plus the DUST GRIEF on the offer path: a maker funds
/// their offer through the ledgered instruction, a stranger drops one base unit
/// into the escrow, and the maker's passport is revoked before they cancel.
/// They must still get back exactly what they put in — the dust must not take
/// their deposit hostage, and it must not travel with it either.
#[test]
fn kyc_gated_cancel_offer_refunds_a_revoked_makers_own_deposit_despite_dust() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);
    approve_kyc(&mut svm, &ctx, &ctx.seller.pubkey());

    let seller_pk = ctx.seller.pubkey();
    let offer_id = 13u64;
    let (offer_pda, escrow_pda) = create_and_fund_offer(&mut svm, &ctx, offer_id);
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(offer.deposited, OFFER_AMOUNT, "ledger credited");
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        SELLER_UNITS - OFFER_AMOUNT
    );

    // One base unit of somebody else's money, then the passport lapses.
    raw_fund_escrow(&mut svm, &ctx, &escrow_pda, &offer_pda, 1);
    revoke_kyc(&mut svm, &ctx, &seller_pk);

    send(
        &mut svm,
        &[&ctx.seller],
        &[cancel_offer_ix(
            &ctx,
            offer_id,
            &seller_pk,
            &ctx.seller_share_ata,
        )],
        "cancel_offer (revoked maker, dusted escrow)",
    );
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        SELLER_UNITS - 1,
        "own deposit returned in full despite the revoked passport (the 1 dust \
         unit came out of the seller's own balance and stays behind)"
    );
    assert_eq!(
        token_balance(&svm, &escrow_pda),
        1,
        "the un-deposited dust is withheld, not delivered"
    );
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(offer.status, OfferStatus::Cancelled);
    assert_eq!(offer.deposited, 0, "ledger consumed by the refund");
}

/// A maker may only ever ledger their OWN units — otherwise the whole scheme
/// collapses (anyone could credit Mallory's offer and let her cancel it out).
#[test]
fn offer_deposit_rejects_a_non_maker_depositor() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 100_000_000_000).unwrap();
    let offer_id = 14u64;
    let (offer_pda, _) = create_offer_by(&mut svm, &ctx, &mallory, offer_id, 1, 0);

    // The seller (the party actually holding units) is not the maker.
    let err = try_send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_to_offer_ix(
            &ctx,
            offer_id,
            &ctx.seller.pubkey(),
            &ctx.seller_share_ata,
            5,
        )],
    )
    .expect_err("only the maker may credit an offer's ledger");
    assert!(
        err.contains("Custom("),
        "expected a program error, got: {err}"
    );
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(offer.deposited, 0);
}

/// `take_offer` must sell only what the MAKER deposited — otherwise a maker
/// could collect the payment for units a third party pushed into the escrow.
/// (It also proves the fill no longer keys on the raw escrow balance, so a
/// dust transfer can no longer brick an offer: the old `escrow.amount ==
/// amount` equality made that a one-unit denial of service.)
#[test]
fn kyc_gated_take_offer_requires_a_ledgered_deposit() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);
    approve_kyc(&mut svm, &ctx, &ctx.buyer.pubkey());

    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 100_000_000_000).unwrap();
    let mallory_payment_ata =
        create_ata(&mut svm, &ctx.payer, &ctx.payment_mint, &mallory.pubkey());

    // Mallory opens an offer for OFFER_AMOUNT units she does not own, and lets
    // the escrow be raw-funded with exactly that many.
    let offer_id = 15u64;
    let (offer_pda, escrow_pda) =
        create_offer_by(&mut svm, &ctx, &mallory, offer_id, OFFER_AMOUNT, 0);
    raw_fund_escrow(&mut svm, &ctx, &escrow_pda, &offer_pda, OFFER_AMOUNT);
    assert_eq!(token_balance(&svm, &escrow_pda), OFFER_AMOUNT);

    let mut take = take_offer_ix(
        &ctx,
        offer_id,
        &ctx.buyer.pubkey(),
        &ctx.buyer_share_ata,
        &ctx.buyer_payment_ata,
    );
    // maker_payment_account must be owned by the maker (Mallory) here.
    for meta in take.accounts.iter_mut() {
        if meta.pubkey == ctx.seller_payment_ata {
            meta.pubkey = mallory_payment_ata;
        }
    }
    let err = try_send(&mut svm, &[&ctx.buyer], &[take])
        .expect_err("an offer nobody deposited into must not be fillable");
    assert!(
        err.contains("Custom("),
        "expected a program error, got: {err}"
    );
    assert_eq!(
        token_balance(&svm, &ctx.buyer_share_ata),
        0,
        "no units and no payment moved"
    );
    assert_eq!(token_balance(&svm, &mallory_payment_ata), 0);
}

// ── Custody-vault helpers (the escrow→wallet exit) ───────────────────────────

const CUSTODY_DEPOSIT: u64 = 12;

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

/// The admin opens a `DeliveryEscrow` vault naming `beneficiary` — no KYC of
/// any kind is required of the beneficiary at this point.
fn open_delivery_vault(
    svm: &mut LiteSVM,
    ctx: &Ctx,
    vault_id: u64,
    beneficiary: &Pubkey,
) -> (Pubkey, Pubkey) {
    let (custody_pda, escrow_pda) = custody_pdas(ctx, vault_id);
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::OpenCustodyVault {
                vault_id,
                vault_type: VaultType::DeliveryEscrow,
                realize_action: RealizeAction::BurnAndAttest,
                amount: CUSTODY_DEPOSIT,
                deadline: 0,
                metadata_hash: [7u8; 32],
                beneficiary: *beneficiary,
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
            }
            .to_account_metas(None),
        )],
        "open_custody_vault (DeliveryEscrow)",
    );
    (custody_pda, escrow_pda)
}

/// `deposit_to_custody_vault` — the ONLY route that credits the vault's
/// deposit ledger. `depositor` signs and is debited.
fn deposit_to_vault_ix(
    ctx: &Ctx,
    vault_id: u64,
    depositor: &Pubkey,
    depositor_share_ata: &Pubkey,
    amount: u64,
) -> Instruction {
    let (custody_pda, escrow_pda) = custody_pdas(ctx, vault_id);
    let mut metas = acc::DepositToCustodyVault {
        depositor: *depositor,
        share_class: ctx.share_class_pda,
        custody_vault: custody_pda,
        mint: ctx.mint_pda,
        escrow: escrow_pda,
        depositor_share_account: *depositor_share_ata,
        token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    // deposit leg: depositor ATA (owner depositor) → escrow (owner vault PDA)
    metas.extend(kyc_hook_metas(ctx, depositor, depositor, &custody_pda));
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::DepositToCustodyVault { amount }.data(),
        metas,
    )
}

/// A RAW `transfer_checked` from the seller straight into a program escrow —
/// THE primitive behind every laundering route in this file, and the reason
/// every escrow needs a deposit ledger. `escrow_owner` is the escrow's
/// authority PDA (offer / deal / custody vault); its `EscrowMarker` resolves
/// at Execute idx 10 and exempts the inbound leg from receiver KYC, so the
/// hook lets ANY holder push units into ANY escrow — and NOTHING is credited
/// to that escrow's ledger. Nothing on-chain can prevent this; the exits are
/// what must not trust it.
fn raw_fund_escrow(
    svm: &mut LiteSVM,
    ctx: &Ctx,
    escrow_pda: &Pubkey,
    escrow_owner: &Pubkey,
    amount: u64,
) {
    let mut ix = token_ix::transfer_checked(
        &TOKEN_2022,
        &ctx.seller_share_ata,
        &ctx.mint_pda,
        escrow_pda,
        &ctx.seller.pubkey(),
        &[],
        amount,
        0,
    )
    .unwrap();
    ix.accounts.extend(kyc_hook_metas(
        ctx,
        &ctx.seller.pubkey(),
        &ctx.seller.pubkey(),
        escrow_owner,
    ));
    send(
        svm,
        &[&ctx.seller],
        &[ix],
        "raw transfer into program escrow",
    );
}

fn return_vault_ix(
    ctx: &Ctx,
    signer: &Pubkey,
    vault_id: u64,
    beneficiary: &Pubkey,
    beneficiary_ata: &Pubkey,
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
        beneficiary_token_account: *beneficiary_ata,
        escrow_marker: escrow_marker_of(ctx, &custody_pda),
        token_program: TOKEN_2022,
    }
    .to_account_metas(None);
    // return leg: escrow (owner vault PDA) → beneficiary ATA
    metas.extend(kyc_hook_metas(ctx, &custody_pda, &custody_pda, beneficiary));
    Instruction::new_with_bytes(ctx.program_id, &ixd::ReturnCustodyVault {}.data(), metas)
}

// ── Tests: custody escrow → wallet ───────────────────────────────────────────

/// ATTACK (two-hop custody detour) — a single privileged signer holds both the
/// `Admin` record and the issuer authority, so it can:
///   1. `open_custody_vault(DeliveryEscrow, beneficiary = a wallet with NO
///      KycEntry, deadline = 0)` — admin-gated, no KYC asked of anyone;
///   2. push freshly emitted treasury units into that escrow with a RAW
///      `transfer_checked` (the destination-owner marker exempts the leg —
///      `mint_to_treasury`'s own shape gate is bypassed by not minting
///      straight into the vault);
///   3. `return_custody_vault` — the vault PDA's SOURCE marker exempts the
///      leg, so the hook never checks the receiver.
///
/// End state before the fix: brand-new KycGated units in a wallet with no
/// `KycEntry`. `return_custody_vault` now refuses to release anything the
/// beneficiary did not itself deposit unless the receiver's KYC passes.
///
/// MUTATION PROOF: drop the `if return_amount > deposited { require_receiver_kyc }`
/// block from `return_custody_vault.rs` and this test fails at the
/// `expect_err` — the return succeeds and `mallory_ata` holds the units.
#[test]
fn kyc_gated_custody_return_rejects_undeposited_units() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    // A wallet with no KycEntry whatsoever.
    let mallory = Keypair::new().pubkey();
    let mallory_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &mallory);

    let vault_id = 1u64;
    let (vault_pda, escrow_pda) = open_delivery_vault(&mut svm, &ctx, vault_id, &mallory);
    let vault: CustodyVault = load(&svm, &vault_pda);
    assert_eq!(vault.deposited, 0, "ledger starts empty");

    // Hop 2 — raw transfer of "treasury" units into the escrow. It succeeds
    // (destination marker), and credits NOTHING to the ledger.
    raw_fund_escrow(&mut svm, &ctx, &escrow_pda, &vault_pda, CUSTODY_DEPOSIT);
    assert_eq!(token_balance(&svm, &escrow_pda), CUSTODY_DEPOSIT);
    let vault: CustodyVault = load(&svm, &vault_pda);
    assert_eq!(vault.deposited, 0, "a raw transfer credits no deposit");

    // Hop 3 — the return is now blocked.
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[return_vault_ix(
            &ctx,
            &ctx.payer.pubkey(),
            vault_id,
            &mallory,
            &mallory_ata,
        )],
    )
    .expect_err("returning undeposited units to a non-KYC wallet must fail");
    assert!(
        err.contains("Custom(6069)"),
        "expected ReceiverNotApproved (6069), got: {err}"
    );
    assert_eq!(token_balance(&svm, &mallory_ata), 0, "no units leaked");
    assert_eq!(
        token_balance(&svm, &escrow_pda),
        CUSTODY_DEPOSIT,
        "escrow untouched after the rejected return"
    );

    // POSITIVE CONTROL — the surplus IS releasable, just not to an unvetted
    // wallet: approve the beneficiary and the identical return goes through.
    approve_kyc(&mut svm, &ctx, &mallory);
    send(
        &mut svm,
        &[&ctx.payer],
        &[return_vault_ix(
            &ctx,
            &ctx.payer.pubkey(),
            vault_id,
            &mallory,
            &mallory_ata,
        )],
        "return_custody_vault to a KYC'd beneficiary",
    );
    assert_eq!(token_balance(&svm, &mallory_ata), CUSTODY_DEPOSIT);
}

/// The legitimate flow must survive the fix: a holder deposits their own units
/// into a delivery escrow, their passport is REVOKED while the units sit
/// there, and the return still hands them back. Nothing is ever confiscated by
/// a paperwork lapse.
#[test]
fn kyc_gated_custody_return_refunds_own_deposit_with_revoked_passport() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);
    approve_kyc(&mut svm, &ctx, &ctx.seller.pubkey());

    let vault_id = 2u64;
    let seller_pk = ctx.seller.pubkey();
    let (vault_pda, escrow_pda) = open_delivery_vault(&mut svm, &ctx, vault_id, &seller_pk);

    // The beneficiary funds the escrow through the ledgered instruction.
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_to_vault_ix(
            &ctx,
            vault_id,
            &seller_pk,
            &ctx.seller_share_ata,
            CUSTODY_DEPOSIT,
        )],
        "deposit_to_custody_vault",
    );
    let vault: CustodyVault = load(&svm, &vault_pda);
    assert_eq!(vault.deposited, CUSTODY_DEPOSIT, "ledger credited");
    assert_eq!(token_balance(&svm, &escrow_pda), CUSTODY_DEPOSIT);
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        SELLER_UNITS - CUSTODY_DEPOSIT
    );

    // …the passport is revoked while the deposit sits in escrow…
    revoke_kyc(&mut svm, &ctx, &seller_pk);

    // …and the refund still works — the ledger covers the whole balance.
    send(
        &mut svm,
        &[&ctx.payer],
        &[return_vault_ix(
            &ctx,
            &ctx.payer.pubkey(),
            vault_id,
            &seller_pk,
            &ctx.seller_share_ata,
        )],
        "return_custody_vault refunds a revoked beneficiary's own deposit",
    );
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        SELLER_UNITS,
        "own deposit returned despite the revoked passport"
    );
    let vault: CustodyVault = load(&svm, &vault_pda);
    assert_eq!(vault.state, VaultState::Returned);
}

/// DUST GRIEF — the boundary is an AMOUNT, not a verdict on the transaction.
///
/// A custody escrow is an ordinary token account with a destination marker, so
/// anyone can drop one base unit into it for the cost of a fee. An earlier
/// version of the gate refused the WHOLE return whenever
/// `escrow.amount > deposited`, which meant that single unit held a
/// revoked-passport beneficiary's entire deposit hostage — with `trigger` +
/// `realize` (a burn) as the only remaining exit, i.e. confiscation. The rule
/// is therefore split: `min(balance, deposited)` leaves unchecked, the surplus
/// alone is gated, and the vault stays open while a surplus is withheld so
/// nothing is stranded.
///
/// MUTATION PROOF: change `split_escrow_release` back to a threshold (refuse
/// everything when `balance > deposited`) and the first `send` here fails with
/// 6069 — the exact regression this test exists to pin.
#[test]
fn kyc_gated_custody_dust_cannot_trap_a_revoked_beneficiarys_deposit() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);
    approve_kyc(&mut svm, &ctx, &ctx.seller.pubkey());

    let vault_id = 3u64;
    let seller_pk = ctx.seller.pubkey();
    let (vault_pda, escrow_pda) = open_delivery_vault(&mut svm, &ctx, vault_id, &seller_pk);
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_to_vault_ix(
            &ctx,
            vault_id,
            &seller_pk,
            &ctx.seller_share_ata,
            CUSTODY_DEPOSIT,
        )],
        "deposit_to_custody_vault",
    );
    // One unit of "somebody else's" money on top of the recorded deposit.
    raw_fund_escrow(&mut svm, &ctx, &escrow_pda, &vault_pda, 1);
    assert_eq!(token_balance(&svm, &escrow_pda), CUSTODY_DEPOSIT + 1);
    let vault: CustodyVault = load(&svm, &vault_pda);
    assert_eq!(vault.deposited, CUSTODY_DEPOSIT, "surplus is not ledgered");

    // Revoked beneficiary + dust: the DEPOSIT still comes back in full.
    revoke_kyc(&mut svm, &ctx, &seller_pk);
    let before = token_balance(&svm, &ctx.seller_share_ata);
    send(
        &mut svm,
        &[&ctx.payer],
        &[return_vault_ix(
            &ctx,
            &ctx.payer.pubkey(),
            vault_id,
            &seller_pk,
            &ctx.seller_share_ata,
        )],
        "return_custody_vault (dusted escrow, revoked beneficiary)",
    );
    assert_eq!(
        token_balance(&svm, &ctx.seller_share_ata),
        before + CUSTODY_DEPOSIT,
        "the whole recorded deposit is refunded — the dust cannot hold it hostage"
    );
    assert_eq!(
        token_balance(&svm, &escrow_pda),
        1,
        "only the un-deposited surplus is withheld"
    );
    let vault: CustodyVault = load(&svm, &vault_pda);
    assert_eq!(vault.deposited, 0, "ledger consumed by the refund");
    assert_eq!(
        vault.state,
        VaultState::Active,
        "a partial return is NOT terminal — the surplus must keep an exit"
    );
    assert!(
        svm.get_account(&escrow_marker_of(&ctx, &vault_pda))
            .is_some(),
        "marker stays open while the vault is not drained"
    );

    // And the withheld unit is not stranded: once the beneficiary is eligible
    // again a second return sweeps it and the vault goes terminal. That second
    // return is FULLY gated (the ledger is spent), which is exactly right.
    approve_kyc(&mut svm, &ctx, &seller_pk);
    send(
        &mut svm,
        &[&ctx.payer],
        &[return_vault_ix(
            &ctx,
            &ctx.payer.pubkey(),
            vault_id,
            &seller_pk,
            &ctx.seller_share_ata,
        )],
        "return_custody_vault (surplus sweep after re-approval)",
    );
    assert_eq!(token_balance(&svm, &escrow_pda), 0);
    let vault: CustodyVault = load(&svm, &vault_pda);
    assert_eq!(vault.state, VaultState::Returned);
    assert!(
        account_closed(&svm, &escrow_marker_of(&ctx, &vault_pda)),
        "marker closed once the escrow is drained"
    );
}

/// A delivery escrow's ledger may only ever record the BENEFICIARY's units —
/// otherwise the issuer authority could credit it with fresh treasury units
/// and walk them straight out through the KYC-free refund branch.
#[test]
fn custody_deposit_rejects_a_non_beneficiary_depositor() {
    let (mut svm, ctx) = boot();
    warp_to(&mut svm, 1_000);

    let mallory = Keypair::new().pubkey();
    let vault_id = 4u64;
    let (vault_pda, _) = open_delivery_vault(&mut svm, &ctx, vault_id, &mallory);

    // The seller (here: the units holder / "treasury") is not the beneficiary.
    let err = try_send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_to_vault_ix(
            &ctx,
            vault_id,
            &ctx.seller.pubkey(),
            &ctx.seller_share_ata,
            CUSTODY_DEPOSIT,
        )],
    )
    .expect_err("only the beneficiary may credit a delivery escrow's ledger");
    assert!(
        err.contains("Custom(6084)"),
        "expected DepositorNotBeneficiary (6084), got: {err}"
    );
    let vault: CustodyVault = load(&svm, &vault_pda);
    assert_eq!(vault.deposited, 0);
}

/// The deposit ledger is capped at what the offer actually sells.
///
/// `take_offer` fills exactly `offer.amount` and then marks the offer `Filled`,
/// and no instruction accepts a `Filled` offer — so a ledgered surplus would be
/// stranded in an escrow only the offer PDA can sign for, i.e. the maker's OWN
/// property lost forever. Capping deposits at `offer.amount` makes that state
/// unreachable: a fill always drains the ledger to zero.
#[test]
fn offer_deposit_is_capped_at_the_offer_amount() {
    let (mut svm, ctx) = boot();
    let seller_pk = ctx.seller.pubkey();
    let (offer_pda, _escrow) = create_offer_by(&mut svm, &ctx, &ctx.seller, 91, OFFER_AMOUNT, 0);

    // One unit over the offer size, in a single deposit.
    let err = try_send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_to_offer_ix(
            &ctx,
            91,
            &seller_pk,
            &ctx.seller_share_ata,
            OFFER_AMOUNT + 1,
        )],
    )
    .expect_err("over-funding the offer must fail");
    assert!(
        err.contains("Custom(6085)"),
        "expected InvalidDepositAmount, got: {err}"
    );

    // Exactly the offer size is fine…
    send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_to_offer_ix(
            &ctx,
            91,
            &seller_pk,
            &ctx.seller_share_ata,
            OFFER_AMOUNT,
        )],
        "deposit_to_offer_escrow",
    );
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(offer.deposited, OFFER_AMOUNT);

    // …and topping up beyond it is refused too (the cap is on the total, not
    // on the single call).
    let err = try_send(
        &mut svm,
        &[&ctx.seller],
        &[deposit_to_offer_ix(
            &ctx,
            91,
            &seller_pk,
            &ctx.seller_share_ata,
            1,
        )],
    )
    .expect_err("topping up past the offer amount must fail");
    assert!(
        err.contains("Custom(6085)"),
        "expected InvalidDepositAmount, got: {err}"
    );
    let offer: Offer = load(&svm, &offer_pda);
    assert_eq!(offer.deposited, OFFER_AMOUNT, "ledger unchanged by refusal");
}
