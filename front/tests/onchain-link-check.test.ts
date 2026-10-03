// Buys by wallets not linked to the platform (D2, owner and counsel decision
// 2026-10-03): buying an Open class needs no KYC but a wallet signed in on the
// site with the Terms in force accepted. The program cannot check it, so the
// alarm worker does, after the fact (lib/server/onchain-link-check.ts, run from
// processEventJob): a buyer without an acceptance of the Terms in force by
// 2 minutes after the buy raises one compliance alert per (transaction,
// buyer), the wallet as subject, high on mainnet; within those 2 minutes the
// job waits (LINK_GRACE); a read or write that fails is never a verdict.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase, type Row } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ txs: {} as Record<string, unknown> }));
vi.mock("@/lib/server/sale-capacity-chain", () => ({
  finalizedTransaction: vi.fn(async (sig: string) => state.txs[sig] ?? null),
}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));

import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  BUY_DISCRIMINATOR,
  TAKE_OFFER_DISCRIMINATOR,
  getBuyInstructionDataEncoder,
} from "@/lib/generated/asset_registry";
import { isUnlinkedBuy, UNLINKED_BUY_SOURCE as CLIENT_SOURCE, unlinkedBuyMints } from "@/lib/compliance";
import { OFAC_SDN_SOURCE } from "@/lib/ofac-sdn";
import { processEventJob, type EventJob } from "@/lib/server/onchain-alarms";
import {
  BUY_ACCOUNTS,
  LINK_GRACE_MS,
  UNLINKED_BUY_SOURCE,
  anyVersionCounts,
  buysOf,
  linkVerdict,
  unlinkedBuyDedupKey,
  unlinkedBuySummary,
  versionEffectiveMs,
} from "@/lib/server/onchain-link-check";
import { clearSanctionsCache } from "@/lib/server/sanctions";
import { SOURCE_LABELS } from "@/lib/server/system-alerts";
import { DEVNET_TOS_VERSION, tosVersionFor } from "@/lib/tos-version";
import { buildTx, type Ix } from "./helpers/chain-tx";

const R = ASSET_REGISTRY_PROGRAM_ADDRESS;
const BUYER = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const SECOND = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SALE = "Pc4auCy8Fnwxs7EcFwBGKqV3SudxCKEEDLHbEHujBpK";
const CLASS = "6t3xLqAFPZoE4mzWzxabrKxK8cGoHxAmaCj3MigJpWh5";
const MINT = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const OTHER_MINT = "8yY7nAbZip1FPakFXDh5sTsxhXnxKdSMo4D8Zybf6GbQ";
const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const SIG = "5".repeat(88);
const SIG2 = "6".repeat(88);
const SIG3 = "7".repeat(88);
/** Wallets that never accepted the Terms (fresh). */
const FRESH = [
  "8JouJg4GTs3S9dXjv8HC1CqLS8uaTqz7ahE2hUCf9E4e",
  "F8bsGKzgjHcr6q4NP286XtUYbR7joxkRjcvC2qAxgd7y",
  "4fBwaTZ2dewX6xbwjJKqdHLftveU9xwFJyFBsYt5Z2p8",
];
const CURRENT = tosVersionFor("mainnet");
const OLD = DEVNET_TOS_VERSION;
/** The buy's block time: after the current mainnet version's date. */
const T = Date.parse("2026-10-05T12:00:00Z");
const at = (offsetMs: number) => new Date(T + offsetMs).toISOString();

const buyIx = (buyer: string, units: bigint = BigInt(250), mint: string = MINT, program: string = R): Ix => ({
  program,
  accounts: [buyer, SALE, CLASS, mint],
  data: new Uint8Array(getBuyInstructionDataEncoder().encode({ amount: units })),
});
const job = (over: Partial<EventJob> = {}): EventJob => ({
  id: "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b", network: "mainnet", signature: SIG, source: "webhook", status: "pending",
  attempts: 0, created_at: at(15_000), ...over,
});
const signal = () => AbortSignal.timeout(5_000);
const alerts = () => db.ref!.rows("compliance_alerts").filter((a) => a.source === UNLINKED_BUY_SOURCE);
const jobRow = () => db.ref!.rows("onchain_event_jobs")[0];
const accept = (wallet: string, version: string, createdAt: string) =>
  db.ref!.rows("tos_acceptances").push({ id: `tos-${wallet}-${version}`, wallet, version, created_at: createdAt, source: "wallet-gate" });
