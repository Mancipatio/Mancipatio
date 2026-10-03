// Public-sale requests (/api/sale-requests/*, lib/server/sale-requests): only
// the class's issuer authority asks, the terms are checked against the chain
// (duration, room, an open or approved sale), the request is stored in the
// private profile with the server's stamps and the buyer document published
// in the same call; one request waits at a time until its sale opens (the
// raise-cap ledger shows it); the operator lists what waits (with the
// offering clearance on mainnet) and declines with a reason; the issuer
// withdraws or marks it opened (the Sale read on chain). Chain reads, SIWS,
// the admin gate and the audit are mocked; Supabase is in memory.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));

const ASSET = "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr";
const ISSUER_PDA = "Pc4auCy8Fnwxs7EcFwBGKqV3SudxCKEEDLHbEHujBpK";
const SHARE_CLASS = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC";
const ISSUER = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP";
const ADMIN = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const OTHER = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const SALE = "6D6TgUKrYY6dJrCUZ6LcJKt5EGGdCUgHtVeUKmRZbUJ2";
const SHA = "ab".repeat(32);
const LEGAL = Uint8Array.from(Buffer.from(SHA, "hex"));
const PATH = `whitepapers/${ASSET}/devnet/${SHA}/offer.pdf`;
const VERSION = "10000000-0000-4000-8000-000000000001";

const state = vi.hoisted(() => ({
  wallet: "",
  action: "",
  params: {} as Record<string, unknown>,
  admins: new Set<string>(),
  chain: { authority: "", verified: true },
  room: {
    room: BigInt(4_000) as bigint | null,
    assetActive: true,
    mintInitialized: true,
    openSales: 0,
    liveApprovals: 0,
  },
  sale: null as null | { shareClass: string; authority: string },
  audits: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async (_req: Request, action: string) => {
    state.action = action;
    return { wallet: state.wallet, params: state.params, via: "signature" };
  }),
}));
vi.mock("@/lib/server/admin-gate", async () => {
  const { SiwsError } = await import("@/lib/server/siws");
  return {
    requireAdmin: vi.fn(async (wallet: string) => {
      if (!state.admins.has(wallet)) throw new SiwsError(403, "Admin privileges required");
    }),
  };
});
vi.mock("@/app/api/sale-approvals/_lib", () => ({
  shareClassChain: vi.fn(async (shareClass: string) => ({
    shareClass, asset: ASSET, issuer: ISSUER_PDA, authority: state.chain.authority, issuerVerified: state.chain.verified,
  })),
  assertAllowedPaymentMint: vi.fn(),
}));
vi.mock("@/lib/server/document-versions", async () => {
  const { SiwsError } = await import("@/lib/server/siws");
  return {
    requireDocumentVersion: vi.fn(async (_bucket: string, path: string, sha256: unknown) => {
      if (path !== PATH || sha256 !== SHA) throw new SiwsError(409, "Upload and verify an immutable document version before publishing");
      return { id: VERSION, path, sha256: SHA, verified_at: "2026-10-01T00:00:00Z" };
    }),
  };
});
vi.mock("@/lib/server/sale-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/sale-requests")>()),
  readSaleRoom: vi.fn(async () => ({ ...state.room, legalDocHash: LEGAL })),
}));
vi.mock("@/lib/server/audit", () => ({
  actorSourceOf: () => "siws-signature",
  writeServerAudit: vi.fn(async (_sb: unknown, input: Record<string, unknown>) => {
    state.audits.push(input);
    return "audit-1";
  }),
}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/generated/asset_registry")>()),
  fetchMaybeSale: vi.fn(async () => (state.sale ? { exists: true, data: state.sale } : { exists: false })),
}));

import { POST as submit } from "@/app/api/sale-requests/submit/route";
import { POST as list } from "@/app/api/sale-requests/list/route";
import { POST as decide } from "@/app/api/sale-requests/decide/route";
import { SESSION_READ_ACTIONS } from "@/lib/siws-session";
import type { SaleRequest } from "@/lib/public-sale";

