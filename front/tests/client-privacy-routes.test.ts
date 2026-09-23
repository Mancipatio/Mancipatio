// KYC access logging and GDPR routes, run for real against an in-memory
// Supabase stand-in (tables, storage buckets, rpc) with SIWS, the on-chain
// admin gate, the on-chain passport check and the maintenance flag mocked:
//   * /api/clients/doc-url  — 120 s URL, audit row BEFORE the URL, 503 + no
//                             URL when the audit write fails, no timeline
//                             note during maintenance, network-bound
//   * /api/audit            — refuses the server-only "kyc" category
//   * /api/clients/export   — admin gate, audit-logged bundle, no token, every
//                             wallet of the account, operators pseudonymised
//   * /api/clients/anonymize — Super Admin + typed confirmation, dry-run and
//                             live-passport preflight, audit before any file
//                             is deleted, legacy public-bucket files, shared
//                             and repository paths kept, late uploads swept,
//                             no row deletes / cascades from the route
//   * /api/clients/upload   — an upload that overlapped an erasure is rolled back
//   * /api/clients/admin-detail — works without migration 0065's column
//   * /api/storage/documents/list + /url — confidential files signed on click,
//                             logged, never pre-signed or public
//   * /api/tos/accept       — unique (wallet, version) conflict = accepted
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
type Call = { op: string; table?: string; payload?: unknown };

const state = vi.hoisted(() => ({
  wallet: "",
  via: "signature" as "signature" | "session",
  params: {} as Record<string, unknown>,
  admins: new Set<string>(),
  superAdmins: new Set<string>(),
  tables: {} as Record<string, Row[]>,
  objects: new Set<string>(),
  calls: [] as Call[],
  failAudit: false,
  failRemove: false,
  /** Remove calls from this 1-based index on fail (null = never). */
  failRemoveFrom: null as number | null,
  removeCalls: 0,
  tosConflict: false,
  /** Columns the database does not have yet (select naming one errors). */
  missingColumns: new Set<string>(),
  onInsert: null as null | ((table: string, row: Record<string, unknown>) => void),
  /** Reads of this table fail (null = none). */
  failSelectTable: null as string | null,
  passport: "none" as "none" | "live" | "error",
  maintenance: false,
  rpc: (() => ({ data: null, error: null })) as (fn: string, args: Record<string, unknown>) => {
    data: unknown;
    error: { code?: string; message?: string } | null;
  },
  nextId: 1,
}));

vi.mock("@/lib/server/siws", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/siws")>();
  return {
    ...real,
    verifySigned: vi.fn(async () => ({ wallet: state.wallet, params: state.params, via: state.via })),
  };
});

vi.mock("@/lib/server/admin-gate", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    requireAdmin: vi.fn(async (wallet: string) => {
      if (!state.admins.has(wallet) && !state.superAdmins.has(wallet)) {
        throw new SiwsError(403, "Admin privileges required");
      }
    }),
    requireSuperAdmin: vi.fn(async (wallet: string) => {
      if (!state.superAdmins.has(wallet)) throw new SiwsError(403, "Super admin privileges required");
    }),
  };
});

vi.mock("@/lib/server/passport-state", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    assertNoLivePassport: vi.fn(async (wallet: string | null) => {
      state.calls.push({ op: "passport", payload: wallet });
      if (!wallet) return;
      if (state.passport === "error") throw new SiwsError(503, "Could not check the on-chain passport");
      if (state.passport === "live") throw new SiwsError(409, "live on-chain passport");
    }),
  };
});

vi.mock("@/lib/server/maintenance", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/maintenance")>();
  return {
    ...real,
    getMaintenance: vi.fn(async () => ({ enabled: state.maintenance, message: null })),
    assertWritable: vi.fn(async () => {
      if (state.maintenance) throw new real.MaintenanceError(null);
    }),
  };
});

/** Split a PostgREST `or` expression at top-level commas. */
function orParts(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function rowsOf(table: string): Row[] {
  state.tables[table] ??= [];
  return state.tables[table];
}

function from(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: Row | null = null;
  let head = false;
  let columns = "*";
  const run = async (single: boolean) => {
    state.calls.push({ op, table, payload });
    const missing = [...state.missingColumns].find((c) => op === "select" && columns.split(",").includes(c));
    if (missing) return { data: null, error: { code: "42703", message: `column ${table}.${missing} does not exist` } };
    if (op === "select" && state.failSelectTable === table) return { data: null, error: { message: "db down" } };
    if (op === "insert") {
      state.onInsert?.(table, payload ?? {});
      if (table === "audit_events" && state.failAudit) return { data: null, error: { message: "audit down" } };
      if (table === "tos_acceptances" && state.tosConflict) {
        return { data: null, error: { code: "23505", message: "duplicate key value" } };
      }
      const row = { id: `${table}-${state.nextId++}`, ...payload };
      rowsOf(table).push(row);
      return { data: single ? row : [row], error: null };
    }
    const matched = rowsOf(table).filter((r) => filters.every((f) => f(r)));
    if (op === "update") {
      for (const r of matched) Object.assign(r, payload);
      return { data: null, error: null };
    }
    if (op === "delete") {
      state.tables[table] = rowsOf(table).filter((r) => !matched.includes(r));
      return { data: null, error: null };
    }
    if (head) return { data: null, error: null, count: matched.length };
    return single ? { data: matched[0] ?? null, error: null } : { data: matched, error: null };
  };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: (cols?: string, opts?: { head?: boolean }) => {
      if (opts?.head) head = true;
      if (op === "select" && typeof cols === "string") columns = cols.replace(/\s+/g, "");
      return b;
    },
    eq: (column: string, value: unknown) => {
      filters.push((r) => r[column] === value);
      return b;
    },
    neq: (column: string, value: unknown) => {
      filters.push((r) => r[column] !== value);
      return b;
    },
    in: (column: string, values: unknown[]) => {
      filters.push((r) => values.includes(r[column]));
      return b;
    },
    is: (column: string, value: unknown) => {
      filters.push((r) => (r[column] ?? null) === value);
      return b;
    },
    or: (expr: string) => {
      const parts = orParts(expr).map((part) => {
        const [column, operator, ...rest] = part.split(".");
        return [column, operator, rest.join(".")] as const;
      });
      filters.push((r) => parts.some(([column, operator, value]) =>
        operator === "in"
          ? value.replace(/[()]/g, "").split(",").includes(String(r[column]))
          : String(r[column]) === value));
      return b;
    },
    not: (column: string, _op: string, value: string) => {
      const values = value.replace(/[()]/g, "").split(",");
      filters.push((r) => !values.includes(String(r[column])));
      return b;
    },
    order: () => b,
    limit: () => b,
    range: () => b,
    abortSignal: () => b,
    insert: (row: Row) => {
      op = "insert";
      payload = row;
      return b;
    },
    update: (patch: Row) => {
      op = "update";
      payload = patch;
      return b;
    },
    delete: () => {
      op = "delete";
      return b;
    },
    maybeSingle: () => run(true),
    single: () => run(true),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => run(false).then(resolve, reject),
  });
  return b;
}

