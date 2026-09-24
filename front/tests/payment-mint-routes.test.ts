// Talas 4.2 §3.3: the server routes that let a payment mint in —
// /api/admin-config/fx-rates, /api/sale-approvals/reserve and /api/otc/create
// — read the mint from chain under the plain-payment rule and, on mainnet,
// the allowlist and the FX kind it fixes. SIWS, the gates, Supabase and the
// on-chain account reads are mocked; the routes and lib/server/payment-mint
// run for real.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  network: "devnet" as "devnet" | "mainnet",
  wallet: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2",
  params: {} as Record<string, unknown>,
  accounts: new Map<string, { exists: true; programAddress: string; data: Uint8Array } | { exists: false }>(),
  rpcDown: false,
  calls: [] as Array<{ kind: string; target: string; args: unknown }>,
}));

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => state.network,
}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@solana/kit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/kit")>()),
  fetchEncodedAccount: vi.fn(async (_rpc: unknown, key: string) => {
    if (state.rpcDown) throw new Error("fetch failed https://rpc.example/?api-key=SECRET");
    return { address: key, ...(state.accounts.get(key) ?? { exists: false }) };
  }),
}));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: state.wallet, params: state.params, via: "signature" })),
}));
vi.mock("@/lib/server/admin-gate", () => ({
  requireAdmin: vi.fn(async () => {}),
  requireSuperAdmin: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/kyc-gate", () => ({ refuseSuspendedClient: vi.fn(async () => {}) }));
vi.mock("@/lib/server/token-holdings", () => ({
  verifyShareClassMint: vi.fn(async () => {}),
  getToken2022Balance: vi.fn(async () => BigInt(1_000_000)),
}));
// The reserve route's chain/ledger helpers; the payment-mint checks stay real.
vi.mock("@/app/api/sale-approvals/_lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/sale-approvals/_lib")>()),
  shareClassChain: vi.fn(async (shareClass: string) => ({
    shareClass, asset: "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr", issuer: "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx",
    authority: "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9", issuerVerified: true,
  })),
  saleAndApprovalPdas: vi.fn(async () => ({
    sale: "6D6TgUKrYY6dJrCUZ6LcJKt5EGGdCUgHtVeUKmRZbUJ2", approval: "9V6dJcVh4Zq8bqXjbHZ8YbtcEQTP6NrbXKzmZ9pQxTaG",
  })),
  accountExists: vi.fn(async () => false),
  applicantWallets: vi.fn(async () => []),
  subjectSpvId: vi.fn(async () => null),
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
        select: chain, eq: chain, in: chain, order: chain, limit: chain, abortSignal: chain,
        upsert: write("upsert"), insert: write("insert"), delete: write("delete"),
        single: async () => ({ data: { id: `${table}-1` }, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve, reject),
      });
      return builder;
    },
    rpc: (fn: string, args: unknown) => {
      state.calls.push({ kind: "rpc", target: fn, args });
      const result = { data: { id: "1b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0c", amount_eur: 1, subject: "issuer:x", existing: false, capacity: {} }, error: null };
      return Object.assign(Promise.resolve(result), { abortSignal: () => Promise.resolve(result) });
    },
  }),
}));

import { getMintEncoder, type ExtensionArgs } from "@solana-program/token-2022";
import { TOKEN_2022, TOKEN_CLASSIC, USDC } from "@/lib/payment-mints";
import { POST as fxRatesRoute } from "@/app/api/admin-config/fx-rates/route";
import { POST as reserveRoute } from "@/app/api/sale-approvals/reserve/route";
import { POST as otcCreateRoute } from "@/app/api/otc/create/route";

const MAINNET_USDC = USDC.mainnet!.mint;
const DEVNET_USDC = USDC.devnet!.mint;
const PLAIN = "5MZBGE68wKvzAiRnh9BLcxWzWZ9EGDgvS39mgLDLKTsy";
const HOOKED = "BpTT41WYH3RAaj3qnW15gJcW2xFjTEVkb1coKWEpshAr";
const AUTHORITY = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";

