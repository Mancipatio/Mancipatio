// Talas 3.1 K6: the client-dossier routes a KYC provider (the live
// KycRegistry.authority, possibly without an Admin record) works on, plus the
// narrow /api/compliance/open-wallets read.
//
// The REAL lib/server/admin-gate and lib/server/kyc-provider-gate run: only
// the chain underneath them is mocked (server RPC, network verifier, the
// generated Platform/Admin readers, the registry scan / pinned read), so the
// admin-then-provider composition is what is under test. Supabase is an
// in-memory stand-in. No real RPC and no database.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  signer: "",
  params: {} as Record<string, unknown>,
  tables: {} as Record<string, Row[]>,
  /** Called right before an update is applied (race simulation). */
  beforeUpdate: null as null | ((table: string) => void),
  /** Inserts into this table fail (DB error simulation). */
  failInsert: null as null | string,
  nextId: 100,
}));
const chain = vi.hoisted(() => ({
  network: vi.fn(async () => {}),
  platformAdmin: "",
  admins: new Set<string>(),
  registryAuthority: null as string | null,
  pin: null as string | null,
}));

vi.mock("@/lib/server/siws", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/siws")>();
  return {
    ...real,
    verifySigned: vi.fn(async () => ({ wallet: state.signer, params: state.params, via: "signature" })),
  };
});
vi.mock("@/lib/server/rpc", () => ({
  getServerRpc: () =>
    new Proxy({}, {
      get: () => {
        throw new Error("tests must not reach a real RPC");
      },
    }),
}));
vi.mock("@/lib/network-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network-identity")>()),
  createNetworkVerifier: () => chain.network,
}));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/generated/asset_registry")>();
  return {
    ...real,
    findPlatformPda: async () => ["platform-pda", 255],
    fetchMaybePlatform: async () => ({
      exists: true,
      programAddress: real.ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { admin: chain.platformAdmin },
    }),
    findAdminRecordPda: async ({ authority }: { authority: string }) => [`admin-${authority}`, 255],
    fetchMaybeAdmin: async (_rpc: unknown, pda: string) => {
      const wallet = pda.replace(/^admin-/, "");
      return chain.admins.has(wallet)
        ? { exists: true, programAddress: real.ASSET_REGISTRY_PROGRAM_ADDRESS, data: { admin: wallet } }
        : { exists: false };
    },
  };
});
vi.mock("@/lib/kyc-authority", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/kyc-authority")>();
  const registry = (address = "registry-pda") =>
    chain.registryAuthority ? { address, registry: { authority: chain.registryAuthority } } : null;
  return {
    ...real,
    listKycRegistries: async () => (registry() ? [registry()] : []),
    fetchKycRegistryAt: async (_rpc: unknown, address: string) =>
      chain.pin && address === chain.pin ? null : registry(address),
  };
});
vi.mock("@/lib/kyc-registry-pin", () => ({ configuredKycRegistry: () => chain.pin }));
vi.mock("@/lib/server/email", () => ({
  sendEmail: vi.fn(async () => ({ ok: true })),
  escapeHtml: (s: string) => s,
}));
vi.mock("@/lib/server/maintenance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/maintenance")>()),
  getMaintenance: vi.fn(async () => ({ enabled: false, message: null })),
  assertWritable: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/raise-limits", () => ({ getRaiseCapacity: async () => null }));

// ── In-memory Supabase ───────────────────────────────────────────────────────

function rowsOf(table: string): Row[] {
  state.tables[table] ??= [];
  return state.tables[table];
}