function bucket(name: string) {
  const signed = (path: string, ttl: number) => `https://storage.test/${name}/${path}?ttl=${ttl}`;
  return {
    createSignedUrl: async (path: string, ttl: number) => {
      state.calls.push({ op: "sign", payload: { bucket: name, path, ttl } });
      return state.objects.has(`${name}:${path}`)
        ? { data: { signedUrl: signed(path, ttl) }, error: null }
        : { data: null, error: { message: "Object not found" } };
    },
    createSignedUrls: async (paths: string[], ttl: number) => {
      state.calls.push({ op: "signMany", payload: { bucket: name, paths, ttl } });
      return {
        data: paths.map((path) =>
          state.objects.has(`${name}:${path}`)
            ? { path, signedUrl: signed(path, ttl), error: null }
            : { path, signedUrl: null, error: "Object not found" },
        ),
        error: null,
      };
    },
    list: async (prefix: string) => {
      state.calls.push({ op: "list", payload: { bucket: name, prefix } });
      const entries = new Map<string, { name: string; id: string | null }>();
      for (const key of state.objects) {
        const [b, path] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
        if (b !== name || !path.startsWith(`${prefix}/`)) continue;
        const rest = path.slice(prefix.length + 1).split("/");
        entries.set(rest[0], { name: rest[0], id: rest.length > 1 ? null : `obj-${rest[0]}` });
      }
      return { data: [...entries.values()], error: null };
    },
    upload: async (path: string) => {
      state.calls.push({ op: "upload", payload: { bucket: name, path } });
      state.objects.add(`${name}:${path}`);
      return { data: { path }, error: null };
    },
    remove: async (paths: string[]) => {
      state.calls.push({ op: "remove", payload: { bucket: name, paths } });
      state.removeCalls += 1;
      if (state.failRemove || (state.failRemoveFrom !== null && state.removeCalls >= state.failRemoveFrom)) {
        return { data: null, error: { message: "storage down" } };
      }
      const gone = paths.filter((p) => state.objects.delete(`${name}:${p}`));
      return { data: gone.map((p) => ({ name: p })), error: null };
    },
  };
}

vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.calls.push({ op: "rpc", payload: { fn, args } });
      return state.rpc(fn, args);
    },
    storage: { from: bucket },
  }),
}));

const ADMIN = "AdminWa11etAdminWa11etAdminWa11et1";
const SUPER = "SuperWa11etSuperWa11etSuperWa11et1";
const STRANGER = "StrangerWa11etStrangerWa11etStra1";
const CLIENT_WALLET = "C1ientWa11etC1ientWa11etC1ientWa1";
const CLIENT_ID = "c0000000-0000-4000-8000-000000000003";
const DOC_PATH = `clients/${CLIENT_ID}/passport/aaaa-passport.pdf`;
const LEGACY_PATH = "legacy/old-scan.pdf";
const ORPHAN_PATH = `clients/${CLIENT_ID}/selfie/cccc-selfie.jpg`;
const OTHER_WALLET = "ZtherWa11etZtherWa11etZtherWa11et";
const ACCOUNT_ID = "a0000000-0000-4000-8000-0000000000aa";
const OTHER_CLIENT_ID = "c0000000-0000-4000-8000-000000000009";

const request = () => new Request("https://manci.test/api", { method: "POST" });
const post = async (handler: (r: Request) => Promise<Response>) => {
  const res = await handler(request());
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string } };
};
const auditRows = () =>
  state.calls.filter((c) => c.op === "insert" && c.table === "audit_events").map((c) => c.payload as Row);
