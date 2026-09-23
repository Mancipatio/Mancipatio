//! On-chain KYC completion (LiteSVM): the `buy` receiver gate and the
//! `clawback_from_holder` / `mint_to_treasury` bindings.
//!
//! Proven here:
//!   * `buy` on a KycGated mint FAILS without an approved `KycEntry` — both
//!     with the full 9-account tail (no entry ⇒ ReceiverNotApproved) and with
//!     a stripped tail (fail-closed ⇒ KycProofRequired). `mint_to` never runs
//!     the transfer hook, so this program-side gate is the only backstop;
//!   * `buy` with an approved entry passes; Open-mode `buy` still works with
//!     the standard 3-account Open tail (the ExtraAccountMetaList in its
//!     1-meta Open shape is the on-chain Open proof);
//!   * `clawback_from_holder` sweeps a REVOKED holder's balance into a
//!     burn-only `RedemptionQueue` custody escrow via the mint's
//!     PermanentDelegate (ShareClass PDA signs; the destination-owner
//!     EscrowMarker exempts the leg from the hook's receiver-KYC) — and is
//!     rejected for a holder in good standing, for a non-admin signer, on an
//!     Open mint, with a registry the mint's hook config does not name, and
//!     with any destination that has a wallet exit (Offer escrow,
//!     DeliveryEscrow vault);
//!   * `mint_to_treasury` binds its destination by TYPE: an arbitrary wallet
//!     and a permissionlessly created `Offer` PDA are both rejected, while the
//!     issuer authority's ATA and a `CustodyVault` escrow of this mint pass —
//!     and by EXIT SHAPE: a vault that can pay a wallet (`DeliveryEscrow`, or
//!     `TransferToBeneficiary`) is refused even though it is a real vault of
//!     this very mint;
//!   * `claim_milestone` delivers only into the claimer's OWN token account,
//!     so an arbitrary `publish_milestone` root cannot be paid out through an
//!     `EscrowMarker`-carrying third-party escrow.

#[path = "../../../tests/support/kyc_registry.rs"]
mod kyc;
#[path = "../../../tests/support/pause.rs"]
mod pause;
#[path = "../../../tests/support/sale_approval.rs"]
mod sale_approval;
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
        accounts as acc, instruction as ixd, util, AssetType, JurisdictionRules, RaiseType,
        RealizeAction, Sale, ShareClassType, VaultType, RIGHT_DIVIDEND, RIGHT_LIQ_PREF, RIGHT_VOTE,
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

const PRICE_PER_UNIT: u64 = 1_000_000;
const TOTAL_FOR_SALE: u64 = 500;
const BUYER_PAYMENT: u64 = 100_000_000;
/// Jurisdiction used for every KYC approval here (bit set in the registry).
const JURISDICTION: u16 = 222;
const FAR_FUTURE: i64 = 4_102_444_800; // 2100-01-01

// ── Helpers (pattern from test_escrow_marker_kyc.rs) ─────────────────────────

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
    hook_config_pda: Pubkey,
    kyc_registry_pda: Pubkey,
    sale_pda: Pubkey,
    proceeds_pda: Pubkey,
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

fn kyc_entry_of(ctx: &Ctx, holder: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            asset_registry::KYC_SEED,
            ctx.kyc_registry_pda.as_ref(),
            holder.as_ref(),
        ],
        &ctx.program_id,
    )
    .0
}

/// The full KycGated hook tail for one leg, in meta-list order, plus the
/// ExtraAccountMetaList + hook program — the exact tail the front builds
/// (lib/hook-metas.ts) and `take_offer` / `buy` take via remaining accounts.
fn kyc_hook_metas(
    ctx: &Ctx,
    _transfer_authority: &Pubkey,
    src_owner: &Pubkey,
    dest_owner: &Pubkey,
) -> Vec<AccountMeta> {
    let (block_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::BLOCK_ENTRY_SEED, src_owner.as_ref()],
        &ctx.hook_id,
    );
    vec![
        AccountMeta::new_readonly(block_pda, false),
        AccountMeta::new_readonly(ctx.hook_config_pda, false),
        AccountMeta::new_readonly(ctx.kyc_registry_pda, false),
        AccountMeta::new_readonly(ctx.program_id, false), // asset_registry program
        AccountMeta::new_readonly(kyc_entry_of(ctx, dest_owner), false),
        AccountMeta::new_readonly(escrow_marker_of(ctx, dest_owner), false),
        AccountMeta::new_readonly(escrow_marker_of(ctx, src_owner), false),
        AccountMeta::new_readonly(ctx.extra_metas_pda, false),
        AccountMeta::new_readonly(ctx.hook_id, false),
    ]
}

/// The 3-account Open-mode hook tail (what the front builds for Open mints).
fn open_hook_metas(ctx: &Ctx, source_authority: &Pubkey) -> Vec<AccountMeta> {
    let (block_pda, _) = Pubkey::find_program_address(
        &[transfer_hook::BLOCK_ENTRY_SEED, source_authority.as_ref()],
        &ctx.hook_id,
    );
    vec![
        AccountMeta::new_readonly(block_pda, false),
        AccountMeta::new_readonly(ctx.extra_metas_pda, false),
        AccountMeta::new_readonly(ctx.hook_id, false),
    ]
}

/// Creates an OTC offer for the boot share class, made by `maker` — the
/// permissionless escrow-with-a-wallet-exit anyone can conjure. Returns
/// `(offer_pda, escrow_pda)`.
fn create_offer(svm: &mut LiteSVM, ctx: &Ctx, maker: &Keypair, offer_id: u64) -> (Pubkey, Pubkey) {
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
    send(
        svm,
        &[maker],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::CreateOffer {
                offer_id,
                amount: 1,
                price: 1,
                expires_at: 0,
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

/// Approves `holder` in the boot registry (payer is the KYC authority).
fn approve_kyc(svm: &mut LiteSVM, ctx: &Ctx, holder: &Pubkey) {
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
                kyc_entry: kyc_entry_of(ctx, holder),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "approve_holder",
    );
}

/// Revokes `holder` in the boot registry.
fn revoke_kyc(svm: &mut LiteSVM, ctx: &Ctx, holder: &Pubkey) {
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::RevokeHolder { holder: *holder }.data(),
            acc::RevokeHolder {
                authority: ctx.payer.pubkey(),
                kyc_registry: ctx.kyc_registry_pda,
                kyc_entry: kyc_entry_of(ctx, holder),
            }
            .to_account_metas(None),
        )],
        "revoke_holder",
    );
}

/// A `buy` for the boot buyer with the given hook tail as remaining accounts.
fn buy_ix(ctx: &Ctx, amount: u64, tail: Vec<AccountMeta>) -> Instruction {
    let mut metas = acc::Buy {
        asset: ctx.asset_pda,
        issuer: ctx.issuer_pda,
        buyer: ctx.buyer.pubkey(),
        sale: ctx.sale_pda,
        share_class: ctx.share_class_pda,
        mint: ctx.mint_pda,
        buyer_share_account: ctx.buyer_share_ata,
        buyer_payment_account: ctx.buyer_payment_ata,
        payment_mint: ctx.payment_mint,
        proceeds: ctx.proceeds_pda,
        share_token_program: TOKEN_2022,
        payment_token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    metas.extend(tail);
    Instruction::new_with_bytes(ctx.program_id, &ixd::Buy { amount }.data(), metas)
}

/// Opens a `RedemptionQueue` custody vault (admin) — the clawback destination.
/// Returns `(custody_pda, escrow_pda)`.
fn open_redemption_vault(svm: &mut LiteSVM, ctx: &Ctx, vault_id: u64) -> (Pubkey, Pubkey) {
    open_vault(
        svm,
        ctx,
        vault_id,
        VaultType::RedemptionQueue,
        Pubkey::default(),
    )
}

/// Opens a custody vault of an arbitrary type — `RedemptionQueue` is the only
/// shape `clawback_from_holder` accepts as a destination.
fn open_vault(
    svm: &mut LiteSVM,
    ctx: &Ctx,
    vault_id: u64,
    vault_type: VaultType,
    beneficiary: Pubkey,
) -> (Pubkey, Pubkey) {
    open_vault_with_action(
        svm,
        ctx,
        vault_id,
        vault_type,
        RealizeAction::BurnAndAttest,
        beneficiary,
    )
}

/// Opens a custody vault of an arbitrary type AND realize action — the two
/// fields that decide whether the vault has an escrow → wallet exit, and
/// therefore whether `mint_to_treasury` may emit into its escrow.
fn open_vault_with_action(
    svm: &mut LiteSVM,
    ctx: &Ctx,
    vault_id: u64,
    vault_type: VaultType,
    realize_action: RealizeAction,
    beneficiary: Pubkey,
) -> (Pubkey, Pubkey) {
    open_vault_with_deadline(
        svm,
        ctx,
        vault_id,
        vault_type,
        realize_action,
        beneficiary,
        0,
    )
}

fn open_vault_ix(
    ctx: &Ctx,
    vault_id: u64,
    vault_type: VaultType,
    realize_action: RealizeAction,
    beneficiary: Pubkey,
    deadline: i64,
) -> (Instruction, Pubkey, Pubkey) {
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
    let ix = Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::OpenCustodyVault {
            vault_id,
            vault_type,
            realize_action,
            amount: 0,
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
            // 2C-3: a DeliveryEscrow pins the boot registry; every other type
            // (the clawback quarantine included) passes none.
            kyc_registry: (vault_type == VaultType::DeliveryEscrow).then_some(ctx.kyc_registry_pda),
        }
        .to_account_metas(None),
    );
    (ix, custody_pda, escrow_pda)
}

fn open_vault_with_deadline(
    svm: &mut LiteSVM,
    ctx: &Ctx,
    vault_id: u64,
    vault_type: VaultType,
    realize_action: RealizeAction,
    beneficiary: Pubkey,
    deadline: i64,
) -> (Pubkey, Pubkey) {
    let (ix, custody_pda, escrow_pda) = open_vault_ix(
        ctx,
        vault_id,
        vault_type,
        realize_action,
        beneficiary,
        deadline,
    );
    send(
        svm,
        &[&ctx.payer],
        &[ix],
        "open_custody_vault (RedemptionQueue)",
    );
    (custody_pda, escrow_pda)
}

fn try_open_vault_with_action(
    svm: &mut LiteSVM,
    ctx: &Ctx,
    vault_id: u64,
    vault_type: VaultType,
    realize_action: RealizeAction,
    beneficiary: Pubkey,
) -> Result<(), String> {
    let (ix, _, _) = open_vault_ix(ctx, vault_id, vault_type, realize_action, beneficiary, 0);
    try_send(svm, &[&ctx.payer], &[ix])
}

/// Rewrites a live `CustodyVault`'s `realize_action` in place — the only way to
/// obtain a vault with an unsupported action now that `open_custody_vault`
/// refuses to create one (models an account written before that gate).
fn set_realize_action(svm: &mut LiteSVM, vault: &Pubkey, action: RealizeAction) {
    use anchor_lang::AccountSerialize;
    let mut state: asset_registry::CustodyVault = load(svm, vault);
    state.realize_action = action;
    let mut account = svm.get_account(vault).unwrap();
    state
        .try_serialize(&mut account.data.as_mut_slice())
        .unwrap();
    svm.set_account(*vault, account).unwrap();
}

/// A `clawback_from_holder` signed by `authority`, sweeping (or taking
/// `amount` of) the boot buyer's balance into the vault escrow.
fn clawback_ix(
    ctx: &Ctx,
    authority: &Pubkey,
    holder: &Pubkey,
    holder_ata: &Pubkey,
    custody_pda: &Pubkey,
    escrow_pda: &Pubkey,
    amount: u64,
) -> Instruction {
    clawback_ix_with_registry(
        ctx,
        authority,
        holder,
        holder_ata,
        custody_pda,
        escrow_pda,
        &ctx.kyc_registry_pda,
        amount,
    )
}

/// Same, but with an explicit registry — lets a test try to smuggle in a
/// registry the mint's hook config does not name.
#[allow(clippy::too_many_arguments)]
fn clawback_ix_with_registry(
    ctx: &Ctx,
    authority: &Pubkey,
    holder: &Pubkey,
    holder_ata: &Pubkey,
    custody_pda: &Pubkey,
    escrow_pda: &Pubkey,
    registry: &Pubkey,
    amount: u64,
) -> Instruction {
    let (admin_pda, _) = Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, authority.as_ref()],
        &ctx.program_id,
    );
    let (entry_pda, _) = Pubkey::find_program_address(
        &[asset_registry::KYC_SEED, registry.as_ref(), holder.as_ref()],
        &ctx.program_id,
    );
    let mut metas = acc::ClawbackFromHolder {
        authority: *authority,
        admin_record: admin_pda,
        share_class: ctx.share_class_pda,
        mint: ctx.mint_pda,
        holder_share_account: *holder_ata,
        // Must be an EMPTY account: an initialised marker here means the target
        // is a program escrow, not a wallet, and the clawback is refused.
        holder_escrow_marker: escrow_marker_of(ctx, holder),
        destination: *escrow_pda,
        custody_vault: *custody_pda,
        kyc_registry: *registry,
        kyc_entry: entry_pda,
        hook_config: ctx.hook_config_pda,
        token_program: TOKEN_2022,
    }
    .to_account_metas(None);
    // Hook BlockEntry is bound to the holder owner, while the transfer
    // authority remains the ShareClass permanent delegate.
    metas.extend(kyc_hook_metas(ctx, holder, holder, custody_pda));
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::ClawbackFromHolder {
            holder: *holder,
            amount,
        }
        .data(),
        metas,
    )
}

/// Boots the full stack with an open primary sale. `kyc_gated == true` flips
/// the mint Open → KycGated at the end (meta list grows 1 → 7 metas).
fn boot(kyc_gated: bool) -> (LiteSVM, Ctx) {
    boot_asset_type(kyc_gated, AssetType::Equity)
}

fn boot_asset_type(kyc_gated: bool, asset_type: AssetType) -> (LiteSVM, Ctx) {
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
    let buyer = Keypair::new();
    svm.airdrop(&buyer.pubkey(), 100_000_000_000).unwrap();

    let legal_entity_id: [u8; 32] = *b"KYC-BUY-CLAWBACK-ENTITY-00000001";
    let asset_id = "kyc-buy-pilot-01";
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
                asset_type,
                name: "KYC Buy Pilot".to_string(),
                symbol_prefix: "KBP".to_string(),
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
                max_supply: if asset_type == AssetType::PhysicalGood {
                    Some(1)
                } else {
                    None
                },
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

    // payment mint + buyer token accounts
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
    let buyer_share_ata = create_ata(&mut svm, &payer, &mint_pda, &buyer.pubkey());
    let buyer_payment_ata = create_ata(&mut svm, &payer, &payment_mint, &buyer.pubkey());
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

    // open the primary sale
    let sale_id: u64 = 1;
    let (sale_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::SALE_SEED,
            share_class_pda.as_ref(),
            &sale_id.to_le_bytes(),
        ],
        &program_id,
    );
    let (proceeds_pda, _) = Pubkey::find_program_address(
        &[asset_registry::PROCEEDS_SEED, sale_pda.as_ref()],
        &program_id,
    );
    let approval_terms =
        sale_approval::Terms::covering(&svm, PRICE_PER_UNIT, TOTAL_FOR_SALE, RaiseType::Mature);
    let approval = sale_approval::approve_sale(
        &mut svm,
        &payer,
        &issuer_pda,
        &asset_pda,
        &share_class_pda,
        &payment_mint,
        sale_id,
        approval_terms,
    );
    send(
        &mut svm,
        &[&payer],
        &[Instruction::new_with_bytes(
            program_id,
            &ixd::OpenSale {
                sale_id,
                price_per_unit: PRICE_PER_UNIT,
                total_for_sale: TOTAL_FOR_SALE,
                start_ts: 0,
                end_ts: 0,
                raise_type: RaiseType::Mature,
                cliff_months: 0,
                vesting_months: 0,
            }
            .data(),
            acc::OpenSale {
                authority: payer.pubkey(),
                issuer: issuer_pda,
                asset: asset_pda,
                share_class: share_class_pda,
                mint: mint_pda,
                payment_mint,
                sale: sale_pda,
                proceeds: proceeds_pda,
                payment_token_program: TOKEN_2022,
                system_program: system_program::ID,
                sale_approval: approval,
                approved_by: payer.pubkey(),
                approver_admin_record: sale_approval::admin_pda(&payer.pubkey()),
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        )],
        "open_sale",
    );

    if kyc_gated {
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
                    kyc_registry_account: Some(kyc_registry_pda),
                }
                .to_account_metas(None),
            )],
            "update_transfer_hook_config (Open -> KycGated)",
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
        hook_config_pda,
        kyc_registry_pda,
        sale_pda,
        proceeds_pda,
        buyer,
        buyer_share_ata,
        buyer_payment_ata,
    };
    (svm, ctx)
}

// ── buy — receiver KYC gate ──────────────────────────────────────────────────

#[test]
fn kyc_gated_buy_without_entry_fails() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    // NOTE: buyer is never KYC-approved.

    // Full 9-account KycGated tail, but no KycEntry exists for the buyer →
    // ReceiverNotApproved (asset_registry 6069). `mint_to` never runs the
    // hook, so this is the program's own gate, not the hook's.
    let buyer_pk = ctx.buyer.pubkey();
    let err = try_send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            10,
            kyc_hook_metas(&ctx, &buyer_pk, &buyer_pk, &buyer_pk),
        )],
    )
    .expect_err("buy without a KYC entry must fail on a KycGated mint");
    assert!(err.contains("Custom(6069)"), "got: {err}");

    // Stripped tail (the direct-RPC attack): fail-closed → KycProofRequired.
    let err = try_send(&mut svm, &[&ctx.buyer], &[buy_ix(&ctx, 10, vec![])])
        .expect_err("buy with a stripped tail must fail closed");
    assert!(err.contains("Custom(6077)"), "got: {err}");

    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 0);
    let sale: Sale = load(&svm, &ctx.sale_pda);
    assert_eq!(sale.sold, 0, "nothing sold to the non-KYC'd buyer");
}

#[test]
fn kyc_gated_buy_with_approved_entry_passes() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    approve_kyc(&mut svm, &ctx, &ctx.buyer.pubkey());

    let buyer_pk = ctx.buyer.pubkey();
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            10,
            kyc_hook_metas(&ctx, &buyer_pk, &buyer_pk, &buyer_pk),
        )],
        "buy (KYC'd buyer, KycGated mint)",
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 10);
    assert_eq!(token_balance(&svm, &ctx.proceeds_pda), 10 * PRICE_PER_UNIT);
    let sale: Sale = load(&svm, &ctx.sale_pda);
    assert_eq!(sale.sold, 10);
}

