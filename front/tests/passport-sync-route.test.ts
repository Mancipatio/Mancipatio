// POST /api/clients/passport-sync × lib/clients.ts syncPassportToClient()
// (2026-09-08 e2e §4): the /admin/kyc "Retry off-chain sync" button used to
// call the wrapper without the on-chain expiry, the wrapper sent
// `expires_at: null`, and the route answered 400 before touching the DB —
// every retry failed by construction. These tests feed the EXACT params the
// wrapper signs into the route and pin both directions of the contract.
//
// Authorization (§4 × §5): the route runs the REAL lib/server/kyc-provider-gate
// against a mocked chain — the KYC provider is `KycRegistry.authority`, a
// separate role from `Platform.admin`, so the write-back (and every retry)
// must succeed for a rotated provider and fail for a new super admin who never
// held the registry. lib/server/admin-gate is mocked to refuse everyone, which
// proves the route no longer depends on it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  params: {} as Record<string, unknown>,
  signer: "" as string,
  updates: [] as Array<{ table: string; patch: Record<string, unknown>; filters: Array<[string, unknown]> }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  clientRow: null as Record<string, unknown> | null,
  sent: [] as Array<{ path: string; action: string; params: Record<string, unknown> }>,
}));
const chain = vi.hoisted(() => ({
  platformAdmin: "" as string,
  registryAuthority: null as string | null,
  adminGate: vi.fn(),
}));

// The original provider key: bootstrapped the registry, then the platform
// admin was rotated away from it (e2e §5 scenario).
const PROVIDER = "11111111111111111111111111111111";
const NEW_SUPER_ADMIN = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

vi.mock("@/lib/server/siws", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/siws")>();
  return {
    ...real,
    verifySigned: vi.fn(async () => ({ wallet: state.signer, params: state.params })),
  };
});
vi.mock("@/lib/server/admin-gate", async () => {
  const siws = await vi.importActual<typeof import("@/lib/server/siws")>("@/lib/server/siws");
  const refuse = async () => {
    chain.adminGate();
    throw new siws.SiwsError(403, "Super admin privileges required");
  };
  return { requireSuperAdmin: vi.fn(refuse), requireAdmin: vi.fn(refuse) };
});
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/network-identity", () => ({ createNetworkVerifier: () => async () => {} }));
vi.mock("@/lib/generated/asset_registry", () => ({
  ASSET_REGISTRY_PROGRAM_ADDRESS: "registry-program",
  findPlatformPda: async () => ["platform"],
  fetchMaybePlatform: async () => ({
    exists: true,
    programAddress: "registry-program",
    data: { admin: chain.platformAdmin },
  }),
}));
vi.mock("@/lib/kyc-authority", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/kyc-authority")>();
  return {
    ...real,
    listKycRegistries: async () =>
      chain.registryAuthority
        ? [{ address: "registry-pda", registry: { authority: chain.registryAuthority } }]
        : [],
    // The gate re-reads the chosen registry at "finalized" (2C-1).
    fetchKycRegistryAt: async (_rpc: unknown, address: string) =>
      chain.registryAuthority ? { address, registry: { authority: chain.registryAuthority } } : null,
  };
});
vi.mock("@/lib/server/email", () => ({
  sendEmail: vi.fn(async () => ({ ok: true })),
  escapeHtml: (s: string) => s,
}));
vi.mock("@/lib/siws-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/siws-client")>();
  return {
    ...real,
    signedFetch: vi.fn(async (_s: unknown, path: string, action: string, params: Record<string, unknown>) => {
      state.sent.push({ path, action, params });
      return { ok: true };
    }),
  };
});
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let pendingUpdate: Record<string, unknown> | null = null;
      let counting = false;
      const builder = {
        select: (_cols?: string, opts?: { count?: string }) => {
          counting = Boolean(opts?.count);
          return builder;
        },
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return builder;
        },
        update: (patch: Record<string, unknown>) => {
          pendingUpdate = patch;
          return builder;
        },
        insert: (row: Record<string, unknown>) => {
          state.inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle: async () => {
          if (table !== "clients" || !state.clientRow) return { data: null, error: null };
          const ok = filters.every(([k, v]) => state.clientRow?.[k] === v);
          return { data: ok ? state.clientRow : null, error: null };
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          if (pendingUpdate) state.updates.push({ table, patch: pendingUpdate, filters });
          const result = counting ? { count: 1, error: null } : { data: null, error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
  }),
}));

import { POST } from "@/app/api/clients/passport-sync/route";
import { passportSyncParams, syncPassportToClient } from "@/lib/clients";

const CLIENT_ID = "10000000-0000-4000-8000-000000000001";
const SIG =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmMZmNGyXSf6TXzE";
const EXPIRES_AT = "2027-09-08T12:00:00.000Z";

function request() {
  return new Request("https://manci.test/api/clients/passport-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

async function post(params: Record<string, unknown>) {
  state.params = params;
  const res = await POST(request());
  return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string } };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  chain.adminGate.mockClear();
  chain.platformAdmin = NEW_SUPER_ADMIN;
  chain.registryAuthority = PROVIDER;
  state.signer = PROVIDER;
  state.updates.length = 0;
  state.inserts.length = 0;
  state.sent.length = 0;
  state.clientRow = {
    id: CLIENT_ID,
    network: "devnet",
    email: null,
    display_name: "Fixture",
    kyc_status: "verified",
  };
});
afterEach(() => vi.unstubAllEnvs());

