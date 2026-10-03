// Wallet sanctions screening without a provider (8.5; pravo-compliance-3,
// ops-qa-4, lansiranje-4):
//   - lib/ofac-sdn.ts parses the OFAC SDN.XML (fixture in the real format:
//     tests/fixtures/ofac-sdn-sample.xml) and keeps only Solana addresses;
//   - lib/server/sanctions.ts refuses a listed wallet (403 + one alert),
//     fails closed on mainnet when the list is stale (> 3 days), empty or
//     unreadable, and only warns elsewhere;
//   - lib/server/sanctions-refresh.ts downloads, parses and replaces the list,
//     keeping the previous one on any failure;
//   - the compliance screen of sales and trading (refuseSuspendedClient)
//     runs it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));
const signer = vi.hoisted(() => ({ wallet: "" }));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: signer.wallet, params: {}, via: "session" })),
}));

import { OFAC_SDN_SOURCE, OFAC_SDN_XML_URL, parseSdnXml, SdnListFormatError } from "@/lib/ofac-sdn";
import {
  clearSanctionsCache,
  requireSanctionsClear,
  SANCTIONS_MAX_LIST_AGE_MS,
  SCREENING_COUNTERPARTY_HIT,
  SCREENING_SELF_HIT,
  SCREENING_UNAVAILABLE,
  screenWallets,
  sanctionsStatus,
  type SanctionsProvider,
} from "@/lib/server/sanctions";
import { runSanctionsRefresh } from "@/lib/server/sanctions-refresh";
import { refuseSuspendedClient } from "@/lib/server/kyc-gate";
import { POST as internalRefresh } from "@/app/api/internal/sanctions/route";
import { POST as screenWalletRoute } from "@/app/api/compliance/screen-wallet/route";
import { SESSION_READ_ACTIONS } from "@/lib/siws-session";
import { TOS_VERSION } from "@/lib/tos-version";

const FIXTURE = readFileSync(join(process.cwd(), "tests/fixtures/ofac-sdn-sample.xml"), "utf8");
const LISTED = "6t3xLqAFPZoE4mzWzxabrKxK8cGoHxAmaCj3MigJpWh5";
const LISTED_USDC = "8yY7nAbZip1FPakFXDh5sTsxhXnxKdSMo4D8Zybf6GbQ";
const LISTED_TRIMMED = "B52HDW2t44DGiPVz3UoZtbFsakcKeSUH8CQaQpKeoxWZ";
const CLEAN = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const NOW = Date.parse("2026-09-28T12:00:00Z");