#[test]
fn open_mode_buy_still_works() {
    let (mut svm, ctx) = boot(false);
    warp_to(&mut svm, 1_000);
    // NOTE: no KYC entry anywhere — the mint is Open.

    // The standard 3-account Open tail carries the ExtraAccountMetaList in
    // its 1-meta Open shape — the on-chain proof the mint is not gated.
    let buyer_pk = ctx.buyer.pubkey();
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(&ctx, 10, open_hook_metas(&ctx, &buyer_pk))],
        "buy (Open mint, Open tail)",
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 10);

    // Even on an Open mint the tail cannot be stripped entirely — the mode
    // must be provable on-chain (fail-closed contract).
    let err = try_send(&mut svm, &[&ctx.buyer], &[buy_ix(&ctx, 5, vec![])])
        .expect_err("buy with no tail at all must fail closed even in Open mode");
    assert!(err.contains("Custom(6077)"), "got: {err}");
}

// ── clawback_from_holder ─────────────────────────────────────────────────────

#[test]
fn clawback_from_revoked_holder_sweeps_balance() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    let buyer_pk = ctx.buyer.pubkey();
    approve_kyc(&mut svm, &ctx, &buyer_pk);
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            10,
            kyc_hook_metas(&ctx, &buyer_pk, &buyer_pk, &buyer_pk),
        )],
        "buy",
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 10);

    // The holder is revoked — their balance becomes seizable.
    revoke_kyc(&mut svm, &ctx, &buyer_pk);
    let (custody_pda, escrow_pda) = open_redemption_vault(&mut svm, &ctx, 1);

    // amount == 0 sweeps the full balance (permanent delegate signs; the
    // destination-owner EscrowMarker exempts the hook's receiver-KYC).
    let payer_pk = ctx.payer.pubkey();
    send(
        &mut svm,
        &[&ctx.payer],
        &[clawback_ix(
            &ctx,
            &payer_pk,
            &buyer_pk,
            &ctx.buyer_share_ata,
            &custody_pda,
            &escrow_pda,
            0,
        )],
        "clawback_from_holder (revoked, sweep)",
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 0, "holder swept");
    assert_eq!(
        token_balance(&svm, &escrow_pda),
        10,
        "escrow holds the units"
    );
}

#[test]
fn clawback_rejected_for_approved_holder() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    let buyer_pk = ctx.buyer.pubkey();
    approve_kyc(&mut svm, &ctx, &buyer_pk);
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            10,
            kyc_hook_metas(&ctx, &buyer_pk, &buyer_pk, &buyer_pk),
        )],
        "buy",
    );
    let (custody_pda, escrow_pda) = open_redemption_vault(&mut svm, &ctx, 1);

    // The holder is still Approved and unexpired — clawback must be refused.
    let payer_pk = ctx.payer.pubkey();
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[clawback_ix(
            &ctx,
            &payer_pk,
            &buyer_pk,
            &ctx.buyer_share_ata,
            &custody_pda,
            &escrow_pda,
            0,
        )],
    )
    .expect_err("clawback against a holder in good standing must fail");
    assert!(err.contains("Custom(6079)"), "got: {err}");
    assert_eq!(
        token_balance(&svm, &ctx.buyer_share_ata),
        10,
        "holder balance untouched"
    );
}

#[test]
fn clawback_by_non_admin_fails() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    let buyer_pk = ctx.buyer.pubkey();
    approve_kyc(&mut svm, &ctx, &buyer_pk);
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            10,
            kyc_hook_metas(&ctx, &buyer_pk, &buyer_pk, &buyer_pk),
        )],
        "buy",
    );
    revoke_kyc(&mut svm, &ctx, &buyer_pk);
    let (custody_pda, escrow_pda) = open_redemption_vault(&mut svm, &ctx, 1);

    // A wallet without an Admin record cannot clawback — its admin PDA does
    // not exist (AccountNotInitialized, anchor 3012).
    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 10_000_000_000).unwrap();
    let mallory_pk = mallory.pubkey();
    let err = try_send(
        &mut svm,
        &[&mallory],
        &[clawback_ix(
            &ctx,
            &mallory_pk,
            &buyer_pk,
            &ctx.buyer_share_ata,
            &custody_pda,
            &escrow_pda,
            0,
        )],
    )
    .expect_err("non-admin clawback must fail");
    assert!(err.contains("Custom(3012)"), "got: {err}");
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 10);
}

// ── mint_to_treasury — destination binding ───────────────────────────────────

#[test]
fn mint_to_treasury_binds_destination() {
    let (mut svm, ctx) = boot(false);
    warp_to(&mut svm, 1_000);

    // An arbitrary wallet ATA (owner = buyer, not the issuer authority, no
    // registry-PDA proof) is rejected — MintDestinationNotBound (6078).
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::MintToTreasury { amount: 100 }.data(),
            acc::MintToTreasury {
                authority: ctx.payer.pubkey(),
                admin_record: ctx.admin_pda,
                issuer: ctx.issuer_pda,
                asset: ctx.asset_pda,
                share_class: ctx.share_class_pda,
                mint: ctx.mint_pda,
                destination: ctx.buyer_share_ata,
                token_program: TOKEN_2022,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        )],
    )
    .expect_err("mint_to_treasury to an arbitrary wallet must fail");
    assert!(err.contains("Custom(6078)"), "got: {err}");
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 0);

    // A registry-owned account that is NOT a CustodyVault / RightsIssuance of
    // this mint proves nothing — even though it is program-owned, initialised,
    // and really is the destination's owner. This is the permissionless
    // `create_offer` → `mint_to_treasury` → `cancel_offer` exfiltration.
    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 10_000_000_000).unwrap();
    let (offer_pda, offer_escrow) = create_offer(&mut svm, &ctx, &mallory, 77);
    let mut metas = acc::MintToTreasury {
        authority: ctx.payer.pubkey(),
        admin_record: ctx.admin_pda,
        issuer: ctx.issuer_pda,
        asset: ctx.asset_pda,
        share_class: ctx.share_class_pda,
        mint: ctx.mint_pda,
        destination: offer_escrow,
        token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    metas.push(AccountMeta::new_readonly(offer_pda, false));
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::MintToTreasury { amount: 100 }.data(),
            metas,
        )],
    )
    .expect_err("an Offer PDA must not pass as a mint destination binding");
    assert!(err.contains("Custom(6078)"), "got: {err}");
    assert_eq!(token_balance(&svm, &offer_escrow), 0, "offer escrow empty");

    // The issuer authority's own ATA (the treasury) passes.
    let payer_share_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &ctx.payer.pubkey());
    send(
        &mut svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::MintToTreasury { amount: 100 }.data(),
            acc::MintToTreasury {
                authority: ctx.payer.pubkey(),
                admin_record: ctx.admin_pda,
                issuer: ctx.issuer_pda,
                asset: ctx.asset_pda,
                share_class: ctx.share_class_pda,
                mint: ctx.mint_pda,
                destination: payer_share_ata,
                token_program: TOKEN_2022,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        )],
        "mint_to_treasury (issuer treasury)",
    );
    assert_eq!(token_balance(&svm, &payer_share_ata), 100);
}

/// A `CustodyVault` escrow of this share class DOES pass — the documented
/// escrow-funding flow must keep working through the typed binding.
#[test]
fn mint_to_treasury_accepts_custody_escrow() {
    let (mut svm, ctx) = boot(false);
    warp_to(&mut svm, 1_000);

    let (custody_pda, escrow_pda) = open_redemption_vault(&mut svm, &ctx, 9);
    let mut metas = acc::MintToTreasury {
        authority: ctx.payer.pubkey(),
        admin_record: ctx.admin_pda,
        issuer: ctx.issuer_pda,
        asset: ctx.asset_pda,
        share_class: ctx.share_class_pda,
        mint: ctx.mint_pda,
        destination: escrow_pda,
        token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    metas.push(AccountMeta::new_readonly(custody_pda, false));
    send(
        &mut svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::MintToTreasury { amount: 42 }.data(),
            metas,
        )],
        "mint_to_treasury (custody escrow)",
    );
    assert_eq!(token_balance(&svm, &escrow_pda), 42);
}

/// A `mint_to_treasury` whose destination is `escrow`, proving the binding with
/// `parent` (the `CustodyVault` / `RightsIssuance` PDA that owns the escrow).
fn mint_to_escrow_ix(ctx: &Ctx, escrow: &Pubkey, parent: &Pubkey, amount: u64) -> Instruction {
    let mut metas = acc::MintToTreasury {
        authority: ctx.payer.pubkey(),
        admin_record: ctx.admin_pda,
        issuer: ctx.issuer_pda,
        asset: ctx.asset_pda,
        share_class: ctx.share_class_pda,
        mint: ctx.mint_pda,
        destination: *escrow,
        token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    metas.push(AccountMeta::new_readonly(*parent, false));
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::MintToTreasury { amount }.data(),
        metas,
    )
}

/// A `CustodyVault` of the right share class and mint is NOT enough: the vault
/// must also have no escrow → wallet exit. `mint_to_treasury` and
/// `open_custody_vault` share one privilege level (an `Admin` record), so
/// without this gate the very signer the binding constrains could mint fresh
/// KycGated units into a `DeliveryEscrow` vault and `return_custody_vault`
/// them to any wallet — the vault's own `EscrowMarker` exempts that leg from
/// receiver KYC. MintDestinationVaultNotBurnOnly (6082).
#[test]
fn mint_to_treasury_rejects_vaults_with_a_wallet_exit() {
    let (mut svm, ctx) = boot(true); // KycGated — the units being conjured
    warp_to(&mut svm, 1_000);

    // (a) DeliveryEscrow — `return_custody_vault` pays `beneficiary` (here a
    //     wallet with no KycEntry at all).
    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 10_000_000_000).unwrap();
    let (delivery_pda, delivery_escrow) = open_vault(
        &mut svm,
        &ctx,
        1,
        VaultType::DeliveryEscrow,
        mallory.pubkey(),
    );
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[mint_to_escrow_ix(
            &ctx,
            &delivery_escrow,
            &delivery_pda,
            100,
        )],
    )
    .expect_err("a DeliveryEscrow vault must not be a mint destination");
    assert!(err.contains("Custom(6082)"), "got: {err}");
    assert_eq!(token_balance(&svm, &delivery_escrow), 0, "escrow untouched");

    // (b) A non-delivery vault whose realize action pays a beneficiary is
    //     refused for the same reason (and would strand the units today —
    //     `realize_custody_vault` only implements BurnAndAttest).
    //     `open_custody_vault` no longer stores such an action, so model a
    //     vault written before that gate by rewriting the state directly.
    let (vesting_pda, vesting_escrow) =
        open_vault(&mut svm, &ctx, 2, VaultType::Vesting, mallory.pubkey());
    set_realize_action(&mut svm, &vesting_pda, RealizeAction::TransferToBeneficiary);
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[mint_to_escrow_ix(&ctx, &vesting_escrow, &vesting_pda, 100)],
    )
    .expect_err("a TransferToBeneficiary vault must not be a mint destination");
    assert!(err.contains("Custom(6082)"), "got: {err}");
    assert_eq!(token_balance(&svm, &vesting_escrow), 0, "escrow untouched");

    // (c) The burn-only shapes still fund — the legitimate flow is intact.
    let (vesting_ok_pda, vesting_ok_escrow) =
        open_vault(&mut svm, &ctx, 3, VaultType::Vesting, Pubkey::default());
    send(
        &mut svm,
        &[&ctx.payer],
        &[mint_to_escrow_ix(
            &ctx,
            &vesting_ok_escrow,
            &vesting_ok_pda,
            25,
        )],
        "mint_to_treasury (Vesting + BurnAndAttest)",
    );
    assert_eq!(token_balance(&svm, &vesting_ok_escrow), 25);
}

// ── claim_milestone — the claimer's own account is the only destination ──────

/// Opens a `RightsIssuance` over the boot share class (underlying = the share
/// mint), funds its escrow with `amount` freshly minted units and publishes a
/// single-leaf milestone entitling `claimer` to `entitlement`.
/// Returns `(rights_pda, rights_escrow, milestone_pda)`.
fn create_rights_issuance_ix(ctx: &Ctx, issuance_id: u64) -> (Instruction, Pubkey, Pubkey) {
    let (rights_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::RIGHTS_SEED,
            ctx.share_class_pda.as_ref(),
            &issuance_id.to_le_bytes(),
        ],
        &ctx.program_id,
    );
    let (rights_escrow, _) = Pubkey::find_program_address(
        &[asset_registry::ESCROW_SEED, rights_pda.as_ref()],
        &ctx.program_id,
    );
    let ix = Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::CreateRightsIssuance { issuance_id }.data(),
        acc::CreateRightsIssuance {
            identity: Pubkey::find_program_address(
                &[asset_registry::ESCROW_MARKER_SEED, rights_pda.as_ref()],
                &asset_registry::ID,
            )
            .0,
            authority: ctx.payer.pubkey(),
            admin_record: ctx.admin_pda,
            share_class: ctx.share_class_pda,
            underlying_mint: ctx.mint_pda,
            rights_issuance: rights_pda,
            escrow: rights_escrow,
            token_program: TOKEN_2022,
            system_program: system_program::ID,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
    );
    (ix, rights_pda, rights_escrow)
}

/// Milestone 0 with a single-leaf snapshot (root == leaf, so an empty proof
/// verifies). The root is whatever the admin says it is.
fn publish_milestone_ix(
    ctx: &Ctx,
    rights_pda: &Pubkey,
    claimer: &Pubkey,
    entitlement: u64,
) -> (Instruction, Pubkey) {
    let index: u16 = 0;
    let (milestone_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::RT_MILESTONE_SEED,
            rights_pda.as_ref(),
            &index.to_le_bytes(),
        ],
        &ctx.program_id,
    );
    let ix = Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::PublishMilestone {
            index,
            merkle_root: util::snapshot_leaf(claimer, entitlement),
            amount_pool: entitlement,
            unlock_ts: 0,
        }
        .data(),
        acc::PublishMilestone {
            authority: ctx.payer.pubkey(),
            admin_record: ctx.admin_pda,
            rights_issuance: *rights_pda,
            milestone: milestone_pda,
            system_program: system_program::ID,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
    );
    (ix, milestone_pda)
}

fn setup_rights_issuance(
    svm: &mut LiteSVM,
    ctx: &Ctx,
    issuance_id: u64,
    amount: u64,
    claimer: &Pubkey,
    entitlement: u64,
) -> (Pubkey, Pubkey, Pubkey) {
    let (create_ix, rights_pda, rights_escrow) = create_rights_issuance_ix(ctx, issuance_id);
    send(svm, &[&ctx.payer], &[create_ix], "create_rights_issuance");
    send(
        svm,
        &[&ctx.payer],
        &[mint_to_escrow_ix(ctx, &rights_escrow, &rights_pda, amount)],
        "fund rights escrow",
    );
    let (publish_ix, milestone_pda) = publish_milestone_ix(ctx, &rights_pda, claimer, entitlement);
    send(svm, &[&ctx.payer], &[publish_ix], "publish_milestone");
    (rights_pda, rights_escrow, milestone_pda)
}

#[allow(clippy::too_many_arguments)]
fn claim_milestone_ix(
    ctx: &Ctx,
    claimer: &Pubkey,
    rights_pda: &Pubkey,
    rights_escrow: &Pubkey,
    milestone_pda: &Pubkey,
    claimer_token_account: &Pubkey,
    dest_owner: &Pubkey,
    amount: u64,
) -> Instruction {
    let (claim_pda, _) = Pubkey::find_program_address(
        &[
            asset_registry::RT_CLAIM_SEED,
            milestone_pda.as_ref(),
            claimer.as_ref(),
        ],
        &ctx.program_id,
    );
    let mut metas = acc::ClaimMilestone {
        claimer: *claimer,
        rights_issuance: *rights_pda,
        milestone: *milestone_pda,
        claim: claim_pda,
        underlying_mint: ctx.mint_pda,
        escrow: *rights_escrow,
        claimer_token_account: *claimer_token_account,
        token_program: TOKEN_2022,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    // The escrow → destination leg's KycGated hook tail: source authority and
    // source owner are both the RightsIssuance PDA (which carries no
    // EscrowMarker, so receiver KYC really applies to the destination owner).
    metas.extend(kyc_hook_metas(ctx, rights_pda, rights_pda, dest_owner));
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::ClaimMilestone {
            amount,
            proof: vec![],
        }
        .data(),
        metas,
    )
}

/// `publish_milestone` takes an ARBITRARY `merkle_root`, so the milestone path
/// is admin-trusted by construction — but the delivery destination must still
/// be the claimer's own account. Otherwise an admin plus one accomplice could
/// route escrowed units into a permissionlessly created `Offer` escrow (owner =
/// `Offer` PDA, whose `EscrowMarker` makes the hook skip receiver KYC) and
/// `cancel_offer` them out to a wallet with no `KycEntry`.
#[test]
fn claim_milestone_binds_claimer_token_account() {
    let (mut svm, ctx) = boot(true); // KycGated mint
    warp_to(&mut svm, 1_000);

    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 10_000_000_000).unwrap();
    let mallory_pk = mallory.pubkey();
    let (rights_pda, rights_escrow, milestone_pda) =
        setup_rights_issuance(&mut svm, &ctx, 1, 100, &mallory_pk, 40);
    assert_eq!(token_balance(&svm, &rights_escrow), 100);

    // The exfiltration destination: an Offer escrow anyone can conjure.
    let (offer_pda, offer_escrow) = create_offer(&mut svm, &ctx, &mallory, 7);
    let err = try_send(
        &mut svm,
        &[&mallory],
        &[claim_milestone_ix(
            &ctx,
            &mallory_pk,
            &rights_pda,
            &rights_escrow,
            &milestone_pda,
            &offer_escrow,
            &offer_pda,
            40,
        )],
    )
    .expect_err("a claim must not deliver into a third party's token account");
    assert!(err.contains("Custom(6001)"), "got: {err}"); // Unauthorized
    assert_eq!(token_balance(&svm, &offer_escrow), 0, "offer escrow empty");
    assert_eq!(token_balance(&svm, &rights_escrow), 100, "escrow untouched");

    // The legitimate claim — same entitlement, claimer's OWN (KYC'd) account.
    approve_kyc(&mut svm, &ctx, &mallory_pk);
    let mallory_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &mallory_pk);
    send(
        &mut svm,
        &[&mallory],
        &[claim_milestone_ix(
            &ctx,
            &mallory_pk,
            &rights_pda,
            &rights_escrow,
            &milestone_pda,
            &mallory_ata,
            &mallory_pk,
            40,
        )],
        "claim_milestone (own account)",
    );
    assert_eq!(token_balance(&svm, &mallory_ata), 40);
    assert_eq!(token_balance(&svm, &rights_escrow), 60);
}

