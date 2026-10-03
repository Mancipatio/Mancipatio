// /api/archive/{list,check,set} (lib/archive.ts, lib/server/archive-actions):
// who may archive what, the blockers and the super admin's explicit override,
// the stored record and its restore, the audit event per change (and the undo
// when it cannot be written), and the issuer archive before / after
// migration 0081. Chain reads, SIWS, the admin gate and the audit are
// mocked; Supabase is in memory.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";
import type { AssetArchiveChain } from "@/lib/server/archive";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));

const ASSET = "7Vr6Yqmgkqf6TDgChpwHA4LpoenE4PeAH6MPNvThDYYP";
const ASSET2 = "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr";
const ISSUER = "B4tYFfqtw1Ya3Pv6vQAy7ZjXbbCtEsNksr4kZt963DBw";
const ISSUER_KEY = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP";
const SUPER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const ADMIN = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const STRANGER = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC";
const SC0 = "Pc4auCy8Fnwxs7EcFwBGKqV3SudxCKEEDLHbEHujBpK";
const SC1 = "6D6TgUKrYY6dJrCUZ6LcJKt5EGGdCUgHtVeUKmRZbUJ2";

const state = vi.hoisted(() => ({
  wallet: "",
  action: "",
  params: {} as Record<string, unknown>,
  superAdmins: new Set<string>(),
  admins: new Set<string>(),
  chain: null as unknown as AssetArchiveChain,
  issuerAssets: [] as { assetPda: string; name: string; circulating: bigint }[],
  audits: [] as Record<string, unknown>[],
  auditFails: false,
}));

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "mainnet",
}));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async (_req: Request, action: string) => {
    state.action = action;
    return { wallet: state.wallet, params: state.params, via: "signature" };
  }),
}));
vi.mock("@/lib/server/admin-gate", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    requireAdmin: vi.fn(async (wallet: string) => {
      if (!state.admins.has(wallet) && !state.superAdmins.has(wallet)) throw new SiwsError(403, "Admin privileges required");
    }),
    requireSuperAdmin: vi.fn(async (wallet: string) => {
      if (!state.superAdmins.has(wallet)) throw new SiwsError(403, "Super admin privileges required");
    }),
  };
});
vi.mock("@/lib/server/profile-read", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    isProfileAdmin: vi.fn(async (wallet: string) => state.admins.has(wallet) || state.superAdmins.has(wallet)),
    requireProfileOwner: vi.fn(async (wallet: string) => {
      if (wallet !== ISSUER_KEY) throw new SiwsError(403, "Profile access denied");
    }),
  };
});
vi.mock("@/lib/server/archive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/archive")>()),
  readAssetArchiveFacts: vi.fn(async (pda: string) => ({ ...state.chain, assetId: pda === ASSET ? "MANCI-5PCT" : "OTHER" })),
  readIssuerAssets: vi.fn(async () => state.issuerAssets),
  requireIssuerAccount: vi.fn(async () => ({ authority: ISSUER_KEY })),
}));
vi.mock("@/lib/server/audit", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    actorSourceOf: () => "siws-signature",
    writeServerAudit: vi.fn(async (_sb: unknown, input: Record<string, unknown>) => {
      if (state.auditFails) throw new SiwsError(503, "Audit log unavailable — nothing was released; try again");
      state.audits.push(input);
      return "audit-1";
    }),
  };
});

// The sale-request route (an archived asset is not offered, nor published, again).
vi.mock("@/app/api/sale-approvals/_lib", () => ({
  shareClassChain: vi.fn(async (shareClass: string) => ({
    shareClass, asset: ASSET, issuer: ISSUER, authority: ISSUER_KEY, issuerVerified: true,
  })),
  assertAllowedPaymentMint: vi.fn(),
}));
vi.mock("@/lib/server/document-versions", () => ({
  requireDocumentVersion: vi.fn(async (_bucket: string, path: string, sha256: string) => ({
    id: "10000000-0000-4000-8000-000000000001", path, sha256, verified_at: "2026-10-03T00:00:00Z",
  })),
}));
vi.mock("@/lib/server/sale-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/sale-requests")>()),
  readSaleRoom: vi.fn(async () => ({
    room: BigInt(4_000), legalDocHash: new Uint8Array(32), assetActive: true, mintInitialized: true, openSales: 0, liveApprovals: 0,
  })),
}));

