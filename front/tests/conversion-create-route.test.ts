// POST /api/conversion/create on mainnet: besides the module switch, the KYC
// gate and the on-chain checks (tests/kyc-at-conversion-routes.test.ts), the
// holder's wallet is screened against the sanctions lists and must have
// accepted the Terms in force, as on /api/otc/create. A verified dossier does
// not replace the screen (a wallet can be listed after its dossier was
// verified). The screen runs once the request itself is valid and before any
// chain read; the Terms are checked last, right before the write.
//
// The route runs for real against an in-memory database with the REAL
// lib/server/kyc-gate.ts, lib/server/sanctions.ts and lib/server/tos-gate.ts;
// the signature check and the chain reads are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));
const signer = vi.hoisted(() => ({ wallet: "", params: {} as Record<string, unknown> }));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: signer.wallet, params: signer.params })),
}));
const chain = vi.hoisted(() => ({
  getToken2022Balance: vi.fn(async () => BigInt(1_000)),
  verifyShareClassMint: vi.fn(async () => {}),
  resolveShareClassAssetFacts: vi.fn(async () => ({
    assetPda: "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr",
    assetLabel: "Test asset · #0 · 1",
    convertibleTo: "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx",
    assetTypeDeliverable: false,
  })),
}));
vi.mock("@/lib/server/token-holdings", () => chain);

import { moduleDisabledMessage, PILOT_MODULE_ENV } from "@/lib/features";
import { OFAC_SDN_SOURCE } from "@/lib/ofac-sdn";
import { clearSanctionsCache, SCREENING_SELF_HIT } from "@/lib/server/sanctions";
import { TOS_VERSION } from "@/lib/tos-version";
import { POST as conversionCreate } from "@/app/api/conversion/create/route";

const LISTED = "6t3xLqAFPZoE4mzWzxabrKxK8cGoHxAmaCj3MigJpWh5";
const CLEAN = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const SHARE_CLASS = "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr";
const MINT = "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const FUTURE = "2027-10-10T00:00:00.000Z";

const params = () => ({ share_class_pda: SHARE_CLASS, mint: MINT, amount: 10, contact: "holder@example.com" });

/** The sanctions list as a fresh refresh leaves it. */
function loadList(refreshedAt: number = NOW - 3_600_000, addresses: string[] = [LISTED]) {
  db.ref!.rows("sanctions_list_state").push({
    source: OFAC_SDN_SOURCE, published_on: "2026-10-09", address_count: addresses.length,
    refreshed_at: new Date(refreshedAt).toISOString(), last_attempt_at: new Date(refreshedAt).toISOString(),
    last_status: "ok", last_error: null,
  });
  for (const address of addresses) {
    db.ref!.rows("sanctions_addresses").push({
      source: OFAC_SDN_SOURCE, address, currency: "SOL", entry_uid: "90001", entry_name: "Fixture PERSON ONE", programs: ["CYBER2"],
    });
  }
}

/** A live verified dossier for `wallet` on `network` (what the KYC gate requires). */
function verified(wallet: string, network = "mainnet") {
  db.ref!.rows("clients").push({
    id: `client-${wallet.slice(0, 4)}`, wallet, network, kyc_status: "verified", kyc_expires_at: FUTURE,
    created_at: "2026-09-01T00:00:00.000Z",
  });
}

function accepted(wallet: string, version: string = TOS_VERSION) {
  db.ref!.rows("tos_acceptances").push({ id: `tos-${wallet}-${version}`, wallet, version });
}

async function post(wallet: string, over: Record<string, unknown> = {}) {
  signer.wallet = wallet;
  signer.params = { ...params(), ...over };
  const res = await conversionCreate(
    new Request("https://manci.test/api/conversion/create", { method: "POST", body: JSON.stringify({ params: signer.params }) }),
  );
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; data?: { id: string } } };
}

const written = () => db.ref!.rows("conversion_requests");
const alerts = () => db.ref!.rows("compliance_alerts");

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv(PILOT_MODULE_ENV.custodyConversion, "true");
  vi.stubEnv("SANCTIONS_SCREENING", "");
  vi.stubEnv("TOS_SERVER_GATE", "");
  db.ref = memorySupabase();
  db.ref.rpcs.raise_sanctions_hit = (args) => {
    db.ref!.rows("compliance_alerts").push({ ...args });
    return { inserted: true };
  };
  clearSanctionsCache();
  chain.getToken2022Balance.mockClear();
  chain.resolveShareClassAssetFacts.mockClear();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  warnSpy.mockRestore();
});

