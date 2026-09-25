// POST /api/admin/badges × lib/server/admin-badges.ts (the admin menu counts)
// and the "Needs review" annotation of POST /api/clients/admin-list, which
// shares the Clients reader (lib/server/client-review-queue.ts).
//
// The signature check and the on-chain gate are mocked (their own suites
// cover them); Supabase is an in-memory stand-in that filters like PostgREST
// for the operators these readers use and records every call, so the tests
// pin authorization (role filtering before any read), network scoping,
// per-source failure isolation, the indexer freshness gate, the counting
// rules and the memo. No real RPC and no database.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_BADGE_HREFS, VESTING_REVIEW_FILTER, vestingSeriesNeedsReview } from "@/lib/admin-badge-rules";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
type Op = [string, ...unknown[]];

const state = vi.hoisted(() => ({
  signer: "",
  params: {} as Record<string, unknown>,
  tables: {} as Record<string, Row[]>,
  calls: [] as Array<{ table: string; ops: Op[] }>,
  /** Per-table failure: an `{ error }` result, a thrown error, or a query that never settles. */
  fail: {} as Record<string, "error" | "throw" | "hang">,
  noDb: false,
}));
const mocks = vi.hoisted(() => ({ verify: vi.fn(), gate: vi.fn() }));

vi.mock("@/lib/server/siws", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/siws")>();
  return { ...real, verifySigned: mocks.verify };
});
vi.mock("@/lib/server/kyc-provider-gate", () => ({ requireAdminOrKycProvider: mocks.gate }));

// ── In-memory Supabase ───────────────────────────────────────────────────────

function compare(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string" && Number.isNaN(Number(a))) return a < b ? -1 : a > b ? 1 : 0;
  return Number(a) - Number(b);
}

function from(table: string) {
  const ops: Op[] = [];
  state.calls.push({ table, ops });
  const filters: Array<(r: Row) => boolean> = [];
  let head = false;
  let limit: number | null = null;
  let order: { column: string; ascending: boolean } | null = null;
  let patch: Row | null = null;
  const run = async (single: boolean) => {
    const failure = state.fail[table];
    if (failure === "error") return { data: null, count: null, error: { message: "relation is broken", code: "XX000" } };
    if (failure === "throw") throw new Error("network down");
    if (failure === "hang") return new Promise<never>(() => {});
    state.tables[table] ??= [];
    let matched = state.tables[table].filter((r) => filters.every((f) => f(r)));
    if (patch) {
      for (const r of matched) Object.assign(r, patch);
      return { data: null, error: null };
    }
    if (order) {
      const { column, ascending } = order;
      matched = [...matched].sort((x, y) => (ascending ? 1 : -1) * compare(x[column], y[column]));
    }
    if (limit !== null) matched = matched.slice(0, limit);
    if (head) return { data: null, error: null, count: matched.length };
    return single ? { data: matched[0] ?? null, error: null } : { data: matched, error: null };
  };
  const b: Record<string, unknown> = {};
  const op = (name: string, filter?: (...args: never[]) => (r: Row) => boolean) =>
    (...args: unknown[]) => {
      ops.push([name, ...args]);
      if (filter) filters.push((filter as (...a: unknown[]) => (r: Row) => boolean)(...args));
      return b;
    };
  Object.assign(b, {
    select: (cols: string, opts?: { head?: boolean }) => {
      ops.push(["select", cols]);
      head = Boolean(opts?.head);
      return b;
    },
    eq: op("eq", (c: string, v: unknown) => (r) => r[c] === v),
    in: op("in", (c: string, vs: unknown[]) => (r) => vs.includes(r[c])),
    is: op("is", (c: string, v: unknown) => (r) => (r[c] ?? null) === v),
    gt: op("gt", (c: string, v: unknown) => (r) => compare(r[c], v) > 0),
    lte: op("lte", (c: string, v: unknown) => (r) => compare(r[c], v) <= 0),
    lt: op("lt", (c: string, v: unknown) => (r) => compare(r[c], v) < 0),
    or: (expr: string) => {
      ops.push(["or", expr]);
      // The only `or` in the readers is the vesting constant.
      if (expr !== VESTING_REVIEW_FILTER) throw new Error(`unexpected or(${expr})`);
      filters.push((r) => vestingSeriesNeedsReview(r as Parameters<typeof vestingSeriesNeedsReview>[0]));
      return b;
    },
    order: (column: string, opts?: { ascending?: boolean }) => {
      ops.push(["order", column]);
      order = { column, ascending: opts?.ascending !== false };
      return b;
    },
    limit: (n: number) => {
      ops.push(["limit", n]);
      limit = n;
      return b;
    },
    abortSignal: (signal: AbortSignal) => {
      ops.push(["abortSignal", signal instanceof AbortSignal]);
      return b;
    },
    update: (p: Row) => {
      patch = p;
      return b;
    },
    maybeSingle: () => run(true),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => run(false).then(resolve, reject),
  });
  return b;
}

vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => {
    if (state.noDb) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    return { from };
  },
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ADMIN = "AdminWa11etAdminWa11etAdminWa11et1";
const PROVIDER = "ProviderWa11etProviderWa11etProv1";
const ISSUER = "IssuerWa11etIssuerWa11etIssuerWa1";
const uuid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const NETWORK_TABLES = [
  "issuers", "assets", "sales", "proposals", "launch_applications", "delivery_requests",
  "conversion_requests", "otc_requests", "vesting_series", "clients", "custom_inquiries",
  "compliance_alerts", "indexer_sync_state",
];
const INDEXER_TABLES = ["issuers", "assets", "sales", "proposals"];
const ADMIN_ONLY_TABLES = [
  ...INDEXER_TABLES, "launch_applications", "delivery_requests", "conversion_requests", "otc_requests",
  "vesting_series", "custom_inquiries", "compliance_alerts", "payout_schedules", "indexer_sync_state",
];

function iso(offsetMs: number) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function fixtures() {
  const nowSec = Math.floor(Date.now() / 1000);
  const today = new Date().toISOString().slice(0, 10);
  const client = (n: number, kyc_status: string, extra: Row = {}) => ({
    id: uuid(n), network: "devnet", kyc_status, anonymized_at: null, ...extra,
  });
  const req = (n: number, status: string, updated_at = "2026-09-20T00:00:00.000Z") => ({ client_id: uuid(n), status, updated_at });
  const details = (n: number, kind: string, status: string, updated_at = "2026-09-19T00:00:00.000Z") => ({ client_id: uuid(n), kind, status, updated_at });
  return {
    indexer_sync_state: [{ network: "devnet", status: "ready", completed_at: iso(-3_600_000), checked_at: iso(-10_000) }],
    issuers: [
      { network: "devnet", pda: "I1", kyb_status: 0 },
      { network: "devnet", pda: "I2", kyb_status: 1 },
      { network: "devnet", pda: "I3", kyb_status: 1 },
      { network: "mainnet", pda: "I4", kyb_status: 0 },
    ],
    assets: [
      { network: "devnet", pda: "A1", issuer_pda: "I2", status: 0, share_classes_count: 2 }, // ready
      { network: "devnet", pda: "A2", issuer_pda: "I1", status: 0, share_classes_count: 1 }, // issuer not verified
      { network: "devnet", pda: "A3", issuer_pda: "I3", status: 0, share_classes_count: 0 }, // no share class
      { network: "devnet", pda: "A4", issuer_pda: "I2", status: 1, share_classes_count: 1 }, // active
      { network: "mainnet", pda: "A5", issuer_pda: "I2", status: 0, share_classes_count: 1 },
    ],
    sales: [
      { network: "devnet", pda: "S1", status: 0, end_ts: nowSec - 60, authority: ADMIN },
      { network: "devnet", pda: "S2", status: 0, end_ts: nowSec - 60, authority: ISSUER },
      { network: "devnet", pda: "S3", status: 0, end_ts: nowSec + 3_600, authority: ADMIN },
      { network: "devnet", pda: "S4", status: 0, end_ts: 0, authority: ADMIN },
      { network: "devnet", pda: "S5", status: 1, end_ts: nowSec - 60, authority: ADMIN },
      { network: "mainnet", pda: "S6", status: 0, end_ts: nowSec - 60, authority: ADMIN },
    ],
    proposals: [
      { network: "devnet", pda: "P1", status: 0, end_ts: nowSec - 1 },
      { network: "devnet", pda: "P2", status: 0, end_ts: nowSec + 600 },
      { network: "devnet", pda: "P3", status: 1, end_ts: nowSec - 600 },
      { network: "devnet", pda: "P4", status: 0, end_ts: 0 },
      { network: "mainnet", pda: "P5", status: 0, end_ts: nowSec - 600 },
    ],
    launch_applications: [
      { id: 1, network: "devnet", status: "pending", submitted_at: "2026-09-24T08:00:00.000Z" },
      { id: 2, network: "devnet", status: "approved", submitted_at: "2026-09-25T08:00:00.000Z" },
      { id: 3, network: "devnet", status: "needs_changes", submitted_at: "2026-09-25T09:00:00.000Z" },
      { id: 4, network: "mainnet", status: "pending", submitted_at: "2026-09-25T10:00:00.000Z" },
    ],
    delivery_requests: ["requested", "deposited", "in_delivery", "vault_opened", "delivered", "approved"]
      .map((status, id) => ({ id, network: "devnet", status }))
      .concat([{ id: 99, network: "mainnet", status: "requested" }]),
    conversion_requests: ["requested", "deposited", "vault_opened", "converted", "approved"]
      .map((status, id) => ({ id, network: "devnet", status })),
    otc_requests: [
      { id: 1, network: "devnet", status: "requested" },
      { id: 2, network: "devnet", status: "requested" },
      { id: 3, network: "devnet", status: "created" },
      { id: 4, network: "mainnet", status: "requested" },
    ],
    vesting_series: [
      { id: 1, network: "devnet", status: "submitted", approved_terms_hash: null, series_pda: null },
      { id: 2, network: "devnet", status: "approved", approved_terms_hash: null, series_pda: null },
      { id: 3, network: "devnet", status: "approved", approved_terms_hash: "ab", series_pda: null },
      { id: 4, network: "devnet", status: "approved", approved_terms_hash: null, series_pda: "V1" },
      { id: 5, network: "devnet", status: "rejected", approved_terms_hash: null, series_pda: null },
      { id: 6, network: "mainnet", status: "submitted", approved_terms_hash: null, series_pda: null },
    ],
    custom_inquiries: ["new", "new", "in_review", "proposed"].map((status, id) => ({ id, network: "devnet", status }))
      .concat([{ id: 9, network: "mainnet", status: "new" }]),
    passport_requests: [
      { id: 1, wallet: "w1", status: "new", created_at: "2026-09-24T10:00:00.000Z" },
      { id: 2, wallet: "w2", status: "new", created_at: "2026-09-25T11:00:00.000Z" },
      { id: 3, wallet: "w3", status: "in_review", created_at: "2026-09-25T12:00:00.000Z" },
      { id: 4, wallet: "w4", status: "approved", created_at: "2026-09-25T13:00:00.000Z" },
    ],
    compliance_alerts: ["open", "open", "escalated", "resolved"].map((status, id) => ({ id, network: "devnet", status }))
      .concat([{ id: 9, network: "mainnet", status: "open" }]),
    payout_schedules: [
      { id: 1, active: true, next_due: "2020-01-01" },
      { id: 2, active: true, next_due: today },
      { id: 3, active: false, next_due: "2020-01-01" },
      { id: 4, active: true, next_due: "2999-01-01" },
    ],
    clients: [
      client(1, "pending"), // all documents approved → final
      client(2, "pending"), // one submitted, one requested → documents
      client(3, "pending"), // only requested → waits on the client
      client(4, "pending"), // admin-created, nothing submitted → not counted
      client(5, "pending"), // /verify details, no checklist → final
      client(6, "more_info"), // re-upload submitted → documents
      client(7, "verified"), // KYB pending, documents approved → kyb (admin only)
      client(8, "verified"), // KYB pending, a company document still requested → not counted
      client(9, "suspended"), // closed
      client(10, "pending", { anonymized_at: "2026-09-01T00:00:00Z" }), // erased
      client(11, "pending", { network: "mainnet" }), // other network
      client(12, "pending"), // final AND kyb → counted once
    ],
    kyc_requirements: [
      req(1, "approved"), req(1, "approved", "2026-09-25T07:00:00.000Z"),
      req(2, "submitted", "2026-09-25T09:30:00.000Z"), req(2, "requested"),
      req(3, "requested"),
      req(6, "submitted"),
      req(7, "approved"),
      req(8, "requested"),
      req(9, "submitted"),
      req(10, "approved"),
      req(11, "submitted", "2099-01-01T00:00:00.000Z"),
      req(12, "approved"),
    ],
    client_verification_details: [
      details(5, "kyc", "pending"),
      details(7, "kyb", "pending"),
      details(8, "kyb", "pending"),
      details(12, "kyb", "pending"),
      details(12, "kyc", "pending"),
    ],
  } as Record<string, Row[]>;
}