type Body = { ok: boolean; data?: unknown; error?: string };
async function call(route: (r: Request) => Promise<Response>, wallet: string, params: Record<string, unknown>) {
  state.wallet = wallet;
  state.params = params;
  const res = await route(new Request("https://manci.test/api/sale-requests", { method: "POST", body: "{}" }));
  return { status: res.status, body: (await res.json()) as Body };
}
const terms = (over: Record<string, unknown> = {}) => ({
  share_class: SHARE_CLASS, price_per_unit: "2500000", tokens: "1000", duration_days: 30, document: { path: PATH, sha256: SHA }, ...over,
});
const profileRow = () => db.ref!.rows("asset_profiles").find((r) => r.asset_pda === ASSET)!;
const storedRequest = () => (profileRow().fields as { sale_request?: SaleRequest }).sale_request;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  db.ref = memorySupabase();
  db.ref.rows("asset_profiles").push({
    network: "devnet", asset_pda: ASSET, display_name: "Mancipatio 5 %", category: "equity",
    fields: { tokenize: { tokens: "5000" } }, is_published: false, status: "draft",
    whitepaper_path: null, whitepaper_sha256: null, whitepaper_status: "none", whitepaper_published_at: null,
  });
  state.admins = new Set([ADMIN]);
  state.chain = { authority: ISSUER, verified: true };
  state.room = { room: BigInt(4_000), assetActive: true, mintInitialized: true, openSales: 0, liveApprovals: 0 };
  state.sale = null;
  state.audits = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/sale-requests/submit", () => {
  it("stores the request with the server's stamps and publishes the buyer document in the same call", async () => {
    const res = await call(submit, ISSUER, terms());
    expect(res.status).toBe(200);
    expect(state.action).toBe("saleRequests.submit");
    const saved = storedRequest()!;
    expect(saved).toMatchObject({
      v: 1, share_class: SHARE_CLASS, price_per_unit: "2500000", tokens: "1000", duration_days: 30, status: "requested",
      payment_mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", requested_by: ISSUER,
      document: { path: PATH, sha256: SHA, version_id: VERSION, matches_legal_doc: true },
    });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    // The other fields are kept; the document and the profile are published.
    expect(profileRow()).toMatchObject({
      fields: { tokenize: { tokens: "5000" } }, whitepaper_path: PATH, whitepaper_version_id: VERSION, whitepaper_status: "published",
      is_published: true, status: "published",
    });
    expect(state.audits[0]).toMatchObject({ ix_name: "sale_request_submit", category: "launchpad", target_label: SHARE_CLASS });
    // Not a session read: every request is signed.
    expect(SESSION_READ_ACTIONS.has("saleRequests.submit")).toBe(false);
    expect(SESSION_READ_ACTIONS.has("saleRequests.list")).toBe(true);
  });

  it("only the class's issuer authority, for a verified issuer, may ask", async () => {
    expect((await call(submit, OTHER, terms())).status).toBe(403);
    expect((await call(submit, ADMIN, terms())).status).toBe(403);
    state.chain.verified = false;
    expect((await call(submit, ISSUER, terms())).status).toBe(409);
    expect(storedRequest()).toBeUndefined();
  });

  it("checks the terms: 30/90/365 days, a price and tokens above 0, never past the room", async () => {
    expect((await call(submit, ISSUER, terms({ duration_days: 60 }))).status).toBe(400);
    expect((await call(submit, ISSUER, terms({ price_per_unit: "0" }))).status).toBe(400);
    expect((await call(submit, ISSUER, terms({ tokens: "0" }))).status).toBe(400);
    const over = await call(submit, ISSUER, terms({ tokens: "4001" }));
    expect(over).toMatchObject({ status: 409, body: { error: expect.stringMatching(/Only 4,000 tokens can still be offered/) } });
    expect((await call(submit, ISSUER, terms({ tokens: "4000", duration_days: 365 }))).status).toBe(200);
  });

  it("refuses while a sale of the class is open or approved, before activation, and a document that is not a verified upload", async () => {
    state.room.openSales = 1;
    expect((await call(submit, ISSUER, terms())).body.error).toMatch(/sale of this class is open/);
    state.room = { ...state.room, openSales: 0, liveApprovals: 1 };
    expect((await call(submit, ISSUER, terms())).body.error).toMatch(/already approved/);
    state.room = { ...state.room, liveApprovals: 0, assetActive: false };
    expect((await call(submit, ISSUER, terms())).status).toBe(409);
    state.room.assetActive = true;
    expect((await call(submit, ISSUER, terms({ document: { path: `whitepapers/${OTHER}/x.pdf`, sha256: SHA } }))).status).toBe(400);
    expect((await call(submit, ISSUER, terms({ document: { path: `whitepapers/${ASSET}/other.pdf`, sha256: SHA } }))).status).toBe(409);
  });

  it("a separate offering document is accepted (matches_legal_doc false); an SSC-approved whitepaper is never replaced", async () => {
    const { readSaleRoom } = await import("@/lib/server/sale-requests");
    vi.mocked(readSaleRoom).mockResolvedValueOnce({ ...state.room, legalDocHash: new Uint8Array(32).fill(7) });
    expect((await call(submit, ISSUER, terms())).status).toBe(200);
    expect(storedRequest()?.document.matches_legal_doc).toBe(false);
    Object.assign(profileRow(), { whitepaper_status: "ssc_approved", whitepaper_path: `whitepapers/${ASSET}/approved.pdf`, fields: {} });
    expect((await call(submit, ISSUER, terms())).body.error).toMatch(/SSC-approved/);
  });

  it("one request waits at a time; a new one is possible once its sale opened (the ledger shows it consumed)", async () => {
    expect((await call(submit, ISSUER, terms())).status).toBe(200);
    const first = storedRequest()!;
    expect((await call(submit, ISSUER, terms())).body.error).toMatch(/already waiting/);
    // Approved (reserved) but not opened: still waiting.
    db.ref!.rows("sale_capacity_reservations").push({ network: "devnet", kind: "sale", share_class_pda: SHARE_CLASS, status: "reserved", release_reason: null, created_at: new Date(Date.parse(first.requested_at) + 1000).toISOString() });
    expect((await call(submit, ISSUER, terms())).status).toBe(409);
    // Opened: the request is history.
    db.ref!.rows("sale_capacity_reservations")[0].status = "consumed";
    expect((await call(submit, ISSUER, terms({ tokens: "500" }))).status).toBe(200);
    expect(storedRequest()).toMatchObject({ tokens: "500", status: "requested" });
    expect(storedRequest()!.id).not.toBe(first.id);
  });

  it("needs the profile first (the asset page's details)", async () => {
    db.ref!.tables.asset_profiles = [];
    expect((await call(submit, ISSUER, terms())).body.error).toMatch(/Save the token's details first/);
  });
});

