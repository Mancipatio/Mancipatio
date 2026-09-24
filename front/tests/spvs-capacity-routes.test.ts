// Talas 5.1: /api/spvs/capacity and /api/spvs/issuances carry what 0074 takes
// away from anonymous reads (design §5.6, §9 "spvs.capacity gating"). SIWS,
// the admin gate, the chain and Supabase are mocked; the routes and
// lib/server/sale-capacity.ts run for real.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  wallet: "",
  params: {} as Record<string, unknown>,
  admins: [] as string[],
  asset: null as { issuer: string } | null,
  authority: "",
  spvExists: true,
  subjectSpv: null as string | null,
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));
const ADMIN = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const ISSUER_KEY = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9";
const STRANGER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const ISSUER_PDA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ASSET = "So11111111111111111111111111111111111111112";
const SPV = "30000000-0000-4000-8000-000000000001";
const CAPACITY = { cap: 3000000, issued: 1200, reserved: 300, used: 1500, remaining: 2998500, window_start: "2025-09-25", holds: [] };

vi.mock("@/lib/network", async (orig) => ({ ...(await orig<typeof import("@/lib/network")>()), detectNetwork: () => "devnet" }));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/server/siws", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: state.wallet, params: state.params, via: "signature" })),
}));
vi.mock("@/lib/server/admin-gate", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return { requireAdmin: vi.fn(async (w: string) => { if (!state.admins.includes(w)) throw new SiwsError(403, "Admin privileges required"); }) };
});
vi.mock("@/app/api/launchpad/_lib", () => ({ isAdminWallet: vi.fn(async (w: string) => state.admins.includes(w)) }));
vi.mock("@/lib/generated/asset_registry", async (orig) => {
  const o = await orig<typeof import("@/lib/generated/asset_registry")>();
  const account = (data: Record<string, unknown> | null) => (data ? { exists: true, programAddress: o.ASSET_REGISTRY_PROGRAM_ADDRESS, data } : { exists: false });
  return {
    ...o,
    fetchMaybeAsset: vi.fn(async () => account(state.asset)),
    fetchMaybeIssuer: vi.fn(async () => account({ authority: state.authority })),
  };
});
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const k of ["select", "eq", "order", "limit"]) b[k] = () => b;
      b.maybeSingle = () => Promise.resolve({ data: state.spvExists ? { id: SPV } : null, error: null });
      b.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === "spv_issuances" ? [{ id: 1, source: "sale", reason_code: null, issued_at: "2026-09-01", amount_eur: 1200 }] : [], error: null }).then(resolve);
      return b;
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcs.push({ fn, args });
      const result = { data: fn === "sale_capacity" ? CAPACITY : fn === "sale_capacity_spv" ? state.subjectSpv : null, error: null };
      return Object.assign(Promise.resolve(result), { abortSignal: () => Promise.resolve(result) });
    },
  }),
}));

import { POST as capacityRoute } from "@/app/api/spvs/capacity/route";
import { POST as issuancesRoute } from "@/app/api/spvs/issuances/route";

async function call(route: (r: Request) => Promise<Response>, params: Record<string, unknown>, wallet: string) {
  state.params = params;
  state.wallet = wallet;
  const response = await route(new Request("http://localhost/api/test", { method: "POST", body: "{}" }));
  return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string; data?: Record<string, unknown> } };
}

beforeEach(() => {
  Object.assign(state, { admins: [ADMIN], asset: { issuer: ISSUER_PDA }, authority: ISSUER_KEY, spvExists: true, subjectSpv: null, rpcs: [] });
});

describe("spvs.capacity", () => {
  it("{spv_id}: an admin only", async () => {
    expect((await call(capacityRoute, { spv_id: SPV }, STRANGER)).status).toBe(403);
    expect((await call(capacityRoute, { spv_id: SPV }, ISSUER_KEY)).status).toBe(403);
    expect(state.rpcs).toEqual([]);
    const ok = await call(capacityRoute, { spv_id: SPV }, ADMIN);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ subject: `spv:${SPV}`, spv_id: SPV, ...CAPACITY });
    expect(state.rpcs.find((r) => r.fn === "sale_capacity")?.args).toEqual({ p_network: "devnet", p_subject: `spv:${SPV}` });
  });

  it("{asset}: the asset's issuer authority or an admin; anyone else 403", async () => {
    const issuer = await call(capacityRoute, { asset: ASSET }, ISSUER_KEY);
    expect(issuer.status).toBe(200);
    expect(issuer.body.data).toMatchObject({ subject: `issuer:${ISSUER_PDA}`, spv_id: null, cap: 3000000, issued: 1200, reserved: 300,
      remaining: 2998500, window_start: "2025-09-25", holds: [] });
    state.subjectSpv = SPV;
    expect((await call(capacityRoute, { asset: ASSET }, ADMIN)).body.data).toMatchObject({ subject: `spv:${SPV}`, spv_id: SPV });
    state.rpcs = [];
    expect((await call(capacityRoute, { asset: ASSET }, STRANGER)).status).toBe(403);
    expect(state.rpcs.find((r) => r.fn === "sale_capacity")).toBeUndefined();
  });

  it("validates: an unknown SPV 404, an asset not on-chain 404, neither parameter 400", async () => {
    state.spvExists = false;
    expect((await call(capacityRoute, { spv_id: SPV }, ADMIN)).status).toBe(404);
    expect((await call(capacityRoute, { spv_id: "not-a-uuid" }, ADMIN)).status).toBe(400);
    state.asset = null;
    expect((await call(capacityRoute, { asset: ASSET }, ADMIN)).status).toBe(404);
    expect((await call(capacityRoute, {}, ADMIN)).status).toBe(400);
  });
});

describe("spvs.issuances", () => {
  it("an admin only; rows carry source, reason code and issue date", async () => {
    expect((await call(issuancesRoute, { spv_id: SPV }, STRANGER)).status).toBe(403);
    expect((await call(issuancesRoute, { spv_id: SPV }, ISSUER_KEY)).status).toBe(403);
    const ok = await call(issuancesRoute, { spv_id: SPV }, ADMIN);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual([{ id: 1, source: "sale", reason_code: null, issued_at: "2026-09-01", amount_eur: 1200 }]);
    expect((await call(issuancesRoute, { spv_id: "x" }, ADMIN)).status).toBe(400);
  });
});
