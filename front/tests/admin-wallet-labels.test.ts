// Names of the wallets on /admin/admins (0092): any Admin reads them over its
// session with the linked accounts; only the Super Admin writes, with a fresh
// signature, and every write leaves an audit row. A missing table (0092 not
// applied) degrades to "no names" for reads and a clear 503 for writes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
type Row = Record<string, unknown>;
type Failure = { code?: string; message: string };
const state = vi.hoisted(() => ({
  params: {} as Record<string, unknown>,
  tables: {} as Record<string, Row[]>,
  fail: {} as Record<string, Failure>,
  writes: [] as Array<{ table: string; op: string; row?: Row; filters: [string, unknown][] }>,
  verify: vi.fn(), admin: vi.fn(), superAdmin: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/server/siws", async (original) => ({ ...await original<typeof import("@/lib/server/siws")>(), verifySigned: state.verify }));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: state.admin, requireSuperAdmin: state.superAdmin }));
vi.mock("@/lib/server/audit", async (original) => ({ ...await original<typeof import("@/lib/server/audit")>(), writeServerAudit: state.audit }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ from }) }));

function from(table: string) {
  const filters: [string, unknown][] = [];
  const sets: [string, unknown[]][] = [];
  let op = "select";
  let row: Row | undefined;
  const query = {
    select() { return query; },
    eq(column: string, value: unknown) { filters.push([column, value]); return query; },
    in(column: string, values: unknown[]) { sets.push([column, values]); return query; },
    delete() { op = "delete"; return query; },
    upsert(value: Row) { op = "upsert"; row = value; return query; },
    then(resolve: (result: unknown) => unknown, reject?: (error: unknown) => unknown) {
      if (state.fail[table]) return Promise.resolve({ data: null, error: state.fail[table] }).then(resolve, reject);
      if (op !== "select") {
        state.writes.push({ table, op, row, filters: [...filters] });
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      const data = (state.tables[table] ?? [])
        .filter((r) => filters.every(([c, v]) => r[c] === v))
        .filter((r) => sets.every(([c, vs]) => vs.includes(r[c])));
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
  return query;
}

import { POST as READ } from "@/app/api/admin/wallet-labels/route";
import { POST as SET } from "@/app/api/admin/wallet-labels/set/route";
import { normalizeWalletLabel, WALLET_LABEL_MAX } from "@/lib/admin-wallet-labels";
import { LABELS_NOT_SET_UP } from "@/lib/server/admin-wallet-labels";
import { SiwsError } from "@/lib/server/siws";
import { isSessionReadAction } from "@/lib/siws-session";

const SA = "8TEmJBkcoBsUjRPftZ3kdWb9NmZDy7Zy3a7GqFCK5Nx9";
const A = "2xGdpGmyHBnXYwbuszYBXD9weUrtqwS7JphhigTcdbNh";
const B = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP";
const req = () => new Request("https://manci.test/api/admin/wallet-labels", { method: "POST", body: "{}" });
const json = async (r: Response) => (await r.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  state.params = {};
  state.tables = {
    admin_wallet_labels: [
      { network: "devnet", wallet: A, label: "Ops laptop", set_by: SA, updated_at: "2026-11-09T19:00:00.000Z" },
      { network: "mainnet", wallet: B, label: "Other network", set_by: SA, updated_at: "2026-11-09T19:00:00.000Z" },
    ],
    account_wallets: [{ network: "devnet", wallet: B, account_id: "acc-1" }],
    account_profiles: [{ network: "devnet", id: "acc-1", display_name: " Marko ", email: "marko@example.com" }],
  };
  state.fail = {};
  state.writes.length = 0;
  state.verify.mockReset().mockImplementation(async () => ({ wallet: SA, params: state.params, via: "signature" }));
  state.admin.mockReset().mockResolvedValue(undefined);
  state.superAdmin.mockReset().mockResolvedValue(undefined);
  state.audit.mockReset().mockResolvedValue("audit-id");
});
afterEach(() => vi.unstubAllEnvs());

describe("normalizeWalletLabel", () => {
  it("collapses whitespace, trims, keeps \"\" as no name and refuses control characters or a long name", () => {
    expect(normalizeWalletLabel("  Ops   laptop\t ")).toBe("Ops laptop");
    expect(normalizeWalletLabel("   ")).toBe("");
    expect(normalizeWalletLabel("Ž".repeat(WALLET_LABEL_MAX))).toHaveLength(WALLET_LABEL_MAX);
    expect(() => normalizeWalletLabel("x".repeat(WALLET_LABEL_MAX + 1))).toThrow(/at most 80/);
    expect(() => normalizeWalletLabel("bad\u0007name")).toThrow(/control/);
  });
});

describe("POST /api/admin/wallet-labels (read)", () => {
  it("is a session read gated by requireAdmin before any database read", async () => {
    expect(isSessionReadAction("admin.walletLabels")).toBe(true);
    expect(isSessionReadAction("admin.walletLabelSet")).toBe(false);
    state.admin.mockRejectedValue(new SiwsError(403, "Admin privileges required"));
    state.params = { wallets: [A] };
    const response = await READ(req());
    expect(response.status).toBe(403);
    expect(state.verify).toHaveBeenCalledWith(expect.any(Request), "admin.walletLabels");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns this network's names and the linked accounts", async () => {
    state.params = { wallets: [A, B, A] };
    const body = await json(await READ(req()));
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      available: true,
      labels: { [A]: { label: "Ops laptop", setBy: SA, updatedAt: "2026-11-09T19:00:00.000Z" } },
      accounts: { [B]: { displayName: "Marko", email: "marko@example.com" } },
    });
  });

  it("without 0092 there are no names but the accounts still show", async () => {
    state.fail.admin_wallet_labels = { code: "42P01", message: "relation does not exist" };
    state.params = { wallets: [A, B] };
    const body = await json(await READ(req()));
    expect(body.data).toMatchObject({ available: false, labels: {}, accounts: { [B]: { displayName: "Marko" } } });
    state.fail.admin_wallet_labels = { code: "57014", message: "statement timeout" };
    expect((await READ(req())).status).toBe(503);
  });

  it("refuses an empty, oversized or malformed wallet list", async () => {
    for (const wallets of [[], "x", ["not-an-address"], Array.from({ length: 201 }, () => A)]) {
      state.params = { wallets };
      expect((await READ(req())).status).toBe(400);
    }
  });
});

