/**
 * The e2e matrix (Talas 6.3, design-6.3 §A): every step the runner may take
 * (one step = one transaction, so a resumed run never repeats half a step),
 * with the networks it runs on and the outcome it must have. Pure: the tool
 * and the offline tests read the same list, and the plan digest that
 * CHAIN_CONFIRM_PLAN confirms is computed over it.
 *
 * Expected failures name the program and the code. Codes come from the
 * generated SDK constants, so a renumbering fails the offline test instead
 * of silently expecting a stale number.
 */
import {
  ASSET_REGISTRY_ERROR__CANNOT_REVOKE_PLATFORM_ADMIN,
  ASSET_REGISTRY_ERROR__CLAWBACK_HOLDER_NOT_BLOCKED,
  ASSET_REGISTRY_ERROR__CLAWBACK_HOLDER_STILL_ELIGIBLE,
  ASSET_REGISTRY_ERROR__CLAWBACK_NOT_KYC_GATED,
  ASSET_REGISTRY_ERROR__DEAL_EXPIRY_OUT_OF_RANGE,
  ASSET_REGISTRY_ERROR__DELIVERY_DEADLINE_OUT_OF_RANGE,
  ASSET_REGISTRY_ERROR__DEPOSITOR_NOT_BENEFICIARY,
  ASSET_REGISTRY_ERROR__INVALID_MERKLE_PROOF,
  ASSET_REGISTRY_ERROR__INVALID_PROPOSED_AUTHORITY,
  ASSET_REGISTRY_ERROR__INVALID_PROTOCOL_TREASURY,
  ASSET_REGISTRY_ERROR__ISSUER_PROCEEDS_FROZEN,
  ASSET_REGISTRY_ERROR__ISSUER_RECOVERY_TIMELOCK_ACTIVE,
  ASSET_REGISTRY_ERROR__MILESTONE_LOCKED,
  ASSET_REGISTRY_ERROR__OFFER_EXPIRED,
  ASSET_REGISTRY_ERROR__PARTY_BLOCKLISTED,
  ASSET_REGISTRY_ERROR__PAUSE_CLEAR_NOT_ALLOWED,
  ASSET_REGISTRY_ERROR__PAYOUT_MODULES_CLEAR_NOT_EXPLICIT,
  ASSET_REGISTRY_ERROR__PLATFORM_PAUSED,
  ASSET_REGISTRY_ERROR__PLATFORM_RECOVERY_PENDING,
  ASSET_REGISTRY_ERROR__PROPOSAL_NOT_ENDED,
  ASSET_REGISTRY_ERROR__RECEIVER_NOT_APPROVED,
  ASSET_REGISTRY_ERROR__RETURN_NOT_ALLOWED,
  ASSET_REGISTRY_ERROR__SALE_APPROVAL_EXPIRED,
  ASSET_REGISTRY_ERROR__SALE_DURATION_INVALID,
  ASSET_REGISTRY_ERROR__SALE_EXCEEDS_APPROVED_RAISE,
  ASSET_REGISTRY_ERROR__SALE_NOT_STARTED,
  ASSET_REGISTRY_ERROR__SALE_PRICE_OUTSIDE_APPROVAL,
  ASSET_REGISTRY_ERROR__SALE_SOLD_OUT,
  ASSET_REGISTRY_ERROR__TIMELOCK_ACTIVE,
  ASSET_REGISTRY_ERROR__TREASURY_MINT_REQUIRES_ADMIN,
  ASSET_REGISTRY_ERROR__UNAUTHORIZED,
  ASSET_REGISTRY_ERROR__UPDATE_REQUIRED,
  ASSET_REGISTRY_ERROR__VAULT_TYPE_RETIRED,
  ASSET_REGISTRY_ERROR__VESTING_NOTHING_TO_CLAIM,
  ASSET_REGISTRY_ERROR__VOTING_PERIOD_TOO_SHORT,
  ASSET_REGISTRY_ERROR__WRONG_DEAL_PARTY,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_ERROR__RECOVERY_PENDING,
  TRANSFER_HOOK_ERROR__SENDER_BLOCKED,
  TRANSFER_HOOK_ERROR__UNAUTHORIZED,
} from "@/lib/generated/transfer_hook";
import { canonicalJson, sha256Hex } from "../safety";

export type E2eNetwork = "devnet" | "localnet";

/** Anchor's AccountNotInitialized: a required PDA (an Admin record, a closed marker) is missing. */
export const ANCHOR_ACCOUNT_NOT_INITIALIZED = 3012;
export type ProgramLabel = "asset_registry" | "transfer_hook";


export type Expect =
  | { ok: true }
  | { ok: false; program: ProgramLabel; code: number; name: string };

export type StepSpec = {
  id: string;
  group: number;
  title: string;
  networks: readonly E2eNetwork[];
  /** Role name of the fee payer (keys.ts / tool roles). */
  signer: string;
  expect: Expect;
};

const BOTH: readonly E2eNetwork[] = ["devnet", "localnet"];
const LOCAL: readonly E2eNetwork[] = ["localnet"];
const DEVNET: readonly E2eNetwork[] = ["devnet"];
const ok = { ok: true } as const;
const fails = (code: number, name: string, program: ProgramLabel = "asset_registry"): Expect => ({
  ok: false,
  program,
  code,
  name,
});

