// Talas 4.2 §3.5: the orphan-approval scan adopts every on-chain approval on
// its own. One whose payment mint has no EUR rate (FX_RATE_MISSING) used to
// abort the whole scan on every run, so every approval behind it was never
// counted and nothing raised an alarm. Now it raises one deduplicated
// compliance alert and the scan continues. RPC and Supabase are mocked; the
// stage runs for real.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Alert = { network: string; source: string; severity: string; wallet: string | null; status: string; evidence: Record<string, unknown>; summary: string };
const state = vi.hoisted(() => ({
  network: "devnet" as "devnet" | "mainnet",
  live: [] as Record<string, unknown>[],
  sales: [] as Record<string, unknown>[],
  finalizedSale: null as Record<string, unknown> | null,
  missingFx: new Set<string>(),
  alerts: [] as Alert[],
  adopted: [] as string[],
  audit: 0,
}));

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => state.network,
}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/server/sale-capacity-chain", () => ({
  readApprovalAndSale: vi.fn(async () => ({ approval: null, sale: null })),
  listLiveApprovals: vi.fn(async () => state.live),
  listFinalizedSignatures: vi.fn(async () => ({ signatures: [], complete: true })),
  finalizedTransaction: vi.fn(async () => null),
}));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/generated/asset_registry")>();
  const account = (data: Record<string, unknown> | null) =>
    data ? { exists: true, programAddress: original.ASSET_REGISTRY_PROGRAM_ADDRESS, data } : { exists: false };
  return {
    ...original,
    fetchMaybeShareClass: vi.fn(async () => account({ asset: "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr" })),
    fetchMaybeAsset: vi.fn(async () => account({ issuer: "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx" })),
    fetchMaybeSale: vi.fn(async () => account(state.finalizedSale)),
  };
});
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain, in: chain, order: chain, limit: chain, abortSignal: chain, not: chain, gte: chain, lte: chain, is: chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        update: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === "compliance_alerts") state.alerts.push({ status: "open", ...row } as Alert);
          if (table === "audit_events") state.audit++;
          return builder;
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          let data: unknown = [];
          if (table === "sales") data = state.sales;
          if (table === "compliance_alerts") {
            data = state.alerts.filter((a) =>
              a.network === filters.network && a.source === filters.source && a.status === filters.status &&
              a.evidence.key === filters["evidence->>key"]);
          }
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      });
      return builder;
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      let result: { data: unknown; error: unknown } = { data: null, error: null };
      if (fn === "adopt_sale_approval") {
        if (state.missingFx.has(String(args.p_payment_mint))) {
          result = { data: null, error: { code: "P0001", message: "FX_RATE_MISSING" } };
        } else {
          state.adopted.push(String(args.p_approval_pda));
          result = { data: { id: "1b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0c", network: state.network, approval_pda: args.p_approval_pda, action: "inserted", over_cap: false, last_error: null, status: "reserved" }, error: null };
        }
      }
      return Object.assign(Promise.resolve(result), { abortSignal: () => Promise.resolve(result) });
    },
  }),
}));

import { RaiseType, SaleStatus } from "@/lib/generated/asset_registry";
import { USDC } from "@/lib/payment-mints";
import { capacityError, isCapacityCode, raisePaymentMintAlarm, reconcileSaleCapacity } from "@/lib/server/sale-capacity";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const ADMIN = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const SC = "Pc4auCy8Fnwxs7EcFwBGKqV3SudxCKEEDLHbEHujBpK";
const ISSUER = "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx";
const UNRATED = "5MZBGE68wKvzAiRnh9BLcxWzWZ9EGDgvS39mgLDLKTsy";
const A1 = "6D6TgUKrYY6dJrCUZ6LcJKt5EGGdCUgHtVeUKmRZbUJ2";
const A2 = "9V6dJcVh4Zq8bqXjbHZ8YbtcEQTP6NrbXKzmZ9pQxTaG";
const EXPIRES = Math.floor(Date.now() / 1000) + 86_400;

