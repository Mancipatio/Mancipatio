import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({
  params: {} as Record<string, unknown>,
  calls: [] as { table: string; op: string; value?: unknown }[],
  openRequests: [] as unknown[],
  ensureDossier: vi.fn(), ensureReqs: vi.fn(), missingDocs: vi.fn(),
}));
vi.mock("@/lib/server/siws", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: "7xGLjBL7VWYNmBZxmPBv9YJSQd8FywuRyAnGoC9mhjjs", params: m.params })),
}));
vi.mock("@/lib/server/bounded-request", () => ({ boundedRequest: async (r: Request) => r }));
vi.mock("@/app/api/clients/_helpers", () => ({
  clientIpOf: () => "1.1.1.1", rateLimited: () => false, insertNote: vi.fn(), DEGRADED_TTL_MESSAGE: "degraded",
}));
vi.mock("@/lib/server/kyc-dossier", () => ({
  ensureClientDossier: m.ensureDossier, ensureStandardRequirements: m.ensureReqs, requestMissingDocuments: m.missingDocs,
  STANDARD_COMPANY_REQUIREMENTS: [{ doc_kind: "incorporation", label: "x" }],
  STANDARD_INVESTOR_REQUIREMENTS: [{ doc_kind: "passport", label: "y" }],
}));
function chain(table: string) {
  const c: Record<string, unknown> = {};
  const self = () => c;
  Object.assign(c, {
    select: self, eq: self, in: self, limit: async () => ({ data: m.openRequests, error: null }),
    maybeSingle: async () => ({ data: { display_name: "Investor 7xGLjB…hjjs" }, error: null }),
    upsert: async (value: unknown) => { m.calls.push({ table, op: "upsert", value }); return { error: null }; },
    insert: async (value: unknown) => { m.calls.push({ table, op: "insert", value }); return { error: null }; },
    update: (value: unknown) => { m.calls.push({ table, op: "update", value }); return { eq: async () => ({ error: null }) }; },
  });
  return c;
}
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ from: chain }) }));

import { POST } from "@/app/api/verification/submit/route";

const kyc = {
  kind: "kyc", legal_name: "Ana Anić", date_of_birth: "1990-05-01", nationality: 688, residence_country: 688,
  address_line: "Knez Mihailova 1", city: "Beograd", postal_code: "11000", email: "ana@example.com",
};
const kyb = {
  kind: "kyb", legal_name: "Ana Anić", residence_country: 688, address_line: "Knez Mihailova 1", city: "Beograd",
  postal_code: "11000", email: "ana@example.com", company_name: "Ana d.o.o.", company_reg_number: "12345678",
  company_country: 688, company_address: "Bulevar 2, Beograd", representative_role: "Director",
};
const call = async (params: Record<string, unknown>) => {
  m.params = params;
  const res = await POST(new Request("https://manci.test/api/verification/submit", { method: "POST", body: "{}" }));
  return { status: res.status, json: await res.json() };
};

beforeEach(() => {
  m.calls.length = 0; m.openRequests = [];
  m.ensureDossier.mockReset().mockResolvedValue({ client: { id: "c1", email: null, kyc_status: "pending" }, token: "tok", created: true, linkUnusable: false });
  m.ensureReqs.mockReset().mockResolvedValue(undefined);
  m.missingDocs.mockReset().mockResolvedValue(undefined);
});

describe("/api/verification/submit", () => {
  it("stores KYC details, requests documents, files a passport request and returns the upload link", async () => {
    const { status, json } = await call(kyc);
    expect(status).toBe(200);
    expect(json.data.onboarding_path).toBe("/onboarding/c1?t=tok");
    expect(m.ensureDossier).toHaveBeenCalledWith(expect.anything(), expect.any(String), 688, "investor", "verification-kyc", false);
    expect(m.calls.find((c) => c.table === "client_verification_details")?.value).toMatchObject({ kind: "kyc", legal_name: "Ana Anić", company_name: null, status: "pending", reviewed_at: null });
    expect(m.calls.some((c) => c.table === "passport_requests" && c.op === "insert")).toBe(true);
    expect(m.calls.find((c) => c.table === "clients")?.value).toMatchObject({ email: "ana@example.com", display_name: "Ana Anić" });
  });

  it("provisions a company (issuer) dossier for KYB without a passport request", async () => {
    const { status } = await call(kyb);
    expect(status).toBe(200);
    // KYB always gets an upload link and its own document set, even on a KYC-verified dossier.
    expect(m.ensureDossier).toHaveBeenCalledWith(expect.anything(), expect.any(String), 688, "issuer", "verification-kyb", true);
    expect(m.missingDocs).toHaveBeenCalledOnce();
    expect(m.ensureReqs).not.toHaveBeenCalled();
    expect(m.calls.find((c) => c.table === "client_verification_details")?.value).toMatchObject({ kind: "kyb", status: "pending" });
    expect(m.calls.some((c) => c.table === "passport_requests")).toBe(false);
  });

  it.each([
    ["unknown field", { ...kyc, wallet: "x" }],
    ["missing date of birth", { ...kyc, date_of_birth: undefined }],
    ["under 18", { ...kyc, date_of_birth: new Date().toISOString().slice(0, 10) }],
    ["unsupported residence", { ...kyc, residence_country: 4 }],
    ["bad email", { ...kyc, email: "nope" }],
    ["KYB without company", { ...kyb, company_name: undefined }],
    ["bad kind", { ...kyc, kind: "other" }],
  ])("rejects %s before touching the dossier", async (_label, params) => {
    const { status } = await call(params as Record<string, unknown>);
    expect(status).toBe(400);
    expect(m.ensureDossier).not.toHaveBeenCalled();
  });
});