async function load() {
  vi.resetModules();
  const route = await import("@/app/api/admin/badges/route");
  // The class siwsErrorResponse checks (the mocked module keeps the real one).
  const { SiwsError } = await import("@/lib/server/siws");
  return { POST: route.POST, SiwsError };
}

function request() {
  return new Request("https://manci.test/api/admin/badges", { method: "POST", body: "{}" });
}

type Badge = { count: number | null; parts?: Record<string, number>; aside?: Record<string, number>; atLeast?: true; latest?: string; reason?: string };
type Body = { ok: boolean; error?: string; data: { network: string; checkedAt: string; badges: Record<string, Badge> } };

async function call(POST: (r: Request) => Promise<Response>, params: Record<string, unknown> = {}) {
  state.params = params;
  const res = await POST(request());
  return { res, body: (await res.json()) as Body };
}

const tablesQueried = () => new Set(state.calls.map((c) => c.table));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  state.signer = ADMIN;
  state.params = {};
  state.tables = fixtures();
  state.calls = [];
  state.fail = {};
  state.noDb = false;
  mocks.verify.mockReset().mockImplementation(async () => ({ wallet: state.signer, params: state.params, via: "session" }));
  mocks.gate.mockReset().mockResolvedValue("admin");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── Authorization ────────────────────────────────────────────────────────────

