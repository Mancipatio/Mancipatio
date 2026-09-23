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
  rows: {} as Record<string, unknown>,
  lists: {} as Record<string, unknown[]>,
  rpc: {} as Record<string, unknown>,
  calls: [] as Array<{ kind: string; target: string; args: unknown }>,
  fixtures: { issuer: "", asset: "", shareClass: "", assetId: "sale-approval-01", legalEntityId: new Uint8Array(32) },
}));

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => state.network,
}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
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
        select: chain, eq: chain, in: chain, order: chain, limit: chain, abortSignal: chain,
        update: write("update"), insert: write("insert"),
        maybeSingle: async () => ({ data: state.rows[table] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: state.lists[table] ?? [], error: null }).then(resolve, reject),
      });
      return builder;
    },
    rpc: (fn: string, args: unknown) => {
      state.calls.push({ kind: "rpc", target: fn, args });
      const result = { data: state.rpc[fn] ?? null, error: null };
      return Object.assign(Promise.resolve(result), { abortSignal: () => Promise.resolve(result) });
    },
  }),
}));

import { findAssetPda, findIssuerPda, findSaleApprovalPda, RaiseType, SaleStatus } from "@/lib/generated/asset_registry";
import { findSalePda, findShareClassPda } from "@/lib/pdas";
import { applicationSnapshot, snapshotHash, TOKEN_PROGRAM } from "@/lib/server/sale-capacity";
import { POST as reserveRoute } from "@/app/api/sale-approvals/reserve/route";
import { POST as confirmRoute } from "@/app/api/sale-approvals/confirm/route";
import { POST as releaseRoute } from "@/app/api/sale-approvals/release/route";
import { POST as settleRoute } from "@/app/api/sale-approvals/settle/route";
import { POST as recordIssuanceRoute } from "@/app/api/spvs/record-issuance/route";

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
  min_price_per_unit: "1000000", max_price_per_unit: "1200000", raise_type: "mature",
  expires_at: new Date(EXPIRES * 1000).toISOString(), amount_units: null, amount_eur: 250000, status: "reserved",
  chain_confirmed_at: null, approve_signature: null, mint_signature: null, booked_amount_eur: null,
  release_reason: null, reason: null, last_error: null, reserved_by: ADMIN, created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(), ...over,
});
const onChainApproval = (over: Record<string, unknown> = {}) => ({
  shareClass: state.fixtures.shareClass, saleId: BigInt(4), issuer: state.fixtures.issuer, paymentMint: MINT,
  maxGrossRaise: BigInt(250_000_000_000), minPricePerUnit: BigInt(1_000_000), maxPricePerUnit: BigInt(1_200_000),
  raiseType: RaiseType.Mature, expiresAt: BigInt(EXPIRES), applicationHash: new Uint8Array(32).fill(0xab),
  approvedBy: ADMIN, bump: 255, version: 1, ...over,
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
  state.rows = { launch_applications: APP_ROW, asset_profiles: { spv_id: null } };
  state.lists = {};
  state.rpc = {
    applicant_wallets: [ISSUER_KEY],
    reserve_sale_capacity: { id: RESERVATION_ID, amount_eur: 250000, subject: "issuer:x", existing: false, capacity: {} },
  };
  state.calls = [];
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

  it("reserves with the chain-derived PDAs, the on-chain decimals and the pinned application hash", async () => {
    const { status, body } = await call(reserveRoute, reserveParams());
    expect(status).toBe(200);
    const expected = snapshotHash(
      applicationSnapshot(APP_ROW, {
        shareClass: state.fixtures.shareClass, saleId: BigInt(4), issuer: state.fixtures.issuer, paymentMint: MINT,
        maxGrossRaise: BigInt(250_000_000_000), minPricePerUnit: BigInt(1_000_000), maxPricePerUnit: BigInt(1_200_000),
        raiseType: "mature", expiresAt: BigInt(EXPIRES),
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

  it("answers 409 and records the mismatch when the on-chain terms differ", async () => {
    state.approval = onChainApproval({ maxGrossRaise: BigInt(250_000_000_001) });
    const { status, body } = await call(confirmRoute, { reservation_id: RESERVATION_ID });
    expect(status).toBe(409);
    expect(body.error).toMatch(/max_gross_raise/);
    expect(state.calls.find((c) => c.kind === "update")?.args).toMatchObject({ last_error: expect.stringMatching(/max_gross_raise/) });
    expect(rpcCall("confirm_sale_reservation")).toBeUndefined();
  });

  it("answers 409 while the approval is not on-chain", async () => {
    expect((await call(confirmRoute, { reservation_id: RESERVATION_ID })).status).toBe(409);
  });

  it("confirms an exact match, including approved_by = the reserving admin", async () => {
    state.approval = onChainApproval({ approvedBy: STRANGER });
    expect((await call(confirmRoute, { reservation_id: RESERVATION_ID })).status).toBe(409);
    state.approval = onChainApproval();
    expect((await call(confirmRoute, { reservation_id: RESERVATION_ID })).status).toBe(200);
    expect(rpcCall("confirm_sale_reservation")).toMatchObject({ p_id: RESERVATION_ID });
  });
});

describe("release", () => {
  beforeEach(() => {
    state.rows.sale_capacity_reservations = reservation();
    state.rpc.release_sale_reservation = reservation({ status: "released", release_reason: "tx_failed" });
  });

  it("is refused while the approval still exists on-chain, or once a sale used it", async () => {
    state.accounts.set(APPROVAL, { exists: true });
    expect((await call(releaseRoute, { reservation_id: RESERVATION_ID, reason: "tx_failed" })).status).toBe(409);
    state.accounts.delete(APPROVAL);
    state.accounts.set(SALE, { exists: true });
    expect((await call(releaseRoute, { reservation_id: RESERVATION_ID, reason: "revoked" })).status).toBe(409);
    expect(rpcCall("release_sale_reservation")).toBeUndefined();
  });

  it("releases when the chain proves the approval can no longer be used", async () => {
    expect((await call(releaseRoute, { reservation_id: RESERVATION_ID, reason: "closed_unsold" })).status).toBe(400);
    const { status } = await call(releaseRoute, { reservation_id: RESERVATION_ID, reason: "tx_failed" });
    expect(status).toBe(200);
    expect(rpcCall("release_sale_reservation")).toMatchObject({ p_id: RESERVATION_ID, p_reason: "tx_failed", p_by: ADMIN });
  });
});

describe("settle", () => {
  beforeEach(() => {
    state.admin = false;
    state.sale = {
      shareClass: state.fixtures.shareClass, saleId: BigInt(4), pricePerUnit: BigInt(1_000_000), totalForSale: BigInt(200_000),
      sold: BigInt(150_000), status: SaleStatus.Closed, saleApproval: APPROVAL, raiseType: RaiseType.Mature,
    };
    state.lists.sale_capacity_reservations = [reservation({ status: "consumed" })];
    state.rpc.book_sale_reservation = reservation({ status: "booked", booked_amount_eur: 150000 });
  });

  it("is the sale's issuer authority or an admin, nobody else", async () => {
    expect((await call(settleRoute, { sale: SALE }, STRANGER)).status).toBe(403);
    const { status, body } = await call(settleRoute, { sale: SALE }, ISSUER_KEY);
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ status: "booked", booked_amount_eur: 150000 });
    // sold x price, never a browser-supplied amount.
    expect(rpcCall("book_sale_reservation")).toMatchObject({ p_id: RESERVATION_ID, p_gross_base_units: "150000000000" });
    state.admin = true;
    expect((await call(settleRoute, { sale: SALE }, STRANGER)).status).toBe(200);
  });

  it("consumes a still-reserved row first, and does not book an open sale", async () => {
    state.lists.sale_capacity_reservations = [reservation()];
    state.rpc.consume_sale_reservation = reservation({ status: "consumed" });
    state.sale = { ...state.sale!, status: SaleStatus.Open };
    const { status, body } = await call(settleRoute, { sale: SALE }, ISSUER_KEY);
    expect(status).toBe(200);
    expect(body.data?.status).toBe("consumed");
    expect(rpcCall("consume_sale_reservation")).toMatchObject({ p_sale_pda: SALE, p_sale_gross_max: "200000000000" });
    expect(rpcCall("book_sale_reservation")).toBeUndefined();
  });

  it("refuses a sale whose approval has no reservation", async () => {
    state.lists.sale_capacity_reservations = [];
    expect((await call(settleRoute, { sale: SALE }, ISSUER_KEY)).status).toBe(409);
  });
});

describe("record-issuance", () => {
  it("no longer books sale proceeds from the browser (410)", async () => {
    const { status, body } = await call(recordIssuanceRoute, {
      spv_id: "30000000-0000-4000-8000-000000000001", amount_eur: 100, source: "sale", asset_pda: state.fixtures.asset,
    });
    expect(status).toBe(410);
    expect(body.error).toMatch(/booked by the server/);
    expect(state.calls.filter((c) => c.kind === "insert")).toHaveLength(0);
  });
});
