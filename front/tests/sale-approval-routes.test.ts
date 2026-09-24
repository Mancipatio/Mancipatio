// /api/sale-approvals/* (program package 2B). SIWS verification, the admin
// gate, the RPC and Supabase are mocked; the routes, their _lib and
// lib/server/sale-capacity.ts run for real, including every PDA derivation.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  wallet: "",
  params: {} as Record<string, unknown>,
  admin: true,
  superAdmin: false,
  network: "devnet" as "devnet" | "mainnet",
  issuerAuthority: "",
  accounts: new Map<string, { exists: boolean; programAddress?: string; data?: Uint8Array }>(),
  approval: null as Record<string, unknown> | null,
  sale: null as Record<string, unknown> | null,
  // The single-slot reads of the release route, per commitment.
  chainState: { confirmed: { approval: false, sale: false }, finalized: { approval: false, sale: false } },
  expired: false,
  sigOutcome: "unknown" as "failed" | "succeeded" | "unknown",
  // Treasury-mint history on the share class (release route scan).
  signatures: { signatures: [] as Array<{ signature: string; blockTime: number }>, complete: true },
  txs: {} as Record<string, unknown>,
  rows: {} as Record<string, unknown>,
  lists: {} as Record<string, unknown[]>,
  rpc: {} as Record<string, unknown>,
  calls: [] as Array<{ kind: string; target: string; args: unknown }>,
  rpcErrors: {} as Record<string, { code: string; message: string }>,
  fixtures: { issuer: "", asset: "", shareClass: "", assetId: "sale-approval-01", legalEntityId: new Uint8Array(32) },
}));

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => state.network,
}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/server/sale-capacity-chain", () => ({
  readApprovalAndSale: vi.fn(async (_a: string, _s: string, commitment: "confirmed" | "finalized") => ({
    approval: state.chainState[commitment].approval ? {} : null,
    sale: state.chainState[commitment].sale ? {} : null,
  })),
  blockhashExpired: vi.fn(async () => state.expired),
  signatureOutcome: vi.fn(async () => state.sigOutcome),
  listLiveApprovals: vi.fn(async () => []),
  listFinalizedSignatures: vi.fn(async () => state.signatures),
  finalizedTransaction: vi.fn(async (sig: string) => state.txs[sig] ?? null),
}));
vi.mock("@solana/kit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/kit")>()),
  fetchEncodedAccount: vi.fn(async (_rpc: unknown, key: string) => state.accounts.get(key) ?? { exists: false, address: key }),
}));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/generated/asset_registry")>();
  const account = (data: Record<string, unknown> | null) =>
    data ? { exists: true, programAddress: original.ASSET_REGISTRY_PROGRAM_ADDRESS, data } : { exists: false };
  return {
    ...original,
    fetchMaybeShareClass: vi.fn(async () => account({ asset: state.fixtures.asset, classIndex: 0 })),
    fetchMaybeAsset: vi.fn(async () => account({ issuer: state.fixtures.issuer, assetId: state.fixtures.assetId })),
    fetchMaybeIssuer: vi.fn(async () =>
      account({ legalEntityId: state.fixtures.legalEntityId, authority: state.issuerAuthority, kybStatus: original.KybStatus.Verified }),
    ),
    fetchMaybeSaleApproval: vi.fn(async () => account(state.approval)),
    fetchMaybeSale: vi.fn(async () => account(state.sale)),
  };
});
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: state.wallet, params: state.params, via: "signature" })),
}));
vi.mock("@/lib/server/admin-gate", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    requireAdmin: vi.fn(async () => {
      if (!state.admin) throw new SiwsError(403, "Admin privileges required");
    }),
    requireSuperAdmin: vi.fn(async () => {
      if (!state.superAdmin) throw new SiwsError(403, "Super admin privileges required");
    }),
  };
});
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      const write = (kind: string) => (args: unknown) => {
        state.calls.push({ kind, target: table, args });
        return builder;
      };
      Object.assign(builder, {
        select: chain, eq: chain, in: chain, order: chain, limit: chain, abortSignal: chain, gte: chain, is: chain, not: chain,
        update: write("update"), insert: write("insert"),
        maybeSingle: async () => ({ data: state.rows[table] ?? null, error: null }),
        single: async () => ({ data: { id: `${table}-row` }, error: null }),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: state.lists[table] ?? [], error: null }).then(resolve, reject),
      });
      return builder;
    },
    rpc: (fn: string, args: unknown) => {
      state.calls.push({ kind: "rpc", target: fn, args });
      const result = state.rpcErrors[fn] ? { data: null, error: state.rpcErrors[fn] } : { data: state.rpc[fn] ?? null, error: null };
      return Object.assign(Promise.resolve(result), { abortSignal: () => Promise.resolve(result) });
    },
  }),
}));