describe("POST /api/sale-requests/list", () => {
  it("a class's request for its issuer or an Admin, no one else", async () => {
    await call(submit, ISSUER, terms());
    const own = await call(list, ISSUER, { share_class: SHARE_CLASS });
    expect(own.status).toBe(200);
    expect(own.body.data).toEqual([expect.objectContaining({ asset: ASSET, display_name: "Mancipatio 5 %", outcome: null, request: expect.objectContaining({ status: "requested" }) })]);
    expect((await call(list, ADMIN, { share_class: SHARE_CLASS })).status).toBe(200);
    expect((await call(list, OTHER, { share_class: SHARE_CLASS })).status).toBe(403);
  });

  it("the operator's list: what still waits (approved included, opened left out), Admin only, with the clearance", async () => {
    await call(submit, ISSUER, terms());
    const pending = await call(list, ADMIN, { pending: true });
    expect(pending.body.data).toEqual([expect.objectContaining({ asset: ASSET, outcome: null, clearance: { cleared: true, basis: "test_network" } })]);
    expect((await call(list, ISSUER, { pending: true })).status).toBe(403);
    const at = new Date(Date.parse(storedRequest()!.requested_at) + 1000).toISOString();
    db.ref!.rows("sale_capacity_reservations").push({ network: "devnet", kind: "sale", share_class_pda: SHARE_CLASS, status: "reserved", release_reason: null, created_at: at });
    expect((await call(list, ADMIN, { pending: true })).body.data).toEqual([expect.objectContaining({ outcome: "approved" })]);
    db.ref!.rows("sale_capacity_reservations")[0].status = "consumed";
    expect((await call(list, ADMIN, { pending: true })).body.data).toEqual([]);
  });

  it("each row names the reservation made for it (the pre-clear check's own approval); its sale on chain makes it opened at once", async () => {
    await call(submit, ISSUER, terms());
    const at = new Date(Date.parse(storedRequest()!.requested_at) + 1000).toISOString();
    const APPROVAL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    db.ref!.rows("sale_capacity_reservations").push({
      network: "devnet", kind: "sale", share_class_pda: SHARE_CLASS, status: "reserved", release_reason: null, created_at: at,
      approval_pda: APPROVAL, sale_pda: SALE, sale_id: 3,
    });
    const reservation = { approval_pda: APPROVAL, sale_pda: SALE, sale_id: "3" };
    expect((await call(list, ADMIN, { pending: true })).body.data).toEqual([expect.objectContaining({ outcome: "approved", reservation })]);
    expect((await call(list, ISSUER, { share_class: SHARE_CLASS })).body.data).toEqual([expect.objectContaining({ outcome: "approved", reservation })]);
    // A Sale of another class at that address is not this one.
    state.sale = { shareClass: OTHER, authority: ISSUER };
    expect((await call(list, ADMIN, { pending: true })).body.data).toEqual([expect.objectContaining({ outcome: "approved" })]);
    // open_sale ran (the Sale account exists) but the retry worker has not consumed the reservation yet: opened, off the
    // operator's list — "Approve sale" is never offered for it again.
    state.sale = { shareClass: SHARE_CLASS, authority: ISSUER };
    expect((await call(list, ADMIN, { pending: true })).body.data).toEqual([]);
    expect((await call(list, ISSUER, { share_class: SHARE_CLASS })).body.data).toEqual([expect.objectContaining({ outcome: "opened" })]);
    // A chain read that fails leaves it approved (the admin row then offers neither Approve nor Decline while the approval is gone).
    const { fetchMaybeSale } = await import("@/lib/generated/asset_registry");
    vi.mocked(fetchMaybeSale).mockRejectedValueOnce(new Error("rpc down"));
    expect((await call(list, ADMIN, { pending: true })).body.data).toEqual([expect.objectContaining({ outcome: "approved", reservation })]);
  });

  it("mainnet: an offering not cleared is said in the operator's list (the reserve refuses it)", async () => {
    await call(submit, ISSUER, terms());
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    profileRow().network = "mainnet";
    const pending = await call(list, ADMIN, { pending: true });
    expect(pending.body.data).toEqual([expect.objectContaining({ clearance: expect.objectContaining({ cleared: false }) })]);
    Object.assign(profileRow(), { offering_exemption_ref: "Opinion 12/2026", offering_exemption_reason: "Fewer than 20 investors" });
    expect((await call(list, ADMIN, { pending: true })).body.data).toEqual([
      expect.objectContaining({ clearance: { cleared: true, basis: "exemption", ref: "Opinion 12/2026" } }),
    ]);
  });
});