const opsOf = (...ops: string[]) => state.calls.filter((c) => ops.includes(c.op));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.test");
  state.wallet = ADMIN;
  state.via = "signature";
  state.params = {};
  state.admins = new Set([ADMIN]);
  state.superAdmins = new Set([SUPER]);
  state.objects = new Set([`client-documents:${DOC_PATH}`, `client-documents:${ORPHAN_PATH}`]);
  state.calls = [];
  state.failAudit = false;
  state.failRemove = false;
  state.failRemoveFrom = null;
  state.removeCalls = 0;
  state.tosConflict = false;
  state.missingColumns = new Set();
  state.onInsert = null;
  state.failSelectTable = null;
  state.passport = "none";
  state.maintenance = false;
  state.nextId = 1;
  state.rpc = () => ({ data: null, error: null });
  state.tables = {
    clients: [{
      id: CLIENT_ID, network: "devnet", wallet: CLIENT_WALLET, account_id: null, email: "carol@x.test",
      display_name: "Carol Example", kyc_status: "verified", onboarding_token: "secret-token",
      created_at: "2026-01-01T00:00:00Z", tos_accepted_at: null, anonymized_at: null,
    }],
    client_documents: [
      { id: 11, client_id: CLIENT_ID, kind: "passport", storage_path: DOC_PATH },
      { id: 12, client_id: CLIENT_ID, kind: "proof_of_address", storage_path: LEGACY_PATH },
    ],
    client_notes: [{ id: 1, client_id: CLIENT_ID, author: ADMIN, body: "Met at the fair", kind: "note" }],
    tos_acceptances: [
      { id: 1, client_id: null, wallet: CLIENT_WALLET, version: "v1", source: "wallet-gate" },
      { id: 2, client_id: null, wallet: "SomeoneE1seWa11etSomeoneE1seWa11", version: "v1", source: "wallet-gate" },
    ],
    passport_requests: [{ id: "p1", wallet: CLIENT_WALLET, note: "I live in Berlin" }],
    audit_events: [],
  };
});
afterEach(() => vi.unstubAllEnvs());

describe("KYC document view (/api/clients/doc-url)", () => {
  it("signs a 120 s URL and logs the view, server-attributed, before returning it", async () => {
    const { POST } = await import("@/app/api/clients/doc-url/route");
    state.via = "session";
    state.params = { document_id: 11 };
    const { status, body } = await post(POST);
    expect(status).toBe(200);
    expect(body.data).toEqual({ url: `https://storage.test/client-documents/${DOC_PATH}?ttl=120`, expires_in: 120 });
    const audit = auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      network: "devnet",
      ix_name: "kyc_document_view",
      category: "kyc",
      actor_wallet: ADMIN,
      target_label: CLIENT_ID,
      status: "success",
      metadata: {
        document_id: 11, kind: "passport", ttl: 120, actor_wallet: ADMIN,
        actor_verified: true, actor_source: "siws-session",
      },
    });
    // Timeline note (system) after the audit row.
    const note = state.calls.find((c) => c.op === "insert" && c.table === "client_notes");
    expect(note?.payload).toMatchObject({ client_id: CLIENT_ID, author: ADMIN, kind: "system" });
    expect(state.calls.indexOf(note!)).toBeGreaterThan(state.calls.findIndex((c) => c.table === "audit_events"));
  });

  it("answers 503 and hands out no URL when the access cannot be logged", async () => {
    const { POST } = await import("@/app/api/clients/doc-url/route");
    state.failAudit = true;
    state.params = { document_id: 11 };
    const { status, body } = await post(POST);
    expect(status).toBe(503);
    expect(JSON.stringify(body)).not.toContain("storage.test");
    expect(state.calls.some((c) => c.op === "insert" && c.table === "client_notes")).toBe(false);
  });

  it("refuses non-admins before touching storage or the log", async () => {
    const { POST } = await import("@/app/api/clients/doc-url/route");
    state.wallet = STRANGER;
    state.params = { document_id: 11 };
    expect((await post(POST)).status).toBe(403);
    expect(opsOf("sign", "insert")).toEqual([]);
  });

  it("gives a legacy file outside the private bucket no link (404), and logs no view", async () => {
    const { POST } = await import("@/app/api/clients/doc-url/route");
    state.params = { document_id: 12 };
    expect((await post(POST)).status).toBe(404);
    expect(auditRows()).toEqual([]);
  });

  it("answers 404 for a document of another network's dossier, before signing or logging", async () => {
    const { POST } = await import("@/app/api/clients/doc-url/route");
    state.tables.clients.push({ id: OTHER_CLIENT_ID, network: "mainnet", wallet: OTHER_WALLET, display_name: "Mainnet client" });
    const path = `clients/${OTHER_CLIENT_ID}/passport/dddd-passport.pdf`;
    state.tables.client_documents.push({ id: 13, client_id: OTHER_CLIENT_ID, kind: "passport", storage_path: path });
    state.objects.add(`client-documents:${path}`);
    state.params = { document_id: 13 };
    expect((await post(POST)).status).toBe(404);
    expect(opsOf("sign")).toEqual([]);
    expect(auditRows()).toEqual([]);
  });

  it("still logs the view during maintenance but leaves the timeline alone", async () => {
    const { POST } = await import("@/app/api/clients/doc-url/route");
    state.maintenance = true;
    state.via = "session";
    state.params = { document_id: 11 };
    const { status, body } = await post(POST);
    expect(status).toBe(200);
    expect(body.data?.url).toContain(DOC_PATH);
    expect(auditRows()).toHaveLength(1);
    expect(state.calls.filter((c) => c.table === "client_notes" || (c.table === "clients" && c.op === "update"))).toEqual([]);
  });
});

describe("unsigned audit breadcrumbs (/api/audit)", () => {
  it("cannot write the server-only kyc category", async () => {
    const { POST } = await import("@/app/api/audit/route");
    const res = await POST(new Request("https://manci.test/api/audit", {
      method: "POST",
      body: JSON.stringify({ ix_name: "kyc_document_view", category: "kyc", actor_wallet: ADMIN, reason: "" }),
    }));
    expect(res.status).toBe(400);
    expect(auditRows()).toEqual([]);
  });
});

