// /api/conversion/list-mine and /api/delivery/list-mine report the signer's
// KYC verdict from the SAME resolver the create routes' gate uses
// (lib/server/kyc-gate.ts: lookupClientKyc + kycGateMessage), so the page's
// "+ Request …" button is enabled exactly when the create route would accept,
// and the reason it shows is the 403 text the create route would answer
// with. Before this, list-mine read the oldest clients row by wallet alone:
// an account-verified holder (a linked wallet without a dossier of its own,
// the path KYC-only mainnet collects) got a permanently disabled button, and
// an expired or newer-suspended dossier got an enabled one the server
// refused. The harness mirrors tests/kyc-at-conversion-routes.test.ts: the
// routes and the REAL gate run against a stubbed query builder; the SIWS
// check and the chain reads are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type ClientRow = { id: string; kyc_status: string | null; kyc_expires_at: string | null };
type Row = Record<string, unknown>;

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
  /** The request tables, filtered by every eq() the route applies. */
  requests: { conversion_requests: [] as Row[], delivery_requests: [] as Row[] },
  inserts: [] as Array<{ table: string; row: Row }>,
}));

vi.mock("@/lib/server/siws", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/siws")>();
  return { ...real, verifySigned: vi.fn(async () => ({ wallet: state.wallet, params: state.params })) };
});

vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let insertRow: Row | null = null;
      const list = () => {
        if (table === "conversion_requests" || table === "delivery_requests") {
          const rows = state.requests[table].filter((r) => Object.entries(filters).every(([column, value]) => r[column] === value));
          return { data: rows, error: null };
        }
        if (table !== "clients") return { data: [], error: null };
        if (typeof filters.wallet === "string") return { data: state.clients[filters.wallet] ?? [], error: null };
        if (typeof filters.account_id === "string") return { data: state.accountClients[filters.account_id] ?? [], error: null };
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
        insert: (row: Row) => {
          insertRow = row;
          return builder;
        },
        maybeSingle: async () => {
          if (table === "account_wallets" && state.membershipError) {
            return { data: null, error: { message: "membership read timed out" } };
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
          return { data: { id: `${table}-1`, ...insertRow }, error: null };
        },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(list()).then(resolve, reject),
      };
      return builder;
    },
  }),
}));

// On-chain reads — the gate logic is what is under test.
vi.mock("@/lib/server/token-holdings", () => ({
  getToken2022Balance: vi.fn(async () => BigInt(1_000)),
  verifyShareClassMint: vi.fn(async () => {}),
  resolveShareClassAssetFacts: vi.fn(async () => ({
    assetPda: "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr",
    assetLabel: "Test asset · #0 · 1",
    convertibleTo: "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx",
    assetTypeDeliverable: true,
  })),
}));

import { POST as conversionListMine } from "@/app/api/conversion/list-mine/route";
import { POST as conversionCreate } from "@/app/api/conversion/create/route";
import { POST as deliveryListMine } from "@/app/api/delivery/list-mine/route";
import { POST as deliveryCreate } from "@/app/api/delivery/create/route";

const WALLET = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const OTHER = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9";
const MINT = "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx";
const SHARE_CLASS = "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

const row = (id: string, kyc_status: string | null, kyc_expires_at: string | null = null): ClientRow => ({ id, kyc_status, kyc_expires_at });

type Verdict = { eligible: boolean; status: string | null; expired: boolean; message: string | null };
type ListMineData = { requests: Row[]; kyc: Verdict | null; kyc_status: string | null };
type Route = (request: Request) => Promise<Response>;
type RequestTable = keyof typeof state.requests;

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  state.wallet = WALLET;
  state.params = {};
  state.clients = {};
  state.accountOf = {};
  state.accountClients = {};
  state.membershipError = false;
  state.requests = { conversion_requests: [], delivery_requests: [] };
  state.inserts = [];
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

async function call(route: Route, params: Record<string, unknown>) {
  state.params = params;
  const response = await route(
    new Request("http://localhost/api/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params }) }),
  );
  return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string; data?: unknown } };
}

const conversionParams = () => ({ share_class_pda: SHARE_CLASS, mint: MINT, amount: 10, contact: "holder@example.com" });
const deliveryParams = () => ({
  share_class_pda: SHARE_CLASS, mint: MINT, amount: 10, delivery_details: "Warehouse pickup, Belgrade", contact: "holder@example.com",
});

