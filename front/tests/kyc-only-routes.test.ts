// The server half of KYC-only mode (lib/server/feature-gate.ts requireArea):
// while the mode is on, the ENTRY routes of primary sales and issuance answer
// 403 with KYC_ONLY_MESSAGE, a pure entry route before the signature and
// before any database work, a route an admin also uses on its non-admin
// branch only. Take-downs (a listing's is_published=false, a profile's
// Unpublish), the admin paths, the verification (KYC) request and every
// exit stay open. With the mode off, none of them answers that 403. SIWS,
// the admin gate, profile ownership, the share-class chain and the database
// are mocked; the routes and the gate run for real.
import { getAddressDecoder } from "@solana/kit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const at = vi.hoisted(() => ({
  // Deterministic test keys (32 equal bytes each), no real wallet.
  admin: "",
  issuer: "",
  authority: "",
}));
{
  const address = (seed: number) => getAddressDecoder().decode(new Uint8Array(32).fill(seed)).toString();
  at.admin = address(11);
  at.issuer = address(12);
  at.authority = at.issuer;
}

vi.mock("server-only", () => ({}));
// A request that passes the gate stops at the signature (401) unless a test signs it.
vi.mock("@/lib/server/siws", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/siws")>();
  return { ...real, verifySigned: vi.fn(async () => { throw new real.SiwsError(401, "signature checked"); }) };
});
vi.mock("@/lib/server/admin-gate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/admin-gate")>();
  const { SiwsError } = await import("@/lib/server/siws");
  const gate = async (wallet: string) => { if (wallet !== at.admin) throw new SiwsError(403, "Admin only"); };
  return { ...real, requireAdmin: vi.fn(gate), requireSuperAdmin: vi.fn(gate) };
});
vi.mock("@/lib/server/profile-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/profile-read")>()),
  requireProfileOwner: vi.fn(async () => {}),
}));
vi.mock("@/app/api/sale-approvals/_lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/sale-approvals/_lib")>()),
  shareClassChain: vi.fn(async (shareClass: string) => ({ shareClass, asset: "A", issuer: "I", authority: at.authority, issuerVerified: true })),
}));
vi.mock("@/lib/server/shared-rate-limit", () => ({ consumeSharedRateLimit: vi.fn(async () => "ok") }));
// The on-chain Sale -> ShareClass -> Asset -> Issuer chain of launchpad/_lib.ts
// saleChainInfo (as tests/feature-flag-routes.test.ts): a Mature sale of the issuer.
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/generated/asset_registry")>();
  const account = (data: Record<string, unknown>) => ({ exists: true, programAddress: original.ASSET_REGISTRY_PROGRAM_ADDRESS, data });
  return {
    ...original,
    fetchMaybeSale: vi.fn(async () => account({ shareClass: "ShareC1ass111111111111111111111111111111111", raiseType: 0 })),
    fetchMaybeShareClass: vi.fn(async () => account({ asset: "Asset1111111111111111111111111111111111111" })),
    fetchMaybeAsset: vi.fn(async () => account({ issuer: "Issuer111111111111111111111111111111111111" })),
    fetchMaybeIssuer: vi.fn(async () => account({ authority: at.issuer })),
  };
});
const db = vi.hoisted(() => ({ touched: [] as string[] }));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => { db.touched.push(table); throw new Error("no database in this test"); },
    rpc: (fn: string) => { db.touched.push(fn); throw new Error("no database in this test"); },
  }),
}));

import { verifySigned } from "@/lib/server/siws";
import { KYC_ONLY_ENV, KYC_ONLY_MESSAGE, PILOT_MODULE_ENV } from "@/lib/features";

type Route = { POST: (r: Request) => Promise<Response> };
type Load = () => Promise<Route>;

const ASSET = getAddressDecoder().decode(new Uint8Array(32).fill(13)).toString();
const SALE = getAddressDecoder().decode(new Uint8Array(32).fill(14)).toString();
const RECIPIENT = getAddressDecoder().decode(new Uint8Array(32).fill(15)).toString();

async function post(load: Load) {
  const { POST } = await load();
  const res = await POST(new Request("https://manci.test/api/x", { method: "POST", body: "{}" }));
  return { status: res.status, body: (await res.json()) as { error?: string } };
}
function signed(wallet: string, params: Record<string, unknown>) {
  vi.mocked(verifySigned).mockResolvedValueOnce({ wallet, params, via: "signature" } as never);
}
function network(name: "mainnet" | "devnet", kyc: string) {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", name);
  vi.stubEnv(KYC_ONLY_ENV, kyc);
  for (const variable of Object.values(PILOT_MODULE_ENV)) vi.stubEnv(variable, "");
}
/** KYC-only mode on (mainnet, the variable unset). */
const modeOn = () => network("mainnet", "");
/** Today's mainnet: the mode read as off. */
const modeOff = () => network("mainnet", "off");

beforeEach(() => {
  db.touched.length = 0;
  at.authority = at.issuer;
});
afterEach(() => vi.unstubAllEnvs());