/// TRIPWIRE — the Rights-Token escrow→claimer leg is gated by the HOOK, and
/// only because `create_rights_issuance` deliberately does NOT stamp an
/// `EscrowMarker` on the `RightsIssuance` PDA. Nothing in `claim_milestone`
/// re-checks the receiver, so if a marker is ever added there (e.g. to let the
/// escrow be funded by transfer, the way custody vaults are) this whole path
/// would silently become an admin-plus-accomplice channel for delivering
/// KycGated units to a wallet with no `KycEntry` — and every existing test
/// would stay green, because the positive control approves the claimer first.
///
/// This test pins the property: a claim into the claimer's OWN account with no
/// approved `KycEntry` must fail at the hook.
#[test]
fn claim_milestone_requires_claimer_kyc() {
    let (mut svm, ctx) = boot(true); // KycGated mint
    warp_to(&mut svm, 1_000);

    let claimer = Keypair::new();
    svm.airdrop(&claimer.pubkey(), 10_000_000_000).unwrap();
    let claimer_pk = claimer.pubkey();
    let (rights_pda, rights_escrow, milestone_pda) =
        setup_rights_issuance(&mut svm, &ctx, 1, 100, &claimer_pk, 40);
    let claimer_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &claimer_pk);

    // No KycEntry for the claimer — the hook must reject the delivery even
    // though the entitlement proof and the account binding are both valid.
    let err = try_send(
        &mut svm,
        &[&claimer],
        &[claim_milestone_ix(
            &ctx,
            &claimer_pk,
            &rights_pda,
            &rights_escrow,
            &milestone_pda,
            &claimer_ata,
            &claimer_pk,
            40,
        )],
    )
    .expect_err("a claim to a wallet with no KycEntry must fail");
    assert!(
        err.contains("Custom("),
        "expected a program error, got: {err}"
    );
    assert_eq!(token_balance(&svm, &claimer_ata), 0, "no units leaked");
    assert_eq!(token_balance(&svm, &rights_escrow), 100, "escrow untouched");

    // POSITIVE CONTROL — approve the claimer and the identical claim settles.
    approve_kyc(&mut svm, &ctx, &claimer_pk);
    send(
        &mut svm,
        &[&claimer],
        &[claim_milestone_ix(
            &ctx,
            &claimer_pk,
            &rights_pda,
            &rights_escrow,
            &milestone_pda,
            &claimer_ata,
            &claimer_pk,
            40,
        )],
        "claim_milestone (KYC'd claimer)",
    );
    assert_eq!(token_balance(&svm, &claimer_ata), 40);
    assert_eq!(token_balance(&svm, &rights_escrow), 60);
}

// ── clawback — registry pinning and destination containment ──────────────────

/// Buys 10 units for the boot buyer on a `KycGated` mint and revokes them, so
/// the balance is seizable. Returns the buyer pubkey.
fn buy_then_revoke(svm: &mut LiteSVM, ctx: &Ctx) -> Pubkey {
    let buyer_pk = ctx.buyer.pubkey();
    approve_kyc(svm, ctx, &buyer_pk);
    send(
        svm,
        &[&ctx.buyer],
        &[buy_ix(
            ctx,
            10,
            kyc_hook_metas(ctx, &buyer_pk, &buyer_pk, &buyer_pk),
        )],
        "buy",
    );
    revoke_kyc(svm, ctx, &buyer_pk);
    buyer_pk
}

#[test]
fn clawback_on_open_mint_fails() {
    let (mut svm, ctx) = boot(false); // Open mint — no configured registry
    warp_to(&mut svm, 1_000);

    // The buyer holds units bought in Open mode, and carries a Revoked entry
    // in a registry the mint is NOT configured for (on an Open mint EVERY
    // registry is such a registry — that is the point).
    let buyer_pk = ctx.buyer.pubkey();
    approve_kyc(&mut svm, &ctx, &buyer_pk);
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(&ctx, 10, open_hook_metas(&ctx, &buyer_pk))],
        "buy (Open mint)",
    );
    revoke_kyc(&mut svm, &ctx, &buyer_pk);
    let (custody_pda, escrow_pda) = open_redemption_vault(&mut svm, &ctx, 1);

    let payer_pk = ctx.payer.pubkey();
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[clawback_ix(
            &ctx,
            &payer_pk,
            &buyer_pk,
            &ctx.buyer_share_ata,
            &custody_pda,
            &escrow_pda,
            0,
        )],
    )
    .expect_err("clawback on an Open mint must be refused");
    assert!(err.contains("Custom(6080)"), "got: {err}");
    assert_eq!(
        token_balance(&svm, &ctx.buyer_share_ata),
        10,
        "holder balance untouched"
    );
}

#[test]
fn clawback_with_foreign_registry_fails() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    let buyer_pk = buy_then_revoke(&mut svm, &ctx);
    let (custody_pda, escrow_pda) = open_redemption_vault(&mut svm, &ctx, 1);

    // A rogue registry — created by a KYC-provider key with the platform admin
    // co-signing (i.e. even an admin's OWN registry does not work).
    let rogue = Keypair::new();
    svm.airdrop(&rogue.pubkey(), 10_000_000_000).unwrap();
    let (rogue_registry, _) = Pubkey::find_program_address(
        &[asset_registry::KYC_REGISTRY_SEED, rogue.pubkey().as_ref()],
        &ctx.program_id,
    );
    send(
        &mut svm,
        &[&rogue, &ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::CreateKycRegistry {
                approved_jurisdictions: [0xFFu8; 128],
                blocked_jurisdictions: [0u8; 128],
            }
            .data(),
            acc::CreateKycRegistry {
                authority: rogue.pubkey(),
                admin_authority: ctx.payer.pubkey(),
                admin_record: ctx.admin_pda,
                kyc_registry: rogue_registry,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "create_kyc_registry (rogue)",
    );

    // Fabricate a Revoked entry for the victim inside it.
    let (rogue_entry, _) = Pubkey::find_program_address(
        &[
            asset_registry::KYC_SEED,
            rogue_registry.as_ref(),
            buyer_pk.as_ref(),
        ],
        &ctx.program_id,
    );
    send(
        &mut svm,
        &[&rogue],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::ApproveHolder {
                holder: buyer_pk,
                jurisdiction: JURISDICTION,
                accreditation_level: 1,
                expiry: FAR_FUTURE,
                provider_id: 1,
                external_ref_hash: [1u8; 32],
            }
            .data(),
            acc::ApproveHolder {
                authority: rogue.pubkey(),
                kyc_registry: rogue_registry,
                kyc_entry: rogue_entry,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "approve_holder (rogue registry)",
    );
    send(
        &mut svm,
        &[&rogue],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::RevokeHolder { holder: buyer_pk }.data(),
            acc::RevokeHolder {
                authority: rogue.pubkey(),
                kyc_registry: rogue_registry,
                kyc_entry: rogue_entry,
            }
            .to_account_metas(None),
        )],
        "revoke_holder (rogue registry)",
    );

    // The mint's hook config names the boot registry — the rogue one is refused
    // even though its entry says Revoked.
    let payer_pk = ctx.payer.pubkey();
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[clawback_ix_with_registry(
            &ctx,
            &payer_pk,
            &buyer_pk,
            &ctx.buyer_share_ata,
            &custody_pda,
            &escrow_pda,
            &rogue_registry,
            0,
        )],
    )
    .expect_err("a registry the mint is not configured for must be refused");
    assert!(err.contains("Custom(6072)"), "got: {err}");
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 10);
}

#[test]
fn clawback_destination_must_be_burn_only_vault() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    let buyer_pk = buy_then_revoke(&mut svm, &ctx);
    let (custody_pda, _escrow_pda) = open_redemption_vault(&mut svm, &ctx, 1);

    // (a) A permissionlessly created Offer escrow — the exfiltration route
    //     (`cancel_offer` pays the whole balance to the maker's wallet) — is
    //     not a valid destination: it is not this vault's escrow.
    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), 10_000_000_000).unwrap();
    let (_offer_pda, offer_escrow) = create_offer(&mut svm, &ctx, &mallory, 5);
    let payer_pk = ctx.payer.pubkey();
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[clawback_ix(
            &ctx,
            &payer_pk,
            &buyer_pk,
            &ctx.buyer_share_ata,
            &custody_pda,
            &offer_escrow,
            0,
        )],
    )
    .expect_err("an Offer escrow must not be a clawback destination");
    assert!(err.contains("Custom(6081)"), "got: {err}");
    assert_eq!(token_balance(&svm, &offer_escrow), 0);

    // (b) A DeliveryEscrow vault is refused too — `return_custody_vault` would
    //     hand the seized units to its beneficiary's wallet.
    let (delivery_pda, delivery_escrow) = open_vault(
        &mut svm,
        &ctx,
        2,
        VaultType::DeliveryEscrow,
        ctx.payer.pubkey(),
    );
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[clawback_ix(
            &ctx,
            &payer_pk,
            &buyer_pk,
            &ctx.buyer_share_ata,
            &delivery_pda,
            &delivery_escrow,
            0,
        )],
    )
    .expect_err("a DeliveryEscrow vault must not be a clawback destination");
    assert!(err.contains("Custom(6081)"), "got: {err}");

    assert_eq!(
        token_balance(&svm, &ctx.buyer_share_ata),
        10,
        "holder balance untouched by either attempt"
    );
}

// ── clawback must never target a program escrow ──────────────────────────────

/// `holder` is a free parameter and `approve_holder` mints a `KycEntry` for ANY
/// pubkey — a PDA included. Without the `holder_escrow_marker` guard an admin
/// could approve→revoke one of the program's own escrows and "claw back" its
/// balance into a burn vault, destroying the ledgered deposit of a perfectly
/// compliant maker/seller/beneficiary. The marker account is address-derived by
/// Anchor, so the caller can neither omit nor substitute it.
#[test]
fn clawback_refuses_a_program_escrow_as_holder() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);

    // A DeliveryEscrow vault standing in for "some program escrow holding a
    // compliant user's ledgered deposit". Its PDA owns the escrow token
    // account and carries an EscrowMarker.
    let victim_beneficiary = Keypair::new();
    svm.airdrop(&victim_beneficiary.pubkey(), 10_000_000_000)
        .unwrap();
    let (victim_vault, victim_escrow) = open_vault(
        &mut svm,
        &ctx,
        77,
        VaultType::DeliveryEscrow,
        victim_beneficiary.pubkey(),
    );

    // The admin gives the ESCROW PDA a KYC entry and then revokes it — both
    // instructions accept an arbitrary pubkey, so this part succeeds.
    approve_kyc(&mut svm, &ctx, &victim_vault);
    revoke_kyc(&mut svm, &ctx, &victim_vault);

    // Destination: a legitimate burn-only quarantine vault.
    let (quarantine, quarantine_escrow) = open_redemption_vault(&mut svm, &ctx, 78);

    let before = token_balance(&svm, &victim_escrow);
    let authority = ctx.payer.pubkey();
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[clawback_ix(
            &ctx,
            &authority,
            &victim_vault,
            &victim_escrow,
            &quarantine,
            &quarantine_escrow,
            0,
        )],
    )
    .expect_err("clawback against a program escrow must fail");
    assert!(
        err.contains("Custom(6087)"),
        "expected ClawbackTargetIsEscrow, got: {err}"
    );
    assert_eq!(
        token_balance(&svm, &victim_escrow),
        before,
        "escrow balance untouched"
    );
}

/// Layout pin: `transfer_hook` reads `KycRegistry` by raw byte offset (it has
/// no crate dependency on `asset_registry`), so its hardcoded constants —
/// `KYC_REGISTRY_APPROVED_OFFSET` (40), `KYC_REGISTRY_BLOCKED_OFFSET` (168),
/// `KYC_REGISTRY_MIN_LEN` (296) — must track this struct byte for byte. This
/// is the same pact the `SHARE_CLASS_DISCRIMINATOR` assertion in
/// test_happy_path guards. If this test fails, update the hook's constants
/// AND its `kyc_registry_bytes` test fixture together.
#[test]
fn kyc_registry_layout_matches_hook_offsets() {
    use anchor_lang::{AnchorSerialize, Discriminator};
    use asset_registry::{KycRegistry, JURISDICTION_BITMAP_BYTES};

    assert_eq!(JURISDICTION_BITMAP_BYTES, 128);

    let reg = KycRegistry {
        authority: Pubkey::new_from_array([7u8; 32]),
        approved_jurisdictions: [0xAA; JURISDICTION_BITMAP_BYTES],
        blocked_jurisdictions: [0xBB; JURISDICTION_BITMAP_BYTES],
        entries_count: 0x1122_3344_5566_7788,
        version: 9,
        bump: 250,
    };
    let mut data = KycRegistry::DISCRIMINATOR.to_vec();
    reg.serialize(&mut data).unwrap();

    assert_eq!(&data[8..40], reg.authority.as_ref(), "authority @ 8");
    assert_eq!(
        &data[40..168],
        &[0xAAu8; 128][..],
        "approved_jurisdictions @ 40 — hook KYC_REGISTRY_APPROVED_OFFSET"
    );
    assert_eq!(
        &data[168..296],
        &[0xBBu8; 128][..],
        "blocked_jurisdictions @ 168 — hook KYC_REGISTRY_BLOCKED_OFFSET"
    );
    assert_eq!(
        &data[296..304],
        &0x1122_3344_5566_7788u64.to_le_bytes(),
        "entries_count @ 296 — hook KYC_REGISTRY_MIN_LEN"
    );
    assert_eq!(data.len(), 306, "total serialized KycRegistry length");

    // Cross-crate pin: `update_transfer_hook_config` validates a named
    // registry by these two hardcoded hook constants.
    assert_eq!(
        KycRegistry::DISCRIMINATOR,
        &transfer_hook::KYC_REGISTRY_DISCRIMINATOR[..],
        "transfer_hook::KYC_REGISTRY_DISCRIMINATOR drifted from asset_registry::KycRegistry"
    );
    assert_eq!(
        8 + <KycRegistry as anchor_lang::Space>::INIT_SPACE,
        transfer_hook::KYC_REGISTRY_ACCOUNT_LEN,
        "transfer_hook::KYC_REGISTRY_ACCOUNT_LEN drifted from asset_registry::KycRegistry"
    );
}

// ── KYC registry rotation / jurisdictions on a live KycGated mint (2C-1) ────

/// The payer (creating KYC authority) hands the boot registry to `next`.
fn rotate_registry(svm: &mut LiteSVM, ctx: &Ctx, next: &Keypair) {
    send(
        svm,
        &[&ctx.payer],
        &[kyc::propose_ix(
            &ctx.payer.pubkey(),
            &ctx.kyc_registry_pda,
            &next.pubkey(),
        )],
        "propose_kyc_registry_authority",
    );
    send(
        svm,
        &[next],
        &[kyc::accept_ix(&next.pubkey(), &ctx.kyc_registry_pda)],
        "accept_kyc_registry_authority",
    );
}

/// A jurisdiction block applies immediately to every path that reads the
/// registry live: the hook (wallet transfer) and `buy`'s receiver check. The
/// hook config pins the registry by address, so nothing needs re-pointing.
#[test]
fn jurisdiction_update_applies_live_to_a_kyc_gated_mint() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    let buyer = ctx.buyer.pubkey();
    let receiver = Keypair::new();
    approve_kyc(&mut svm, &ctx, &buyer);
    approve_kyc(&mut svm, &ctx, &receiver.pubkey());
    let receiver_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &receiver.pubkey());
    let tail = || kyc_hook_metas(&ctx, &buyer, &buyer, &buyer);
    let to_receiver = || {
        transfer_ix(
            &ctx,
            ctx.buyer_share_ata,
            receiver_ata,
            buyer,
            buyer,
            receiver.pubkey(),
            true,
        )
    };

    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(&ctx, 10, tail())],
        "buy in J",
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[to_receiver()],
        "transfer to J holder",
    );
    assert_eq!(token_balance(&svm, &receiver_ata), 1);

    // Block J (approved map untouched: blocked wins).
    send(
        &mut svm,
        &[&ctx.payer],
        &[kyc::update_jurisdictions_ix(
            &ctx.payer.pubkey(),
            &ctx.kyc_registry_pda,
            [0xFF; 128],
            kyc::bitmap(&[JURISDICTION]),
        )],
        "block J",
    );
    let err = try_send(&mut svm, &[&ctx.buyer], &[to_receiver()])
        .expect_err("hook transfer into a blocked jurisdiction");
    assert_custom_error(
        &err,
        u32::from(transfer_hook::HookError::JurisdictionBlocked),
    );
    let err = try_send(&mut svm, &[&ctx.buyer], &[buy_ix(&ctx, 1, tail())])
        .expect_err("buy into a blocked jurisdiction");
    assert_custom_error(&err, 6071); // ReceiverJurisdictionBlocked
    assert_eq!(token_balance(&svm, &receiver_ata), 1);
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 9);

    // Unblock — both paths work again.
    send(
        &mut svm,
        &[&ctx.payer],
        &[kyc::update_jurisdictions_ix(
            &ctx.payer.pubkey(),
            &ctx.kyc_registry_pda,
            [0xFF; 128],
            [0u8; 128],
        )],
        "unblock J",
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[to_receiver()],
        "transfer after unblock",
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(&ctx, 1, tail())],
        "buy after unblock",
    );
    assert_eq!(token_balance(&svm, &receiver_ata), 2);
}

/// Rotation does not re-point anything: the hook config and every KycEntry
/// stay keyed on the registry ADDRESS. The new authority revokes on the same
/// registry, the admin claws back, the old authority is locked out.
#[test]
fn clawback_still_works_after_registry_rotation() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    let buyer = ctx.buyer.pubkey();
    approve_kyc(&mut svm, &ctx, &buyer);
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            10,
            kyc_hook_metas(&ctx, &buyer, &buyer, &buyer),
        )],
        "buy",
    );

    let compliance = Keypair::new();
    svm.airdrop(&compliance.pubkey(), 10_000_000_000).unwrap();
    rotate_registry(&mut svm, &ctx, &compliance);

    // The old authority (still the platform admin) is out of the registry.
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[kyc::revoke_ix(
            &ctx.payer.pubkey(),
            &ctx.kyc_registry_pda,
            &buyer,
        )],
    )
    .expect_err("old registry authority cannot revoke");
    assert_custom_error(&err, 6001);

    send(
        &mut svm,
        &[&compliance],
        &[kyc::revoke_ix(
            &compliance.pubkey(),
            &ctx.kyc_registry_pda,
            &buyer,
        )],
        "revoke by the rotated authority",
    );
    let (custody_pda, escrow_pda) = open_redemption_vault(&mut svm, &ctx, 77);
    let payer_pk = ctx.payer.pubkey();
    send(
        &mut svm,
        &[&ctx.payer],
        &[clawback_ix(
            &ctx,
            &payer_pk,
            &buyer,
            &ctx.buyer_share_ata,
            &custody_pda,
            &escrow_pda,
            0,
        )],
        "clawback after rotation",
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 0);
    assert_eq!(token_balance(&svm, &escrow_pda), 10);
}