const routes: Array<[string, Route, Route, () => Record<string, unknown>, string, RequestTable]> = [
  ["conversion", conversionListMine, conversionCreate, conversionParams, "requesting a conversion", "conversion_requests"],
  ["delivery", deliveryListMine, deliveryCreate, deliveryParams, "requesting delivery", "delivery_requests"],
];

describe.each(routes)("%s: list-mine reports the create gate's verdict", (_name, listMine, create, params, context, table) => {
  async function listed(): Promise<ListMineData> {
    const res = await call(listMine, {});
    expect(res.status).toBe(200);
    return res.body.data as ListMineData;
  }

  /** The button is enabled exactly when create accepts; otherwise the page shows create's 403. */
  async function parity() {
    const data = await listed();
    const created = await call(create, params());
    expect(data.kyc?.eligible ?? false, "eligible exactly when the create route accepts").toBe(created.status === 200);
    if (data.kyc && !data.kyc.eligible) expect(created.body.error).toBe(data.kyc.message);
    return { data, created };
  }

  it("a linked account wallet with a live account dossier is eligible, as the create route accepts it", async () => {
    // No row of its own; verification belongs to the account (verification/submit writes wallet: null).
    state.accountOf[WALLET] = "account-1";
    state.accountClients["account-1"] = [row("c9", "verified", FUTURE)];
    const { data, created } = await parity();
    expect(data.kyc).toEqual({ eligible: true, status: "verified", expired: false, message: null });
    expect(data.kyc_status).toBe("verified");
    expect(created.status).toBe(200);
    expect(state.inserts).toEqual([expect.objectContaining({ table, row: expect.objectContaining({ holder_wallet: WALLET, client_id: "c9" }) })]);
  });

  it("a wallet's own live verified row is eligible", async () => {
    state.clients[WALLET] = [row("c7", "verified", FUTURE)];
    const { data } = await parity();
    expect(data.kyc).toMatchObject({ eligible: true, message: null });
    expect(data.kyc_status).toBe("verified");
  });

  it("an expired verification is not eligible; the message names the expiry and the action", async () => {
    state.clients[WALLET] = [row("c1", "verified", PAST)];
    const { data, created } = await parity();
    expect(data.kyc).toMatchObject({ eligible: false, status: "verified", expired: true });
    expect(data.kyc?.message).toContain("expired on 2000-01-01");
    expect(data.kyc?.message).toContain(context);
    expect(data.kyc_status).toBe("expired");
    expect(created.status).toBe(403);
  });

  it("a newer suspended row wins over an older verified one (fail closed)", async () => {
    state.clients[WALLET] = [row("old", "verified", FUTURE), row("new", "suspended")];
    const { data, created } = await parity();
    expect(data.kyc).toMatchObject({ eligible: false, status: "suspended", expired: false });
    expect(data.kyc_status).toBe("suspended");
    expect(created.status).toBe(403);
  });

  it("a pending dossier is not eligible and names its status", async () => {
    state.clients[WALLET] = [row("c1", "pending")];
    const { data } = await parity();
    expect(data.kyc).toMatchObject({ eligible: false, status: "pending" });
    expect(data.kyc?.message).toBe(`KYC verification required before ${context} — your current status is "pending".`);
    expect(data.kyc_status).toBe("pending");
  });

  it("no dossier at all: onboarding required, nothing linked", async () => {
    const { data, created } = await parity();
    expect(data.kyc).toMatchObject({ eligible: false, status: null, expired: false });
    expect(data.kyc?.message).toContain("Onboarding required");
    expect(data.kyc_status).toBeNull();
    expect(created.status).toBe(403);
  });

  it("the membership read fails: the requests still load with an unknown verdict, and create refuses (500)", async () => {
    state.membershipError = true;
    const data = await listed();
    expect(data).toEqual({ requests: [], kyc: null, kyc_status: null });
    expect((await call(create, params())).status).toBe(500);
    expect(state.inserts).toEqual([]);
  });

  it("lists only the signer's rows of this network, with the verdict beside them", async () => {
    state.clients[WALLET] = [row("c7", "verified", FUTURE)];
    state.requests[table] = [
      { id: "mine", holder_wallet: WALLET, network: "devnet", status: "requested" },
      { id: "elsewhere", holder_wallet: WALLET, network: "mainnet", status: "requested" },
      { id: "theirs", holder_wallet: OTHER, network: "devnet", status: "requested" },
    ];
    const data = await listed();
    expect(data.requests.map((r) => r.id)).toEqual(["mine"]);
    expect(data.kyc?.eligible).toBe(true);
  });
});
