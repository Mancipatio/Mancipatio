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
  live: [] as Record<string, unknown>[],
  failRead: false,
  sales: [] as Record<string, unknown>[],
  signatures: { signatures: [] as Array<{ signature: string; blockTime: number }>, complete: true },
  txs: {} as Record<string, unknown>,
  rpc: {} as Record<string, unknown>,
  calls: [] as Array<{ kind: string; target: string; args: unknown }>,
}));

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/server/sale-capacity-chain", () => ({
  // One slot for the approval and the sale (the worker never reads them apart).
  readApprovalAndSale: vi.fn(async () => {
    if (state.failRead) throw new Error("rpc down");
    return { approval: state.approval, sale: state.confirmedSale };
  }),
  listLiveApprovals: vi.fn(async () => state.live),
  listFinalizedSignatures: vi.fn(async () => state.signatures),
  finalizedTransaction: vi.fn(async (sig: string) => state.txs[sig] ?? null),
}));
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
    fetchMaybeShareClass: vi.fn(async () => account({ asset: "Asset11111111111111111111111111111111111111" })),
    fetchMaybeAsset: vi.fn(async () => account({ issuer: "Issuer111111111111111111111111111111111111" })),
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
        not: chain, gte: chain, lte: chain, is: chain,
        maybeSingle: async () => ({ data: { spv_id: null }, error: null }),
        update: write("update"), insert: write("insert"),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({
            data: table === "sale_capacity_reservations" ? state.rows : table === "sales" ? state.sales : null, error: null,
          }).then(resolve, reject),
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
  raise_type: "mature", cliff_months: 0, vesting_months: 0, expires_at: new Date(EXPIRES * 1000).toISOString(), application_hash: "ab".repeat(32),
  amount_eur: 1, status: "reserved", chain_confirmed_at: null, reserved_by: ADMIN, created_at: OLD, updated_at: OLD,
  ...over,
});
const approval = (over: Record<string, unknown> = {}) => ({
  shareClass: SC, saleId: BigInt(4), issuer: ISSUER, paymentMint: MINT, maxGrossRaise: BigInt(1_000_000),
  minPricePerUnit: BigInt(10), maxPricePerUnit: BigInt(10), raiseType: RaiseType.Mature, expiresAt: BigInt(EXPIRES),
  applicationHash: new Uint8Array(32).fill(0xab), approvedBy: ADMIN, cliffMonths: 0, vestingMonths: 0, ...over,
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
  state.live = [];
  state.failRead = false;
  state.sales = [];
  state.signatures = { signatures: [], complete: true };
  state.txs = {};
  state.rpc = {
    adopt_sale_approval: row({ action: "adopted_terms", over_cap: false, last_error: "Adopted" }),
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

  it("adopts the on-chain terms of a mismatched approval (never less than reserved) and alerts", async () => {
    state.rows = [row()];
    state.approval = approval({ maxGrossRaise: BigInt(2_000_000) });
    await reconcileSaleCapacity(5);
    expect(rpcs()).toEqual(["adopt_sale_approval"]);
    expect(rpcArgs("adopt_sale_approval")).toMatchObject({ p_max_gross_raise: "2000000", p_approved_by: ADMIN, p_source: "worker" });
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

describe("reconcileSaleCapacity — review follow-ups", () => {
  it("adopts an on-chain approval that has no live reservation (orphan scan) and alerts once", async () => {
    state.live = [{ ...approval({ approvedBy: "Stranger1111111111111111111111111111111111" }), address: APPROVAL }];
    state.rpc.adopt_sale_approval = row({ action: "inserted", over_cap: true, last_error: "Adopted" });
    await reconcileSaleCapacity(5);
    expect(rpcArgs("adopt_sale_approval")).toMatchObject({ p_approval_pda: APPROVAL, p_source: "orphan-scan", p_spv_id: null });
    const alerts = state.calls.filter((c) => c.kind === "insert" && c.target === "audit_events");
    expect(alerts).toHaveLength(1);
    expect((alerts[0].args as { reason: string }).reason).toMatch(/no live reservation.*OVER its raise cap/);
  });

  it("does not adopt an approval that a live reservation covers", async () => {
    state.live = [{ ...approval(), address: APPROVAL }];
    state.rows = [row({ created_at: new Date().toISOString() })];
    // The builder returns state.rows for every select: the live set covers APPROVAL.
    state.rows = [{ ...state.rows[0], approval_pda: APPROVAL }];
    await reconcileSaleCapacity(5);
    expect(rpcs()).not.toContain("adopt_sale_approval");
  });

  it("rotates a row that keeps failing instead of starving the rest", async () => {
    state.rows = [row()];
    state.failRead = true;
    expect(await reconcileSaleCapacity(5)).toMatchObject({ pending: 1 });
    const touch = state.calls.find((c) => c.kind === "update" && c.target === "sale_capacity_reservations");
    expect(touch?.args).toMatchObject({ last_error: expect.stringMatching(/Worker: rpc down/), updated_at: expect.any(String) });
  });

  it("raises a repeated alert only once (same last_error)", async () => {
    state.rows = [row({ chain_confirmed_at: OLD, last_error: "A sale exists for this id but consumed a different approval" })];
    state.confirmedSale = sale({ saleApproval: SC });
    await reconcileSaleCapacity(5);
    expect(state.calls.some((c) => c.target === "audit_events")).toBe(false);
  });

  it("alerts when a sale was larger than its reservation (the ledger grew it)", async () => {
    state.rows = [row({ chain_confirmed_at: OLD })];
    state.confirmedSale = sale({ status: SaleStatus.Open });
    state.finalizedSale = sale({ status: SaleStatus.Open, totalForSale: BigInt(200_000) });
    state.rpc.consume_sale_reservation = row({ status: "consumed", grew: true, last_error: "The sale (gross 2000000) is larger" });
    await reconcileSaleCapacity(5);
    expect(rpcArgs("consume_sale_reservation")).toMatchObject({ p_sale_gross_max: "2000000" });
    expect(state.calls.some((c) => c.target === "audit_events")).toBe(true);
  });
});

// ── Orphan sales and treasury-mint rows ───────────────────────────────────

import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getMintToTreasuryInstructionDataEncoder,
} from "@/lib/generated/asset_registry";
import { getBase58Decoder } from "@solana/kit";
import { findSalePda } from "@/lib/pdas";

const SIG = "5".repeat(88);
const DEST = "Dest111111111111111111111111111111111111111";
const treasuryRow = (over: Record<string, unknown> = {}) => row({
  kind: "treasury_mint", sale_id: null, approval_pda: null, sale_pda: null, payment_mint: null, amount_units: "500",
  amount_eur: 1000, reason: "Founder allocation", ...over,
});
/** A finalized transaction with one mint_to_treasury of `amount` units of SC by ADMIN into ADMIN's account. */
function treasuryTx(amount: bigint, signature = SIG, owner = ADMIN) {
  const data = getBase58Decoder().decode(getMintToTreasuryInstructionDataEncoder().encode({ amount }));
  const keys = [ADMIN, "AdminRec1111111111111111111111111111111111", ISSUER, "Asset11111111111111111111111111111111111111",
    SC, "Mint111111111111111111111111111111111111111", DEST, "Tok11111111111111111111111111111111111111111",
    "P1atform11111111111111111111111111111111111", ASSET_REGISTRY_PROGRAM_ADDRESS];
  return {
    transaction: { signatures: [signature], message: { accountKeys: keys, header: { numRequiredSignatures: 1 },
      instructions: [{ programIdIndex: 9, accounts: [0, 1, 2, 3, 4, 5, 6, 7, 8], data }] } },
    meta: { err: null, postTokenBalances: [{ accountIndex: 6, mint: keys[5], owner }] },
  };
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("reconcileSaleCapacity — orphan sales and treasury mints", () => {
  it("adopts an indexed sale no reservation covers: counted at its own terms, consumed, booked, alerted", async () => {
    const salePda = await findSalePda(SC as never, BigInt(4));
    state.sales = [{ pda: salePda, sale_approval: APPROVAL }];
    state.finalizedSale = sale({
      shareClass: SC, saleId: BigInt(4), paymentMint: MINT, raiseType: RaiseType.Mature, cliffMonths: 0, vestingMonths: 0,
      applicationHash: new Uint8Array(32).fill(0xcd),
    });
    state.rpc.adopt_sale_approval = row({ sale_pda: salePda, action: "inserted", over_cap: true, last_error: null });
    await reconcileSaleCapacity(5);
    expect(rpcArgs("adopt_sale_approval")).toMatchObject({
      p_sale_pda: salePda, p_approval_pda: APPROVAL, p_max_gross_raise: "1000000", p_min_price_per_unit: "10",
      p_max_price_per_unit: "10", p_application_hash: "cd".repeat(32), p_source: "orphan-sale-scan",
    });
    expect(rpcs()).toEqual(["sale_capacity_spv", "adopt_sale_approval", "consume_sale_reservation", "book_sale_reservation"]);
    expect(state.calls.find((c) => c.kind === "insert" && c.target === "audit_events")?.args).toMatchObject({
      ix_name: "sale_capacity_alert", reason: expect.stringMatching(/no live reservation.*OVER its raise cap/),
    });
  });

  it("leaves a sale alone when a reservation covers it (or it closed unsold), and skips a stale mirror row", async () => {
    const salePda = await findSalePda(SC as never, BigInt(4));
    state.sales = [{ pda: salePda, sale_approval: APPROVAL }];
    state.finalizedSale = sale({ shareClass: SC, saleId: BigInt(4) });
    state.rows = [row({ sale_pda: salePda, status: "released", release_reason: "closed_unsold" })];
    await reconcileSaleCapacity(5);
    expect(rpcs()).not.toContain("adopt_sale_approval");
    state.rows = [];
    state.finalizedSale = sale({ shareClass: SC, saleId: BigInt(5) });
    await reconcileSaleCapacity(5);
    expect(rpcs()).not.toContain("adopt_sale_approval");
  });

  it("books a treasury mint the browser never booked, found on the share class's finalized history", async () => {
    state.rows = [treasuryRow()];
    state.signatures = { signatures: [{ signature: "4".repeat(88), blockTime: 1 }, { signature: SIG, blockTime: 2 }], complete: true };
    // The first transaction mints another amount: not this reservation's.
    state.txs = { ["4".repeat(88)]: treasuryTx(BigInt(499), "4".repeat(88)), [SIG]: treasuryTx(BigInt(500)) };
    state.rpc.book_treasury_mint = treasuryRow({ status: "booked", mint_signature: SIG });
    expect(await reconcileSaleCapacity(5)).toMatchObject({ complete: 1 });
    expect(rpcArgs("book_treasury_mint")).toMatchObject({ p_id: row().id, p_signature: SIG });
  });

  it("never books a mint into an account the admin does not own", async () => {
    state.rows = [treasuryRow()];
    state.signatures = { signatures: [{ signature: SIG, blockTime: 2 }], complete: true };
    state.txs = { [SIG]: treasuryTx(BigInt(500), SIG, "Someone111111111111111111111111111111111111") };
    await reconcileSaleCapacity(5);
    expect(rpcs()).toEqual([]);
  });

  it("expires a treasury reservation with no mint after 30 minutes, but not a younger one or an unread history", async () => {
    state.rows = [treasuryRow({ created_at: minutesAgo(10) })];
    await reconcileSaleCapacity(5);
    expect(rpcs()).toEqual([]);
    state.rows = [treasuryRow({ created_at: minutesAgo(40) })];
    state.signatures = { signatures: [], complete: false };
    await reconcileSaleCapacity(5);
    expect(rpcs()).toEqual([]);
    state.signatures = { signatures: [], complete: true };
    expect(await reconcileSaleCapacity(5)).toMatchObject({ complete: 1 });
    expect(rpcArgs("release_sale_reservation")).toMatchObject({ p_reason: "expired", p_by: "retry-worker" });
  });

  it("rechecks a released treasury row and counts a mint that landed before the release", async () => {
    state.rows = [treasuryRow({ status: "released", release_reason: "tx_failed", released_at: minutesAgo(20) })];
    state.signatures = { signatures: [{ signature: SIG, blockTime: 2 }], complete: true };
    state.txs = { [SIG]: treasuryTx(BigInt(500)) };
    state.rpc.book_treasury_mint = treasuryRow({ status: "booked", mint_signature: SIG, adopted: true });
    await reconcileSaleCapacity(5);
    expect(rpcArgs("book_treasury_mint")).toMatchObject({ p_signature: SIG });
    expect(state.calls.find((c) => c.kind === "insert" && c.target === "audit_events")?.args).toMatchObject({
      reason: expect.stringMatching(/landed although its reservation was released/),
    });
  });
});