describe("POST /api/conversion/create: sanctions screen and Terms acceptance (mainnet)", () => {
  it("accepts a verified holder who is clear of the lists and accepted the Terms in force", async () => {
    loadList();
    verified(CLEAN);
    accepted(CLEAN);
    const res = await post(CLEAN);
    expect(res.status).toBe(200);
    expect(written()).toEqual([
      expect.objectContaining({ network: "mainnet", holder_wallet: CLEAN, client_id: `client-${CLEAN.slice(0, 4)}`, amount: 10 }),
    ]);
    expect(chain.resolveShareClassAssetFacts).toHaveBeenCalledWith(SHARE_CLASS, MINT);
    expect(chain.getToken2022Balance).toHaveBeenCalledWith(CLEAN, MINT);
    expect(alerts()).toEqual([]);
  });

  it("refuses a listed wallet (403) and raises its compliance alert, even with a verified dossier and the Terms accepted, before any chain read", async () => {
    loadList();
    verified(LISTED);
    accepted(LISTED);
    const res = await post(LISTED);
    expect(res).toEqual({ status: 403, body: { ok: false, error: SCREENING_SELF_HIT } });
    expect(alerts()).toEqual([expect.objectContaining({ p_wallet: LISTED })]);
    expect(alerts()[0].p_evidence).toMatchObject({ route: "conversion/create", role: "self" });
    expect(chain.resolveShareClassAssetFacts).not.toHaveBeenCalled();
    expect(chain.getToken2022Balance).not.toHaveBeenCalled();
    expect(written()).toEqual([]);
  });

  it("validates the request before the screen: invalid parameters from a listed wallet get 400, no screen and no alert", async () => {
    verified(LISTED);
    accepted(LISTED);
    // No list loaded: a screen would answer 503, so a 400 shows it never ran.
    const unscreened = await post(LISTED, { amount: 0 });
    expect(unscreened).toEqual({ status: 400, body: { ok: false, error: "amount must be a positive integer" } });
    // With the list loaded, the listed wallet's invalid request still raises no alert.
    loadList();
    expect((await post(LISTED, { mint: "not-an-address" })).status).toBe(400);
    expect(alerts()).toEqual([]);
    expect(chain.resolveShareClassAssetFacts).not.toHaveBeenCalled();
    expect(written()).toEqual([]);
  });

  it.each([
    ["never loaded", () => {}],
    ["older than 3 days", () => loadList(NOW - 4 * 24 * 3_600_000)],
    ["unreadable", () => { loadList(); db.ref!.failReads.add("sanctions_list_state"); }],
  ])("fails closed (503) when the list is %s, before any chain read or write", async (_label, seed) => {
    seed();
    verified(CLEAN);
    accepted(CLEAN);
    const res = await post(CLEAN);
    expect(res.status).toBe(503);
    expect(chain.resolveShareClassAssetFacts).not.toHaveBeenCalled();
    expect(written()).toEqual([]);
  });

  it("refuses (409) a wallet without an acceptance of the Terms in force, after the chain checks and before the write; 503 when unreadable", async () => {
    loadList();
    verified(CLEAN);
    accepted(CLEAN, "2000-01-01"); // an older version does not count
    const refused = await post(CLEAN);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(
      `Accept the current Terms of Service (v${TOS_VERSION}) with this wallet before requesting a conversion`,
    );
    expect(chain.getToken2022Balance).toHaveBeenCalledWith(CLEAN, MINT);
    expect(written()).toEqual([]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      accepted(CLEAN);
      db.ref!.failReads.add("tos_acceptances");
      expect((await post(CLEAN)).status).toBe(503);
      expect(written()).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("the module switch and the KYC gate still answer first: no screen, no alert", async () => {
    loadList();
    accepted(LISTED);
    // Conversion off on mainnet: 403 before anything else.
    vi.stubEnv(PILOT_MODULE_ENV.custodyConversion, "");
    const off = await post(LISTED);
    expect(off).toEqual({ status: 403, body: { ok: false, error: moduleDisabledMessage("custodyConversion", "mainnet") } });
    // On, but no verified dossier: the KYC gate refuses before the screen.
    vi.stubEnv(PILOT_MODULE_ENV.custodyConversion, "true");
    const unverified = await post(LISTED);
    expect(unverified.status).toBe(403);
    expect(unverified.body.error).toContain("Onboarding required");
    expect(alerts()).toEqual([]);
    expect(written()).toEqual([]);
  });

  it("devnet: a listed wallet is still refused; the Terms are asked only with TOS_SERVER_GATE=enforce", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    loadList();
    verified(CLEAN, "devnet");
    verified(LISTED, "devnet");
    expect((await post(LISTED)).status).toBe(403);
    expect((await post(CLEAN)).status).toBe(200);
    vi.stubEnv("TOS_SERVER_GATE", "enforce");
    expect((await post(CLEAN)).status).toBe(409);
    expect(written()).toHaveLength(1);
  });
});