function from(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: Row | Row[] | null = null;
  let returning = false;
  let head = false;
  const run = async (single: boolean) => {
    if (op === "insert") {
      if (state.failInsert === table) return { data: null, error: { message: "insert failed" } };
      const rows = (Array.isArray(payload) ? payload : [payload ?? {}]).map((r) => ({
        // audit_events ids are uuids (writeServerAudit checks for a string).
        id: table === "audit_events" ? `audit-${state.nextId++}` : state.nextId++,
        ...r,
      }));
      rowsOf(table).push(...rows);
      return { data: single ? rows[0] : rows, error: null };
    }
    if (op === "update") state.beforeUpdate?.(table);
    const matched = rowsOf(table).filter((r) => filters.every((f) => f(r)));
    if (op === "update") {
      for (const r of matched) Object.assign(r, payload);
      return { data: returning ? matched.map((r) => ({ id: r.id })) : null, error: null };
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
      if (op === "select") head = Boolean(opts?.head);
      else returning = true;
      return b;
    },
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
    not: (c: string, operator: string, value: string) => {
      expect(operator).toBe("in");
      const values = value.replace(/[()]/g, "").split(",");
      filters.push((r) => !values.includes(String(r[c])));
      return b;
    },
    order: () => b,
    limit: () => b,
    insert: (row: Row | Row[]) => ((op = "insert"), (payload = row), b),
    update: (patch: Row) => ((op = "update"), (payload = patch), b),
    delete: () => ((op = "delete"), b),
    maybeSingle: () => run(true),
    single: () => run(true),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => run(false).then(resolve, reject),
  });
  return b;
}

vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from,
    storage: {
      from: () => ({
        createSignedUrl: async (path: string, ttl: number) => ({
          data: { signedUrl: `https://storage.test/${path}?ttl=${ttl}` },
          error: null,
        }),
        upload: async () => ({ data: {}, error: null }),
        remove: async () => ({ data: [], error: null }),
      }),
    },
  }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SUPER = "SuperWa11etSuperWa11etSuperWa11et1";
const ADMIN = "AdminWa11etAdminWa11etAdminWa11et1";
const PROVIDER = "ProviderWa11etProviderWa11etProv1";
const STRANGER = "StrangerWa11etStrangerWa11etStra1";
const CLIENT_ID = "c0000000-0000-4000-8000-000000000001";
const CLIENT_WALLET = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const W_OPEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const W_ESCALATED = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const W_RESOLVED = "Stake11111111111111111111111111111111111111";
const W_MAINNET = "Vote111111111111111111111111111111111111111";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  chain.network.mockReset();
  chain.network.mockResolvedValue(undefined);
  chain.platformAdmin = SUPER;
  chain.admins = new Set([ADMIN]);
  chain.registryAuthority = PROVIDER;
  chain.pin = null;
  state.signer = PROVIDER;
  state.params = {};
  state.beforeUpdate = null;
  state.failInsert = null;
  state.nextId = 100;
  state.tables = {
    clients: [
      {
        id: CLIENT_ID,
        network: "devnet",
        wallet: CLIENT_WALLET,
        email: "carol@x.test",
        display_name: "Carol",
        kyc_status: "pending",
        onboarding_token: "tok",
        onboarding_token_expires_at: "2099-01-01T00:00:00Z",
        created_at: "2026-09-01T00:00:00Z",
        anonymized_at: null,
      },
    ],
    client_notes: [],
    client_documents: [{ id: 11, client_id: CLIENT_ID, kind: "passport", storage_path: `clients/${CLIENT_ID}/p.pdf` }],
    kyc_requirements: [{ id: 7, client_id: CLIENT_ID, status: "submitted", doc_kind: "passport" }],
    client_verification_details: [],
    client_raise_limits: [],
    audit_events: [],
    compliance_alerts: [
      { id: 1, network: "devnet", wallet: W_OPEN, status: "open", evidence: { secret: 1 }, resolution_note: "x" },
      { id: 2, network: "devnet", wallet: W_ESCALATED, status: "escalated", evidence: {} },
      { id: 3, network: "devnet", wallet: W_RESOLVED, status: "resolved", evidence: {} },
      { id: 4, network: "devnet", wallet: W_RESOLVED, status: "dismissed", evidence: {} },
      { id: 5, network: "mainnet", wallet: W_MAINNET, status: "open", evidence: {} },
      { id: 6, network: "devnet", wallet: W_OPEN, status: "open", evidence: {} },
    ],
  };
});

