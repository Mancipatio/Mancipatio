import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  verify: vi.fn(), admin: vi.fn(), owner: vi.fn(), isAdmin: vi.fn(), editor: vi.fn(),
  from: vi.fn(), calls: [] as Array<[string, ...unknown[]]>,
  result: { data: [] as Record<string, unknown>[], error: null as null | { message: string } },
}));
vi.mock("@/lib/server/siws", () => {
  class SiwsError extends Error { constructor(public status: number, message: string) { super(message); } }
  return { SiwsError, verifySigned: mocks.verify, siwsErrorResponse: (err: unknown) =>
    Response.json({ ok: false }, { status: err instanceof SiwsError ? err.status : 500 }) };
});
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/server/profile-read", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/server/profile-read")>();
  return { ...original, isProfileAdmin: mocks.isAdmin, requireProfileOwner: mocks.owner };
});
vi.mock("@/app/api/vesting/_lib", () => ({
  UUID_RE: /^[0-9a-f-]{36}$/i, requireVestingEditor: mocks.editor,
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ from: mocks.from }) }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
import { SiwsError } from "@/lib/server/siws";
import { POST as publicProfiles } from "@/app/api/profiles/public/route";
import { POST as privateProfiles } from "@/app/api/profiles/read/route";
import { POST as issuerProfiles } from "@/app/api/issuer-profiles/read/route";
import { POST as otc } from "@/app/api/otc/list/route";
import { POST as audit } from "@/app/api/audit/list/route";
import { POST as beneficiaries } from "@/app/api/vesting/beneficiaries/route";
import { projectPublicAssetProfile, PUBLIC_ASSET_PROFILE_FIELDS } from "@/lib/profile-public";

const WALLET = "11111111111111111111111111111111";
const OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ID = "d3c87bda-e195-47e2-bb9e-a18f7aa73dc5";
const request = (params: Record<string, unknown> = {}) => new Request("http://localhost/api/test", { method: "POST", body: JSON.stringify(params) });
function signed(params: Record<string, unknown>) { mocks.verify.mockResolvedValue({ wallet: WALLET, params }); }

beforeEach(() => {
  vi.clearAllMocks(); mocks.calls.length = 0; mocks.result = { data: [], error: null };
  const query = Object.fromEntries(["select", "eq", "in", "or", "order", "range"].map((method) => [method, (...args: unknown[]) => { mocks.calls.push([method, ...args]); return query; }])) as Record<string, unknown>;
  query.then = (resolve: (result: typeof mocks.result) => unknown) => Promise.resolve(mocks.result).then(resolve);
  mocks.from.mockImplementation((table: string) => { mocks.calls.push(["from", table]); return query; });
  mocks.admin.mockResolvedValue(undefined); mocks.owner.mockResolvedValue(undefined);
  mocks.isAdmin.mockResolvedValue(false); mocks.editor.mockResolvedValue({ id: ID });
  signed({});
});