describe("admin badges: authorization", () => {
  it("verifies the session read action and gates admin-or-provider before any read", async () => {
    const { POST } = await load();
    const { res } = await call(POST);
    expect(res.status).toBe(200);
    expect(mocks.verify).toHaveBeenCalledWith(expect.any(Request), "admin.badges");
    expect(mocks.gate).toHaveBeenCalledWith(ADMIN);
  });

  it.each([401, 403, 503])("a %i from the signature or the gate passes through with no database call", async (status) => {
    const { POST, SiwsError } = await load();
    if (status === 401) mocks.verify.mockRejectedValue(new SiwsError(401, "Wallet session expired — sign in again"));
    else mocks.gate.mockRejectedValue(new SiwsError(status, status === 403 ? "Admin or KYC provider privileges required" : "Authorization check unavailable — try again"));
    const { res } = await call(POST);
    expect(res.status).toBe(status);
    expect(state.calls).toHaveLength(0);
  });

  it("an admin gets exactly the 13 queues, in menu order", async () => {
    const { POST } = await load();
    const { body } = await call(POST);
    expect(Object.keys(body.data.badges)).toEqual([...ADMIN_BADGE_HREFS]);
    expect(body.data.network).toBe("devnet");
  });

  it("the KYC provider gets only Clients (without KYB) and KYC, and no admin-only table is read", async () => {
    state.signer = PROVIDER;
    mocks.gate.mockResolvedValue("kycProvider");
    const { POST } = await load();
    const { body } = await call(POST);
    expect(Object.keys(body.data.badges)).toEqual(["/admin/clients", "/admin/kyc"]);
    for (const table of ADMIN_ONLY_TABLES) expect(tablesQueried().has(table)).toBe(false);
    // The KYB candidate read never runs for the provider…
    const kybCandidates = state.calls.filter((c) => c.table === "client_verification_details" &&
      c.ops.some((o) => o[0] === "eq" && o[1] === "kind"));
    expect(kybCandidates).toHaveLength(0);
    // …and neither the KYB reason nor its part is counted.
    expect(body.data.badges["/admin/clients"]).toMatchObject({ count: 5, parts: { final: 3, documents: 2 } });
    expect(body.data.badges["/admin/clients"].parts).not.toHaveProperty("kyb");
  });

  it("503 when the database client cannot be built (env unset)", async () => {
    state.noDb = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await load();
    const { res, body } = await call(POST);
    expect(res.status).toBe(503);
    expect(body.error).toBe("Admin badges unavailable — try again");
  });
});

// ── Counting rules ───────────────────────────────────────────────────────────

