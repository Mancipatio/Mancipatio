// Product policy 2026-09-23 — "KYC at conversion, not at sale". Buying
// (launchpad commit), OTC trading (otc/create) and resell listings
// (resell/create) no longer require a KYC-verified client; the only
// compliance screen left on them refuses a dossier compliance has SUSPENDED
// (a rejected KYC application is not a sanction and passes). Converting
// tokens into company equity (conversion/create) and redeeming them for a
// physical good (delivery/create) still require a live, verified KYC
// dossier. OTC requests are re-screened for suspension right before the
// escrow is opened (otc/admin-screen).
//
// The routes run for real against a stubbed Supabase query builder and the
// REAL lib/server/kyc-gate.ts (so the terminal/verified row selection is the
// production logic); SIWS verification and the on-chain reads are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type ClientRow = {
  id: string;
  kyc_status: string | null;
  kyc_expires_at: string | null;
};

const state = vi.hoisted(() => ({
  wallet: "",
  params: {} as Record<string, unknown>,
  /** clients rows keyed by wallet (the wallet's own dossiers). */
  clients: {} as Record<string, ClientRow[]>,
  /** account_wallets membership: wallet -> account id. */
  accountOf: {} as Record<string, string>,
  /** clients rows keyed by account id (account-level dossier). */
  accountClients: {} as Record<string, ClientRow[]>,
  /** Simulated failure of the account_wallets membership read. */
  membershipError: false,
  /** otc_requests rows keyed by id (admin-screen reads one). */
  otcRequests: {} as Record<string, { id: string; seller_wallet: string; buyer_wallet: string }>,
  admins: [] as string[],
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/lib/server/siws", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/siws")>();
  return {
    ...real,
    verifySigned: vi.fn(async () => ({
      wallet: state.wallet,
      params: state.params,
    })),
  };
});

vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return { data: "commitment-1", error: null };
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let insertRow: Record<string, unknown> | null = null;
      const list = () => {
        if (table !== "clients") return { data: [], error: null };
        if (typeof filters.wallet === "string") {
          return { data: state.clients[filters.wallet] ?? [], error: null };
        }
        if (typeof filters.account_id === "string") {
          return {
            data: state.accountClients[filters.account_id] ?? [],
            error: null,
          };
        }
        return { data: [], error: null };
      };
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        insert: (row: Record<string, unknown>) => {
          insertRow = row;
          return builder;
        },
        maybeSingle: async () => {
          if (table === "account_wallets" && state.membershipError) {
            return { data: null, error: { message: "membership read timed out" } };
          }
          if (table === "otc_requests" && typeof filters.id === "string") {
            return { data: state.otcRequests[filters.id] ?? null, error: null };
          }
          if (table === "account_wallets" && typeof filters.wallet === "string") {
            const account = state.accountOf[filters.wallet];
            return { data: account ? { account_id: account } : null, error: null };
          }
          return { data: null, error: null };
        },
        single: async () => {
          if (!insertRow) return { data: null, error: { message: "unexpected read" } };
          state.inserts.push({ table, row: insertRow });
          return { data: { id: `${table}-1` }, error: null };
        },
        then: (
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(list()).then(resolve, reject),
      };
      return builder;
    },
  }),
}));

