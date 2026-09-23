// Server half of the network feature flags (lib/features.ts): with a flag off
// the routes refuse the gated operation BEFORE any database write, whatever
// the UI did. SIWS verification, the admin gate and the on-chain sale reads
// are mocked; the routes, app/api/launchpad/_lib.ts and
// lib/server/feature-gate.ts run for real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  params: {} as Record<string, unknown>,
  writes: [] as Array<{ table: string; kind: string; row: Record<string, unknown> }>,
  /** What .maybeSingle() returns (application rows for review/adjust-terms). */
  row: null as Record<string, unknown> | null,
  /** The mocked on-chain Sale's raise type (0 = Mature, 1 = Startup). */
  raiseType: 0,
}));

// On-chain Sale -> ShareClass -> Asset -> Issuer chain (launchpad/_lib.ts
// saleChainInfo). Only the fetchers are replaced; RaiseType etc. stay real.
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/generated/asset_registry")>();
  const account = (data: Record<string, unknown>) => ({
    exists: true,
    programAddress: original.ASSET_REGISTRY_PROGRAM_ADDRESS,
    data,
  });
  return {
    ...original,
    fetchMaybeSale: vi.fn(async () =>
      account({ shareClass: "ShareC1ass111111111111111111111111111111111", raiseType: state.raiseType }),
    ),
    fetchMaybeShareClass: vi.fn(async () => account({ asset: "Asset1111111111111111111111111111111111111" })),
    fetchMaybeAsset: vi.fn(async () => account({ issuer: "Issuer111111111111111111111111111111111111" })),
    fetchMaybeIssuer: vi.fn(async () =>
      account({ authority: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2" }),
    ),
  };
});
vi.mock("@/lib/server/sale-document", () => ({
  publishedSaleDocument: vi.fn(async () => ({ versionId: "doc-v1", sha256: "a".repeat(64) })),
}));
vi.mock("@/lib/server/email", () => ({ sendEmail: vi.fn(async () => ({ sent: false })) }));

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
  refuseSuspendedClient: vi.fn(async () => ({ clientId: null })),
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
        order: chain,
        limit: chain,
        update: write("update"),
        insert: write("insert"),
        single: async () => ({ data: { id: "application-1" }, error: null }),
        maybeSingle: async () => ({ data: state.row, error: null }),
        then: (resolve: (value: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve, reject),
      });
      return builder;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.writes.push({ table: fn, kind: "rpc", row: args });
      return { data: "row-1", error: null };
    },
  }),
}));

import { POST as updatePayoutRoute } from "@/app/api/payouts/update/route";
import { POST as recipientsRoute } from "@/app/api/payouts/recipients/route";
import { POST as submitApplicationRoute } from "@/app/api/applications/submit/route";
import { POST as reviewApplicationRoute } from "@/app/api/applications/review/route";
import { POST as adjustTermsRoute } from "@/app/api/applications/adjust-terms/route";
import { POST as commitRoute } from "@/app/api/launchpad/commit/route";
import { POST as listingUpsertRoute } from "@/app/api/launchpad/listing-upsert/route";
import { narrowApplication } from "@/app/api/applications/_lib";
import { RaiseType } from "@/lib/generated/asset_registry";

