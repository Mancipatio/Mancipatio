// Sanctions screening without the buyer's client (8.5, gap-2026-09-28): a
// wallet that calls the program directly never reaches a screened route, so
// the alarm worker screens the signer of every finalized buy, OTC offer and
// take the indexer delivers (lib/server/onchain-screening.ts, run from
// processEventJob). A hit is the routes' compliance alert, with the
// transaction; a list that cannot answer on mainnet keeps the job pending.
// The purchase record reports, it never refuses (the buy already landed).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ txs: {} as Record<string, unknown> }));
vi.mock("@/lib/server/sale-capacity-chain", () => ({
  finalizedTransaction: vi.fn(async (sig: string) => state.txs[sig] ?? null),
}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));
const record = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: "6t3xLqAFPZoE4mzWzxabrKxK8cGoHxAmaCj3MigJpWh5", params: {
    sale_pubkey: "Pc4auCy8Fnwxs7EcFwBGKqV3SudxCKEEDLHbEHujBpK", investor_wallet: "6t3xLqAFPZoE4mzWzxabrKxK8cGoHxAmaCj3MigJpWh5",
    settled_tx: "5".repeat(88),
  } })),
}));
vi.mock("@/lib/server/purchase-records", () => ({
  enqueuePurchase: vi.fn(async () => ({ id: "job-1" })),
  processPurchaseJob: vi.fn(async () => {
    if (record.fail) throw new Error("rpc down");
    return { id: "p1", jobId: "job-1", status: "complete" };
  }),
}));

import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  BUY_DISCRIMINATOR,
  CANCEL_OFFER_DISCRIMINATOR,
  TAKE_OFFER_DISCRIMINATOR,
} from "@/lib/generated/asset_registry";
import { OFAC_SDN_SOURCE } from "@/lib/ofac-sdn";
import { processEventJob, type EventJob } from "@/lib/server/onchain-alarms";
import { SCREENED_ENTRIES, screenedParties } from "@/lib/server/onchain-screening";
import { clearSanctionsCache } from "@/lib/server/sanctions";
import { enqueuePurchase } from "@/lib/server/purchase-records";
import { POST as recordPurchase } from "@/app/api/launchpad/record-purchase/route";
import { buildTx, type Ix } from "./helpers/chain-tx";

const R = ASSET_REGISTRY_PROGRAM_ADDRESS;
const LISTED = "6t3xLqAFPZoE4mzWzxabrKxK8cGoHxAmaCj3MigJpWh5";
const CLEAN = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const SIG = "5".repeat(88);
const NOW = Date.parse("2026-09-28T12:00:00Z");

const ix = (discriminator: Uint8Array, signer: string, program: string = R): Ix => ({
  program, accounts: [signer, OTHER, CLEAN], data: new Uint8Array([...discriminator, ...new Uint8Array(16)]),
});
const job = (over: Partial<EventJob> = {}): EventJob => ({
  id: "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b", network: "mainnet", signature: SIG, source: "webhook", status: "pending",
  attempts: 0, created_at: new Date().toISOString(), ...over,
});
const signal = () => AbortSignal.timeout(5_000);

function loadList(refreshedAt: number = NOW - 3_600_000) {
  db.ref!.rows("sanctions_list_state").push({
    source: OFAC_SDN_SOURCE, published_on: "2026-09-23", address_count: 1,
    refreshed_at: new Date(refreshedAt).toISOString(), last_attempt_at: new Date(refreshedAt).toISOString(),
    last_status: "ok", last_error: null,
  });
  db.ref!.rows("sanctions_addresses").push({
    source: OFAC_SDN_SOURCE, address: LISTED, currency: "SOL", entry_uid: "90001", entry_name: "Fixture PERSON ONE", programs: ["CYBER2"],
  });
}
const alerts = () => db.ref!.rows("compliance_alerts");
const jobRow = () => db.ref!.rows("onchain_event_jobs")[0];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv("SANCTIONS_SCREENING", "");
  db.ref = memorySupabase();
  db.ref.rpcs.raise_sanctions_hit = (args) => {
    db.ref!.rows("compliance_alerts").push({ ...args });
    return { inserted: true };
  };
  db.ref.rows("onchain_event_jobs").push({ ...job() });
  state.txs = {};
  record.fail = false;
  clearSanctionsCache();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("screenedParties", () => {
  it("pins each entry's signer to the IDL account order", () => {
    const idl = JSON.parse(readFileSync("idl/asset_registry.json", "utf8")) as { instructions: { name: string; accounts: { name: string; signer?: boolean }[] }[] };
    for (const entry of SCREENED_ENTRIES) {
      const account = idl.instructions.find((i) => i.name === entry.name)?.accounts[entry.account];
      expect(account?.name, entry.name).toBe(entry.party);
      expect(account?.signer, entry.name).toBe(true);
    }
  });

  it("finds the signers of buys, offers and takes, top-level or inside a CPI, each wallet once", () => {
    const { tx } = buildTx({
      signature: SIG,
      instructions: [
        { ix: ix(BUY_DISCRIMINATOR, LISTED) },
        { ix: { program: SQUADS, accounts: [OTHER], data: new Uint8Array([0]) }, inner: [ix(TAKE_OFFER_DISCRIMINATOR, CLEAN), ix(BUY_DISCRIMINATOR, LISTED)] },
        { ix: ix(CANCEL_OFFER_DISCRIMINATOR, OTHER) },
        { ix: ix(BUY_DISCRIMINATOR, OTHER, SQUADS) },
      ],
    });
    expect(screenedParties(tx)).toEqual([
      { wallet: LISTED, instruction: "buy", party: "buyer" },
      { wallet: CLEAN, instruction: "take_offer", party: "taker" },
    ]);
  });
});