import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findAssetPda,
  findIssuerPda,
  findSaleApprovalPda,
  getMintToTreasuryInstructionDataEncoder,
  RaiseType,
} from "@/lib/generated/asset_registry";
import { getBase58Decoder } from "@solana/kit";
import { findSalePda, findShareClassPda } from "@/lib/pdas";
import { applicationSnapshot, snapshotHash, TOKEN_PROGRAM } from "@/lib/server/sale-capacity";
import { POST as reserveRoute } from "@/app/api/sale-approvals/reserve/route";
import { POST as confirmRoute } from "@/app/api/sale-approvals/confirm/route";
import { POST as releaseRoute } from "@/app/api/sale-approvals/release/route";
import { POST as settleRoute } from "@/app/api/sale-approvals/settle/route";
import { POST as recordIssuanceRoute } from "@/app/api/spvs/record-issuance/route";
import { POST as treasuryRevalueRoute } from "@/app/api/sale-approvals/treasury-revalue/route";
import { POST as treasuryMintRoute } from "@/app/api/sale-approvals/treasury-mint/route";

const ADMIN = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const ISSUER_KEY = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9";
const STRANGER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const MINT = "EURCmint11111111111111111111111111111111111";
const APPLICATION_ID = "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";
const RESERVATION_ID = "1b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0c";
const NOW = Math.floor(Date.now() / 1000);
const EXPIRES = NOW + 30 * 86_400;
let SALE = "";
let APPROVAL = "";

const APP_ROW = {
  id: APPLICATION_ID, network: "devnet", status: "approved", applicant_wallet: ISSUER_KEY, revision_count: 1,
  reviewed_at: "2026-09-20T10:00:00.000Z", company_name: "Acme d.o.o.", raise_type: "mature",
  raise_amount: 500000, equity_offered: 10, cliff_months: 0, vesting_months: 0,
};

const reserveParams = () => ({
  application_id: APPLICATION_ID, share_class: state.fixtures.shareClass, sale_id: "4", payment_mint: MINT,
  max_gross_raise: "250000000000", min_price_per_unit: "1000000", max_price_per_unit: "1200000",
  raise_type: "mature", expires_at: String(EXPIRES),
});

function mintAccount(decimals: number) {
  const data = new Uint8Array(82);
  data[44] = decimals;
  data[45] = 1;
  return { exists: true, programAddress: TOKEN_PROGRAM, data };
}

async function call(route: (r: Request) => Promise<Response>, params: Record<string, unknown>, wallet = ADMIN) {
  state.params = params;
  state.wallet = wallet;
  const response = await route(new Request("http://localhost/api/test", { method: "POST", body: "{}" }));
  return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string; data?: Record<string, unknown> } };
}
const rpcCall = (fn: string) => state.calls.find((c) => c.kind === "rpc" && c.target === fn)?.args as Record<string, unknown> | undefined;

