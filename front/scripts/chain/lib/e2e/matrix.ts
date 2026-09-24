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
  ASSET_REGISTRY_ERROR__OFFER_EXPIRED,
  ASSET_REGISTRY_ERROR__OFFER_NOT_OPEN,
  ASSET_REGISTRY_ERROR__RECEIVER_NOT_APPROVED,
  ASSET_REGISTRY_ERROR__SALE_APPROVAL_EXPIRED,
  ASSET_REGISTRY_ERROR__SALE_EXCEEDS_APPROVED_RAISE,
  ASSET_REGISTRY_ERROR__SALE_NOT_STARTED,
  ASSET_REGISTRY_ERROR__SALE_PRICE_OUTSIDE_APPROVAL,
  ASSET_REGISTRY_ERROR__SALE_SOLD_OUT,
  ASSET_REGISTRY_ERROR__TREASURY_MINT_REQUIRES_ADMIN,
  ASSET_REGISTRY_ERROR__WRONG_DEAL_PARTY,
} from "@/lib/generated/asset_registry";
import { canonicalJson, sha256Hex } from "../safety";

export type E2eNetwork = "devnet" | "localnet";
export type ProgramLabel = "asset_registry" | "transfer_hook";

/** Anchor's AccountNotInitialized: a required PDA (e.g. an Admin record) is missing. */
export const ANCHOR_ACCOUNT_NOT_INITIALIZED = 3012;

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
    expect: fails(3012, "AccountNotInitialized"),
  },
  { id: "2.7a", group: 2, title: "approve_sale #5", networks: BOTH, signer: "admin", expect: ok },
  { id: "2.7b", group: 2, title: "open_sale #5 starting in an hour", networks: BOTH, signer: "issuer", expect: ok },
  {
    id: "2.7c", group: 2, title: "buy before sale #5 starts", networks: BOTH, signer: "buyer1",
    expect: fails(ASSET_REGISTRY_ERROR__SALE_NOT_STARTED, "SaleNotStarted"),
  },

  // G3: OTC.
  { id: "3.1", group: 3, title: "create_offer #1 + deposit_to_offer_escrow (B1)", networks: BOTH, signer: "buyer1", expect: ok },
  { id: "3.2", group: 3, title: "take_offer #1 (B2, no KYC)", networks: BOTH, signer: "buyer2", expect: ok },
  { id: "3.3a", group: 3, title: "create_offer #2 + deposit_to_offer_escrow (B1)", networks: BOTH, signer: "buyer1", expect: ok },
  { id: "3.3b", group: 3, title: "cancel_offer #2 (B1)", networks: BOTH, signer: "buyer1", expect: ok },
  {
    id: "3.3c", group: 3, title: "take the cancelled offer #2", networks: BOTH, signer: "buyer2",
    expect: fails(ASSET_REGISTRY_ERROR__OFFER_NOT_OPEN, "OfferNotOpen"),
  },
  { id: "3.4a", group: 3, title: "create_offer #3 expiring in about a minute + deposit (B1)", networks: BOTH, signer: "buyer1", expect: ok },
  {
    id: "3.4b", group: 3, title: "take offer #3 after it expired", networks: BOTH, signer: "buyer2",
    expect: fails(ASSET_REGISTRY_ERROR__OFFER_EXPIRED, "OfferExpired"),
  },
  { id: "3.4c", group: 3, title: "expire_offer #3 (permissionless)", networks: BOTH, signer: "buyer2", expect: ok },
  { id: "3.5a", group: 3, title: "create_otc_deal #1 (seller B1, buyer B2)", networks: BOTH, signer: "admin", expect: ok },
  {
    id: "3.5b", group: 3, title: "deposit_otc_asset by the buyer (wrong party)", networks: BOTH, signer: "buyer2",
    expect: fails(ASSET_REGISTRY_ERROR__WRONG_DEAL_PARTY, "WrongDealParty"),
  },
  { id: "3.5c", group: 3, title: "deposit_otc_asset (B1)", networks: BOTH, signer: "buyer1", expect: ok },
  { id: "3.5d", group: 3, title: "deposit_otc_payment (B2) settles deal #1", networks: BOTH, signer: "buyer2", expect: ok },
  { id: "3.6a", group: 3, title: "create_otc_deal #2 (seller B1, buyer B2)", networks: BOTH, signer: "admin", expect: ok },
  { id: "3.6b", group: 3, title: "deposit_otc_payment for deal #2 (B2)", networks: BOTH, signer: "buyer2", expect: ok },
  { id: "3.6c", group: 3, title: "cancel_otc_deal #2 (Admin; refunds the payment)", networks: BOTH, signer: "admin", expect: ok },
];

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