// Pure entry routes: the gate is their first line, before the signature.
const PRE_SIGNATURE: Array<[string, Load, string | null]> = [
  ["launchpad/commit", () => import("@/app/api/launchpad/commit/route"), null],
  ["compliance/screen-wallet", () => import("@/app/api/compliance/screen-wallet/route"), null],
  ["sale-requests/submit", () => import("@/app/api/sale-requests/submit/route"), null],
  ["applications/submit", () => import("@/app/api/applications/submit/route"), null],
  ["applications/resubmit", () => import("@/app/api/applications/resubmit/route"), null],
  // A vesting-series entry (requireModule("vesting")): off with every module in the mode.
  ["vesting-series/update", () => import("@/app/api/vesting-series/update/route"), PILOT_MODULE_ENV.vesting],
];

describe("entry routes answer 403 before the signature while the mode is on", () => {
  it.each(PRE_SIGNATURE)("%s", async (_name, load, moduleEnv) => {
    modeOn();
    const refused = await post(load);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe(KYC_ONLY_MESSAGE);
    expect(db.touched).toEqual([]);

    // The mode off (its module on, for a module route): the signature is reached.
    modeOff();
    if (moduleEnv) vi.stubEnv(moduleEnv, "true");
    expect((await post(load)).status).toBe(401);

    network("devnet", "");
    expect((await post(load)).status).toBe(401);
    network("devnet", "on");
    const rehearsal = await post(load);
    expect(rehearsal.status).toBe(403);
    expect(rehearsal.body.error).toBe(KYC_ONLY_MESSAGE);
  });
});

describe("routes an admin also uses: the non-admin branch only", () => {
  const notKycRefusal = (res: { status: number; body: { error?: string } }) =>
    !(res.status === 403 && res.body.error === KYC_ONLY_MESSAGE);

  it("issuer-profiles/upsert: an issuer is refused, an admin goes on", async () => {
    const load = () => import("@/app/api/issuer-profiles/upsert/route");
    const params = { profile: { issuer_pda: ASSET, company_name: "Example Ltd" } };
    modeOn();
    signed(at.issuer, params);
    const refused = await post(load);
    expect(refused).toMatchObject({ status: 403, body: { error: KYC_ONLY_MESSAGE } });
    expect(db.touched).toEqual([]);
    signed(at.admin, params);
    expect((await post(load)).status).not.toBe(403);
    expect(db.touched).toContain("issuer_profiles");
    modeOff();
    signed(at.issuer, params);
    expect(notKycRefusal(await post(load))).toBe(true);
  });

  it("profiles/upsert: an issuer's publish or edit is refused; Unpublish and the admin go on", async () => {
    const load = () => import("@/app/api/profiles/upsert/route");
    const base = { asset_pda: ASSET, category: "equity" };
    const publish = { profile: { ...base, issuer_pda: ASSET, status: "published", is_published: true } };
    const edit = { profile: { ...base, display_name: "Example" } };
    const unpublish = { profile: { ...base, issuer_pda: ASSET, status: "draft", is_published: false } };
    // An Unpublish that also changes something is not a take-down.
    const unpublishAndEdit = { profile: { ...unpublish.profile, display_name: "Example" } };
    modeOn();
    for (const params of [publish, edit, unpublishAndEdit]) {
      signed(at.issuer, params);
      expect(await post(load)).toMatchObject({ status: 403, body: { error: KYC_ONLY_MESSAGE } });
    }
    expect(db.touched).toEqual([]);
    signed(at.issuer, unpublish);
    expect(notKycRefusal(await post(load))).toBe(true);
    expect(db.touched.length).toBeGreaterThan(0);
    db.touched.length = 0;
    signed(at.admin, publish);
    expect(notKycRefusal(await post(load))).toBe(true);
    expect(db.touched.length).toBeGreaterThan(0);
    modeOff();
    signed(at.issuer, publish);
    expect(notKycRefusal(await post(load))).toBe(true);
  });

  it("storage/upload (whitepapers): an issuer is refused, an admin goes on", async () => {
    const load = () => import("@/app/api/storage/upload/route");
    const params = { bucket: "documents", path: `whitepapers/${ASSET}/aaaaaaaa-paper.pdf`, sha256: "a".repeat(64), contentType: "application/pdf", size: 100 };
    modeOn();
    signed(at.issuer, params);
    expect(await post(load)).toMatchObject({ status: 403, body: { error: KYC_ONLY_MESSAGE } });
    expect(db.touched).toEqual([]);
    signed(at.admin, params);
    expect((await post(load)).status).not.toBe(403);
    expect(db.touched).toContain("document_uploads");
    modeOff();
    signed(at.issuer, params);
    expect(notKycRefusal(await post(load))).toBe(true);
  });

  it("compliance/screen-recipients: every issuer key is refused (Send to wallets is paused); an admin goes on", async () => {
    const load = () => import("@/app/api/compliance/screen-recipients/route");
    const params = { share_class: SALE, wallets: [RECIPIENT] };
    modeOn();
    signed(at.issuer, params);
    expect(await post(load)).toMatchObject({ status: 403, body: { error: KYC_ONLY_MESSAGE } });
    // The operator's key as the class's issuer authority: refused too.
    at.authority = at.admin;
    signed(at.admin, params);
    expect(await post(load)).toMatchObject({ status: 403, body: { error: KYC_ONLY_MESSAGE } });
    // An admin that is not the issuer: the admin path (requireAdmin) goes on.
    at.authority = at.issuer;
    signed(at.admin, params);
    expect(notKycRefusal(await post(load))).toBe(true);
    modeOff();
    signed(at.issuer, params);
    expect(notKycRefusal(await post(load))).toBe(true);
  });

  it("launchpad/listing-upsert: an issuer's publish is refused; a take-down and the admin go on", async () => {
    const load = () => import("@/app/api/launchpad/listing-upsert/route");
    modeOn();
    signed(at.issuer, { listing: { sale_pubkey: SALE, is_published: true } });
    expect(await post(load)).toMatchObject({ status: 403, body: { error: KYC_ONLY_MESSAGE } });
    expect(db.touched).toEqual([]);
    signed(at.issuer, { listing: { sale_pubkey: SALE, is_published: false } });
    expect(notKycRefusal(await post(load))).toBe(true);
    expect(db.touched).toContain("save_launch_listing");
    db.touched.length = 0;
    signed(at.admin, { listing: { sale_pubkey: SALE, is_published: true } });
    expect(notKycRefusal(await post(load))).toBe(true);
    expect(db.touched).toContain("save_launch_listing");
    modeOff();
    signed(at.issuer, { listing: { sale_pubkey: SALE, is_published: true } });
    expect(notKycRefusal(await post(load))).toBe(true);
  });

  it("verification/submit: a person's KYC goes on; a company's KYB is refused while the mode is on", async () => {
    const load = () => import("@/app/api/verification/submit/route");
    modeOn();
    signed(at.issuer, { kind: "kyb" });
    expect(await post(load)).toMatchObject({ status: 403, body: { error: KYC_ONLY_MESSAGE } });
    expect(db.touched).toEqual([]);
    signed(at.issuer, { kind: "kyc" });
    expect(notKycRefusal(await post(load))).toBe(true);
    modeOff();
    signed(at.issuer, { kind: "kyb" });
    expect(notKycRefusal(await post(load))).toBe(true);
  });
});

