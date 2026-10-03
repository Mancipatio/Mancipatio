// POST /api/compliance/screen-recipients ("Send to wallets", S3): the sender
// screens its recipients before anything is signed. A hit blocks only that
// row (its alert raised, no list named); mainnet refuses the whole request
// while the list cannot answer (503); only the class's issuer authority or
// an Admin may ask (no sanctions oracle); a session read.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));
const signer = vi.hoisted(() => ({ wallet: "", params: {} as Record<string, unknown> }));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async (_req: Request, action: string) => {
    expect(action).toBe("compliance.screenRecipients");
    return { wallet: signer.wallet, params: signer.params, via: "session" };
  }),
}));
const chain = vi.hoisted(() => ({ authority: "", admins: new Set<string>() }));
vi.mock("@/app/api/sale-approvals/_lib", () => ({
  shareClassChain: vi.fn(async (shareClass: string) => ({ shareClass, asset: "A", issuer: "I", authority: chain.authority, issuerVerified: true })),
}));
vi.mock("@/lib/server/admin-gate", async () => {
  const { SiwsError } = await import("@/lib/server/siws");
  return {
    requireAdmin: vi.fn(async (wallet: string) => {
      if (!chain.admins.has(wallet)) throw new SiwsError(403, "Admin privileges required");
    }),
  };
});

import { OFAC_SDN_SOURCE } from "@/lib/ofac-sdn";
import { clearSanctionsCache, SCREENING_UNAVAILABLE } from "@/lib/server/sanctions";
import { POST } from "@/app/api/compliance/screen-recipients/route";
import { SESSION_READ_ACTIONS } from "@/lib/siws-session";

const LISTED = "6t3xLqAFPZoE4mzWzxabrKxK8cGoHxAmaCj3MigJpWh5";
const CLEAN = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const CLEAN2 = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const ISSUER = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP";
const SHARE_CLASS = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC";
const NOW = Date.parse("2026-10-03T12:00:00Z");

function loadList(refreshedAt = NOW - 3_600_000) {
  db.ref!.rows("sanctions_list_state").push({
    source: OFAC_SDN_SOURCE, published_on: "2026-10-01", address_count: 1,
    refreshed_at: new Date(refreshedAt).toISOString(), last_attempt_at: new Date(refreshedAt).toISOString(), last_status: "ok", last_error: null,
  });
  db.ref!.rows("sanctions_addresses").push({
    source: OFAC_SDN_SOURCE, address: LISTED, currency: "SOL", entry_uid: "1", entry_name: "Fixture", programs: ["CYBER2"],
  });
}

async function post(wallet: string, params: Record<string, unknown>, ip?: string) {
  signer.wallet = wallet;
  signer.params = params;
  const res = await POST(
    new Request("https://manci.test/api/compliance/screen-recipients", { method: "POST", body: "{}", headers: ip ? { "x-real-ip": ip } : {} }),
  );
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: { blocked: string[] }; error?: string } };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv("SANCTIONS_SCREENING", "");
  db.ref = memorySupabase();
  db.ref.rpcs.raise_sanctions_hit = (args) => {
    db.ref!.rows("compliance_alerts").push({ ...args });
    return { inserted: true };
  };
  clearSanctionsCache();
  chain.authority = ISSUER;
  chain.admins = new Set();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("POST /api/compliance/screen-recipients", () => {
  it("is a session read (no prompt per screen)", () => {
    expect(SESSION_READ_ACTIONS.has("compliance.screenRecipients")).toBe(true);
  });

  it("a hit blocks only its row, with its alert raised and no list named", async () => {
    loadList();
    const res = await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN, LISTED, CLEAN2, LISTED] });
    expect(res).toEqual({ status: 200, body: { ok: true, data: { blocked: [LISTED] } } });
    const alerts = db.ref!.rows("compliance_alerts");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ p_wallet: LISTED, p_network: "mainnet" });
    expect(alerts[0].p_evidence).toMatchObject({ route: "distribution (send to wallets)", role: "counterparty" });
    expect(JSON.stringify(res.body)).not.toMatch(/OFAC|Fixture|CYBER/);
  });

  it("answers clear for a clean list", async () => {
    loadList();
    expect((await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] })).body.data).toEqual({ blocked: [] });
  });

  it("mainnet fails closed (503) while the list is stale: nothing can be sent unscreened", async () => {
    loadList(NOW - 4 * 86_400_000);
    expect(await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] })).toEqual({
      status: 503,
      body: { ok: false, error: SCREENING_UNAVAILABLE },
    });
  });

  it("only the class's issuer authority or an Admin may ask (no sanctions oracle)", async () => {
    loadList();
    expect((await post(CLEAN2, { share_class: SHARE_CLASS, wallets: [CLEAN] })).status).toBe(403);
    chain.admins.add(CLEAN2);
    expect((await post(CLEAN2, { share_class: SHARE_CLASS, wallets: [CLEAN] })).status).toBe(200);
  });

  it("limits a flood: a burst per IP before the signature, then a limit per wallet shared by every instance (429)", async () => {
    loadList();
    // The burst: 30 per minute and IP on this instance, refused before any signature is read.
    for (let i = 0; i < 30; i++) expect((await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] }, "203.0.113.7")).status).toBe(200);
    const burst = await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] }, "203.0.113.7");
    expect(burst).toMatchObject({ status: 429, body: { ok: false } });
    // Another IP is not affected.
    expect((await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] }, "203.0.113.8")).status).toBe(200);
    // The shared limit per wallet (consume_account_rate_limit answers false once it is used up)…
    const keys: string[] = [];
    db.ref!.rpcs.consume_account_rate_limit = (args) => {
      keys.push(String(args.p_key_hash));
      return false;
    };
    expect(await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] }, "203.0.113.9")).toMatchObject({ status: 429 });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    // …and a limiter that cannot answer leaves the per-instance limit in charge (no refusal).
    db.ref!.rpcs.consume_account_rate_limit = () => {
      throw new Error("down");
    };
    expect((await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] }, "203.0.113.10")).status).toBe(200);
  });

  it("refuses a malformed request", async () => {
    loadList();
    expect((await post(ISSUER, { share_class: SHARE_CLASS, wallets: [] })).status).toBe(400);
    expect((await post(ISSUER, { share_class: SHARE_CLASS, wallets: ["not-a-wallet"] })).status).toBe(400);
    expect((await post(ISSUER, { share_class: SHARE_CLASS, wallets: Array.from({ length: 101 }, () => CLEAN) })).status).toBe(400);
    expect((await post(ISSUER, { share_class: "x", wallets: [CLEAN] })).status).toBe(400);
  });
});
