// Product policy 2026-09-23 — "KYC at conversion, not at sale". Buying
// (launchpad commit), OTC trading (otc/create) and resell listings
// (resell/create) no longer require a KYC-verified client; the only
// compliance screen left on them refuses a dossier compliance has SUSPENDED
// or REJECTED. Converting tokens into company equity (conversion/create) and
// redeeming them for a physical good (delivery/create) still require a live,
// verified KYC dossier.
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
  requireLiveSale: vi.fn(async () => "issuer-authority"),
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

import { POST as commitRoute } from "@/app/api/launchpad/commit/route";
import { POST as otcCreateRoute } from "@/app/api/otc/create/route";
import { POST as resellCreateRoute } from "@/app/api/resell/create/route";
import { POST as conversionCreateRoute } from "@/app/api/conversion/create/route";
import { POST as deliveryCreateRoute } from "@/app/api/delivery/create/route";

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
  state.inserts = [];
  state.rpcCalls = [];
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  warnSpy.mockRestore();
  holdings.getToken2022Balance.mockClear();
  holdings.resolveShareClassAssetFacts.mockClear();
});

async function call(
  route: (request: Request) => Promise<Response>,
  params: Record<string, unknown>,
): Promise<{ status: number; body: { ok: boolean; error?: string; data?: { id: string } } }> {
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

// ── Sales & trading: terminal compliance statuses are still refused ────────

describe("sales and trading routes refuse suspended / rejected client profiles", () => {
  const terminal: Array<[string]> = [["suspended"], ["rejected"]];

  it.each(terminal)("launchpad commit refuses a %s dossier", async (status) => {
    state.clients[WALLET] = [row("c1", status)];
    const res = await call(commitRoute, commitParams());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain(`is ${status} by compliance`);
    expect(res.body.error).toContain("committing to a raise");
    expect(res.body.error).not.toContain("KYC verification required");
    expect(state.rpcCalls).toHaveLength(0);
  });

  it.each(terminal)("OTC create refuses a %s requester", async (status) => {
    state.clients[WALLET] = [row("c1", status)];
    const res = await call(otcCreateRoute, otcParams());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain(`is ${status} by compliance`);
    expect(state.inserts).toHaveLength(0);
  });

  it.each(terminal)("OTC create refuses a %s counterparty without naming the status", async (status) => {
    state.clients[OTHER] = [row("c2", status)];
    const res = await call(otcCreateRoute, otcParams());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("counterparty");
    expect(res.body.error).not.toContain(status);
    expect(state.inserts).toHaveLength(0);
  });

  it("OTC create screens the seller when the buyer requests the escrow", async () => {
    state.wallet = OTHER;
    state.clients[WALLET] = [row("c1", "suspended")];
    const res = await call(otcCreateRoute, otcParams());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("counterparty");
    expect(state.inserts).toHaveLength(0);
  });

  it.each(terminal)("resell create refuses a %s seller before any on-chain read", async (status) => {
    state.clients[WALLET] = [row("c1", status)];
    const res = await call(resellCreateRoute, resellParams());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("posting a resell listing");
    expect(holdings.getToken2022Balance).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  it("a terminal row wins over an older verified duplicate (fail closed)", async () => {
    state.clients[WALLET] = [row("old", "verified", FUTURE), row("new", "suspended")];
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