/** The database as a fresh refresh leaves it. */
function loadList(refreshedAt: number = NOW - 3_600_000, addresses: string[] = [LISTED, LISTED_USDC]) {
  db.ref!.rows("sanctions_list_state").push({
    source: OFAC_SDN_SOURCE, published_on: "2026-09-23", address_count: addresses.length,
    refreshed_at: new Date(refreshedAt).toISOString(), last_attempt_at: new Date(refreshedAt).toISOString(),
    last_status: "ok", last_error: null,
  });
  for (const address of addresses) {
    db.ref!.rows("sanctions_addresses").push({
      source: OFAC_SDN_SOURCE, address, currency: "SOL", entry_uid: "90001", entry_name: "Fixture PERSON ONE", programs: ["CYBER2"],
    });
  }
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv("SANCTIONS_SCREENING", "");
  db.ref = memorySupabase();
  db.ref.rpcs.raise_sanctions_hit = (args) => {
    db.ref!.rows("compliance_alerts").push({ ...args });
    return { inserted: true };
  };
  clearSanctionsCache();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("lib/ofac-sdn.ts parseSdnXml", () => {
  it("keeps the Solana addresses of the SDN list, with their entry, and nothing else", () => {
    const parsed = parseSdnXml(FIXTURE);
    expect(parsed.publishedOn).toBe("2026-09-23");
    expect(parsed.recordCount).toBe(4);
    expect(parsed.addresses).toEqual([
      { address: LISTED, currency: "SOL", entryUid: "90001", entryName: "Fixture PERSON ONE", programs: ["CYBER2", "ILLICIT-DRUGS-EO14059"] },
      // A Solana-format address listed under USDC is a Solana wallet too.
      { address: LISTED_USDC, currency: "USDC", entryUid: "90010", entryName: "FIXTURE EXCHANGE & CO. LTD", programs: ["RUSSIA-EO14024"] },
      { address: LISTED_TRIMMED, currency: "SOL", entryUid: "90010", entryName: "FIXTURE EXCHANGE & CO. LTD", programs: ["RUSSIA-EO14024"] },
    ]);
    // XBT, ETH, TRX and the malformed SOL entry; the duplicate of LISTED is merged.
    expect(parsed.skipped).toBe(4);
  });

  it("refuses a truncated file, a count that does not match the header, and a file without its header", () => {
    const code = (xml: string) => {
      try {
        parseSdnXml(xml);
        return "parsed";
      } catch (err) {
        return err instanceof SdnListFormatError ? err.code : "other";
      }
    };
    expect(code(FIXTURE.slice(0, FIXTURE.lastIndexOf("</sdnList>")))).toBe("TRUNCATED");
    expect(code(FIXTURE.replace("<Record_Count>4</Record_Count>", "<Record_Count>5</Record_Count>"))).toBe("RECORD_COUNT_MISMATCH");
    expect(code(FIXTURE.replace(/<publshInformation>[\s\S]*?<\/publshInformation>/, ""))).toBe("NO_PUBLISH_INFO");
  });
});

describe("requireSanctionsClear", () => {
  const screen = (wallet: string, role: "self" | "counterparty" = "self", txSignature?: string) =>
    requireSanctionsClear(db.ref!.client as never, { route: "launchpad/commit", wallets: [{ wallet, role }], txSignature });

  it("lets a clean wallet through a fresh list", async () => {
    loadList();
    await expect(screen(CLEAN)).resolves.toBeUndefined();
    expect(db.ref!.rows("compliance_alerts")).toHaveLength(0);
  });

  it("refuses a listed wallet (403) after raising its compliance alert, on every network", async () => {
    loadList();
    const sig = "5".repeat(88);
    await expect(screen(LISTED, "self", sig)).rejects.toMatchObject({ status: 403, message: SCREENING_SELF_HIT });
    const [alert] = db.ref!.rows("compliance_alerts");
    expect(alert).toMatchObject({
      p_network: "mainnet", p_wallet: LISTED, p_source: OFAC_SDN_SOURCE, p_hit_list: "OFAC SDN", p_tx_signature: sig,
    });
    expect(alert.p_evidence).toMatchObject({ screening: "wallet-address", route: "launchpad/commit", role: "self",
      matches: [{ list: "OFAC SDN", entry_uid: "90001", entry_name: "Fixture PERSON ONE" }] });
    expect(String(alert.p_summary)).not.toContain(LISTED);

    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    await expect(screen(LISTED)).rejects.toMatchObject({ status: 403 });
  });

  it("a counterparty's hit gets the generic copy", async () => {
    loadList();
    await expect(screen(LISTED_USDC, "counterparty")).rejects.toMatchObject({ status: 403, message: SCREENING_COUNTERPARTY_HIT });
  });

  it.each([
    ["stale (older than 3 days)", () => loadList(NOW - SANCTIONS_MAX_LIST_AGE_MS - 1)],
    ["never loaded", () => {}],
    ["loaded without an address", () => loadList(NOW - 3_600_000, [])],
    ["unreadable", () => { loadList(); db.ref!.failReads.add("sanctions_addresses"); }],
  ])("mainnet fails closed (503) when the list is %s, and nothing is raised", async (_label, setup) => {
    setup();
    await expect(screen(CLEAN)).rejects.toMatchObject({ status: 503, message: SCREENING_UNAVAILABLE });
    await expect(screen(LISTED)).rejects.toMatchObject({ status: 503 });
    expect(db.ref!.rows("compliance_alerts")).toHaveLength(0);
  });

  it("devnet only warns about a stale list; SANCTIONS_SCREENING=enforce rehearses mainnet", async () => {
    loadList(NOW - SANCTIONS_MAX_LIST_AGE_MS - 1);
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(screen(CLEAN)).resolves.toBeUndefined();
    const { unavailable } = await screenWallets(db.ref!.client as never, [CLEAN], { now: NOW });
    expect(unavailable).toEqual([{ provider: "ofac-sdn-list", code: "LIST_STALE" }]);
    warn.mockRestore();
    vi.stubEnv("SANCTIONS_SCREENING", "enforce");
    await expect(screen(CLEAN)).rejects.toMatchObject({ status: 503 });
  });

  it("asks every provider, so a paid one joins without a route change", async () => {
    const paid: SanctionsProvider = {
      name: "paid-provider",
      screen: async (wallets) => new Map(wallets.filter((w) => w === CLEAN).map((w) => [w, [{ provider: "paid-provider", source: "paid", hitList: "Paid list" }]])),
      status: async () => ({ provider: "paid-provider", source: "paid", state: "fresh", publishedOn: null, refreshedAt: null, addressCount: null, lastAttemptAt: null, lastStatus: null, lastError: null }),
    };
    loadList();
    const { hits } = await screenWallets(db.ref!.client as never, [CLEAN, LISTED], { now: NOW, providers: [paid] });
    expect([...hits.keys()]).toEqual([CLEAN]);
  });

  it("ignores values that are not wallet addresses", async () => {
    loadList();
    const { hits } = await screenWallets(db.ref!.client as never, ["not a wallet", ""], { now: NOW });
    expect(hits.size).toBe(0);
  });

  it("reports each list's state for /admin/compliance", async () => {
    loadList(NOW - SANCTIONS_MAX_LIST_AGE_MS - 1);
    expect(await sanctionsStatus(db.ref!.client as never, NOW)).toEqual([expect.objectContaining({
      provider: "ofac-sdn-list", source: OFAC_SDN_SOURCE, state: "stale", publishedOn: "2026-09-23", addressCount: 2,
    })]);
  });
});

describe("the sales and trading compliance screen (refuseSuspendedClient)", () => {
  it("refuses a listed wallet without a dossier, and the counterparty generically", async () => {
    loadList();
    await expect(refuseSuspendedClient(db.ref!.client as never, LISTED, "committing to a raise")).rejects.toMatchObject({
      status: 403, message: SCREENING_SELF_HIT,
    });
    await expect(refuseSuspendedClient(db.ref!.client as never, LISTED, "trading", "counterparty")).rejects.toMatchObject({
      status: 403, message: SCREENING_COUNTERPARTY_HIT,
    });
    await expect(refuseSuspendedClient(db.ref!.client as never, CLEAN, "trading")).resolves.toEqual({ clientId: null });
  });
});

describe("POST /api/compliance/screen-wallet (the buyer's own pre-check before an on-chain buy)", () => {
  const post = async (wallet: string) => {
    signer.wallet = wallet;
    const res = await screenWalletRoute(new Request("https://manci.test/api/compliance/screen-wallet", { method: "POST", body: "{}" }));
    return { status: res.status, body: (await res.json()) as { error?: string } };
  };

  const accepted = (wallet: string) =>
    db.ref!.rows("tos_acceptances").push({ id: `tos-${wallet}`, wallet, version: TOS_VERSION, created_at: new Date(NOW - 60_000).toISOString() });

  it("answers clear, refuses a listed buyer with the alert raised, and fails closed on mainnet", async () => {
    expect(SESSION_READ_ACTIONS.has("compliance.screenWallet")).toBe(true);
    loadList();
    accepted(CLEAN);
    expect((await post(CLEAN)).status).toBe(200);
    // Screened first: a listed wallet is refused and reported with or without an acceptance.
    const hit = await post(LISTED);
    expect(hit).toEqual({ status: 403, body: { ok: false, error: SCREENING_SELF_HIT } });
    expect(db.ref!.rows("compliance_alerts")).toEqual([expect.objectContaining({ p_wallet: LISTED })]);
    db.ref!.tables.sanctions_list_state = [];
    clearSanctionsCache();
    expect((await post(CLEAN)).status).toBe(503);
  });

  it("D2: a clear wallet still needs the Terms in force accepted on mainnet (409; 503 when unreadable); devnet does not ask", async () => {
    loadList();
    const refused = await post(CLEAN);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain(`Accept the current Terms of Service (v${TOS_VERSION}) with this wallet before buying`);
    db.ref!.failReads.add("tos_acceptances");
    expect((await post(CLEAN)).status).toBe(503);
    db.ref!.failReads.clear();
    accepted(CLEAN);
    expect((await post(CLEAN)).status).toBe(200);
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    db.ref!.tables.tos_acceptances = [];
    expect((await post(CLEAN)).status).toBe(200);
    vi.stubEnv("TOS_SERVER_GATE", "enforce");
    expect((await post(CLEAN)).status).toBe(409);
    expect(db.ref!.rows("compliance_alerts")).toEqual([]);
  });
});

describe("runSanctionsRefresh", () => {
  const response = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });
  let replaced: Record<string, unknown> | null;
  let failures: Record<string, unknown>[];
  beforeEach(() => {
    replaced = null;
    failures = [];
    db.ref!.rpcs.replace_sanctions_list = (args) => {
      replaced = args;
      return { source: args.p_source, addresses: (args.p_addresses as unknown[]).length, removed: 0 };
    };
    db.ref!.rpcs.record_sanctions_refresh_failure = (args) => {
      failures.push(args);
      return null;
    };
  });
  const run = (fetchImpl: (url: string) => Promise<Response>) =>
    runSanctionsRefresh({ sb: db.ref!.client as never, fetchImpl: fetchImpl as never });

  it("downloads the Treasury's SDN.XML and replaces the list in one call", async () => {
    const urls: string[] = [];
    const result = await run(async (url) => {
      urls.push(url);
      return response(FIXTURE);
    });
    expect(urls).toEqual([OFAC_SDN_XML_URL]);
    expect(result).toEqual({ status: "processed", network: "mainnet", source: OFAC_SDN_SOURCE, publishedOn: "2026-09-23", addresses: 3, removed: 0, skipped: 4 });
    expect(replaced).toMatchObject({ p_source: OFAC_SDN_SOURCE, p_published_on: "2026-09-23", p_record_count: 4 });
    expect(String(replaced!.p_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect((replaced!.p_addresses as { address: string }[]).map((a) => a.address)).toEqual([LISTED, LISTED_USDC, LISTED_TRIMMED]);
    expect(failures).toEqual([]);
  });

  it.each([
    ["HTTP_ERROR", async () => response("nope", { status: 500 })],
    ["TRANSPORT_ERROR", async () => { throw new TypeError("fetch failed"); }],
    ["TRUNCATED", async () => response(FIXTURE.slice(0, 2000))],
    ["EMPTY_LIST", async () => response(FIXTURE.replace(/<idList>[\s\S]*?<\/idList>/g, ""))],
    ["TOO_LARGE", async () => response(FIXTURE, { headers: { "content-length": String(200 * 1024 * 1024) } })],
  ])("keeps the previous list and records %s", async (code, fetchImpl) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await run(fetchImpl as never);
    error.mockRestore();
    expect(result).toMatchObject({ status: "failed", error: code });
    expect(replaced).toBeNull();
    expect(failures).toEqual([{ p_source: OFAC_SDN_SOURCE, p_error: code }]);
  });

  it("caps a body without a content-length while it streams (TOO_LARGE, the rest never read)", async () => {
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runSanctionsRefresh({
      sb: db.ref!.client as never,
      fetchImpl: (async () => new Response(endless, { status: 200 })) as never,
      maxBytes: 8 * 1024,
    });
    error.mockRestore();
    expect(result).toMatchObject({ status: "failed", error: "TOO_LARGE" });
    expect(pulls).toBeLessThan(20);
    expect(cancelled).toBe(true);
    expect(failures).toEqual([{ p_source: OFAC_SDN_SOURCE, p_error: "TOO_LARGE" }]);
    // Under the cap, a chunked body is read whole.
    const ok = await runSanctionsRefresh({
      sb: db.ref!.client as never,
      fetchImpl: (async () => new Response(new Blob([FIXTURE]).stream(), { status: 200 })) as never,
    });
    expect(ok).toMatchObject({ status: "processed", addresses: 3 });
  });

  it("the scheduler's route needs the worker credential", async () => {
    const post = (authorization?: string) =>
      internalRefresh(new Request("https://manci.test/api/internal/sanctions", { method: "POST", headers: authorization ? { authorization } : {} }));
    vi.stubEnv("RETRY_WORKER_SECRET", "");
    expect((await post("Bearer x")).status).toBe(503);
    vi.stubEnv("RETRY_WORKER_SECRET", "s".repeat(40));
    expect((await post()).status).toBe(401);
    expect((await post("Bearer wrong")).status).toBe(401);
  });
});
