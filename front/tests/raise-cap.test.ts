// The admin raise-limit routes keep every limit at or below the Terms'
// EUR 3,000,000 on mainnet (lib/raise-cap.ts; Terms clause 7, the owner's
// decision D4): the platform default (POST /api/admin-config/raise-limits)
// and a client's override (POST /api/clients/raise-limits). Other networks
// keep the old bound. Signature, admin gate and Supabase are stand-ins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CLIENT_ID = "11111111-2222-4333-8444-555555555555";

const state = vi.hoisted(() => ({
  params: {} as Record<string, unknown>,
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

vi.mock("@/lib/server/siws", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/siws")>();
  return {
    ...real,
    verifySigned: vi.fn(async () => ({ wallet: "AdminWallet1111111111111111111111111111111", params: state.params, via: "signature" })),
  };
});
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      let last: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        upsert: (row: Record<string, unknown>) => {
          last = row;
          state.upserts.push({ table, row });
          return chain;
        },
        maybeSingle: async () => ({ data: last, error: null }),
        single: async () => ({ data: last, error: null }),
        then: (resolve: (value: unknown) => unknown) => resolve({ data: null, error: null }),
      };
      return chain;
    },
  }),
}));
vi.mock("@/app/api/clients/_helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/clients/_helpers")>()),
  fetchClientOr404: vi.fn(async () => ({ id: CLIENT_ID })),
  insertNote: vi.fn(async () => {}),
}));

import { POST as platformLimits } from "@/app/api/admin-config/raise-limits/route";
import { POST as clientLimits } from "@/app/api/clients/raise-limits/route";
import { MAINNET_RAISE_CAP_EUR, maxRaiseCapEur } from "@/lib/raise-cap";

async function call(route: (request: Request) => Promise<Response>, action: string, params: Record<string, unknown>) {
  state.params = params;
  const response = await route(
    new Request("https://manci.test/api", { method: "POST", body: JSON.stringify({ payload: { action, params } }) }),
  );
  return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string } };
}

const setPlatform = (cap: number) =>
  call(platformLimits, "adminConfig.raiseLimitsUpdate", { annual_raise_cap_eur: cap, max_equity_percent: 30 });
const setClient = (cap: number | null) =>
  call(clientLimits, "clients.raiseLimits", { client_id: CLIENT_ID, annual_raise_cap_eur: cap, max_equity_percent: 20 });

describe("the raise-limit ceiling (lib/raise-cap.ts)", () => {
  beforeEach(() => {
    state.upserts = [];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is the Terms' EUR 3,000,000 on mainnet and the old bound elsewhere", () => {
    expect(MAINNET_RAISE_CAP_EUR).toBe(3_000_000);
    expect(maxRaiseCapEur("mainnet")).toBe(3_000_000);
    for (const network of ["devnet", "testnet", "localnet"] as const) expect(maxRaiseCapEur(network)).toBe(1_000_000_000_000);
  });

  it("refuses a platform cap above EUR 3,000,000 on mainnet and saves one at or below it", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    const refused = await setPlatform(3_000_001);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("Annual raise cap must be between 1 and 3000000");
    expect(state.upserts).toEqual([]);
    const saved = await setPlatform(3_000_000);
    expect(saved.status).toBe(200);
    expect(state.upserts).toEqual([
      { table: "platform_raise_limits", row: expect.objectContaining({ network: "mainnet", annual_raise_cap_eur: 3_000_000 }) },
    ]);
  });

  it("refuses a client override above EUR 3,000,000 on mainnet; lower overrides and equity-only ones still save", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    const refused = await setClient(3_500_000);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("Annual raise cap must be between 1 and 3000000");
    expect(state.upserts).toEqual([]);
    expect((await setClient(2_000_000)).status).toBe(200);
    expect((await setClient(null)).status).toBe(200);
    expect(state.upserts.map((u) => [u.table, u.row.annual_raise_cap_eur])).toEqual([
      ["client_raise_limits", 2_000_000],
      ["client_raise_limits", null],
    ]);
  });

  it("devnet keeps the old bound, so a rehearsal can use any value", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    expect((await setPlatform(5_000_000)).status).toBe(200);
    expect((await setClient(5_000_000)).status).toBe(200);
    expect(state.upserts.map((u) => u.row.annual_raise_cap_eur)).toEqual([5_000_000, 5_000_000]);
  });
});
