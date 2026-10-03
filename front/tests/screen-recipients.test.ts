// POST /api/compliance/screen-recipients ("Send to wallets", S3): the sender
// screens its recipients before anything is signed. A hit blocks only that
// row (its alert raised, no list named); mainnet refuses the whole request
// while the list cannot answer (503); only the class's issuer authority or
// an Admin may ask (no sanctions oracle); a session read. Since the
// 2026-10-03 rehearsal (P1) every screen is RECORDED (a server-attributed
// audit_events row per screen, each wallet's result and the list version)
// and POST /api/compliance/distribution-evidence checks those records
// before the sender signs.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));
const signer = vi.hoisted(() => ({ wallet: "", params: {} as Record<string, unknown>, actions: [] as string[] }));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async (_req: Request, action: string) => {
    signer.actions.push(action);
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
import { POST as EVIDENCE } from "@/app/api/compliance/distribution-evidence/route";
import { SESSION_READ_ACTIONS } from "@/lib/siws-session";
import { SCREENING_FRESH_MS } from "@/lib/distribution-screening";
import { EVIDENCE_IX, SCREENING_IX } from "@/lib/server/screening-evidence";

const LISTED = "6t3xLqAFPZoE4mzWzxabrKxK8cGoHxAmaCj3MigJpWh5";
const CLEAN = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const CLEAN2 = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const ISSUER = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP";
const SHARE_CLASS = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC";
const OTHER_CLASS = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";
const RUN = "ab".repeat(32);
const NOW = Date.parse("2026-10-03T12:00:00Z");
const SHA = "c0ffee".repeat(10) + "abcd";

function loadList(refreshedAt = NOW - 3_600_000) {
  db.ref!.rows("sanctions_list_state").push({
    source: OFAC_SDN_SOURCE, published_on: "2026-10-01", address_count: 1, sha256: SHA,
    refreshed_at: new Date(refreshedAt).toISOString(), last_attempt_at: new Date(refreshedAt).toISOString(), last_status: "ok", last_error: null,
  });
  db.ref!.rows("sanctions_addresses").push({
    source: OFAC_SDN_SOURCE, address: LISTED, currency: "SOL", entry_uid: "1", entry_name: "Fixture", programs: ["CYBER2"],
  });
}

type Body = { ok: boolean; data?: Record<string, unknown> & { blocked?: string[] }; error?: string };

async function call(route: typeof POST, path: string, wallet: string, params: Record<string, unknown>, ip?: string) {
  signer.wallet = wallet;
  signer.params = params;
  const res = await route(new Request(`https://manci.test/api/compliance/${path}`, { method: "POST", body: "{}", headers: ip ? { "x-real-ip": ip } : {} }));
  return { status: res.status, body: (await res.json()) as Body };
}
const post = (wallet: string, params: Record<string, unknown>, ip?: string) => call(POST, "screen-recipients", wallet, params, ip);
const evidence = (wallet: string, params: Record<string, unknown>) => call(EVIDENCE, "distribution-evidence", wallet, params);

const records = (ix: string) => db.ref!.rows("audit_events").filter((r) => r.ix_name === ix);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv("SANCTIONS_SCREENING", "");
  db.ref = memorySupabase();
  db.ref.rpcs.raise_sanctions_hit = (args) => {
    db.ref!.rows("compliance_alerts").push({ ...args });
    return { inserted: true };
  };
  // audit_events.created_at defaults to now() (0001).
  db.ref.defaults.audit_events = () => ({ created_at: new Date().toISOString() });
  clearSanctionsCache();
  chain.authority = ISSUER;
  chain.admins = new Set();
  signer.actions = [];
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("POST /api/compliance/screen-recipients", () => {
  it("is a session read (no prompt per screen)", async () => {
    expect(SESSION_READ_ACTIONS.has("compliance.screenRecipients")).toBe(true);
    loadList();
    await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] });
    expect(signer.actions).toEqual(["compliance.screenRecipients"]);
  });

  it("a hit blocks only its row, with its alert raised and no list named", async () => {
    loadList();
    const res = await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN, LISTED, CLEAN2, LISTED] });
    expect(res.status).toBe(200);
    expect(res.body.data?.blocked).toEqual([LISTED]);
    const alerts = db.ref!.rows("compliance_alerts");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ p_wallet: LISTED, p_network: "mainnet" });
    expect(alerts[0].p_evidence).toMatchObject({ route: "distribution (send to wallets)", role: "counterparty" });
    expect(JSON.stringify(res.body)).not.toMatch(/OFAC|Fixture|CYBER/);
  });

  it("answers clear for a clean list", async () => {
    loadList();
    expect((await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] })).body.data?.blocked).toEqual([]);
  });

  it("records every screen: a server-attributed compliance row with each wallet's result and the list version (P1)", async () => {
    loadList();
    const res = await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN, LISTED], run_id: RUN });
    const [row] = records(SCREENING_IX);
    expect(row).toMatchObject({
      network: "mainnet", category: "compliance", actor_wallet: ISSUER, target_label: SHARE_CLASS, status: "success",
      reason: "Sanctions screening of 2 distribution recipients",
    });
    expect(row.metadata).toMatchObject({
      run_id: RUN, share_class: SHARE_CLASS, screened_at: new Date(NOW).toISOString(),
      results: { [CLEAN]: "clear", [LISTED]: "hit" }, counts: { clear: 1, hit: 1, unscreened: 0 },
      list_version: `${OFAC_SDN_SOURCE}:2026-10-01:${SHA.slice(0, 12)}`,
      lists: [{ provider: "ofac-sdn-list", source: OFAC_SDN_SOURCE, published_on: "2026-10-01", sha256: SHA, address_count: 1 }],
      unavailable: [], enforced: true, actor_verified: true, actor_source: "siws-session",
    });
    // The answer cites the record, never a reason per wallet.
    expect(res.body.data?.screening).toEqual({ id: row.id, screened_at: new Date(NOW).toISOString(), list_version: row.metadata && (row.metadata as { list_version: string }).list_version });
    // The background screen has no run yet.
    await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] });
    expect(records(SCREENING_IX)[1].metadata).toMatchObject({ run_id: null });
  });

  it("refuses the screen (503) when its record cannot be written: nothing is sent on an unrecorded screen", async () => {
    loadList();
    db.ref!.failWrites.add("audit_events");
    const res = await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] });
    expect(res.status).toBe(503);
  });

  it("mainnet fails closed (503) while the list is stale: nothing can be sent unscreened", async () => {
    loadList(NOW - 4 * 86_400_000);
    expect(await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] })).toEqual({
      status: 503,
      body: { ok: false, error: SCREENING_UNAVAILABLE },
    });
    expect(records(SCREENING_IX)).toEqual([]);
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
    expect((await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN], run_id: "nope" })).status).toBe(400);
  });
});