describe("public profile boundary", () => {
  const profile = { asset_pda: WALLET, network: "devnet", is_published: true, status: "published", category: "equity", display_name: "Public offer" };
  it("rejects draft and archived profiles even if a publisher flag is inconsistent", () => {
    expect(projectPublicAssetProfile({ ...profile, status: "draft" })).toBeNull();
    expect(projectPublicAssetProfile({ ...profile, status: "archived" })).toBeNull();
    expect(projectPublicAssetProfile({ ...profile, is_published: false })).toBeNull();
  });
  it("never returns internal JSON, creator, private contract or draft document metadata", () => {
    const result = projectPublicAssetProfile({ ...profile, created_by: OTHER, fields: { email: "private@example.test" }, legal_doc_path: "private.pdf", whitepaper_status: "draft", whitepaper_url: "https://example.test/draft", whitepaper_sha256: "private-digest", ssc_decision_ref: "internal review" });
    expect(result).toMatchObject({ display_name: "Public offer", whitepaper_status: "none", whitepaper_url: null, whitepaper_sha256: null, ssc_decision_ref: null });
    expect(result).not.toHaveProperty("fields"); expect(result).not.toHaveProperty("created_by"); expect(result).not.toHaveProperty("legal_doc_path");
  });
  it("only exposes published document paths under the correct asset directory", () => {
    const result = projectPublicAssetProfile({ ...profile, whitepaper_status: "ssc_approved", whitepaper_path: `whitepapers/${WALLET}/report.pdf`, ssc_decision_doc_path: `whitepapers/${OTHER}/decision.pdf`, ssc_decision_ref: "PUBLIC-1" });
    expect(result).toMatchObject({ whitepaper_path: `whitepapers/${WALLET}/report.pdf`, ssc_decision_doc_path: null, ssc_decision_ref: "PUBLIC-1" });
  });
  it("enforces network/publication filters and reprojects rows returned by the database", async () => {
    mocks.result.data = [{ ...profile, fields: { secret: "hidden" } }];
    const res = await publicProfiles(request({ pdas: [WALLET], network: "mainnet" }));
    expect(res.status).toBe(200);
    expect(mocks.calls).toContainEqual(["eq", "network", "devnet"]);
    expect(mocks.calls).toContainEqual(["eq", "is_published", true]);
    expect(mocks.calls).toContainEqual(["eq", "status", "published"]);
    expect(mocks.calls).toContainEqual(["select", [...PUBLIC_ASSET_PROFILE_FIELDS, "spv_id"].join(",")]);
    expect((await res.json()).data[0]).not.toHaveProperty("fields");
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it("retains the public SPV name without exposing its private row or internal linkage", async () => {
    mocks.result.data = [{ ...profile, spv_id: ID }];
    const original = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => {
      if (table === "spvs") mocks.result = { data: [{ id: ID, name: "Example SPV", notes: "private", client_id: "private" }], error: null };
      return original(table);
    });
    const res = await publicProfiles(request());
    expect(res.status).toBe(200);
    const row = (await res.json()).data[0];
    expect(row.spv_name).toBe("Example SPV");
    expect(row).not.toHaveProperty("spv_id");
    expect(row).not.toHaveProperty("notes");
    expect(row).not.toHaveProperty("client_id");
    expect(mocks.calls).toContainEqual(["select", "id,name"]);
    expect(mocks.calls).toContainEqual(["in", "id", [ID]]);
  });
  it("returns a client error for malformed JSON without querying storage", async () => {
    const res = await publicProfiles(new Request("http://localhost/api/test", { method: "POST", body: "{" }));
    expect(res.status).toBe(400); expect(mocks.from).not.toHaveBeenCalled();
  });
  it("rejects oversized address batches before querying", async () => {
    const res = await publicProfiles(request({ pdas: Array(101).fill(WALLET) }));
    expect(res.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("signed profile readers", () => {
  it.each([privateProfiles, issuerProfiles])("rejects an unsigned read before touching private storage", async (route) => {
    mocks.verify.mockRejectedValue(new SiwsError(401, "Signature required"));
    expect((await route(request())).status).toBe(401); expect(mocks.from).not.toHaveBeenCalled();
  });
  it("rejects any foreign asset in a batch before reading any row", async () => {
    signed({ pdas: [WALLET, OTHER] });
    mocks.owner.mockImplementation(async (_wallet, pda) => { if (pda === OTHER) throw new SiwsError(403, "Denied"); });
    expect((await privateProfiles(request())).status).toBe(403); expect(mocks.from).not.toHaveBeenCalled();
  });
  it("authorizes every issuer and binds returned contact data to the current network", async () => {
    signed({ pdas: [WALLET] });
    expect((await issuerProfiles(request())).status).toBe(200);
    expect(mocks.owner).toHaveBeenCalledWith(WALLET, WALLET, "issuer");
    expect(mocks.calls).toContainEqual(["eq", "network", "devnet"]);
    expect(mocks.calls).toContainEqual(["in", "issuer_pda", [WALLET]]);
  });
  it("allows an on-chain admin to read requested private profiles", async () => {
    signed({ pdas: [OTHER] }); mocks.isAdmin.mockResolvedValue(true);
    expect((await privateProfiles(request())).status).toBe(200); expect(mocks.owner).not.toHaveBeenCalled();
  });
  it("fails closed when role resolution is unavailable", async () => {
    signed({ pdas: [WALLET] }); mocks.isAdmin.mockRejectedValue(new SiwsError(503, "RPC unavailable"));
    expect((await privateProfiles(request())).status).toBe(503); expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("OTC, audit and legacy beneficiary readers", () => {
  it("binds OTC participants to the signer, excludes staff notes and ignores a supplied different wallet", async () => {
    signed({ scope: "mine", wallet: OTHER, network: "mainnet" });
    expect((await otc(request())).status).toBe(200);
    expect(mocks.calls).toContainEqual(["or", `seller_wallet.eq.${WALLET},buyer_wallet.eq.${WALLET}`]);
    expect(mocks.calls).toContainEqual(["eq", "network", "devnet"]);
    const select = mocks.calls.find(([method]) => method === "select")?.[1];
    expect(select).not.toContain("admin_note"); expect(select).not.toContain("decided_by");
  });
  it.each([otc, audit])("denies admin reads before database access", async (route) => {
    signed({ scope: "admin" }); mocks.admin.mockRejectedValue(new SiwsError(403, "Admin required"));
    expect((await route(request())).status).toBe(403); expect(mocks.from).not.toHaveBeenCalled();
  });
  it("preserves audit attribution metadata only inside its admin-authorized response", async () => {
    signed({ page: 2 }); mocks.result.data = [{ metadata: { actor_verified: false } }];
    const res = await audit(request()); expect(res.status).toBe(200); expect(mocks.admin).toHaveBeenCalledWith(WALLET);
    expect(mocks.calls).toContainEqual(["range", 100, 149]);
    expect((await res.json()).data[0].metadata.actor_verified).toBe(false);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("restricts beneficiary proofs to the signer when editor authorization fails", async () => {
    signed({ schedule_id: ID, wallet: OTHER }); mocks.editor.mockRejectedValue(new SiwsError(403, "Not editor"));
    const res = await beneficiaries(request()); expect(res.status).toBe(200);
    expect(mocks.calls).toContainEqual(["eq", "wallet", WALLET]);
    expect((await res.json()).data.can_manage).toBe(false);
  });
  it("grants editor beneficiary access only after the existing on-chain/author gate passes", async () => {
    signed({ schedule_id: ID }); const res = await beneficiaries(request());
    expect(res.status).toBe(200); expect(mocks.editor).toHaveBeenCalledWith(WALLET, ID);
    expect(mocks.calls).not.toContainEqual(["eq", "wallet", WALLET]);
    expect((await res.json()).data.can_manage).toBe(true);
  });
  it("does not downgrade an unavailable beneficiary authorization check to self access", async () => {
    signed({ schedule_id: ID }); mocks.editor.mockRejectedValue(new SiwsError(503, "RPC unavailable"));
    expect((await beneficiaries(request())).status).toBe(503); expect(mocks.from).not.toHaveBeenCalled();
  });
  it("returns unavailable instead of an empty successful OTC result on database errors", async () => {
    signed({ scope: "mine" }); mocks.result.error = { message: "database paused" };
    expect((await otc(request())).status).toBe(503);
  });
});