describe("passport-sync route accepts what the UI wrapper sends", () => {
  it("issued: the wrapper's params pass validation and stamp kyc_expires_at + tx ref", async () => {
    const params = passportSyncParams(CLIENT_ID, "issued", SIG, EXPIRES_AT);
    const { status, json } = await post(params);
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, data: { client_id: CLIENT_ID, event: "issued" } });
    const dossier = state.updates.find((u) => u.table === "clients" && "kyc_expires_at" in u.patch);
    expect(dossier).toBeDefined();
    expect(dossier?.patch).toEqual({
      kyc_provider: "manual",
      kyc_provider_ref: SIG,
      kyc_expires_at: EXPIRES_AT,
    });
    expect(dossier?.filters).toEqual([["id", CLIENT_ID]]);
    expect(state.inserts.map((i) => i.table)).toContain("client_notes");
  });

  it("issued: syncPassportToClient() signs exactly those params (the retry path replays them)", async () => {
    await expect(syncPassportToClient(null, CLIENT_ID, "issued", SIG, EXPIRES_AT)).resolves.toBe(true);
    expect(state.sent).toEqual([
      {
        path: "/api/clients/passport-sync",
        action: "clients.passport-sync",
        params: passportSyncParams(CLIENT_ID, "issued", SIG, EXPIRES_AT),
      },
    ]);
    // …and the route accepts that very payload.
    expect((await post(state.sent[0].params)).status).toBe(200);
  });

  it("revoked: the wrapper's params (no expiry) pass validation and suspend the dossier", async () => {
    const params = passportSyncParams(CLIENT_ID, "revoked", SIG);
    expect(params.expires_at).toBeNull();
    const { status } = await post(params);
    expect(status).toBe(200);
    const suspended = state.updates.find((u) => u.table === "clients" && u.patch.kyc_status === "suspended");
    expect(suspended).toBeDefined();
  });

  it("pins the bug: an 'issued' event without expiry is rejected with 400 before any DB write", async () => {
    const { status, json } = await post({
      client_id: CLIENT_ID,
      event: "issued",
      tx_signature: SIG,
      expires_at: null,
    });
    expect(status).toBe(400);
    expect(json.error).toBe("expires_at must be an ISO timestamp");
    expect(state.updates).toHaveLength(0);
  });

  it("the wrapper refuses to sign that request at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The overloads make this a compile error for callers; the runtime guard
      // covers dynamic call sites and returns the same `false` the UI expects.
      const call = syncPassportToClient as unknown as (
        ...args: unknown[]
      ) => Promise<boolean>;
      await expect(call(null, CLIENT_ID, "issued", SIG)).resolves.toBe(false);
      await expect(call(null, CLIENT_ID, "issued", SIG, "not-a-date")).resolves.toBe(false);
      expect(state.sent).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("normalizes the expiry the UI computes from the on-chain expiry seconds", () => {
    const expirySec = 1_820_000_000;
    const uiIso = new Date(expirySec * 1000).toISOString();
    expect(passportSyncParams(CLIENT_ID, "issued", SIG, uiIso).expires_at).toBe(uiIso);
  });
});

describe("passport-sync route authorizes the KYC provider, not the platform admin (§4 × §5)", () => {
  const issued = () => passportSyncParams(CLIENT_ID, "issued", SIG, EXPIRES_AT);

  it("the rotated provider (no longer Platform.admin) can write back and retry", async () => {
    // First write-back after approve_holder…
    expect((await post(issued())).status).toBe(200);
    // …and the "Retry off-chain sync" replay of the same payload.
    expect((await post(issued())).status).toBe(200);
    expect(state.updates.filter((u) => "kyc_expires_at" in u.patch)).toHaveLength(2);
    // Super-admin status was never what authorized it.
    expect(chain.adminGate).not.toHaveBeenCalled();
  });

  it("a new super admin who never held the registry is refused before any DB write", async () => {
    state.signer = NEW_SUPER_ADMIN;
    const { status, json } = await post(issued());
    expect(status).toBe(403);
    expect(json.error).toBe("KYC provider privileges required");
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("pre-rotation (provider === platform admin) still works for the shared key", async () => {
    chain.platformAdmin = PROVIDER;
    expect((await post(issued())).status).toBe(200);
  });

  it("revoked events are gated the same way", async () => {
    state.signer = NEW_SUPER_ADMIN;
    expect((await post(passportSyncParams(CLIENT_ID, "revoked", SIG))).status).toBe(403);
    state.signer = PROVIDER;
    expect((await post(passportSyncParams(CLIENT_ID, "revoked", SIG))).status).toBe(200);
  });

  it("fails closed when no registry exists", async () => {
    chain.registryAuthority = null;
    expect((await post(issued())).status).toBe(403);
    expect(state.updates).toHaveLength(0);
  });
});
