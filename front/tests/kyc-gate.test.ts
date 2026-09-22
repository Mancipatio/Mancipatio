// lib/server/kyc-gate.ts — the shared client-KYC gate. The pure halves
// (evaluateKycLookup status/expiry mapping + kycGateMessage copy) are pinned
// directly; the Supabase-facing halves run against a stubbed query builder.
// `server-only` throws outside a React Server Component, so it is mocked
// inert here (the module itself has no other import-time side effects).
//
// Network + expiry binding (2026-09-08 e2e §3 / F01) is pinned in
// tests/kyc-gate-network-expiry.test.ts against the promoted reproduction.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  evaluateKycLookup,
  kycGateMessage,
  lookupClientKyc,
  requireVerifiedClient,
  type ClientKycLookup,
} from "@/lib/server/kyc-gate";
import { SiwsError } from "@/lib/server/siws";

const WALLET = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet"));
afterEach(() => vi.unstubAllEnvs());

// ── stub Supabase query builder ─────────────────────────────────────────────
// Records the chained calls so the tests can assert the lookup shape. The
// gate reads EVERY row for the wallet (no .limit(1)) and picks fail-closed,
// so the builder itself is thenable, exactly like PostgREST's.
type ClientStubRow = {
  id: string;
  kyc_status: string | null;
  kyc_expires_at?: string | null;
};
type QueryResult = {
  data: ClientStubRow[] | null;
  error: { message: string } | null;
};