/// The issuing half after a rotation: a holder approved ONLY by the new
/// authority, on the same registry address, buys (`receiver_kyc_outcome`)
/// and receives through the hook — no hook config re-point needed.
#[test]
fn holder_approved_by_the_rotated_authority_buys_and_receives() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    let buyer = ctx.buyer.pubkey();
    let receiver = Keypair::new();
    let receiver_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &receiver.pubkey());
    let config_before: transfer_hook::TransferHookConfig = load(&svm, &ctx.hook_config_pda);

    let compliance = Keypair::new();
    svm.airdrop(&compliance.pubkey(), 10_000_000_000).unwrap();
    rotate_registry(&mut svm, &ctx, &compliance);

    // The old authority can no longer onboard anyone.
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[kyc::approve_ix(
            &ctx.payer.pubkey(),
            &ctx.kyc_registry_pda,
            &buyer,
            JURISDICTION,
        )],
    )
    .expect_err("old registry authority cannot approve");
    assert_custom_error(&err, 6001);

    for holder in [buyer, receiver.pubkey()] {
        send(
            &mut svm,
            &[&compliance],
            &[kyc::approve_ix(
                &compliance.pubkey(),
                &ctx.kyc_registry_pda,
                &holder,
                JURISDICTION,
            )],
            "approve by the rotated authority",
        );
    }
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            10,
            kyc_hook_metas(&ctx, &buyer, &buyer, &buyer),
        )],
        "buy by a holder the rotated authority approved",
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[transfer_ix(
            &ctx,
            ctx.buyer_share_ata,
            receiver_ata,
            buyer,
            buyer,
            receiver.pubkey(),
            true,
        )],
        "hook transfer to a holder the rotated authority approved",
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 9);
    assert_eq!(token_balance(&svm, &receiver_ata), 1);

    let config_after: transfer_hook::TransferHookConfig = load(&svm, &ctx.hook_config_pda);
    assert_eq!(config_after.kyc_registry, Some(ctx.kyc_registry_pda));
    assert_eq!(
        config_after.version, config_before.version,
        "hook config never touched by the rotation"
    );
}

/// `update_transfer_hook_config` for a KycGated mint pointing at `registry`.
fn repoint_hook_ix(ctx: &Ctx, registry: Pubkey) -> Instruction {
    let (blocklist_authority, _) =
        Pubkey::find_program_address(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED], &ctx.hook_id);
    Instruction::new_with_bytes(
        ctx.hook_id,
        &transfer_hook::instruction::UpdateTransferHookConfig {
            restriction_mode: transfer_hook::RestrictionMode::KycGated,
            kyc_registry: Some(registry),
        }
        .data(),
        transfer_hook::accounts::UpdateTransferHookConfig {
            authority: ctx.payer.pubkey(),
            blocklist_authority,
            mint: ctx.mint_pda,
            config: ctx.hook_config_pda,
            extra_account_meta_list: ctx.extra_metas_pda,
            system_program: system_program::ID,
            kyc_registry_account: Some(registry),
        }
        .to_account_metas(None),
    )
}

/// The lost-KYC-key recovery path with REAL registries: a replacement
/// registry R2 (fresh key, admin co-signed) is created, the KycGated mint is
/// re-pointed R1 -> R2, and from then on only R2 passports count — for the
/// hook and for `buy` alike.
#[test]
fn re_pointing_a_kyc_gated_mint_to_a_replacement_registry() {
    let (mut svm, mut ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    let r1 = ctx.kyc_registry_pda;
    let buyer = ctx.buyer.pubkey();
    let receiver = Keypair::new();
    let receiver_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &receiver.pubkey());
    approve_kyc(&mut svm, &ctx, &buyer); // R1 only
    approve_kyc(&mut svm, &ctx, &receiver.pubkey()); // R1 only
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            10,
            kyc_hook_metas(&ctx, &buyer, &buyer, &buyer),
        )],
        "buy on R1",
    );

    // Replacement registry from a key that never created one.
    let r2_key = Keypair::new();
    svm.airdrop(&r2_key.pubkey(), 10_000_000_000).unwrap();
    send(
        &mut svm,
        &[&r2_key, &ctx.payer],
        &[kyc::create_registry_ix(
            &r2_key.pubkey(),
            &ctx.payer.pubkey(),
            [0xFF; 128],
            [0u8; 128],
        )],
        "create R2",
    );
    let r2 = kyc::registry_pda(&r2_key.pubkey());
    assert_ne!(r1, r2);
    send(
        &mut svm,
        &[&ctx.payer],
        &[repoint_hook_ix(&ctx, r2)],
        "re-point R1 -> R2",
    );
    let config: transfer_hook::TransferHookConfig = load(&svm, &ctx.hook_config_pda);
    assert_eq!(config.kyc_registry, Some(r2));

    // A stale client still naming R1 is refused by both paths.
    let stale_buy = buy_ix(&ctx, 1, kyc_hook_metas(&ctx, &buyer, &buyer, &buyer));
    let to_receiver = |ctx: &Ctx| {
        transfer_ix(
            ctx,
            ctx.buyer_share_ata,
            receiver_ata,
            buyer,
            buyer,
            receiver.pubkey(),
            true,
        )
    };
    let stale_transfer = to_receiver(&ctx);
    try_send(&mut svm, &[&ctx.buyer], &[stale_buy]).expect_err("buy with an R1 tail");
    try_send(&mut svm, &[&ctx.buyer], &[stale_transfer]).expect_err("transfer with an R1 tail");

    // From here on the tails name R2; R1 passports no longer count.
    ctx.kyc_registry_pda = r2;
    let err = try_send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            1,
            kyc_hook_metas(&ctx, &buyer, &buyer, &buyer),
        )],
    )
    .expect_err("buyer approved only in R1");
    assert_custom_error(&err, 6069); // ReceiverNotApproved
    let err = try_send(&mut svm, &[&ctx.buyer], &[to_receiver(&ctx)])
        .expect_err("receiver approved only in R1");
    assert_custom_error(
        &err,
        u32::from(transfer_hook::HookError::ReceiverNotApproved),
    );
    assert_eq!(token_balance(&svm, &receiver_ata), 0);

    // Re-issued in R2 — both paths pass again.
    for holder in [buyer, receiver.pubkey()] {
        send(
            &mut svm,
            &[&r2_key],
            &[kyc::approve_ix(
                &r2_key.pubkey(),
                &r2,
                &holder,
                JURISDICTION,
            )],
            "re-issue in R2",
        );
    }
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            1,
            kyc_hook_metas(&ctx, &buyer, &buyer, &buyer),
        )],
        "buy on R2",
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[to_receiver(&ctx)],
        "transfer on R2",
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 10);
    assert_eq!(token_balance(&svm, &receiver_ata), 1);
}

// ── Fixed owner and source-owner sanctions invariants ───────────────────────

/// A standards-compliant custom Token-2022 account, with mint-required
/// extensions but intentionally without the optional ImmutableOwner extension.
fn create_mutable_share_account(svm: &mut LiteSVM, ctx: &Ctx, owner: &Pubkey) -> Pubkey {
    use spl_token_2022_interface::{
        extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
        state::{Account, Mint},
    };
    let mint = svm.get_account(&ctx.mint_pda).unwrap();
    let state = StateWithExtensions::<Mint>::unpack(&mint.data).unwrap();
    let required =
        ExtensionType::get_required_init_account_extensions(&state.get_extension_types().unwrap());
    let space = ExtensionType::try_calculate_account_len::<Account>(&required).unwrap();
    let account = Keypair::new();
    let create = anchor_lang::solana_program::system_instruction::create_account(
        &ctx.payer.pubkey(),
        &account.pubkey(),
        svm.minimum_balance_for_rent_exemption(space),
        space as u64,
        &TOKEN_2022,
    );
    let init = token_ix::initialize_account3(&TOKEN_2022, &account.pubkey(), &ctx.mint_pda, owner)
        .unwrap();
    send(
        svm,
        &[&ctx.payer, &account],
        &[create, init],
        "create custom mutable account",
    );
    account.pubkey()
}

fn assert_custom_error(err: &str, code: u32) {
    assert!(
        err.contains(&format!("Custom({code})")),
        "expected {code}, got {err}"
    );
}

fn block_holder(svm: &mut LiteSVM, ctx: &Ctx, holder: Pubkey) {
    let authority =
        Pubkey::find_program_address(&[transfer_hook::BLOCKLIST_AUTHORITY_SEED], &ctx.hook_id).0;
    let block_entry = Pubkey::find_program_address(
        &[transfer_hook::BLOCK_ENTRY_SEED, holder.as_ref()],
        &ctx.hook_id,
    )
    .0;
    send(
        svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.hook_id,
            &transfer_hook::instruction::AddToBlocklist { wallet: holder }.data(),
            transfer_hook::accounts::AddToBlocklist {
                authority: ctx.payer.pubkey(),
                blocklist_authority: authority,
                block_entry,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "block holder",
    );
}

fn transfer_ix(
    ctx: &Ctx,
    source: Pubkey,
    destination: Pubkey,
    authority: Pubkey,
    source_owner: Pubkey,
    destination_owner: Pubkey,
    gated: bool,
) -> Instruction {
    let mut ix = token_ix::transfer_checked(
        &TOKEN_2022,
        &source,
        &ctx.mint_pda,
        &destination,
        &authority,
        &[],
        1,
        0,
    )
    .unwrap();
    ix.accounts.extend(if gated {
        kyc_hook_metas(ctx, &authority, &source_owner, &destination_owner)
    } else {
        open_hook_metas(ctx, &source_owner)
    });
    ix
}

#[test]
fn issuance_rejects_mutable_owners_before_payment_or_supply_changes() {
    for gated in [false, true] {
        let (mut svm, mut ctx) = boot(gated);
        warp_to(&mut svm, 1_000);
        let buyer = ctx.buyer.pubkey();
        if gated {
            approve_kyc(&mut svm, &ctx, &buyer);
        }
        let mutable_buyer = create_mutable_share_account(&mut svm, &ctx, &buyer);
        ctx.buyer_share_ata = mutable_buyer;
        let before_payment = token_balance(&svm, &ctx.buyer_payment_ata);
        let tail = if gated {
            kyc_hook_metas(&ctx, &buyer, &buyer, &buyer)
        } else {
            open_hook_metas(&ctx, &buyer)
        };
        let err = try_send(&mut svm, &[&ctx.buyer], &[buy_ix(&ctx, 1, tail)]).unwrap_err();
        assert_custom_error(
            &err,
            u32::from(asset_registry::error::RegistryError::ImmutableOwnerRequired),
        );
        assert_eq!(token_balance(&svm, &mutable_buyer), 0);
        assert_eq!(token_balance(&svm, &ctx.buyer_payment_ata), before_payment);
        assert_eq!(load::<Sale>(&svm, &ctx.sale_pda).sold, 0);

        let mutable_treasury = create_mutable_share_account(&mut svm, &ctx, &ctx.payer.pubkey());
        let ix = Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::MintToTreasury { amount: 1 }.data(),
            acc::MintToTreasury {
                authority: ctx.payer.pubkey(),
                admin_record: ctx.admin_pda,
                issuer: ctx.issuer_pda,
                asset: ctx.asset_pda,
                share_class: ctx.share_class_pda,
                mint: ctx.mint_pda,
                destination: mutable_treasury,
                token_program: TOKEN_2022,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        );
        let err = try_send(&mut svm, &[&ctx.payer], &[ix]).unwrap_err();
        assert_custom_error(
            &err,
            u32::from(asset_registry::error::RegistryError::ImmutableOwnerRequired),
        );
        assert_eq!(token_balance(&svm, &mutable_treasury), 0);
    }
}

#[test]
fn hook_rejects_mutable_destinations_and_blocked_owner_delegates_in_both_modes() {
    for gated in [false, true] {
        let (mut svm, ctx) = boot(gated);
        warp_to(&mut svm, 1_000);
        let buyer = ctx.buyer.pubkey();
        let receiver = Keypair::new();
        if gated {
            approve_kyc(&mut svm, &ctx, &buyer);
            approve_kyc(&mut svm, &ctx, &receiver.pubkey());
        }
        let tail = if gated {
            kyc_hook_metas(&ctx, &buyer, &buyer, &buyer)
        } else {
            open_hook_metas(&ctx, &buyer)
        };
        send(
            &mut svm,
            &[&ctx.buyer],
            &[buy_ix(&ctx, 5, tail)],
            "fund immutable holder",
        );
        let mutable = create_mutable_share_account(&mut svm, &ctx, &receiver.pubkey());
        let err = try_send(
            &mut svm,
            &[&ctx.buyer],
            &[transfer_ix(
                &ctx,
                ctx.buyer_share_ata,
                mutable,
                buyer,
                buyer,
                receiver.pubkey(),
                gated,
            )],
        )
        .unwrap_err();
        assert_custom_error(
            &err,
            u32::from(transfer_hook::HookError::ImmutableOwnerRequired),
        );
        assert_eq!(token_balance(&svm, &mutable), 0);
        assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 5);

        let destination = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &receiver.pubkey());
        let delegate = Keypair::new();
        svm.airdrop(&delegate.pubkey(), 10_000_000).unwrap();
        send(
            &mut svm,
            &[&ctx.buyer],
            &[token_ix::approve_checked(
                &TOKEN_2022,
                &ctx.buyer_share_ata,
                &ctx.mint_pda,
                &delegate.pubkey(),
                &buyer,
                &[],
                5,
                0,
            )
            .unwrap()],
            "authorize ordinary delegate",
        );
        // A compliant delegate works with the owner's BlockEntry resolution.
        send(
            &mut svm,
            &[&delegate],
            &[transfer_ix(
                &ctx,
                ctx.buyer_share_ata,
                destination,
                delegate.pubkey(),
                buyer,
                receiver.pubkey(),
                gated,
            )],
            "compliant delegated transfer",
        );
        block_holder(&mut svm, &ctx, buyer);
        svm.expire_blockhash();
        let err = try_send(
            &mut svm,
            &[&delegate],
            &[transfer_ix(
                &ctx,
                ctx.buyer_share_ata,
                destination,
                delegate.pubkey(),
                buyer,
                receiver.pubkey(),
                gated,
            )],
        )
        .unwrap_err();
        assert_custom_error(&err, u32::from(transfer_hook::HookError::SenderBlocked));
        assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 4);
        assert_eq!(token_balance(&svm, &destination), 1);
    }
}

#[test]
fn blocked_revoked_holder_still_enters_burn_only_quarantine() {
    use spl_token_2022_interface::{
        extension::{
            immutable_owner::ImmutableOwner, BaseStateWithExtensions, StateWithExtensions,
        },
        state::Account,
    };
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    let holder = buy_then_revoke(&mut svm, &ctx);
    block_holder(&mut svm, &ctx, holder);
    let (vault, escrow) = open_redemption_vault(&mut svm, &ctx, 909);
    let data = svm.get_account(&escrow).unwrap().data;
    assert!(StateWithExtensions::<Account>::unpack(&data)
        .unwrap()
        .get_extension::<ImmutableOwner>()
        .is_ok());
    send(
        &mut svm,
        &[&ctx.payer],
        &[clawback_ix(
            &ctx,
            &ctx.payer.pubkey(),
            &holder,
            &ctx.buyer_share_ata,
            &vault,
            &escrow,
            0,
        )],
        "authorized permanent-delegate quarantine for blocked holder",
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 0);
    assert!(token_balance(&svm, &escrow) > 0);
}

