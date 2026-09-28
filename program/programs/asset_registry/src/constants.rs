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
/// `TransferHookConfig.mint` (right after the discriminator).
pub const HOOK_CONFIG_MINT_OFFSET: usize = 8;
/// `TransferHookConfig.share_class`.
pub const HOOK_CONFIG_SHARE_CLASS_OFFSET: usize = 40;

// ── transfer_hook `BlockEntry` (read by offset; mirrored, 2C-4) ──────────────
// `clawback_blocklisted_holder` requires the holder to carry a live hook
// `BlockEntry` — created ONLY by the hook's `BlocklistAuthority`, never by an
// admin of this program. Layout: disc(8) wallet(32) added_by(32) bump(1).
// Pinned against the hook crate by `block_entry_layout_matches_hook`.
/// Seed of the hook's per-wallet `BlockEntry` PDA: `["blocked", wallet]`.
pub const HOOK_BLOCK_ENTRY_SEED: &[u8] = b"blocked";
/// Anchor discriminator of `transfer_hook::BlockEntry`.
pub const HOOK_BLOCK_ENTRY_DISCRIMINATOR: [u8; 8] = [160, 179, 255, 246, 122, 148, 254, 143];
/// Full `BlockEntry` account length (`8 + INIT_SPACE`).
pub const HOOK_BLOCK_ENTRY_LEN: usize = 73;
/// `BlockEntry.wallet`.
pub const HOOK_BLOCK_ENTRY_WALLET_OFFSET: usize = 8;
/// `BlockEntry.added_by` — the BlocklistAuthority key that added the entry.
pub const HOOK_BLOCK_ENTRY_ADDED_BY_OFFSET: usize = 40;

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
/// Seed for a `SaleApproval` PDA — `["sale_approval", share_class, sale_id LE]`.
pub const SALE_APPROVAL_SEED: &[u8] = b"sale_approval";
/// Longest an admin's sale approval may stay open: 90 days.
pub const SALE_APPROVAL_MAX_TTL_SECS: i64 = 7_776_000;
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

// ── Emergency pause (`Platform.pause_flags`, byte 74) ────────────────────────
// Bits 0-6 each stop one family of platform-mediated ENTRY flows. Exits
// (cancels, expiries, refunds, claims, custody burns/returns) never read these
// bits, and the transfer hook never reads the Platform — wallet-to-wallet
// transfers stay free. Any Admin may SET bits; only the super admin
// (`Platform.admin`) may CLEAR them, and `PAUSE_PAYOUT_MODULES` only in a call
// of its own. Values 0 and 1 keep the meaning of the former `paused: bool`
// (1 = onboarding paused). Bit 7 is not a pause bit: it is the one-way
// `PLATFORM_BOOTSTRAP_OPEN` marker (see below).
/// Issuer registration, asset / share-class creation, share-class mint setup.
pub const PAUSE_ONBOARDING: u8 = 1 << 0;
/// Primary issuance: `open_sale`, `buy`, `mint_to_treasury`.
pub const PAUSE_PRIMARY: u8 = 1 << 1;
/// Program-mediated trading: offers and OTC deals (create / fund / take).
pub const PAUSE_SECONDARY: u8 = 1 << 2;
/// Entries into custody (`open_custody_vault`, `deposit_to_custody_vault`),
/// except opening a burn-only quarantine vault for clawback.
pub const PAUSE_CUSTODY_ENTRY: u8 = 1 << 3;
/// Distributions, yield routing, vesting funding and Rights-Token entries.
pub const PAUSE_DISTRIBUTIONS: u8 = 1 << 4;
/// Proceeds paid out to issuers / founders (`close_sale`, `release_payout`,
/// `claim_founder_yield`).
pub const PAUSE_ISSUER_PROCEEDS: u8 = 1 << 5;
/// The payout / Merkle modules (D2, off on mainnet): Startup raises
/// (`open_sale` with `RaiseType::Startup`, and `buy` into an already open
/// Startup sale), `route_yield`, `create_rights_issuance` and
/// `publish_milestone`. Their exits and continuations (`open_payout_vault`,
/// vault lifecycle, refunds and claims) stay open. Clearing it must be a
/// `set_pause_flags` call of its own (`PayoutModulesClearNotExplicit`).
pub const PAUSE_PAYOUT_MODULES: u8 = 1 << 6;
/// Every defined pause bit (0x7F).
pub const PAUSE_FLAGS_ALL: u8 = PAUSE_ONBOARDING
    | PAUSE_PRIMARY
    | PAUSE_SECONDARY
    | PAUSE_CUSTODY_ENTRY
    | PAUSE_DISTRIBUTIONS
    | PAUSE_ISSUER_PROCEEDS
    | PAUSE_PAYOUT_MODULES;