import { POST as setRoute } from "@/app/api/archive/set/route";
import { POST as submitSaleRequest } from "@/app/api/sale-requests/submit/route";
import { requireNotArchived } from "@/lib/server/archive";
import { POST as checkRoute } from "@/app/api/archive/check/route";
import { GET as listRoute } from "@/app/api/archive/list/route";
import { POST as publicProfiles } from "@/app/api/profiles/public/route";
import { SESSION_READ_ACTIONS } from "@/lib/siws-session";

const REASON = "Test asset made with a test legal PDF";
const B = (n: number) => BigInt(n);
const testToken = (over: Partial<AssetArchiveChain> = {}): AssetArchiveChain => ({
  issuer: ISSUER,
  name: "Mancipatio 5%",
  assetId: "MANCI-5PCT",
  draft: false,
  classes: [
    { address: SC0, classIndex: 0, circulating: B(0), lifetimeMinted: B(0), supplyLocked: false },
    { address: SC1, classIndex: 1, circulating: B(0), lifetimeMinted: B(0), supplyLocked: false },
  ],
  openSales: 0,
  liveApprovals: 0,
  ...over,
});

async function call(route: (r: Request) => Promise<Response>, wallet: string, params: Record<string, unknown>) {
  state.wallet = wallet;
  state.params = params;
  const res = await route(new Request("https://www.manci.io/api/archive", { method: "POST", body: "{}" }));
  return { status: res.status, body: await res.json() };
}
const archive = (wallet: string, extra: Record<string, unknown> = {}) =>
  call(setRoute, wallet, { kind: "asset", pda: ASSET, archive: true, reason: REASON, ...extra });
const unarchive = (wallet: string, extra: Record<string, unknown> = {}) =>
  call(setRoute, wallet, { kind: "asset", pda: ASSET, archive: false, reason: "Shown again for the pilot", ...extra });
const profile = () => db.ref!.rows("asset_profiles").find((r) => r.asset_pda === ASSET);

beforeEach(() => {
  db.ref = memorySupabase();
  state.superAdmins = new Set([SUPER]);
  state.admins = new Set([ADMIN]);
  state.chain = testToken();
  state.issuerAssets = [];
  state.audits = [];
  state.auditFails = false;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
});