const setTx = (instructions: { ix: Ix; inner?: Ix[] }[], blockTime: number | null = T / 1000, err?: unknown) => {
  state.txs[SIG] = buildTx({ signature: SIG, instructions, logs: null, blockTime, ...(err ? { err } : {}) }).tx;
};
/** Another finalized transaction (one buy per wallet, at T) and its job, replacing the queued one. */
const nextTx = (signature: string, buyers: string[]) => {
  state.txs[signature] = buildTx({ signature, instructions: buyers.map((b) => ({ ix: buyIx(b) })), logs: null, blockTime: T / 1000 }).tx;
  db.ref!.rows("onchain_event_jobs")[0] = { ...job({ signature }) };
};
const run = (over: Partial<EventJob> = {}, sb: unknown = db.ref!.client) =>
  processEventJob(job(over), signal(), Date.now() + 5_000, sb as never);
/** After the grace: the next run decides. */
const afterGrace = () => vi.setSystemTime(T + LINK_GRACE_MS + 6_000);

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv("SANCTIONS_SCREENING", "");
  db.ref = memorySupabase();
  db.ref.rpcs.raise_sanctions_hit = (args) => {
    db.ref!.rows("compliance_alerts").push({ ...args });
    return { inserted: true };
  };
  // A fresh sanctions list that does not name the buyers.
  db.ref.rows("sanctions_list_state").push({
    source: OFAC_SDN_SOURCE, published_on: "2026-10-01", address_count: 1,
    refreshed_at: at(-3_600_000), last_attempt_at: at(-3_600_000), last_status: "ok", last_error: null,
  });
  db.ref.rows("sanctions_addresses").push({
    source: OFAC_SDN_SOURCE, address: SQUADS, currency: "SOL", entry_uid: "90001", entry_name: "Fixture", programs: ["CYBER2"],
  });
  db.ref.rows("onchain_event_jobs").push({ ...job() });
  state.txs = {};
  clearSanctionsCache();
  vi.useFakeTimers({ now: T + 30_000, toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("buysOf (pure)", () => {
  it("pins the buy accounts to the IDL's names", () => {
    const idl = JSON.parse(readFileSync("idl/asset_registry.json", "utf8")) as { instructions: { name: string; accounts: { name: string; signer?: boolean }[] }[] };
    const buy = idl.instructions.find((i) => i.name === "buy")!;
    for (const [name, index] of Object.entries(BUY_ACCOUNTS)) expect(buy.accounts[index]?.name, name).toBe(name);
    expect(buy.accounts[BUY_ACCOUNTS.buyer].signer).toBe(true);
  });

  it("finds top-level and CPI buys of the registry only, decodes the units and groups them by buyer", () => {
    const { tx } = buildTx({
      signature: SIG,
      instructions: [
        { ix: buyIx(BUYER, BigInt(10)) },
        { ix: { program: SQUADS, accounts: [SECOND], data: new Uint8Array([0]) }, inner: [buyIx(SECOND, BigInt(7), OTHER_MINT), buyIx(BUYER, BigInt(3))] },
        { ix: buyIx(SECOND, BigInt(99), MINT, SQUADS) },
        { ix: { program: R, accounts: [SECOND, SALE], data: new Uint8Array([...TAKE_OFFER_DISCRIMINATOR, 0]) } },
        { ix: { program: R, accounts: [BUYER, SALE, CLASS, MINT], data: new Uint8Array([...BUY_DISCRIMINATOR, 1, 2]) } },
      ],
    });
    expect(buysOf(tx)).toEqual([
      { buyer: BUYER, buys: [
        { ordinal: 0, via_cpi: false, sale: SALE, share_class: CLASS, mint: MINT, units: "10" },
        { ordinal: 3, via_cpi: true, sale: SALE, share_class: CLASS, mint: MINT, units: "3" },
        { ordinal: 6, via_cpi: false, sale: SALE, share_class: CLASS, mint: MINT, units: null },
      ] },
      { buyer: SECOND, buys: [{ ordinal: 2, via_cpi: true, sale: SALE, share_class: CLASS, mint: OTHER_MINT, units: "7" }] },
    ]);
  });
});

describe("the link rule (pure)", () => {
  const rows = (...r: [string, string, number][]) => r.map(([wallet, version, offset]) => ({ wallet, version, created_at: at(offset) }));

  it("the current version accepted by T + 2 minutes links; later, or another wallet's, does not", () => {
    expect(linkVerdict(rows([BUYER, CURRENT, -86_400_000]), BUYER, T, CURRENT)).toMatchObject({ linked: true });
    expect(linkVerdict(rows([BUYER, CURRENT, 60_000]), BUYER, T, CURRENT)).toMatchObject({ linked: true });
    expect(linkVerdict(rows([BUYER, CURRENT, LINK_GRACE_MS]), BUYER, T, CURRENT)).toMatchObject({ linked: true });
    expect(linkVerdict(rows([BUYER, CURRENT, LINK_GRACE_MS + 1_000]), BUYER, T, CURRENT))
      .toEqual({ linked: false, acceptance: { wallet: BUYER, version: CURRENT, created_at: at(LINK_GRACE_MS + 1_000) } });
    expect(linkVerdict(rows([SECOND, CURRENT, -1]), BUYER, T, CURRENT)).toEqual({ linked: false, acceptance: null });
  });

  it("an older version counts only for a buy before the current version's date or before it was live", () => {
    const old = rows([BUYER, OLD, -86_400_000]);
    expect(linkVerdict(old, BUYER, T, CURRENT)).toMatchObject({ linked: "ask-live" });
    expect(linkVerdict(old, BUYER, T, CURRENT, true)).toMatchObject({ linked: false });
    expect(linkVerdict(old, BUYER, T, CURRENT, false)).toMatchObject({ linked: true });
    const beforeDate = Date.parse(`${CURRENT}T00:00:00Z`) - 1_000;
    expect(linkVerdict(rows([BUYER, OLD, beforeDate - T - 60_000]), BUYER, beforeDate, CURRENT)).toMatchObject({ linked: true });
    expect(versionEffectiveMs("2026-10-02")).toBe(Date.parse("2026-10-02T00:00:00Z"));
    expect(versionEffectiveMs("draft")).toBeNull();
    expect(anyVersionCounts(T, "draft", null)).toBe(false);
    expect(anyVersionCounts(T, "draft", false)).toBe(true);
  });

  it("the summary names the wallet, the units, the sale and the version, within 500 characters", () => {
    const [{ buys }] = buysOf(buildTx({ signature: SIG, instructions: [{ ix: buyIx(BUYER, BigInt(250)) }, { ix: buyIx(BUYER, BigInt(50)) }] }).tx);
    const summary = unlinkedBuySummary(BUYER, buys, CURRENT);
    expect(summary).toContain("DAWS…pMpp bought 300 unit(s) of sale Pc4a…jBpK");
    expect(summary).toContain(`(v${CURRENT})`);
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(unlinkedBuySummary(BUYER, buys, null)).toContain("any version of the Terms");
    // The 0072 dedup format (compliance_alerts_dedup_key_format) holds for the longest signature and wallet.
    expect(unlinkedBuyDedupKey("z".repeat(88), BUYER)).toMatch(/^(onchain|ledger|incident|test):[A-Za-z0-9:._-]{1,200}$/);
  });
});

describe("processEventJob: the platform link of every buy (D2)", () => {
  it("a buyer who accepted the Terms in force before the buy completes without an alert", async () => {
    accept(BUYER, CURRENT, at(-86_400_000));
    setTx([{ ix: buyIx(BUYER) }]);
    expect(await run()).toBe("complete");
    expect(alerts()).toHaveLength(0);
    expect(jobRow()).toMatchObject({ status: "complete", alerts: 0, last_error: null });
  });

  it("an acceptance 60 s after the buy still links it", async () => {
    accept(BUYER, CURRENT, at(60_000));
    setTx([{ ix: buyIx(BUYER) }]);
    afterGrace();
    expect(await run()).toBe("complete");
    expect(alerts()).toHaveLength(0);
  });

  it("not linked: the job waits for the grace (LINK_GRACE), then raises exactly one high alert", async () => {
    // Another wallet accepted the current version before the buy: it was in force.
    accept(SECOND, CURRENT, at(-3_600_000));
    setTx([{ ix: buyIx(BUYER, BigInt(250)), inner: [] }]);
    expect(await run()).toBe("pending");
    expect(jobRow()).toMatchObject({ status: "pending", last_error: "LINK_GRACE", attempts: 1 });
    expect(Date.parse(String(jobRow().next_attempt_at))).toBe(T + LINK_GRACE_MS + 5_000);
    expect(alerts()).toHaveLength(0);

    afterGrace();
    expect(await run({ attempts: 1 })).toBe("complete");
    expect(jobRow()).toMatchObject({ status: "complete", alerts: 1 });
    expect(alerts()).toHaveLength(1);
    const alert = alerts()[0];
    expect(alert).toMatchObject({
      network: "mainnet", wallet: BUYER, client_id: null, source: UNLINKED_BUY_SOURCE, severity: "high", confidence: 100,
      status: "open", tx_signature: SIG, dedup_key: `onchain:${SIG}:unlinked-buy:${BUYER}`, category: null, notify_state: "pending",
    });
    expect(Date.parse(String(alert.next_notify_at))).toBeLessThanOrEqual(Date.now());
    expect(alert.evidence).toEqual({
      check: "platform-link (D2)",
      buyer: BUYER,
      buys: [{ ordinal: 0, via_cpi: false, sale: SALE, share_class: CLASS, mint: MINT, units: "250" }],
      buys_total: 1,
      via_cpi: false,
      block_time: at(0),
      block_time_source: "block",
      grace_seconds: 120,
      terms_version_required: CURRENT,
      terms_accepted: null,
      purchase_recorded: false,
      account_linked: false,
    });
    expect(String(alert.summary)).toContain("Buy by a wallet not linked to the platform");
    // The admin page's helpers read it back.
    expect(isUnlinkedBuy(alert as never)).toBe(true);
    expect(unlinkedBuyMints(alert as never)).toEqual([MINT]);
  });

  it("an acceptance 121 s after the buy is too late: alert, with the late acceptance in the evidence", async () => {
    accept(BUYER, CURRENT, at(121_000));
    setTx([{ ix: buyIx(BUYER) }]);
    afterGrace();
    expect(await run()).toBe("complete");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].evidence).toMatchObject({ terms_accepted: { version: CURRENT, accepted_at: at(121_000) } });
  });

  it("an older version: alert once the current version was live at the buy; none when the buy predates it", async () => {
    accept(BUYER, OLD, at(-30 * 86_400_000));
    setTx([{ ix: buyIx(BUYER) }]);
    afterGrace();
    // Nobody had accepted the current version by the buy: it was not deployed yet.
    expect(await run()).toBe("complete");
    expect(alerts()).toHaveLength(0);

    db.ref!.rows("onchain_event_jobs")[0] = { ...job() };
    accept(SECOND, CURRENT, at(-3_600_000));
    expect(await run()).toBe("complete");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].evidence).toMatchObject({ terms_version_required: CURRENT, terms_accepted: { version: OLD } });

    // A buy before the current version's date (a gap scan after the update) counts any version.
    db.ref!.tables.compliance_alerts = [];
    db.ref!.rows("onchain_event_jobs")[0] = { ...job() };
    setTx([{ ix: buyIx(BUYER) }], Date.parse(`${CURRENT}T00:00:00Z`) / 1000 - 3_600);
    expect(await run()).toBe("complete");
    expect(alerts()).toHaveLength(0);
  });

  it("a purchase record does not clear it (the flags are evidence); a client row becomes the subject client", async () => {
    db.ref!.rows("purchase_evidence_jobs").push({ id: "p1", network: "mainnet", signature: SIG, buyer: BUYER, sale_pubkey: SALE });
    db.ref!.rows("account_wallets").push({ network: "mainnet", wallet: BUYER, account_id: "acc-1" });
    db.ref!.rows("clients").push({ id: "client-1", network: "mainnet", wallet: BUYER, created_at: at(-1) });
    setTx([{ ix: buyIx(BUYER) }]);
    afterGrace();
    expect(await run()).toBe("complete");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ client_id: "client-1" });
    expect(alerts()[0].evidence).toMatchObject({ purchase_recorded: true, account_linked: true });
  });

  it("one alert per (transaction, buyer): a linked co-buyer raises nothing, a CPI buy says so", async () => {
    accept(SECOND, CURRENT, at(-1_000));
    setTx([
      { ix: buyIx(SECOND) },
      { ix: { program: SQUADS, accounts: [BUYER], data: new Uint8Array([0]) }, inner: [buyIx(BUYER, BigInt(4)), buyIx(BUYER, BigInt(6), OTHER_MINT)] },
    ]);
    afterGrace();
    expect(await run()).toBe("complete");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ wallet: BUYER });
    expect(alerts()[0].evidence).toMatchObject({ via_cpi: true, buys_total: 2 });
    expect(unlinkedBuyMints(alerts()[0] as never)).toEqual([MINT, OTHER_MINT]);
  });

  it("idempotent: a rerun keeps one alert, and a concurrent insert's unique violation (23505) counts as raised", async () => {
    setTx([{ ix: buyIx(BUYER) }]);
    afterGrace();
    expect(await run()).toBe("complete");
    db.ref!.rows("onchain_event_jobs")[0] = { ...job() };
    expect(await run()).toBe("complete");
    expect(alerts()).toHaveLength(1);

    db.ref!.tables.compliance_alerts = [];
    db.ref!.rows("onchain_event_jobs")[0] = { ...job() };
    const base = db.ref!.client;
    const conflicting = {
      rpc: base.rpc,
      from: (table: string) => {
        const builder = base.from(table) as Record<string, unknown>;
        if (table !== "compliance_alerts") return builder;
        return { ...builder, insert: () => ({ abortSignal: async () => ({ data: null, error: { code: "23505", message: "duplicate key" } }) }) };
      },
    };
    expect(await run({}, conflicting)).toBe("complete");
    expect(jobRow()).toMatchObject({ status: "complete", alerts: 1 });
  });

  it("one email per wallet: a later unlinked buy while the wallet's alert is open is recorded, not emailed", async () => {
    setTx([{ ix: buyIx(BUYER) }]);
    afterGrace();
    expect(await run()).toBe("complete");
    const first = alerts()[0];
    expect(first).toMatchObject({ notify_state: "pending" });
    expect(first.evidence).not.toHaveProperty("not_emailed");
    // The digest went out; compliance has not resolved the alert yet.
    first.notify_state = "sent";

    nextTx(SIG2, [BUYER]);
    expect(await run({ signature: SIG2 })).toBe("complete");
    expect(alerts()).toHaveLength(2);
    const second = alerts()[1];
    expect(second).toMatchObject({ wallet: BUYER, status: "open", tx_signature: SIG2, notify_state: "skipped", severity: "high" });
    expect(second.evidence).toMatchObject({ buys_total: 1, not_emailed: { reason: "wallet-alert-open", alert_id: first.id } });

    // Resolved: the wallet's next unlinked buy is emailed again.
    first.status = "resolved";
    second.status = "resolved";
    nextTx(SIG3, [BUYER]);
    expect(await run({ signature: SIG3 })).toBe("complete");
    expect(alerts()[2]).toMatchObject({ tx_signature: SIG3, notify_state: "pending" });
  });

  it("a burst (fresh wallets, several buyers in one transaction) keeps one unlinked-buy row in the outbox", async () => {
    const wallets = [BUYER, SECOND, FRESH[0]];
    setTx(wallets.map((w) => ({ ix: buyIx(w) })));
    afterGrace();
    expect(await run()).toBe("complete");
    expect(jobRow()).toMatchObject({ status: "complete", alerts: 3 });
    // Every buyer has its own open alert (the passport gate); one is emailed.
    expect(alerts().map((a) => [a.wallet, a.status, a.notify_state])).toEqual([
      [wallets[0], "open", "pending"], [wallets[1], "open", "skipped"], [wallets[2], "open", "skipped"],
    ]);
    expect(alerts()[1].evidence).toMatchObject({ not_emailed: { reason: "alert-pending", alert_id: alerts()[0].id } });

    // Another fresh wallet in another transaction while that row is still pending: not emailed either.
    nextTx(SIG2, [FRESH[1]]);
    expect(await run({ signature: SIG2 })).toBe("complete");
    expect(alerts()[3]).toMatchObject({ wallet: FRESH[1], notify_state: "skipped" });

    // Once the digest has gone out, the next fresh wallet's row is emailed.
    alerts()[0].notify_state = "sent";
    nextTx(SIG3, [FRESH[2]]);
    expect(await run({ signature: SIG3 })).toBe("complete");
    expect(alerts()[4]).toMatchObject({ wallet: FRESH[2], notify_state: "pending" });
    expect(alerts()[4].evidence).not.toHaveProperty("not_emailed");
  });

  it("the outbox check fails closed: an unreadable alert table retries, nothing is inserted unemailed", async () => {
    setTx([{ ix: buyIx(BUYER) }]);
    afterGrace();
    const base = db.ref!.client;
    let reads = 0;
    // The dedup lookup answers; the coalescing reads fail.
    const flaky = {
      rpc: base.rpc,
      from: (table: string) => {
        if (table !== "compliance_alerts") return base.from(table);
        const builder = base.from(table) as Record<string, unknown>;
        return { ...builder, select: (...args: unknown[]) => {
          reads++;
          if (reads === 1) return (builder.select as (...a: unknown[]) => unknown)(...args);
          const failing: Record<string, unknown> = {};
          for (const m of ["eq", "in", "limit"]) failing[m] = () => failing;
          failing.abortSignal = async () => ({ data: null, error: { code: "XX000", message: "down" } });
          return failing;
        } };
      },
    };
    expect(await run({}, flaky)).toBe("pending");
    expect(jobRow()).toMatchObject({ status: "pending", last_error: "DB_UNAVAILABLE" });
    expect(alerts()).toHaveLength(0);
  });

  it("never decides on an error: an unreadable acceptance table or a failed insert retries (DB_UNAVAILABLE)", async () => {
    setTx([{ ix: buyIx(BUYER) }]);
    afterGrace();
    db.ref!.failReads.add("tos_acceptances");
    expect(await run()).toBe("pending");
    expect(jobRow()).toMatchObject({ status: "pending", last_error: "DB_UNAVAILABLE" });
    db.ref!.failReads.clear();
    db.ref!.failWrites.add("compliance_alerts");
    db.ref!.rows("onchain_event_jobs")[0] = { ...job() };
    expect(await run()).toBe("pending");
    expect(jobRow()).toMatchObject({ status: "pending", last_error: "DB_UNAVAILABLE" });
    expect(alerts()).toHaveLength(0);
  });

  it("a failed transaction raises nothing; a transaction without a buy reads no acceptance", async () => {
    setTx([{ ix: buyIx(BUYER) }], T / 1000, { InstructionError: [0, "Custom"] });
    afterGrace();
    expect(await run()).toBe("complete");
    expect(alerts()).toHaveLength(0);
    db.ref!.rows("onchain_event_jobs")[0] = { ...job() };
    db.ref!.failReads.add("tos_acceptances");
    setTx([{ ix: { program: R, accounts: [BUYER, SALE], data: new Uint8Array([...TAKE_OFFER_DISCRIMINATOR, 0]) } }]);
    expect(await run()).toBe("complete");
  });

  it("devnet: medium; without a block time the job's time is the buy's", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    db.ref!.rows("onchain_event_jobs")[0] = { ...job({ network: "devnet" }) };
    setTx([{ ix: buyIx(BUYER) }], null);
    // The job was queued at T + 15 s: the grace runs from there.
    expect(await run({ network: "devnet" })).toBe("pending");
    expect(Date.parse(String(jobRow().next_attempt_at))).toBe(T + 15_000 + LINK_GRACE_MS + 5_000);
    vi.setSystemTime(T + 15_000 + LINK_GRACE_MS + 6_000);
    expect(await run({ network: "devnet" })).toBe("complete");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ network: "devnet", severity: "medium" });
    // Nobody had accepted the devnet version by then either: any version would have counted.
    expect(alerts()[0].evidence).toMatchObject({ block_time: at(15_000), block_time_source: "job", terms_version_required: "any" });
    expect(String(alerts()[0].summary)).toContain("any version of the Terms");
  });
});