function mint(decimals = 6, extensions: ExtensionArgs[] | null = null) {
  return new Uint8Array(
    getMintEncoder().encode({ mintAuthority: AUTHORITY as never, supply: BigInt(0), decimals, isInitialized: true, freezeAuthority: null, extensions }),
  );
}

async function call(route: (r: Request) => Promise<Response>, params: Record<string, unknown>, action?: string) {
  state.params = params;
  const body = JSON.stringify(action ? { payload: { action } } : {});
  const response = await route(new Request("http://localhost/api/test", { method: "POST", body }));
  return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string; data?: unknown } };
}
const writes = (kind: string, target: string) => state.calls.filter((c) => c.kind === kind && c.target === target);

beforeEach(() => {
  state.network = "devnet";
  state.rpcDown = false;
  state.calls = [];
  state.accounts = new Map([
    [MAINNET_USDC, { exists: true, programAddress: TOKEN_CLASSIC, data: mint(6) }],
    [DEVNET_USDC, { exists: true, programAddress: TOKEN_CLASSIC, data: mint(6) }],
    [PLAIN, { exists: true, programAddress: TOKEN_2022, data: mint(6) }],
    [HOOKED, { exists: true, programAddress: TOKEN_2022, data: mint(6, [{ __kind: "TransferHook", authority: AUTHORITY as never, programId: AUTHORITY as never }]) }],
  ]);
});

describe("POST /api/admin-config/fx-rates (write)", () => {
  const WRITE = "adminConfig.fxRatesWrite";
  const rate = (over: Record<string, unknown> = {}) => ({
    op: "upsert", payment_mint: MAINNET_USDC, kind: "rate", eur_per_token: "0.92", source: "ECB", max_age_days: 7, ...over,
  });

  it("mainnet: refuses a non-allowlisted mint, USDC as eur_peg and a max age above 7 days", async () => {
    state.network = "mainnet";
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [rate({ payment_mint: PLAIN }), /not an allowed payment token on mainnet/],
      [rate({ kind: "eur_peg" }), /must be kind rate/],
      [rate({ max_age_days: 8 }), /at most 7/],
    ];
    for (const [params, message] of cases) {
      const { status, body } = await call(fxRatesRoute, params, WRITE);
      expect(status).toBe(400);
      expect(body.error).toMatch(message);
    }
    expect(writes("upsert", "fx_rates")).toEqual([]);
  });

  it("mainnet: accepts USDC as a rate with the decimals read from chain", async () => {
    state.network = "mainnet";
    const { status } = await call(fxRatesRoute, rate(), WRITE);
    expect(status).toBe(200);
    expect(writes("upsert", "fx_rates")[0].args).toMatchObject({
      network: "mainnet", payment_mint: MAINNET_USDC, kind: "rate", eur_per_token: "0.92", decimals: 6, max_age: "7 days",
    });
  });

  it("mainnet: a USDC account that is not 6-decimal SPL Token is the wrong cluster", async () => {
    state.network = "mainnet";
    state.accounts.set(MAINNET_USDC, { exists: true, programAddress: TOKEN_CLASSIC, data: mint(9) });
    const { status, body } = await call(fxRatesRoute, rate(), WRITE);
    expect(status).toBe(400);
    expect(body.error).toMatch(/wrong cluster or RPC/);
  });

  it("any network: a hook mint fails the plain-payment rule; a plain Token-2022 mint is fine off mainnet", async () => {
    let r = await call(fxRatesRoute, rate({ payment_mint: HOOKED, kind: "eur_peg" }), WRITE);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/transfer hook/);
    r = await call(fxRatesRoute, rate({ payment_mint: PLAIN, kind: "eur_peg", max_age_days: 30 }), WRITE);
    expect(r.status).toBe(200);
    expect(writes("upsert", "fx_rates")[0].args).toMatchObject({ network: "devnet", payment_mint: PLAIN, kind: "eur_peg", decimals: 6 });
  });

  it("deleting a row is always allowed, and RPC trouble is a 503 without detail", async () => {
    state.network = "mainnet";
    expect((await call(fxRatesRoute, { op: "delete", payment_mint: PLAIN }, WRITE)).status).toBe(200);
    state.rpcDown = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await call(fxRatesRoute, rate(), WRITE);
    expect(status).toBe(503);
    expect(JSON.stringify(body)).not.toMatch(/SECRET|rpc\.example/);
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/SECRET|rpc\.example/);
    error.mockRestore();
  });
});

