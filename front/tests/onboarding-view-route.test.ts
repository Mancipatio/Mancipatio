// The magic-link reads and writes of the onboarding page, run for real
// against an in-memory Supabase stand-in:
//   * /api/clients/onboarding-view — a fixed projection of the dossier: never
//     the token nor the internal columns (tags, tier, source, provider
//     references, account id, notes), plus `account_owned`;
//   * /api/clients/onboarding-requirements — the checklist without who
//     requested each document (a staff wallet or a system key);
//   * the wallet-less (email/Google) path finishes on the server: accept-tos
//     and upload work with the token alone for an account-owned dossier, an
//     invitation without an account still needs its wallet linked first.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({
  ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase>,
  uploads: [] as string[],
}));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    ...db.ref!.client,
    storage: {
      from: () => ({
        upload: async (path: string) => { db.uploads.push(path); return { error: null }; },
        remove: async () => ({ error: null }),
      }),
    },
  }),
}));
vi.mock("@/lib/server/maintenance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/maintenance")>()),
  assertWritable: vi.fn(async () => {}),
}));
// Operator mode is not under test here; keep the on-chain gate out of the import graph.
vi.mock("@/lib/server/kyc-provider-gate", () => ({ requireAdminOrKycProvider: vi.fn() }));

import { POST as onboardingView } from "@/app/api/clients/onboarding-view/route";
import { POST as onboardingRequirements } from "@/app/api/clients/onboarding-requirements/route";
import { POST as acceptTos } from "@/app/api/clients/accept-tos/route";
import { POST as upload } from "@/app/api/clients/upload/route";
import { TOS_VERSION } from "@/lib/tos-version";

const CLIENT_ID = "c0000000-0000-4000-8000-000000000003";
const OTHER_CLIENT_ID = "c0000000-0000-4000-8000-000000000009";
const ACCOUNT_ID = "a0000000-0000-4000-8000-0000000000aa";
const CLIENT_WALLET = "C1ientWa11etC1ientWa11etC1ientWa1";
const ADMIN = "AdminWa11etAdminWa11etAdminWa11et1";
const TOKEN = "secret-token";