const reservation = (over: Record<string, unknown> = {}) => ({
  id: RESERVATION_ID, network: "devnet", kind: "sale", share_class_pda: state.fixtures.shareClass, sale_id: "4",
  approval_pda: APPROVAL, sale_pda: SALE, asset_pda: state.fixtures.asset, issuer_pda: state.fixtures.issuer, spv_id: null,
  subject: `issuer:${state.fixtures.issuer}`, application_id: APPLICATION_ID, application_snapshot: {},
  application_hash: "ab".repeat(32), payment_mint: MINT, payment_decimals: 6, max_gross_raise: "250000000000",
  min_price_per_unit: "1000000", max_price_per_unit: "1200000", raise_type: "mature", cliff_months: 0, vesting_months: 0,
  expires_at: new Date(EXPIRES * 1000).toISOString(), amount_units: null, amount_eur: 250000, status: "reserved",
  chain_confirmed_at: null, approve_signature: null, mint_signature: null, booked_amount_eur: null,
  release_reason: null, reason: null, last_error: null, reserved_by: ADMIN, created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(), ...over,
});
const onChainApproval = (over: Record<string, unknown> = {}) => ({
  shareClass: state.fixtures.shareClass, saleId: BigInt(4), issuer: state.fixtures.issuer, paymentMint: MINT,
  maxGrossRaise: BigInt(250_000_000_000), minPricePerUnit: BigInt(1_000_000), maxPricePerUnit: BigInt(1_200_000),
  raiseType: RaiseType.Mature, expiresAt: BigInt(EXPIRES), applicationHash: new Uint8Array(32).fill(0xab),
  approvedBy: ADMIN, bump: 255, version: 1, cliffMonths: 0, vestingMonths: 0, ...over,
});

beforeAll(async () => {
  state.fixtures.legalEntityId = new TextEncoder().encode("SALE-APPROVAL-ROUTES-ENTITY-0001");
  [state.fixtures.issuer] = await findIssuerPda({ legalEntityId: state.fixtures.legalEntityId });
  [state.fixtures.asset] = await findAssetPda({ issuer: state.fixtures.issuer as never, assetId: state.fixtures.assetId });
  state.fixtures.shareClass = await findShareClassPda(state.fixtures.asset as never, 0);
  SALE = await findSalePda(state.fixtures.shareClass as never, BigInt(4));
  [APPROVAL] = await findSaleApprovalPda({ shareClass: state.fixtures.shareClass as never, saleId: BigInt(4) });
});

beforeEach(() => {
  state.admin = true;
  state.superAdmin = false;
  state.network = "devnet";
  state.issuerAuthority = ISSUER_KEY;
  state.accounts = new Map([[MINT, mintAccount(6)]]);
  state.approval = null;
  state.sale = null;
  state.chainState = { confirmed: { approval: false, sale: false }, finalized: { approval: false, sale: false } };
  state.expired = false;
  state.sigOutcome = "unknown";
  state.signatures = { signatures: [], complete: true };
  state.txs = {};
  state.rows = { launch_applications: APP_ROW, asset_profiles: { spv_id: null } };
  state.lists = {};
  state.rpc = {
    applicant_wallets: [ISSUER_KEY],
    reserve_sale_capacity: { id: RESERVATION_ID, amount_eur: 250000, subject: "issuer:x", existing: false, capacity: {} },
  };
  state.calls = [];
  state.rpcErrors = {};
});