describe("POST /api/sale-approvals/reserve", () => {
  const NOW = Math.floor(Date.now() / 1000);
  const reserve = (paymentMint: string) => ({
    reason: "Manual platform approval", share_class: "Pc4auCy8Fnwxs7EcFwBGKqV3SudxCKEEDLHbEHujBpK", sale_id: "4",
    payment_mint: paymentMint, max_gross_raise: "1000000", min_price_per_unit: "10", max_price_per_unit: "10",
    raise_type: "mature", expires_at: String(NOW + 30 * 86_400),
  });
  const reserved = () => writes("rpc", "reserve_sale_capacity");

  it("refuses a hook payment mint before reserving", async () => {
    const { status, body } = await call(reserveRoute, reserve(HOOKED));
    expect(status).toBe(400);
    expect(body.error).toMatch(/transfer hook/);
    expect(reserved()).toEqual([]);
  });

  it("mainnet: refuses a non-allowlisted mint before reserving (defense in depth)", async () => {
    state.network = "mainnet";
    const { status, body } = await call(reserveRoute, reserve(PLAIN));
    expect(status).toBe(400);
    expect(body.error).toMatch(/not an allowed payment token on mainnet/);
    expect(reserved()).toEqual([]);
  });

  it("reserves an allowed mint with its on-chain decimals", async () => {
    state.network = "mainnet";
    expect((await call(reserveRoute, reserve(MAINNET_USDC))).status).toBe(200);
    expect(reserved()[0].args).toMatchObject({ p_network: "mainnet", p_payment_mint: MAINNET_USDC, p_payment_decimals: 6 });
    state.network = "devnet";
    state.calls = [];
    state.accounts.set(PLAIN, { exists: true, programAddress: TOKEN_2022, data: mint(2) });
    expect((await call(reserveRoute, reserve(PLAIN))).status).toBe(200);
    expect(reserved()[0].args).toMatchObject({ p_payment_mint: PLAIN, p_payment_decimals: 2 });
  });
});

describe("POST /api/otc/create", () => {
  const request = (paymentMint: string) => ({
    share_class_pda: "Pc4auCy8Fnwxs7EcFwBGKqV3SudxCKEEDLHbEHujBpK", mint: "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr",
    asset_label: "Test", seller_wallet: AUTHORITY, buyer_wallet: "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9",
    amount: 10, price: 1_000_000, payment_mint: paymentMint,
  });

  it("refuses a hook payment mint; nothing is queued", async () => {
    const { status, body } = await call(otcCreateRoute, request(HOOKED));
    expect(status).toBe(400);
    expect(body.error).toMatch(/transfer hook/);
    expect(writes("insert", "otc_requests")).toEqual([]);
  });

  it("mainnet: refuses a non-allowlisted payment mint", async () => {
    state.network = "mainnet";
    const { status, body } = await call(otcCreateRoute, request(PLAIN));
    expect(status).toBe(400);
    expect(body.error).toMatch(/not an allowed payment token on mainnet/);
    expect(writes("insert", "otc_requests")).toEqual([]);
  });

  it("queues a request with a plain payment mint", async () => {
    const { status } = await call(otcCreateRoute, request(PLAIN));
    expect(status).toBe(200);
    expect(writes("insert", "otc_requests")[0].args).toMatchObject({ network: "devnet", payment_mint: PLAIN });
  });
});
