//! Compile-time constants: PDA seeds, share-class rights bitfield, bounds.

use anchor_lang::prelude::Pubkey;

/// The Mancipatio `transfer_hook` program ID — hardcoded so a share-class mint
/// can only ever be wired to the real hook (not a caller-supplied program).
pub const TRANSFER_HOOK_PROGRAM: Pubkey =
    Pubkey::from_str_const("GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy");

// ── transfer_hook PDA seeds (mirrored — no crate dependency on the hook) ─────
/// Seed of the hook's per-mint `TransferHookConfig` PDA.
pub const HOOK_CONFIG_SEED: &[u8] = b"hook_cfg";
/// Seed of the hook's per-mint `ExtraAccountMetaList` PDA (SPL interface).
pub const HOOK_EXTRA_METAS_SEED: &[u8] = b"extra-account-metas";
/// Seed of the hook's singleton `BlocklistAuthority` PDA.
pub const HOOK_BLOCKLIST_AUTHORITY_SEED: &[u8] = b"blocklist_authority";

// ── transfer_hook `TransferHookConfig` byte layout (read by offset; mirrored) ─
// The permissionless offer-take path (`take_offer`), the primary-sale path
// (`buy` — a `mint_to`, which never runs the hook) and `clawback_from_holder`
// re-derive the receiver's / holder's KYC on-chain rather than trusting the
// hook (whose escrow-marker exemption deliberately skips it for
// platform-mediated legs). To do that they read the mint's hook config
// without a crate dependency on the hook. Layout:
//   disc(8) mint(32) share_class(32) blocklist(32) restriction_mode(1)
//   kyc_registry(Option<Pubkey> = tag(1) + pubkey(32)) version(1) bump(1).
/// `TransferHookConfig.restriction_mode` — `u8` (0 = Open, 1 = KycGated).
pub const HOOK_CONFIG_RESTRICTION_MODE_OFFSET: usize = 104;
/// `TransferHookConfig.kyc_registry` Option tag — `u8` (0 = None, 1 = Some).
pub const HOOK_CONFIG_KYC_REGISTRY_TAG_OFFSET: usize = 105;
/// `TransferHookConfig.kyc_registry` pubkey (present iff the tag == 1).
pub const HOOK_CONFIG_KYC_REGISTRY_KEY_OFFSET: usize = 106;
/// Minimum `TransferHookConfig` data length (through the `kyc_registry` pubkey).
pub const HOOK_CONFIG_MIN_LEN: usize = 138;
/// `RestrictionMode::KycGated` borsh discriminant.
pub const RESTRICTION_MODE_KYC_GATED: u8 = 1;

// ── PDA seeds (docs/01-asset-registry-design.md §8) ──────────────────────────
pub const PLATFORM_SEED: &[u8] = b"platform";
pub const ISSUER_SEED: &[u8] = b"issuer";
pub const ASSET_SEED: &[u8] = b"asset";
pub const SHARE_CLASS_SEED: &[u8] = b"share_class";
pub const KYC_REGISTRY_SEED: &[u8] = b"kyc_registry";
pub const KYC_SEED: &[u8] = b"kyc";
/// Seed for the Token-2022 mint PDA of a share class.
pub const SHARE_MINT_SEED: &[u8] = b"share_mint";
/// Seed for a `CustodyVault` PDA.
pub const CUSTODY_SEED: &[u8] = b"custody";
/// Seed for a custody vault's escrow token account PDA.
pub const ESCROW_SEED: &[u8] = b"escrow";
/// Seed for a primary `Sale` PDA.
pub const SALE_SEED: &[u8] = b"sale";
/// Seed for a sale's proceeds escrow token account PDA.
pub const PROCEEDS_SEED: &[u8] = b"proceeds";
/// Seed for an OTC `Offer` PDA.
pub const OFFER_SEED: &[u8] = b"offer";
/// Seed for a bilateral `OtcDeal` PDA.
pub const OTC_DEAL_SEED: &[u8] = b"otc_deal";
/// Seed for an OTC deal's share-unit escrow token account PDA.
pub const OTC_ASSET_ESCROW_SEED: &[u8] = b"otc_asset_escrow";
/// Seed for an OTC deal's payment escrow token account PDA.
pub const OTC_PAYMENT_ESCROW_SEED: &[u8] = b"otc_payment_escrow";
/// Seed for an `EscrowMarker` PDA — `["escrow_marker", owner_pda]` where
/// `owner_pda` is the deal / offer / custody-vault / distribution PDA that
/// owns an escrow token account. Mirrored by the `transfer_hook` program.
pub const ESCROW_MARKER_SEED: &[u8] = b"escrow_marker";
/// Seed for a revenue `Distribution` PDA.
pub const DISTRIBUTION_SEED: &[u8] = b"distribution";
/// Seed for a distribution's payment escrow token account PDA.
pub const DISTRIBUTION_ESCROW_SEED: &[u8] = b"distribution_escrow";
/// Seed for an `Admin` record PDA.
pub const ADMIN_SEED: &[u8] = b"admin";
/// Seed for a governance `Proposal` PDA.
pub const PROPOSAL_SEED: &[u8] = b"proposal";
/// Seed for a `VoteRecord` PDA.
pub const VOTE_SEED: &[u8] = b"vote";
/// Seed for a Rights-Token `RightsIssuance` PDA.
pub const RIGHTS_SEED: &[u8] = b"rights";
/// Seed for a `VestingMilestone` PDA.
pub const RT_MILESTONE_SEED: &[u8] = b"rt_milestone";
/// Seed for a `MilestoneClaim` PDA.
pub const RT_CLAIM_SEED: &[u8] = b"rt_claim";
/// Seed for a `PayoutVault` PDA (proceeds disbursement).
pub const PAYOUT_SEED: &[u8] = b"payout";
/// Seed for a payout vault's payment-token escrow token account PDA.
pub const PAYOUT_ESCROW_SEED: &[u8] = b"payout_escrow";
/// Seed for a `VaultVote` PDA.
pub const VAULT_VOTE_SEED: &[u8] = b"vaultvote";
/// Seed for a `VaultVoteRecord` PDA.
pub const VAULT_VOTE_RECORD_SEED: &[u8] = b"vvrec";
/// Seed for a payout vault `ClaimRecord` PDA (refund / investor-yield claims).
pub const PAYOUT_CLAIM_SEED: &[u8] = b"pv_claim";
/// 30 days in seconds — one vesting period.
pub const MONTH: i64 = 2_592_000;
/// Consecutive missed update periods that trigger a freeze.
pub const MISSED_FREEZE_THRESHOLD: u8 = 3;

