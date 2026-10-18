// /api/sale-approvals/treasury-mint, the reserve branch: the room counted
// from lifetime_minted (F003). The program caps an Equity class on
// circulating supply, so a conversion burn reopens room on chain; the product
// rule (lib/distribution-supply) counts from lifetime_minted and never
// re-issues tokens for shares that already left the pool. MANCI0's facts:
// cap 1,750, 500 created, 250 of them burned → circulating 250; the room is
// 1,250 (never the chain's 1,500). The route reads it through
// lib/server/sale-requests readSaleRoom, the one copy Send to wallets and a
// sale request use, and answers 409 above it before anything is reserved; an
// unreadable chain refuses (503). SIWS, the admin gate, the RPC and Supabase
// are mocked; the route, its _lib, the room arithmetic and every PDA
// derivation run for real.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  wallet: "",
  params: {} as Record<string, unknown>,
  issuerAuthority: "",
  /** The ShareClass fields on top of the PDA's own (asset, classIndex). */
  shareClass: {} as Record<string, unknown>,
  openSales: [] as Array<{ totalForSale: bigint; sold: bigint }>,
  openSalesError: null as Error | null,
  liveApprovals: [] as Array<Record<string, unknown>>,
  rows: {} as Record<string, unknown>,
  lists: {} as Record<string, unknown[]>,
  rpc: {} as Record<string, unknown>,
  calls: [] as Array<{ kind: string; target: string; args: unknown }>,
  fixtures: { issuer: "", asset: "", shareClass: "", assetId: "issuance-supply-01", legalEntityId: new Uint8Array(32) },
}));

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/server/sale-capacity-chain", () => ({
  readApprovalAndSale: vi.fn(async () => ({ approval: null, sale: null })),
  blockhashExpired: vi.fn(async () => false),
  signatureOutcome: vi.fn(async () => "unknown"),
  listLiveApprovals: vi.fn(async () => state.liveApprovals),
  listFinalizedSignatures: vi.fn(async () => ({ signatures: [], complete: true })),
  finalizedTransaction: vi.fn(async () => null),
}));
vi.mock("@/lib/distribution-chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/distribution-chain")>()),
  listOpenSales: vi.fn(async () => {
    if (state.openSalesError) throw state.openSalesError;
    return state.openSales;
  }),
}));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/generated/asset_registry")>();
  const account = (data: Record<string, unknown>) => ({ exists: true, programAddress: original.ASSET_REGISTRY_PROGRAM_ADDRESS, data });
  return {
    ...original,
    fetchMaybeShareClass: vi.fn(async () => account({ asset: state.fixtures.asset, classIndex: 0, ...state.shareClass })),
    fetchMaybeAsset: vi.fn(async () =>
      account({ issuer: state.fixtures.issuer, assetId: state.fixtures.assetId, legalDocHash: new Uint8Array(32), status: original.AssetStatus.Active }),
    ),
    fetchMaybeIssuer: vi.fn(async () =>
      account({ legalEntityId: state.fixtures.legalEntityId, authority: state.issuerAuthority, kybStatus: original.KybStatus.Verified }),
    ),
  };
});
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: state.wallet, params: state.params, via: "signature" })),
}));
vi.mock("@/lib/server/admin-gate", () => ({
  requireAdmin: vi.fn(async () => undefined),
  requireSuperAdmin: vi.fn(async () => undefined),
}));
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
      const result = { data: state.rpc[fn] ?? null, error: null };
      return Object.assign(Promise.resolve(result), { abortSignal: () => Promise.resolve(result) });
    },
  }),
}));

import { findAssetPda, findIssuerPda } from "@/lib/generated/asset_registry";
import { listOpenSales } from "@/lib/distribution-chain";
import { findShareClassPda } from "@/lib/pdas";
import { POST as treasuryMintRoute } from "@/app/api/sale-approvals/treasury-mint/route";

const ADMIN = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const STRANGER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const OTHER_CLASS = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9";
const RESERVATION_ID = "1b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0c";
const NOW = Math.floor(Date.now() / 1000);

/** MANCI0's figures: cap 1,750, 500 created, 250 of them burned by a conversion (version 2 carries lifetime_minted). */
const MANCI0 = {
  maxSupply: { __option: "Some", value: BigInt(1_750) },
  lifetimeMinted: BigInt(500),
  circulatingSupply: BigInt(250),
  version: 2,
  supplyLocked: false,
  mintablePostLaunch: false,
  mintInitialized: true,
};

/** A sale approval of `shareClass` allowing `units` at a €1 minimum price (1,000,000 base units), live unless expired. */
const approval = (shareClass: string, units: number, expiresAt = NOW + 30 * 86_400) => ({
  shareClass,
  expiresAt: BigInt(expiresAt),
  maxGrossRaise: BigInt(units) * BigInt(1_000_000),
  minPricePerUnit: BigInt(1_000_000),
});