const client = () => state.tables.clients[0];
const notes = () => state.tables.client_notes.map((n) => String(n.body));

type Handler = { POST: (r: Request) => Promise<Response> };
const ROUTE_MODULES: Record<string, () => Promise<Handler>> = {
  "clients/admin-list": () => import("@/app/api/clients/admin-list/route"),
  "clients/admin-detail": () => import("@/app/api/clients/admin-detail/route"),
  "clients/doc-url": () => import("@/app/api/clients/doc-url/route"),
  "clients/note": () => import("@/app/api/clients/note/route"),
  "clients/status": () => import("@/app/api/clients/status/route"),
  "clients/request-docs": () => import("@/app/api/clients/request-docs/route"),
  "clients/review-requirement": () => import("@/app/api/clients/review-requirement/route"),
  "clients/create": () => import("@/app/api/clients/create/route"),
  "clients/update": () => import("@/app/api/clients/update/route"),
  "clients/export": () => import("@/app/api/clients/export/route"),
  "clients/kyb-decision": () => import("@/app/api/clients/kyb-decision/route"),
  "clients/raise-limits": () => import("@/app/api/clients/raise-limits/route"),
  "compliance/list": () => import("@/app/api/compliance/list/route"),
  "compliance/open-wallets": () => import("@/app/api/compliance/open-wallets/route"),
};