describe("archive an asset", () => {
  it("the super admin archives the mainnet test token: hidden, the profile's status kept for unarchive, audited", async () => {
    db.ref!.rows("asset_profiles").push({
      network: "mainnet", asset_pda: ASSET, issuer_pda: ISSUER, category: "equity", status: "published", is_published: true,
      fields: { tokenize: { tokens: "5000" } },
    });
    const res = await archive(SUPER);
    expect(res.status).toBe(200);
    expect(state.action).toBe("archive.set");
    expect(profile()).toMatchObject({ status: "archived", is_published: false });
    expect(profile()!.fields).toMatchObject({
      tokenize: { tokens: "5000" },
      archive: { reason: REASON, archived_by: SUPER, previous_status: "published", previous_is_published: true, row_created: false },
    });
    expect(state.audits).toEqual([expect.objectContaining({
      ix_name: "asset_archive", category: "assets", actor_wallet: SUPER, reason: REASON, target_label: ASSET,
      metadata: expect.objectContaining({ network: "mainnet", asset_id: "MANCI-5PCT", overridden: [], actor: "super" }),
    })]);

    const list = await listRoute();
    expect((await list.json()).data).toMatchObject({ assets: [ASSET], issuers: [], issuerArchiveAvailable: true });

    // Unarchive restores what it was, without the record.
    expect((await unarchive(SUPER)).status).toBe(200);
    expect(profile()).toMatchObject({ status: "published", is_published: true, fields: { tokenize: { tokens: "5000" } } });
    expect(profile()!.fields).not.toHaveProperty("archive");
    expect(state.audits.map((a) => a.ix_name)).toEqual(["asset_archive", "asset_unarchive"]);
  });

  it("an asset without a profile row gets one for the archive, removed again by unarchive", async () => {
    expect((await archive(SUPER)).status).toBe(200);
    expect(profile()).toMatchObject({ category: "other", status: "archived", is_published: false, issuer_pda: ISSUER, display_name: "Mancipatio 5%" });
    expect((await unarchive(SUPER)).status).toBe(200);
    expect(profile()).toBeUndefined();
  });

  it("an Open sale, a live approval or circulating supply: refused with the reason, archived only on the super admin's explicit confirm", async () => {
    state.chain = testToken({ openSales: 1, liveApprovals: 1, classes: [{ address: SC0, classIndex: 0, circulating: B(30), lifetimeMinted: B(30), supplyLocked: false }] });
    const refused = await archive(SUPER);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Confirm explicitly to archive anyway — 1 sale is still Open on chain.*sale approval is still live.*30 token units are in circulation/);
    expect(profile()).toBeUndefined();
    expect(state.audits).toEqual([]);

    expect((await archive(SUPER, { confirm: true })).status).toBe(200);
    expect(profile()!.fields).toMatchObject({ archive: { overridden: ["open_sale", "live_approval", "circulating"] } });
    expect(state.audits[0].metadata).toMatchObject({ overridden: ["open_sale", "live_approval", "circulating"] });
  });

  it("the issuer authority: its own Draft / never-minted asset yes, a minted one or one with a live approval no (confirm does not help)", async () => {
    state.chain = testToken({ draft: true });
    expect((await archive(ISSUER_KEY)).status).toBe(200);
    expect(state.audits[0].metadata).toMatchObject({ actor: "issuer" });
    // Its own archive it may undo.
    expect((await unarchive(ISSUER_KEY)).status).toBe(200);

    state.chain = testToken({ classes: [{ address: SC0, classIndex: 0, circulating: B(0), lifetimeMinted: B(10), supplyLocked: false }] });
    const minted = await archive(ISSUER_KEY, { confirm: true });
    expect(minted.status).toBe(403);
    expect(minted.body.error).toMatch(/Tokens of this asset were created: only the platform's super admin/);

    state.chain = testToken({ liveApprovals: 1 });
    expect((await archive(ISSUER_KEY, { confirm: true })).status).toBe(403);
  });

  it("the issuer cannot unarchive what the platform archived; other admins and strangers cannot act", async () => {
    expect((await archive(SUPER)).status).toBe(200);
    const res = await unarchive(ISSUER_KEY);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/platform archived this asset/);
    expect((await unarchive(ADMIN)).status).toBe(403);
    expect((await call(setRoute, STRANGER, { kind: "asset", pda: ASSET2, archive: true, reason: REASON })).status).toBe(403);
    expect(profile()).toMatchObject({ status: "archived" });
  });

  it("a reason is required; twice archived or unarchiving a live asset is a 409", async () => {
    expect((await archive(SUPER, { reason: "short" })).status).toBe(400);
    expect((await call(setRoute, SUPER, { kind: "asset", pda: ASSET, reason: REASON })).status).toBe(400);
    expect((await call(setRoute, SUPER, { kind: "thing", pda: ASSET, archive: true, reason: REASON })).status).toBe(400);
    expect((await unarchive(SUPER)).status).toBe(409);
    expect((await archive(SUPER)).status).toBe(200);
    expect((await archive(SUPER)).status).toBe(409);
  });

  it("no archive without its audit trail: the write is undone and the route says so", async () => {
    db.ref!.rows("asset_profiles").push({ network: "mainnet", asset_pda: ASSET, category: "equity", status: "draft", is_published: false, fields: {} });
    state.auditFails = true;
    const res = await archive(SUPER);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/nothing was changed/);
    expect(profile()).toMatchObject({ status: "draft", is_published: false, fields: {} });
    // A created row is removed again.
    db.ref!.tables.asset_profiles = [];
    expect((await archive(SUPER)).status).toBe(503);
    expect(profile()).toBeUndefined();
  });
});

describe("check (the dialog's fresh read)", () => {
  it("is a session read that reports blockers, the lockable classes and who may act", async () => {
    expect(SESSION_READ_ACTIONS.has("archive.check")).toBe(true);
    expect(SESSION_READ_ACTIONS.has("archive.set")).toBe(false);
    state.chain = testToken({ classes: [
      { address: SC0, classIndex: 0, circulating: B(0), lifetimeMinted: B(0), supplyLocked: false },
      { address: SC1, classIndex: 1, circulating: B(0), lifetimeMinted: B(0), supplyLocked: true },
    ] });
    const res = await call(checkRoute, SUPER, { kind: "asset", pda: ASSET });
    expect(res.status).toBe(200);
    expect(state.action).toBe("archive.check");
    expect(res.body.data).toMatchObject({
      actor: "super", archived: false, canArchive: true, blockers: [], name: "Mancipatio 5%",
      lockableAtZero: [{ address: SC0, classIndex: 0, circulating: "0" }],
    });
    const admin = await call(checkRoute, ADMIN, { kind: "asset", pda: ASSET });
    expect(admin.body.data).toMatchObject({ actor: "admin", canArchive: false });
    expect((await call(checkRoute, STRANGER, { kind: "asset", pda: ASSET })).status).toBe(403);
  });
});