export const E2E_STEPS: readonly StepSpec[] = [
  // G0 (localnet): the reviewed bootstrap plan (scripts/chain/lib/bootstrap-plan) with
  // separated roles; 0.2 runs its cycles until no step remains.
  { id: "0.1", group: 0, title: "fund the bootstrap roles (SA, BA, KYC authority)", networks: LOCAL, signer: "funder", expect: ok },
  { id: "0.2", group: 0, title: "bootstrap plan S1–S6 + X1–X3 until no step remains", networks: LOCAL, signer: "funder", expect: ok },

  // G1: issuer → KYB → asset → classes → mints → approval → sale → buy without KYC.
  { id: "1.0", group: 1, title: "fund the e2e roles", networks: BOTH, signer: "funder", expect: ok },
  { id: "1.1a", group: 1, title: "payment mint (classic SPL, 6 dp)", networks: BOTH, signer: "funder", expect: ok },
  { id: "1.1b", group: 1, title: "payment balances for B1 and B2", networks: BOTH, signer: "funder", expect: ok },
  { id: "1.1c", group: 1, title: "payment balances for B3, B4 and the issuer", networks: BOTH, signer: "funder", expect: ok },
  { id: "1.2", group: 1, title: "register_issuer (e2e legal id)", networks: BOTH, signer: "issuer", expect: ok },
  { id: "1.3", group: 1, title: "verify_issuer_kyb(true) — devnet: Super Admin in the browser (C1)", networks: BOTH, signer: "superAdmin", expect: ok },
  { id: "1.4a", group: 1, title: "create_asset", networks: BOTH, signer: "issuer", expect: ok },
  { id: "1.4b", group: 1, title: "add_share_class A (index 0, Common)", networks: BOTH, signer: "issuer", expect: ok },
  { id: "1.4c", group: 1, title: "add_share_class B (index 1, PreferredA)", networks: BOTH, signer: "issuer", expect: ok },
  { id: "1.5", group: 1, title: "set_issuer_permissions(issuer, MINT|METADATA|CONVERSION)", networks: LOCAL, signer: "superAdmin", expect: ok },
  { id: "1.6a", group: 1, title: "initialize_share_class_mint A", networks: BOTH, signer: "issuer", expect: ok },
  { id: "1.6b", group: 1, title: "initialize_share_class_mint B", networks: BOTH, signer: "issuer", expect: ok },
  { id: "1.7", group: 1, title: "activate_asset", networks: BOTH, signer: "admin", expect: ok },
  { id: "1.8", group: 1, title: "approve_sale #1 (class A, Mature, expires in 1 day)", networks: BOTH, signer: "admin", expect: ok },
  { id: "1.9", group: 1, title: "open_sale #1", networks: BOTH, signer: "issuer", expect: ok },
  { id: "1.10", group: 1, title: "buy (B1, no passport) on the Open class", networks: BOTH, signer: "buyer1", expect: ok },
  {
    id: "1.11", group: 1, title: "mint_to_treasury by a non-Admin issuer to its own account", networks: LOCAL, signer: "issuer",
    expect: fails(ASSET_REGISTRY_ERROR__TREASURY_MINT_REQUIRES_ADMIN, "TreasuryMintRequiresAdmin"),
  },
  { id: "1.12a", group: 1, title: "update_transfer_hook_config(class B → KycGated, registry R0)", networks: LOCAL, signer: "blocklistAuthority", expect: ok },
  { id: "1.12b", group: 1, title: "approve_sale #4 (class B)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "1.12c", group: 1, title: "open_sale #4 (class B)", networks: LOCAL, signer: "issuer", expect: ok },
  {
    id: "1.12d", group: 1, title: "buy on the KycGated class without a passport (B2)", networks: LOCAL, signer: "buyer2",
    expect: fails(ASSET_REGISTRY_ERROR__RECEIVER_NOT_APPROVED, "ReceiverNotApproved"),
  },
  { id: "1.12e", group: 1, title: "approve_holder(B2) on R0", networks: LOCAL, signer: "kycAuthority", expect: ok },
  { id: "1.12f", group: 1, title: "buy on the KycGated class with a passport (B2)", networks: LOCAL, signer: "buyer2", expect: ok },
  // v1.0.0-rc (8.3): a blocked payer (prog-novac-4) and a frozen issuer (D1).
  { id: "1.13a", group: 1, title: "add_to_blocklist(B4) by the BA", networks: LOCAL, signer: "blocklistAuthority", expect: ok },
  {
    id: "1.13b", group: 1, title: "buy on sale #1 by the blocked buyer B4", networks: LOCAL, signer: "buyer4",
    expect: fails(ASSET_REGISTRY_ERROR__PARTY_BLOCKLISTED, "PartyBlocklisted"),
  },
  { id: "1.13c", group: 1, title: "remove_from_blocklist(B4) by the BA", networks: LOCAL, signer: "blocklistAuthority", expect: ok },
  { id: "1.14a", group: 1, title: "freeze_issuer_proceeds(e2e issuer) by the Admin", networks: LOCAL, signer: "admin", expect: ok },
  {
    id: "1.14b", group: 1, title: "buy on sale #1 while its issuer's proceeds are frozen (B1)", networks: LOCAL, signer: "buyer1",
    expect: fails(ASSET_REGISTRY_ERROR__ISSUER_PROCEEDS_FROZEN, "IssuerProceedsFrozen"),
  },
  { id: "1.14c", group: 1, title: "unfreeze_issuer_proceeds by the Super Admin", networks: LOCAL, signer: "superAdmin", expect: ok },

  // G2: a sale beyond its approval.
  { id: "2.1", group: 2, title: "approve_sale #2 (max gross G, price [p, p])", networks: BOTH, signer: "admin", expect: ok },
  {
    id: "2.2", group: 2, title: "open_sale #2 with price × total above the approved gross", networks: BOTH, signer: "issuer",
    expect: fails(ASSET_REGISTRY_ERROR__SALE_EXCEEDS_APPROVED_RAISE, "SaleExceedsApprovedRaise"),
  },
  {
    id: "2.3", group: 2, title: "open_sale #2 with a price above the approved maximum", networks: BOTH, signer: "issuer",
    expect: fails(ASSET_REGISTRY_ERROR__SALE_PRICE_OUTSIDE_APPROVAL, "SalePriceOutsideApproval"),
  },
  {
    // v1.0.0-rc (8.3 §8.2): every sale ends within 365 days of max(start, now).
    id: "2.2b", group: 2, title: "open_sale #2 ending 366 days after its start", networks: LOCAL, signer: "issuer",
    expect: fails(ASSET_REGISTRY_ERROR__SALE_DURATION_INVALID, "SaleDurationInvalid"),
  },
  { id: "2.4a", group: 2, title: "open_sale #2 at exactly the approved gross", networks: BOTH, signer: "issuer", expect: ok },
  { id: "2.4b", group: 2, title: "buy the whole sale #2 (B3)", networks: BOTH, signer: "buyer3", expect: ok },
  {
    id: "2.4c", group: 2, title: "buy one more unit of sale #2", networks: BOTH, signer: "buyer3",
    expect: fails(ASSET_REGISTRY_ERROR__SALE_SOLD_OUT, "SaleSoldOut"),
  },
  { id: "2.5a", group: 2, title: "approve_sale #3 expiring in about a minute", networks: BOTH, signer: "admin", expect: ok },
  {
    id: "2.5b", group: 2, title: "open_sale #3 after its approval expired", networks: BOTH, signer: "issuer",
    expect: fails(ASSET_REGISTRY_ERROR__SALE_APPROVAL_EXPIRED, "SaleApprovalExpired"),
  },
  { id: "2.5c", group: 2, title: "revoke_sale_approval #3", networks: BOTH, signer: "admin", expect: ok },
  {
    id: "2.6", group: 2, title: "approve_sale signed by a buyer (no Admin record)", networks: BOTH, signer: "buyer1",
    expect: fails(ANCHOR_ACCOUNT_NOT_INITIALIZED, "AccountNotInitialized"),
  },
  { id: "2.7a", group: 2, title: "approve_sale #5", networks: BOTH, signer: "admin", expect: ok },
  { id: "2.7b", group: 2, title: "open_sale #5 starting in an hour", networks: BOTH, signer: "issuer", expect: ok },
  {
    id: "2.7c", group: 2, title: "buy before sale #5 starts", networks: BOTH, signer: "buyer1",
    expect: fails(ASSET_REGISTRY_ERROR__SALE_NOT_STARTED, "SaleNotStarted"),
  },
  // v1.0.0-rc (8.3 D2/D3), with the bootstrap window closed by G0.
  {
    id: "2.8", group: 2, title: "set_pause_flags(clear 0x41) by the SA: 0x40 clears only on its own", networks: LOCAL, signer: "superAdmin",
    expect: fails(ASSET_REGISTRY_ERROR__PAYOUT_MODULES_CLEAR_NOT_EXPLICIT, "PayoutModulesClearNotExplicit"),
  },
  { id: "2.9a", group: 2, title: "propose_admin(fresh key) by the SA (funds the key)", networks: LOCAL, signer: "superAdmin", expect: ok },
  {
    id: "2.9b", group: 2, title: "add_admin by the proposed key at once (48 h timelock)", networks: LOCAL, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__TIMELOCK_ACTIVE, "TimelockActive"),
  },
  { id: "2.9c", group: 2, title: "cancel_admin_proposal by a live Admin (the veto)", networks: LOCAL, signer: "admin", expect: ok },

  // G3: OTC.
  { id: "3.1", group: 3, title: "create_offer #1 + deposit_to_offer_escrow (B1)", networks: BOTH, signer: "buyer1", expect: ok },
  { id: "3.2", group: 3, title: "take_offer #1 (B2, no KYC)", networks: BOTH, signer: "buyer2", expect: ok },
  { id: "3.3a", group: 3, title: "create_offer #2 + deposit_to_offer_escrow (B1)", networks: BOTH, signer: "buyer1", expect: ok },
  { id: "3.3b", group: 3, title: "cancel_offer #2 (B1)", networks: BOTH, signer: "buyer1", expect: ok },
  {
    // cancel_offer closes the escrow marker, so the take is refused at account
    // validation (3012) before the status check (OfferNotOpen) is reached.
    id: "3.3c", group: 3, title: "take the cancelled offer #2", networks: BOTH, signer: "buyer2",
    expect: fails(ANCHOR_ACCOUNT_NOT_INITIALIZED, "AccountNotInitialized"),
  },
  { id: "3.4a", group: 3, title: "create_offer #3 expiring in about a minute + deposit (B1)", networks: BOTH, signer: "buyer1", expect: ok },
  {
    id: "3.4b", group: 3, title: "take offer #3 after it expired", networks: BOTH, signer: "buyer2",
    expect: fails(ASSET_REGISTRY_ERROR__OFFER_EXPIRED, "OfferExpired"),
  },
  { id: "3.4c", group: 3, title: "expire_offer #3 (permissionless)", networks: BOTH, signer: "buyer2", expect: ok },
  { id: "3.5a", group: 3, title: "create_otc_deal #1 (seller B1, buyer B2)", networks: BOTH, signer: "admin", expect: ok },
  {
    // A stranger (B3), not the deal's buyer: the buyer as "seller" would name its
    // own share account twice and fail Anchor's duplicate-account check first.
    id: "3.5b", group: 3, title: "deposit_otc_asset by a stranger (B3, wrong party)", networks: BOTH, signer: "buyer3",
    expect: fails(ASSET_REGISTRY_ERROR__WRONG_DEAL_PARTY, "WrongDealParty"),
  },
  { id: "3.5c", group: 3, title: "deposit_otc_asset (B1)", networks: BOTH, signer: "buyer1", expect: ok },
  { id: "3.5d", group: 3, title: "deposit_otc_payment (B2) settles deal #1", networks: BOTH, signer: "buyer2", expect: ok },
  { id: "3.6a", group: 3, title: "create_otc_deal #2 (seller B1, buyer B2)", networks: BOTH, signer: "admin", expect: ok },
  { id: "3.6b", group: 3, title: "deposit_otc_payment for deal #2 (B2)", networks: BOTH, signer: "buyer2", expect: ok },
  { id: "3.6c", group: 3, title: "cancel_otc_deal #2 (Admin; refunds the payment)", networks: BOTH, signer: "admin", expect: ok },
  // v1.0.0-rc (8.3): the party blocklist in trades and refunds (O-11), and the deal deadline.
  { id: "3.7a", group: 3, title: "create_otc_deal #3 expiring in about 90 s (seller B1, buyer B2)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "3.7b", group: 3, title: "deposit_otc_payment for deal #3 (B2)", networks: LOCAL, signer: "buyer2", expect: ok },
  {
    id: "3.9", group: 3, title: "create_otc_deal #9 expiring 91 days out", networks: BOTH, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__DEAL_EXPIRY_OUT_OF_RANGE, "DealExpiryOutOfRange"),
  },
  { id: "3.8a", group: 3, title: "add_to_blocklist(B2) by the BA", networks: LOCAL, signer: "blocklistAuthority", expect: ok },
  { id: "3.8b", group: 3, title: "create_offer #4 + deposit_to_offer_escrow (B1)", networks: LOCAL, signer: "buyer1", expect: ok },
  {
    id: "3.8c", group: 3, title: "take_offer #4 by the blocked taker B2", networks: LOCAL, signer: "buyer2",
    expect: fails(ASSET_REGISTRY_ERROR__PARTY_BLOCKLISTED, "PartyBlocklisted"),
  },
  {
    id: "3.7c", group: 3, title: "expire_otc_deal #3 after its expiry: its blocked buyer is not refunded (O-11)", networks: LOCAL, signer: "buyer3",
    expect: fails(ASSET_REGISTRY_ERROR__PARTY_BLOCKLISTED, "PartyBlocklisted"),
  },
  { id: "3.7d", group: 3, title: "cancel_otc_deal #3 (Admin; refunds the blocked buyer)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "3.8d", group: 3, title: "remove_from_blocklist(B2) by the BA", networks: LOCAL, signer: "blocklistAuthority", expect: ok },
  { id: "3.8e", group: 3, title: "cancel_offer #4 (B1)", networks: LOCAL, signer: "buyer1", expect: ok },

  // G4: conversion and delivery = DeliveryEscrow (design-6.3 §A G4, v1: the
  // deadline lies between now + 24 h and now + 365 d, 6148). The KYC authority
  // signs its approve_holder with the Admin paying the fee. Devnet uses a
  // registry of the run's own KYC key (4.0); localnet the platform's R0.
  { id: "4.0", group: 4, title: "create_kyc_registry for the run's KYC key (Admin co-signs)", networks: DEVNET, signer: "admin", expect: ok },
  {
    id: "4.1", group: 4, title: "open_custody_vault ConversionPending (retired type)", networks: BOTH, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__VAULT_TYPE_RETIRED, "VaultTypeRetired"),
  },
  { id: "4.2", group: 4, title: "set_convertible_to(class A → class B)", networks: BOTH, signer: "issuer", expect: ok },
  {
    id: "4.3a", group: 4, title: "open a DeliveryEscrow whose deadline is one hour out", networks: BOTH, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__DELIVERY_DEADLINE_OUT_OF_RANGE, "DeliveryDeadlineOutOfRange"),
  },
  {
    id: "4.3b", group: 4, title: "open a DeliveryEscrow whose deadline is 366 days out", networks: BOTH, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__DELIVERY_DEADLINE_OUT_OF_RANGE, "DeliveryDeadlineOutOfRange"),
  },
  { id: "4.4", group: 4, title: "open DeliveryEscrow V1 (class A, beneficiary B1, deadline +25 h, registry pinned)", networks: BOTH, signer: "admin", expect: ok },
  {
    id: "4.5", group: 4, title: "deposit_to_custody_vault V1 by B2 (not the beneficiary)", networks: BOTH, signer: "buyer2",
    expect: fails(ASSET_REGISTRY_ERROR__DEPOSITOR_NOT_BENEFICIARY, "DepositorNotBeneficiary"),
  },
  { id: "4.6", group: 4, title: "deposit_to_custody_vault V1 by B1 (2 units)", networks: BOTH, signer: "buyer1", expect: ok },
  { id: "4.7", group: 4, title: "trigger_custody_vault V1", networks: BOTH, signer: "admin", expect: ok },
  {
    // realizeKycAccounts names the beneficiary's KycEntry, which does not exist yet.
    id: "4.8", group: 4, title: "realize V1 without the beneficiary's passport", networks: BOTH, signer: "admin",
    expect: fails(ANCHOR_ACCOUNT_NOT_INITIALIZED, "AccountNotInitialized"),
  },
  { id: "4.9", group: 4, title: "approve_holder(B1) on the e2e KYC registry (KYC authority signs)", networks: BOTH, signer: "admin", expect: ok },
  { id: "4.10", group: 4, title: "realize V1 with the passport (burns the deposit)", networks: BOTH, signer: "admin", expect: ok },
  { id: "4.11a", group: 4, title: "open DeliveryEscrow V2 (beneficiary B3, no passport)", networks: BOTH, signer: "admin", expect: ok },
  { id: "4.11b", group: 4, title: "deposit_to_custody_vault V2 by B3 (1 unit)", networks: BOTH, signer: "buyer3", expect: ok },
  { id: "4.11c", group: 4, title: "trigger_custody_vault V2", networks: BOTH, signer: "admin", expect: ok },
  {
    id: "4.11d", group: 4, title: "realize V2 without a passport", networks: BOTH, signer: "admin",
    expect: fails(ANCHOR_ACCOUNT_NOT_INITIALIZED, "AccountNotInitialized"),
  },
  { id: "4.11e", group: 4, title: "return_custody_vault V2 by its authority (the deposit goes back without KYC)", networks: BOTH, signer: "admin", expect: ok },
  { id: "4.12a", group: 4, title: "open DeliveryEscrow V3 (beneficiary B1, deadline +25 h)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "4.12b", group: 4, title: "deposit_to_custody_vault V3 by B1 (1 unit)", networks: LOCAL, signer: "buyer1", expect: ok },
  {
    id: "4.12c", group: 4, title: "return V3 by the beneficiary before its deadline", networks: LOCAL, signer: "buyer1",
    expect: fails(ASSET_REGISTRY_ERROR__RETURN_NOT_ALLOWED, "ReturnNotAllowed"),
  },
  { id: "4.12d", group: 4, title: "return V3 by the beneficiary after its deadline (warp)", networks: LOCAL, signer: "buyer1", expect: ok },

  // G5: distribution, vesting, governance on both networks; the payout / Merkle
  // modules (0x40, off on mainnet) on localnet: refused while set (6000), run
  // with the bit cleared on its own by the SA, then set again. The "after"
  // steps follow one clock move (a warp on localnet, which also covers the
  // three missed payout months; a wait on devnet).
  { id: "5.0", group: 5, title: "payment balance for the Admin (it funds the distributions)", networks: BOTH, signer: "funder", expect: ok },
  { id: "5.1a", group: 5, title: "create_distribution #1 (canonical plan: B1, B2, B3; funded by the Admin)", networks: BOTH, signer: "admin", expect: ok },
  { id: "5.1b", group: 5, title: "distribute_batch #1 batch 0", networks: BOTH, signer: "admin", expect: ok },
  { id: "5.1c", group: 5, title: "close_distribution #1", networks: BOTH, signer: "admin", expect: ok },
  { id: "5.2a", group: 5, title: "create_vesting_series #1 (B1, class A, one tranche ~3 min out)", networks: BOTH, signer: "buyer1", expect: ok },
  { id: "5.2b", group: 5, title: "add_vesting_position ×2 (B2, B3)", networks: BOTH, signer: "buyer1", expect: ok },
  { id: "5.2c", group: 5, title: "finalize_vesting_series #1", networks: BOTH, signer: "buyer1", expect: ok },
  { id: "5.2d", group: 5, title: "deposit_to_vesting_escrow #1 (2 units, B1)", networks: BOTH, signer: "buyer1", expect: ok },
  {
    id: "5.2e", group: 5, title: "claim_vested by B2 before the unlock", networks: BOTH, signer: "buyer2",
    expect: fails(ASSET_REGISTRY_ERROR__VESTING_NOTHING_TO_CLAIM, "VestingNothingToClaim"),
  },
  { id: "5.3a", group: 5, title: "create_proposal #1 (class A, voting ~3 min)", networks: BOTH, signer: "admin", expect: ok },
  { id: "5.3b", group: 5, title: "cast_vote For (B1, weight 3)", networks: BOTH, signer: "buyer1", expect: ok },
  {
    id: "5.3c", group: 5, title: "cast_vote with a proof for another weight (B2)", networks: BOTH, signer: "buyer2",
    expect: fails(ASSET_REGISTRY_ERROR__INVALID_MERKLE_PROOF, "InvalidMerkleProof"),
  },
  { id: "5.3d", group: 5, title: "cast_vote Against (B2, weight 2)", networks: BOTH, signer: "buyer2", expect: ok },
  {
    id: "5.3e", group: 5, title: "finalize_proposal #1 before its end", networks: BOTH, signer: "buyer3",
    expect: fails(ASSET_REGISTRY_ERROR__PROPOSAL_NOT_ENDED, "ProposalNotEnded"),
  },
  { id: "5.4a", group: 5, title: "approve_sale #30 (class A, Startup, cliff 0, vesting 3 months)", networks: LOCAL, signer: "admin", expect: ok },
  {
    id: "5.4b", group: 5, title: "open_sale #30 Startup while 0x40 is set", networks: LOCAL, signer: "issuer",
    expect: fails(ASSET_REGISTRY_ERROR__PLATFORM_PAUSED, "PlatformPaused"),
  },
  {
    id: "5.4c", group: 5, title: "create_rights_issuance while 0x40 is set", networks: LOCAL, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__PLATFORM_PAUSED, "PlatformPaused"),
  },
  { id: "5.4d", group: 5, title: "set_pause_flags(clear 0x40 on its own) by the SA", networks: LOCAL, signer: "superAdmin", expect: ok },
  { id: "5.5a", group: 5, title: "create_rights_issuance #1 (class A underlying)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "5.5b", group: 5, title: "mint_to_treasury of 4 units into the rights escrow (issuer, MINT grant)", networks: LOCAL, signer: "issuer", expect: ok },
  { id: "5.5c", group: 5, title: "publish_milestone #1/0 (B1: 2, B2: 1; unlock ~3 min)", networks: LOCAL, signer: "admin", expect: ok },
  {
    id: "5.5d", group: 5, title: "claim_milestone by B1 before the unlock", networks: LOCAL, signer: "buyer1",
    expect: fails(ASSET_REGISTRY_ERROR__MILESTONE_LOCKED, "MilestoneLocked"),
  },
  { id: "5.6a", group: 5, title: "open_sale #30 Startup", networks: LOCAL, signer: "issuer", expect: ok },
  { id: "5.6b", group: 5, title: "buy on the Startup sale #30 (B1)", networks: LOCAL, signer: "buyer1", expect: ok },
  { id: "5.6c", group: 5, title: "open_payout_vault #30 (the Startup proceeds)", networks: LOCAL, signer: "issuer", expect: ok },
  {
    id: "5.6d", group: 5, title: "freeze_vault #30 with one payout period overdue (a freeze needs three)", networks: LOCAL, signer: "buyer3",
    expect: fails(ASSET_REGISTRY_ERROR__UPDATE_REQUIRED, "UpdateRequired"),
  },
  { id: "5.2f", group: 5, title: "claim_vested by B2 after the unlock", networks: BOTH, signer: "buyer2", expect: ok },
  { id: "5.3f", group: 5, title: "finalize_proposal #1 after its end", networks: BOTH, signer: "buyer3", expect: ok },
  { id: "5.5e", group: 5, title: "claim_milestone by B1 after the unlock", networks: LOCAL, signer: "buyer1", expect: ok },
  { id: "5.6e", group: 5, title: "freeze_vault #30 after three missed monthly updates (warp)", networks: LOCAL, signer: "buyer3", expect: ok },
  {
    id: "5.6f", group: 5, title: "open_vault_vote #30 with a 1-day voting period", networks: LOCAL, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__VOTING_PERIOD_TOO_SHORT, "VotingPeriodTooShort"),
  },
  { id: "5.6g", group: 5, title: "open_vault_vote #30 with a 7-day voting period", networks: LOCAL, signer: "admin", expect: ok },
  { id: "5.7", group: 5, title: "set_pause_flags(set 0x40) by the Admin: the payout modules are off again", networks: LOCAL, signer: "admin", expect: ok },

  // G6: clawback. The negatives on both networks; the blocklist path (Open
  // class) and the KycGated path (revoked at once; expired only after the
  // 30-day grace, via a warp) on localnet.
  { id: "6.1", group: 6, title: "open the quarantine vault QA (class A, RedemptionQueue + BurnAndAttest)", networks: BOTH, signer: "admin", expect: ok },
  {
    id: "6.2", group: 6, title: "clawback_from_holder on the Open class A (B1)", networks: BOTH, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__CLAWBACK_NOT_KYC_GATED, "ClawbackNotKycGated"),
  },
  {
    id: "6.3", group: 6, title: "clawback_blocklisted_holder of a holder who is not blocked (B1)", networks: BOTH, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__CLAWBACK_HOLDER_NOT_BLOCKED, "ClawbackHolderNotBlocked"),
  },
  { id: "6.4a", group: 6, title: "add_to_blocklist(B3) by the BA", networks: LOCAL, signer: "blocklistAuthority", expect: ok },
  {
    id: "6.4b", group: 6, title: "wallet transfer of class A by the blocked B3", networks: LOCAL, signer: "buyer3",
    expect: fails(TRANSFER_HOOK_ERROR__SENDER_BLOCKED, "SenderBlocked", "transfer_hook"),
  },
  { id: "6.4c", group: 6, title: "clawback_blocklisted_holder(B3, 2 units) into QA by the Admin", networks: LOCAL, signer: "admin", expect: ok },
  { id: "6.4d", group: 6, title: "remove_from_blocklist(B3) by the BA", networks: LOCAL, signer: "blocklistAuthority", expect: ok },
  { id: "6.4e", group: 6, title: "trigger_custody_vault QA", networks: LOCAL, signer: "admin", expect: ok },
  { id: "6.4f", group: 6, title: "realize QA (burns the seized units)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "6.5a", group: 6, title: "approve_sale #7 (class B)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "6.5b", group: 6, title: "open_sale #7 (class B)", networks: LOCAL, signer: "issuer", expect: ok },
  { id: "6.5c", group: 6, title: "approve_holder B2 (refresh), B3 and B4 (expiring in ~3 min)", networks: LOCAL, signer: "kycAuthority", expect: ok },
  { id: "6.5d", group: 6, title: "buy 2 units of class B (B3)", networks: LOCAL, signer: "buyer3", expect: ok },
  { id: "6.5e", group: 6, title: "buy 2 units of class B (B4)", networks: LOCAL, signer: "buyer4", expect: ok },
  { id: "6.5f", group: 6, title: "revoke_holder(B3)", networks: LOCAL, signer: "kycAuthority", expect: ok },
  { id: "6.6a", group: 6, title: "open the quarantine vault QB (class B)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "6.6b", group: 6, title: "clawback_from_holder(B3, revoked) into QB", networks: LOCAL, signer: "admin", expect: ok },
  {
    id: "6.6c", group: 6, title: "clawback_from_holder(B2, passport valid)", networks: LOCAL, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__CLAWBACK_HOLDER_STILL_ELIGIBLE, "ClawbackHolderStillEligible"),
  },
  {
    id: "6.6d", group: 6, title: "clawback_from_holder(B4) inside the 30-day grace after its expiry", networks: LOCAL, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__CLAWBACK_HOLDER_STILL_ELIGIBLE, "ClawbackHolderStillEligible"),
  },
  { id: "6.6e", group: 6, title: "clawback_from_holder(B4) after the 30-day grace (warp)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "6.6f", group: 6, title: "trigger_custody_vault QB", networks: LOCAL, signer: "admin", expect: ok },
  { id: "6.6g", group: 6, title: "realize QB (burns the seized units)", networks: LOCAL, signer: "admin", expect: ok },

  // G7 (localnet): the pause matrix. Positions are staged first; with only
  // 0x40 set (as on mainnet) its entries are refused; then each emergency bit
  // alone refuses its entries (6000) and the SA clears it; then with every
  // bit set (0x7F) the exits land, an Admin cannot clear (6119), the SA
  // cannot clear 0x40 with other bits (6154), clears 0x3F, and a buy lands.
  { id: "7.0a", group: 7, title: "approve_sale #20 (class A)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.0b", group: 7, title: "open_sale #20 (class A)", networks: LOCAL, signer: "issuer", expect: ok },
  { id: "7.0c", group: 7, title: "approve_sale #22 (class A; opened only under the pause)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.0d", group: 7, title: "approve_sale #31 (class A, Startup; opened only under the pause)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.0e", group: 7, title: "create_offer #5 + deposit_to_offer_escrow (B1)", networks: LOCAL, signer: "buyer1", expect: ok },
  { id: "7.0f", group: 7, title: "create_offer #6 expiring in about two minutes + deposit (B1)", networks: LOCAL, signer: "buyer1", expect: ok },
  { id: "7.0g", group: 7, title: "create_otc_deal #10 (seller B1, buyer B2)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.0h", group: 7, title: "deposit_otc_payment for deal #10 (B2)", networks: LOCAL, signer: "buyer2", expect: ok },
  { id: "7.0i", group: 7, title: "open DeliveryEscrow V4 (beneficiary B1, deadline +25 h)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.0j", group: 7, title: "deposit_to_custody_vault V4 by B1 (1 unit)", networks: LOCAL, signer: "buyer1", expect: ok },
  { id: "7.0k", group: 7, title: "create_distribution #2 (funded by the Admin; left unpaid)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.0l", group: 7, title: "create_proposal #2 (class A, voting one day)", networks: LOCAL, signer: "admin", expect: ok },
  ...pausedEntries("7.1", "0x40 alone (as on mainnet)", [
    ["a", "create_rights_issuance #2", "admin"],
    ["b", "publish_milestone #1/1", "admin"],
    ["c", "open_sale #31 Startup", "issuer"],
  ]),
  ...pauseRound("7.2", "0x01 onboarding", [
    ["b", "register_issuer (B4 as a new issuer)", "buyer4"],
    ["c", "create_asset", "issuer"],
  ]),
  ...pauseRound("7.3", "0x02 primary", [
    ["b", "buy on sale #20 (B1)", "buyer1"],
    ["c", "open_sale #22", "issuer"],
    ["d", "mint_to_treasury (issuer)", "issuer"],
  ]),
  ...pauseRound("7.4", "0x04 secondary", [
    ["b", "create_offer #7 (B1)", "buyer1"],
    ["c", "take_offer #5 (B2)", "buyer2"],
    ["d", "create_otc_deal #11", "admin"],
    ["e", "deposit_otc_asset for deal #10 (B1)", "buyer1"],
  ]),
  ...pauseRound("7.5", "0x08 custody entry", [
    ["b", "open a DeliveryEscrow", "admin"],
    ["c", "deposit_to_custody_vault V4 (B1)", "buyer1"],
  ]),
  ...pauseRound("7.6", "0x10 distributions", [
    ["b", "create_distribution #3", "admin"],
    ["c", "distribute_batch of #2", "admin"],
    ["d", "deposit_to_vesting_escrow #1 (B1)", "buyer1"],
  ]),
  ...pauseRound("7.7", "0x20 issuer proceeds", [["b", "close_sale #20 (issuer)", "issuer"]]),
  { id: "7.8a", group: 7, title: "set_pause_flags(set 0x3F) by the Admin: every bit set (0x7F)", networks: LOCAL, signer: "admin", expect: ok },
  {
    id: "7.8b", group: 7, title: "set_pause_flags(clear 0x01) by an Admin", networks: LOCAL, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__PAUSE_CLEAR_NOT_ALLOWED, "PauseClearNotAllowed"),
  },
  { id: "7.8c", group: 7, title: "exit under 0x7F: cancel_offer #5 (B1)", networks: LOCAL, signer: "buyer1", expect: ok },
  { id: "7.8d", group: 7, title: "exit under 0x7F: expire_offer #6 after its expiry (B2)", networks: LOCAL, signer: "buyer2", expect: ok },
  { id: "7.8e", group: 7, title: "exit under 0x7F: cancel_otc_deal #10 (Admin; refunds B2)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.8f", group: 7, title: "exit under 0x7F: return_custody_vault V4 (Admin)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.8g", group: 7, title: "exit under 0x7F: open the quarantine vault QA2 (class A)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.8h", group: 7, title: "exit under 0x7F: add_to_blocklist(B2) by the BA", networks: LOCAL, signer: "blocklistAuthority", expect: ok },
  { id: "7.8i", group: 7, title: "exit under 0x7F: clawback_blocklisted_holder(B2, 1 unit) into QA2", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.8j", group: 7, title: "exit under 0x7F: remove_from_blocklist(B2) by the BA", networks: LOCAL, signer: "blocklistAuthority", expect: ok },
  { id: "7.8k", group: 7, title: "exit under 0x7F: trigger_custody_vault QA2", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.8l", group: 7, title: "exit under 0x7F: realize QA2 (burn)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.8m", group: 7, title: "exit under 0x7F: claim_vested by B3", networks: LOCAL, signer: "buyer3", expect: ok },
  { id: "7.8n", group: 7, title: "exit under 0x7F: claim_milestone by B2", networks: LOCAL, signer: "buyer2", expect: ok },
  { id: "7.8o", group: 7, title: "exit under 0x7F: close_distribution #2 (refunds the Admin)", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.8p", group: 7, title: "exit under 0x7F: cast_vote on proposal #2 (B1)", networks: LOCAL, signer: "buyer1", expect: ok },
  { id: "7.8q", group: 7, title: "under 0x7F: approve_sale #23", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.8r", group: 7, title: "under 0x7F: revoke_sale_approval #23", networks: LOCAL, signer: "admin", expect: ok },
  { id: "7.8s", group: 7, title: "exit under 0x7F: wallet transfer of class A, B1 → B2", networks: LOCAL, signer: "buyer1", expect: ok },
  {
    id: "7.9a", group: 7, title: "set_pause_flags(clear 0x7F) by the SA: 0x40 clears only on its own", networks: LOCAL, signer: "superAdmin",
    expect: fails(ASSET_REGISTRY_ERROR__PAYOUT_MODULES_CLEAR_NOT_EXPLICIT, "PayoutModulesClearNotExplicit"),
  },
  { id: "7.9b", group: 7, title: "set_pause_flags(clear 0x3F) by the SA (0x40 stays set)", networks: LOCAL, signer: "superAdmin", expect: ok },
  { id: "7.9c", group: 7, title: "buy on sale #20 after the resume (B1)", networks: LOCAL, signer: "buyer1", expect: ok },

  // G8 (localnet): rotations and recoveries. Keys that are not a matrix role
  // (K2, SA2, SA3, BA2, BA3, BA4, A2, Ia, Ib, I2, T2) sign their instructions
  // with the deployer (funder) paying the fee. One warp of 7 days covers the
  // 7-day recoveries and the 48 h grant; a second one of 48 h the SA
  // rotation proposed by the recovered SA.
  { id: "8.0", group: 8, title: "fund the G8 keys (K2, SA2, SA3, BA2, BA3, BA4, A2, Ia, Ib, I2)", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.1a", group: 8, title: "propose_kyc_registry_authority(K2) by K1", networks: LOCAL, signer: "kycAuthority", expect: ok },
  { id: "8.1b", group: 8, title: "cancel_kyc_registry_authority_transfer by K1", networks: LOCAL, signer: "kycAuthority", expect: ok },
  { id: "8.1c", group: 8, title: "propose_kyc_registry_authority(K2) again", networks: LOCAL, signer: "kycAuthority", expect: ok },
  { id: "8.1d", group: 8, title: "accept_kyc_registry_authority by K2", networks: LOCAL, signer: "funder", expect: ok },
  {
    id: "8.1e", group: 8, title: "approve_holder by the former registry authority K1", networks: LOCAL, signer: "kycAuthority",
    expect: fails(ASSET_REGISTRY_ERROR__UNAUTHORIZED, "Unauthorized"),
  },
  { id: "8.1f", group: 8, title: "approve_holder by K2 on the same registry address", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.2a", group: 8, title: "register_issuer (throwaway issuer, authority Ia)", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.2b", group: 8, title: "propose_issuer_authority(Ib) by Ia", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.2c", group: 8, title: "cancel_issuer_authority_transfer by Ia", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.2d", group: 8, title: "propose_issuer_authority(Ib) again", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.2e", group: 8, title: "accept_issuer_authority by Ib", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.2f", group: 8, title: "propose_issuer_authority(the Admin key A1) by Ib", networks: LOCAL, signer: "funder", expect: ok },
  {
    id: "8.2g", group: 8, title: "accept_issuer_authority by A1: a non-Admin issuer key may not pass to an Admin", networks: LOCAL, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__INVALID_PROPOSED_AUTHORITY, "InvalidProposedAuthority"),
  },
  { id: "8.3a", group: 8, title: "set_protocol_treasury(T2) by the SA", networks: LOCAL, signer: "superAdmin", expect: ok },
  {
    id: "8.3b", group: 8, title: "set_protocol_treasury by an Admin", networks: LOCAL, signer: "admin",
    expect: fails(ASSET_REGISTRY_ERROR__UNAUTHORIZED, "Unauthorized"),
  },
  {
    id: "8.3c", group: 8, title: "set_protocol_treasury(the default address) by the SA", networks: LOCAL, signer: "superAdmin",
    expect: fails(ASSET_REGISTRY_ERROR__INVALID_PROTOCOL_TREASURY, "InvalidProtocolTreasury"),
  },
  { id: "8.4a", group: 8, title: "propose_blocklist_authority(BA2) by BA1", networks: LOCAL, signer: "blocklistAuthority", expect: ok },
  { id: "8.4b", group: 8, title: "accept_blocklist_authority by BA2", networks: LOCAL, signer: "funder", expect: ok },
  {
    id: "8.4c", group: 8, title: "add_to_blocklist by the former BA1", networks: LOCAL, signer: "blocklistAuthority",
    expect: fails(TRANSFER_HOOK_ERROR__UNAUTHORIZED, "Unauthorized", "transfer_hook"),
  },
  { id: "8.4d", group: 8, title: "add_to_blocklist(B4) by BA2", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.4e", group: 8, title: "remove_from_blocklist(B4) by BA2", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.5a", group: 8, title: "propose_issuer_recovery(I2) for the e2e issuer by the SA", networks: LOCAL, signer: "superAdmin", expect: ok },
  {
    id: "8.5b", group: 8, title: "execute_issuer_recovery by I2 inside the 7 days", networks: LOCAL, signer: "funder",
    expect: fails(ASSET_REGISTRY_ERROR__ISSUER_RECOVERY_TIMELOCK_ACTIVE, "IssuerRecoveryTimelockActive"),
  },
  { id: "8.5c", group: 8, title: "cancel_issuer_recovery by the issuer", networks: LOCAL, signer: "issuer", expect: ok },
  { id: "8.5d", group: 8, title: "propose_issuer_recovery(I2) again", networks: LOCAL, signer: "superAdmin", expect: ok },
  { id: "8.6a", group: 8, title: "propose_admin(A2) by the SA", networks: LOCAL, signer: "superAdmin", expect: ok },
  {
    id: "8.6b", group: 8, title: "add_admin by A2 inside the 48 h", networks: LOCAL, signer: "funder",
    expect: fails(ASSET_REGISTRY_ERROR__TIMELOCK_ACTIVE, "TimelockActive"),
  },
  { id: "8.7a", group: 8, title: "propose_platform_admin(SA2) by SA1", networks: LOCAL, signer: "superAdmin", expect: ok },
  {
    id: "8.7b", group: 8, title: "accept_platform_admin by SA2 inside the 48 h", networks: LOCAL, signer: "funder",
    expect: fails(ASSET_REGISTRY_ERROR__TIMELOCK_ACTIVE, "TimelockActive"),
  },
  { id: "8.8a", group: 8, title: "propose_platform_recovery(SA3) by the upgrade authority", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.8b", group: 8, title: "cancel_platform_recovery by the live SA1", networks: LOCAL, signer: "superAdmin", expect: ok },
  { id: "8.8c", group: 8, title: "propose_platform_recovery(SA3) again", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.9a", group: 8, title: "propose_blocklist_recovery(BA3) by the upgrade authority", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.9b", group: 8, title: "propose_blocklist_authority(BA4) by BA2", networks: LOCAL, signer: "funder", expect: ok },
  {
    id: "8.9c", group: 8, title: "accept_blocklist_authority by BA4 while a recovery is pending", networks: LOCAL, signer: "funder",
    expect: fails(TRANSFER_HOOK_ERROR__RECOVERY_PENDING, "RecoveryPending", "transfer_hook"),
  },
  { id: "8.9d", group: 8, title: "cancel_blocklist_authority_transfer (BA4) by BA2", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.9e", group: 8, title: "cancel_blocklist_recovery by BA2 (the live holder)", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.9f", group: 8, title: "propose_blocklist_recovery(BA3) again", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.6c", group: 8, title: "add_admin by A2 after the 48 h (warp)", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.6d", group: 8, title: "approve_sale #40 by the new Admin A2", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.6e", group: 8, title: "remove_admin(A2) by the SA", networks: LOCAL, signer: "superAdmin", expect: ok },
  {
    id: "8.6f", group: 8, title: "open_sale #40 after its approving Admin was removed", networks: LOCAL, signer: "issuer",
    expect: fails(ANCHOR_ACCOUNT_NOT_INITIALIZED, "AccountNotInitialized"),
  },
  {
    id: "8.6g", group: 8, title: "remove_admin of the Super Admin's own record", networks: LOCAL, signer: "superAdmin",
    expect: fails(ASSET_REGISTRY_ERROR__CANNOT_REVOKE_PLATFORM_ADMIN, "CannotRevokePlatformAdmin"),
  },
  {
    id: "8.7c", group: 8, title: "accept_platform_admin by SA2 while a recovery is pending", networks: LOCAL, signer: "funder",
    expect: fails(ASSET_REGISTRY_ERROR__PLATFORM_RECOVERY_PENDING, "PlatformRecoveryPending"),
  },
  // A recovery executes only while its proposer is the Super Admin: the
  // issuer recovery (proposed by SA1) goes before the SA1 → SA3 recovery.
  { id: "8.5e", group: 8, title: "execute_issuer_recovery by I2 after 7 days (its proposer SA1 is still the SA)", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.5f", group: 8, title: "sync_sale_authority(sale #1) to the recovered issuer key", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.8d", group: 8, title: "execute_platform_recovery by SA3 after 7 days", networks: LOCAL, signer: "funder", expect: ok },
  {
    id: "8.8e", group: 8, title: "set_pause_flags(set 0x01) by the former SA1", networks: LOCAL, signer: "superAdmin",
    expect: fails(ASSET_REGISTRY_ERROR__UNAUTHORIZED, "Unauthorized"),
  },
  { id: "8.9g", group: 8, title: "execute_blocklist_recovery by BA3 after 7 days", networks: LOCAL, signer: "funder", expect: ok },
  {
    id: "8.9h", group: 8, title: "add_to_blocklist by the former BA2", networks: LOCAL, signer: "funder",
    expect: fails(TRANSFER_HOOK_ERROR__UNAUTHORIZED, "Unauthorized", "transfer_hook"),
  },
  { id: "8.7d", group: 8, title: "propose_platform_admin(SA2) by the recovered SA3", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.7e", group: 8, title: "accept_platform_admin by SA2 after 48 h (warp)", networks: LOCAL, signer: "funder", expect: ok },
  {
    id: "8.7f", group: 8, title: "set_pause_flags(set 0x01) by the former SA3", networks: LOCAL, signer: "funder",
    expect: fails(ASSET_REGISTRY_ERROR__UNAUTHORIZED, "Unauthorized"),
  },
  { id: "8.7g", group: 8, title: "set_pause_flags(set 0x01) by SA2", networks: LOCAL, signer: "funder", expect: ok },
  { id: "8.7h", group: 8, title: "set_pause_flags(clear 0x01) by SA2 (only the SA clears)", networks: LOCAL, signer: "funder", expect: ok },
];

/** Entries of one pause family refused while its bit is set (6000); no set/clear. */
function pausedEntries(prefix: string, what: string, entries: readonly [string, string, string][]): StepSpec[] {
  const group = Number(prefix.split(".")[0]);
  return entries.map(([suffix, title, signer]) => ({
    id: `${prefix}${suffix}`,
    group,
    title: `${title} while ${what} is set`,
    networks: LOCAL,
    signer,
    expect: fails(ASSET_REGISTRY_ERROR__PLATFORM_PAUSED, "PlatformPaused"),
  }));
}

/** One G7 round: the Admin sets one bit (a), its entries are refused, the SA clears it (last). */
function pauseRound(prefix: string, bit: string, entries: readonly [string, string, string][]): StepSpec[] {
  const group = Number(prefix.split(".")[0]);
  const clear = String.fromCharCode("a".charCodeAt(0) + entries.length + 1);
  return [
    { id: `${prefix}a`, group, title: `set_pause_flags(set ${bit}) by the Admin`, networks: LOCAL, signer: "admin", expect: ok },
    ...pausedEntries(prefix, bit, entries),
    { id: `${prefix}${clear}`, group, title: `set_pause_flags(clear ${bit}) by the SA`, networks: LOCAL, signer: "superAdmin", expect: ok },
  ];
}

/** "1-3", "0,1,2", "2" → sorted unique group numbers (0..8). */
export function parseGroups(value: string): number[] {
  const out = new Set<number>();
  for (const part of value.split(",").map((p) => p.trim()).filter(Boolean)) {
    const range = /^(\d)(?:-(\d))?$/.exec(part);
    if (!range) throw new Error(`E2E_GROUPS: "${part}" is not a group or a range (0..8)`);
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from > 8 || to > 8 || to < from) throw new Error(`E2E_GROUPS: "${part}" is outside 0..8`);
    for (let g = from; g <= to; g++) out.add(g);
  }
  if (!out.size) throw new Error("E2E_GROUPS is empty");
  return [...out].sort((a, b) => a - b);
}

export function stepsFor(network: E2eNetwork, groups: readonly number[]): StepSpec[] {
  return E2E_STEPS.filter((s) => groups.includes(s.group) && s.networks.includes(network));
}

export function stepSpec(id: string): StepSpec {
  const spec = E2E_STEPS.find((s) => s.id === id);
  if (!spec) throw new Error(`Unknown e2e step ${id}`);
  return spec;
}

/**
 * The digest CHAIN_CONFIRM_PLAN confirms: the network, its genesis, the
 * paying admin (devnet) or deployer (localnet), the groups and every step
 * spec that will run. Entity addresses are derived during the run and are
 * not part of it; the journal records them.
 */
export function e2ePlanDigest(input: {
  network: E2eNetwork;
  genesis: string;
  payer: string;
  runId: string;
  groups: readonly number[];
}): string {
  return sha256Hex(
    canonicalJson({
      schema: "mancipatio-e2e-plan-v1",
      network: input.network,
      genesis: input.genesis,
      payer: input.payer,
      runId: input.runId,
      groups: [...input.groups],
      steps: stepsFor(input.network, input.groups),
    }),
  );
}
