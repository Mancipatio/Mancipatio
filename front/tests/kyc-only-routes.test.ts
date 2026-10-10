// The server half of KYC-only mode (lib/server/feature-gate.ts requireArea):
// while the mode is on, the ENTRY routes of primary sales and issuance answer
// 403 with KYC_ONLY_MESSAGE, a pure entry route before the signature and
// before any database work, a route an admin also uses on its non-admin
// branch only. Take-downs (a listing's is_published=false, a profile's
// Unpublish), the admin paths, the verification (KYC) request and every
// exit stay open. With the mode off, none of them answers that 403. SIWS,
// the admin gate, profile ownership, the share-class chain and the database
// are mocked; the routes and the gate run for real. Last, every API route is
// classified: gated (admin, area or module), open for a recorded reason, or
// MIXED (an admin and anyone else take different branches) with what its
// non-admin branch is, so a new entry route, or a new non-admin branch of an
// admin route, cannot stay open in the mode unnoticed.
import { getAddressDecoder } from "@solana/kit";
import { readdirSync, readFileSync } from "node:fs";
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
const PRE_SIGNATURE: Array<[string, Load]> = [
  ["launchpad/commit", () => import("@/app/api/launchpad/commit/route")],
  ["compliance/screen-wallet", () => import("@/app/api/compliance/screen-wallet/route")],
  ["sale-requests/submit", () => import("@/app/api/sale-requests/submit/route")],
  ["applications/submit", () => import("@/app/api/applications/submit/route")],
  ["applications/resubmit", () => import("@/app/api/applications/resubmit/route")],
  // The issuer's resubmission of a vesting series request: an issuance entry,
  // a no-op while the mode is off (mainnet with vesting off included: today's).
  ["vesting-series/update", () => import("@/app/api/vesting-series/update/route")],
];

describe("entry routes answer 403 before the signature while the mode is on", () => {
  it.each(PRE_SIGNATURE)("%s", async (_name, load) => {
    modeOn();
    const refused = await post(load);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe(KYC_ONLY_MESSAGE);
    expect(db.touched).toEqual([]);

    // The mode off (every module switch unset, as today): the signature is reached.
    modeOff();
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

  it("compliance/screen-recipients: a non-admin issuer is refused; an Admin issuer key and an admin go on", async () => {
    const load = () => import("@/app/api/compliance/screen-recipients/route");
    const params = { share_class: SALE, wallets: [RECIPIENT] };
    modeOn();
    signed(at.issuer, params);
    expect(await post(load)).toMatchObject({ status: 403, body: { error: KYC_ONLY_MESSAGE } });
    expect(db.touched).toEqual([]);
    // The operator's key as the class's issuer authority: the admin console stays whole.
    at.authority = at.admin;
    signed(at.admin, params);
    expect(notKycRefusal(await post(load))).toBe(true);
    // An admin that is not the issuer: the admin path (requireAdmin) goes on.
    at.authority = at.issuer;
    signed(at.admin, params);
    expect(notKycRefusal(await post(load))).toBe(true);
    modeOff();
    signed(at.issuer, params);
    expect(notKycRefusal(await post(load))).toBe(true);
  });

  it("vesting/update-status: an issuer's forward move is refused; completing, cancelling and the admin go on", async () => {
    const load = () => import("@/app/api/vesting/update-status/route");
    const SCHEDULE = "00000000-0000-4000-8000-000000000001";
    modeOn();
    for (const status of ["published", "live"]) {
      signed(at.issuer, { schedule_id: SCHEDULE, status });
      expect(await post(load), status).toMatchObject({ status: 403, body: { error: KYC_ONLY_MESSAGE } });
    }
    expect(db.touched).toEqual([]);
    for (const status of ["completed", "cancelled"]) {
      signed(at.issuer, { schedule_id: SCHEDULE, status });
      expect(notKycRefusal(await post(load)), status).toBe(true);
    }
    expect(db.touched).toContain("vesting_schedules");
    db.touched.length = 0;
    signed(at.admin, { schedule_id: SCHEDULE, status: "live" });
    expect(notKycRefusal(await post(load))).toBe(true);
    expect(db.touched).toContain("vesting_schedules");
    modeOff();
    signed(at.issuer, { schedule_id: SCHEDULE, status: "live" });
    expect(notKycRefusal(await post(load))).toBe(true);
  });

  it("vesting/publish-milestone: an issuer is refused; the admin goes on", async () => {
    const load = () => import("@/app/api/vesting/publish-milestone/route");
    const params = { schedule_id: "00000000-0000-4000-8000-000000000001", idx: 0 };
    modeOn();
    signed(at.issuer, params);
    expect(await post(load)).toMatchObject({ status: 403, body: { error: KYC_ONLY_MESSAGE } });
    expect(db.touched).toEqual([]);
    signed(at.admin, params);
    expect(notKycRefusal(await post(load))).toBe(true);
    expect(db.touched).toContain("vesting_schedules");
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
      ["vesting-series/update", /requireArea\("issuance"\)/],
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
      ["vesting/update-status", 'requireArea("issuance")'],
      ["vesting/publish-milestone", 'requireArea("issuance")'],
      // An issuer's unarchive that would re-publish (tests/archive-routes.test.ts).
      ["archive/set", 'if (state.actor === "issuer" && unarchiveRepublishes(state.record)) requireArea("issuance")'],
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
      "delivery/cancel", "delivery/reclaim", "resell/update", "sale-requests/decide",
      "distribution-plans/proof", "payout-snapshots/proof",
    ]) {
      const text = source(route);
      expect(text, route).not.toContain("requireArea(");
      expect(text, route).not.toContain("requireModule(");
    }
  });
});