describe("admin badges: what each queue counts", () => {
  it("counts only rows whose next step is the admin's", async () => {
    const { POST } = await load();
    const { res, body } = await call(POST);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const b = body.data.badges;
    expect(b["/admin/issuers"]).toEqual({ count: 1 });
    expect(b["/admin/applications"]).toEqual({ count: 1, latest: "2026-09-24T08:00:00.000Z" });
    // M2: only the draft with a verified issuer AND a share class.
    expect(b["/admin/assets"]).toEqual({
      count: 1, parts: { ready: 1 }, aside: { issuerNotVerified: 1, noShareClasses: 1 },
    });
    // S1: every expired open sale; the parts say who can close it.
    expect(b["/admin/launchpad"]).toEqual({ count: 2, parts: { yours: 1, issuers: 1 } });
    // M5: requested + deposited (+ in_delivery); never vault_opened or the legacy approved.
    expect(b["/admin/custody"]).toEqual({ count: 5, parts: { delivery: 3, conversion: 2 } });
    expect(b["/admin/otc"]).toEqual({ count: 2 });
    expect(b["/admin/governance"]).toEqual({ count: 1 });
    expect(b["/admin/vesting"]).toEqual({ count: 2 });
    expect(b["/admin/inquiries"]).toEqual({ count: 3, parts: { new: 2, inReview: 1 } });
    // S3: new requests are the number; in-review ones are named, not counted.
    expect(b["/admin/kyc"]).toEqual({ count: 2, parts: { new: 2 }, aside: { inReview: 1 }, latest: "2026-09-25T11:00:00.000Z" });
    expect(b["/admin/compliance"]).toEqual({ count: 3, parts: { open: 2, escalated: 1 } });
    expect(b["/admin/payouts"]).toEqual({ count: 1 });
  });

  it("Clients: distinct dossiers with a reviewer step (M3, S5, S6), overlap counted once", async () => {
    const { POST } = await load();
    const { body } = await call(POST);
    // 1, 5, 12 final · 2, 6 documents · 7, 12 kyb → 6 dossiers (12 is in two).
    expect(body.data.badges["/admin/clients"]).toEqual({
      count: 6,
      parts: { final: 3, documents: 2, kyb: 2 },
      // Newest submitted/approved document or details change among the counted dossiers.
      latest: "2026-09-25T09:30:00.000Z",
    });
  });

  it("the vesting filter is the exact shared constant", async () => {
    const { POST } = await load();
    await call(POST);
    const vesting = state.calls.find((c) => c.table === "vesting_series")!;
    expect(vesting.ops).toContainEqual(["or", VESTING_REVIEW_FILTER]);
  });

  it("Launchpad's own part filters on the caller's wallet", async () => {
    const { POST } = await load();
    await call(POST);
    const sales = state.calls.filter((c) => c.table === "sales");
    expect(sales.some((c) => c.ops.some((o) => o[0] === "eq" && o[1] === "authority" && o[2] === ADMIN))).toBe(true);
  });

  it("a capped candidate read marks the Clients number as a lower bound", async () => {
    state.tables.clients = Array.from({ length: 1000 }, (_, i) => ({ id: uuid(1000 + i), network: "devnet", kyc_status: "pending", anonymized_at: null }));
    state.tables.kyc_requirements = state.tables.clients.map((c) => ({ client_id: c.id, status: "approved", updated_at: iso(-1000) }));
    state.tables.client_verification_details = [];
    const { POST } = await load();
    const { body } = await call(POST);
    expect(body.data.badges["/admin/clients"]).toMatchObject({ count: 1000, atLeast: true });
    // The id reads are chunked, never one giant `in()`.
    const byId = state.calls.filter((c) => c.table === "kyc_requirements" && c.ops.some((o) => o[0] === "in"));
    expect(byId.length).toBeGreaterThan(1);
    for (const c of byId) expect((c.ops.find((o) => o[0] === "in")![2] as unknown[]).length).toBeLessThanOrEqual(150);
  });

  it("hygiene: only integers, fixed keys, reason keys and timestamps leave the server", async () => {
    const { POST } = await load();
    const { body } = await call(POST);
    const reasonKeys = new Set(["indexer", "unavailable"]);
    for (const badge of Object.values(body.data.badges)) {
      for (const [key, value] of Object.entries(badge)) {
        if (key === "count") expect(value === null || Number.isInteger(value)).toBe(true);
        else if (key === "parts" || key === "aside") {
          for (const n of Object.values(value as Record<string, unknown>)) expect(Number.isInteger(n)).toBe(true);
        } else if (key === "atLeast") expect(value).toBe(true);
        else if (key === "latest") expect(new Date(value as string).toISOString()).toBe(value);
        else if (key === "reason") expect(reasonKeys.has(value as string)).toBe(true);
        else throw new Error(`unexpected badge field ${key}`);
      }
    }
    const text = JSON.stringify(body);
    for (const secret of [uuid(1), "I1", "S1", ADMIN, ISSUER, "w1"]) expect(text).not.toContain(secret);
  });
});

