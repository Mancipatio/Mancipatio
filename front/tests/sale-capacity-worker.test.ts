// Retry-worker stage for raise-cap reservations (lib/server/sale-capacity.ts
// reconcileSaleCapacity): every step a browser may leave undone is finished
// from chain state. RPC and Supabase are mocked; the stage runs for real.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  approval: null as Record<string, unknown> | null,
  confirmedSale: null as Record<string, unknown> | null,
  finalizedSale: null as Record<string, unknown> | null,
  rpc: {} as Record<string, unknown>,
  calls: [] as Array<{ kind: string; target: string; args: unknown }>,
}));

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/generated/asset_registry")>();
  const account = (data: Record<string, unknown> | null) =>
    data ? { exists: true, programAddress: original.ASSET_REGISTRY_PROGRAM_ADDRESS, data } : { exists: false };
  return {
    ...original,
    fetchMaybeSaleApproval: vi.fn(async () => account(state.approval)),
    fetchMaybeSale: vi.fn(async (_rpc: unknown, _key: unknown, config: { commitment: string }) =>
      account(config.commitment === "finalized" ? state.finalizedSale : state.confirmedSale),
    ),
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
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: table === "sale_capacity_reservations" ? state.rows : null, error: null }).then(resolve, reject),
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

import { RaiseType, SaleStatus } from "@/lib/generated/asset_registry";
import { reconcileSaleCapacity } from "@/lib/server/sale-capacity";

const ADMIN = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const SC = "ShareC1ass111111111111111111111111111111111";
const ISSUER = "Issuer111111111111111111111111111111111111";
const MINT = "EURCmint11111111111111111111111111111111111";
const APPROVAL = "Approva1111111111111111111111111111111111111";
const SALE = "SysvarRent111111111111111111111111111111111";
const EXPIRES = Math.floor(Date.now() / 1000) + 86_400;
const OLD = new Date(Date.now() - 10 * 60_000).toISOString();

const row = (over: Record<string, unknown> = {}) => ({
  id: "1b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0c", network: "devnet", kind: "sale", share_class_pda: SC, sale_id: "4",
  approval_pda: APPROVAL, sale_pda: SALE, issuer_pda: ISSUER, subject: `issuer:${ISSUER}`, payment_mint: MINT,
  payment_decimals: 6, max_gross_raise: "1000000", min_price_per_unit: "10", max_price_per_unit: "10",
  raise_type: "mature", expires_at: new Date(EXPIRES * 1000).toISOString(), application_hash: "ab".repeat(32),
  amount_eur: 1, status: "reserved", chain_confirmed_at: null, reserved_by: ADMIN, created_at: OLD, updated_at: OLD,
  ...over,
});
const approval = (over: Record<string, unknown> = {}) => ({
  shareClass: SC, saleId: BigInt(4), issuer: ISSUER, paymentMint: MINT, maxGrossRaise: BigInt(1_000_000),
  minPricePerUnit: BigInt(10), maxPricePerUnit: BigInt(10), raiseType: RaiseType.Mature, expiresAt: BigInt(EXPIRES),
  applicationHash: new Uint8Array(32).fill(0xab), approvedBy: ADMIN, ...over,
});
const sale = (over: Record<string, unknown> = {}) => ({
  saleApproval: APPROVAL, pricePerUnit: BigInt(10), totalForSale: BigInt(100_000), sold: BigInt(40_000),
  status: SaleStatus.Closed, ...over,
});
const rpcs = () => state.calls.filter((c) => c.kind === "rpc").map((c) => c.target);
const rpcArgs = (fn: string) => state.calls.find((c) => c.kind === "rpc" && c.target === fn)?.args as Record<string, unknown>;

beforeEach(() => {
  state.rows = [];
  state.approval = null;
  state.confirmedSale = null;
  state.finalizedSale = null;
  state.calls = [];
  state.rpc = {
    confirm_sale_reservation: row({ chain_confirmed_at: OLD }),
    consume_sale_reservation: row({ status: "consumed" }),
    book_sale_reservation: row({ status: "booked" }),
    release_sale_reservation: row({ status: "released" }),
  };
});