async function reserve(amountUnits: string, wallet = ADMIN) {
  state.params = { share_class: state.fixtures.shareClass, amount_units: amountUnits, amount_eur: 500, reason: "Treasury top-up for OTC" };
  state.wallet = wallet;
  const response = await treasuryMintRoute(new Request("http://localhost/api/test", { method: "POST", body: "{}" }));
  return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string; data?: Record<string, unknown> } };
}
const reserveCall = () =>
  state.calls.find((c) => c.kind === "rpc" && c.target === "reserve_treasury_mint_capacity")?.args as Record<string, unknown> | undefined;

beforeAll(async () => {
  state.fixtures.legalEntityId = new TextEncoder().encode("ISSUANCE-SUPPLY-ROUTE-ENTITY-001");
  [state.fixtures.issuer] = await findIssuerPda({ legalEntityId: state.fixtures.legalEntityId });
  [state.fixtures.asset] = await findAssetPda({ issuer: state.fixtures.issuer as never, assetId: state.fixtures.assetId });
  state.fixtures.shareClass = await findShareClassPda(state.fixtures.asset as never, 0);
});

beforeEach(() => {
  state.issuerAuthority = ADMIN;
  state.shareClass = { ...MANCI0 };
  state.openSales = [];
  state.openSalesError = null;
  state.liveApprovals = [];
  state.rows = { asset_profiles: { spv_id: null, status: "published" } };
  state.lists = {};
  state.rpc = { reserve_treasury_mint_capacity: { id: RESERVATION_ID, amount_eur: 500, subject: "issuer:x", capacity: {} } };
  state.calls = [];
  vi.mocked(listOpenSales).mockClear();
});

describe("treasury-mint reserve: the room counted from lifetime_minted (F003)", () => {
  it("refuses the chain's circulating headroom (1,500) with 409 and the lifetime room; nothing is reserved", async () => {
    const refused = await reserve("1500");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/^Only 1,250 more tokens can be created/);
    expect(refused.body.error).toMatch(/converted tokens included/);
    expect(reserveCall()).toBeUndefined();
  });

  it("reserves the lifetime room (1,250) itself", async () => {
    const ok = await reserve("1250");
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ reservation_id: RESERVATION_ID });
    expect(reserveCall()).toMatchObject({ p_amount_units: "1250", p_share_class_pda: state.fixtures.shareClass });
  });

  it("a treasury mint reserved and not yet booked lowers the room", async () => {
    state.lists.sale_capacity_reservations = [{ amount_units: "200" }];
    expect((await reserve("1100")).body.error).toMatch(/^Only 1,050 more tokens/);
    expect(reserveCall()).toBeUndefined();
    expect((await reserve("1050")).status).toBe(200);
  });

  it("an Open sale's unsold tokens and a live approval of the class hold room too; another class's or an expired approval does not", async () => {
    state.openSales = [{ totalForSale: BigInt(300), sold: BigInt(100) }];
    state.liveApprovals = [
      approval(state.fixtures.shareClass, 100),
      approval(OTHER_CLASS, 400),
      approval(state.fixtures.shareClass, 400, NOW - 60),
    ];
    expect((await reserve("951")).body.error).toMatch(/^Only 950 more tokens/);
    expect((await reserve("950")).status).toBe(200);
  });

  it("an unreadable chain refuses (503) before anything is reserved", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.openSalesError = new Error("429 Too Many Requests");
      const refused = await reserve("10");
      expect(refused.status).toBe(503);
      expect(reserveCall()).toBeUndefined();
    } finally {
      quiet.mockRestore();
    }
  });

  it("an uncapped class has no room to check", async () => {
    state.shareClass = { ...MANCI0, maxSupply: { __option: "None" } };
    expect((await reserve("1000000")).status).toBe(200);
    expect(reserveCall()).toMatchObject({ p_amount_units: "1000000" });
  });

  it("a class before the lifetime counter (version 1) creates nothing from here", async () => {
    state.shareClass = { ...MANCI0, version: 1 };
    const refused = await reserve("1");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/^Only 0 more tokens/);
  });

  it("the authority and archive checks come first: neither reads the chain for the room", async () => {
    const stranger = await reserve("10", STRANGER);
    expect(stranger.status).toBe(409);
    expect(stranger.body.error).toMatch(/issuer's own \(Admin\) key/);
    state.rows.asset_profiles = { spv_id: null, status: "archived" };
    const archived = await reserve("10");
    expect(archived.status).toBe(409);
    expect(archived.body.error).toMatch(/archived/);
    expect(vi.mocked(listOpenSales)).not.toHaveBeenCalled();
    expect(reserveCall()).toBeUndefined();
  });
});
