// KYC access logging and GDPR routes, run for real against an in-memory
// Supabase stand-in (tables, storage bucket, rpc) with SIWS and the on-chain
// admin gate mocked:
//   * /api/clients/doc-url  — 120 s URL, audit row BEFORE the URL, 503 + no
//                             URL when the audit write fails
//   * /api/audit            — refuses the server-only "kyc" category
//   * /api/clients/export   — admin gate, audit-logged bundle, no token
//   * /api/clients/anonymize — Super Admin + typed confirmation, dry-run
//                             preflight, audit before any file is deleted,
//                             no row deletes / cascades from the route
//   * /api/storage/documents/list — no public URL for confidential files
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
  tosConflict: false,
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

function rowsOf(table: string): Row[] {
  state.tables[table] ??= [];
  return state.tables[table];
}

function from(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: Row | null = null;
  let head = false;
  const run = async (single: boolean) => {
    state.calls.push({ op, table, payload });
    if (op === "insert") {
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
    select: (_cols?: string, opts?: { head?: boolean }) => {
      if (opts?.head) head = true;
      return b;
    },
    eq: (column: string, value: unknown) => {
      filters.push((r) => r[column] === value);
      return b;
    },
    is: (column: string, value: unknown) => {
      filters.push((r) => (r[column] ?? null) === value);
      return b;
    },
    or: (expr: string) => {
      const parts = expr.split(",").map((part) => {
        const [column, , ...rest] = part.split(".");
        return [column, rest.join(".")] as const;
      });
      filters.push((r) => parts.some(([column, value]) => String(r[column]) === value));
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
    remove: async (paths: string[]) => {
      state.calls.push({ op: "remove", payload: { bucket: name, paths } });
      if (state.failRemove) return { data: null, error: { message: "storage down" } };
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
  state.tosConflict = false;
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
      generated_by: ADMIN,
      network: "devnet",
      document_links_expire_in_seconds: 600,
      account: null,
      passport_requests: [{ wallet: CLIENT_WALLET, note: "I live in Berlin" }],
      notes: [{ body: "Met at the fair" }],
      // Linked by wallet (wallet-gate) even without a dossier link; others excluded.
      tos_acceptances: [{ id: 1, wallet: CLIENT_WALLET }],
    });
    const client = bundle.client as Row;
    expect(client.onboarding_token).toBeUndefined();
    expect(client.onboarding_token_present).toBe(true);
    expect(client.email).toBe("carol@x.test");
    const docs = bundle.documents as Row[];
    expect(docs[0]).toMatchObject({ id: 11, download_url: `https://storage.test/client-documents/${DOC_PATH}?ttl=600` });
    expect(docs[1]).toMatchObject({ id: 12, download_url: null, download_unavailable: "file not in the private bucket" });
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
    expect(auditRows().slice(0, 1)).toEqual([
      expect.objectContaining({
        ix_name: "kyc_data_export",
        category: "kyc",
        target_label: CLIENT_ID,
        metadata: expect.objectContaining({ documents: 2, document_links: 1, ttl: 600, actor_verified: true, actor_source: "siws-signature" }),
      }),
    ]);
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
      files_missing: 1, // the legacy path was not in the private bucket
      files_left: 0,
      audit_complete: true,
    });
    const sequence = state.calls
      .filter((c) => c.op !== "select" || c.table === "client_documents")
      .map((c) => (c.op === "rpc" ? `rpc:${(c.payload as { args: Row }).args.p_dry_run ? "dry" : "run"}` : c.table ? `${c.op}:${c.table}` : c.op));
    expect(sequence).toEqual([
      "rpc:dry",
      "insert:audit_events",
      "select:client_documents",
      "list", "list", "list",
      "remove",
      "rpc:run",
      "insert:audit_events",
    ]);
    const removed = opsOf("remove")[0].payload as { bucket: string; paths: string[] };
    expect(removed.bucket).toBe("client-documents");
    expect(new Set(removed.paths)).toEqual(new Set([DOC_PATH, LEGACY_PATH, ORPHAN_PATH]));
    expect(auditRows().map((r) => [r.ix_name, r.status, (r.metadata as Row).actor_verified])).toEqual([
      ["client_anonymize", "pending", true],
      ["client_anonymize", "success", true],
    ]);
    // The route itself deletes and updates nothing: the dossier and every
    // dependent row are handled by anonymize_client() (no cascade).
    expect(state.calls.filter((c) => c.op === "delete" || c.op === "update")).toEqual([]);
    expect(state.tables.clients).toHaveLength(1);
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

describe("document repository (/api/storage/documents/list)", () => {
  it("never falls back to a public URL for a confidential file; public files keep theirs", async () => {
    const { POST } = await import("@/app/api/storage/documents/list/route");
    state.tables.documents = [
      { id: "d1", category: "compliance", slug: "memo", version: 1, storage_path: "compliance/memo.pdf", external_url: null },
      { id: "d2", category: "whitepaper", slug: "wp", version: 1, storage_path: "whitepaper/wp.pdf", external_url: null },
    ];
    const { status, body } = await post(POST);
    expect(status).toBe(200);
    const docs = (body.data as { documents: Row[] }).documents;
    expect(docs[0]).toMatchObject({ id: "d1", download_url: null, download_unavailable: "not_in_private_bucket" });
    expect(docs[1]).toMatchObject({
      id: "d2",
      download_url: "https://project.supabase.test/storage/v1/object/public/documents/whitepaper/wp.pdf",
    });
    expect(JSON.stringify(docs[0])).not.toContain("/object/public/");
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