describe("GDPR export (/api/clients/export)", () => {
  it("is admin-only and reads nothing for anyone else", async () => {
    const { POST } = await import("@/app/api/clients/export/route");
    state.wallet = STRANGER;
    state.params = { client_id: CLIENT_ID };
    expect((await post(POST)).status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it("returns the dossier bundle with fresh short links, without the onboarding token, and logs it", async () => {
    const { POST } = await import("@/app/api/clients/export/route");
    state.params = { client_id: CLIENT_ID };
    const { status, body } = await post(POST);
    expect(status).toBe(200);
    const bundle = body.data!;
    expect(bundle).toMatchObject({
      format: "manci.client-data-export.v1",
      client_id: CLIENT_ID,
      network: "devnet",
      document_links_expire_in_seconds: 600,
      account: null,
      passport_requests: [{ wallet: CLIENT_WALLET, note: "I live in Berlin" }],
      // The note text stays; the operator who wrote it is not named.
      notes: [{ body: "Met at the fair", author: "operator" }],
      // Linked by wallet (wallet-gate) even without a dossier link; others excluded.
      tos_acceptances: [{ id: 1, wallet: CLIENT_WALLET }],
    });
    expect(bundle.generated_by).toBeUndefined();
    const client = bundle.client as Row;
    expect(client.onboarding_token).toBeUndefined();
    expect(client.onboarding_token_present).toBe(true);
    expect(client.email).toBe("carol@x.test");
    const docs = bundle.documents as Row[];
    expect(docs[0]).toMatchObject({ id: 11, download_url: `https://storage.test/client-documents/${DOC_PATH}?ttl=600` });
    expect(docs[1]).toMatchObject({ id: 12, download_url: null, download_unavailable: "file not found in storage" });
    expect(JSON.stringify(bundle)).not.toContain("secret-token");
    // The subject sees when the data was accessed, not which operator did it.
    state.tables.audit_events.push({
      network: "devnet", category: "kyc", target_label: CLIENT_ID, ix_name: "kyc_document_view",
      created_at: "2026-09-22T08:00:00Z", status: "success", actor_wallet: ADMIN,
      metadata: { document_id: 11, kind: "passport", actor_wallet: ADMIN },
    });
    const again = (await post(POST)).body.data!;
    expect(again.access_log).toHaveLength(2);
    expect(again.access_log).toEqual(expect.arrayContaining([
      { at: "2026-09-22T08:00:00Z", action: "kyc_document_view", status: "success", document_id: 11, document_kind: "passport" },
      expect.objectContaining({ action: "kyc_data_export" }),
    ]));
    expect(JSON.stringify(again.access_log)).not.toContain(ADMIN);
    expect(JSON.stringify(again)).not.toContain(ADMIN);
    expect(auditRows().slice(0, 1)).toEqual([
      expect.objectContaining({
        ix_name: "kyc_data_export",
        category: "kyc",
        target_label: CLIENT_ID,
        metadata: expect.objectContaining({ documents: 2, document_links: 1, ttl: 600, actor_verified: true, actor_source: "siws-signature" }),
      }),
    ]);
  });

  it("covers every wallet of the account, SPVs, vesting series and legacy files, naming no operator", async () => {
    const { POST } = await import("@/app/api/clients/export/route");
    state.tables.clients[0].account_id = ACCOUNT_ID;
    state.tables.account_profiles = [{ id: ACCOUNT_ID, network: "devnet", display_name: "Carol", email: "carol@x.test" }];
    state.tables.account_wallets = [
      { account_id: ACCOUNT_ID, network: "devnet", wallet: CLIENT_WALLET, linked_at: "2026-01-01T00:00:00Z" },
      { account_id: ACCOUNT_ID, network: "devnet", wallet: OTHER_WALLET, linked_at: "2026-02-01T00:00:00Z" },
    ];
    state.tables.tos_acceptances.push({ id: 3, client_id: null, wallet: OTHER_WALLET, version: "v1", source: "wallet-gate" });
    state.tables.passport_requests.push({ id: "p2", wallet: OTHER_WALLET, note: null, handled_by: ADMIN });
    state.tables.conversion_requests = [
      { id: 1, network: "devnet", holder_wallet: OTHER_WALLET, client_id: null, status: "converted", decided_by: ADMIN, admin_note: "Paid out" },
      { id: 2, network: "devnet", holder_wallet: STRANGER, client_id: null, status: "converted" },
    ];
    state.tables.spvs = [{ id: "s1", network: "devnet", client_id: CLIENT_ID, name: "Carol SPV d.o.o.", notes: "" }];
    state.tables.vesting_series = [
      { id: "v1", network: "devnet", client_wallet: OTHER_WALLET, client_id: null, reviewed_by: ADMIN, status: "created" },
      { id: "v2", network: "devnet", client_wallet: STRANGER, client_id: null, status: "created" },
    ];
    state.tables.client_documents.push({ id: 14, client_id: CLIENT_ID, kind: "selfie", storage_path: "clients/x/selfie.jpg", uploaded_by: CLIENT_WALLET });
    state.tables.client_notes.push({ id: 2, client_id: CLIENT_ID, author: CLIENT_WALLET, body: "Wallet linked", kind: "system" });
    state.objects.add(`documents:${LEGACY_PATH}`);
    state.params = { client_id: CLIENT_ID };
    const { status, body } = await post(POST);
    expect(status).toBe(200);
    const bundle = body.data!;
    expect((bundle.tos_acceptances as Row[]).map((r) => r.id)).toEqual([1, 3]);
    expect((bundle.passport_requests as Row[]).map((r) => [r.id, r.handled_by ?? null])).toEqual([["p1", null], ["p2", "operator"]]);
    expect(bundle.conversion_requests).toEqual([expect.objectContaining({ id: 1, decided_by: "operator", admin_note: "Paid out" })]);
    expect(bundle.spvs).toEqual([expect.objectContaining({ id: "s1", name: "Carol SPV d.o.o." })]);
    expect(bundle.vesting_series).toEqual([expect.objectContaining({ id: "v1", reviewed_by: "operator" })]);
    expect((bundle.account as { wallets: Row[] }).wallets.map((w) => w.wallet)).toEqual([CLIENT_WALLET, OTHER_WALLET]);
    // The person's own wallet is not an operator.
    expect((bundle.notes as Row[]).map((n) => n.author)).toEqual(["operator", CLIENT_WALLET]);
    expect((bundle.documents as Row[]).find((d) => d.id === 14)).toMatchObject({ uploaded_by: CLIENT_WALLET });
    // Pre-P1 file in the old public bucket: same short-lived signed link.
    expect((bundle.documents as Row[]).find((d) => d.id === 12)).toMatchObject({
      download_url: `https://storage.test/documents/${LEGACY_PATH}?ttl=600`,
      stored_in: "legacy public bucket (to be moved)",
    });
    expect(JSON.stringify(bundle)).not.toContain(ADMIN);
    expect(JSON.stringify(bundle)).not.toContain(STRANGER);
    expect((bundle.not_included as Row[]).map((n) => n.record)).toContain("operator identities");
  });

  it("returns nothing when the export cannot be logged", async () => {
    const { POST } = await import("@/app/api/clients/export/route");
    state.failAudit = true;
    state.params = { client_id: CLIENT_ID };
    const { status, body } = await post(POST);
    expect(status).toBe(503);
    expect(body.data).toBeUndefined();
  });

  it("needs a fresh signature and waits out maintenance", async () => {
    const { SESSION_READ_ACTIONS } = await import("@/lib/siws-session");
    const { refusedInMaintenance } = await import("@/lib/maintenance");
    for (const action of ["clients.export", "clients.anonymize"]) {
      expect(SESSION_READ_ACTIONS.has(action)).toBe(false);
      expect(refusedInMaintenance(action)).toBe(true);
    }
  });
});

describe("GDPR erasure (/api/clients/anonymize)", () => {
  const confirm = `ANONYMIZE ${CLIENT_ID.slice(0, 8)}`;
  const erased = {
    status: "anonymized",
    anonymized_at: "2026-09-23T10:00:00Z",
    storage_paths: [DOC_PATH, LEGACY_PATH],
    previous: { kyc_status: "verified" },
    counts: { documents: 2, verification_details: 1, notes_erased: 1, requirements_cleared: 0, tos_detached: 1, passport_request_notes: 1 },
  };
  const happyRpc = (_fn: string, args: Record<string, unknown>) =>
    args.p_dry_run ? { data: { status: "ready", anonymized_at: null }, error: null } : { data: erased, error: null };

  it("is Super Admin only — an admin is refused before anything runs", async () => {
    const { POST } = await import("@/app/api/clients/anonymize/route");
    state.params = { client_id: CLIENT_ID, confirm, reason: "Erasure request" };
    expect((await post(POST)).status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it("needs the typed confirmation for THIS dossier and a reason", async () => {
    const { POST } = await import("@/app/api/clients/anonymize/route");
    state.wallet = SUPER;
    state.params = { client_id: CLIENT_ID, confirm: "ANONYMIZE 00000000", reason: "Erasure request" };
    const wrong = await post(POST);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain(confirm);
    state.params = { client_id: CLIENT_ID, confirm, reason: "" };
    expect((await post(POST)).status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it("stops before any change when the database refuses or lacks the function", async () => {
    const { POST } = await import("@/app/api/clients/anonymize/route");
    state.wallet = SUPER;
    state.params = { client_id: CLIENT_ID, confirm, reason: "Erasure request" };
    state.rpc = () => ({ data: { status: "active_requests" }, error: null });
    expect((await post(POST)).status).toBe(409);
    state.rpc = () => ({ data: null, error: { code: "PGRST202", message: "function not found" } });
    expect((await post(POST)).status).toBe(503);
    expect(opsOf("remove", "list")).toEqual([]);
    expect(auditRows()).toEqual([]);
    // Only the dry run was ever called.
    expect(opsOf("rpc").every((c) => (c.payload as { args: Row }).args.p_dry_run === true)).toBe(true);
  });

  const label = (c: Call) =>
    c.op === "rpc" ? `rpc:${(c.payload as { args: Row }).args.p_dry_run ? "dry" : "run"}` : c.table ? `${c.op}:${c.table}` : c.op;
  const removesIn = (bucket: string) =>
    opsOf("remove").map((c) => c.payload as { bucket: string; paths: string[] }).filter((r) => r.bucket === bucket);

  it("logs, deletes the files, erases through the database function and never deletes a row itself", async () => {
    const { POST } = await import("@/app/api/clients/anonymize/route");
    state.wallet = SUPER;
    state.params = { client_id: CLIENT_ID, confirm, reason: "Erasure request 2026-09-20" };
    state.rpc = happyRpc;
    const { status, body } = await post(POST);
    expect(status).toBe(200);
    expect(body.data).toEqual({
      anonymized_at: "2026-09-23T10:00:00Z",
      counts: erased.counts,
      files_deleted: 2, // the row's file and the orphan under clients/<id>/
      legacy_files_deleted: 0,
      files_missing: 1, // the legacy path is in neither bucket
      files_shared: 0,
      files_left: 0,
      late_sweep_complete: true,
      files_for_review: [],
      audit_complete: true,
    });
    const sequence = state.calls.filter((c) => c.op !== "select" || c.table === "client_documents").map(label);
    expect(sequence).toEqual([
      "rpc:dry",
      "passport",
      "insert:audit_events",
      "select:client_documents",
      "list", "list", "list", "list", // private: root + 2 folders; legacy: root
      "select:client_documents", // shared with another dossier?
      "remove", "remove", // private, then legacy public bucket
      "rpc:run",
      "list", "select:client_documents", // sweep for raced uploads
      "insert:audit_events",
    ]);
    expect(new Set(removesIn("client-documents")[0].paths)).toEqual(new Set([DOC_PATH, LEGACY_PATH, ORPHAN_PATH]));
    expect(removesIn("documents")).toEqual([{ bucket: "documents", paths: [LEGACY_PATH] }]);
    expect(opsOf("passport")[0].payload).toBe(CLIENT_WALLET);
    expect(auditRows().map((r) => [r.ix_name, r.status, (r.metadata as Row).actor_verified])).toEqual([
      ["client_anonymize", "pending", true],
      ["client_anonymize", "success", true],
    ]);
    // The route itself deletes and updates nothing: the dossier and every
    // dependent row are handled by anonymize_client() (no cascade).
    expect(state.calls.filter((c) => c.op === "delete" || c.op === "update")).toEqual([]);
    expect(state.tables.clients).toHaveLength(1);
  });

  it("deletes pre-P1 copies from the old public bucket and keeps shared and repository files", async () => {
    const { POST } = await import("@/app/api/clients/anonymize/route");
    const legacyOrphan = `clients/${CLIENT_ID}/old/eeee-id.pdf`;
    const memo = "compliance/memo-carol.pdf";
    state.objects.add(`documents:${LEGACY_PATH}`);
    state.objects.add(`documents:${legacyOrphan}`);
    state.objects.add(`documents:${memo}`);
    state.tables.client_documents.push({ id: 15, client_id: CLIENT_ID, kind: "other", storage_path: memo });
    // Another dossier's row points at the same private file.
    state.tables.client_documents.push({ id: 16, client_id: OTHER_CLIENT_ID, kind: "passport", storage_path: DOC_PATH });
    state.wallet = SUPER;
    state.params = { client_id: CLIENT_ID, confirm, reason: "Erasure request" };
    state.rpc = (_fn, args) => args.p_dry_run
      ? { data: { status: "ready" }, error: null }
      : { data: { ...erased, storage_paths: [DOC_PATH, LEGACY_PATH, memo] }, error: null };
    const { status, body } = await post(POST);
    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      files_deleted: 3, // private orphan + legacy row file + legacy orphan
      legacy_files_deleted: 2,
      files_missing: 0,
      files_shared: 1,
      files_for_review: [memo],
    });
    expect(state.objects.has(`documents:${LEGACY_PATH}`)).toBe(false);
    expect(state.objects.has(`documents:${legacyOrphan}`)).toBe(false);
    expect(state.objects.has(`client-documents:${ORPHAN_PATH}`)).toBe(false);
    // Kept: the other dossier's file and the repository-folder file.
    expect(state.objects.has(`client-documents:${DOC_PATH}`)).toBe(true);
    expect(state.objects.has(`documents:${memo}`)).toBe(true);
    const success = auditRows().find((r) => r.status === "success")!;
    expect(success.metadata).toMatchObject({ files_for_review: [memo], files_shared: 1, legacy_files_deleted: 2 });
  });

  it("refuses while the wallet holds a live on-chain passport, before anything is logged or deleted", async () => {
    const { POST } = await import("@/app/api/clients/anonymize/route");
    state.wallet = SUPER;
    state.params = { client_id: CLIENT_ID, confirm, reason: "Erasure request" };
    state.rpc = happyRpc;
    state.passport = "live";
    expect((await post(POST)).status).toBe(409);
    state.passport = "error";
    expect((await post(POST)).status).toBe(503);
    expect(auditRows()).toEqual([]);
    expect(opsOf("list", "remove")).toEqual([]);
    expect(opsOf("rpc").every((c) => (c.payload as { args: Row }).args.p_dry_run === true)).toBe(true);
  });

  it("answers 409 with a failed audit row when the database refuses after the files were deleted", async () => {
    const { POST } = await import("@/app/api/clients/anonymize/route");
    state.wallet = SUPER;
    state.params = { client_id: CLIENT_ID, confirm, reason: "Erasure request" };
    state.rpc = (_fn, args) => args.p_dry_run
      ? { data: { status: "ready" }, error: null }
      : { data: { status: "active_requests" }, error: null };
    const { status, body } = await post(POST);
    expect(status).toBe(409);
    expect(body.error).toMatch(/already deleted; run it again/);
    expect(state.objects.has(`client-documents:${DOC_PATH}`)).toBe(false);
    expect(auditRows().map((r) => [r.status, r.reason])).toEqual([
      ["pending", "Erasure request"],
      ["failed", "Anonymization stopped at: database refused: active_requests"],
    ]);
  });

  it("sweeps files uploaded during the erasure and keeps a fresh upload that has its row", async () => {
    const { POST } = await import("@/app/api/clients/anonymize/route");
    const raced = `clients/${CLIENT_ID}/passport/ffff-raced.pdf`; // row erased by the function
    const orphan = `clients/${CLIENT_ID}/passport/9999-orphan.pdf`; // stored, row never written
    const fresh = `clients/${CLIENT_ID}/passport/8888-fresh.pdf`; // row written after the erasure
    state.wallet = SUPER;
    state.params = { client_id: CLIENT_ID, confirm, reason: "Erasure request" };
    state.rpc = (_fn, args) => {
      if (args.p_dry_run) return { data: { status: "ready" }, error: null };
      for (const p of [raced, orphan, fresh]) state.objects.add(`client-documents:${p}`);
      state.tables.client_documents = [{ id: 20, client_id: CLIENT_ID, kind: "passport", storage_path: fresh }];
      return { data: { ...erased, storage_paths: [DOC_PATH, LEGACY_PATH, raced] }, error: null };
    };
    const { status, body } = await post(POST);
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ files_deleted: 4, files_left: 0, late_sweep_complete: true });
    expect(state.objects.has(`client-documents:${raced}`)).toBe(false);
    expect(state.objects.has(`client-documents:${orphan}`)).toBe(false);
    expect(state.objects.has(`client-documents:${fresh}`)).toBe(true);
  });

  it("reports late files it could not delete so the operator runs it again", async () => {
    const { POST } = await import("@/app/api/clients/anonymize/route");
    const raced = `clients/${CLIENT_ID}/passport/ffff-raced.pdf`;
    state.wallet = SUPER;
    state.params = { client_id: CLIENT_ID, confirm, reason: "Erasure request" };
    state.rpc = (_fn, args) => {
      if (args.p_dry_run) return { data: { status: "ready" }, error: null };
      state.objects.add(`client-documents:${raced}`);
      return { data: { ...erased, storage_paths: [DOC_PATH, LEGACY_PATH, raced] }, error: null };
    };
    state.failRemoveFrom = 3; // private and legacy deletes pass; the late one fails
    const { status, body } = await post(POST);
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ files_left: 1, late_sweep_complete: true });
    const success = auditRows().find((r) => r.status === "success")!;
    expect((success.metadata as Row).files_left).toBe(1);
  });

  it("deletes nothing when the intent cannot be logged", async () => {
    const { POST } = await import("@/app/api/clients/anonymize/route");
    state.wallet = SUPER;
    state.params = { client_id: CLIENT_ID, confirm, reason: "Erasure request" };
    state.rpc = happyRpc;
    state.failAudit = true;
    expect((await post(POST)).status).toBe(503);
    expect(opsOf("remove", "list")).toEqual([]);
    expect(opsOf("rpc")).toHaveLength(1);
  });

  it("leaves the database untouched when the files cannot be deleted", async () => {
    const { POST } = await import("@/app/api/clients/anonymize/route");
    state.wallet = SUPER;
    state.params = { client_id: CLIENT_ID, confirm, reason: "Erasure request" };
    state.rpc = happyRpc;
    state.failRemove = true;
    const { status, body } = await post(POST);
    expect(status).toBe(500);
    expect(body.error).toMatch(/database was not changed/);
    expect(opsOf("rpc")).toHaveLength(1);
    expect(auditRows().map((r) => r.status)).toEqual(["pending", "failed"]);
  });
});

describe("KYC upload racing an erasure (/api/clients/upload)", () => {
  async function uploadRequest(name: string) {
    const { createHash } = await import("node:crypto");
    const bytes = new TextEncoder().encode(`%PDF-1.4 ${name}`);
    state.params = {
      client_id: CLIENT_ID, kind: "passport",
      sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
    };
    const form = new FormData();
    form.set("auth", JSON.stringify({ signed: true }));
    form.set("file", new File([bytes], name, { type: "application/pdf" }));
    return new Request("https://manci.test/api/clients/upload", { method: "POST", body: form });
  }
  const storedUploads = () => [...state.objects].filter((o) => o.includes("/passport/") && o.endsWith(".pdf") && !o.includes("aaaa"));

  it("rolls back an upload whose row was written after an erasure started", async () => {
    const { POST } = await import("@/app/api/clients/upload/route");
    // The row insert waited on anonymize_client's lock and commits after it.
    state.onInsert = (table) => {
      if (table === "client_documents") state.tables.clients[0].anonymized_at = "2026-09-23T10:00:00Z";
    };
    const res = await POST(await uploadRequest("scan.pdf"));
    expect(res.status).toBe(409);
    expect(storedUploads()).toEqual([]);
    expect(state.tables.client_documents.map((d) => d.id)).toEqual([11, 12]);
  });

  it("fails closed when the dossier cannot be re-read, keeping a file an earlier row still uses", async () => {
    const { POST } = await import("@/app/api/clients/upload/route");
    const req = await uploadRequest("dup.pdf");
    const path = `clients/${CLIENT_ID}/passport/${String(state.params.sha256).slice(0, 8)}-dup.pdf`;
    state.objects.add(`client-documents:${path}`);
    state.tables.client_documents.push({ id: 30, client_id: CLIENT_ID, kind: "passport", storage_path: path });
    state.onInsert = (table) => {
      if (table === "client_documents") state.failSelectTable = "clients";
    };
    expect((await POST(req)).status).toBe(503);
    expect(state.tables.client_documents.map((d) => d.id)).toEqual([11, 12, 30]);
    expect(state.objects.has(`client-documents:${path}`)).toBe(true);
  });

  it("keeps a normal upload, also on a dossier erased before it started (re-verification)", async () => {
    const { POST } = await import("@/app/api/clients/upload/route");
    expect((await POST(await uploadRequest("first.pdf"))).status).toBe(200);
    state.tables.clients[0].anonymized_at = "2026-09-01T00:00:00Z";
    expect((await POST(await uploadRequest("second.pdf"))).status).toBe(200);
    expect(storedUploads()).toHaveLength(2);
    expect(state.tables.client_documents).toHaveLength(4);
  });
});

describe("admin client detail (/api/clients/admin-detail)", () => {
  it("reads the dossier on a database without migration 0065's anonymized_at", async () => {
    const { POST } = await import("@/app/api/clients/admin-detail/route");
    state.missingColumns = new Set(["anonymized_at"]);
    state.params = { id: CLIENT_ID };
    const { status, body } = await post(POST);
    expect(status).toBe(200);
    expect((body.data!.client as Row).id).toBe(CLIENT_ID);
    expect(state.calls.filter((c) => c.table === "clients" && c.op === "select")).toHaveLength(2);
  });
});

describe("document repository (/api/storage/documents/list and /url)", () => {
  const MEMO = { id: "d0000000-0000-4000-8000-0000000000d1", category: "compliance", slug: "memo", version: 1, storage_path: "compliance/memo.pdf", external_url: null };
  const WP = { id: "d0000000-0000-4000-8000-0000000000d2", category: "legal", slug: "tos", version: 1, storage_path: "legal/tos.pdf", external_url: null };

  it("never pre-signs or publishes a confidential file; public files keep their URL", async () => {
    const { POST } = await import("@/app/api/storage/documents/list/route");
    state.tables.documents = [MEMO, WP];
    state.objects.add("documents-confidential:compliance/memo.pdf");
    const { status, body } = await post(POST);
    expect(status).toBe(200);
    const docs = (body.data as { documents: Row[] }).documents;
    expect(docs[0]).toMatchObject({ id: MEMO.id, download_url: null, download_on_request: true });
    expect(docs[1]).toMatchObject({
      id: WP.id,
      download_url: "https://project.supabase.test/storage/v1/object/public/documents/legal/tos.pdf",
    });
    expect(opsOf("sign", "signMany")).toEqual([]);
  });

  it("signs ONE confidential file for 120 s on click, logged before the URL leaves", async () => {
    const { POST } = await import("@/app/api/storage/documents/url/route");
    state.tables.documents = [MEMO, WP];
    state.objects.add("documents-confidential:compliance/memo.pdf");
    state.via = "session";
    state.params = { id: MEMO.id };
    const { status, body } = await post(POST);
    expect(status).toBe(200);
    expect(body.data).toEqual({ url: "https://storage.test/documents-confidential/compliance/memo.pdf?ttl=120", expires_in: 120 });
    expect(auditRows()).toEqual([expect.objectContaining({
      ix_name: "confidential_document_view",
      category: "kyc",
      target_label: `document:${MEMO.id}`,
      metadata: expect.objectContaining({ document_category: "compliance", ttl: 120, actor_verified: true, actor_source: "siws-session" }),
    })]);
    const { SESSION_READ_ACTIONS } = await import("@/lib/siws-session");
    expect(SESSION_READ_ACTIONS.has("storage.documents.url")).toBe(true);
  });

  it("hands out nothing when the view cannot be logged, the file is not private, or the caller is no admin", async () => {
    const { POST } = await import("@/app/api/storage/documents/url/route");
    state.tables.documents = [MEMO, WP];
    state.params = { id: MEMO.id };
    // Still in the old public bucket only: 404, no public link, nothing logged.
    state.objects.add("documents:compliance/memo.pdf");
    const legacy = await post(POST);
    expect(legacy.status).toBe(404);
    expect(JSON.stringify(legacy.body)).not.toContain("storage.test");
    expect(auditRows()).toEqual([]);
    state.objects.add("documents-confidential:compliance/memo.pdf");
    state.failAudit = true;
    const unlogged = await post(POST);
    expect(unlogged.status).toBe(503);
    expect(JSON.stringify(unlogged.body)).not.toContain("storage.test");
    state.failAudit = false;
    state.params = { id: WP.id };
    expect((await post(POST)).status).toBe(400);
    state.wallet = STRANGER;
    state.params = { id: MEMO.id };
    expect((await post(POST)).status).toBe(403);
    // Only the one failed attempt; nothing was ever stored.
    expect(auditRows()).toHaveLength(1);
    expect(state.tables.audit_events).toEqual([]);
  });
});

describe("Terms acceptance (/api/tos/accept)", () => {
  it("answers a unique (wallet, version) conflict as already accepted", async () => {
    const { TOS_VERSION } = await import("@/lib/tos-version");
    const { POST } = await import("@/app/api/tos/accept/route");
    state.wallet = "NewWa11etNewWa11etNewWa11etNewWa1";
    state.params = { version: TOS_VERSION };
    state.tosConflict = true;
    const { status, body } = await post(POST);
    expect(status).toBe(200);
    expect(body.data).toEqual({ accepted: true, version: TOS_VERSION, already: true });
  });

  it("links the wallet's earlier acceptance to the dossier instead of duplicating it (onboarding)", async () => {
    const { TOS_VERSION } = await import("@/lib/tos-version");
    const { POST } = await import("@/app/api/clients/accept-tos/route");
    state.tables.clients[0].onboarding_token_expires_at = new Date(Date.now() + 86_400_000).toISOString();
    state.tables.tos_acceptances[0].version = TOS_VERSION;
    state.tosConflict = true;
    const res = await POST(new Request("https://manci.test/api/clients/accept-tos", {
      method: "POST",
      body: JSON.stringify({ client_id: CLIENT_ID, token: "secret-token" }),
    }));
    expect(res.status).toBe(200);
    expect(state.tables.tos_acceptances.map((r) => [r.id, r.client_id])).toEqual([[1, CLIENT_ID], [2, null]]);
  });
});