describe("every API route is classified", () => {
  // A route is GATED when every branch ends in a gate: an admin gate right
  // after the signature (topLevelAdminGate), a KYC-only area (requireArea), a
  // module switch (requireModule) or the Send to wallets sender check
  // (requireClassSender, which calls requireArea). A route is MIXED when an
  // admin and anyone else take different branches: it probes for an admin
  // (isAdminWallet, isSuperAdminWallet, isProfileAdmin, an archive actor), or
  // its admin gate is on one branch only. A MIXED route names what its
  // non-admin branch is: "gated" (requireArea/requireModule, pinned by the
  // tests above), "admin" (every branch is an admin's after all), or the
  // reason it stays open in KYC-only mode. Every other route is OPEN and is
  // listed with its reason. A new ungated route, or a new non-admin branch
  // of an admin route, fails here.
  const GATE = /\b(requireAdmin|requireSuperAdmin|requireAdminOrKycProvider|requireKycProvider|requireArea|requireModule|requireClassSender)\(/;
  const ADMIN_GATE = /\b(requireAdmin|requireSuperAdmin|requireAdminOrKycProvider|requireKycProvider)\(/;
  const ADMIN_STATEMENT = /^\s*(?:const [^=]+=\s*)?await (?:requireAdmin|requireSuperAdmin|requireAdminOrKycProvider|requireKycProvider)\(/;
  const ADMIN_PROBE = /\b(isAdminWallet|isSuperAdminWallet|isProfileAdmin)\(|\bstate\.actor\b/;
  const AREA_GATE = /\b(requireArea|requireModule|requireClassSender)\(/;
  type OpenReason =
    | "sign-in" // wallet, email or Google session
    | "account" // the signed-in account and its wallets
    | "terms" // Terms acceptance
    | "verification" // the KYC request, its documents and the passport
    | "read" // reads only
    | "exit" // winding down an existing position
    | "recording" // records an on-chain fact or finishes an authorized step
    | "support" // the contact form
    | "platform"; // health, cron, CSP reports, audit breadcrumbs, a gone route
  const OPEN: Record<string, OpenReason> = {
    "account/email/cancel": "account", "account/email/request": "account", "account/email/verify": "account",
    "account/google/callback": "sign-in", "account/google/start": "sign-in", "account/google/unlink": "account",
    "account/me": "account", "account/update": "account",
    "account/wallets/attach": "account", "account/wallets/cancel": "account", "account/wallets/complete": "account",
    "account/wallets/primary": "account", "account/wallets/remove": "account", "account/wallets/start": "account",
    "account/wallets/transaction": "account",
    "applications/capacity": "read", "applications/eligibility": "read", "applications/mine": "read", "applications/public": "read",
    "archive/check": "read", "archive/list": "read",
    "audit": "platform",
    "auth/email/start": "sign-in", "auth/email/verify": "sign-in", "auth/google/start": "sign-in",
    "auth/logout": "sign-in", "auth/me": "sign-in", "auth/session": "sign-in",
    "clients/accept-tos": "verification", "clients/link-wallet": "verification", "clients/me": "verification",
    "clients/onboarding-requirements": "verification", "clients/onboarding-view": "verification",
    "conversion/cancel": "exit", "conversion/reclaim": "exit", "conversion/deposited": "recording", "conversion/list-mine": "read",
    "delivery/cancel": "exit", "delivery/reclaim": "exit", "delivery/deposited": "recording", "delivery/list-mine": "read",
    "csp-report": "platform", "health": "platform", "health/alarms": "platform", "maintenance": "platform", "priority-fee": "platform",
    "internal/alarms": "platform", "internal/fx": "platform", "internal/retry": "platform", "internal/sanctions": "platform",
    "distribution-plans/proof": "read", "payout-snapshots/proof": "read",
    "inquiries/create": "support",
    "profiles/public": "read",
    "launchpad/commitment-aggregate": "read", "launchpad/terms": "read",
    // Purchase recovery: a buy that already landed on-chain ("Retry recording").
    "launchpad/record-purchase": "recording",
    "passport/status": "verification", "passport/submit": "verification",
    // Withdraw a listing or mark it matched.
    "resell/update": "exit",
    "sale-approvals/mine": "read",
    // Gone (Talas 5.1): answers every call with a refusal.
    "sale-approvals/settle": "platform",
    // Finishes an upload that storage/upload (gated for issuers) authorized.
    "storage/finalize": "recording",
    "tos/accept": "terms", "tos/status": "terms",
    "vesting-series/creation-state": "read", "vesting-series/list-mine": "read",
    "vesting-series/mark-cancelled": "exit",
    // Records steps whose on-chain entries the client gate refuses in the mode (KYC_ONLY_FLOWS).
    "vesting-series/mark-created": "recording", "vesting-series/record-step": "recording",
    "vesting/beneficiaries": "read",
  };
  const MIXED: Record<string, "gated" | "admin" | OpenReason> = {
    // Read: the issuer's own rows (an admin reads all).
    "issuer-profiles/read": "read", "profiles/read": "read", "otc/list": "read", "sale-requests/list": "read", "spvs/capacity": "read",
    // Purchase recovery: the sale's issuer records a buy that already landed.
    "launchpad/commitment-status": "recording",
    // The issuer withdraws its request, or records a sale its key opened (open_sale is refused before the wallet).
    "sale-requests/decide": "exit",
    // Every branch is an admin's: a read (admin) or a write (super admin).
    "admin-config/fx-rates": "admin",
    // A super admin for a cap override or a backdated issuance, an admin otherwise.
    "spvs/record-issuance": "admin",
    // The non-admin branch calls requireArea (the tests above pin each).
    "archive/set": "gated", "issuer-profiles/upsert": "gated", "profiles/upsert": "gated", "launchpad/listing-upsert": "gated",
    "storage/upload": "gated", "vesting/update-status": "gated", "vesting/publish-milestone": "gated",
  };

  /** Code without its comments (a gate named in a comment gates nothing). */
  const code = (route: string) =>
    readFileSync(join(process.cwd(), "app/api", route, "route.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  /** Every handler's signature is followed, at its own indentation, by an unconditional admin gate. */
  function topLevelAdminGate(src: string): boolean {
    const lines = src.split("\n");
    const signatures = lines.flatMap((line, i) => (/verifySigned\(/.test(line) && !/^\s*import\b/.test(line) ? [i] : []));
    const indent = (line: string) => /^\s*/.exec(line)![0].length;
    return signatures.length > 0 && signatures.every((i) => {
      if (/;\s*(?:const [^=]+=\s*)?await (?:requireAdmin|requireSuperAdmin|requireAdminOrKycProvider|requireKycProvider)\(/.test(lines[i])) return true;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (indent(lines[j]) < indent(lines[i])) return false;
        if (indent(lines[j]) === indent(lines[i]) && ADMIN_STATEMENT.test(lines[j])) return true;
      }
      return false;
    });
  }
  /** "gated", "mixed" or "open", from the code alone. */
  function kind(route: string): "gated" | "mixed" | "open" {
    const src = code(route);
    if (ADMIN_PROBE.test(src) || (ADMIN_GATE.test(src) && !topLevelAdminGate(src))) return "mixed";
    return GATE.test(src) ? "gated" : "open";
  }

  function routes(dir = join(process.cwd(), "app/api"), prefix = ""): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      // A "_" folder is private: Next.js does not route it (app/api/_exemplar).
      if (entry.isDirectory()) return entry.name.startsWith("_") ? [] : routes(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      return entry.name === "route.ts" && prefix ? [prefix] : [];
    });
  }

  it("each route is gated, mixed (with its non-admin branch named) or listed as open, never two of them", () => {
    const all = routes();
    expect(all.length).toBeGreaterThan(150);
    const wrong: string[] = [];
    for (const route of all) {
      const found = kind(route);
      const listed = route in MIXED ? "mixed" : route in OPEN ? "open" : "gated";
      if (route in MIXED && route in OPEN) wrong.push(`${route}: listed twice`);
      else if (found !== listed) wrong.push(`${route}: ${found}, listed as ${listed}`);
      else if (MIXED[route] === "gated" && !AREA_GATE.test(code(route))) wrong.push(`${route}: "gated" without requireArea/requireModule`);
    }
    expect(wrong, "gate a new route (requireArea/requireModule/admin) or list it (OPEN, or MIXED with its non-admin branch)").toEqual([]);
    for (const route of [...Object.keys(OPEN), ...Object.keys(MIXED)]) expect(all, route).toContain(route);
  });

  it("the classifier: an admin gate right after the signature gates; one on a branch, or an admin probe, is mixed", () => {
    const top = "  try {\n    const { wallet } = await verifySigned(request, \"x\");\n    await requireAdmin(wallet);\n  } catch {}";
    const branch = "  try {\n    const { wallet, params } = await verifySigned(request, \"x\");\n    if (params.all) {\n      await requireAdmin(wallet);\n    }\n  } catch {}";
    expect(topLevelAdminGate(top)).toBe(true);
    expect(topLevelAdminGate(branch)).toBe(false);
    expect(topLevelAdminGate("    const { wallet } = await verifySigned(r, \"x\"); await requireAdmin(wallet);")).toBe(true);
    expect(ADMIN_PROBE.test("if (!(await isAdminWallet(wallet))) requireArea(\"issuance\");")).toBe(true);
  });
});
