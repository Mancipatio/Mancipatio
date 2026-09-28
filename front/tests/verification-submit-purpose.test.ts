// Sim gap G5: every /verify KYC used to file a passport request, also for a
// founder who verifies only to raise (/verify?next=/apply), so the /admin/kyc
// queue and its badge filled with requests nobody meant to act on. The
// founder's submit (`purpose: "founder"`) now files none; the default
// (investor) still does. Same mocks as tests/verification-submit-route.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({
  params: {} as Record<string, unknown>,
  calls: [] as { table: string; op: string; value?: unknown }[],
  ensureDossier: vi.fn(), ensureReqs: vi.fn(), missingDocs: vi.fn(),
}));
vi.mock("@/lib/server/siws", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: "7xGLjBL7VWYNmBZxmPBv9YJSQd8FywuRyAnGoC9mhjjs", params: m.params })),
}));
vi.mock("@/lib/server/bounded-request", () => ({ boundedRequest: async (r: Request) => r }));
vi.mock("@/app/api/clients/_helpers", () => ({
  clientIpOf: () => "1.1.1.1", ipRateLimitKey: (ip: string) => ip, rateLimited: () => false, insertNote: vi.fn(), DEGRADED_TTL_MESSAGE: "degraded",
}));
vi.mock("@/lib/server/kyc-dossier", () => ({
  ensureClientDossier: m.ensureDossier, ensureStandardRequirements: m.ensureReqs, requestMissingDocuments: m.missingDocs,
  accountIdForWallet: async () => "acc-1",
  STANDARD_COMPANY_REQUIREMENTS: [{ doc_kind: "incorporation", label: "x" }],
  STANDARD_INVESTOR_REQUIREMENTS: [{ doc_kind: "passport", label: "y" }],
}));
function chain(table: string) {
  const c: Record<string, unknown> = {};
  const self = () => c;
  Object.assign(c, {
    select: self, eq: self, in: self, limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: { display_name: "Investor 7xGLjB…hjjs" }, error: null }),
    upsert: async (value: unknown) => { m.calls.push({ table, op: "upsert", value }); return { error: null }; },
    insert: async (value: unknown) => { m.calls.push({ table, op: "insert", value }); return { error: null }; },
    update: (value: unknown) => { m.calls.push({ table, op: "update", value }); return { eq: async () => ({ error: null }) }; },
  });
  return c;
}
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ from: chain }) }));
vi.mock("@/lib/server/shared-rate-limit", () => ({ consumeSharedRateLimit: vi.fn(async () => "ok") }));

import { POST } from "@/app/api/verification/submit/route";

const kyc = {
  kind: "kyc", legal_name: "Ana Anić", date_of_birth: "1990-05-01", nationality: 688, residence_country: 688,
  address_line: "Knez Mihailova 1", city: "Beograd", postal_code: "11000", email: "ana@example.com",
};
const call = async (params: Record<string, unknown>) => {
  m.params = params;
  const res = await POST(new Request("https://manci.test/api/verification/submit", { method: "POST", body: "{}" }));
  return { status: res.status, json: await res.json() };
};
const filedPassportRequest = () => m.calls.some((c) => c.table === "passport_requests" && c.op === "insert");

beforeEach(() => {
  m.calls.length = 0;
  m.ensureDossier.mockReset().mockResolvedValue({ client: { id: "c1", email: null, kyc_status: "pending" }, token: "tok", created: true, linkUnusable: false });
  m.ensureReqs.mockReset().mockResolvedValue(undefined);
  m.missingDocs.mockReset().mockResolvedValue(undefined);
});

describe("/api/verification/submit purpose (G5)", () => {
  it("a founder's KYC requests the documents but files no passport request", async () => {
    const { status } = await call({ ...kyc, purpose: "founder" });
    expect(status).toBe(200);
    expect(m.ensureReqs).toHaveBeenCalledOnce();
    expect(filedPassportRequest()).toBe(false);
  });

  it("keeps the purpose as the dossier's role: officer for a founder, investor otherwise", async () => {
    await call({ ...kyc, purpose: "founder" });
    expect(m.ensureDossier.mock.calls[0][3]).toBe("officer");
    await call({ ...kyc, purpose: "investor" });
    expect(m.ensureDossier.mock.calls[1][3]).toBe("investor");
  });

  it("an investor's KYC (the default, or explicit) still files one", async () => {
    expect((await call({ ...kyc, purpose: "investor" })).status).toBe(200);
    expect(filedPassportRequest()).toBe(true);
    m.calls.length = 0;
    expect((await call(kyc)).status).toBe(200);
    expect(filedPassportRequest()).toBe(true);
  });

  it("refuses an unknown purpose before touching the dossier", async () => {
    const { status } = await call({ ...kyc, purpose: "passport-please" });
    expect(status).toBe(400);
    expect(m.ensureDossier).not.toHaveBeenCalled();
  });
});