/// Bit 7 of `pause_flags` — NOT a pause bit and never in `PAUSE_FLAGS_ALL`.
/// Set only by `initialize_platform` (0xFF); cleared by the first
/// `set_pause_flags` with a non-zero clear mask or `set_pause(false)` (the
/// first unpause), or explicitly with `set_pause_flags(0, 0x80)`. Nothing can
/// set it again. While it is set the admin-grant and super-admin-rotation
/// timelocks are waived at execution (bootstrap); proposal expiries never are.
pub const PLATFORM_BOOTSTRAP_OPEN: u8 = 1 << 7;
/// `open_vault_vote`: a payout-vault vote runs at least 7 days (notice).
pub const MIN_VAULT_VOTING_PERIOD_SECS: i64 = 604_800;

// ── D1: issuer proceeds freeze ───────────────────────────────────────────────
/// `IssuerFreeze` PDA: `["issuer_freeze", issuer]`. While it exists every
/// proceeds exit of that issuer (and its `buy` / `open_sale`) is closed.
pub const ISSUER_FREEZE_SEED: &[u8] = b"issuer_freeze";

// ── D3: timelocked admin grants and super-admin rotation ────────────────────
/// `PendingAdmin` PDA: `["pending_admin", new_admin]`.
pub const PENDING_ADMIN_SEED: &[u8] = b"pending_admin";
/// `AuthorityProposal` PDA: `["authority_proposal", target]` (platform,
/// custody vault, issuer or KYC registry). Replaces the legacy
/// `AUTHORITY_TRANSFER_SEED` accounts, which no instruction reads any more.
pub const AUTHORITY_PROPOSAL_SEED: &[u8] = b"authority_proposal";
/// `add_admin` executes at or after `proposed_at + 48 h`.
pub const ADMIN_TIMELOCK_SECS: i64 = 172_800;
/// `accept_platform_admin` executes at or after `proposed_at + 48 h`.
pub const SUPER_ADMIN_ROTATION_TIMELOCK_SECS: i64 = 172_800;
/// Every proposal expires 14 days after its eta (eta = proposed_at when the
/// flow has no timelock).
pub const PROPOSAL_WINDOW_SECS: i64 = 1_209_600;
/// `AuthorityProposal.kind`.
pub const AUTHORITY_PROPOSAL_KIND_PLATFORM: u8 = 0;
pub const AUTHORITY_PROPOSAL_KIND_CUSTODY: u8 = 1;
pub const AUTHORITY_PROPOSAL_KIND_ISSUER: u8 = 2;
pub const AUTHORITY_PROPOSAL_KIND_KYC_REGISTRY: u8 = 3;

// ── D4: super-admin recovery by the program upgrade authority ───────────────
/// `PlatformRecovery` PDA: `["platform_recovery", platform]`.
pub const PLATFORM_RECOVERY_SEED: &[u8] = b"platform_recovery";
/// Recovery executes at or after `proposed_at + 7 days`, strictly before
/// `eta + PROPOSAL_WINDOW_SECS`. The `incident` build (never a release
/// artifact; design 8.3 §7.4) sets it to 0 for a COMPROMISED super admin.
#[cfg(not(feature = "incident"))]
pub const PLATFORM_RECOVERY_DELAY_SECS: i64 = 604_800;
#[cfg(feature = "incident")]
pub const PLATFORM_RECOVERY_DELAY_SECS: i64 = 0;