#[test]
fn physical_good_lifetime_cap_survives_both_issuance_paths_and_custody_burns() {
    for primary_first in [false, true] {
        let (mut svm, ctx) = boot_asset_type(false, AssetType::PhysicalGood);
        warp_to(&mut svm, 1_000);
        // 2C-3: the DeliveryEscrow realize (the physical delivery) needs the
        // holder's passport in the pinned registry; the quarantine needs none.
        let realize_kyc = if primary_first {
            let owner = ctx.buyer.pubkey();
            approve_kyc(&mut svm, &ctx, &owner);
            (Some(ctx.kyc_registry_pda), Some(kyc_entry_of(&ctx, &owner)))
        } else {
            (None, None)
        };
        let (vault, escrow) = if primary_first {
            let owner = ctx.buyer.pubkey();
            send(
                &mut svm,
                &[&ctx.buyer],
                &[buy_ix(&ctx, 1, open_hook_metas(&ctx, &owner))],
                "issue physical unit through sale",
            );
            let (vault, escrow) = open_vault(&mut svm, &ctx, 994, VaultType::DeliveryEscrow, owner);
            let mut metas = acc::DepositToCustodyVault {
                depositor: owner,
                share_class: ctx.share_class_pda,
                custody_vault: vault,
                mint: ctx.mint_pda,
                escrow,
                depositor_share_account: ctx.buyer_share_ata,
                token_program: TOKEN_2022,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None);
            metas.extend(open_hook_metas(&ctx, &owner));
            send(
                &mut svm,
                &[&ctx.buyer],
                &[Instruction::new_with_bytes(
                    ctx.program_id,
                    &ixd::DepositToCustodyVault { amount: 1 }.data(),
                    metas,
                )],
                "holder deposits physical unit for delivery",
            );
            (vault, escrow)
        } else {
            let (vault, escrow) = open_redemption_vault(&mut svm, &ctx, 994);
            send(
                &mut svm,
                &[&ctx.payer],
                &[mint_to_escrow_ix(&ctx, &escrow, &vault, 1)],
                "issue physical unit through treasury",
            );
            (vault, escrow)
        };
        send(
            &mut svm,
            &[&ctx.payer],
            &[
                Instruction::new_with_bytes(
                    ctx.program_id,
                    &ixd::TriggerCustodyVault {}.data(),
                    acc::TriggerCustodyVault {
                        authority_admin_record: Pubkey::find_program_address(
                            &[asset_registry::ADMIN_SEED, ctx.payer.pubkey().as_ref()],
                            &asset_registry::ID,
                        )
                        .0,
                        authority: ctx.payer.pubkey(),
                        custody_vault: vault,
                    }
                    .to_account_metas(None),
                ),
                Instruction::new_with_bytes(
                    ctx.program_id,
                    &ixd::RealizeCustodyVault {}.data(),
                    acc::RealizeCustodyVault {
                        authority_admin_record: Pubkey::find_program_address(
                            &[asset_registry::ADMIN_SEED, ctx.payer.pubkey().as_ref()],
                            &asset_registry::ID,
                        )
                        .0,
                        authority: ctx.payer.pubkey(),
                        share_class: ctx.share_class_pda,
                        custody_vault: vault,
                        mint: ctx.mint_pda,
                        escrow,
                        escrow_marker: escrow_marker_of(&ctx, &vault),
                        token_program: TOKEN_2022,
                        kyc_registry: realize_kyc.0,
                        kyc_entry: realize_kyc.1,
                    }
                    .to_account_metas(None),
                ),
            ],
            "consume physical unit and record custody realization",
        );
        let state: asset_registry::ShareClass = load(&svm, &ctx.share_class_pda);
        assert!(state.cumulative_cap);
        assert_eq!(state.lifetime_minted, 1);
        assert_eq!(state.circulating_supply, 0);
        assert!(
            !state.supply_locked,
            "lifetime cap must work without a manual lock"
        );
        let treasury = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &ctx.payer.pubkey());
        let ix = Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::MintToTreasury { amount: 1 }.data(),
            acc::MintToTreasury {
                authority: ctx.payer.pubkey(),
                admin_record: ctx.admin_pda,
                issuer: ctx.issuer_pda,
                asset: ctx.asset_pda,
                share_class: ctx.share_class_pda,
                mint: ctx.mint_pda,
                destination: treasury,
                token_program: TOKEN_2022,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        );
        assert_custom_error(
            &try_send(&mut svm, &[&ctx.payer], &[ix]).unwrap_err(),
            u32::from(asset_registry::error::RegistryError::MaxSupplyExceeded),
        );
        let payment_before = token_balance(&svm, &ctx.buyer_payment_ata);
        svm.expire_blockhash();
        assert_custom_error(
            &try_send(
                &mut svm,
                &[&ctx.buyer],
                &[buy_ix(&ctx, 1, open_hook_metas(&ctx, &ctx.buyer.pubkey()))],
            )
            .unwrap_err(),
            u32::from(asset_registry::error::RegistryError::MaxSupplyExceeded),
        );
        assert_eq!(token_balance(&svm, &ctx.buyer_payment_ata), payment_before);
        assert_eq!(token_balance(&svm, &treasury), 0);
    }
}

#[test]
fn legacy_share_class_version_cannot_silently_start_new_lifetime_accounting() {
    use anchor_lang::AccountSerialize;
    let (mut svm, ctx) = boot(false);
    warp_to(&mut svm, 1_000);
    // Old Option padding can be long enough to decode appended zero fields.
    // Explicit version checking must still reject it before either mint CPI.
    let mut state: asset_registry::ShareClass = load(&svm, &ctx.share_class_pda);
    state.version = 1;
    let mut account = svm.get_account(&ctx.share_class_pda).unwrap();
    state
        .try_serialize(&mut account.data.as_mut_slice())
        .unwrap();
    svm.set_account(ctx.share_class_pda, account).unwrap();
    let buyer = ctx.buyer.pubkey();
    assert_custom_error(
        &try_send(
            &mut svm,
            &[&ctx.buyer],
            &[buy_ix(&ctx, 1, open_hook_metas(&ctx, &buyer))],
        )
        .unwrap_err(),
        u32::from(asset_registry::error::RegistryError::AccountMigrationRequired),
    );
    let treasury = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &ctx.payer.pubkey());
    let ix = Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::MintToTreasury { amount: 1 }.data(),
        acc::MintToTreasury {
            authority: ctx.payer.pubkey(),
            admin_record: ctx.admin_pda,
            issuer: ctx.issuer_pda,
            asset: ctx.asset_pda,
            share_class: ctx.share_class_pda,
            mint: ctx.mint_pda,
            destination: treasury,
            token_program: TOKEN_2022,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
    );
    assert_custom_error(
        &try_send(&mut svm, &[&ctx.payer], &[ix]).unwrap_err(),
        u32::from(asset_registry::error::RegistryError::AccountMigrationRequired),
    );
}

// Authority lifecycle regression helpers. All transactions run only in LiteSVM.
fn platform_address() -> Pubkey {
    Pubkey::find_program_address(&[asset_registry::PLATFORM_SEED], &asset_registry::ID).0
}
fn admin_address(authority: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, authority.as_ref()],
        &asset_registry::ID,
    )
    .0
}
fn authority_transfer_address(target: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::AUTHORITY_TRANSFER_SEED, target.as_ref()],
        &asset_registry::ID,
    )
    .0
}
fn propose_platform_ix(authority: Pubkey, new_admin: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::ProposePlatformAdmin { new_admin }.data(),
        acc::ProposePlatformAdmin {
            authority,
            platform: platform_address(),
            transfer: authority_transfer_address(platform_address()),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}
fn accept_platform_ix(current: Pubkey, new_admin: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::AcceptPlatformAdmin {}.data(),
        acc::AcceptPlatformAdmin {
            new_admin,
            platform: platform_address(),
            transfer: authority_transfer_address(platform_address()),
            old_admin_record: admin_address(current),
            new_admin_record: admin_address(new_admin),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}
fn rotate_platform(svm: &mut LiteSVM, ctx: &Ctx, next: &Keypair) {
    svm.airdrop(&next.pubkey(), 100_000_000_000).unwrap();
    send(
        svm,
        &[&ctx.payer],
        &[propose_platform_ix(ctx.payer.pubkey(), next.pubkey())],
        "propose application admin",
    );
    send(
        svm,
        &[next],
        &[accept_platform_ix(ctx.payer.pubkey(), next.pubkey())],
        "accept application admin",
    );
}
fn add_admin_ix(super_admin: Pubkey, new_admin: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::AddAdmin { new_admin }.data(),
        acc::AddAdmin {
            super_admin,
            platform: platform_address(),
            admin_record: admin_address(new_admin),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}
fn permission_address(issuer: Pubkey, authority: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            asset_registry::ISSUER_PERMISSIONS_SEED,
            issuer.as_ref(),
            authority.as_ref(),
        ],
        &asset_registry::ID,
    )
    .0
}
fn set_permissions_ix(super_admin: Pubkey, ctx: &Ctx, capabilities: u8) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::SetIssuerPermissions { capabilities }.data(),
        acc::SetIssuerPermissions {
            super_admin,
            platform: platform_address(),
            issuer: ctx.issuer_pda,
            permissions: permission_address(ctx.issuer_pda, ctx.payer.pubkey()),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}
fn treasury_ix(ctx: &Ctx, destination: Pubkey, proof: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::MintToTreasury { amount: 1 }.data(),
        acc::MintToTreasury {
            authority: ctx.payer.pubkey(),
            admin_record: proof,
            issuer: ctx.issuer_pda,
            asset: ctx.asset_pda,
            share_class: ctx.share_class_pda,
            mint: ctx.mint_pda,
            destination,
            token_program: TOKEN_2022,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
    )
}
fn verify_issuer_ix(admin: Pubkey, issuer: Pubkey, approved: bool) -> Instruction {
    Instruction::new_with_bytes(
        asset_registry::ID,
        &ixd::VerifyIssuerKyb { approved }.data(),
        acc::VerifyIssuerKyb {
            admin,
            platform: platform_address(),
            issuer,
        }
        .to_account_metas(None),
    )
}

#[test]
fn application_admin_rotation_requires_acceptance_revokes_old_role_and_preserves_upgrade_authority()
{
    let (mut svm, ctx) = boot(false);
    let proposed = Keypair::new();
    let final_admin = Keypair::new();
    for key in [&proposed, &final_admin] {
        svm.airdrop(&key.pubkey(), 100_000_000_000).unwrap();
    }
    let program_data = support::program_data(&ctx.program_id);
    let deployment_before = svm.get_account(&program_data).unwrap().data;
    let self_revoke = Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::RemoveAdmin {
            admin: ctx.payer.pubkey(),
        }
        .data(),
        acc::RemoveAdmin {
            super_admin: ctx.payer.pubkey(),
            platform: platform_address(),
            admin_record: ctx.admin_pda,
        }
        .to_account_metas(None),
    );
    assert!(try_send(&mut svm, &[&ctx.payer], &[self_revoke])
        .unwrap_err()
        .contains("CannotRevokePlatformAdmin"));
    assert!(try_send(
        &mut svm,
        &[&proposed],
        &[propose_platform_ix(proposed.pubkey(), final_admin.pubkey())]
    )
    .unwrap_err()
    .contains("Unauthorized"));
    send(
        &mut svm,
        &[&ctx.payer],
        &[propose_platform_ix(ctx.payer.pubkey(), proposed.pubkey())],
        "first proposal",
    );
    assert!(try_send(
        &mut svm,
        &[&final_admin],
        &[accept_platform_ix(ctx.payer.pubkey(), final_admin.pubkey())]
    )
    .unwrap_err()
    .contains("InvalidAuthorityTransfer"));
    send(
        &mut svm,
        &[&ctx.payer],
        &[propose_platform_ix(
            ctx.payer.pubkey(),
            final_admin.pubkey(),
        )],
        "replace proposal",
    );
    assert!(try_send(
        &mut svm,
        &[&proposed],
        &[accept_platform_ix(ctx.payer.pubkey(), proposed.pubkey())]
    )
    .unwrap_err()
    .contains("InvalidAuthorityTransfer"));
    send(
        &mut svm,
        &[&final_admin],
        &[accept_platform_ix(ctx.payer.pubkey(), final_admin.pubkey())],
        "accept final proposal",
    );
    assert_eq!(
        load::<asset_registry::Platform>(&svm, &platform_address()).admin,
        final_admin.pubkey()
    );
    assert!(svm
        .get_account(&ctx.admin_pda)
        .is_none_or(|a| a.lamports == 0 && a.data.is_empty()));
    assert_eq!(
        load::<asset_registry::Admin>(&svm, &admin_address(final_admin.pubkey())).admin,
        final_admin.pubkey()
    );
    assert!(svm
        .get_account(&authority_transfer_address(platform_address()))
        .is_none_or(|a| a.data.is_empty()));
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[add_admin_ix(ctx.payer.pubkey(), proposed.pubkey())]
    )
    .unwrap_err()
    .contains("Unauthorized"));
    send(
        &mut svm,
        &[&final_admin],
        &[add_admin_ix(final_admin.pubkey(), proposed.pubkey())],
        "new admin manages roles",
    );
    assert_eq!(
        svm.get_account(&program_data).unwrap().data,
        deployment_before,
        "operational rotation cannot rotate the deployment key"
    );
}

#[test]
fn issuer_scoped_permissions_are_capability_bound_revocable_and_not_global_admin() {
    let (mut svm, ctx) = boot(false);
    let new_root = Keypair::new();
    rotate_platform(&mut svm, &ctx, &new_root);
    let destination = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &ctx.payer.pubkey());
    let proof = permission_address(ctx.issuer_pda, ctx.payer.pubkey());
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[treasury_ix(&ctx, destination, proof)]
    )
    .unwrap_err()
    .contains("Unauthorized"));
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[set_permissions_ix(ctx.payer.pubkey(), &ctx, 1)]
    )
    .unwrap_err()
    .contains("Unauthorized"));
    assert!(try_send(
        &mut svm,
        &[&new_root],
        &[set_permissions_ix(new_root.pubkey(), &ctx, 128)]
    )
    .unwrap_err()
    .contains("InvalidIssuerPermissions"));
    send(
        &mut svm,
        &[&new_root],
        &[set_permissions_ix(
            new_root.pubkey(),
            &ctx,
            asset_registry::ISSUER_PERMISSION_MINT,
        )],
        "grant issuer mint only",
    );
    // MINT alone no longer reaches the issuer treasury: freshly minted,
    // freely transferable units need an Admin issuer key (or an approved sale).
    let err = try_send(
        &mut svm,
        &[&ctx.payer],
        &[treasury_ix(&ctx, destination, proof)],
    )
    .unwrap_err();
    assert_custom_error(&err, 6128);
    assert!(err.contains("TreasuryMintRequiresAdmin"), "{err}");
    assert_eq!(token_balance(&svm, &destination), 0);
    // MINT still funds an admin-created burn-only escrow: here a
    // RedemptionQueue vault opened by the (rotated) platform admin.
    let (escrow, custody) = open_admin_burn_only_vault(&mut svm, &ctx, &new_root, 77);
    send(
        &mut svm,
        &[&ctx.payer],
        &[scoped_mint_to_escrow_ix(&ctx, proof, &escrow, &custody, 1)],
        "scoped issuer funds a burn-only custody escrow",
    );
    assert_eq!(token_balance(&svm, &escrow), 1);
    assert!(svm
        .get_account(&ctx.admin_pda)
        .is_none_or(|a| a.data.is_empty()));
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[treasury_ix(
            &ctx,
            destination,
            admin_address(new_root.pubkey())
        )]
    )
    .unwrap_err()
    .contains("Unauthorized"));
    let metadata = Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::UpdateMintMetadata {
            field: "uri".into(),
            value: "https://example.test/reviewed-metadata.json".into(),
        }
        .data(),
        acc::UpdateMintMetadata {
            authority: ctx.payer.pubkey(),
            admin_record: proof,
            issuer: ctx.issuer_pda,
            asset: ctx.asset_pda,
            share_class: ctx.share_class_pda,
            mint: ctx.mint_pda,
            token_program: TOKEN_2022,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(
        try_send(&mut svm, &[&ctx.payer], std::slice::from_ref(&metadata))
            .unwrap_err()
            .contains("Unauthorized")
    );
    send(
        &mut svm,
        &[&new_root],
        &[set_permissions_ix(
            new_root.pubkey(),
            &ctx,
            asset_registry::ISSUER_PERMISSIONS_ALL,
        )],
        "grant approved issuer capabilities",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[metadata],
        "scoped metadata update",
    );
    let conversion = Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::SetConvertibleTo {}.data(),
        acc::SetConvertibleTo {
            authority: ctx.payer.pubkey(),
            admin_record: proof,
            issuer: ctx.issuer_pda,
            asset: ctx.asset_pda,
            share_class: ctx.share_class_pda,
            target_share_class: None,
        }
        .to_account_metas(None),
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[conversion],
        "scoped conversion clearing",
    );
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[add_admin_ix(ctx.payer.pubkey(), ctx.buyer.pubkey())]
    )
    .unwrap_err()
    .contains("Unauthorized"));
    send(
        &mut svm,
        &[&new_root],
        &[set_permissions_ix(new_root.pubkey(), &ctx, 0)],
        "revoke issuer capabilities",
    );
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[treasury_ix(&ctx, destination, proof)]
    )
    .unwrap_err()
    .contains("Unauthorized"));
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[scoped_mint_to_escrow_ix(&ctx, proof, &escrow, &custody, 1)]
    )
    .unwrap_err()
    .contains("Unauthorized"));
    assert_eq!(token_balance(&svm, &destination), 0);
    assert_eq!(token_balance(&svm, &escrow), 1);
}

/// Opens a burn-only `RedemptionQueue` custody vault signed by `admin` (an
/// Admin record holder other than the issuer). Returns `(escrow, custody)`.
fn open_admin_burn_only_vault(
    svm: &mut LiteSVM,
    ctx: &Ctx,
    admin: &Keypair,
    vault_id: u64,
) -> (Pubkey, Pubkey) {
    let custody = Pubkey::find_program_address(
        &[
            asset_registry::CUSTODY_SEED,
            ctx.share_class_pda.as_ref(),
            &vault_id.to_le_bytes(),
        ],
        &ctx.program_id,
    )
    .0;
    let escrow = Pubkey::find_program_address(
        &[asset_registry::ESCROW_SEED, custody.as_ref()],
        &ctx.program_id,
    )
    .0;
    let ix = Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::OpenCustodyVault {
            vault_id,
            vault_type: VaultType::RedemptionQueue,
            realize_action: RealizeAction::BurnAndAttest,
            amount: 0,
            deadline: 0,
            metadata_hash: [7u8; 32],
            beneficiary: Pubkey::default(),
        }
        .data(),
        acc::OpenCustodyVault {
            authority: admin.pubkey(),
            admin_record: admin_address(admin.pubkey()),
            share_class: ctx.share_class_pda,
            mint: ctx.mint_pda,
            custody_vault: custody,
            escrow,
            escrow_marker: escrow_marker_of(ctx, &custody),
            token_program: TOKEN_2022,
            system_program: system_program::ID,
            platform: pause::platform_pda(),
            kyc_registry: None,
        }
        .to_account_metas(None),
    );
    send(svm, &[admin], &[ix], "open burn-only vault (admin)");
    (escrow, custody)
}

/// `mint_to_treasury` into a custody escrow, proving the signer's authority
/// with `proof` (an Admin record or IssuerPermissions PDA).
fn scoped_mint_to_escrow_ix(
    ctx: &Ctx,
    proof: Pubkey,
    escrow: &Pubkey,
    parent: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut metas = acc::MintToTreasury {
        authority: ctx.payer.pubkey(),
        admin_record: proof,
        issuer: ctx.issuer_pda,
        asset: ctx.asset_pda,
        share_class: ctx.share_class_pda,
        mint: ctx.mint_pda,
        destination: *escrow,
        token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    metas.push(AccountMeta::new_readonly(*parent, false));
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::MintToTreasury { amount }.data(),
        metas,
    )
}

#[test]
fn kyb_revocation_stops_existing_sale_and_treasury_issuance_preserving_holder_transfers() {
    let (mut svm, ctx) = boot(false);
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(&ctx, 2, open_hook_metas(&ctx, &ctx.buyer.pubkey()))],
        "buy before KYB revocation",
    );
    let treasury = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &ctx.payer.pubkey());
    let before_payment = token_balance(&svm, &ctx.buyer_payment_ata);
    send(
        &mut svm,
        &[&ctx.payer],
        &[verify_issuer_ix(ctx.payer.pubkey(), ctx.issuer_pda, false)],
        "revoke issuer KYB",
    );
    assert!(try_send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(&ctx, 1, open_hook_metas(&ctx, &ctx.buyer.pubkey()))]
    )
    .unwrap_err()
    .contains("IssuerNotVerified"));
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[treasury_ix(&ctx, treasury, ctx.admin_pda)]
    )
    .unwrap_err()
    .contains("IssuerNotVerified"));
    assert_eq!(token_balance(&svm, &ctx.buyer_payment_ata), before_payment);
    assert_eq!(
        load::<asset_registry::ShareClass>(&svm, &ctx.share_class_pda).circulating_supply,
        2
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[transfer_ix(
            &ctx,
            ctx.buyer_share_ata,
            treasury,
            ctx.buyer.pubkey(),
            ctx.buyer.pubkey(),
            ctx.payer.pubkey(),
            false,
        )],
        "holder property still transfers after issuer KYB revocation",
    );
    assert_eq!(token_balance(&svm, &treasury), 1);
    // Revocation itself remains available after KYB is lost; new grants do not.
    send(
        &mut svm,
        &[&ctx.payer],
        &[set_permissions_ix(ctx.payer.pubkey(), &ctx, 0)],
        "clear permissions for revoked issuer",
    );
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[set_permissions_ix(ctx.payer.pubkey(), &ctx, 1)]
    )
    .unwrap_err()
    .contains("IssuerNotVerified"));
}