describe("POST /api/admin/wallet-labels/set (write)", () => {
  it("is the Super Admin's alone, checked before any write", async () => {
    state.superAdmin.mockRejectedValue(new SiwsError(403, "Super admin privileges required"));
    state.params = { wallet: A, label: "Ops" };
    expect((await SET(req())).status).toBe(403);
    expect(state.verify).toHaveBeenCalledWith(expect.any(Request), "admin.walletLabelSet");
    expect(state.writes).toEqual([]);
    expect(state.audit).not.toHaveBeenCalled();
  });

  it("upserts the normalized name with its author and records it in the audit log", async () => {
    state.params = { wallet: A, label: "  Marko   (ops) " };
    const body = await json(await SET(req()));
    expect(body).toEqual({ ok: true, data: { label: "Marko (ops)" } });
    expect(state.writes).toEqual([
      { table: "admin_wallet_labels", op: "upsert", row: { network: "devnet", wallet: A, label: "Marko (ops)", set_by: SA }, filters: [] },
    ]);
    expect(state.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ix_name: "admin_wallet_label", category: "admins", actor_wallet: SA, actor_source: "siws-signature",
      reason: 'Wallet named "Marko (ops)"', target_label: A,
    }));
  });

  it("an empty name deletes the row", async () => {
    state.params = { wallet: A, label: "  " };
    expect(await json(await SET(req()))).toEqual({ ok: true, data: { label: null } });
    expect(state.writes).toEqual([
      { table: "admin_wallet_labels", op: "delete", row: undefined, filters: [["network", "devnet"], ["wallet", A]] },
    ]);
    expect(state.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "Wallet name removed" }));
  });

  it("refuses a bad wallet or name, and says when 0092 is missing", async () => {
    for (const params of [{ wallet: "nope", label: "x" }, { wallet: A, label: 5 }, { wallet: A, label: "x".repeat(81) }]) {
      state.params = params;
      expect((await SET(req())).status).toBe(400);
    }
    state.fail.admin_wallet_labels = { code: "42P01", message: "relation does not exist" };
    state.params = { wallet: A, label: "Ops" };
    const response = await SET(req());
    expect(response.status).toBe(503);
    expect((await json(response)).error).toBe(LABELS_NOT_SET_UP);
  });
});