describe("archive an issuer (migration 0081)", () => {
  const archiveIssuer = (wallet: string, archiveIt = true) =>
    call(setRoute, wallet, { kind: "issuer", pda: ISSUER, archive: archiveIt, reason: REASON });

  it("super admin only; refused while an asset of it that is not archived has tokens in circulation", async () => {
    expect((await archiveIssuer(ADMIN)).status).toBe(403);
    expect((await archiveIssuer(ISSUER_KEY)).status).toBe(403);
    state.issuerAssets = [{ assetPda: ASSET, name: "Mancipatio 5%", circulating: B(30) }, { assetPda: ASSET2, name: "Empty", circulating: B(0) }];
    const refused = await archiveIssuer(SUPER);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/1 asset of this issuer still has tokens in circulation.*Mancipatio 5%: 30.*Archive that asset first/);

    // Once that asset is archived, the issuer can be.
    db.ref!.rows("asset_profiles").push({ network: "mainnet", asset_pda: ASSET, category: "equity", status: "archived", is_published: false, fields: {} });
    expect((await archiveIssuer(SUPER)).status).toBe(200);
    expect(db.ref!.rows("issuer_profiles")[0]).toMatchObject({ issuer_pda: ISSUER, archive: { reason: REASON, archived_by: SUPER, row_created: true } });
    expect(state.audits.at(-1)).toMatchObject({ ix_name: "issuer_archive", category: "issuers", target_label: ISSUER });
    expect((await (await listRoute()).json()).data.issuers).toEqual([ISSUER]);

    expect((await archiveIssuer(SUPER, false)).status).toBe(200);
    expect(db.ref!.rows("issuer_profiles")[0]).toMatchObject({ issuer_pda: ISSUER, archive: null });
    expect((await (await listRoute()).json()).data.issuers).toEqual([]);
    expect(state.audits.at(-1)).toMatchObject({ ix_name: "issuer_unarchive" });
  });

  it("an archived issuer's published profiles leave the public read", async () => {
    db.ref!.rows("asset_profiles").push({ network: "mainnet", asset_pda: ASSET, issuer_pda: ISSUER, category: "equity", status: "published", is_published: true, fields: {} });
    const read = async () => (await (await publicProfiles(new Request("https://www.manci.io/api/profiles/public", { method: "POST", body: "{}" }))).json()).data;
    expect(await read()).toHaveLength(1);
    db.ref!.rows("issuer_profiles").push({ network: "mainnet", issuer_pda: ISSUER, archive: { reason: REASON, archived_by: SUPER, archived_at: "t" } });
    expect(await read()).toEqual([]);
  });

  it("before 0081: the list says unavailable (nothing hidden for issuers), the archive is a plain 503, assets still work", async () => {
    db.ref!.failReads.add("issuer_profiles");
    db.ref!.readErrorCodes.issuer_profiles = "42703";
    const list = (await (await listRoute()).json()).data;
    expect(list).toMatchObject({ issuers: [], issuerArchiveAvailable: false });
    const res = await archiveIssuer(SUPER);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/migration 0081/);
    const check = await call(checkRoute, SUPER, { kind: "issuer", pda: ISSUER });
    expect(check.body.data).toMatchObject({ available: false, canArchive: false, refusal: expect.stringMatching(/migration 0081/) });
    expect((await archive(SUPER)).status).toBe(200);
  });
});

