// The admin-API gaps the simulator's code review found (report "Known
// admin-API gaps", G1–G6), each closed in its route:
//   G1 passport.update approved   → only for a live KycEntry at finalized
//   G2 otc.adminUpdate created     → the Open on-chain deal of this request,
//                                     at finalized; a status machine with CAS
//   G3 clients.kybDecision verified → documents first (as clients.status)
//   G4/G6 a document reject         → asks the client for a replacement:
//                                     email, note, pending → more_info
// (G5 is in tests/verification-submit-purpose.test.ts; G7, the unsigned
// /api/audit, is by design and already upgraded by a wallet session.)
// The routes run for real on an in-memory Supabase; SIWS, the admin gates,
// the finality check and the RPC are mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddressDecoder } from "@solana/kit";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  signer: "",
  params: {} as Record<string, unknown>,
  finality: vi.fn(async (): Promise<"none" | "finalized" | "not-finalized"> => "finalized"),
  accounts: new Map<string, { owner: string; data: Uint8Array }>(),
  rpcDown: false,
  emails: [] as Array<{ to: string; subject: string; html: string }>,
}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));

vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: h.signer, params: h.params, via: "signature" })),
}));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: vi.fn(async () => {}), requireSuperAdmin: vi.fn(async () => {}) }));
vi.mock("@/lib/server/kyc-provider-gate", () => ({ requireAdminOrKycProvider: vi.fn(async () => "admin") }));
vi.mock("@/lib/server/passport-state", () => ({ passportFinality: h.finality }));
vi.mock("@/lib/server/email", () => ({
  sendEmail: vi.fn(async (input: { to: string; subject: string; html: string }) => {
    h.emails.push(input);
    return { sent: true };
  }),
  escapeHtml: (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));
vi.mock("@/lib/server/rpc", () => ({
  getServerRpc: () => ({
    getAccountInfo: (addr: string, config?: { commitment?: string }) => ({
      send: async () => {
        if (h.rpcDown) throw new Error("rpc down");
        expect(config?.commitment).toBe("finalized");
        const hit = h.accounts.get(addr);
        return {
          context: { slot: BigInt(1) },
          value: hit
            ? { data: [Buffer.from(hit.data).toString("base64"), "base64"], executable: false, lamports: BigInt(1), owner: hit.owner, rentEpoch: BigInt(0), space: BigInt(hit.data.length) }
            : null,
        };
      },
    }),
  }),
}));

import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findDealPda,
  getOtcDealEncoder,
  OtcDealStatus,
} from "@/lib/generated/asset_registry";
import { USDC } from "@/lib/payment-mints";
import { POST as passportUpdate } from "@/app/api/passport/update/route";
import { POST as otcAdminUpdate } from "@/app/api/otc/admin-update/route";
import { POST as kybDecision } from "@/app/api/clients/kyb-decision/route";
import { POST as reviewRequirement } from "@/app/api/clients/review-requirement/route";

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const ADMIN = key(1);
const SHARE_CLASS = key(2);
const BUYER = key(3);
const SELLER = key(4);
const MINT = key(5);
const PAY_MINT = key(6);
const CLIENT_ID = "10000000-0000-4000-8000-000000000001";
const PASSPORT_REQUEST = "20000000-0000-4000-8000-000000000002";

async function call(route: (r: Request) => Promise<Response>, params: Record<string, unknown>) {
  h.params = params;
  const res = await route(new Request("https://manci.test/api/x", { method: "POST", body: "{}" }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; data?: Record<string, unknown> } };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  db.ref = memorySupabase();
  h.signer = ADMIN;
  h.finality.mockReset().mockResolvedValue("finalized");
  h.accounts.clear();
  h.rpcDown = false;
  h.emails.length = 0;
});