describe("reserve", () => {
  it("refuses a non-admin before touching the chain or the ledger", async () => {
    state.admin = false;
    const { status } = await call(reserveRoute, reserveParams(), STRANGER);
    expect(status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it("validates the terms", async () => {
    expect((await call(reserveRoute, { ...reserveParams(), min_price_per_unit: "1300000" })).status).toBe(400);
    expect((await call(reserveRoute, { ...reserveParams(), raise_type: "bridge" })).status).toBe(400);
    expect((await call(reserveRoute, { ...reserveParams(), max_gross_raise: "0" })).status).toBe(400);
    expect((await call(reserveRoute, { ...reserveParams(), expires_at: String(NOW + 91 * 86_400) })).status).toBe(400);
    expect((await call(reserveRoute, { ...reserveParams(), sale_id: "18446744073709551616" })).status).toBe(400);
    expect(rpcCall("reserve_sale_capacity")).toBeUndefined();
  });

  it("requires an approved application with the same raise type", async () => {
    state.rows.launch_applications = { ...APP_ROW, status: "pending" };
    expect((await call(reserveRoute, reserveParams())).status).toBe(409);
    state.rows.launch_applications = { ...APP_ROW, raise_type: "startup" };
    expect((await call(reserveRoute, reserveParams())).status).toBe(409);
    expect(rpcCall("reserve_sale_capacity")).toBeUndefined();
  });

  it("requires the issuer authority to be one of the applicant's wallets", async () => {
    state.issuerAuthority = STRANGER;
    const { status, body } = await call(reserveRoute, reserveParams());
    expect(status).toBe(409);
    expect(body.error).toMatch(/not a wallet of this applicant/);
  });

  it("refuses an id whose Sale or approval already exists", async () => {
    state.accounts.set(SALE, { exists: true });
    expect((await call(reserveRoute, reserveParams())).status).toBe(409);
    state.accounts.delete(SALE);
    state.accounts.set(APPROVAL, { exists: true });
    expect((await call(reserveRoute, reserveParams())).status).toBe(409);
    expect(rpcCall("reserve_sale_capacity")).toBeUndefined();
  });

  it("without an application needs the super admin and a reason", async () => {
    const manual = { ...reserveParams(), application_id: undefined, reason: "Platform SPV bridge round" };
    expect((await call(reserveRoute, manual)).status).toBe(403);
    state.superAdmin = true;
    expect((await call(reserveRoute, { ...manual, reason: "" })).status).toBe(400);
    expect((await call(reserveRoute, manual)).status).toBe(200);
    expect(rpcCall("reserve_sale_capacity")).toMatchObject({ p_application_id: null });
  });

  it("on mainnet an issuer's own admin key cannot approve its sale", async () => {
    state.network = "mainnet";
    state.issuerAuthority = ADMIN;
    state.rpc.applicant_wallets = [ADMIN];
    state.rows.launch_applications = { ...APP_ROW, network: "mainnet", applicant_wallet: ADMIN };
    expect((await call(reserveRoute, reserveParams())).status).toBe(403);
  });

  it("fixes the payout schedule: 0/0 for mature, the application's for startup", async () => {
    expect((await call(reserveRoute, { ...reserveParams(), cliff_months: 1, vesting_months: 12 })).status).toBe(400);
    state.rows.launch_applications = { ...APP_ROW, raise_type: "startup", cliff_months: 6, vesting_months: 24 };
    const startup = { ...reserveParams(), raise_type: "startup" };
    expect((await call(reserveRoute, { ...startup, cliff_months: 0, vesting_months: 12 })).status).toBe(409);
    expect((await call(reserveRoute, { ...startup, cliff_months: 6, vesting_months: 6 })).status).toBe(400);
    expect(rpcCall("reserve_sale_capacity")).toBeUndefined();
    expect((await call(reserveRoute, { ...startup, cliff_months: 6, vesting_months: 24 })).status).toBe(200);
    expect(rpcCall("reserve_sale_capacity")).toMatchObject({ p_raise_type: "startup", p_cliff_months: 6, p_vesting_months: 24 });
  });

  it("reserves with the chain-derived PDAs, the on-chain decimals and the pinned application hash", async () => {
    const { status, body } = await call(reserveRoute, reserveParams());
    expect(status).toBe(200);
    const expected = snapshotHash(
      applicationSnapshot(APP_ROW, {
        shareClass: state.fixtures.shareClass, saleId: BigInt(4), issuer: state.fixtures.issuer, paymentMint: MINT,
        maxGrossRaise: BigInt(250_000_000_000), minPricePerUnit: BigInt(1_000_000), maxPricePerUnit: BigInt(1_200_000),
        raiseType: "mature", expiresAt: BigInt(EXPIRES), cliffMonths: 0, vestingMonths: 0,
      }),
    ).hex;
    expect(body.data).toMatchObject({ reservation_id: RESERVATION_ID, approval_pda: APPROVAL, sale_pda: SALE, application_hash: expected });
    expect(rpcCall("reserve_sale_capacity")).toMatchObject({
      p_network: "devnet", p_share_class_pda: state.fixtures.shareClass, p_sale_id: "4", p_approval_pda: APPROVAL,
      p_sale_pda: SALE, p_issuer_pda: state.fixtures.issuer, p_asset_pda: state.fixtures.asset, p_spv_id: null,
      p_application_hash: expected, p_payment_decimals: 6, p_max_gross_raise: "250000000000", p_raise_type: "mature",
      p_reserved_by: ADMIN, p_expires_at: new Date(EXPIRES * 1000).toISOString(),
    });
  });
});

describe("confirm", () => {
  beforeEach(() => {
    state.rows.sale_capacity_reservations = reservation();
    state.rpc.confirm_sale_reservation = reservation({ chain_confirmed_at: new Date().toISOString() });
  });

  it("answers 409, counts the ON-CHAIN terms (adopt) and alerts when they differ", async () => {
    state.approval = onChainApproval({ maxGrossRaise: BigInt(250_000_000_001) });
    state.rpc.adopt_sale_approval = reservation({ action: "adopted_terms", over_cap: true });
    const { status, body } = await call(confirmRoute, { reservation_id: RESERVATION_ID });
    expect(status).toBe(409);
    expect(body.error).toMatch(/max_gross_raise.*over its raise cap.*revoke/);
    expect(rpcCall("adopt_sale_approval")).toMatchObject({ p_max_gross_raise: "250000000001", p_source: "confirm" });
    expect(state.calls.find((c) => c.kind === "insert" && c.target === "audit_events")?.args).toMatchObject({ ix_name: "sale_capacity_alert" });
    expect(state.calls.find((c) => c.kind === "update")?.args).toMatchObject({ last_error: expect.stringMatching(/max_gross_raise/) });
    expect(rpcCall("confirm_sale_reservation")).toBeUndefined();
  });

  it("answers 409 while the approval is not on-chain", async () => {
    expect((await call(confirmRoute, { reservation_id: RESERVATION_ID })).status).toBe(409);
  });

  it("confirms an exact match, including approved_by = the reserving admin", async () => {
    state.rpc.adopt_sale_approval = reservation({ action: "adopted_terms", over_cap: false });
    state.approval = onChainApproval({ approvedBy: STRANGER });
    expect((await call(confirmRoute, { reservation_id: RESERVATION_ID })).status).toBe(409);
    state.approval = onChainApproval();
    expect((await call(confirmRoute, { reservation_id: RESERVATION_ID })).status).toBe(200);
    expect(rpcCall("confirm_sale_reservation")).toMatchObject({ p_id: RESERVATION_ID });
  });
});

describe("release", () => {
  beforeEach(() => {
    state.rows.sale_capacity_reservations = reservation({ chain_confirmed_at: new Date().toISOString() });
    state.rpc.release_sale_reservation = reservation({ status: "released", release_reason: "tx_failed" });
  });
  const release = (extra: Record<string, unknown> = {}) =>
    call(releaseRoute, { reservation_id: RESERVATION_ID, reason: "tx_failed", ...extra });

  it("is refused while the approval still exists on-chain, or once a sale used it (one-slot read)", async () => {
    state.chainState.confirmed.approval = true;
    expect((await release()).status).toBe(409);
    state.chainState.confirmed = { approval: false, sale: true };
    expect((await release({ reason: "revoked" })).status).toBe(409);
    expect(rpcCall("release_sale_reservation")).toBeUndefined();
  });

  it("releases a confirmed approval that is gone with no sale (revoked)", async () => {
    expect((await release({ reason: "closed_unsold" })).status).toBe(400);
    const { status } = await release({ reason: "revoked" });
    expect(status).toBe(200);
    expect(rpcCall("release_sale_reservation")).toMatchObject({ p_id: RESERVATION_ID, p_reason: "revoked", p_by: ADMIN });
  });

  it("never releases an unconfirmed approval whose transaction may still land", async () => {
    state.rows.sale_capacity_reservations = reservation();
    // No proof at all, a signature not (yet) visible, or a blockhash still valid.
    expect((await release()).body.error).toMatch(/may still land/);
    expect((await release({ signature: "5".repeat(88) })).status).toBe(409);
    expect((await release({ last_valid_block_height: "1000" })).status).toBe(409);
    // Expired, but the approval exists at finalized (landed, then not yet visible at confirmed? no — still absent proof fails).
    state.expired = true;
    state.chainState.finalized.approval = true;
    expect((await release({ last_valid_block_height: "1000" })).status).toBe(409);
    expect(rpcCall("release_sale_reservation")).toBeUndefined();
  });

  it("releases an unconfirmed approval once its transaction provably cannot land", async () => {
    state.rows.sale_capacity_reservations = reservation();
    state.sigOutcome = "failed";
    expect((await release({ signature: "5".repeat(88) })).status).toBe(200);
    state.calls = [];
    state.sigOutcome = "unknown";
    state.expired = true;
    expect((await release({ last_valid_block_height: "1000" })).status).toBe(200);
    expect(rpcCall("release_sale_reservation")).toMatchObject({ p_reason: "tx_failed" });
  });

  it("a treasury mint needs the same proof, and a landed mint is booked, not released", async () => {
    state.rows.sale_capacity_reservations = reservation({ kind: "treasury_mint", approval_pda: null, sale_pda: null });
    expect((await release()).status).toBe(409);
    state.sigOutcome = "succeeded";
    expect((await release({ signature: "5".repeat(88), last_valid_block_height: "1" })).body.error).toMatch(/book it/);
    state.sigOutcome = "unknown";
    state.expired = true;
    expect((await release({ last_valid_block_height: "1000" })).status).toBe(200);
  });

  it("books instead of releasing a treasury mint found on the share class's finalized history", async () => {
    state.rows.sale_capacity_reservations = reservation({ kind: "treasury_mint", approval_pda: null, sale_pda: null, amount_units: "500" });
    state.expired = true;
    const sig = "5".repeat(88);
    state.signatures = { signatures: [{ signature: sig, blockTime: NOW }], complete: true };
    state.txs = { [sig]: treasuryTx(BigInt(500), sig) };
    state.rpc.book_treasury_mint = reservation({ kind: "treasury_mint", status: "booked", mint_signature: sig });
    const { status, body } = await release({ last_valid_block_height: "1000" });
    expect(status).toBe(409);
    expect(body.error).toMatch(/booked instead of released/);
    expect(rpcCall("book_treasury_mint")).toMatchObject({ p_id: RESERVATION_ID, p_signature: sig, p_issued_at: new Date(NOW * 1000).toISOString().slice(0, 10) });
    expect(rpcCall("release_sale_reservation")).toBeUndefined();
    // A history too long to read proves nothing: refused, left to the worker.
    state.calls = [];
    state.signatures = { signatures: [], complete: false };
    expect((await release({ last_valid_block_height: "1000" })).body.error).toMatch(/too long/);
    expect(rpcCall("release_sale_reservation")).toBeUndefined();
  });
});

describe("settle", () => {
  it("is gone: the server books closed sales (410), whoever asks, and books nothing", async () => {
    for (const wallet of [STRANGER, ISSUER_KEY, ADMIN]) {
      const { status, body } = await call(settleRoute, { sale: SALE }, wallet);
      expect(status).toBe(410);
      expect(body.error).toMatch(/booked by the server/);
    }
    expect(state.calls).toHaveLength(0);
  });
});

/** One mint_to_treasury of `amount` units of the fixture share class by ADMIN into ADMIN's account. */
function treasuryTx(amount: bigint, signature: string) {
  const data = getBase58Decoder().decode(getMintToTreasuryInstructionDataEncoder().encode({ amount }));
  const keys = [ADMIN, STRANGER, state.fixtures.issuer, state.fixtures.asset, state.fixtures.shareClass, MINT, ISSUER_KEY,
    TOKEN_PROGRAM, "SysvarRent111111111111111111111111111111111", ASSET_REGISTRY_PROGRAM_ADDRESS];
  return {
    transaction: { signatures: [signature], message: { accountKeys: keys, header: { numRequiredSignatures: 1 },
      instructions: [{ programIdIndex: 9, accounts: [0, 1, 2, 3, 4, 5, 6, 7, 8], data }] } },
    meta: { err: null, postTokenBalances: [{ accountIndex: 6, mint: MINT, owner: ADMIN }] },
  };
}

describe("treasury-mint book with signature (manual, D11)", () => {
  const BLOCK = 1_760_000_000; // 2025-10-09
  const sig = "5".repeat(88);
  const book = async (params: Record<string, unknown>, wallet = ADMIN) => {
    state.params = params;
    state.wallet = wallet;
    const response = await treasuryMintRoute(new Request("http://localhost/api/test", {
      method: "POST", body: JSON.stringify({ payload: { action: "saleApprovals.treasuryMintBook" } }),
    }));
    return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string; data?: Record<string, unknown> } };
  };
  beforeEach(() => {
    state.rows.sale_capacity_reservations = reservation({ kind: "treasury_mint", approval_pda: null, sale_pda: null, amount_units: "500" });
    state.txs = { [sig]: { ...treasuryTx(BigInt(500), sig), blockTime: BLOCK } };
  });

  it("checks the evidence and books at the mint's block date; over the cap it is booked and alerted", async () => {
    state.rpc.book_treasury_mint = reservation({ kind: "treasury_mint", status: "booked", mint_signature: sig, booked_amount_eur: 250000, over_cap: true });
    const { status, body } = await book({ reservation_id: RESERVATION_ID, signature: sig });
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ reservation_id: RESERVATION_ID, status: "booked", over_cap: true });
    expect(rpcCall("book_treasury_mint")).toMatchObject({ p_id: RESERVATION_ID, p_signature: sig, p_issued_at: "2025-10-09" });
    expect(JSON.stringify(rpcCall("raise_system_alert"))).toContain("ledger:over-cap");
  });

  it("refuses another admin, a wrong amount, and maps MINT_ALREADY_BOOKED to 409", async () => {
    expect((await book({ reservation_id: RESERVATION_ID, signature: sig }, STRANGER)).status).toBe(403);
    state.txs = { [sig]: { ...treasuryTx(BigInt(501), sig), blockTime: BLOCK } };
    expect((await book({ reservation_id: RESERVATION_ID, signature: sig })).status).toBeGreaterThanOrEqual(400);
    expect(rpcCall("book_treasury_mint")).toBeUndefined();
    state.txs = { [sig]: { ...treasuryTx(BigInt(500), sig), blockTime: BLOCK } };
    state.rpcErrors.book_treasury_mint = { code: "P0001", message: "MINT_ALREADY_BOOKED" };
    const refused = await book({ reservation_id: RESERVATION_ID, signature: sig });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/already booked/);
  });
});