#[test]
fn issuer_registration_recovery_requires_both_signers_and_never_reassigns_verified_or_used_issuers()
{
    let (mut svm, ctx) = boot(false);
    let replacement = Keypair::new();
    svm.airdrop(&replacement.pubkey(), 100_000_000_000).unwrap();
    let legal_entity_id = [74u8; 32];
    let issuer = Pubkey::find_program_address(
        &[asset_registry::ISSUER_SEED, &legal_entity_id],
        &ctx.program_id,
    )
    .0;
    send(
        &mut svm,
        &[&ctx.buyer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::RegisterIssuer {
                legal_entity_id,
                jurisdiction: 2,
                kyb_doc_hash: [1; 32],
            }
            .data(),
            acc::RegisterIssuer {
                authority: ctx.buyer.pubkey(),
                platform: platform_address(),
                issuer,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "register unused pending issuer",
    );
    let before_count = load::<asset_registry::Platform>(&svm, &platform_address()).issuers_count;
    let recover = |super_admin, target| {
        Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::RecoverIssuerRegistration {
                jurisdiction: 222,
                kyb_doc_hash: [8; 32],
            }
            .data(),
            acc::RecoverIssuerRegistration {
                super_admin,
                platform: platform_address(),
                issuer: target,
                new_authority: replacement.pubkey(),
            }
            .to_account_metas(None),
        )
    };
    assert!(try_send(
        &mut svm,
        &[&ctx.buyer, &replacement],
        &[recover(ctx.buyer.pubkey(), issuer)]
    )
    .unwrap_err()
    .contains("Unauthorized"));
    // Remove the account signer flag to exercise the on-chain Signer constraint.
    let mut missing_signature = recover(ctx.payer.pubkey(), issuer);
    missing_signature.accounts[3].is_signer = false;
    assert!(try_send(&mut svm, &[&ctx.payer], &[missing_signature])
        .unwrap_err()
        .contains("AccountNotSigner"));
    send(
        &mut svm,
        &[&ctx.payer, &replacement],
        &[recover(ctx.payer.pubkey(), issuer)],
        "recover unused registration with recipient consent",
    );
    let state: asset_registry::Issuer = load(&svm, &issuer);
    assert_eq!(state.authority, replacement.pubkey());
    assert_eq!(state.legal_entity_id, legal_entity_id);
    assert_eq!(state.kyb_status, asset_registry::KybStatus::Pending);
    assert_eq!(state.assets_count, 0);
    assert_eq!(state.kyb_doc_hash, [8; 32]);
    assert_eq!(
        load::<asset_registry::Platform>(&svm, &platform_address()).issuers_count,
        before_count
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[verify_issuer_ix(ctx.payer.pubkey(), issuer, true)],
        "verify recovered registration",
    );
    assert!(try_send(
        &mut svm,
        &[&ctx.payer, &replacement],
        &[recover(ctx.payer.pubkey(), issuer)]
    )
    .unwrap_err()
    .contains("IssuerRegistrationNotRecoverable"));
    send(
        &mut svm,
        &[&ctx.payer],
        &[verify_issuer_ix(ctx.payer.pubkey(), ctx.issuer_pda, false)],
        "reject existing used issuer",
    );
    assert!(try_send(
        &mut svm,
        &[&ctx.payer, &replacement],
        &[recover(ctx.payer.pubkey(), ctx.issuer_pda)]
    )
    .unwrap_err()
    .contains("IssuerRegistrationNotRecoverable"));
    assert_eq!(
        load::<asset_registry::Issuer>(&svm, &ctx.issuer_pda).authority,
        ctx.payer.pubkey()
    );
}

#[test]
fn revoked_custody_operator_can_be_rotated_without_blocking_deadline_refund() {
    let (mut svm, ctx) = boot(false);
    warp_to(&mut svm, 1_000);
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(&ctx, 2, open_hook_metas(&ctx, &ctx.buyer.pubkey()))],
        "acquire deposited property",
    );
    let (delivery, delivery_escrow) = open_vault_with_deadline(
        &mut svm,
        &ctx,
        998,
        VaultType::DeliveryEscrow,
        RealizeAction::BurnAndAttest,
        ctx.buyer.pubkey(),
        2_000,
    );
    let mut deposit_metas = acc::DepositToCustodyVault {
        depositor: ctx.buyer.pubkey(),
        share_class: ctx.share_class_pda,
        custody_vault: delivery,
        mint: ctx.mint_pda,
        escrow: delivery_escrow,
        depositor_share_account: ctx.buyer_share_ata,
        token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    deposit_metas.extend(open_hook_metas(&ctx, &ctx.buyer.pubkey()));
    send(
        &mut svm,
        &[&ctx.buyer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::DepositToCustodyVault { amount: 2 }.data(),
            deposit_metas,
        )],
        "deposit own tokens",
    );
    let (redemption, redemption_escrow) = open_redemption_vault(&mut svm, &ctx, 999);
    send(
        &mut svm,
        &[&ctx.payer],
        &[mint_to_escrow_ix(&ctx, &redemption_escrow, &redemption, 1)],
        "fund burn-only vault",
    );
    let new_root = Keypair::new();
    rotate_platform(&mut svm, &ctx, &new_root);
    let trigger = |authority| {
        Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::TriggerCustodyVault {}.data(),
            acc::TriggerCustodyVault {
                authority,
                custody_vault: redemption,
                authority_admin_record: admin_address(authority),
            }
            .to_account_metas(None),
        )
    };
    assert!(
        try_send(&mut svm, &[&ctx.payer], &[trigger(ctx.payer.pubkey())]).is_err(),
        "revoked operator cannot trigger"
    );
    let return_ix = |signer| {
        let mut metas = acc::ReturnCustodyVault {
            signer,
            share_class: ctx.share_class_pda,
            custody_vault: delivery,
            mint: ctx.mint_pda,
            escrow: delivery_escrow,
            beneficiary_token_account: ctx.buyer_share_ata,
            escrow_marker: escrow_marker_of(&ctx, &delivery),
            token_program: TOKEN_2022,
            authority_admin_record: ctx.admin_pda,
        }
        .to_account_metas(None);
        metas.extend(open_hook_metas(&ctx, &delivery));
        Instruction::new_with_bytes(ctx.program_id, &ixd::ReturnCustodyVault {}.data(), metas)
    };
    assert!(
        try_send(&mut svm, &[&ctx.payer], &[return_ix(ctx.payer.pubkey())])
            .unwrap_err()
            .contains("ReturnNotAllowed")
    );
    send(
        &mut svm,
        &[&new_root],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::ProposeCustodyAuthority {
                new_authority: new_root.pubkey(),
            }
            .data(),
            acc::ProposeCustodyAuthority {
                super_admin: new_root.pubkey(),
                platform: platform_address(),
                custody_vault: redemption,
                new_admin_record: admin_address(new_root.pubkey()),
                transfer: authority_transfer_address(redemption),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "recover revoked custody role",
    );
    let wrong_recipient = Keypair::new();
    svm.airdrop(&wrong_recipient.pubkey(), 100_000_000_000)
        .unwrap();
    send(
        &mut svm,
        &[&new_root],
        &[add_admin_ix(new_root.pubkey(), wrong_recipient.pubkey())],
        "another real operator",
    );
    let accept = |new_authority| {
        Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::AcceptCustodyAuthority {}.data(),
            acc::AcceptCustodyAuthority {
                new_authority,
                platform: platform_address(),
                custody_vault: redemption,
                new_admin_record: admin_address(new_authority),
                transfer: authority_transfer_address(redemption),
            }
            .to_account_metas(None),
        )
    };
    assert!(try_send(
        &mut svm,
        &[&wrong_recipient],
        &[accept(wrong_recipient.pubkey())]
    )
    .unwrap_err()
    .contains("InvalidAuthorityTransfer"));
    send(
        &mut svm,
        &[&new_root],
        &[accept(new_root.pubkey()), trigger(new_root.pubkey())],
        "accepted new custody operator triggers",
    );
    send(
        &mut svm,
        &[&new_root],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::RealizeCustodyVault {}.data(),
            acc::RealizeCustodyVault {
                authority: new_root.pubkey(),
                share_class: ctx.share_class_pda,
                custody_vault: redemption,
                mint: ctx.mint_pda,
                escrow: redemption_escrow,
                escrow_marker: escrow_marker_of(&ctx, &redemption),
                token_program: TOKEN_2022,
                authority_admin_record: admin_address(new_root.pubkey()),
                kyc_registry: None,
                kyc_entry: None,
            }
            .to_account_metas(None),
        )],
        "new operator realizes burn-only vault",
    );
    warp_to(&mut svm, 2_000);
    send(
        &mut svm,
        &[&ctx.buyer],
        &[return_ix(ctx.buyer.pubkey())],
        "beneficiary deadline refund with revoked role PDA absent",
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 2);
    assert_eq!(
        load::<asset_registry::CustodyVault>(&svm, &delivery).beneficiary,
        ctx.buyer.pubkey()
    );
}

#[test]
fn empty_asset_cannot_activate_and_scoped_issuer_initializes_mint_without_global_approval_power() {
    let (mut svm, ctx) = boot(false);
    let asset_id = "authority-reviewed";
    let asset = Pubkey::find_program_address(
        &[
            asset_registry::ASSET_SEED,
            ctx.issuer_pda.as_ref(),
            asset_id.as_bytes(),
        ],
        &ctx.program_id,
    )
    .0;
    let share_class = Pubkey::find_program_address(
        &[asset_registry::SHARE_CLASS_SEED, asset.as_ref(), &[0]],
        &ctx.program_id,
    )
    .0;
    let mint = Pubkey::find_program_address(
        &[asset_registry::SHARE_MINT_SEED, share_class.as_ref()],
        &ctx.program_id,
    )
    .0;
    let hook_config = Pubkey::find_program_address(
        &[transfer_hook::HOOK_CONFIG_SEED, mint.as_ref()],
        &ctx.hook_id,
    )
    .0;
    let extra_account_meta_list = Pubkey::find_program_address(
        &[transfer_hook::EXTRA_METAS_SEED, mint.as_ref()],
        &ctx.hook_id,
    )
    .0;
    send(
        &mut svm,
        &[&ctx.payer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::CreateAsset {
                asset_id: asset_id.into(),
                asset_type: AssetType::Equity,
                name: "Reviewed asset".into(),
                symbol_prefix: "REV".into(),
                legal_doc_hash: [4; 32],
                jurisdiction_rules: JurisdictionRules {
                    allowed_countries: [0; 128],
                    max_holders: 0,
                    restricted_period_end: 0,
                    allow_p2p: true,
                },
            }
            .data(),
            acc::CreateAsset {
                authority: ctx.payer.pubkey(),
                platform: platform_address(),
                issuer: ctx.issuer_pda,
                asset,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        "create empty draft",
    );
    let activate = |authority, admin_record| {
        Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::ActivateAsset {}.data(),
            acc::ActivateAsset {
                authority,
                admin_record,
                issuer: ctx.issuer_pda,
                asset,
            }
            .to_account_metas(None),
        )
    };
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[activate(ctx.payer.pubkey(), ctx.admin_pda)]
    )
    .unwrap_err()
    .contains("AssetHasNoShareClasses"));
    let add_class = Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::AddShareClass {
            class_index: 0,
            class_type: ShareClassType::Common,
            rights_bitfield: RIGHT_VOTE,
            liq_pref_multiplier_bps: 10_000,
            liq_seniority: 0,
            voting_weight: 1,
            max_supply: None,
            mintable_post_launch: false,
        }
        .data(),
        acc::AddShareClass {
            authority: ctx.payer.pubkey(),
            platform: platform_address(),
            issuer: ctx.issuer_pda,
            asset,
            share_class,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[verify_issuer_ix(ctx.payer.pubkey(), ctx.issuer_pda, false)],
        "temporarily revoke KYB",
    );
    assert!(
        try_send(&mut svm, &[&ctx.payer], std::slice::from_ref(&add_class))
            .unwrap_err()
            .contains("IssuerNotVerified")
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[
            verify_issuer_ix(ctx.payer.pubkey(), ctx.issuer_pda, true),
            add_class,
        ],
        "review issuer and add class",
    );
    let new_root = Keypair::new();
    rotate_platform(&mut svm, &ctx, &new_root);
    let proof = permission_address(ctx.issuer_pda, ctx.payer.pubkey());
    send(
        &mut svm,
        &[&new_root],
        &[set_permissions_ix(
            new_root.pubkey(),
            &ctx,
            asset_registry::ISSUER_PERMISSION_MINT,
        )],
        "scoped mint grant",
    );
    let init_mint = Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::InitializeShareClassMint {}.data(),
        acc::InitializeShareClassMint {
            authority: ctx.payer.pubkey(),
            admin_record: proof,
            issuer: ctx.issuer_pda,
            asset,
            share_class,
            mint,
            hook_config,
            extra_account_meta_list,
            transfer_hook_program: ctx.hook_id,
            token_program: TOKEN_2022,
            system_program: system_program::ID,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None),
    );
    send(
        &mut svm,
        &[&new_root],
        &[verify_issuer_ix(new_root.pubkey(), ctx.issuer_pda, false)],
        "revoke before mint initialization",
    );
    assert!(
        try_send(&mut svm, &[&ctx.payer], std::slice::from_ref(&init_mint))
            .unwrap_err()
            .contains("IssuerNotVerified")
    );
    assert!(try_send(
        &mut svm,
        &[&new_root],
        &[activate(
            new_root.pubkey(),
            admin_address(new_root.pubkey())
        )]
    )
    .unwrap_err()
    .contains("IssuerNotVerified"));
    send(
        &mut svm,
        &[&new_root],
        &[verify_issuer_ix(new_root.pubkey(), ctx.issuer_pda, true)],
        "restore after KYB review",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[init_mint],
        "initialize mint using scoped issuer grant",
    );
    assert!(
        try_send(
            &mut svm,
            &[&ctx.payer],
            &[activate(ctx.payer.pubkey(), proof)]
        )
        .is_err(),
        "issuer capability cannot approve asset activation"
    );
    send(
        &mut svm,
        &[&new_root],
        &[activate(
            new_root.pubkey(),
            admin_address(new_root.pubkey()),
        )],
        "independent platform activation",
    );
    assert_eq!(
        load::<asset_registry::Asset>(&svm, &asset).status,
        asset_registry::AssetStatus::Active
    );
    assert!(load::<asset_registry::ShareClass>(&svm, &share_class).mint_initialized);
}

fn share_vesting(
    svm: &mut LiteSVM,
    ctx: &Ctx,
    id: u64,
    delivery: asset_registry::VestingDeliveryMode,
    recipient: Pubkey,
) -> (Pubkey, Pubkey, Pubkey) {
    let series = Pubkey::find_program_address(
        &[
            asset_registry::VESTING_SERIES_SEED,
            ctx.payer.pubkey().as_ref(),
            &id.to_le_bytes(),
        ],
        &ctx.program_id,
    )
    .0;
    let escrow = Pubkey::find_program_address(
        &[asset_registry::VESTING_ESCROW_SEED, series.as_ref()],
        &ctx.program_id,
    )
    .0;
    let position = Pubkey::find_program_address(
        &[
            asset_registry::VESTING_POSITION_SEED,
            series.as_ref(),
            &0u32.to_le_bytes(),
        ],
        &ctx.program_id,
    )
    .0;
    send(
        svm,
        &[&ctx.payer],
        &[
            Instruction::new_with_bytes(
                ctx.program_id,
                &ixd::CreateVestingSeries {
                    series_id: id,
                    tranches: vec![asset_registry::VestingTranche {
                        unlock_ts: 1_000,
                        amount: 4,
                    }],
                    timing_mode: asset_registry::VestingTimingMode::Auto,
                    delivery_mode: delivery,
                    approval_window_secs: 0,
                    recovery_enabled: false,
                    cancellation_enabled: true,
                    pre_cliff_bps: 0,
                }
                .data(),
                acc::CreateVestingSeries {
                    authority: ctx.payer.pubkey(),
                    token_mint: ctx.mint_pda,
                    series,
                    escrow,
                    token_program: TOKEN_2022,
                    system_program: system_program::ID,
                    identity: escrow_marker_of(ctx, &series),
                }
                .to_account_metas(None),
            ),
            Instruction::new_with_bytes(
                ctx.program_id,
                &ixd::AddVestingPosition {
                    wallet: recipient,
                    allocation: 4,
                }
                .data(),
                acc::AddVestingPosition {
                    authority: ctx.payer.pubkey(),
                    series,
                    position,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
            ),
            Instruction::new_with_bytes(
                ctx.program_id,
                &ixd::FinalizeVestingSeries {}.data(),
                acc::FinalizeVestingSeries {
                    authority: ctx.payer.pubkey(),
                    series,
                }
                .to_account_metas(None),
            ),
        ],
        "finalized hooked vesting with identity",
    );
    (series, escrow, position)
}
fn share_vesting_deposit(
    ctx: &Ctx,
    series: Pubkey,
    escrow: Pubkey,
    depositor: Pubkey,
    source: Pubkey,
    amount: u64,
) -> Instruction {
    let mut metas = acc::DepositToVestingEscrow {
        depositor,
        series,
        token_mint: ctx.mint_pda,
        escrow,
        depositor_token_account: source,
        token_program: TOKEN_2022,
        identity: escrow_marker_of(ctx, &series),
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    metas.extend(kyc_hook_metas(ctx, &depositor, &depositor, &series));
    Instruction::new_with_bytes(
        ctx.program_id,
        &ixd::DepositToVestingEscrow { amount }.data(),
        metas,
    )
}
fn share_vesting_withdraw(
    ctx: &Ctx,
    series: Pubkey,
    escrow: Pubkey,
    destination: Pubkey,
) -> Instruction {
    let mut metas = acc::WithdrawUnvested {
        authority: ctx.payer.pubkey(),
        series,
        token_mint: ctx.mint_pda,
        escrow,
        authority_token_account: destination,
        token_program: TOKEN_2022,
        identity: escrow_marker_of(ctx, &series),
    }
    .to_account_metas(None);
    metas.extend(kyc_hook_metas(ctx, &series, &series, &ctx.payer.pubkey()));
    Instruction::new_with_bytes(ctx.program_id, &ixd::WithdrawUnvested {}.data(), metas)
}

#[test]
fn hooked_vesting_deposits_without_pda_kyc_and_screens_both_delivery_modes() {
    for delivery in [
        asset_registry::VestingDeliveryMode::Claim,
        asset_registry::VestingDeliveryMode::Push,
    ] {
        let (mut svm, ctx) = boot(true);
        let treasury = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &ctx.payer.pubkey());
        send(
            &mut svm,
            &[&ctx.payer],
            &[treasury_ix(&ctx, treasury, ctx.admin_pda)],
            "fund first owned unit",
        );
        for _ in 0..3 {
            send(
                &mut svm,
                &[&ctx.payer],
                &[treasury_ix(&ctx, treasury, ctx.admin_pda)],
                "fund owned unit",
            );
        }
        let (series, escrow, position) =
            share_vesting(&mut svm, &ctx, 2001, delivery, ctx.buyer.pubkey());
        send(
            &mut svm,
            &[&ctx.payer],
            &[share_vesting_deposit(
                &ctx,
                series,
                escrow,
                ctx.payer.pubkey(),
                treasury,
                4,
            )],
            "fund series with no KYC entry for PDA",
        );
        assert!(svm.get_account(&kyc_entry_of(&ctx, &series)).is_none());
        warp_to(&mut svm, 1_000);
        let mut metas = if delivery == asset_registry::VestingDeliveryMode::Claim {
            acc::ClaimVested {
                recipient: ctx.buyer.pubkey(),
                series,
                position,
                token_mint: ctx.mint_pda,
                escrow,
                recipient_token_account: ctx.buyer_share_ata,
                token_program: TOKEN_2022,
            }
            .to_account_metas(None)
        } else {
            acc::PushVested {
                payer: ctx.buyer.pubkey(),
                series,
                position,
                token_mint: ctx.mint_pda,
                escrow,
                recipient_token_account: ctx.buyer_share_ata,
                token_program: TOKEN_2022,
            }
            .to_account_metas(None)
        };
        metas.extend(kyc_hook_metas(&ctx, &series, &series, &ctx.buyer.pubkey()));
        let data = if delivery == asset_registry::VestingDeliveryMode::Claim {
            ixd::ClaimVested { position_index: 0 }.data()
        } else {
            ixd::PushVested { position_index: 0 }.data()
        };
        let release = Instruction::new_with_bytes(ctx.program_id, &data, metas);
        assert!(
            try_send(&mut svm, &[&ctx.buyer], std::slice::from_ref(&release))
                .unwrap_err()
                .contains("ReceiverNotApproved")
        );
        assert_eq!(token_balance(&svm, &escrow), 4);
        approve_kyc(&mut svm, &ctx, &ctx.buyer.pubkey());
        send(
            &mut svm,
            &[&ctx.buyer],
            &[release],
            "screened final recipient receives vested property",
        );
        assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 4);
    }
}

