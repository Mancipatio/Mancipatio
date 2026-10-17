// /api/otc/admin-update, on the admin-api-gaps harness (an in-memory
// Supabase; SIWS, the admin gate, the mailer and the RPC are mocked):
//   - a decline (requested → cancelled) tells both parties once, generically
//     — an email when one is on file, always the in-app row — and never
//     carries the admin's reason; a repeat sends nothing (F058);
//   - cancelling a created request (the deal cancel) sends no decline notice;
//   - a request that already records a deal never gets a second one: the
//     flip with another deal_pda is refused with 409 and nothing is written,
//     whatever the row's status (F057);
//   - a decline that loses the compare-and-set sends nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddressDecoder } from "@solana/kit";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  signer: "",
  params: {} as Record<string, unknown>,
  accounts: new Map<string, { owner: string; data: Uint8Array }>(),
  emails: [] as Array<{ to: string; subject: string; html: string }>,
}));
const db = vi.hoisted(() => ({
  ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase>,
}));

vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: h.signer, params: h.params, via: "signature" })),
}));
vi.mock("@/lib/server/admin-gate", () => ({
  requireAdmin: vi.fn(async () => {}),
  requireSuperAdmin: vi.fn(async () => {}),
}));
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
        expect(config?.commitment).toBe("finalized");
        const hit = h.accounts.get(addr);
        return {
          context: { slot: BigInt(1) },
          value: hit
            ? {
                data: [Buffer.from(hit.data).toString("base64"), "base64"],
                executable: false,
                lamports: BigInt(1),
                owner: hit.owner,
                rentEpoch: BigInt(0),
                space: BigInt(hit.data.length),
              }
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
import { POST as otcAdminUpdate } from "@/app/api/otc/admin-update/route";

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const ADMIN = key(1);
const SHARE_CLASS = key(2);
const BUYER = key(3);
const SELLER = key(4);
const MINT = key(5);
const PAY_MINT = key(6);
const REQUEST_ID = "30000000-0000-4000-8000-000000000003";
const CLIENT_ID = "10000000-0000-4000-8000-000000000001";
const DEAL_ID = BigInt(1_790_000_000_000);
const OTHER_DEAL_ID = BigInt(1_790_000_000_001);

async function call(params: Record<string, unknown>) {
  h.params = params;
  const res = await otcAdminUpdate(
    new Request("https://manci.test/api/otc/admin-update", { method: "POST", body: "{}" }),
  );
  return {
    status: res.status,
    body: (await res.json()) as { ok: boolean; error?: string; data?: Record<string, unknown> },
  };
}

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
const notifications = () => db.ref!.rows("notifications");
const decline = (reason: string) =>
  call({ id: REQUEST_ID, status: "cancelled", admin_note: reason, decide: true });

describe("otc.adminUpdate: decline notices and one deal per request", () => {
  let dealPda = "";
  let otherPda = "";
  const flip = (extra: Record<string, unknown> = {}) =>
    call({ id: REQUEST_ID, status: "created", deal_pda: dealPda, deal_id: Number(DEAL_ID), decide: true, ...extra });

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    db.ref = memorySupabase();
    h.signer = ADMIN;
    h.accounts.clear();
    h.emails.length = 0;
    [dealPda] = await findDealPda({ shareClass: SHARE_CLASS, dealId: DEAL_ID });
    [otherPda] = await findDealPda({ shareClass: SHARE_CLASS, dealId: OTHER_DEAL_ID });
    // Two Open deals with exactly the request's terms are on-chain: the one
    // the request records, and a second one somebody else opened.
    h.accounts.set(dealPda, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: encode() });
    h.accounts.set(otherPda, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: encode({ dealId: OTHER_DEAL_ID }) });
    db.ref.rows("otc_requests").push({
      id: REQUEST_ID, status: "requested", share_class_pda: SHARE_CLASS, mint: MINT, asset_label: "Fixture A",
      seller_wallet: SELLER, buyer_wallet: BUYER, amount: 10, price: 25_000_000, payment_mint: PAY_MINT, deal_pda: null,
    });
  });

  it("a decline tells both parties once, generically, never with the admin's reason", async () => {
    db.ref!.rows("clients").push({ id: CLIENT_ID, network: "devnet", wallet: BUYER, email: "buyer@example.com" });
    const res = await decline("Seller is on a sanctions list");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ notified: true });
    expect(request()).toMatchObject({
      status: "cancelled",
      admin_note: "Seller is on a sanctions list",
      decided_by: ADMIN,
      deal_pda: null,
    });
    const rows = notifications();
    expect(rows.map((r) => r.audience_param).sort()).toEqual([SELLER, BUYER].sort());
    for (const row of rows) {
      expect(row.subject).toBe("Your OTC escrow request was declined");
      expect(String(row.body)).toContain("The platform declined the OTC escrow request for Fixture A (10 units for ");
      expect(String(row.body)).toContain("No escrow was opened and nothing was deposited.");
      expect(String(row.body)).not.toContain("sanctions");
      expect(row.author).toBe(ADMIN);
    }
    expect(rows.map((r) => r.kind).sort()).toEqual(["both", "in-app"]);
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]).toMatchObject({ to: "buyer@example.com", subject: "Your OTC escrow request was declined" });
    expect(h.emails[0].html).not.toContain("sanctions");
    expect(h.emails[0].html).toContain("/portfolio/deals");

    // A repeat is a no-op for the parties: nothing is sent twice.
    const again = await decline("Seller is on a sanctions list");
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ notified: false });
    expect(notifications()).toHaveLength(2);
    expect(h.emails).toHaveLength(1);
  });

  it("cancelling a created request (the deal cancel) sends no decline notice", async () => {
    expect((await flip()).body.data).toMatchObject({ notified: true });
    expect(notifications()).toHaveLength(2);
    const res = await decline("Deal cancelled by the platform");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ notified: false });
    expect(request()).toMatchObject({ status: "cancelled", deal_pda: dealPda });
    expect(notifications()).toHaveLength(2);
    for (const row of notifications()) expect(String(row.subject)).not.toMatch(/declined/);
  });

  it("a request that records a deal never gets a second one, whatever its status (409, nothing written)", async () => {
    expect((await flip()).status).toBe(200);
    const second = await flip({ deal_pda: otherPda, deal_id: Number(OTHER_DEAL_ID) });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already has an on-chain deal/);
    expect(request()).toMatchObject({ status: "created", deal_pda: dealPda, deal_id: Number(DEAL_ID) });
    expect(notifications()).toHaveLength(2);

    // The same guard before the status machine: a waiting row that somehow
    // carries a deal keeps it; only that deal's own flip goes through.
    request().status = "requested";
    const replaced = await flip({ deal_pda: otherPda, deal_id: Number(OTHER_DEAL_ID) });
    expect(replaced.status).toBe(409);
    expect(replaced.body.error).toMatch(/already has an on-chain deal/);
    expect(request()).toMatchObject({ status: "requested", deal_pda: dealPda });
    expect((await flip()).status).toBe(200);
    expect(request()).toMatchObject({ status: "created", deal_pda: dealPda });
  });

  it("a decline that loses the compare-and-set sends nothing", async () => {
    db.ref!.beforeUpdate = (table) => {
      if (table === "otc_requests") request().status = "created";
    };
    const res = await decline("too late");
    expect(res.status).toBe(409);
    expect(notifications()).toHaveLength(0);
    expect(h.emails).toHaveLength(0);
  });
});