// On-chain / document dependencies — the gate logic is what is under test.
vi.mock("@/app/api/launchpad/_lib", () => ({
  BASE58_RE: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  validateAmount: (value: unknown) => {
    if (typeof value !== "number" || !(value > 0)) throw new Error("bad amount");
    return value;
  },
  // raiseType 0 = RaiseType.Mature (startup-raise gating is covered in
  // feature-flag-routes.test.ts).
  requireLiveSale: vi.fn(async () => ({ authority: "issuer-authority", raiseType: 0 })),
  enforceSaleAmountCap: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/sale-document", () => ({
  publishedSaleDocument: vi.fn(async () => ({ versionId: "doc-v1", sha256: "a".repeat(64) })),
}));
const holdings = vi.hoisted(() => ({
  getToken2022Balance: vi.fn(async () => BigInt(1_000)),
  verifyShareClassMint: vi.fn(async () => {}),
  resolveShareClassAssetFacts: vi.fn(async () => ({
    assetPda: "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr",
    assetLabel: "Test asset · #0 · 1",
    convertibleTo: "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx",
    assetTypeDeliverable: true,
  })),
}));
vi.mock("@/lib/server/token-holdings", () => holdings);
// The OTC payment-mint read (plain rule; tests/payment-mint-routes.test.ts).
vi.mock("@/lib/server/payment-mint", async (original) => ({
  ...(await original<typeof import("@/lib/server/payment-mint")>()),
  paymentMintInfo: vi.fn(async () => ({ owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: 6 })),
}));
vi.mock("@/lib/server/admin-gate", async () => {
  const { SiwsError } = await import("@/lib/server/siws");
  return {
    requireAdmin: vi.fn(async (wallet: string) => {
      if (!state.admins.includes(wallet)) throw new SiwsError(403, "Admin only");
    }),
  };
});

import { POST as commitRoute } from "@/app/api/launchpad/commit/route";
import { POST as otcCreateRoute } from "@/app/api/otc/create/route";
import { POST as resellCreateRoute } from "@/app/api/resell/create/route";
import { POST as conversionCreateRoute } from "@/app/api/conversion/create/route";
import { POST as deliveryCreateRoute } from "@/app/api/delivery/create/route";
import { POST as otcAdminScreenRoute } from "@/app/api/otc/admin-screen/route";

const WALLET = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const OTHER = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9";
const SALE = "6D6TgUKrYY6dJrCUZ6LcJKt5EGGdCUgHtVeUKmRZbUJ2";
const MINT = "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx";
const SHARE_CLASS = "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr";
const PAYMENT_MINT = "11111111111111111111111111111111";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

const row = (
  id: string,
  kyc_status: string | null,
  kyc_expires_at: string | null = null,
): ClientRow => ({ id, kyc_status, kyc_expires_at });

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  state.wallet = WALLET;
  state.params = {};
  state.clients = {};
  state.accountOf = {};
  state.accountClients = {};
  state.membershipError = false;
  state.otcRequests = {};
  state.admins = [];
  state.inserts = [];
  state.rpcCalls = [];
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  warnSpy.mockRestore();
  holdings.getToken2022Balance.mockClear();
  holdings.verifyShareClassMint.mockClear();
  holdings.resolveShareClassAssetFacts.mockClear();
});