type Handler = (request: Request) => Promise<Response>;
/** Each call comes from its own address: the routes rate-limit per IP. */
const headers = () => ({ "content-type": "application/json", "x-real-ip": crypto.randomUUID() });
async function post(handler: Handler, body: unknown) {
  const res = await handler(new Request("https://manci.test/api", { method: "POST", headers: headers(), body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string } };
}

/** A dossier as the database holds it, internal columns included. */
function dossier(overrides: Record<string, unknown> = {}) {
  return {
    id: CLIENT_ID, network: "devnet", type: "investor", types: ["investor"], display_name: "Carol Example",
    email: "carol@x.test", kyc_status: "more_info", onboarding_status: "connected", wallet: CLIENT_WALLET,
    account_id: ACCOUNT_ID, tags: ["high-risk"], tier: "pro", source: "referral", kyc_provider: "manual",
    kyc_provider_ref: "TxSigX", notes_count: 3, onboarding_token: TOKEN,
    onboarding_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    created_at: "2026-01-01T00:00:00Z", tos_accepted_at: null, tos_version: null, anonymized_at: null,
    ...overrides,
  };
}
const accountOwned = () => dossier({ wallet: null, onboarding_status: "connected" });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  db.ref = memorySupabase();
  db.uploads = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("magic-link reads (/api/clients/onboarding-view, /onboarding-requirements)", () => {
  it("returns the fixed projection of the dossier and nothing internal", async () => {
    db.ref!.rows("clients").push(dossier());
    const { status, body } = await post(onboardingView, { client_id: CLIENT_ID, token: TOKEN });
    expect(status).toBe(200);
    expect(Object.keys(body.data!).sort()).toEqual([
      "account_owned", "display_name", "id", "kyc_status", "onboarding_status", "tos_accepted_at", "tos_version", "type", "wallet",
    ]);
    // The wallet stays an address: the page compares it with the connected one.
    expect(body.data!.wallet).toBe(CLIENT_WALLET);
    expect(body.data!.account_owned).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/high-risk|secret-token|carol@x\.test|TxSigX|a0000000-|notes_count/);
  });

  it("flags a dossier owned by a wallet-less account; a wallet dossier of an account stays on the wallet path", async () => {
    db.ref!.rows("clients").push(accountOwned());
    const { status, body } = await post(onboardingView, { client_id: CLIENT_ID, token: TOKEN });
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ account_owned: true, wallet: null });
    expect(JSON.stringify(body)).not.toContain(ACCOUNT_ID);
    // An invitation (no wallet, no account) is not account-owned either.
    db.ref!.rows("clients")[0].account_id = null;
    expect((await post(onboardingView, { client_id: CLIENT_ID, token: TOKEN })).body.data!.account_owned).toBe(false);
  });

  it("answers a wrong token with 401 and no data", async () => {
    db.ref!.rows("clients").push(dossier());
    const { status, body } = await post(onboardingView, { client_id: CLIENT_ID, token: "guess" });
    expect(status).toBe(401);
    expect(body.data).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/Carol|high-risk/);
  });

  it("lists the checklist without who requested each document", async () => {
    db.ref!.rows("clients").push(dossier());
    db.ref!.rows("kyc_requirements").push(
      { id: 7, client_id: CLIENT_ID, doc_kind: "passport", label: "Passport", note: "Clear scan, please", status: "rejected",
        document_id: 11, requested_by: ADMIN, requested_at: "2026-01-02T00:00:00Z", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-03T00:00:00Z" },
      { id: 8, client_id: CLIENT_ID, doc_kind: "selfie", label: "Selfie / liveness", note: null, status: "requested",
        document_id: null, requested_by: "system:verification-kyc", requested_at: "2026-01-02T00:00:00Z", created_at: "2026-01-02T00:00:00Z", updated_at: null },
      { id: 9, client_id: OTHER_CLIENT_ID, doc_kind: "passport", label: "Passport", note: null, status: "requested",
        document_id: null, requested_by: ADMIN, requested_at: "2026-01-02T00:00:00Z" },
    );
    const { status, body } = await post(onboardingRequirements, { client_id: CLIENT_ID, token: TOKEN });
    expect(status).toBe(200);
    const rows = body.data!.requirements as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["doc_kind", "id", "label", "note", "requested_at", "status"]);
    }
    expect(rows.map((r) => r.id).sort()).toEqual([7, 8]);
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${ADMIN}|system:|document_id`));
  });
});

describe("the wallet-less (email/Google) onboarding path on the server", () => {
  it("accept-tos: an account-owned dossier accepts through its token alone, and no address can be stamped into the record", async () => {
    db.ref!.rows("clients").push(accountOwned());
    const { status, body } = await post(acceptTos, { client_id: CLIENT_ID, token: TOKEN });
    expect(status).toBe(200);
    expect(body.data).toEqual({ version: TOS_VERSION });
    expect(db.ref!.rows("clients")[0]).toMatchObject({ tos_version: TOS_VERSION });
    expect(typeof db.ref!.rows("clients")[0].tos_accepted_at).toBe("string");
    expect(db.ref!.rows("tos_acceptances")).toMatchObject([{ client_id: CLIENT_ID, wallet: null, version: TOS_VERSION, source: "onboarding" }]);
    expect(db.ref!.rows("client_notes")).toMatchObject([{ client_id: CLIENT_ID, author: "client", kind: "system" }]);

    // A wallet in the body is ignored for the acceptance record (a bearer of
    // the token must not stamp an arbitrary address into the audit trail).
    db.ref!.rows("tos_acceptances").length = 0;
    expect((await post(acceptTos, { client_id: CLIENT_ID, token: TOKEN, wallet: "22222222222222222222222222222222" })).status).toBe(200);
    expect(db.ref!.rows("tos_acceptances")).toMatchObject([{ client_id: CLIENT_ID, wallet: null }]);
  });

  it("accept-tos: an invitation without an account still needs its wallet linked first", async () => {
    db.ref!.rows("clients").push(dossier({ wallet: null, account_id: null, onboarding_status: "invited" }));
    expect((await post(acceptTos, { client_id: CLIENT_ID, token: TOKEN })).status).toBe(401);
    expect(db.ref!.rows("clients")[0].tos_accepted_at).toBeNull();
    expect(db.ref!.rows("tos_acceptances")).toEqual([]);
  });

  it("upload: a magic-link upload of an account-owned dossier lands as 'client', flips the requirement and recomputes the status", async () => {
    db.ref!.rows("clients").push(accountOwned());
    db.ref!.rows("kyc_requirements").push({ id: 7, client_id: CLIENT_ID, doc_kind: "passport", label: "Passport", note: null, status: "requested", requested_by: ADMIN, requested_at: "2026-01-02T00:00:00Z" });
    const form = new FormData();
    form.set("client_id", CLIENT_ID);
    form.set("token", TOKEN);
    form.set("kind", "passport");
    form.set("requirement_id", "7");
    form.set("file", new File([new TextEncoder().encode("%PDF-1.4 passport")], "passport.pdf", { type: "application/pdf" }));
    const res = await upload(new Request("https://manci.test/api/clients/upload", { method: "POST", headers: { "x-real-ip": crypto.randomUUID() }, body: form }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { recomputed: string | null } };
    expect(body.data.recomputed).toBe("pending");
    expect(db.uploads).toHaveLength(1);
    expect(db.uploads[0]).toMatch(new RegExp(`^clients/${CLIENT_ID}/passport/`));
    expect(db.ref!.rows("client_documents")).toMatchObject([{ client_id: CLIENT_ID, kind: "passport", uploaded_by: "client" }]);
    expect(db.ref!.rows("kyc_requirements")[0]).toMatchObject({ status: "submitted" });
    expect(db.ref!.rows("clients")[0]).toMatchObject({ kyc_status: "pending" });
  });
});