// ── Network scoping ──────────────────────────────────────────────────────────

describe("admin badges: network scoping", () => {
  it("every read of a table with a network column is scoped to this deployment's network", async () => {
    const { POST } = await load();
    await call(POST);
    for (const { table, ops } of state.calls) {
      if (!NETWORK_TABLES.includes(table)) continue;
      expect(ops, table).toContainEqual(["eq", "network", "devnet"]);
    }
  });

  it("pins the two unscoped tables (no network column yet), so a later column forces an update here", async () => {
    const { POST } = await load();
    await call(POST);
    for (const table of ["passport_requests", "payout_schedules"]) {
      const calls = state.calls.filter((c) => c.table === table);
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c.ops.some((o) => o[1] === "network")).toBe(false);
    }
  });

  it("dossier child tables are scoped through a clients read that carries the network and skips erased rows", async () => {
    const { POST } = await load();
    await call(POST);
    const clientReads = state.calls.filter((c) => c.table === "clients");
    expect(clientReads.length).toBeGreaterThan(0);
    for (const c of clientReads) {
      expect(c.ops).toContainEqual(["eq", "network", "devnet"]);
      expect(c.ops).toContainEqual(["is", "anonymized_at", null]);
    }
  });

  it("mainnet rows never reach a devnet count", async () => {
    // Make every mainnet row a match for its queue: nothing may change.
    const { POST } = await load();
    const before = (await call(POST)).body.data.badges;
    for (const rows of Object.values(state.tables)) {
      for (const r of [...rows]) if (r.network === "mainnet") rows.push({ ...r, id: `${r.id}-copy`, pda: `${r.pda}-copy` });
    }
    const { POST: fresh } = await load();
    expect((await call(fresh)).body.data.badges).toEqual(before);
  });
});

// ── Failure isolation and the indexer gate ───────────────────────────────────

describe("admin badges: one failing count never fails the menu", () => {
  it("an error result, a throw and a hang each null only their own queue", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.fail = { otc_requests: "error", compliance_alerts: "throw", custom_inquiries: "hang" };
    const { POST } = await load();
    state.params = {};
    const pending = POST(request());
    await vi.advanceTimersByTimeAsync(4_100);
    const res = await pending;
    const body = (await res.json()) as Body;
    expect(res.status).toBe(200);
    const b = body.data.badges;
    for (const href of ["/admin/otc", "/admin/compliance", "/admin/inquiries"]) {
      expect(b[href]).toEqual({ count: null, reason: "unavailable" });
    }
    expect(b["/admin/clients"].count).toBe(6);
    expect(b["/admin/applications"].count).toBe(1);
    // Logged by queue and error code/message only.
    expect(warn).toHaveBeenCalledWith("[api/admin/badges] /admin/otc failed:", "XX000");
    expect(warn).toHaveBeenCalledWith("[api/admin/badges] /admin/compliance failed:", "network down");
    expect(warn).toHaveBeenCalledWith("[api/admin/badges] /admin/inquiries failed:", "timed out");
  });

  it.each([
    ["warming", () => { state.tables.indexer_sync_state[0].status = "warming"; }],
    ["stale", () => { state.tables.indexer_sync_state[0].checked_at = iso(-6 * 60_000); }],
    ["from the future", () => { state.tables.indexer_sync_state[0].checked_at = iso(60_000); }],
    ["missing", () => { state.tables.indexer_sync_state = []; }],
  ])("an indexer that is %s nulls the four indexer queues without reading their tables", async (_label, arrange) => {
    arrange();
    const { POST } = await load();
    const { body } = await call(POST);
    for (const href of ["/admin/issuers", "/admin/assets", "/admin/launchpad", "/admin/governance"]) {
      expect(body.data.badges[href]).toEqual({ count: null, reason: "indexer" });
    }
    for (const table of INDEXER_TABLES) expect(tablesQueried().has(table)).toBe(false);
    expect(body.data.badges["/admin/otc"]).toEqual({ count: 2 });
  });

  it("a failing freshness read counts as not fresh", async () => {
    state.fail = { indexer_sync_state: "error" };
    const { POST } = await load();
    const { body } = await call(POST);
    expect(body.data.badges["/admin/issuers"]).toEqual({ count: null, reason: "indexer" });
  });

  it("the KYC provider never reads the indexer state (it has no indexer queue)", async () => {
    mocks.gate.mockResolvedValue("kycProvider");
    const { POST } = await load();
    await call(POST);
    expect(tablesQueried().has("indexer_sync_state")).toBe(false);
  });
});