describe("G1: passport.update approved only for a finalized on-chain passport", () => {
  beforeEach(() => {
    db.ref!.rows("passport_requests").push({ id: PASSPORT_REQUEST, wallet: BUYER, status: "in_review" });
  });
  const approve = () => call(passportUpdate, { id: PASSPORT_REQUEST, patch: { status: "approved", handled_by: "x" } });

  it("approves once the passport is finalized", async () => {
    const res = await approve();
    expect(res.status).toBe(200);
    expect(h.finality).toHaveBeenCalledWith(BUYER);
    expect(db.ref!.rows("passport_requests")[0]).toMatchObject({ status: "approved", handled_by: ADMIN });
  });

  it("refuses (409, nothing written) when no passport exists, or it is not finalized yet", async () => {
    for (const finality of ["none", "not-finalized"] as const) {
      h.finality.mockResolvedValueOnce(finality);
      const res = await approve();
      expect(res.status, finality).toBe(409);
      expect(res.body.error).toMatch(finality === "none" ? /no live on-chain passport/ : /not finalized yet/);
      expect(db.ref!.rows("passport_requests")[0].status).toBe("in_review");
    }
  });

  it("fails closed (503) when the chain cannot be read", async () => {
    h.finality.mockRejectedValueOnce(new Error("rpc down"));
    const res = await approve();
    expect(res.status).toBe(503);
    expect(db.ref!.rows("passport_requests")[0].status).toBe("in_review");
  });

  it("triage and rejection do not consult the chain", async () => {
    expect((await call(passportUpdate, { id: PASSPORT_REQUEST, patch: { status: "rejected" } })).status).toBe(200);
    expect(h.finality).not.toHaveBeenCalled();
  });
});

describe("G2: otc.adminUpdate created only for this request's Open deal at finalized", () => {
  const REQUEST_ID = "30000000-0000-4000-8000-000000000003";
  const DEAL_ID = BigInt(1_790_000_000_000);
  let dealPda = "";
  const encode = (overrides: Partial<Record<string, unknown>> = {}) =>
    new Uint8Array(
      getOtcDealEncoder().encode({
        admin: ADMIN, buyer: BUYER, seller: SELLER, shareClass: SHARE_CLASS, mint: MINT, paymentMint: PAY_MINT,
        assetEscrow: key(7), paymentEscrow: key(8), amount: BigInt(10), price: BigInt(25_000_000),
        assetDeposited: false, paymentDeposited: false, status: OtcDealStatus.Open, dealId: DEAL_ID,
        expiresAt: BigInt(1_800_000_000), version: 1, bump: 255, assetDepositedAmount: BigInt(0), paymentDepositedAmount: BigInt(0),
        ...overrides,
      } as Parameters<ReturnType<typeof getOtcDealEncoder>["encode"]>[0]),
    );
  const request = () => db.ref!.rows("otc_requests")[0];
  const flip = (extra: Record<string, unknown> = {}) =>
    call(otcAdminUpdate, { id: REQUEST_ID, status: "created", deal_pda: dealPda, deal_id: Number(DEAL_ID), decide: true, ...extra });

  beforeEach(async () => {
    [dealPda] = await findDealPda({ shareClass: SHARE_CLASS, dealId: DEAL_ID });
    h.accounts.set(dealPda, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: encode() });
    db.ref!.rows("otc_requests").push({
      id: REQUEST_ID, status: "requested", share_class_pda: SHARE_CLASS, mint: MINT, asset_label: "Fixture A",
      seller_wallet: SELLER, buyer_wallet: BUYER, amount: 10, price: 25_000_000, payment_mint: PAY_MINT, deal_pda: null,
    });
  });

  it("records the deal from the chain and notifies both parties", async () => {
    const res = await flip();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ notified: true });
    expect(request()).toMatchObject({
      status: "created",
      deal_pda: dealPda,
      deal_id: Number(DEAL_ID),
      expires_at: new Date(1_800_000_000_000).toISOString(),
      decided_by: ADMIN,
    });
    expect(db.ref!.rows("notifications")).toHaveLength(2);
  });

  it("tells the parties the price in the payment token's units, never raw base units", async () => {
    const usdc = USDC.devnet!.mint;
    request().payment_mint = usdc;
    request().asset_label = "Fixture <b>A</b>";
    db.ref!.rows("clients").push({ id: CLIENT_ID, network: "devnet", wallet: BUYER, email: "buyer@example.com" });
    h.accounts.set(dealPda, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: encode({ paymentMint: usdc }) });
    expect((await flip()).status).toBe(200);
    const body = String(db.ref!.rows("notifications")[0].body);
    expect(body).toContain("(10 units for 25 test USDC in total)");
    expect(body).not.toContain("25000000");
    expect(h.emails[0].html).toContain("Fixture &lt;b&gt;A&lt;/b&gt;");
  });

  it("a retried flip of the same deal is a no-op", async () => {
    expect((await flip()).status).toBe(200);
    const again = await flip();
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ notified: false });
    expect(db.ref!.rows("notifications")).toHaveLength(2);
  });

  it("refuses a deal the chain does not show at finalized yet (409), or cannot read (503)", async () => {
    h.accounts.clear();
    expect((await flip()).status).toBe(409);
    h.rpcDown = true;
    expect((await flip()).status).toBe(503);
    expect(request().status).toBe("requested");
    expect(db.ref!.rows("notifications")).toHaveLength(0);
  });

  it.each([
    ["buyer", { buyer: key(9) }],
    ["seller", { seller: key(9) }],
    ["amount", { amount: BigInt(11) }],
    ["price", { price: BigInt(25) }],
    ["payment mint", { paymentMint: key(9) }],
    ["mint", { mint: key(9) }],
  ])("refuses a deal whose %s is not the request's", async (label, overrides) => {
    h.accounts.set(dealPda, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: encode(overrides) });
    const res = await flip();
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(`(${label})`);
    expect(request().status).toBe("requested");
  });

  it("refuses a deal that is no longer Open, an account of another program, or another deal id", async () => {
    h.accounts.set(dealPda, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: encode({ status: OtcDealStatus.Cancelled }) });
    expect((await flip()).status).toBe(409);
    h.accounts.set(dealPda, { owner: key(9), data: encode() });
    expect((await flip()).status).toBe(400);
    h.accounts.set(dealPda, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: encode() });
    expect((await flip({ deal_id: 5 })).status).toBe(400);
    expect(request().status).toBe("requested");
  });

  it("a declined request is never flipped back, and deal coordinates are never set on their own", async () => {
    expect((await call(otcAdminUpdate, { id: REQUEST_ID, status: "cancelled", admin_note: "no", decide: true })).status).toBe(200);
    const back = await flip();
    expect(back.status).toBe(409);
    expect(request().status).toBe("cancelled");
    expect((await call(otcAdminUpdate, { id: REQUEST_ID, deal_pda: dealPda })).status).toBe(400);
  });

  it("pilot scope: with secondary trading off (mainnet default) no escrow is marked open; declining still works", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    const refused = await flip();
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/not available on Solana mainnet/);
    expect(request().status).toBe("requested");
    expect((await call(otcAdminUpdate, { id: REQUEST_ID, status: "cancelled", decide: true })).status).toBe(200);
  });

  it("the write is a compare-and-set: a decision landing in between wins", async () => {
    db.ref!.beforeUpdate = (table) => {
      if (table === "otc_requests") request().status = "cancelled";
    };
    const res = await flip();
    expect(res.status).toBe(409);
    expect(request().status).toBe("cancelled");
    expect(db.ref!.rows("notifications")).toHaveLength(0);
  });
});