// ── Mandatory bounds (mainnet defaults) ──────────────────────────────────────
/// A primary sale ends at most 365 days after `max(start_ts, now)`.
pub const MAX_SALE_DURATION_SECS: i64 = 31_536_000;
/// `approve_holder`: a KYC entry expires at most 2 years (730 days) from now.
pub const MAX_KYC_VALIDITY_SECS: i64 = 63_072_000;
/// `clawback_from_holder` for an EXPIRED entry opens 30 days after its
/// expiry (a Revoked entry is immediate).
pub const KYC_EXPIRY_CLAWBACK_GRACE_SECS: i64 = 2_592_000;
/// `create_otc_deal`: `now < expires_at <= now + 90 days`.
pub const OTC_DEAL_MAX_TTL_SECS: i64 = 7_776_000;
/// DeliveryEscrow custody vault: `now + 24 h <= deadline <= now + 365 days`.
pub const DELIVERY_ESCROW_MIN_DEADLINE_SECS: i64 = 86_400;
pub const DELIVERY_ESCROW_MAX_DEADLINE_SECS: i64 = 31_536_000;

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
/// Sale v2 appends `sale_approval` and `application_hash` (open_sale consumes
/// an admin `SaleApproval`).
pub const SALE_STATE_VERSION: u8 = 2;
/// CustodyVault v2 appends `kyc_registry` (2C-3).
pub const CUSTODY_STATE_VERSION: u8 = 2;

/// Scoped issuer permissions and staged operational authority changes.
pub const ISSUER_PERMISSIONS_SEED: &[u8] = b"issuer_permissions";
/// LEGACY (rc.x): `AuthorityTransfer` PDAs. v1 stages every rotation at
/// `AUTHORITY_PROPOSAL_SEED`; accounts left at this seed are inert, and the
/// devnet go/no-go requires that none exist before the v1 upgrade.
pub const AUTHORITY_TRANSFER_SEED: &[u8] = b"authority_transfer";
pub const ISSUER_PERMISSION_MINT: u8 = 1;
pub const ISSUER_PERMISSION_METADATA: u8 = 2;
pub const ISSUER_PERMISSION_CONVERSION: u8 = 4;
pub const ISSUER_PERMISSIONS_ALL: u8 = 7;

/// Timelocked issuer-authority recovery (2C-2): `["issuer_recovery", issuer]`.
pub const ISSUER_RECOVERY_SEED: &[u8] = b"issuer_recovery";
/// 7 days. Recovery executes at or after `eta = proposed_at + delay`.
pub const ISSUER_RECOVERY_DELAY: i64 = 604_800;
/// 14 days after `eta`. Past it, the recovery is expired and must be re-proposed.
pub const ISSUER_RECOVERY_EXECUTION_WINDOW: i64 = 1_209_600;

pub const DISTRIBUTION_PLAN_SEED: &[u8] = b"distribution_plan";
pub const DISTRIBUTION_BATCH_SEED: &[u8] = b"distribution_batch";
pub const DISTRIBUTION_STATE_VERSION: u8 = 2;
pub const MAX_DISTRIBUTION_BATCH_SIZE: usize = 16;

// ── Rent reclaim (2D) ────────────────────────────────────────────────────────
/// Tombstone written by `reclaim_rent` over a retired Offer / OtcDeal /
/// CustodyVault: the parent shrinks to these 8 bytes, keeps exactly the rent
/// minimum for them and stays owned by this program, so its PDA can never be
/// re-initialised (Anchor `init` on a funded account takes the transfer +
/// `allocate` path, and `allocate` refuses a non-system owner). Deliberately
/// NOT an `#[account]` type: it must never decode as one. Pinned against every
/// account discriminator by a test; mirrored by `front/lib/closed-account.ts`.
pub const CLOSED_ACCOUNT_TAG: [u8; 8] = *b"CLOSED__";
/// `RentReclaimed.kind`: an Offer (escrow closed, Offer tombstoned).
pub const RECLAIM_OFFER: u8 = 0;
/// `RentReclaimed.kind`: an OtcDeal (both escrows closed, deal tombstoned).
pub const RECLAIM_OTC: u8 = 1;
/// `RentReclaimed.kind`: a CustodyVault (escrow closed, vault tombstoned).
pub const RECLAIM_CUSTODY: u8 = 2;
/// `RentReclaimed.kind`: a KycEntry (fully closed; the PDA is reusable).
pub const RECLAIM_KYC: u8 = 3;
