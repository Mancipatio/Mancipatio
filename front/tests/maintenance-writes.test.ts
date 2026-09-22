// Writes outside verifySigned that maintenance must also pause: magic-link
// onboarding (token-authed, unsigned) and the lazy writes of two reads
// (account.me creating a profile for a new wallet, clients.me re-issuing an
// expired upload link).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  flag: null as { enabled: boolean; message: string | null } | null,
  member: null as { account_id: string } | null,
  clients: [] as Row[],
  tables: [] as string[],
  writes: [] as string[],
  uploads: 0,
  rpc: vi.fn(),
  actor: null as unknown,
}));

function from(table: string) {
  db.tables.push(table);
  const q: Record<string, unknown> = {};
  const chain = () => q;
  const write = (kind: string) => () => { db.writes.push(`${kind}:${table}`); return q; };
  Object.assign(q, {
    select: chain, eq: chain, in: chain, order: chain, limit: chain, lt: chain, match: chain, abortSignal: chain,
    update: write("update"), insert: write("insert"), upsert: write("upsert"), delete: write("delete"),
    maybeSingle: async () => ({
      data: table === "platform_maintenance" ? db.flag : table === "account_wallets" ? db.member : null,
      error: null,
    }),
    single: async () => ({ data: null, error: { message: "not modelled" } }),
    then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve({ data: table === "clients" ? db.clients : [], error: null }).then(resolve, reject),
  });
  return q;
}
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from, rpc: db.rpc,
    storage: { from: () => ({ upload: async () => { db.uploads++; return { error: null }; } }) },
  }),
}));
// The signed/session envelope has its own tests; these start from a verified actor.
vi.mock("@/lib/server/account-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/account-auth")>()),
  readActor: async () => db.actor,
}));

const origin = "https://manci.test";
const WALLET = "11111111111111111111111111111111";
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const CLIENT_ID = "20000000-0000-4000-8000-000000000002";
const MAINTENANCE = { enabled: true, message: "Program upgrade" };
const refusal = { ok: false, code: "maintenance", error: "Manci is in maintenance: Program upgrade", message: "Program upgrade" };

