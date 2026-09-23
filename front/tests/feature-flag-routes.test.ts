// Server half of the network feature flags (lib/features.ts): with a flag off
// the routes refuse the gated operation BEFORE any database write, whatever
// the UI did. SIWS verification and the admin gate are mocked; the routes and
// lib/server/feature-gate.ts run for real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  params: {} as Record<string, unknown>,
  writes: [] as Array<{ table: string; kind: string; row: Record<string, unknown> }>,
}));

vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({
    wallet: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2",
    params: state.params,
  })),
}));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: vi.fn(async () => {}) }));
vi.mock("@/lib/server/kyc-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/kyc-gate")>()),
  requireVerifiedApplicant: vi.fn(async () => ({ kind: "company" })),
}));
vi.mock("@/lib/server/raise-limits", () => ({
  getRaiseCapacity: vi.fn(async () => ({})),
  assertWithinCapacity: vi.fn(),
  raiseLimitError: vi.fn(() => null),
}));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      const write = (kind: string) => (row: Record<string, unknown>) => {
        state.writes.push({ table, kind, row });
        return builder;
      };
      Object.assign(builder, {
        select: chain,
        eq: chain,
        in: chain,
        update: write("update"),
        insert: write("insert"),
        single: async () => ({ data: { id: "application-1" }, error: null }),
        then: (resolve: (value: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve, reject),
      });
      return builder;
    },
  }),
}));

import { POST as updatePayoutRoute } from "@/app/api/payouts/update/route";
import { POST as recipientsRoute } from "@/app/api/payouts/recipients/route";
import { POST as submitApplicationRoute } from "@/app/api/applications/submit/route";
import { narrowApplication } from "@/app/api/applications/_lib";

const RECIPIENT = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9";

async function call(
  route: (request: Request) => Promise<Response>,
  params: Record<string, unknown>,
): Promise<{ status: number; body: { ok: boolean; error?: string } }> {
  state.params = params;
  const response = await route(
    new Request("http://localhost/api/test", { method: "POST", body: "{}" }),
  );
  return { status: response.status, body: await response.json() };
}

function onMainnet(flags: { airdrop?: string; startup?: string } = {}) {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", flags.airdrop ?? "");
  vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", flags.startup ?? "");
}

const APPLICATION = {
  raise_type: "startup",
  company_name: "Acme",
  one_liner: "Widgets",
  category: "Hardware",
  valuation: "€5M",
  problem_or_why: "Because",
  raise_amount: 100_000,
  equity_offered: 5,
  raise_structure: "Equity",
  cliff_months: 0,
  vesting_months: 12,
  founder_name: "Ada",
  founder_email: "ada@example.com",
  founder_why: "Why not",
};

beforeEach(() => {
  state.params = {};
  state.writes = [];
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/payouts/update — payoutAirdrop flag", () => {
  it("refuses airdrop stamps on mainnet without the opt-in, before any write", async () => {
    onMainnet();
    for (const params of [
      { id: "p1", airdropStarted: true },
      { id: "p1", airdropCompleted: true },
      { id: "p1", status: "live", airdropStarted: true },
    ]) {
      const res = await call(updatePayoutRoute, params);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(
        "Admin-wallet payout airdrops are not enabled on Solana Mainnet.",
      );
    }
    expect(state.writes).toEqual([]);
  });

  it("still allows non-airdrop lifecycle writes on mainnet", async () => {
    onMainnet();
    const res = await call(updatePayoutRoute, { id: "p1", status: "funded" });
    expect(res.status).toBe(200);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].row).not.toHaveProperty("airdrop_started_at");
  });

  it("allows airdrop stamps with the mainnet opt-in and on devnet", async () => {
    onMainnet({ airdrop: "true" });
    expect((await call(updatePayoutRoute, { id: "p1", airdropStarted: true })).status).toBe(200);
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
    expect((await call(updatePayoutRoute, { id: "p1", airdropCompleted: true })).status).toBe(200);
    expect(state.writes.map((w) => Object.keys(w.row))).toEqual([
      ["airdrop_started_at"],
      ["airdrop_completed_at"],
    ]);
  });
});

describe("POST /api/payouts/recipients — payoutAirdrop flag", () => {
  const markClaimed = {
    payoutId: "p1",
    op: "mark_claimed",
    wallets: [RECIPIENT],
    claimedTx: "5".repeat(88),
  };

  it("refuses mark_claimed on mainnet without the opt-in, before any write", async () => {
    onMainnet();
    const res = await call(recipientsRoute, markClaimed);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/payout airdrops are not enabled/);
    expect(state.writes).toEqual([]);
  });

  it("keeps set_error available on mainnet", async () => {
    onMainnet();
    const res = await call(recipientsRoute, {
      payoutId: "p1",
      op: "set_error",
      wallets: [RECIPIENT],
      sendError: "boom",
    });
    expect(res.status).toBe(200);
  });

  it("allows mark_claimed with the mainnet opt-in and on devnet", async () => {
    onMainnet({ airdrop: "true" });
    expect((await call(recipientsRoute, markClaimed)).status).toBe(200);
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
    expect((await call(recipientsRoute, markClaimed)).status).toBe(200);
    expect(state.writes.filter((w) => w.row.claimed === true)).toHaveLength(2);
  });
});

describe("applications — startupRaises flag", () => {
  it("narrowApplication refuses a startup raise on mainnet without the opt-in", () => {
    onMainnet();
    expect(() => narrowApplication(APPLICATION)).toThrow(
      expect.objectContaining({
        status: 403,
        message: "Startup raises are not enabled on Solana Mainnet.",
      }),
    );
    expect(narrowApplication({ ...APPLICATION, raise_type: "mature" }).raise_type).toBe("mature");
  });

  it("narrowApplication accepts a startup raise with the opt-in and off mainnet", () => {
    onMainnet({ startup: "true" });
    expect(narrowApplication(APPLICATION).raise_type).toBe("startup");
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "");
    expect(narrowApplication(APPLICATION).raise_type).toBe("startup");
  });

  it("submit refuses a mainnet startup application before inserting it", async () => {
    onMainnet();
    const refused = await call(submitApplicationRoute, { application: APPLICATION });
    expect(refused.status).toBe(403);
    expect(state.writes).toEqual([]);

    const accepted = await call(submitApplicationRoute, {
      application: { ...APPLICATION, raise_type: "mature" },
    });
    expect(accepted.status).toBe(200);
    expect(state.writes[0]).toMatchObject({
      table: "launch_applications",
      kind: "insert",
      row: { raise_type: "mature", network: "mainnet" },
    });
  });
});