const approval = (address: string, paymentMint: string, saleId: number) => ({
  address, shareClass: SC, saleId: BigInt(saleId), issuer: ISSUER, paymentMint, maxGrossRaise: BigInt(1_000_000),
  minPricePerUnit: BigInt(10), maxPricePerUnit: BigInt(10), raiseType: RaiseType.Mature, expiresAt: BigInt(EXPIRES),
  applicationHash: new Uint8Array(32).fill(0xab), approvedBy: ADMIN, cliffMonths: 0, vestingMonths: 0,
});

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.network = "devnet";
  state.live = [];
  state.sales = [];
  state.finalizedSale = null;
  state.missingFx = new Set();
  state.alerts = [];
  state.adopted = [];
  state.audit = 0;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("orphan approvals with an unknown payment mint", () => {
  it("an FX_RATE_MISSING approval no longer blocks the ones behind it, and raises one alert", async () => {
    state.missingFx = new Set([UNRATED]);
    state.live = [approval(A1, UNRATED, 4), approval(A2, USDC.devnet!.mint, 5)];
    await reconcileSaleCapacity(5);
    // The second approval is still adopted (and alerted in the audit log).
    expect(state.adopted).toEqual([A2]);
    expect(state.audit).toBe(1);
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0]).toMatchObject({
      network: "devnet", source: "sale-capacity", severity: "high", wallet: ADMIN, status: "open",
      evidence: { kind: "unknown_payment_mint", key: A1, payment_mint: UNRATED, reason: "fx_rate_missing" },
    });
    expect(state.alerts[0].summary).toContain(A1);
  });

  it("a second run does not duplicate the open alert", async () => {
    state.missingFx = new Set([UNRATED]);
    state.live = [approval(A1, UNRATED, 4)];
    await reconcileSaleCapacity(5);
    await reconcileSaleCapacity(5);
    expect(state.alerts).toHaveLength(1);
    // Once it is resolved, a still-unrated approval alerts again.
    state.alerts[0].status = "resolved";
    await reconcileSaleCapacity(5);
    expect(state.alerts).toHaveLength(2);
  });

  it("other adoption errors are logged and the scan continues", async () => {
    state.live = [approval(A1, "not-a-valid-share-class-mint", 4), approval(A2, USDC.devnet!.mint, 5)];
    state.live[0] = { ...state.live[0], shareClass: "bad" };
    await reconcileSaleCapacity(5);
    expect(state.adopted).toEqual([A2]);
    expect(state.alerts).toEqual([]);
    expect(errors.mock.calls.some((c: unknown[]) => String(c[0]).includes("orphan approval adoption failed"))).toBe(true);
  });

  it("mainnet: a counted approval whose mint is not allowlisted (a hand-inserted FX row) still alarms", async () => {
    state.network = "mainnet";
    state.live = [approval(A1, UNRATED, 4), approval(A2, USDC.mainnet!.mint, 5)];
    await reconcileSaleCapacity(5);
    expect(state.adopted).toEqual([A1, A2]);
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0].evidence).toMatchObject({ key: A1, payment_mint: UNRATED, reason: "not_allowlisted" });
  });

  it("an orphan sale without an FX rate alarms under the sale's key", async () => {
    const SALE = "BpTT41WYH3RAaj3qnW15gJcW2xFjTEVkb1coKWEpshAr";
    const { findSalePda } = await import("@/lib/pdas");
    const salePda = await findSalePda(SC as never, BigInt(7));
    state.missingFx = new Set([UNRATED]);
    state.sales = [{ pda: salePda, sale_approval: SALE }];
    state.finalizedSale = {
      shareClass: SC, saleId: BigInt(7), saleApproval: SALE, paymentMint: UNRATED, pricePerUnit: BigInt(10),
      totalForSale: BigInt(100), sold: BigInt(0), status: SaleStatus.Open, raiseType: RaiseType.Mature,
      cliffMonths: 0, vestingMonths: 0, applicationHash: new Uint8Array(32),
    };
    await reconcileSaleCapacity(5);
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0]).toMatchObject({ wallet: null, evidence: { key: salePda, reason: "fx_rate_missing" } });
  });
});

describe("helpers", () => {
  it("capacityError keeps the ledger code; isCapacityCode reads it", () => {
    const err = capacityError({ code: "P0001", message: "FX_RATE_MISSING" });
    expect(err.status).toBe(409);
    expect(isCapacityCode(err, "FX_RATE_MISSING")).toBe(true);
    expect(isCapacityCode(err, "FX_RATE_STALE")).toBe(false);
    expect(isCapacityCode(capacityError({ code: "P0001", message: "SALE_CAP_EXCEEDED remaining=1 cap=2 window_start=x" }), "SALE_CAP_EXCEEDED")).toBe(true);
    expect(isCapacityCode(new Error("FX_RATE_MISSING"), "FX_RATE_MISSING")).toBe(false);
    expect(isCapacityCode(capacityError({ code: "57014", message: "timeout" }), "FX_RATE_MISSING")).toBe(false);
  });

  it("raisePaymentMintAlarm never throws and leaves a non-address approver out", async () => {
    const sb = getSupabaseAdmin();
    await expect(raisePaymentMintAlarm(sb, { network: "devnet", key: A1, paymentMint: UNRATED, approvedBy: "unknown (orphan sale)", reason: "fx_rate_missing" })).resolves.toBe(true);
    expect(state.alerts[0].wallet).toBeNull();
    const broken = { from: () => { throw new Error("down"); } } as unknown as typeof sb;
    await expect(raisePaymentMintAlarm(broken, { network: "devnet", key: A2, paymentMint: UNRATED, approvedBy: null, reason: "fx_rate_missing" })).resolves.toBe(false);
  });
});