// ── Memo ─────────────────────────────────────────────────────────────────────

describe("admin badges: memo", () => {
  it("a second read within 10 s makes no queries; `fresh` reads again", async () => {
    const { POST } = await load();
    await call(POST);
    const first = state.calls.length;
    expect(first).toBeGreaterThan(0);
    await call(POST);
    expect(state.calls.length).toBe(first);
    state.tables.otc_requests.push({ id: 7, network: "devnet", status: "requested" });
    const stale = (await call(POST)).body.data.badges["/admin/otc"];
    expect(stale).toEqual({ count: 2 });
    // `fresh` right after the memo was filled is throttled for a second…
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 1_500 });
    const fresh = (await call(POST, { fresh: true })).body.data.badges["/admin/otc"];
    expect(fresh).toEqual({ count: 3 });
    expect(state.calls.length).toBeGreaterThan(first);
  });

  it("roles and wallets never share an entry", async () => {
    const { POST } = await load();
    await call(POST);
    const adminCalls = state.calls.length;
    mocks.gate.mockResolvedValue("kycProvider");
    await call(POST);
    expect(state.calls.length).toBeGreaterThan(adminCalls);
    const providerCalls = state.calls.length;
    mocks.gate.mockResolvedValue("admin");
    state.signer = "OtherAdminWa11etOtherAdminWa11et1";
    await call(POST);
    expect(state.calls.length).toBeGreaterThan(providerCalls);
  });
});

// ── The Clients page reproduces the badge ────────────────────────────────────

describe("clients/admin-list: the 'Needs review' tab uses the badge's reader", () => {
  async function adminList(params: Record<string, unknown> = { review: true }) {
    vi.resetModules();
    state.params = params;
    const { POST } = await import("@/app/api/clients/admin-list/route");
    const res = await POST(new Request("https://manci.test/api/clients/admin-list", { method: "POST", body: "{}" }));
    return { res, body: (await res.json()) as { data: { clients: Array<{ id: string; review_reasons?: string[] }>; review_available: boolean } } };
  }

  it("annotates each row with its reasons; the rows with any reason equal the badge count", async () => {
    const { body } = await adminList();
    expect(body.data.review_available).toBe(true);
    const flagged = body.data.clients.filter((c) => (c.review_reasons ?? []).length > 0);
    expect(flagged.map((c) => c.id).sort()).toEqual([1, 2, 5, 6, 7, 12].map(uuid).sort());
    expect(body.data.clients.find((c) => c.id === uuid(12))?.review_reasons).toEqual(["final", "kyb"]);
    expect(body.data.clients.find((c) => c.id === uuid(3))?.review_reasons).toEqual([]);
    const { POST } = await load();
    expect((await call(POST)).body.data.badges["/admin/clients"].count).toBe(flagged.length);
  });

  it("the other directory readers (no `review`) skip the review reads", async () => {
    const { body } = await adminList({});
    expect(body.data).not.toHaveProperty("review_available");
    expect(body.data.clients[0]).not.toHaveProperty("review_reasons");
    expect([...tablesQueried()]).toEqual(["clients"]);
  });

  it("a KYC provider sees no KYB reason", async () => {
    mocks.gate.mockResolvedValue("kycProvider");
    const { body } = await adminList();
    expect(body.data.clients.find((c) => c.id === uuid(7))?.review_reasons).toEqual([]);
    expect(body.data.clients.find((c) => c.id === uuid(12))?.review_reasons).toEqual(["final"]);
  });

  it("a failing review read still returns the directory, flagged unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    state.fail = { kyc_requirements: "error" };
    const { res, body } = await adminList();
    expect(res.status).toBe(200);
    expect(body.data.review_available).toBe(false);
    expect(body.data.clients.length).toBeGreaterThan(0);
    expect(body.data.clients[0]).not.toHaveProperty("review_reasons");
  });
});