// ── Share-class rights bitfield (docs/01 §3) ─────────────────────────────────
pub const RIGHT_VOTE: u8 = 1 << 0;
pub const RIGHT_DIVIDEND: u8 = 1 << 1;
pub const RIGHT_LIQ_PREF: u8 = 1 << 2;
pub const RIGHT_CONVERTIBLE: u8 = 1 << 3;
pub const RIGHT_REDEEMABLE: u8 = 1 << 4;
pub const RIGHT_TRANSFERABLE: u8 = 1 << 5;
/// Every defined right OR-ed together; any bit outside this mask is rejected.
pub const RIGHTS_MASK: u8 = RIGHT_VOTE
    | RIGHT_DIVIDEND
    | RIGHT_LIQ_PREF
    | RIGHT_CONVERTIBLE
    | RIGHT_REDEEMABLE
    | RIGHT_TRANSFERABLE;

// ── Bounds ───────────────────────────────────────────────────────────────────
pub const MAX_ASSET_ID_LEN: usize = 32;
pub const MAX_ASSET_NAME_LEN: usize = 64;
pub const MAX_SYMBOL_PREFIX_LEN: usize = 10;
pub const MAX_SHARE_CLASSES: u8 = 32;
/// Protocol fee hard ceiling — 10%.
pub const MAX_FEE_BPS: u16 = 1_000;
/// Liquidation preference floor — 1.0x (preferred can never be worse than common).
pub const MIN_LIQ_PREF_BPS: u16 = 10_000;
/// Schema version stamped on every account, for future `migrate_*` instructions.
pub const STATE_VERSION: u8 = 1;

// ── Vesting series (spec: "11. Vesting — Mancipatio") ───────────────────────
/// Seed for a `VestingSeries` PDA — `["vesting_series", authority, series_id]`.
pub const VESTING_SERIES_SEED: &[u8] = b"vesting_series";
/// Seed for a `VestingPosition` PDA — `["vesting_position", series, index]`.
pub const VESTING_POSITION_SEED: &[u8] = b"vesting_position";
/// Seed for a series's escrow token account PDA.
pub const VESTING_ESCROW_SEED: &[u8] = b"vesting_escrow";
/// Max tranches per series schedule (bitmask-approved ⇒ hard cap 64).
pub const MAX_VESTING_TRANCHES: usize = 64;
/// Approval-window bounds (seconds) — 1 hour .. 90 days.
pub const MIN_APPROVAL_WINDOW_SECS: i64 = 3_600;
pub const MAX_APPROVAL_WINDOW_SECS: i64 = 7_776_000;

/// Explicit schema versions for accounts whose lifecycle/layout changed.
pub const SHARE_CLASS_STATE_VERSION: u8 = 2;
pub const PAYOUT_STATE_VERSION: u8 = 2;
pub const VESTING_STATE_VERSION: u8 = 2;

/// Scoped issuer permissions and staged operational authority changes.
pub const ISSUER_PERMISSIONS_SEED: &[u8] = b"issuer_permissions";
pub const AUTHORITY_TRANSFER_SEED: &[u8] = b"authority_transfer";
pub const ISSUER_PERMISSION_MINT: u8 = 1;
pub const ISSUER_PERMISSION_METADATA: u8 = 2;
pub const ISSUER_PERMISSION_CONVERSION: u8 = 4;
pub const ISSUER_PERMISSIONS_ALL: u8 = 7;

pub const DISTRIBUTION_PLAN_SEED: &[u8] = b"distribution_plan";
pub const DISTRIBUTION_BATCH_SEED: &[u8] = b"distribution_batch";
pub const DISTRIBUTION_STATE_VERSION: u8 = 2;
pub const MAX_DISTRIBUTION_BATCH_SIZE: usize = 16;