describe("reconcileSaleCapacity", () => {
  it("leaves a fresh unconfirmed reservation to the admin's browser", async () => {
    state.rows = [row({ created_at: new Date().toISOString() })];
    expect(await reconcileSaleCapacity(5)).toEqual({ complete: 0, pending: 1, invalid: 0 });
    expect(rpcs()).toEqual([]);
  });

  it("confirms a matching on-chain approval nobody confirmed", async () => {
    state.rows = [row()];
    state.approval = approval();
    expect(await reconcileSaleCapacity(5)).toMatchObject({ pending: 1 });
    expect(rpcs()).toEqual(["confirm_sale_reservation"]);
  });

  it("alerts instead of confirming a mismatched approval", async () => {
    state.rows = [row()];
    state.approval = approval({ maxGrossRaise: BigInt(2_000_000) });
    await reconcileSaleCapacity(5);
    expect(rpcs()).toEqual([]);
    expect(state.calls.find((c) => c.kind === "insert" && c.target === "audit_events")?.args).toMatchObject({
      ix_name: "sale_capacity_alert", status: "failed", reason: expect.stringMatching(/max_gross_raise/),
    });
  });

  it("releases a transaction that never landed (tx_failed) and a revoked approval (revoked)", async () => {
    state.rows = [row()];
    expect(await reconcileSaleCapacity(5)).toMatchObject({ complete: 1 });
    expect(rpcArgs("release_sale_reservation")).toMatchObject({ p_reason: "tx_failed" });
    state.calls = [];
    state.rows = [row({ chain_confirmed_at: OLD })];
    await reconcileSaleCapacity(5);
    expect(rpcArgs("release_sale_reservation")).toMatchObject({ p_reason: "revoked" });
  });

  it("releases an expired, unused approval after the grace hour", async () => {
    const expiredAt = (secondsAgo: number) => Math.floor(Date.now() / 1000) - secondsAgo;
    const expired = (at: number) => {
      state.rows = [row({ chain_confirmed_at: OLD, expires_at: new Date(at * 1000).toISOString() })];
      state.approval = approval({ expiresAt: BigInt(at) });
    };
    expired(expiredAt(3_700));
    await reconcileSaleCapacity(5);
    expect(rpcArgs("release_sale_reservation")).toMatchObject({ p_reason: "expired" });
    state.calls = [];
    // Within the grace hour (chain clock drift) it stays reserved.
    expired(expiredAt(60));
    await reconcileSaleCapacity(5);
    expect(rpcs()).toEqual([]);
  });

  it("consumes the approval a sale used, then books sold x price once the sale is closed and final", async () => {
    state.rows = [row({ chain_confirmed_at: OLD })];
    state.confirmedSale = sale();
    state.finalizedSale = sale();
    expect(await reconcileSaleCapacity(5)).toMatchObject({ complete: 1 });
    expect(rpcs()).toEqual(["consume_sale_reservation", "book_sale_reservation"]);
    expect(rpcArgs("consume_sale_reservation")).toMatchObject({ p_sale_gross_max: "1000000" });
    expect(rpcArgs("book_sale_reservation")).toMatchObject({ p_gross_base_units: "400000" });
  });

  it("books a consumed reservation when its sale closes, and waits while it is open", async () => {
    state.rows = [row({ status: "consumed" })];
    state.finalizedSale = sale({ status: SaleStatus.Open });
    expect(await reconcileSaleCapacity(5)).toMatchObject({ pending: 1 });
    expect(rpcs()).toEqual([]);
    state.finalizedSale = sale();
    expect(await reconcileSaleCapacity(5)).toMatchObject({ complete: 1 });
    expect(rpcs()).toEqual(["book_sale_reservation"]);
  });

  it("alerts when the sale id was opened with another approval", async () => {
    state.rows = [row({ chain_confirmed_at: OLD })];
    state.confirmedSale = sale({ saleApproval: SC });
    await reconcileSaleCapacity(5);
    expect(rpcs()).toEqual([]);
    expect(state.calls.some((c) => c.target === "audit_events")).toBe(true);
  });
});