#[test]
fn vesting_refund_exempts_only_recorded_own_deposit_and_never_reuses_allowance_for_donations() {
    let (mut svm, ctx) = boot(true);
    let treasury = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &ctx.payer.pubkey());
    for _ in 0..3 {
        send(
            &mut svm,
            &[&ctx.payer],
            &[treasury_ix(&ctx, treasury, ctx.admin_pda)],
            "own units",
        );
    }
    approve_kyc(&mut svm, &ctx, &ctx.buyer.pubkey());
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            3,
            kyc_hook_metas(
                &ctx,
                &ctx.buyer.pubkey(),
                &ctx.buyer.pubkey(),
                &ctx.buyer.pubkey(),
            ),
        )],
        "third-party units",
    );
    let (series, escrow, _) = share_vesting(
        &mut svm,
        &ctx,
        2002,
        asset_registry::VestingDeliveryMode::Claim,
        ctx.buyer.pubkey(),
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[share_vesting_deposit(
            &ctx,
            series,
            escrow,
            ctx.payer.pubkey(),
            treasury,
            3,
        )],
        "own ledger deposit",
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[
            share_vesting_deposit(
                &ctx,
                series,
                escrow,
                ctx.buyer.pubkey(),
                ctx.buyer_share_ata,
                1,
            ),
            transfer_ix(
                &ctx,
                ctx.buyer_share_ata,
                escrow,
                ctx.buyer.pubkey(),
                ctx.buyer.pubkey(),
                series,
                true,
            ),
        ],
        "gift plus raw surplus",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[
            Instruction::new_with_bytes(
                ctx.program_id,
                &ixd::CancelVestingSeries {}.data(),
                acc::CancelVestingSeries {
                    authority: ctx.payer.pubkey(),
                    series,
                }
                .to_account_metas(None),
            ),
            share_vesting_withdraw(&ctx, series, escrow, treasury),
        ],
        "return only client's own property without current passport",
    );
    assert_eq!(token_balance(&svm, &treasury), 3);
    assert_eq!(token_balance(&svm, &escrow), 2);
    let identity: asset_registry::EscrowIdentity = load(&svm, &escrow_marker_of(&ctx, &series));
    assert_eq!((identity.own_deposited, identity.own_refunded), (3, 3));
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[share_vesting_withdraw(&ctx, series, escrow, treasury)]
    )
    .unwrap_err()
    .contains("VestingNothingToWithdraw"));
    approve_kyc(&mut svm, &ctx, &ctx.payer.pubkey());
    send(
        &mut svm,
        &[&ctx.payer],
        &[share_vesting_withdraw(&ctx, series, escrow, treasury)],
        "eligible client receives donated surplus",
    );
    revoke_kyc(&mut svm, &ctx, &ctx.payer.pubkey());
    send(
        &mut svm,
        &[&ctx.buyer],
        &[transfer_ix(
            &ctx,
            ctx.buyer_share_ata,
            escrow,
            ctx.buyer.pubkey(),
            ctx.buyer.pubkey(),
            series,
            true,
        )],
        "post-withdraw gift",
    );
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[share_vesting_withdraw(&ctx, series, escrow, treasury)]
    )
    .is_err());
    assert_eq!(token_balance(&svm, &escrow), 1);
}

#[test]
fn rights_and_vesting_identity_prevents_holder_clawback_and_legacy_attach_preserves_zero_history() {
    let (mut svm, ctx) = boot(true);
    let (rights, rights_escrow, _) =
        setup_rights_issuance(&mut svm, &ctx, 2003, 1, &ctx.buyer.pubkey(), 1);
    let (series, vesting_escrow, _) = share_vesting(
        &mut svm,
        &ctx,
        2003,
        asset_registry::VestingDeliveryMode::Claim,
        ctx.buyer.pubkey(),
    );
    let (vault, quarantine) = open_redemption_vault(&mut svm, &ctx, 2003);
    for (parent, escrow) in [(rights, rights_escrow), (series, vesting_escrow)] {
        approve_kyc(&mut svm, &ctx, &parent);
        revoke_kyc(&mut svm, &ctx, &parent);
        assert!(try_send(
            &mut svm,
            &[&ctx.payer],
            &[clawback_ix(
                &ctx,
                &ctx.payer.pubkey(),
                &parent,
                &escrow,
                &vault,
                &quarantine,
                1
            )]
        )
        .unwrap_err()
        .contains("ClawbackTargetIsEscrow"));
    }
    // Stand in for an original pre-identity deployment, retaining real parent
    // data; attach proves the typed parent but does not guess historical owners.
    for (parent, is_vesting) in [(rights, false), (series, true)] {
        let identity = escrow_marker_of(&ctx, &parent);
        let mut empty = svm.get_account(&identity).unwrap();
        empty.data.clear();
        empty.owner = system_program::ID;
        empty.lamports = 0;
        svm.set_account(identity, empty).unwrap();
        let parent_before = svm.get_account(&parent).unwrap().data;
        let instruction = if is_vesting {
            Instruction::new_with_bytes(
                ctx.program_id,
                &ixd::RegisterVestingEscrowIdentity {}.data(),
                acc::RegisterVestingEscrowIdentity {
                    payer: ctx.buyer.pubkey(),
                    series: parent,
                    identity,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
            )
        } else {
            Instruction::new_with_bytes(
                ctx.program_id,
                &ixd::RegisterRightsEscrowIdentity {}.data(),
                acc::RegisterRightsEscrowIdentity {
                    payer: ctx.buyer.pubkey(),
                    rights_issuance: parent,
                    identity,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
            )
        };
        send(
            &mut svm,
            &[&ctx.buyer],
            &[instruction],
            "attach typed legacy identity",
        );
        let recorded: asset_registry::EscrowIdentity = load(&svm, &identity);
        assert_eq!((recorded.own_deposited, recorded.own_refunded), (0, 0));
        assert_eq!(svm.get_account(&parent).unwrap().data, parent_before);
    }
}

#[test]
fn original_full_v1_share_class_prepares_size_only_and_keeps_custody_refund_while_mint_stays_closed(
) {
    use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator, Space};
    use asset_registry::legacy::LegacyShareClass;
    let (mut svm, ctx) = boot(false);
    let original_v2 = svm.get_account(&ctx.share_class_pda).unwrap().data;
    assert!(try_send(
        &mut svm,
        &[&ctx.buyer],
        &[prepare_legacy_ix(ctx.buyer.pubkey(), ctx.share_class_pda)]
    )
    .unwrap_err()
    .contains("AccountMigrationRequired"));
    assert_eq!(
        svm.get_account(&ctx.share_class_pda).unwrap().data,
        original_v2
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(&ctx, 2, open_hook_metas(&ctx, &ctx.buyer.pubkey()))],
        "owned units before upgrade",
    );
    let (vault, escrow) = open_vault(
        &mut svm,
        &ctx,
        2004,
        VaultType::DeliveryEscrow,
        ctx.buyer.pubkey(),
    );
    let mut deposit_metas = acc::DepositToCustodyVault {
        depositor: ctx.buyer.pubkey(),
        share_class: ctx.share_class_pda,
        custody_vault: vault,
        mint: ctx.mint_pda,
        escrow,
        depositor_share_account: ctx.buyer_share_ata,
        token_program: TOKEN_2022,
        platform: pause::platform_pda(),
    }
    .to_account_metas(None);
    deposit_metas.extend(open_hook_metas(&ctx, &ctx.buyer.pubkey()));
    send(
        &mut svm,
        &[&ctx.buyer],
        &[Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::DepositToCustodyVault { amount: 2 }.data(),
            deposit_metas,
        )],
        "legacy delivery deposit",
    );
    let mut old_account = svm.get_account(&ctx.share_class_pda).unwrap();
    let mut legacy = LegacyShareClass::deserialize(&mut &old_account.data[8..]).unwrap();
    legacy.version = 1;
    legacy.max_supply = Some(1_000);
    legacy.convertible_to = Some(Pubkey::new_unique());
    let mut original = asset_registry::ShareClass::DISCRIMINATOR.to_vec();
    legacy.serialize(&mut original).unwrap();
    assert_eq!(
        original.len(),
        8 + LegacyShareClass::INIT_SPACE,
        "both original Options consume all old allocation"
    );
    old_account.data = original.clone();
    old_account.lamports = svm.minimum_balance_for_rent_exemption(original.len());
    svm.set_account(ctx.share_class_pda, old_account).unwrap();
    let mut metas = acc::ReturnCustodyVault {
        signer: ctx.payer.pubkey(),
        share_class: ctx.share_class_pda,
        custody_vault: vault,
        mint: ctx.mint_pda,
        escrow,
        beneficiary_token_account: ctx.buyer_share_ata,
        escrow_marker: escrow_marker_of(&ctx, &vault),
        token_program: TOKEN_2022,
        authority_admin_record: ctx.admin_pda,
    }
    .to_account_metas(None);
    metas.extend(open_hook_metas(&ctx, &vault));
    let refund =
        Instruction::new_with_bytes(ctx.program_id, &ixd::ReturnCustodyVault {}.data(), metas);
    assert!(
        try_send(&mut svm, &[&ctx.payer], std::slice::from_ref(&refund))
            .unwrap_err()
            .contains("AccountDidNotDeserialize")
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[prepare_legacy_ix(ctx.buyer.pubkey(), ctx.share_class_pda)],
        "rent-only legacy preparation",
    );
    let prepared = svm.get_account(&ctx.share_class_pda).unwrap().data;
    assert_eq!(&prepared[..original.len()], original.as_slice());
    assert_eq!(prepared.len(), 8 + asset_registry::ShareClass::INIT_SPACE);
    assert!(prepared[original.len()..].iter().all(|b| *b == 0));
    assert_eq!(
        load::<asset_registry::ShareClass>(&svm, &ctx.share_class_pda).version,
        1
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[refund],
        "v1 delivery refund survives upgrade",
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 2);
    let treasury = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &ctx.payer.pubkey());
    assert!(try_send(
        &mut svm,
        &[&ctx.payer],
        &[treasury_ix(&ctx, treasury, ctx.admin_pda)]
    )
    .unwrap_err()
    .contains("AccountMigrationRequired"));
    send(
        &mut svm,
        &[&ctx.buyer],
        &[prepare_legacy_ix(ctx.buyer.pubkey(), ctx.share_class_pda)],
        "size preparation is repeatable",
    );
}

pub fn prepare_legacy_ix(payer: Pubkey, legacy_account: Pubkey) -> Instruction {
    use anchor_lang::{InstructionData, ToAccountMetas};
    Instruction::new_with_bytes(
        asset_registry::ID,
        &asset_registry::instruction::PrepareLegacyAccount {}.data(),
        asset_registry::accounts::PrepareLegacyAccount {
            payer,
            legacy_account,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    )
}

#[test]
fn v1_option_padding_is_normalized_without_changing_any_active_legacy_field() {
    use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator, Space};
    use asset_registry::legacy::LegacyShareClass;
    let (mut svm, ctx) = boot(false);
    let mut account = svm.get_account(&ctx.share_class_pda).unwrap();
    let mut legacy = LegacyShareClass::deserialize(&mut &account.data[8..]).unwrap();
    legacy.version = 1;
    legacy.convertible_to = None;
    legacy.max_supply = None;
    let mut active_prefix = asset_registry::ShareClass::DISCRIMINATOR.to_vec();
    legacy.serialize(&mut active_prefix).unwrap();
    account.data = vec![0xab; 8 + LegacyShareClass::INIT_SPACE];
    account.data[..active_prefix.len()].copy_from_slice(&active_prefix);
    svm.set_account(ctx.share_class_pda, account).unwrap();
    send(
        &mut svm,
        &[&ctx.buyer],
        &[prepare_legacy_ix(ctx.buyer.pubkey(), ctx.share_class_pda)],
        "prepare dirty old Option padding",
    );
    let prepared = svm.get_account(&ctx.share_class_pda).unwrap().data;
    assert_eq!(&prepared[..active_prefix.len()], active_prefix.as_slice());
    assert_eq!(
        &prepared[active_prefix.len()..active_prefix.len() + 9],
        &[0; 9]
    );
    let compatible: asset_registry::ShareClass = load(&svm, &ctx.share_class_pda);
    assert_eq!(compatible.version, 1);
    assert_eq!(compatible.convertible_to, None);
    assert_eq!(compatible.max_supply, None);
    assert!(asset_registry::util::next_issuance_supply(&compatible, 1).is_err());
}

#[test]
fn active_vesting_surplus_never_borrows_reserved_own_deposits_as_a_kyc_refund_allowance() {
    let (mut svm, ctx) = boot(true);
    let treasury = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &ctx.payer.pubkey());
    for _ in 0..4 {
        send(
            &mut svm,
            &[&ctx.payer],
            &[treasury_ix(&ctx, treasury, ctx.admin_pda)],
            "client's allocated units",
        );
    }
    approve_kyc(&mut svm, &ctx, &ctx.buyer.pubkey());
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            2,
            kyc_hook_metas(
                &ctx,
                &ctx.buyer.pubkey(),
                &ctx.buyer.pubkey(),
                &ctx.buyer.pubkey(),
            ),
        )],
        "donor owns extra units",
    );
    let (series, escrow, _) = share_vesting(
        &mut svm,
        &ctx,
        2104,
        asset_registry::VestingDeliveryMode::Claim,
        ctx.buyer.pubkey(),
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[share_vesting_deposit(
            &ctx,
            series,
            escrow,
            ctx.payer.pubkey(),
            treasury,
            4,
        )],
        "client fully backs recipients",
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[transfer_ix(
            &ctx,
            ctx.buyer_share_ata,
            escrow,
            ctx.buyer.pubkey(),
            ctx.buyer.pubkey(),
            series,
            true,
        )],
        "uncredited third-party surplus",
    );
    let mut withdraw = share_vesting_withdraw(&ctx, series, escrow, treasury);
    withdraw.data = ixd::WithdrawVestingSurplus {}.data();
    assert!(try_send(&mut svm, &[&ctx.payer], &[withdraw.clone()])
        .unwrap_err()
        .contains("VestingNothingToWithdraw"));
    assert_eq!(token_balance(&svm, &escrow), 5);
    assert_eq!(token_balance(&svm, &treasury), 0);
    approve_kyc(&mut svm, &ctx, &ctx.payer.pubkey());
    send(
        &mut svm,
        &[&ctx.payer],
        &[withdraw.clone()],
        "eligible authority receives only donated excess",
    );
    assert_eq!(token_balance(&svm, &escrow), 4);
    assert_eq!(token_balance(&svm, &treasury), 1);
    let identity: asset_registry::EscrowIdentity = load(&svm, &escrow_marker_of(&ctx, &series));
    assert_eq!((identity.own_deposited, identity.own_refunded), (4, 0));
    revoke_kyc(&mut svm, &ctx, &ctx.payer.pubkey());
    send(
        &mut svm,
        &[&ctx.buyer],
        &[transfer_ix(
            &ctx,
            ctx.buyer_share_ata,
            escrow,
            ctx.buyer.pubkey(),
            ctx.buyer.pubkey(),
            series,
            true,
        )],
        "second uncredited gift",
    );
    assert!(try_send(&mut svm, &[&ctx.payer], &[withdraw])
        .unwrap_err()
        .contains("VestingNothingToWithdraw"));
    assert_eq!(token_balance(&svm, &escrow), 5);
}

// ── FINDING B — custody realize-action gate ──────────────────────────────────