describe("POST /api/compliance/distribution-evidence (P1: no send without a fresh clear screening)", () => {
  it("is a session read whose only write is the evidence row", async () => {
    expect(SESSION_READ_ACTIONS.has("compliance.distributionEvidence")).toBe(true);
    loadList();
    await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] });
    signer.actions = [];
    await evidence(ISSUER, { share_class: SHARE_CLASS, run_id: RUN, wallets: [CLEAN] });
    expect(signer.actions).toEqual(["compliance.distributionEvidence"]);
  });

  it("vouches for every recipient with its latest screening and records the run's evidence", async () => {
    loadList();
    await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN, CLEAN2], run_id: RUN });
    const screening = records(SCREENING_IX)[0];
    vi.setSystemTime(NOW + 60_000);
    const res = await evidence(ISSUER, { share_class: SHARE_CLASS, run_id: RUN, wallets: [CLEAN, CLEAN2] });
    expect(res.status).toBe(200);
    const [row] = records(EVIDENCE_IX);
    expect(row).toMatchObject({ category: "compliance", actor_wallet: ISSUER, target_label: SHARE_CLASS, network: "mainnet" });
    const entry = { screening_id: screening.id, screened_at: new Date(NOW).toISOString(), list_version: `${OFAC_SDN_SOURCE}:2026-10-01:${SHA.slice(0, 12)}`, result: "clear" };
    expect(row.metadata).toMatchObject({
      run_id: RUN, share_class: SHARE_CLASS, checked_at: new Date(NOW + 60_000).toISOString(), max_age_ms: SCREENING_FRESH_MS,
      recipients: [{ wallet: CLEAN, ...entry }, { wallet: CLEAN2, ...entry }],
    });
    expect(res.body.data).toEqual({
      evidence_id: row.id,
      checked_at: new Date(NOW + 60_000).toISOString(),
      recipients: { [CLEAN]: { ...entry, evidence_id: row.id }, [CLEAN2]: { ...entry, evidence_id: row.id } },
    });
  });

  it("refuses (409, no wallet named, nothing recorded) a recipient never screened, screened for another class, or a hit", async () => {
    loadList();
    await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN, LISTED] });
    await post(ISSUER, { share_class: OTHER_CLASS, wallets: [CLEAN2] });
    for (const wallets of [[CLEAN, CLEAN2], [CLEAN, LISTED]]) {
      const res = await evidence(ISSUER, { share_class: SHARE_CLASS, run_id: RUN, wallets });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/^1 of the 2 recipients have no clear sanctions screening from the last 15 minutes/);
      expect(res.body.error).not.toContain(LISTED);
    }
    expect(records(EVIDENCE_IX)).toEqual([]);
  });

  it("the LATEST screening counts: clear, then a hit (the list changed) is refused", async () => {
    loadList();
    await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] });
    // The wallet is listed in the next publication.
    db.ref!.rows("sanctions_addresses").push({ source: OFAC_SDN_SOURCE, address: CLEAN, currency: "SOL", entry_uid: "2", entry_name: "Later", programs: [] });
    clearSanctionsCache();
    vi.setSystemTime(NOW + 1_000);
    await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] });
    expect((await evidence(ISSUER, { share_class: SHARE_CLASS, run_id: RUN, wallets: [CLEAN] })).status).toBe(409);
  });

  it("a screening older than 15 minutes no longer vouches; screening again does", async () => {
    loadList();
    await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] });
    vi.setSystemTime(NOW + SCREENING_FRESH_MS + 1_000);
    expect((await evidence(ISSUER, { share_class: SHARE_CLASS, run_id: RUN, wallets: [CLEAN] })).status).toBe(409);
    await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] });
    expect((await evidence(ISSUER, { share_class: SHARE_CLASS, run_id: RUN, wallets: [CLEAN] })).status).toBe(200);
  });

  it("off mainnet an unanswered list is recorded as unscreened and passes (not enforced); enforce refuses the screen itself", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    // No list loaded on this devnet project.
    const res = await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] });
    expect(res.body.data?.blocked).toEqual([]);
    expect(records(SCREENING_IX)[0].metadata).toMatchObject({
      results: { [CLEAN]: "unscreened" }, list_version: "none", enforced: false,
      unavailable: [{ provider: "ofac-sdn-list", code: "LIST_NEVER_LOADED" }],
    });
    const ok = await evidence(ISSUER, { share_class: SHARE_CLASS, run_id: RUN, wallets: [CLEAN] });
    expect(ok.status).toBe(200);
    expect((ok.body.data?.recipients as Record<string, { result: string }>)[CLEAN].result).toBe("unscreened");
    vi.stubEnv("SANCTIONS_SCREENING", "enforce");
    expect((await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] })).status).toBe(503);
    // An "unscreened" record no longer passes once the screen is enforced.
    expect((await evidence(ISSUER, { share_class: SHARE_CLASS, run_id: RUN, wallets: [CLEAN] })).status).toBe(409);
  });

  it("503 when the records cannot be read; the caller rule and the parameters of screen-recipients", async () => {
    loadList();
    await post(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] });
    expect((await evidence(CLEAN2, { share_class: SHARE_CLASS, run_id: RUN, wallets: [CLEAN] })).status).toBe(403);
    expect((await evidence(ISSUER, { share_class: SHARE_CLASS, wallets: [CLEAN] })).status).toBe(400);
    expect((await evidence(ISSUER, { share_class: SHARE_CLASS, run_id: "x", wallets: [CLEAN] })).status).toBe(400);
    expect((await evidence(ISSUER, { share_class: SHARE_CLASS, run_id: RUN, wallets: [] })).status).toBe(400);
    db.ref!.failReads.add("audit_events");
    expect((await evidence(ISSUER, { share_class: SHARE_CLASS, run_id: RUN, wallets: [CLEAN] })).status).toBe(503);
  });

  it("a record forged without the server's fields does not vouch (wrong category or network)", async () => {
    loadList();
    db.ref!.rows("audit_events").push(
      { id: "forged-1", created_at: new Date(NOW).toISOString(), network: "mainnet", category: "share-class", ix_name: SCREENING_IX, target_label: SHARE_CLASS, metadata: { results: { [CLEAN]: "clear" } } },
      { id: "forged-2", created_at: new Date(NOW).toISOString(), network: "devnet", category: "compliance", ix_name: SCREENING_IX, target_label: SHARE_CLASS, metadata: { results: { [CLEAN]: "clear" } } },
    );
    expect((await evidence(ISSUER, { share_class: SHARE_CLASS, run_id: RUN, wallets: [CLEAN] })).status).toBe(409);
  });
});