describe("an archived asset is not offered again (no silent unarchive)", () => {
  const SHA = "ab".repeat(32);
  const terms = () => ({
    share_class: SC0, price_per_unit: "2500000", tokens: "1000", duration_days: 30,
    document: { path: `whitepapers/${ASSET}/mainnet/${SHA}/offer.pdf`, sha256: SHA },
  });
  const submit = () => call(submitSaleRequest, ISSUER_KEY, terms());
  const ISSUER_RECORD = { reason: REASON, archived_by: SUPER, archived_at: "2026-10-03T10:00:00.000Z" };

  beforeEach(() => {
    db.ref!.rows("asset_profiles").push({
      network: "mainnet", asset_pda: ASSET, issuer_pda: ISSUER, category: "equity", status: "published", is_published: true,
      fields: { tokenize: { tokens: "5000" } },
      whitepaper_path: null, whitepaper_sha256: null, whitepaper_status: "none", whitepaper_published_at: null,
    });
  });

  it("a sale request for an archived asset is refused: the row stays archived, no request, no audit, still in the archived list", async () => {
    expect((await archive(SUPER, { confirm: true })).status).toBe(200);
    const archived = structuredClone(profile());
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/This asset is archived: unarchive it first/);
    expect(profile()).toEqual(archived);
    expect(profile()!.fields).not.toHaveProperty("sale_request");
    expect(state.audits.map((a) => a.ix_name)).toEqual(["asset_archive"]);
    expect((await (await listRoute()).json()).data.assets).toEqual([ASSET]);

    // Taken back by the super admin (its own audit event): the request goes through.
    expect((await unarchive(SUPER)).status).toBe(200);
    expect((await submit()).status).toBe(200);
    expect(profile()).toMatchObject({ status: "published", is_published: true, fields: { sale_request: { status: "requested" } } });
    expect(state.audits.map((a) => a.ix_name)).toEqual(["asset_archive", "asset_unarchive", "sale_request_submit"]);
  });

  it("archived between the check and the write: the conditional write publishes nothing", async () => {
    db.ref!.beforeUpdate = (table) => {
      if (table !== "asset_profiles") return;
      Object.assign(profile()!, { status: "archived", is_published: false });
      db.ref!.beforeUpdate = null;
    };
    const res = await submit();
    expect(res.status).toBe(409);
    expect(profile()).toMatchObject({ status: "archived", is_published: false });
    expect(profile()!.fields).not.toHaveProperty("sale_request");
    expect(state.audits).toEqual([]);
  });

  it("an asset of an archived issuer is refused; before 0081 no issuer counts as archived", async () => {
    db.ref!.rows("issuer_profiles").push({ network: "mainnet", issuer_pda: ISSUER, archive: ISSUER_RECORD });
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/issuer is archived: unarchive the issuer first/);
    expect(profile()!.fields).not.toHaveProperty("sale_request");

    db.ref!.failReads.add("issuer_profiles");
    db.ref!.readErrorCodes.issuer_profiles = "42703";
    expect((await submit()).status).toBe(200);
  });

  it("requireNotArchived (sale approvals and treasury mints use it too): 409 archived, 503 unreadable, fine otherwise", async () => {
    const sb = db.ref!.client as never;
    await expect(requireNotArchived(sb, ASSET, ISSUER)).resolves.toBeUndefined();
    // An asset without a profile row is not archived.
    await expect(requireNotArchived(sb, ASSET2, ISSUER)).resolves.toBeUndefined();
    profile()!.status = "archived";
    await expect(requireNotArchived(sb, ASSET, ISSUER)).rejects.toMatchObject({ status: 409 });
    await expect(requireNotArchived(sb, ASSET2, ISSUER)).resolves.toBeUndefined();
    db.ref!.rows("issuer_profiles").push({ network: "mainnet", issuer_pda: ISSUER, archive: ISSUER_RECORD });
    await expect(requireNotArchived(sb, ASSET2, ISSUER)).rejects.toMatchObject({ status: 409 });
    db.ref!.rows("issuer_profiles")[0].archive = null;
    await expect(requireNotArchived(sb, ASSET2, ISSUER)).resolves.toBeUndefined();
    // Fails closed: an unreadable row is a 503, never "not archived".
    db.ref!.failReads.add("asset_profiles");
    await expect(requireNotArchived(sb, ASSET2, ISSUER)).rejects.toMatchObject({ status: 503 });
    db.ref!.failReads.delete("asset_profiles");
    db.ref!.failReads.add("issuer_profiles");
    await expect(requireNotArchived(sb, ASSET2, ISSUER)).rejects.toMatchObject({ status: 503 });
  });
});