const RECIPIENT = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9";
const SIGNER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const SALE = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const APPLICATION_ID = "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";
const STARTUP_OFF = "Startup raises are not enabled on Solana mainnet.";

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
  state.row = null;
  state.raiseType = RaiseType.Mature;
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
        "Admin-wallet payout airdrops are not enabled on Solana mainnet.",
      );
    }
    expect(state.writes).toEqual([]);
  });

  it("refuses the \"live\" transition (airdrop execution opened) on mainnet without the opt-in", async () => {
    onMainnet();
    const res = await call(updatePayoutRoute, { id: "p1", status: "live" });
    expect(res.status).toBe(403);
    expect(state.writes).toEqual([]);

    onMainnet({ airdrop: "true" });
    expect((await call(updatePayoutRoute, { id: "p1", status: "live" })).status).toBe(200);
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
    expect((await call(updatePayoutRoute, { id: "p1", status: "live" })).status).toBe(200);
    expect(state.writes.map((w) => w.row.status)).toEqual(["live", "live"]);
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
        message: STARTUP_OFF,
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

describe("applications review / adjust-terms — startupRaises flag", () => {
  const startupRow = {
    id: APPLICATION_ID,
    status: "pending",
    raise_type: "startup",
    company_name: "Acme",
    founder_name: "Ada",
    founder_email: null,
    raise_amount: 100_000,
    equity_offered: 5,
  };
  const review = (decision: string) =>
    call(reviewApplicationRoute, { id: APPLICATION_ID, decision, reason: "Reviewed" });

  it("refuses to approve a startup application on mainnet without the opt-in, before any write", async () => {
    onMainnet();
    state.row = startupRow;
    const res = await review("approved");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(STARTUP_OFF);
    expect(state.writes).toEqual([]);
  });

  it("still lets the admin reject a startup application or ask for changes on mainnet", async () => {
    onMainnet();
    state.row = startupRow;
    expect((await review("rejected")).status).toBe(200);
    expect((await review("needs_changes")).status).toBe(200);
    expect(
      state.writes.filter((w) => w.table === "launch_applications").map((w) => w.row.status),
    ).toEqual(["rejected", "needs_changes"]);
  });

  it("approves a mature application on mainnet, and a startup one with the opt-in or off mainnet", async () => {
    onMainnet();
    state.row = { ...startupRow, raise_type: "mature" };
    expect((await review("approved")).status).toBe(200);

    onMainnet({ startup: "true" });
    state.row = startupRow;
    expect((await review("approved")).status).toBe(200);

    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "");
    expect((await review("approved")).status).toBe(200);
    expect(
      state.writes.filter((w) => w.table === "launch_applications").map((w) => w.row.status),
    ).toEqual(["approved", "approved", "approved"]);
  });

  it("adjust-terms refuses a startup application on mainnet without the opt-in", async () => {
    const terms = { id: APPLICATION_ID, raise_amount: 200_000, equity_offered: 7 };
    onMainnet();
    state.row = startupRow;
    const refused = await call(adjustTermsRoute, terms);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe(STARTUP_OFF);
    expect(state.writes).toEqual([]);

    state.row = { ...startupRow, raise_type: "mature" };
    expect((await call(adjustTermsRoute, terms)).status).toBe(200);
    onMainnet({ startup: "true" });
    state.row = startupRow;
    expect((await call(adjustTermsRoute, terms)).status).toBe(200);
    expect(
      state.writes.filter((w) => w.table === "launch_applications").map((w) => w.row.raise_amount),
    ).toEqual([200_000, 200_000]);
  });
});

describe("launchpad routes — on-chain Startup sales need startupRaises", () => {
  const commit = () =>
    call(commitRoute, {
      sale_pubkey: SALE,
      investor_wallet: SIGNER,
      amount: 1_000,
      document_terms: { versionId: "doc-v1", sha256: "a".repeat(64) },
    });
  const upsert = (listing: Record<string, unknown>) =>
    call(listingUpsertRoute, { listing: { sale_pubkey: SALE, ...listing } });

  it("commit refuses a Startup sale on mainnet without the opt-in, before recording anything", async () => {
    onMainnet();
    state.raiseType = RaiseType.Startup;
    const res = await commit();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(STARTUP_OFF);
    expect(state.writes).toEqual([]);
  });

  it("commit records a Startup soft commitment with the opt-in and off mainnet", async () => {
    state.raiseType = RaiseType.Startup;
    onMainnet({ startup: "true" });
    expect((await commit()).status).toBe(200);
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "");
    expect((await commit()).status).toBe(200);
    expect(state.writes.map((w) => [w.table, w.row.p_network])).toEqual([
      ["record_soft_commitment", "mainnet"],
      ["record_soft_commitment", "devnet"],
    ]);
  });

  it("commit is not gated for a Mature sale on mainnet", async () => {
    onMainnet();
    state.raiseType = RaiseType.Mature;
    expect((await commit()).status).toBe(200);
    expect(state.writes).toHaveLength(1);
  });

  it("listing-upsert refuses to publish a Startup sale's listing on mainnet without the opt-in", async () => {
    onMainnet();
    state.raiseType = RaiseType.Startup;
    for (const listing of [{ is_published: true }, { problem: "Edited" }]) {
      const res = await upsert(listing);
      expect(res.status, JSON.stringify(listing)).toBe(403);
      expect(res.body.error).toBe(STARTUP_OFF);
    }
    expect(state.writes).toEqual([]);
  });

  it("listing-upsert still lets a Startup sale's listing be unpublished on mainnet", async () => {
    onMainnet();
    state.raiseType = RaiseType.Startup;
    expect((await upsert({ is_published: false })).status).toBe(200);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({ table: "save_launch_listing", kind: "rpc" });
  });

  it("listing-upsert publishes a Mature sale on mainnet and a Startup sale with the opt-in", async () => {
    onMainnet();
    state.raiseType = RaiseType.Mature;
    expect((await upsert({ is_published: true })).status).toBe(200);
    onMainnet({ startup: "true" });
    state.raiseType = RaiseType.Startup;
    expect((await upsert({ is_published: true })).status).toBe(200);
    expect(state.writes).toHaveLength(2);
  });
});