async function call(
  route: (request: Request) => Promise<Response>,
  params: Record<string, unknown>,
): Promise<{ status: number; body: { ok: boolean; error?: string; data?: Record<string, unknown> } }> {
  state.params = params;
  const response = await route(
    new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

const commitParams = () => ({
  sale_pubkey: SALE,
  investor_wallet: WALLET,
  amount: 500,
  document_terms: { versionId: "doc-v1", sha256: "a".repeat(64) },
});
const otcParams = (overrides: Record<string, unknown> = {}) => ({
  share_class_pda: SHARE_CLASS,
  mint: MINT,
  asset_label: "Test asset",
  seller_wallet: WALLET,
  buyer_wallet: OTHER,
  amount: 10,
  price: 1_000,
  payment_mint: PAYMENT_MINT,
  ...overrides,
});
const resellParams = () => ({
  mint: MINT,
  share_class_pda: SHARE_CLASS,
  amount: 10,
  ask_price: 12,
  ask_currency: "USDC",
  contact: "seller@example.com",
});
const conversionParams = () => ({
  share_class_pda: SHARE_CLASS,
  mint: MINT,
  amount: 10,
  contact: "holder@example.com",
});
const deliveryParams = () => ({
  share_class_pda: SHARE_CLASS,
  mint: MINT,
  amount: 10,
  delivery_details: "Warehouse pickup, Belgrade",
  contact: "holder@example.com",
});

// ── Sales & trading: no KYC required ────────────────────────────────────────

describe("sales and trading routes do not require KYC", () => {
  const noKycCases: Array<[string, () => void]> = [
    ["no client profile at all", () => {}],
    ["a pending dossier", () => { state.clients[WALLET] = [row("c1", "pending")]; }],
    ["a dossier waiting for documents", () => { state.clients[WALLET] = [row("c1", "more_info")]; }],
    ["an expired verification", () => { state.clients[WALLET] = [row("c1", "verified", PAST)]; }],
    // A rejected KYC APPLICATION is not a sanction: someone who tried to
    // verify is not worse off than someone who never applied.
    ["a rejected KYC application", () => { state.clients[WALLET] = [row("c1", "rejected")]; }],
  ];

  it.each(noKycCases)("launchpad commit accepts a wallet with %s", async (_label, seed) => {
    seed();
    const res = await call(commitRoute, commitParams());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { id: "commitment-1" } });
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toMatchObject({
      fn: "record_soft_commitment",
      args: { p_wallet: WALLET, p_sale: SALE, p_amount: 500, p_network: "devnet" },
    });
  });

  it.each(noKycCases)("OTC create accepts a requester with %s", async (_label, seed) => {
    seed();
    const res = await call(otcCreateRoute, otcParams());
    expect(res.status).toBe(200);
    expect(state.inserts).toEqual([
      expect.objectContaining({
        table: "otc_requests",
        row: expect.objectContaining({ requested_by: WALLET, seller_wallet: WALLET, buyer_wallet: OTHER }),
      }),
    ]);
    // Now that any signer may file a request, it must name a real share
    // class and a seller who can fund the asset leg.
    expect(holdings.verifyShareClassMint).toHaveBeenCalledWith(SHARE_CLASS, MINT);
    expect(holdings.getToken2022Balance).toHaveBeenCalledWith(WALLET, MINT);
  });

  it("OTC create refuses a share class that is not the mint's on-chain class", async () => {
    const { SiwsError } = await import("@/lib/server/siws");
    holdings.verifyShareClassMint.mockRejectedValueOnce(
      new SiwsError(400, "share_class_pda does not match an on-chain share class for this mint"),
    );
    const res = await call(otcCreateRoute, otcParams());
    expect(res.status).toBe(400);
    expect(state.inserts).toHaveLength(0);
  });

  it("OTC create refuses when the seller does not hold the amount (buyer-initiated too)", async () => {
    state.wallet = OTHER; // the buyer files the request
    holdings.getToken2022Balance.mockResolvedValueOnce(BigInt(9));
    const res = await call(otcCreateRoute, otcParams({ amount: 10 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("seller wallet does not hold enough");
    expect(holdings.getToken2022Balance).toHaveBeenCalledWith(WALLET, MINT);
    expect(state.inserts).toHaveLength(0);
  });

  it("OTC create fails closed (503) when the on-chain checks are unavailable", async () => {
    const { SiwsError } = await import("@/lib/server/siws");
    holdings.getToken2022Balance.mockRejectedValueOnce(
      new SiwsError(503, "On-chain balance check unavailable — try again"),
    );
    const res = await call(otcCreateRoute, otcParams());
    expect(res.status).toBe(503);
    expect(state.inserts).toHaveLength(0);
  });

  it.each(noKycCases)("resell create accepts a seller with %s", async (_label, seed) => {
    seed();
    const res = await call(resellCreateRoute, resellParams());
    expect(res.status).toBe(200);
    expect(state.inserts).toEqual([
      expect.objectContaining({
        table: "resell_listings",
        row: expect.objectContaining({ seller_wallet: WALLET, amount: 10 }),
      }),
    ]);
    // The non-KYC checks stay: the on-chain balance is still verified.
    expect(holdings.getToken2022Balance).toHaveBeenCalledWith(WALLET, MINT);
  });

  it("keeps the other resell checks — an amount above the on-chain balance is refused", async () => {
    holdings.getToken2022Balance.mockResolvedValueOnce(BigInt(5));
    const res = await call(resellCreateRoute, resellParams());
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("on-chain balance");
    expect(state.inserts).toHaveLength(0);
  });

  it("keeps the commitment signer binding — committing for another wallet is refused", async () => {
    const res = await call(commitRoute, { ...commitParams(), investor_wallet: OTHER });
    expect(res.status).toBe(403);
    expect(state.rpcCalls).toHaveLength(0);
  });
});

// ── Sales & trading: a suspended dossier is still refused ─────────────────

describe("sales and trading routes refuse suspended client profiles", () => {
  it("launchpad commit refuses a suspended dossier", async () => {
    state.clients[WALLET] = [row("c1", "suspended")];
    const res = await call(commitRoute, commitParams());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("is suspended by compliance");
    expect(res.body.error).toContain("committing to a raise");
    expect(res.body.error).not.toContain("KYC verification required");
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("OTC create refuses a suspended requester", async () => {
    state.clients[WALLET] = [row("c1", "suspended")];
    const res = await call(otcCreateRoute, otcParams());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("is suspended by compliance");
    expect(state.inserts).toHaveLength(0);
  });

  it("OTC create refuses a suspended counterparty without naming the status", async () => {
    state.clients[OTHER] = [row("c2", "suspended")];
    const res = await call(otcCreateRoute, otcParams());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("counterparty");
    expect(res.body.error).not.toContain("suspended");
    expect(state.inserts).toHaveLength(0);
    // Refused before any on-chain read.
    expect(holdings.getToken2022Balance).not.toHaveBeenCalled();
  });

  it("OTC create accepts a counterparty whose KYC application was rejected", async () => {
    state.clients[OTHER] = [row("c2", "rejected")];
    const res = await call(otcCreateRoute, otcParams());
    expect(res.status).toBe(200);
  });

  it("OTC create screens the seller when the buyer requests the escrow", async () => {
    state.wallet = OTHER;
    state.clients[WALLET] = [row("c1", "suspended")];
    const res = await call(otcCreateRoute, otcParams());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("counterparty");
    expect(state.inserts).toHaveLength(0);
  });

  it("resell create refuses a suspended seller before any on-chain read", async () => {
    state.clients[WALLET] = [row("c1", "suspended")];
    const res = await call(resellCreateRoute, resellParams());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("posting a resell listing");
    expect(holdings.getToken2022Balance).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  it("a suspended row wins over an older verified duplicate (fail closed)", async () => {
    state.clients[WALLET] = [row("old", "verified", FUTURE), row("new", "suspended")];
    const res = await call(commitRoute, commitParams());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("suspended");
  });

  it("a suspended row wins over an older rejected one", async () => {
    state.clients[WALLET] = [row("old", "rejected"), row("new", "suspended")];
    const res = await call(commitRoute, commitParams());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("suspended");
  });

  it("an account-level suspended dossier also answers for a linked wallet without its own", async () => {
    state.accountOf[WALLET] = "account-1";
    state.accountClients["account-1"] = [row("c9", "suspended")];
    const res = await call(resellCreateRoute, resellParams());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("suspended");
  });

  const salesRoutes: Array<[string, (r: Request) => Promise<Response>, () => Record<string, unknown>]> = [
    ["launchpad commit", commitRoute, commitParams],
    ["OTC create", otcCreateRoute, () => otcParams()],
    ["resell create", resellCreateRoute, resellParams],
  ];

  it.each(salesRoutes)("%s fails closed (500) when the account membership read errors", async (_name, route, params) => {
    // A linked wallet with no dossier of its own is answered by its
    // account's dossier. If that membership read fails, the screen must not
    // treat the wallet as "no dossier, allowed".
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      state.membershipError = true;
      const res = await call(route, params());
      expect(res.status).toBe(500);
      expect(state.inserts).toHaveLength(0);
      expect(state.rpcCalls).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ── OTC: re-screen right before the escrow is opened ────────────────────────

describe("otc/admin-screen re-screens both parties before the escrow", () => {
  const ADMIN = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const REQUEST_ID = "5f0c8d2e-1b7a-4c1e-9a55-0d6f3c2b1a10";
  beforeEach(() => {
    state.wallet = ADMIN;
    state.admins = [ADMIN];
    state.otcRequests[REQUEST_ID] = { id: REQUEST_ID, seller_wallet: WALLET, buyer_wallet: OTHER };
  });

  it("clears a request whose parties have no dossier, or a non-suspended one", async () => {
    state.clients[WALLET] = [row("c1", "rejected")];
    const res = await call(otcAdminScreenRoute, { id: REQUEST_ID });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ cleared: true, seller: "clear", buyer: "clear" });
  });

  it("flags a party suspended after the request was filed", async () => {
    state.clients[OTHER] = [row("c2", "verified", FUTURE), row("c3", "suspended")];
    const res = await call(otcAdminScreenRoute, { id: REQUEST_ID });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ cleared: false, seller: "clear", buyer: "suspended" });
  });

  it("flags a seller suspended through the account-level dossier", async () => {
    state.accountOf[WALLET] = "account-1";
    state.accountClients["account-1"] = [row("c9", "suspended")];
    const res = await call(otcAdminScreenRoute, { id: REQUEST_ID });
    expect(res.body.data).toEqual({ cleared: false, seller: "suspended", buyer: "clear" });
  });

  it("fails closed (500) instead of clearing when a lookup errors", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      state.membershipError = true;
      const res = await call(otcAdminScreenRoute, { id: REQUEST_ID });
      expect(res.status).toBe(500);
      expect(res.body.data).toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("is admin-only", async () => {
    state.admins = [];
    const res = await call(otcAdminScreenRoute, { id: REQUEST_ID });
    expect(res.status).toBe(403);
  });

  it("404s an unknown request and 400s a missing id", async () => {
    expect((await call(otcAdminScreenRoute, { id: "nope" })).status).toBe(404);
    expect((await call(otcAdminScreenRoute, {})).status).toBe(400);
  });
});

// ── Conversion & delivery: KYC still required ───────────────────────────────

describe("conversion and delivery still require a live KYC verification", () => {
  const routes: Array<[string, (r: Request) => Promise<Response>, () => Record<string, unknown>, string]> = [
    ["conversion", conversionCreateRoute, conversionParams, "conversion_requests"],
    ["delivery", deliveryCreateRoute, deliveryParams, "delivery_requests"],
  ];

  it.each(routes)("%s refuses a wallet with no client profile", async (_name, route, params) => {
    const res = await call(route, params());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Onboarding required");
    expect(state.inserts).toHaveLength(0);
  });

  it.each(routes)("%s refuses a pending dossier", async (_name, route, params) => {
    state.clients[WALLET] = [row("c1", "pending")];
    const res = await call(route, params());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("KYC verification required");
    expect(state.inserts).toHaveLength(0);
  });

  it.each(routes)("%s refuses an expired verification", async (_name, route, params) => {
    state.clients[WALLET] = [row("c1", "verified", PAST)];
    const res = await call(route, params());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("KYC verification expired");
    expect(state.inserts).toHaveLength(0);
  });

  it.each(routes)("%s refuses a suspended dossier", async (_name, route, params) => {
    state.clients[WALLET] = [row("c1", "suspended")];
    const res = await call(route, params());
    expect(res.status).toBe(403);
    expect(state.inserts).toHaveLength(0);
  });

  it.each(routes)("%s accepts a live verified client and stamps its id", async (_name, route, params, table) => {
    state.clients[WALLET] = [row("client-7", "verified", FUTURE)];
    const res = await call(route, params());
    expect(res.status).toBe(200);
    expect(state.inserts).toEqual([
      expect.objectContaining({
        table,
        row: expect.objectContaining({ holder_wallet: WALLET, client_id: "client-7" }),
      }),
    ]);
  });
});