describe("source matrix", () => {
  const source = (route: string) => readFileSync(join(process.cwd(), "app/api", route, "route.ts"), "utf8");

  it("every locked route calls its gate; a pure entry route before the signature", () => {
    const locked: Array<[string, RegExp]> = [
      ["launchpad/commit", /requireArea\("primarySales"\)/],
      ["compliance/screen-wallet", /requireArea\("primarySales"\)/],
      ["sale-requests/submit", /requireArea\("primarySales"\)/],
      ["applications/submit", /requireArea\("issuance"\)/],
      ["applications/resubmit", /requireArea\("issuance"\)/],
      ["vesting-series/update", /requireModule\("vesting"\)/],
    ];
    for (const [route, gate] of locked) {
      const text = source(route);
      const index = text.search(gate);
      expect(index, route).toBeGreaterThan(-1);
      expect(index, route).toBeLessThan(text.indexOf("verifySigned("));
    }
    for (const [route, gate] of [
      ["launchpad/listing-upsert", 'requireArea("primarySales")'],
      ["issuer-profiles/upsert", 'requireArea("issuance")'],
      ["profiles/upsert", 'requireArea("issuance")'],
      ["storage/upload", 'requireArea("issuance")'],
      ["verification/submit", 'if (kind === "kyb") requireArea("issuance")'],
    ] as const) {
      expect(source(route), route).toContain(gate);
    }
    expect(readFileSync(join(process.cwd(), "app/api/compliance/_recipients.ts"), "utf8")).toContain('requireArea("issuance")');
  });

  it("the verification request, sign-in, the Terms, support, purchase recovery and exits stay open", () => {
    for (const route of [
      "passport/submit", "passport/status",
      "clients/me", "clients/upload", "clients/link-wallet", "clients/accept-tos", "clients/onboarding-view", "clients/onboarding-requirements",
      "tos/accept", "tos/status", "auth/session", "auth/email/start", "auth/email/verify", "account/update", "account/wallets/attach",
      "inquiries/create", "launchpad/record-purchase", "conversion/cancel", "conversion/reclaim", "conversion/deposited",
      "delivery/cancel", "delivery/reclaim", "resell/update", "sale-requests/decide", "archive/set",
      "distribution-plans/proof", "payout-snapshots/proof",
    ]) {
      const text = source(route);
      expect(text, route).not.toContain("requireArea(");
      expect(text, route).not.toContain("requireModule(");
    }
  });
});