async function call(
  route: string,
  params: Record<string, unknown>,
): Promise<{ status: number; body: { ok: boolean; data?: Record<string, unknown>; error?: string } }> {
  const mod = await ROUTE_MODULES[route]();
  state.params = params;
  const res = await mod.POST(new Request(`https://manci.test/api/${route}`, { method: "POST" }));
  return { status: res.status, body: await res.json() };
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The upload route in operator mode (signed `auth` envelope; verifySigned is mocked). */
async function upload(): Promise<number> {
  const { POST } = await import("@/app/api/clients/upload/route");
  const bytes = new TextEncoder().encode("%PDF-1.4 test");
  state.params = {
    client_id: CLIENT_ID,
    kind: "passport",
    sha256: await sha256Hex(bytes),
    size: bytes.length,
    requirement_id: 7,
  };
  const form = new FormData();
  form.set("file", new File([bytes], "p.pdf", { type: "application/pdf" }));
  form.set("auth", "{}");
  const res = await POST(new Request("https://manci.test/api/clients/upload", { method: "POST", body: form }));
  return res.status;
}

// Each widened route with a valid call for the provider.
const ROUTES: Array<{ route: string; params: () => Record<string, unknown> }> = [
  { route: "clients/admin-list", params: () => ({}) },
  { route: "clients/admin-detail", params: () => ({ id: CLIENT_ID }) },
  { route: "clients/doc-url", params: () => ({ document_id: 11 }) },
  { route: "clients/note", params: () => ({ client_id: CLIENT_ID, body: "called the client" }) },
  { route: "clients/status", params: () => ({ id: CLIENT_ID, kyc_status: "verified", onboarding_status: "verified" }) },
  {
    route: "clients/request-docs",
    params: () => ({ client_id: CLIENT_ID, items: [{ doc_kind: "passport", label: "Passport" }] }),
  },
  { route: "clients/review-requirement", params: () => ({ id: 7, status: "approved" }) },
  { route: "compliance/open-wallets", params: () => ({ wallets: [W_OPEN] }) },
];

describe("K6 routes: who gets in", () => {
  for (const { route, params } of ROUTES) {
    it(`${route}: provider 200, stranger 403, RPC error 503, pinned registry missing 403`, async () => {
      state.signer = PROVIDER;
      expect((await call(route, params())).status).toBe(200);

      state.signer = STRANGER;
      const refused = await call(route, params());
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe("Admin or KYC provider privileges required");

      state.signer = PROVIDER;
      chain.network.mockRejectedValue(new Error("wrong cluster"));
      expect((await call(route, params())).status).toBe(503);
      chain.network.mockResolvedValue(undefined);

      chain.pin = "pinned-registry";
      expect((await call(route, params())).status).toBe(403);
    });
  }

  it("clients/upload (operator mode): provider 200, stranger 403, RPC error 503, pinned missing 403", async () => {
    state.signer = PROVIDER;
    expect(await upload()).toBe(200);
    state.signer = STRANGER;
    expect(await upload()).toBe(403);
    state.signer = PROVIDER;
    chain.network.mockRejectedValue(new Error("rpc down"));
    expect(await upload()).toBe(503);
    chain.network.mockResolvedValue(undefined);
    chain.pin = "pinned-registry";
    expect(await upload()).toBe(403);
  });

  it("an Admin and the Super Admin still pass without being the provider", async () => {
    for (const w of [ADMIN, SUPER]) {
      state.signer = w;
      expect((await call("clients/admin-list", {})).status).toBe(200);
      expect((await call("compliance/open-wallets", { wallets: [W_OPEN] })).status).toBe(200);
    }
  });

  it("a former provider is refused once the rotation away is finalized", async () => {
    chain.registryAuthority = STRANGER;
    state.signer = PROVIDER;
    expect((await call("clients/admin-detail", { id: CLIENT_ID })).status).toBe(403);
  });
});

describe("K6 routes that stay admin-only", () => {
  it.each([
    ["clients/create", { display_name: "X", type: "investor" }],
    ["clients/update", { id: CLIENT_ID, display_name: "X" }],
    ["clients/export", { client_id: CLIENT_ID }],
    ["clients/kyb-decision", { client_id: CLIENT_ID, status: "verified" }],
    ["clients/raise-limits", { client_id: CLIENT_ID, clear: true }],
    ["compliance/list", {}],
  ] as const)("%s refuses the KYC provider", async (route, params) => {
    state.signer = PROVIDER;
    expect((await call(route, { ...params })).status).toBe(403);
  });
});

describe("transition rule (OD1): a provider never lifts a terminal status", () => {
  for (const terminal of ["suspended", "rejected"]) {
    it(`status: provider 403 on a ${terminal} client, the Admin succeeds`, async () => {
      client().kyc_status = terminal;
      state.signer = PROVIDER;
      for (const next of ["verified", "pending", "more_info", "suspended", "rejected"]) {
        const res = await call("clients/status", { id: CLIENT_ID, kyc_status: next });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe("Only an Admin can lift a suspension or reverse a rejection");
      }
      expect(client().kyc_status).toBe(terminal);

      state.signer = ADMIN;
      expect((await call("clients/status", { id: CLIENT_ID, kyc_status: "verified" })).status).toBe(200);
      expect(client().kyc_status).toBe("verified");
    });

    it(`request-docs: provider 403 on a ${terminal} client (no requirement written), the Admin succeeds`, async () => {
      client().kyc_status = terminal;
      const before = state.tables.kyc_requirements.length;
      state.signer = PROVIDER;
      const res = await call("clients/request-docs", {
        client_id: CLIENT_ID,
        items: [{ doc_kind: "passport", label: "Passport" }],
      });
      expect(res.status).toBe(403);
      expect(client().kyc_status).toBe(terminal);
      expect(state.tables.kyc_requirements).toHaveLength(before);

      state.signer = ADMIN;
      expect(
        (await call("clients/request-docs", { client_id: CLIENT_ID, items: [{ doc_kind: "passport", label: "Passport" }] }))
          .status,
      ).toBe(200);
      expect(client().kyc_status).toBe("more_info");
    });
  }

  it("the refusal is atomic: a suspension landing between the read and the write still wins", async () => {
    state.signer = PROVIDER;
    // fetchClientOr404 sees `pending`; the suspension commits right before the update.
    state.beforeUpdate = (table) => {
      if (table === "clients" && client().kyc_status === "pending") client().kyc_status = "suspended";
    };
    const res = await call("clients/status", { id: CLIENT_ID, kyc_status: "verified" });
    expect(res.status).toBe(403);
    expect(client().kyc_status).toBe("suspended");
    expect(client().kyc_verified_at).toBeUndefined();
  });

  it("a provider's decision is always noted as [KYC provider] status → X", async () => {
    state.signer = PROVIDER;
    expect((await call("clients/status", { id: CLIENT_ID, kyc_status: "more_info" })).status).toBe(200);
    expect((await call("clients/status", { id: CLIENT_ID, kyc_status: "verified", reason: "docs ok" })).status).toBe(200);
    expect(notes()).toEqual(["[KYC provider] status → more_info", "[KYC provider] status → verified — docs ok"]);
    expect(state.tables.client_notes.every((n) => n.kind === "kyc-event" && n.author === PROVIDER)).toBe(true);
  });

  it("a provider's decision is attributed by a server audit row before it is applied", async () => {
    state.signer = PROVIDER;
    expect((await call("clients/status", { id: CLIENT_ID, kyc_status: "verified", reason: "docs ok" })).status).toBe(200);
    const rows = state.tables.audit_events.filter((r) => r.ix_name === "kyc_provider_status");
    expect(rows.map((r) => r.status)).toEqual(["pending", "success"]);
    for (const r of rows) {
      expect(r).toMatchObject({ category: "kyc", actor_wallet: PROVIDER, target_label: CLIENT_ID });
      expect(r.metadata).toMatchObject({ role: "kycProvider", from: "pending", to: "verified", actor_verified: true });
    }
  });

  it("no attribution, no decision: a failed audit write refuses with 503 and applies nothing", async () => {
    state.signer = PROVIDER;
    state.failInsert = "audit_events";
    const res = await call("clients/status", { id: CLIENT_ID, kyc_status: "verified" });
    expect(res.status).toBe(503);
    expect(client().kyc_status).toBe("pending");
    expect(client().kyc_verified_at).toBeUndefined();
    expect(notes()).toEqual([]);
  });

  it("a refused provider decision is recorded as failed after its pending row", async () => {
    state.signer = PROVIDER;
    state.beforeUpdate = (table) => {
      if (table === "clients" && client().kyc_status === "pending") client().kyc_status = "rejected";
    };
    expect((await call("clients/status", { id: CLIENT_ID, kyc_status: "verified" })).status).toBe(403);
    const rows = state.tables.audit_events.filter((r) => r.ix_name === "kyc_provider_status");
    expect(rows.map((r) => r.status)).toEqual(["pending", "failed"]);
    expect(client().kyc_status).toBe("rejected");
  });

  it("an Admin's decision keeps the old note behaviour (only with a reason)", async () => {
    state.signer = ADMIN;
    expect((await call("clients/status", { id: CLIENT_ID, kyc_status: "more_info" })).status).toBe(200);
    expect(notes()).toEqual([]);
    expect((await call("clients/status", { id: CLIENT_ID, kyc_status: "suspended", reason: "sanctions hit" })).status).toBe(200);
    expect(notes()).toEqual(["sanctions hit"]);
  });

  it("a provider may move a non-terminal client into a terminal status", async () => {
    state.signer = PROVIDER;
    expect((await call("clients/status", { id: CLIENT_ID, kyc_status: "suspended" })).status).toBe(200);
    expect(client().kyc_status).toBe("suspended");
  });
});

describe("requirement recompute (OD1): never lifts a concurrent terminal status", () => {
  it("a provider's approval flips a more_info client back to pending", async () => {
    client().kyc_status = "more_info";
    state.signer = PROVIDER;
    const res = await call("clients/review-requirement", { id: 7, status: "approved" });
    expect(res.status).toBe(200);
    expect(res.body.data?.recomputed).toBe("pending");
    expect(client().kyc_status).toBe("pending");
  });

  it("a suspension landing between the recompute's read and its write wins", async () => {
    client().kyc_status = "more_info";
    state.signer = PROVIDER;
    state.beforeUpdate = (table) => {
      if (table === "clients" && client().kyc_status === "more_info") client().kyc_status = "suspended";
    };
    const res = await call("clients/review-requirement", { id: 7, status: "approved" });
    expect(res.status).toBe(200);
    expect(res.body.data?.recomputed).toBeNull();
    expect(client().kyc_status).toBe("suspended");
  });

  it("the same holds for an operator-mode upload that answers the last requirement", async () => {
    client().kyc_status = "more_info";
    state.tables.kyc_requirements[0].status = "requested";
    state.signer = PROVIDER;
    state.beforeUpdate = (table) => {
      if (table === "clients" && client().kyc_status === "more_info") client().kyc_status = "rejected";
    };
    expect(await upload()).toBe(200);
    expect(client().kyc_status).toBe("rejected");
  });
});

describe("/api/clients/note: provider notes cannot imitate decisions", () => {
  for (const kind of ["kyc-event", "system"]) {
    it(`the provider may not post a ${kind} entry`, async () => {
      state.signer = PROVIDER;
      const res = await call("clients/note", { client_id: CLIENT_ID, body: "approved", kind });
      expect(res.status).toBe(403);
      expect(state.tables.client_notes).toHaveLength(0);
    });
  }

  it("the provider posts notes and communications", async () => {
    state.signer = PROVIDER;
    expect((await call("clients/note", { client_id: CLIENT_ID, body: "called", kind: "communication" })).status).toBe(200);
    expect((await call("clients/note", { client_id: CLIENT_ID, body: "memo" })).status).toBe(200);
    expect(state.tables.client_notes.map((n) => n.kind)).toEqual(["communication", "note"]);
  });

  it("nobody can post the reserved [KYC provider] marker", async () => {
    for (const signer of [PROVIDER, ADMIN]) {
      state.signer = signer;
      const res = await call("clients/note", { client_id: CLIENT_ID, body: " [KYC provider] status → verified" });
      expect(res.status).toBe(400);
    }
    expect(state.tables.client_notes).toHaveLength(0);
  });
});

describe("/api/compliance/open-wallets (OD2, OD14)", () => {
  it("returns only the addresses with an open or escalated alert on this network", async () => {
    const res = await call("compliance/open-wallets", {
      wallets: [W_OPEN, W_ESCALATED, W_RESOLVED, W_MAINNET, CLIENT_WALLET, W_OPEN],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ wallets: [W_OPEN, W_ESCALATED] });
    // No evidence, notes, ids or counts leak.
    expect(JSON.stringify(res.body)).not.toMatch(/secret|evidence|resolution|"id"/);
  });

  it("rejects more than 200 wallets, an empty list and invalid addresses", async () => {
    const many = Array.from({ length: 201 }, () => W_OPEN);
    expect((await call("compliance/open-wallets", { wallets: many })).status).toBe(400);
    expect((await call("compliance/open-wallets", { wallets: [] })).status).toBe(400);
    expect((await call("compliance/open-wallets", { wallets: "x" })).status).toBe(400);
    expect((await call("compliance/open-wallets", { wallets: [W_OPEN, "not-an-address"] })).status).toBe(400);
    expect((await call("compliance/open-wallets", { wallets: [W_OPEN, 42] })).status).toBe(400);
    // Exactly 200 is fine (duplicates collapse).
    expect((await call("compliance/open-wallets", { wallets: many.slice(0, 200) })).status).toBe(200);
  });
});