describe("G3: clients.kybDecision verified needs every document approved first", () => {
  beforeEach(() => {
    db.ref!.rows("clients").push({ id: CLIENT_ID, network: "devnet", kyc_status: "pending", email: null, display_name: "Fixture d.o.o." });
    db.ref!.rows("client_verification_details").push({ client_id: CLIENT_ID, kind: "kyb", status: "pending" });
    db.ref!.rows("kyc_requirements").push({ id: 1, client_id: CLIENT_ID, label: "Registry extract", status: "submitted" });
  });

  it("refuses verified while a document is still open (409), then accepts it", async () => {
    const refused = await call(kybDecision, { client_id: CLIENT_ID, decision: "verified" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Registry extract (submitted)");
    expect(db.ref!.rows("client_verification_details")[0].status).toBe("pending");
    db.ref!.rows("kyc_requirements")[0].status = "approved";
    expect((await call(kybDecision, { client_id: CLIENT_ID, decision: "verified" })).status).toBe(200);
    expect(db.ref!.rows("client_verification_details")[0].status).toBe("verified");
  });

  it("a rejection needs no documents first", async () => {
    expect((await call(kybDecision, { client_id: CLIENT_ID, decision: "rejected" })).status).toBe(200);
  });
});

describe("G6 (and G4): a document reject asks the client for a replacement", () => {
  const client = () => db.ref!.rows("clients")[0];
  beforeEach(() => {
    db.ref!.rows("clients").push({ id: CLIENT_ID, network: "devnet", kyc_status: "pending", email: "ana@example.com", display_name: "Ana" });
    db.ref!.rows("kyc_requirements").push({ id: 7, client_id: CLIENT_ID, label: "Proof of address", doc_kind: "proof_of_address", status: "submitted" });
  });

  it("emails the client with the reason, notes it and moves a pending dossier to more_info", async () => {
    const res = await call(reviewRequirement, { id: 7, status: "rejected", reason: "The bill is older than 3 months." });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "rejected", recomputed: "more_info", notified: true });
    expect(db.ref!.rows("kyc_requirements")[0].status).toBe("rejected");
    expect(client().kyc_status).toBe("more_info");
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0].to).toBe("ana@example.com");
    expect(h.emails[0].html).toContain("Proof of address");
    expect(h.emails[0].html).toContain("The bill is older than 3 months.");
    expect(h.emails[0].html).toContain("/verify");
    expect(db.ref!.rows("client_notes").map((n) => n.body)).toEqual([
      'Document "Proof of address" rejected: The bill is older than 3 months. — the client was asked for a replacement.',
    ]);
  });

  it("a more_info dossier stays more_info and is still emailed", async () => {
    client().kyc_status = "more_info";
    const res = await call(reviewRequirement, { id: 7, status: "rejected" });
    expect(res.body.data).toMatchObject({ recomputed: null, notified: true });
    expect(client().kyc_status).toBe("more_info");
  });

  it("never touches a verified or terminal dossier, and emails nobody there", async () => {
    for (const status of ["verified", "suspended", "rejected"]) {
      client().kyc_status = status;
      h.emails.length = 0;
      const res = await call(reviewRequirement, { id: 7, status: "rejected" });
      expect(res.status, status).toBe(200);
      expect(client().kyc_status, status).toBe(status);
      expect(h.emails, status).toHaveLength(0);
    }
  });

  it("a KYC-verified dossier with a pending KYB is emailed for a refused company document, and stays verified", async () => {
    client().kyc_status = "verified";
    db.ref!.rows("client_verification_details").push({ client_id: CLIENT_ID, kind: "kyb", status: "pending" });
    db.ref!.rows("kyc_requirements")[0].label = "Certificate of incorporation / registry extract";
    const res = await call(reviewRequirement, { id: 7, status: "rejected", reason: "Older than 3 months." });
    expect(res.body.data).toMatchObject({ recomputed: null, notified: true, not_notified: null });
    expect(client().kyc_status).toBe("verified");
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0].html).toContain("Certificate of incorporation / registry extract");
    // A decided KYB is not a review in progress any more.
    db.ref!.rows("client_verification_details")[0].status = "verified";
    h.emails.length = 0;
    const decided = await call(reviewRequirement, { id: 7, status: "rejected" });
    expect(decided.body.data).toMatchObject({ notified: false, not_notified: "no_review_in_progress" });
    expect(h.emails).toHaveLength(0);
  });

  it("the timeline note and the answer say whether the client was really asked", async () => {
    client().kyc_status = "verified";
    const decided = await call(reviewRequirement, { id: 7, status: "rejected" });
    expect(decided.body.data).toMatchObject({ notified: false, not_notified: "no_review_in_progress" });
    client().kyc_status = "pending";
    client().email = null;
    const noAddress = await call(reviewRequirement, { id: 7, status: "rejected" });
    expect(noAddress.body.data).toMatchObject({ notified: false, not_notified: "no_email_on_file" });
    expect(db.ref!.rows("client_notes").map((n) => n.body)).toEqual([
      'Document "Proof of address" rejected — no review is in progress, so the client was not emailed.',
      'Document "Proof of address" rejected — no email address is on file, so the client was not asked; contact them.',
    ]);
  });

  it("an approval sends nothing, and a reason longer than 2000 characters is refused", async () => {
    expect((await call(reviewRequirement, { id: 7, status: "approved" })).status).toBe(200);
    expect(h.emails).toHaveLength(0);
    expect((await call(reviewRequirement, { id: 7, status: "rejected", reason: "x".repeat(2001) })).status).toBe(400);
  });
});