describe("record-issuance (off-chain adjustment, Talas 5.1)", () => {
  const SPV_ID = "30000000-0000-4000-8000-000000000001";
  const today = () => new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const adjustment = (over: Record<string, unknown> = {}) => ({
    spv_id: SPV_ID, amount_eur: 100, issued_at: today(), reason_code: "off_platform_issuance",
    note: "Notarised share issue outside the platform", ...over,
  });

  it("records an adjustment through the ledger with a reason code and a server audit row, never a direct insert", async () => {
    state.rpc.record_spv_adjustment = { id: 1 };
    const { status } = await call(recordIssuanceRoute, adjustment());
    expect(status).toBe(200);
    expect(rpcCall("record_spv_adjustment")).toMatchObject({
      p_spv_id: SPV_ID, p_amount_eur: 100, p_recorded_by: ADMIN, p_cap_override: false, p_allow_backdate: false,
      p_reason_code: "off_platform_issuance", p_note: "Notarised share issue outside the platform", p_asset_pda: null,
    });
    expect(rpcCall("record_spv_issuance")).toBeUndefined();
    const inserts = state.calls.filter((c) => c.kind === "insert");
    expect(inserts.map((c) => c.target)).toEqual(["audit_events"]);
    expect(inserts[0].args).toMatchObject({ ix_name: "spv_adjustment", actor_wallet: ADMIN, target_label: SPV_ID });
  });

  it("requires a reason code and a note of 10 characters; never a sale (no source, no sale_pubkey)", async () => {
    expect((await call(recordIssuanceRoute, adjustment({ reason_code: undefined }))).status).toBe(400);
    expect((await call(recordIssuanceRoute, adjustment({ reason_code: "sale" }))).status).toBe(400);
    expect((await call(recordIssuanceRoute, adjustment({ note: "too short" }))).status).toBe(400);
    expect((await call(recordIssuanceRoute, adjustment({ sale_pubkey: SALE }))).status).toBe(400);
    const gone = await call(recordIssuanceRoute, adjustment({ source: "sale" }));
    expect(gone.status).toBe(410);
    expect(gone.body.error).toMatch(/booked by the server/);
    expect(rpcCall("record_spv_adjustment")).toBeUndefined();
  });

  it("needs the super admin to backdate more than 30 days or to override the cap", async () => {
    state.rpc.record_spv_adjustment = { id: 1 };
    expect((await call(recordIssuanceRoute, adjustment({ issued_at: daysAgo(40) }))).status).toBe(403);
    expect((await call(recordIssuanceRoute, adjustment({ cap_override: true }))).status).toBe(403);
    expect(rpcCall("record_spv_adjustment")).toBeUndefined();
    state.superAdmin = true;
    expect((await call(recordIssuanceRoute, adjustment({ issued_at: daysAgo(40) }))).status).toBe(200);
    expect(rpcCall("record_spv_adjustment")).toMatchObject({ p_allow_backdate: true, p_cap_override: false });
    state.superAdmin = false;
  });

  it("answers POSSIBLE_DUPLICATE with the asset's server bookings unless the admin confirms", async () => {
    state.rpc.record_spv_adjustment = { id: 2 };
    state.lists.spv_issuances = [{ issued_at: today(), amount_eur: 500, source: "sale" }];
    const first = await call(recordIssuanceRoute, adjustment({ asset_pda: state.fixtures.asset }));
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ ok: false, code: "POSSIBLE_DUPLICATE", data: { bookings: [{ amount_eur: 500, source: "sale" }] } });
    expect(first.body.error).toMatch(/^Possible duplicate/);
    expect(rpcCall("record_spv_adjustment")).toBeUndefined();
    const confirmed = await call(recordIssuanceRoute, adjustment({ asset_pda: state.fixtures.asset, confirm_not_duplicate: true }));
    expect(confirmed.status).toBe(200);
    expect(rpcCall("record_spv_adjustment")).toMatchObject({ p_asset_pda: state.fixtures.asset });
  });

  it("maps the ledger's refusals (REF_IS_SALE, SUBJECT_ON_HOLD)", async () => {
    for (const [code, status, text] of [["REF_IS_SALE", 409, /on-chain sale/], ["SUBJECT_ON_HOLD", 409, /on hold/]] as const) {
      state.rpcErrors = { record_spv_adjustment: { code: "P0001", message: code } };
      const { status: got, body } = await call(recordIssuanceRoute, adjustment());
      expect(got).toBe(status);
      expect(body.error).toMatch(text);
    }
    state.rpcErrors = {};
  });
});