function json(path: string, body: unknown) {
  return new Request(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  });
}
const flagOnly = () => db.tables.every((table) => table === "platform_maintenance");

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  db.flag = MAINTENANCE; db.member = null; db.clients = [];
  db.tables = []; db.writes = []; db.uploads = 0; db.actor = null;
  db.rpc.mockReset().mockResolvedValue({ data: null, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("magic-link onboarding in maintenance", () => {
  it("refuses a token upload before any storage or database write", async () => {
    const { POST } = await import("@/app/api/clients/upload/route");
    const form = new FormData();
    form.set("client_id", CLIENT_ID);
    form.set("token", "t".repeat(43));
    form.set("kind", "passport");
    form.set("file", new File([new Uint8Array([37, 80, 68, 70])], "passport.pdf", { type: "application/pdf" }));
    const res = await POST(new Request(`${origin}/api/clients/upload`, { method: "POST", body: form }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(refusal);
    expect(db.uploads).toBe(0);
    expect(db.writes).toEqual([]);
    expect(flagOnly()).toBe(true);
  });

  it("refuses accepting the invitation's Terms", async () => {
    const { POST } = await import("@/app/api/clients/accept-tos/route");
    const res = await POST(json("/api/clients/accept-tos", { client_id: CLIENT_ID, token: "t".repeat(43) }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(refusal);
    expect(db.writes).toEqual([]);
    expect(flagOnly()).toBe(true);
  });
});

describe("reads stay reads in maintenance", () => {
  const dossier = (overrides: Row = {}) => ({
    id: CLIENT_ID, created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), network: "devnet",
    kyc_status: "pending", wallet: WALLET, onboarding_token: "old-token",
    onboarding_token_expires_at: new Date(Date.now() - 60_000).toISOString(), ...overrides,
  });

  it("clients.me does not re-issue an expired upload link, and says why", async () => {
    db.actor = { kind: "account", accountId: ACCOUNT_ID, params: {} };
    db.clients = [dossier()];
    const { POST } = await import("@/app/api/clients/me/route");
    const res = await POST(json("/api/clients/me", {}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.onboarding_path).toBeNull();
    expect(body.data.onboarding_notice).toMatch(/maintenance/);
    expect(db.writes).toEqual([]);
  });

  it("clients.me still serves a live upload link, and re-issues an expired one once maintenance ends", async () => {
    db.actor = { kind: "account", accountId: ACCOUNT_ID, params: {} };
    db.clients = [dossier({ onboarding_token_expires_at: new Date(Date.now() + 86_400_000).toISOString() })];
    let { POST } = await import("@/app/api/clients/me/route");
    let body = await (await POST(json("/api/clients/me", {}))).json();
    expect(body.data.onboarding_path).toBe(`/onboarding/${CLIENT_ID}?t=old-token`);

    vi.resetModules();
    db.flag = null;
    db.clients = [dossier()];
    ({ POST } = await import("@/app/api/clients/me/route"));
    body = await (await POST(json("/api/clients/me", {}))).json();
    expect(db.writes).toEqual(["update:clients"]);
    expect(body.data.onboarding_path).toMatch(new RegExp(`^/onboarding/${CLIENT_ID}\\?t=`));
    expect(body.data.onboarding_notice).toBeNull();
  });

  it("account.me does not create an account for a new wallet", async () => {
    db.actor = { kind: "wallet", wallet: WALLET, params: {} };
    const { POST } = await import("@/app/api/account/me/route");
    const res = await POST(json("/api/account/me", {}));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(refusal);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("account.me reads an existing wallet's account without ensure_account_profile", async () => {
    db.actor = { kind: "wallet", wallet: WALLET, params: {} };
    db.member = { account_id: ACCOUNT_ID };
    db.rpc.mockImplementation(async (name: string) => name === "get_account_profile" ? {
      data: {
        id: ACCOUNT_ID, wallet: null, network: "devnet", primary_wallet: WALLET,
        wallets: [{ wallet: WALLET, linked_at: "2026-09-20T10:00:00Z" }], display_name: "A name",
      },
      error: null,
    } : { data: null, error: { message: "unexpected" } });
    const { POST } = await import("@/app/api/account/me/route");
    const res = await POST(json("/api/account/me", {}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.profile).toMatchObject({ id: ACCOUNT_ID, wallet: WALLET, primary_wallet: WALLET, display_name: "A name" });
    expect(db.rpc.mock.calls.map(([name]) => name)).toEqual(["get_account_profile"]);
    expect(db.writes).toEqual([]);
  });

  it("account.me refuses a profile that does not list the acting wallet", async () => {
    db.actor = { kind: "wallet", wallet: WALLET, params: {} };
    db.member = { account_id: ACCOUNT_ID };
    db.rpc.mockResolvedValue({ data: { id: ACCOUNT_ID, network: "devnet", wallets: [] }, error: null });
    const { POST } = await import("@/app/api/account/me/route");
    const res = await POST(json("/api/account/me", {}));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.not.toHaveProperty("code");
  });

  it("account.me creates the profile as before when maintenance is off", async () => {
    db.flag = null;
    db.actor = { kind: "wallet", wallet: WALLET, params: {} };
    db.rpc.mockResolvedValue({ data: {
      id: ACCOUNT_ID, wallet: WALLET, network: "devnet", primary_wallet: WALLET,
      wallets: [{ wallet: WALLET, linked_at: "2026-09-20T10:00:00Z" }],
    }, error: null });
    const { POST } = await import("@/app/api/account/me/route");
    expect((await POST(json("/api/account/me", {}))).status).toBe(200);
    expect(db.rpc).toHaveBeenCalledWith("ensure_account_profile", { p_wallet: WALLET, p_network: "devnet" });
  });
});