describe("POST /api/sale-requests/decide", () => {
  it("the issuer withdraws its own request; nobody else can", async () => {
    await call(submit, ISSUER, terms());
    const id = storedRequest()!.id;
    expect((await call(decide, OTHER, { share_class: SHARE_CLASS, request_id: id, action: "withdraw" })).status).toBe(403);
    expect((await call(decide, ISSUER, { share_class: SHARE_CLASS, request_id: "nope", action: "withdraw" })).status).toBe(404);
    expect((await call(decide, ISSUER, { share_class: SHARE_CLASS, request_id: id, action: "withdraw" })).status).toBe(200);
    expect(storedRequest()).toMatchObject({ status: "withdrawn", decided_by: ISSUER });
    // Decided once: not again.
    expect((await call(decide, ISSUER, { share_class: SHARE_CLASS, request_id: id, action: "withdraw" })).status).toBe(409);
    // A withdrawn request does not block a new one.
    expect((await call(submit, ISSUER, terms())).status).toBe(200);
  });

  it("an Admin declines with a reason the issuer sees", async () => {
    await call(submit, ISSUER, terms());
    const id = storedRequest()!.id;
    expect((await call(decide, ISSUER, { share_class: SHARE_CLASS, request_id: id, action: "decline", reason: "Not now please" })).status).toBe(403);
    expect((await call(decide, ADMIN, { share_class: SHARE_CLASS, request_id: id, action: "decline", reason: "no" })).status).toBe(400);
    expect((await call(decide, ADMIN, { share_class: SHARE_CLASS, request_id: id, action: "decline", reason: "Offering exemption pending" })).status).toBe(200);
    expect(storedRequest()).toMatchObject({ status: "declined", reason: "Offering exemption pending", decided_by: ADMIN });
    expect(state.audits.at(-1)).toMatchObject({ ix_name: "sale_request_decline" });
  });

  it("opened: only with the Sale of this class opened by the issuer's key, read on chain", async () => {
    await call(submit, ISSUER, terms());
    const id = storedRequest()!.id;
    expect((await call(decide, ISSUER, { share_class: SHARE_CLASS, request_id: id, action: "opened", sale: SALE })).status).toBe(409);
    state.sale = { shareClass: SHARE_CLASS, authority: OTHER };
    expect((await call(decide, ISSUER, { share_class: SHARE_CLASS, request_id: id, action: "opened", sale: SALE })).status).toBe(409);
    state.sale = { shareClass: SHARE_CLASS, authority: ISSUER };
    expect((await call(decide, ISSUER, { share_class: SHARE_CLASS, request_id: id, action: "opened", sale: SALE })).status).toBe(200);
    expect(storedRequest()).toMatchObject({ status: "opened", sale: SALE });
  });
});
