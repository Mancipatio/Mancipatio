// POST /api/conversion/create: the wallet's OPEN requests of the same share
// class (requested / vault_opened / deposited) already claim units of the
// on-chain balance, so their sum plus the new request must fit it (409), and
// the route answers with the created row so the page can show it before its
// reload lands. The check reads the table after the balance and before the
// Terms, and fails closed when it cannot read. Same harness as
// tests/conversion-create-route.test.ts (in-memory database, real gates,
// stubbed signature and chain reads).
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

import { PILOT_MODULE_ENV } from "@/lib/features";
import { OFAC_SDN_SOURCE } from "@/lib/ofac-sdn";
import { clearSanctionsCache } from "@/lib/server/sanctions";
import { TOS_VERSION } from "@/lib/tos-version";
import { POST as conversionCreate } from "@/app/api/conversion/create/route";

const LISTED = "6t3xLqAFPZoE4mzWzxabrKxK8cGoHxAmaCj3MigJpWh5";
const CLEAN = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const OTHER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const SHARE_CLASS = "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr";
const OTHER_CLASS = "6D6TgUKrYY6dJrCUZ6LcJKt5EGGdCUgHtVeUKmRZbUJ2";
const MINT = "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const FUTURE = "2027-10-10T00:00:00.000Z";

const OVER_BALANCE =
  "You already have open conversion requests for 995 units of this share class; together with this request that exceeds your balance.";

const params = () => ({ share_class_pda: SHARE_CLASS, mint: MINT, amount: 10, contact: "holder@example.com" });

/** The sanctions list as a fresh refresh leaves it (one fixture entry: an empty list counts as unavailable). */
function loadList() {
  db.ref!.rows("sanctions_list_state").push({
    source: OFAC_SDN_SOURCE, published_on: "2026-10-09", address_count: 1,
    refreshed_at: new Date(NOW - 3_600_000).toISOString(), last_attempt_at: new Date(NOW - 3_600_000).toISOString(),
    last_status: "ok", last_error: null,
  });
  db.ref!.rows("sanctions_addresses").push({
    source: OFAC_SDN_SOURCE, address: LISTED, currency: "SOL", entry_uid: "90001", entry_name: "Fixture PERSON ONE", programs: ["CYBER2"],
  });
}

function verified(wallet: string) {
  db.ref!.rows("clients").push({
    id: `client-${wallet.slice(0, 4)}`, wallet, network: "mainnet", kyc_status: "verified", kyc_expires_at: FUTURE,
    created_at: "2026-09-01T00:00:00.000Z",
  });
}

function accepted(wallet: string, version: string = TOS_VERSION) {
  db.ref!.rows("tos_acceptances").push({ id: `tos-${wallet}-${version}`, wallet, version });
}

let seq = 0;
/** An existing request row; by default an open one of this wallet, network and class. */
function existing(over: Record<string, unknown>) {
  db.ref!.rows("conversion_requests").push({
    id: `existing-${++seq}`, network: "mainnet", holder_wallet: CLEAN, share_class_pda: SHARE_CLASS, mint: MINT,
    amount: 1, status: "requested", created_at: new Date(NOW - 86_400_000).toISOString(), ...over,
  });
}

async function post(wallet: string, over: Record<string, unknown> = {}) {
  signer.wallet = wallet;
  signer.params = { ...params(), ...over };
  const res = await conversionCreate(
    new Request("https://manci.test/api/conversion/create", { method: "POST", body: JSON.stringify({ params: signer.params }) }),
  );
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; data?: { id: string; request?: Record<string, unknown> } } };
}

/** Rows the route wrote (the seeded ones carry an `existing-` id). */
const written = () => db.ref!.rows("conversion_requests").filter((r) => !String(r.id).startsWith("existing-"));

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv(PILOT_MODULE_ENV.custodyConversion, "true");
  vi.stubEnv("SANCTIONS_SCREENING", "");
  vi.stubEnv("TOS_SERVER_GATE", "");
  db.ref = memorySupabase();
  // What the database fills in on insert (migration 0034 defaults).
  db.ref.defaults.conversion_requests = () => ({ status: "requested", created_at: new Date(NOW).toISOString() });
  clearSanctionsCache();
  chain.getToken2022Balance.mockClear();
  chain.getToken2022Balance.mockResolvedValue(BigInt(1_000));
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  loadList();
  verified(CLEAN);
  accepted(CLEAN);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  warnSpy.mockRestore();
});

describe("POST /api/conversion/create: open requests against the balance, and the created row", () => {
  it("answers with the created row, so the page can show it before its reload lands", async () => {
    const res = await post(CLEAN);
    expect(res.status).toBe(200);
    expect(res.body.data?.request).toMatchObject({
      id: res.body.data?.id, network: "mainnet", holder_wallet: CLEAN, share_class_pda: SHARE_CLASS, mint: MINT,
      amount: 10, status: "requested", client_id: `client-${CLEAN.slice(0, 4)}`,
    });
    expect(written()).toHaveLength(1);
  });

  it("refuses (409) when the wallet's open requests of the class plus this one exceed the balance; a fitting one goes through", async () => {
    existing({ amount: 600, status: "requested" });
    existing({ amount: 300, status: "vault_opened" });
    existing({ amount: 95, status: "deposited" });
    const refused = await post(CLEAN, { amount: 10 }); // 995 + 10 > 1_000
    expect(refused).toEqual({ status: 409, body: { ok: false, error: OVER_BALANCE } });
    expect(written()).toEqual([]);
    const fits = await post(CLEAN, { amount: 5 }); // 995 + 5 = 1_000
    expect(fits.status).toBe(200);
    expect(written()).toHaveLength(1);
  });

  it("counts only open rows of this wallet, this network and this share class", async () => {
    existing({ amount: 995, status: "converted" });
    existing({ amount: 995, status: "cancelled" });
    existing({ amount: 995, status: "returned" });
    existing({ amount: 995, share_class_pda: OTHER_CLASS });
    existing({ amount: 995, holder_wallet: OTHER });
    existing({ amount: 995, network: "devnet" });
    const res = await post(CLEAN, { amount: 1_000 });
    expect(res.status).toBe(200);
    expect(written()).toHaveLength(1);
  });

  it("runs after the balance check and before the Terms", async () => {
    // Over the balance on its own: the balance message, not the open-requests one.
    chain.getToken2022Balance.mockResolvedValueOnce(BigInt(5));
    const over = await post(CLEAN, { amount: 10 });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain("exceeds your on-chain balance");
    // Open requests over the balance AND no acceptance of the Terms in force: the open-requests refusal answers first.
    db.ref!.tables.tos_acceptances = [];
    accepted(CLEAN, "2000-01-01");
    existing({ amount: 995 });
    const refused = await post(CLEAN, { amount: 10 });
    expect(refused).toEqual({ status: 409, body: { ok: false, error: OVER_BALANCE } });
    expect(written()).toEqual([]);
  });

  it("fails closed (500) when the open requests cannot be read", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      db.ref!.failReads.add("conversion_requests");
      const res = await post(CLEAN);
      expect(res).toEqual({ status: 500, body: { ok: false, error: "Could not check your open conversion requests" } });
      expect(written()).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });
});
