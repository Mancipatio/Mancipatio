import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  params: {} as Record<string, unknown>,
  tables: {} as Record<string, Row[]>,
  calls: [] as Array<{ table: string; fields: string; filters: [string, unknown][]; cursor: string | null }>,
  failTable: "", failAfterCursor: false,
  verify: vi.fn(), gate: vi.fn(),
}));
vi.mock("@/lib/server/siws", async (original) => ({ ...await original<typeof import("@/lib/server/siws")>(), verifySigned: state.verify }));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: state.gate }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ from }) }));

function from(table: string) {
  const call = { table, fields: "", filters: [] as [string, unknown][], cursor: null as string | null };
  state.calls.push(call);
  let key = "id";
  let limit = 1000;
  let cursorKey = "";
  const query = {
    select(fields: string) { call.fields = fields; return query; },
    eq(column: string, value: unknown) { call.filters.push([column, value]); return query; },
    order(column: string) { key = column; return query; },
    limit(count: number) { limit = Math.min(count, 1000); return query; },
    abortSignal() { return query; },
    gt(column: string, value: string) { cursorKey = column; call.cursor = value; return query; },
    then(resolve: (result: unknown) => unknown, reject?: (error: unknown) => unknown) {
      if (state.failTable === table && (!state.failAfterCursor || call.cursor)) return Promise.resolve({ data: null, error: { message: "private database details" } }).then(resolve, reject);
      const data = (state.tables[table] ?? []).filter((row) => call.filters.every(([column, value]) => row[column] === value))
        .filter((row) => call.cursor === null || String(row[cursorKey]) > call.cursor)
        .sort((a, b) => String(a[key]).localeCompare(String(b[key])))
        .slice(0, limit);
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
  return query;
}

import { POST } from "@/app/api/admin/accounts/route";
import { SiwsError } from "@/lib/server/siws";
import { adminRouteAllows } from "@/lib/role-resolution";
import { isSessionReadAction } from "@/lib/siws-session";

const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const profile = (n: number, extra: Row = {}): Row => ({
  id: uuid(n), network: "devnet", display_name: `Person ${n}`, email: null, email_verified_at: null,
  google_email: null, google_linked_at: null, created_at: "2026-10-01T00:00:00.000Z", ...extra,
});
function request(body = "{}") { return new Request("https://manci.test/api/admin/accounts", { method: "POST", body }); }
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  state.params = {};
  state.tables = { account_profiles: [], account_wallets: [], clients: [] };
  state.calls.length = 0;
  state.failTable = "";
  state.failAfterCursor = false;
  state.verify.mockReset().mockImplementation(async () => ({ wallet: "AdminWallet", params: state.params }));
  state.gate.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("admin account directory", () => {
  it("authorizes with the dedicated signed read action and admin gate before reading any data", async () => {
    state.gate.mockRejectedValue(new SiwsError(403, "Admin privileges required"));
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.verify).toHaveBeenCalledWith(expect.any(Request), "admin.accountsList");
    expect(state.gate).toHaveBeenCalledWith("AdminWallet");
    expect(state.calls).toEqual([]);
    expect(adminRouteAllows("/admin/accounts", new Set(["kycProvider"]))).toBe(false);
    expect(adminRouteAllows("/admin/accounts", new Set(["admin"]))).toBe(true);
    expect(isSessionReadAction("admin.accountsList")).toBe(true);
  });

  it("rejects an unauthenticated request before the role gate and database", async () => {
    state.verify.mockRejectedValue(new SiwsError(401, "Please sign in"));
    expect((await POST(request())).status).toBe(401);
    expect(state.gate).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it("deduplicates accounts with multiple wallets and overlapping Google/email methods, and keeps legacy dossiers", async () => {
    state.tables.account_profiles = [profile(1, { email: "linked@example.com", email_verified_at: "2026-10-01", google_email: "linked@example.com", google_linked_at: "2026-10-01" }), profile(2), profile(3)];
    state.tables.account_wallets = [
      { network: "devnet", account_id: uuid(1), wallet: "WalletA" },
      { network: "devnet", account_id: uuid(1), wallet: "WalletB" },
      { network: "devnet", account_id: uuid(2), wallet: "WalletC" },
    ];
    state.tables.clients = [
      { network: "devnet", id: uuid(101), account_id: uuid(1), wallet: "WalletA", kyc_status: "pending", kyc_expires_at: null },
      { network: "devnet", id: uuid(102), account_id: null, wallet: "WalletC", kyc_status: "verified", kyc_expires_at: "2020-01-01" },
      // A stale wallet on another account's dossier cannot establish ownership.
      { network: "devnet", id: uuid(103), account_id: uuid(99), wallet: "WalletB", kyc_status: "rejected", kyc_expires_at: null },
    ];
    const response = await POST(request());
    const { data } = await response.json();
    expect(data.summary).toEqual({ total: 3, wallet: 2, google: 1, email: 1, without_verification: 1 });
    expect(data.accounts[0]).toMatchObject({ id: uuid(1), methods: ["wallet", "google", "email"], wallets: ["WalletA", "WalletB"], dossiers: [{ id: uuid(101), status: "pending" }] });
    expect(data.accounts[1].dossiers).toEqual([{ id: uuid(102), status: "expired" }]);
    expect(data.accounts[2].dossiers).toEqual([]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("scopes all three tables to the server network and projects away credentials", async () => {
    state.tables.account_profiles = [profile(1, { google_sub: "secret-subject", pending_email_token_hash: "secret-token" }), profile(2, { network: "mainnet", email: "mainnet@example.com" })];
    state.tables.account_wallets = [{ network: "mainnet", account_id: uuid(1), wallet: "WrongNetworkWallet" }];
    state.tables.clients = [{ network: "mainnet", id: uuid(101), account_id: uuid(1), wallet: null, kyc_status: "verified" }];
    const response = await POST(request());
    const text = await response.text();
    const { data } = JSON.parse(text);
    expect(data.summary).toEqual({ total: 1, wallet: 0, google: 0, email: 0, without_verification: 1 });
    expect(data.network).toBe("devnet");
    for (const call of state.calls) {
      expect(call.filters).toContainEqual(["network", "devnet"]);
      expect(call.fields).not.toMatch(/\*|google_sub|token|pending_email|notes|onboarding/);
    }
    expect(text).not.toMatch(/secret|WrongNetworkWallet|mainnet@example/);
  });

  it("counts beyond PostgREST's 1000-row limit and paginates the filtered result without changing global totals", async () => {
    state.tables.account_profiles = Array.from({ length: 1211 }, (_, index) => profile(index + 1));
    state.tables.account_wallets = Array.from({ length: 1211 }, (_, index) => ({ network: "devnet", account_id: uuid(index + 1), wallet: `Wallet${String(index + 1).padStart(5, "0")}` }));
    state.params = { page: 49 };
    const { data } = await (await POST(request())).json();
    expect(data.summary.total).toBe(1211);
    expect(data.summary.wallet).toBe(1211);
    expect(data.accounts).toHaveLength(11);
    expect(data.accounts[10].id).toBe(uuid(1211));
    expect(state.calls.filter((call) => call.table === "account_profiles")).toHaveLength(3);
    state.params = { query: "Wallet01211", page: 1, method: "wallet", verification: "none" };
    const filtered = (await (await POST(request())).json()).data;
    expect(filtered.filtered_total).toBe(1);
    expect(filtered.accounts[0].id).toBe(uuid(1211));
    expect(filtered.summary.total).toBe(1211);
  });

  it("does not return a partial total when a later page fails", async () => {
    state.tables.account_profiles = Array.from({ length: 501 }, (_, index) => profile(index + 1));
    state.failTable = "account_profiles";
    state.failAfterCursor = true;
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/private database details|"total"/);
  });

  it("returns counts only for the overview and applies method and dossier filters", async () => {
    state.tables.account_profiles = [profile(1, { email: "user@example.com", email_verified_at: "2026-10-01" }), profile(2)];
    state.tables.clients = [{ network: "devnet", id: uuid(101), account_id: uuid(1), wallet: null, kyc_status: "more_info", kyc_expires_at: null }];
    state.params = { summary_only: true };
    const overview = await (await POST(request())).json();
    expect(overview.data.accounts).toEqual([]);
    expect(overview.data.summary.total).toBe(2);
    state.params = { method: "email", verification: "started" };
    const filtered = await (await POST(request())).json();
    expect(filtered.data.accounts).toHaveLength(1);
    expect(filtered.data.accounts[0].dossiers[0].status).toBe("more_info");
    state.params = { method: "email", verification: "none" };
    expect((await (await POST(request())).json()).data.filtered_total).toBe(0);
  });

  it.each([{ query: "x".repeat(201) }, { query: [] }, { page: 0 }, { page: 1.5 }, { method: "password" }, { verification: "approved" }])("rejects invalid filters before a data read: %j", async (params) => {
    state.params = params;
    expect((await POST(request())).status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it("bounds the incoming signed body", async () => {
    expect((await POST(request("x".repeat(4097)))).status).toBe(413);
    expect(state.verify).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });
});
