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
  reservations: [] as Record<string, unknown>[],
  chainApproval: null as Record<string, unknown> | null,
  finalizedSale: null as Record<string, unknown> | null,
  missingFx: new Set<string>(),
  alerts: [] as Alert[],
  adopted: [] as string[],
  attempts: 0,
  audit: 0,
}));

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => state.network,
}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/server/sale-capacity-chain", () => ({
  readApprovalAndSale: vi.fn(async () => ({ approval: state.chainApproval, sale: null })),
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
        select: chain, order: chain, limit: chain, abortSignal: chain, not: chain, gte: chain, lte: chain, is: chain,
        eq: (column: string, value: unknown) => {
          filters[column] = [value];
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          filters[column] = values;
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
          const match = (column: string, value: unknown) => !(column in filters) || (filters[column] as unknown[]).includes(value);
          if (table === "sales") data = state.sales;
          if (table === "sale_capacity_reservations") data = state.reservations;
          if (table === "compliance_alerts") {
            data = state.alerts.filter((a) =>
              match("network", a.network) && match("source", a.source) && match("status", a.status) &&
              match("evidence->>key", a.evidence.key) && match("evidence->>reason", a.evidence.reason));
          }
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      });
      return builder;
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      let result: { data: unknown; error: unknown } = { data: null, error: null };
      if (fn === "adopt_sale_approval") {
        state.attempts++;
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

import { getAddressDecoder } from "@solana/kit";
import { RaiseType, SaleStatus } from "@/lib/generated/asset_registry";
import { USDC } from "@/lib/payment-mints";
import {
  MAX_FAILED_ORPHAN_APPROVALS, capacityError, isCapacityCode, raisePaymentMintAlarm, reconcileSaleCapacity,
} from "@/lib/server/sale-capacity";
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

const key = (n: number) => {
  const bytes = new Uint8Array(32).fill(7);
  bytes[0] = n;
  return getAddressDecoder().decode(bytes) as string;
};

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.network = "devnet";
  state.live = [];
  state.sales = [];
  state.reservations = [];
  state.chainApproval = null;
  state.finalizedSale = null;
  state.missingFx = new Set();
  state.alerts = [];
  state.adopted = [];
  state.attempts = 0;
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
    // No subject wallet: the approving admin is not an AML subject (the
    // passport gate and the client export read compliance_alerts.wallet);
    // the approver is kept in the evidence and the summary.
    expect(state.alerts[0]).toMatchObject({
      network: "devnet", source: "sale-capacity", severity: "high", wallet: null, status: "open",
      evidence: { kind: "unknown_payment_mint", key: A1, payment_mint: UNRATED, reason: "fx_rate_missing", approved_by: ADMIN },
    });
    expect(state.alerts[0].summary).toContain(A1);
    expect(state.alerts[0].summary).toContain(ADMIN);
  });

  it("an escalated alert is unresolved too: no duplicate while it is escalated", async () => {
    state.missingFx = new Set([UNRATED]);
    state.live = [approval(A1, UNRATED, 4)];
    await reconcileSaleCapacity(5);
    state.alerts[0].status = "escalated";
    await reconcileSaleCapacity(5);
    expect(state.alerts).toHaveLength(1);
    state.alerts[0].status = "dismissed";
    await reconcileSaleCapacity(5);
    expect(state.alerts).toHaveLength(2);
  });

  it("mainnet: an open fx_rate_missing alert does not hide the not_allowlisted one after a hand-inserted rate", async () => {
    state.network = "mainnet";
    state.missingFx = new Set([UNRATED]);
    state.live = [approval(A1, UNRATED, 4)];
    await reconcileSaleCapacity(5);
    expect(state.alerts.map((a) => a.evidence.reason)).toEqual(["fx_rate_missing"]);
    // An operator adds the rate by hand (the route refuses it) and the next
    // run counts the approval while the first alert is still open.
    state.missingFx = new Set();
    await reconcileSaleCapacity(5);
    expect(state.adopted).toEqual([A1]);
    expect(state.alerts.map((a) => [a.evidence.key, a.evidence.reason, a.status])).toEqual([
      [A1, "fx_rate_missing", "open"],
      [A1, "not_allowlisted", "open"],
    ]);
  });

  it("stops after a few failing orphans per run, trying un-alerted ones first so none is starved", async () => {
    const unrated = Array.from({ length: MAX_FAILED_ORPHAN_APPROVALS + 2 }, (_, i) => approval(key(i + 1), UNRATED, 10 + i));
    const good = approval(key(99), USDC.devnet!.mint, 99);
    state.missingFx = new Set([UNRATED]);
    state.live = [...unrated, good];
    await reconcileSaleCapacity(5);
    // Run 1: the first five fail (and alarm); the rest wait for the next run.
    expect(state.attempts).toBe(MAX_FAILED_ORPHAN_APPROVALS);
    expect(state.adopted).toEqual([]);
    expect(state.alerts).toHaveLength(MAX_FAILED_ORPHAN_APPROVALS);
    state.attempts = 0;
    await reconcileSaleCapacity(5);
    // Run 2: the two un-alerted ones and the good one go first; then the
    // alerted ones until the failure bound. No duplicate alerts.
    expect(state.adopted).toEqual([good.address]);
    expect(state.alerts).toHaveLength(MAX_FAILED_ORPHAN_APPROVALS + 2);
    expect(state.attempts).toBe(1 + MAX_FAILED_ORPHAN_APPROVALS);
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

  it("mainnet: the worker adopting an approval whose on-chain mint differs from its reservation alarms too", async () => {
    state.network = "mainnet";
    const onChain = approval(A1, UNRATED, 4);
    state.chainApproval = onChain;
    state.reservations = [{
      id: "2c7e8f9a-1b3d-4e5f-8a9b-0c1d2e3f4a5b", network: "mainnet", kind: "sale", status: "reserved",
      share_class_pda: SC, sale_id: "4", approval_pda: A1, sale_pda: "BpTT41WYH3RAaj3qnW15gJcW2xFjTEVkb1coKWEpshAr",
      asset_pda: "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr", issuer_pda: ISSUER, spv_id: null, subject: "issuer:x",
      application_hash: "ab".repeat(32), payment_mint: USDC.mainnet!.mint, payment_decimals: 6,
      max_gross_raise: "1000000", min_price_per_unit: "10", max_price_per_unit: "10", raise_type: "mature",
      cliff_months: 0, vesting_months: 0, expires_at: new Date(EXPIRES * 1000).toISOString(), reserved_by: ADMIN,
      chain_confirmed_at: new Date().toISOString(), created_at: new Date().toISOString(), last_error: null,
    }];
    // No EUR rate for the chain's mint: the adoption fails (as before) and alarms.
    state.missingFx = new Set([UNRATED]);
    await reconcileSaleCapacity(5);
    expect(state.adopted).toEqual([]);
    expect(state.alerts.map((a) => [a.evidence.key, a.evidence.reason])).toEqual([[A1, "fx_rate_missing"]]);
    // A hand-inserted rate: adopted at the chain's terms, with the mainnet alarm.
    state.missingFx = new Set();
    await reconcileSaleCapacity(5);
    expect(state.adopted).toEqual([A1]);
    expect(state.alerts.map((a) => [a.evidence.key, a.evidence.reason])).toEqual([[A1, "fx_rate_missing"], [A1, "not_allowlisted"]]);
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
    expect(state.alerts[0].evidence.approved_by).toBeNull();
    const broken = { from: () => { throw new Error("down"); } } as unknown as typeof sb;
    await expect(raisePaymentMintAlarm(broken, { network: "devnet", key: A2, paymentMint: UNRATED, approvedBy: null, reason: "fx_rate_missing" })).resolves.toBe(false);
  });
});