function stubSupabase(result: QueryResult) {
  const calls: Record<string, unknown[]> = {};
  const eqCalls: unknown[][] = [];
  const builder = {
    select: (...args: unknown[]) => {
      calls.select = args;
      return builder;
    },
    eq: (...args: unknown[]) => {
      eqCalls.push(args);
      return builder;
    },
    order: (...args: unknown[]) => {
      calls.order = args;
      return builder;
    },
    // Account fallback lookup (account_wallets): no linked account in these tests.
    maybeSingle: async () => ({ data: null, error: null }),
    // PostgREST builders resolve when awaited — no terminal call needed.
    then: (
      resolve: (value: QueryResult) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
  const sb = {
    from: (table: string) => {
      calls.from = [table];
      return builder;
    },
  };
  return {
    sb: sb as unknown as Parameters<typeof lookupClientKyc>[0],
    calls,
    eqCalls,
  };
}

const verifiedRow = (id: string, expiresAt: string | null = FUTURE): ClientStubRow => ({
  id,
  kyc_status: "verified",
  kyc_expires_at: expiresAt,
});

// ── evaluateKycLookup — pure status mapping ─────────────────────────────────
describe("evaluateKycLookup", () => {
  const NOW = new Date("2026-09-10T00:00:00Z");

  it("maps a missing row to hasClient=false, not eligible", () => {
    expect(evaluateKycLookup(null, NOW)).toEqual({
      hasClient: false,
      kycStatus: null,
      kycExpiresAt: null,
      expired: false,
      eligible: false,
    });
  });

  it("maps kyc_status 'verified' with a future expiry to eligible", () => {
    expect(
      evaluateKycLookup({ kyc_status: "verified", kyc_expires_at: FUTURE }, NOW),
    ).toEqual({
      hasClient: true,
      kycStatus: "verified",
      kycExpiresAt: FUTURE,
      expired: false,
      eligible: true,
    });
  });

  it.each([
    ["past", PAST],
    ["null", null],
    ["unparsable", "not-a-date"],
    ["exactly now", NOW.toISOString()],
  ])("fails closed for a verified row whose expiry is %s", (_label, expiry) => {
    const kyc = evaluateKycLookup(
      { kyc_status: "verified", kyc_expires_at: expiry },
      NOW,
    );
    expect(kyc.eligible).toBe(false);
    expect(kyc.expired).toBe(true);
    expect(kyc.kycStatus).toBe("verified");
  });

  it.each(["pending", "more_info", "rejected", "suspended", "expired"])(
    "maps kyc_status '%s' to not eligible even with a future expiry",
    (status) => {
      expect(
        evaluateKycLookup({ kyc_status: status, kyc_expires_at: FUTURE }, NOW),
      ).toEqual({
        hasClient: true,
        kycStatus: status,
        kycExpiresAt: FUTURE,
        expired: false,
        eligible: false,
      });
    },
  );

  it("normalizes a null kyc_status to null, not eligible", () => {
    expect(
      evaluateKycLookup({ kyc_status: null, kyc_expires_at: null }, NOW),
    ).toEqual({
      hasClient: true,
      kycStatus: null,
      kycExpiresAt: null,
      expired: false,
      eligible: false,
    });
  });
});

// ── kycGateMessage — pure 403 copy ──────────────────────────────────────────
describe("kycGateMessage", () => {
  const base = { kycExpiresAt: FUTURE, expired: false };
  const eligible: ClientKycLookup = {
    ...base,
    hasClient: true,
    kycStatus: "verified",
    eligible: true,
  };
  const noClient: ClientKycLookup = {
    hasClient: false,
    kycStatus: null,
    kycExpiresAt: null,
    expired: false,
    eligible: false,
  };
  const pending: ClientKycLookup = {
    ...base,
    hasClient: true,
    kycStatus: "pending",
    eligible: false,
  };

  it("returns null for an eligible lookup", () => {
    expect(kycGateMessage(eligible, "applying")).toBeNull();
  });

  it("asks for onboarding when no client row is linked", () => {
    const msg = kycGateMessage(noClient, "posting a resell listing");
    expect(msg).toContain("Onboarding required");
    expect(msg).toContain("posting a resell listing");
  });

  it("asks for KYC verification with the current status when not verified", () => {
    const msg = kycGateMessage(pending, "committing to a raise");
    expect(msg).toContain("KYC verification required");
    expect(msg).toContain("committing to a raise");
    expect(msg).toContain('"pending"');
  });

  it("names the expiry date for an expired verified verdict", () => {
    const msg = kycGateMessage(
      {
        hasClient: true,
        kycStatus: "verified",
        kycExpiresAt: PAST,
        expired: true,
        eligible: false,
      },
      "applying",
    );
    expect(msg).toContain("KYC verification expired on 2000-01-01");
    expect(msg).toContain("before applying");
  });

  it("still blocks (with contact copy) when a verified verdict has no expiry", () => {
    const msg = kycGateMessage(
      {
        hasClient: true,
        kycStatus: "verified",
        kycExpiresAt: null,
        expired: true,
        eligible: false,
      },
      "applying",
    );
    expect(msg).toContain("KYC verification required before applying");
    expect(msg).toContain("no recorded expiry");
  });

  it("falls back to 'unknown' when the status is null", () => {
    const msg = kycGateMessage(
      {
        hasClient: true,
        kycStatus: null,
        kycExpiresAt: null,
        expired: false,
        eligible: false,
      },
      "applying",
    );
    expect(msg).toContain('"unknown"');
  });
});

// ── lookupClientKyc — stubbed Supabase ──────────────────────────────────────
describe("lookupClientKyc", () => {
  it("queries ALL clients rows for the wallet ON THE ACTIVE NETWORK, oldest first", async () => {
    const { sb, calls, eqCalls } = stubSupabase({
      data: [verifiedRow("c1")],
      error: null,
    });
    const kyc = await lookupClientKyc(sb, WALLET);
    expect(kyc).toEqual({
      hasClient: true,
      kycStatus: "verified",
      kycExpiresAt: FUTURE,
      expired: false,
      eligible: true,
    });
    expect(calls.from).toEqual(["clients"]);
    expect(calls.select).toEqual(["id, kyc_status, kyc_expires_at"]);
    expect(eqCalls).toEqual([
      ["wallet", WALLET],
      ["network", "devnet"],
    ]);
    expect(calls.order).toEqual(["created_at", { ascending: true }]);
    // No .limit(1): a single-row read cannot see a suspension recorded on a
    // duplicate row (see the next test).
    expect(calls.limit).toBeUndefined();
  });

  it("binds the network filter to NEXT_PUBLIC_NETWORK", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    const { sb, eqCalls } = stubSupabase({ data: [], error: null });
    await lookupClientKyc(sb, WALLET);
    expect(eqCalls).toContainEqual(["network", "mainnet"]);
  });

  it("lets a TERMINAL duplicate row win over an older verified one", async () => {
    // Historic data: admin invite row (older, verified) + self-service row
    // that compliance later suspended. The gate must see the suspension.
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sb } = stubSupabase({
        data: [
          verifiedRow("old"),
          { id: "new", kyc_status: "suspended", kyc_expires_at: null },
        ],
        error: null,
      });
      const kyc = await lookupClientKyc(sb, WALLET);
      expect(kyc).toMatchObject({
        hasClient: true,
        kycStatus: "suspended",
        eligible: false,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps oldest-wins when no row is terminal", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sb } = stubSupabase({
        data: [
          verifiedRow("old"),
          { id: "new", kyc_status: "pending", kyc_expires_at: null },
        ],
        error: null,
      });
      await expect(lookupClientKyc(sb, WALLET)).resolves.toMatchObject({
        hasClient: true,
        kycStatus: "verified",
        eligible: true,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("reports an expired verdict (not eligible) through the public shape", async () => {
    const { sb } = stubSupabase({
      data: [verifiedRow("c1", PAST)],
      error: null,
    });
    await expect(lookupClientKyc(sb, WALLET)).resolves.toEqual({
      hasClient: true,
      kycStatus: "verified",
      kycExpiresAt: PAST,
      expired: true,
      eligible: false,
    });
  });

  it("reports no client for an empty result set", async () => {
    const { sb } = stubSupabase({ data: [], error: null });
    await expect(lookupClientKyc(sb, WALLET)).resolves.toEqual({
      hasClient: false,
      kycStatus: null,
      kycExpiresAt: null,
      expired: false,
      eligible: false,
    });
  });

  it("throws SiwsError(500) when the lookup itself fails", async () => {
    const { sb } = stubSupabase({ data: null, error: { message: "boom" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(lookupClientKyc(sb, WALLET)).rejects.toMatchObject({
        name: "SiwsError",
        status: 500,
      });
    } finally {
      spy.mockRestore();
    }
  });
});

// ── requireVerifiedClient — gate behaviour ──────────────────────────────────
describe("requireVerifiedClient", () => {
  it("resolves with the clients row id for a verified, unexpired client", async () => {
    const { sb } = stubSupabase({
      data: [verifiedRow("c1")],
      error: null,
    });
    // The id lets routes that stamp client_id (delivery/create) reuse this
    // single gate; it must NOT appear on lookupClientKyc's shape, which the
    // unsigned eligibility route returns verbatim.
    await expect(requireVerifiedClient(sb, WALLET)).resolves.toEqual({
      clientId: "c1",
    });
  });

  it("throws SiwsError(403) with the KYC copy for a non-verified client", async () => {
    const { sb } = stubSupabase({
      data: [{ id: "c1", kyc_status: "pending", kyc_expires_at: null }],
      error: null,
    });
    const err = await requireVerifiedClient(
      sb,
      WALLET,
      "requesting an OTC escrow",
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SiwsError);
    expect((err as SiwsError).status).toBe(403);
    expect((err as SiwsError).message).toContain("KYC verification required");
    expect((err as SiwsError).message).toContain("requesting an OTC escrow");
  });

  it("throws SiwsError(403) with the expiry copy for an expired verified client", async () => {
    const { sb } = stubSupabase({
      data: [verifiedRow("c1", PAST)],
      error: null,
    });
    const err = await requireVerifiedClient(sb, WALLET, "committing to a raise").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SiwsError);
    expect((err as SiwsError).status).toBe(403);
    expect((err as SiwsError).message).toContain("KYC verification expired on 2000-01-01");
    expect((err as SiwsError).message).toContain("committing to a raise");
  });

  it("throws SiwsError(403) with the onboarding copy when no client exists", async () => {
    const { sb } = stubSupabase({ data: [], error: null });
    const err = await requireVerifiedClient(sb, WALLET).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SiwsError);
    expect((err as SiwsError).status).toBe(403);
    expect((err as SiwsError).message).toContain("Onboarding required");
    // Default context preserves the original /api/applications copy.
    expect((err as SiwsError).message).toContain("before applying");
  });
});