describe("the alarm worker screens a buy nobody recorded", () => {
  const buyBy = (signer: string) => {
    state.txs[SIG] = buildTx({ signature: SIG, instructions: [{ ix: ix(BUY_DISCRIMINATOR, signer) }], logs: null }).tx;
  };

  it("a listed buyer raises one critical alert with the transaction; the job completes", async () => {
    loadList();
    buyBy(LISTED);
    expect(await processEventJob(job(), signal(), Date.now() + 5_000, db.ref!.client as never)).toBe("complete");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ p_network: "mainnet", p_wallet: LISTED, p_tx_signature: SIG });
    expect((alerts()[0].p_evidence as { role: string; route: string })).toMatchObject({ role: "onchain-signer", route: "on-chain buy (indexer)" });
    expect(String(alerts()[0].p_summary)).toContain("The transaction already landed");
    expect(jobRow()).toMatchObject({ status: "complete", alerts: 1 });
  });

  it("a clean buyer completes without an alert", async () => {
    loadList();
    buyBy(CLEAN);
    expect(await processEventJob(job(), signal(), Date.now() + 5_000, db.ref!.client as never)).toBe("complete");
    expect(alerts()).toHaveLength(0);
    expect(jobRow()).toMatchObject({ status: "complete", alerts: 0 });
  });

  it("mainnet: a stale list keeps the job pending (never screened against it); devnet completes", async () => {
    loadList(NOW - 4 * 24 * 3_600_000);
    buyBy(LISTED);
    expect(await processEventJob(job(), signal(), Date.now() + 5_000, db.ref!.client as never)).toBe("pending");
    expect(jobRow()).toMatchObject({ status: "pending", last_error: "SANCTIONS_UNAVAILABLE", attempts: 1 });
    expect(alerts()).toHaveLength(0);
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    db.ref!.rows("onchain_event_jobs")[0] = { ...job({ network: "devnet" }) };
    expect(await processEventJob(job({ network: "devnet" }), signal(), Date.now() + 5_000, db.ref!.client as never)).toBe("complete");
  });

  it("an alert that could not be written retries the job", async () => {
    loadList();
    buyBy(LISTED);
    db.ref!.rpcs.raise_sanctions_hit = () => { throw new Error("db down"); };
    expect(await processEventJob(job(), signal(), Date.now() + 5_000, db.ref!.client as never)).toBe("pending");
    expect(jobRow()).toMatchObject({ status: "pending", last_error: "DB_UNAVAILABLE" });
  });
});

describe("the purchase record records, then reports", () => {
  const post = async () => {
    const res = await recordPurchase(new Request("https://manci.test/api/launchpad/record-purchase", { method: "POST", body: "{}" }));
    return { status: res.status, body: (await res.json()) as { ok: boolean; data?: unknown } };
  };

  it("a listed buyer's landed buy is recorded (200) and raises the alert with the transaction", async () => {
    loadList();
    const res = await post();
    expect(res.status).toBe(200);
    expect(vi.mocked(enqueuePurchase)).toHaveBeenCalled();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ p_wallet: LISTED, p_tx_signature: SIG });
  });

  it("mainnet with a stale list: recorded anyway (the alarm worker screens it later), no 503", async () => {
    loadList(NOW - 4 * 24 * 3_600_000);
    expect((await post()).status).toBe(200);
    expect(alerts()).toHaveLength(0);
  });

  it("the report runs even when the record itself fails", async () => {
    loadList();
    record.fail = true;
    expect((await post()).status).not.toBe(200);
    expect(alerts()).toHaveLength(1);
  });
});