describe("labels and the admin page", () => {
  it("the email label is fixed and minimal (no wallet, no amount); the client and server agree on the source", () => {
    expect(SOURCE_LABELS[UNLINKED_BUY_SOURCE]).toEqual({ label: "Buy by a wallet not linked to the platform", format: "minimal" });
    expect(CLIENT_SOURCE).toBe(UNLINKED_BUY_SOURCE);
  });

  it("isUnlinkedBuy and unlinkedBuyMints reject junk", () => {
    const alert = (over: Row) => ({ source: UNLINKED_BUY_SOURCE, wallet: BUYER, evidence: {}, ...over }) as never;
    expect(isUnlinkedBuy(alert({}))).toBe(true);
    expect(isUnlinkedBuy(alert({ wallet: null }))).toBe(false);
    expect(isUnlinkedBuy(alert({ wallet: "not a wallet" }))).toBe(false);
    expect(isUnlinkedBuy(alert({ source: "ofac-sdn" }))).toBe(false);
    expect(unlinkedBuyMints(alert({ evidence: { buys: "x" } }))).toEqual([]);
    expect(unlinkedBuyMints(alert({ evidence: { buys: [null, 1, { mint: "<script>" }, { mint: MINT }, { mint: MINT }] } }))).toEqual([MINT]);
    expect(unlinkedBuyMints({ evidence: null } as never)).toEqual([]);
  });
});