describe("treasury-revalue", () => {
  const params = { reservation_id: RESERVATION_ID, amount_eur: 2500, reason: "Independent appraisal of the units" };

  it("is the super admin's alone, audited, and raises a REVALUED ledger alert", async () => {
    state.rpc.revalue_treasury_mint = { ...reservation({ kind: "treasury_mint", status: "booked", adopted: true, amount_eur: 2500 }), previous_amount_eur: 1800, over_cap: false };
    expect((await call(treasuryRevalueRoute, params)).status).toBe(403);
    expect(rpcCall("revalue_treasury_mint")).toBeUndefined();
    state.superAdmin = true;
    const { status, body } = await call(treasuryRevalueRoute, params);
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ amount_eur: 2500, previous_amount_eur: 1800, over_cap: false });
    expect(rpcCall("revalue_treasury_mint")).toMatchObject({ p_id: RESERVATION_ID, p_amount_eur: 2500, p_by: ADMIN });
    expect(rpcCall("raise_system_alert")).toMatchObject({ p_source: "ledger:revalued", p_severity: "medium" });
    expect(state.calls.find((c) => c.kind === "insert" && c.target === "audit_events")?.args).toMatchObject({ ix_name: "treasury_mint_revalue" });
    state.superAdmin = false;
  });

  it("validates the value and the reason, and maps a value below the floor", async () => {
    state.superAdmin = true;
    expect((await call(treasuryRevalueRoute, { ...params, reason: "short" })).status).toBe(400);
    expect((await call(treasuryRevalueRoute, { ...params, amount_eur: -1 })).status).toBe(400);
    state.rpcErrors = { revalue_treasury_mint: { code: "P0001", message: "TREASURY_VALUE_BELOW_FLOOR floor=1800.00" } };
    const { status, body } = await call(treasuryRevalueRoute, params);
    expect(status).toBe(409);
    expect(body.error).toMatch(/below the floor/);
    state.rpcErrors = {};
    state.superAdmin = false;
  });
});