/// `realize_custody_vault` implements only `BurnAndAttest`; once a vault with
/// any other action is triggered no exit remains (`revert` needs Active,
/// `return` is DeliveryEscrow-only). `open_custody_vault` must therefore refuse
/// to store an action it cannot execute. UnsupportedRealizeAction (6016).
#[test]
fn open_custody_vault_rejects_unsupported_realize_action() {
    let (mut svm, ctx) = boot(false);
    warp_to(&mut svm, 1_000);
    let beneficiary = Pubkey::new_unique();
    let cases = [
        (VaultType::Vesting, RealizeAction::TransferToBeneficiary),
        (VaultType::Vesting, RealizeAction::BurnAndPayout),
        (
            VaultType::DeliveryEscrow,
            RealizeAction::TransferToBeneficiary,
        ),
        (VaultType::RedemptionQueue, RealizeAction::BurnAndPayout),
    ];
    for (i, (vault_type, action)) in cases.into_iter().enumerate() {
        let err = try_open_vault_with_action(
            &mut svm,
            &ctx,
            900 + i as u64,
            vault_type,
            action,
            beneficiary,
        )
        .expect_err("unsupported realize action must not open");
        assert_custom_error(&err, 6016);
    }
    // The supported action still opens for every vault type.
    open_vault(&mut svm, &ctx, 910, VaultType::Vesting, Pubkey::default());
    open_vault(&mut svm, &ctx, 911, VaultType::DeliveryEscrow, beneficiary);
    open_vault(
        &mut svm,
        &ctx,
        912,
        VaultType::RedemptionQueue,
        Pubkey::default(),
    );
    open_vault(
        &mut svm,
        &ctx,
        913,
        VaultType::ConversionPending,
        Pubkey::default(),
    );
}

/// Mirror of the `mint_to_treasury` funding gate on the holder-deposit side:
/// a vault whose realize action cannot be executed (an account written before
/// the open gate) must not accept deposits — they would be stranded after
/// trigger. Flipping the action back to `BurnAndAttest` is the only change
/// needed for the same deposit to succeed, proving the gate is the action.
#[test]
fn deposit_rejects_vault_with_unsupported_realize_action() {
    let (mut svm, ctx) = boot(false);
    warp_to(&mut svm, 1_000);
    let owner = ctx.buyer.pubkey();
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(&ctx, 2, open_hook_metas(&ctx, &owner))],
        "buyer acquires units to deposit",
    );
    let (vault, escrow) = open_vault(&mut svm, &ctx, 920, VaultType::Vesting, Pubkey::default());

    let deposit_ix = |ctx: &Ctx, amount: u64| {
        let mut metas = acc::DepositToCustodyVault {
            depositor: owner,
            share_class: ctx.share_class_pda,
            custody_vault: vault,
            mint: ctx.mint_pda,
            escrow,
            depositor_share_account: ctx.buyer_share_ata,
            token_program: TOKEN_2022,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None);
        metas.extend(open_hook_metas(ctx, &owner));
        Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::DepositToCustodyVault { amount }.data(),
            metas,
        )
    };

    for action in [
        RealizeAction::TransferToBeneficiary,
        RealizeAction::BurnAndPayout,
    ] {
        set_realize_action(&mut svm, &vault, action);
        let err = try_send(&mut svm, &[&ctx.buyer], &[deposit_ix(&ctx, 1)])
            .expect_err("deposit into an unrealizable vault must fail");
        assert_custom_error(&err, 6016);
        assert_eq!(token_balance(&svm, &escrow), 0, "escrow untouched");
        assert_eq!(
            load::<asset_registry::CustodyVault>(&svm, &vault).deposited,
            0
        );
    }

    // Same vault, same depositor, supported action → the deposit lands.
    set_realize_action(&mut svm, &vault, RealizeAction::BurnAndAttest);
    send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_ix(&ctx, 1)],
        "deposit into BurnAndAttest vault",
    );
    assert_eq!(token_balance(&svm, &escrow), 1);
    assert_eq!(
        load::<asset_registry::CustodyVault>(&svm, &vault).deposited,
        1
    );
}

// ── Emergency pause (Platform.pause_flags) ───────────────────────────────────

fn admin_record_of(authority: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[asset_registry::ADMIN_SEED, authority.as_ref()],
        &asset_registry::ID,
    )
    .0
}

/// bit1 gates a KycGated `buy` and `mint_to_treasury` to BOTH bound
/// destinations (the issuer treasury and a burn-only custody escrow). KYC
/// administration and a wallet-to-wallet hook transfer stay open under a full
/// pause — the hook never reads the Platform.
#[test]
fn primary_pause_gates_buy_and_treasury_minting_but_not_kyc_or_transfers() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    let buyer_pk = ctx.buyer.pubkey();
    let treasury_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &ctx.payer.pubkey());

    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_FLAGS_ALL);
    // KYC approval is never gated.
    approve_kyc(&mut svm, &ctx, &buyer_pk);
    // The burn-only quarantine vault opens under a full pause (bit3 exemption).
    let (custody_pda, escrow_pda) = open_redemption_vault(&mut svm, &ctx, 7);
    let treasury_mint = |destination: Pubkey| {
        Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::MintToTreasury { amount: 5 }.data(),
            acc::MintToTreasury {
                authority: ctx.payer.pubkey(),
                admin_record: ctx.admin_pda,
                issuer: ctx.issuer_pda,
                asset: ctx.asset_pda,
                share_class: ctx.share_class_pda,
                mint: ctx.mint_pda,
                destination,
                token_program: TOKEN_2022,
                platform: pause::platform_pda(),
            }
            .to_account_metas(None),
        )
    };

    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_PRIMARY);
    pause::assert_paused(
        try_send(
            &mut svm,
            &[&ctx.buyer],
            &[buy_ix(
                &ctx,
                10,
                kyc_hook_metas(&ctx, &buyer_pk, &buyer_pk, &buyer_pk),
            )],
        ),
        "KycGated buy under PRIMARY",
    );
    pause::assert_paused(
        try_send(&mut svm, &[&ctx.payer], &[treasury_mint(treasury_ata)]),
        "mint_to_treasury (treasury) under PRIMARY",
    );
    pause::assert_paused(
        try_send(
            &mut svm,
            &[&ctx.payer],
            &[mint_to_escrow_ix(&ctx, &escrow_pda, &custody_pda, 5)],
        ),
        "mint_to_treasury (custody escrow) under PRIMARY",
    );

    // Every other bit paused: primary issuance works on both paths.
    pause::pause_only(
        &mut svm,
        &ctx.payer,
        asset_registry::PAUSE_FLAGS_ALL & !asset_registry::PAUSE_PRIMARY,
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            10,
            kyc_hook_metas(&ctx, &buyer_pk, &buyer_pk, &buyer_pk),
        )],
        "KycGated buy",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[treasury_mint(treasury_ata)],
        "mint_to_treasury (treasury)",
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[mint_to_escrow_ix(&ctx, &escrow_pda, &custody_pda, 5)],
        "mint_to_treasury (custody escrow)",
    );
    assert_eq!(token_balance(&svm, &ctx.buyer_share_ata), 10);
    assert_eq!(token_balance(&svm, &treasury_ata), 5);
    assert_eq!(token_balance(&svm, &escrow_pda), 5);

    // Full pause: a KYC'd wallet-to-wallet transfer still clears the hook.
    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_FLAGS_ALL);
    let peer = Keypair::new();
    let peer_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &peer.pubkey());
    approve_kyc(&mut svm, &ctx, &peer.pubkey());
    send(
        &mut svm,
        &[&ctx.buyer],
        &[transfer_ix(
            &ctx,
            ctx.buyer_share_ata,
            peer_ata,
            buyer_pk,
            buyer_pk,
            peer.pubkey(),
            true,
        )],
        "wallet-to-wallet transfer under 0x3F",
    );
    assert_eq!(token_balance(&svm, &peer_ata), 1);
    revoke_kyc(&mut svm, &ctx, &peer.pubkey()); // revocation is never gated
}

/// bit3 stops custody ENTRY, but the clawback quarantine path — open a
/// RedemptionQueue+BurnAndAttest vault, clawback, trigger, realize (burn) —
/// runs end to end under a full pause.
#[test]
fn custody_entry_pause_keeps_the_clawback_quarantine_path_open() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    let buyer_pk = ctx.buyer.pubkey();
    approve_kyc(&mut svm, &ctx, &buyer_pk);
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(
            &ctx,
            10,
            kyc_hook_metas(&ctx, &buyer_pk, &buyer_pk, &buyer_pk),
        )],
        "buy",
    );

    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_FLAGS_ALL);
    revoke_kyc(&mut svm, &ctx, &buyer_pk);

    // Non-quarantine opens are custody entries: paused. The exemption needs
    // BOTH halves — a RedemptionQueue with a non-burn action is an entry too.
    let entries = [
        (
            20,
            VaultType::DeliveryEscrow,
            RealizeAction::BurnAndAttest,
            buyer_pk,
        ),
        (
            21,
            VaultType::ConversionPending,
            RealizeAction::BurnAndAttest,
            Pubkey::default(),
        ),
        (
            22,
            VaultType::Vesting,
            RealizeAction::BurnAndAttest,
            Pubkey::default(),
        ),
        (
            23,
            VaultType::RedemptionQueue,
            RealizeAction::TransferToBeneficiary,
            Pubkey::default(),
        ),
        (
            24,
            VaultType::RedemptionQueue,
            RealizeAction::BurnAndPayout,
            Pubkey::default(),
        ),
    ];
    for (id, vault_type, action, beneficiary) in entries {
        pause::assert_paused(
            try_open_vault_with_action(&mut svm, &ctx, id, vault_type, action, beneficiary),
            "non-quarantine custody open under 0x3F",
        );
    }
    // …also when only bit3 is set.
    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_CUSTODY_ENTRY);
    for (id, vault_type, action, beneficiary) in entries {
        pause::assert_paused(
            try_open_vault_with_action(&mut svm, &ctx, id, vault_type, action, beneficiary),
            "non-quarantine custody open under CUSTODY_ENTRY",
        );
    }
    // The pause check runs first. With bit3 clear the non-burn RedemptionQueue
    // still fails, but on the (independent) realize-action gate: when that
    // gate reopens for TransferToBeneficiary / BurnAndPayout, the pause above
    // keeps such a vault a gated custody entry.
    pause::pause_only(
        &mut svm,
        &ctx.payer,
        asset_registry::PAUSE_FLAGS_ALL & !asset_registry::PAUSE_CUSTODY_ENTRY,
    );
    let err = try_open_vault_with_action(
        &mut svm,
        &ctx,
        23,
        VaultType::RedemptionQueue,
        RealizeAction::TransferToBeneficiary,
        Pubkey::default(),
    )
    .expect_err("non-burn RedemptionQueue");
    assert_custom_error(&err, 6016); // UnsupportedRealizeAction, not 6000

    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_FLAGS_ALL);
    let (custody_pda, escrow_pda) = open_redemption_vault(&mut svm, &ctx, 1);
    let payer_pk = ctx.payer.pubkey();
    send(
        &mut svm,
        &[&ctx.payer],
        &[clawback_ix(
            &ctx,
            &payer_pk,
            &buyer_pk,
            &ctx.buyer_share_ata,
            &custody_pda,
            &escrow_pda,
            0,
        )],
        "clawback under 0x3F",
    );
    assert_eq!(token_balance(&svm, &escrow_pda), 10);
    send(
        &mut svm,
        &[&ctx.payer],
        &[
            Instruction::new_with_bytes(
                ctx.program_id,
                &ixd::TriggerCustodyVault {}.data(),
                acc::TriggerCustodyVault {
                    authority_admin_record: admin_record_of(&payer_pk),
                    authority: payer_pk,
                    custody_vault: custody_pda,
                }
                .to_account_metas(None),
            ),
            Instruction::new_with_bytes(
                ctx.program_id,
                &ixd::RealizeCustodyVault {}.data(),
                acc::RealizeCustodyVault {
                    authority_admin_record: admin_record_of(&payer_pk),
                    authority: payer_pk,
                    share_class: ctx.share_class_pda,
                    custody_vault: custody_pda,
                    mint: ctx.mint_pda,
                    escrow: escrow_pda,
                    escrow_marker: escrow_marker_of(&ctx, &custody_pda),
                    token_program: TOKEN_2022,
                    kyc_registry: None,
                    kyc_entry: None,
                }
                .to_account_metas(None),
            ),
        ],
        "trigger + realize (burn) under 0x3F",
    );
    let state: asset_registry::ShareClass = load(&svm, &ctx.share_class_pda);
    assert_eq!(state.circulating_supply, 0, "quarantined units burned");

    // With only bit3 clear, a DeliveryEscrow opens again.
    pause::pause_only(
        &mut svm,
        &ctx.payer,
        asset_registry::PAUSE_FLAGS_ALL & !asset_registry::PAUSE_CUSTODY_ENTRY,
    );
    open_vault(&mut svm, &ctx, 20, VaultType::DeliveryEscrow, buyer_pk);
}

/// The quarantine exemption covers only OPENING the burn-only vault (clawback's
/// destination). A holder deposit into that same RedemptionQueue +
/// BurnAndAttest vault is a custody entry, gated by bit3 like any other.
#[test]
fn custody_entry_pause_gates_deposits_into_a_quarantine_vault() {
    let (mut svm, ctx) = boot(false);
    warp_to(&mut svm, 1_000);
    let owner = ctx.buyer.pubkey();
    send(
        &mut svm,
        &[&ctx.buyer],
        &[buy_ix(&ctx, 2, open_hook_metas(&ctx, &owner))],
        "buyer acquires units to deposit",
    );

    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_FLAGS_ALL);
    let (vault, escrow) = open_redemption_vault(&mut svm, &ctx, 930);
    let deposit_ix = |ctx: &Ctx| {
        let mut metas = acc::DepositToCustodyVault {
            depositor: owner,
            share_class: ctx.share_class_pda,
            custody_vault: vault,
            mint: ctx.mint_pda,
            escrow,
            depositor_share_account: ctx.buyer_share_ata,
            token_program: TOKEN_2022,
            platform: pause::platform_pda(),
        }
        .to_account_metas(None);
        metas.extend(open_hook_metas(ctx, &owner));
        Instruction::new_with_bytes(
            ctx.program_id,
            &ixd::DepositToCustodyVault { amount: 1 }.data(),
            metas,
        )
    };

    pause::assert_paused(
        try_send(&mut svm, &[&ctx.buyer], &[deposit_ix(&ctx)]),
        "quarantine-vault deposit under 0x3F",
    );
    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_CUSTODY_ENTRY);
    pause::assert_paused(
        try_send(&mut svm, &[&ctx.buyer], &[deposit_ix(&ctx)]),
        "quarantine-vault deposit under CUSTODY_ENTRY",
    );
    assert_eq!(token_balance(&svm, &escrow), 0, "escrow untouched");

    // Only bit3 clear: the same deposit lands.
    pause::pause_only(
        &mut svm,
        &ctx.payer,
        asset_registry::PAUSE_FLAGS_ALL & !asset_registry::PAUSE_CUSTODY_ENTRY,
    );
    send(
        &mut svm,
        &[&ctx.buyer],
        &[deposit_ix(&ctx)],
        "quarantine-vault deposit",
    );
    assert_eq!(token_balance(&svm, &escrow), 1);
    assert_eq!(
        load::<asset_registry::CustodyVault>(&svm, &vault).deposited,
        1
    );
}

/// bit4 gates the Rights-Token entries (`create_rights_issuance`,
/// `publish_milestone`); `claim_milestone` is an exit and stays open.
#[test]
fn distribution_pause_gates_rights_entries_but_not_milestone_claims() {
    let (mut svm, ctx) = boot(true);
    warp_to(&mut svm, 1_000);
    let claimer = Keypair::new();
    svm.airdrop(&claimer.pubkey(), 10_000_000_000).unwrap();
    let claimer_pk = claimer.pubkey();
    let (create_ix, rights_pda, rights_escrow) = create_rights_issuance_ix(&ctx, 1);
    let (publish_ix, milestone_pda) = publish_milestone_ix(&ctx, &rights_pda, &claimer_pk, 40);

    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_DISTRIBUTIONS);
    pause::assert_paused(
        try_send(&mut svm, &[&ctx.payer], std::slice::from_ref(&create_ix)),
        "create_rights_issuance under DISTRIBUTIONS",
    );
    pause::pause_only(
        &mut svm,
        &ctx.payer,
        asset_registry::PAUSE_FLAGS_ALL & !asset_registry::PAUSE_DISTRIBUTIONS,
    );
    send(
        &mut svm,
        &[&ctx.payer],
        &[create_ix],
        "create_rights_issuance",
    );

    // Funding the rights escrow is fresh emission: bit1 (PRIMARY) gates it on
    // this destination too, not only on the treasury and custody escrows.
    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_PRIMARY);
    pause::assert_paused(
        try_send(
            &mut svm,
            &[&ctx.payer],
            &[mint_to_escrow_ix(&ctx, &rights_escrow, &rights_pda, 100)],
        ),
        "mint_to_treasury (rights escrow) under PRIMARY",
    );
    assert_eq!(token_balance(&svm, &rights_escrow), 0);
    pause::unpause_all(&mut svm, &ctx.payer);
    send(
        &mut svm,
        &[&ctx.payer],
        &[mint_to_escrow_ix(&ctx, &rights_escrow, &rights_pda, 100)],
        "fund rights escrow",
    );

    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_DISTRIBUTIONS);
    pause::assert_paused(
        try_send(&mut svm, &[&ctx.payer], std::slice::from_ref(&publish_ix)),
        "publish_milestone under DISTRIBUTIONS",
    );
    pause::pause_only(
        &mut svm,
        &ctx.payer,
        asset_registry::PAUSE_FLAGS_ALL & !asset_registry::PAUSE_DISTRIBUTIONS,
    );
    send(&mut svm, &[&ctx.payer], &[publish_ix], "publish_milestone");

    pause::pause_only(&mut svm, &ctx.payer, asset_registry::PAUSE_FLAGS_ALL);
    let claimer_ata = create_ata(&mut svm, &ctx.payer, &ctx.mint_pda, &claimer_pk);
    approve_kyc(&mut svm, &ctx, &claimer_pk);
    send(
        &mut svm,
        &[&claimer],
        &[claim_milestone_ix(
            &ctx,
            &claimer_pk,
            &rights_pda,
            &rights_escrow,
            &milestone_pda,
            &claimer_ata,
            &claimer_pk,
            40,
        )],
        "claim_milestone under 0x3F",
    );
    assert_eq!(token_balance(&svm, &claimer_ata), 40);
}
