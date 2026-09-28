// 6.4 indexer resilience (gap 2026-09-28: podaci-infra-9, ops-qa-12): the
// REAL server modules on the REAL migration chain (isolated PostgreSQL, run
// with RUN_LOCAL_POSTGRES_TESTS=1 and POSTGRES_BIN at a PostgreSQL 17
// bin/), against an in-memory chain (tests/helpers/indexer-chain.ts):
//
//   1. Helius redelivers the same transaction (the Edge receiver's handler
//      with the Edge adapter's enqueue): one event, one indexer job, one
//      alarm job, one mirror write; a redelivery after completion reopens
//      nothing.
//   2. A delivery is lost: the freshness heartbeat declines
//      UNINDEXED_SIGNATURE (the mirror is never advertised fresh past the
//      miss), the gap scan enqueues it (source gap-scan), the job repairs
//      the mirror, and the next heartbeat proves the network quiet again.
//   3. Events were missed for good (past Helius's retry window): the full
//      reconcile refreshes the changed account, rebuilds the missing one and
//      deletes the closed one, and marks the index ready at its slot.
//   4. Out of order: an older event's snapshot, read from a lagging node
//      after a newer one was applied, is refused by the stale-slot guard
//      (also against a closure tombstone); a node behind the event's own
//      slot leaves the job pending, and the retry completes it.
//
// Nothing here reaches a network: the RPC and the database are local.
import { getBase58Decoder } from "@solana/kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_NETWORK = "devnet";
  return { chain: null as unknown as import("./helpers/indexer-chain").IndexerChain, sb: null as unknown };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => h.chain.rpc() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => h.sb }));

import * as registry from "@/lib/generated/asset_registry";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import { gapScan } from "@/lib/server/alarm-checks";
import { INDEXER_ENTITIES } from "@/lib/server/indexer-accounts";
import { runIndexerHeartbeat } from "@/lib/server/indexer-heartbeat";
import { reconcileAllIndexerAccounts, reconcileIndexerJobs } from "@/lib/server/indexer-sync";
import { handleIndexerWebhook, type IndexerEvent } from "../supabase/functions/_shared/indexer-webhook";
import { buildTx } from "./helpers/chain-tx";
import { IndexerChain } from "./helpers/indexer-chain";
import { indexerFixtures } from "./helpers/indexer-fixtures";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";
import { pgSupabase } from "./helpers/pg-supabase";

const db = new LocalPostgres();
const sql = (query: string) => db.query(query);
const AR = ASSET_REGISTRY_PROGRAM_ADDRESS;
const TH = TRANSFER_HOOK_PROGRAM_ADDRESS;
const SECRET = "resilience-webhook-secret-0123456789abcdef";
const PAYER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const deadline = () => Date.now() + 20_000;
/** A distinct base58 64-byte signature per n. */
function sig(n: number) {
  const bytes = new Uint8Array(64).fill(3);
  new DataView(bytes.buffer).setUint32(0, n + 1);
  return getBase58Decoder().decode(bytes);
}
const MIRROR = ["platforms", "issuers", "assets", "share_classes", "sales", "custody_vaults", "offers", "proposals",
  "vote_records", "rights_issuances", "milestones", "milestone_claims", "kyc_registries", "kyc_entries",
  "issuer_freezes", "pending_admins", "authority_proposals", "platform_recoveries", "blocklist_authority_proposals", "blocklist_recoveries"];

type Fixture = { table: string; pda: string; bytes: Uint8Array };
let fixtures: Fixture[] = [];
const fixture = (table: string) => fixtures.find((f) => f.table === table)!;
/** The offer fixture with other `deposited` / `amount`: the same PDA, a new state. */
function offer(deposited: number) {
  const decoded = registry.getOfferDecoder().decode(fixture("offers").bytes);
  return { owner: AR, data: new Uint8Array(registry.getOfferEncoder().encode({ ...decoded, deposited: BigInt(deposited), amount: BigInt(deposited) })) };
}
const mirrored = (table: string, pda: string) =>
  sql(`select coalesce((select to_jsonb(t) - 'raw' - 'updated_at' - 'created_at' from public.${table} t where network = 'devnet' and pda = '${pda}')::text, '')`);
const deposited = (pda = fixture("offers").pda) => sql(`select deposited || '@' || last_slot from public.offers where network = 'devnet' and pda = '${pda}'`);
const count = (table: string, where = "true") => Number(sql(`select count(*) from public.${table} where ${where}`));

/** A Helius enhanced-webhook event touching `accounts` (the receiver keeps only public keys). */
const heliusEvent = (signature: string, slot: number, accounts: string[]) => ({
  signature, slot, timestamp: Math.floor(Date.now() / 1000) - 30, type: "UNKNOWN", source: "UNKNOWN",
  accountData: accounts.map((account) => ({ account, nativeBalanceChange: 0, tokenBalanceChanges: [] })),
  instructions: [{ programId: AR, accounts, data: "", innerInstructions: [] }],
});
/** One delivery through the Edge receiver's handler and the Edge adapter's enqueue (helius-webhook/index.ts). */
async function deliver(events: unknown[]) {
  const response = await handleIndexerWebhook(new Request("https://edge.test/functions/v1/helius-webhook", {
    method: "POST", headers: { authorization: SECRET, "content-type": "application/json" }, body: JSON.stringify(events),
  }), {
    secret: SECRET, network: "devnet",
    enqueue: async (batch: IndexerEvent[]) => {
      const { data, error } = await (h.sb as ReturnType<typeof pgSupabase>["client"]).rpc("enqueue_indexer_events", { p_network: "devnet", p_events: batch });
      if (error || typeof data !== "number") throw new Error("Durable enqueue failed");
      return data;
    },
  });
  return response.status;
}
/** A finalized transaction invoking asset_registry on `accounts`, listed under the registry program ID. */
function landed(n: number, slot: number, accounts: string[], ageSeconds = 600) {
  const signature = sig(n);
  const blockTime = Math.floor(Date.now() / 1000) - ageSeconds;
  const { tx } = buildTx({ signature, payer: PAYER, blockTime,
    instructions: [{ ix: { program: AR, accounts, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) } }] });
  h.chain.list([AR], { signature, slot, blockTime, err: null }, { ...tx, slot });
  return signature;
}

function reset() {
  sql(`truncate ${[...MIRROR, "indexer_account_versions", "indexer_closed_rows", "indexer_jobs", "indexer_events", "onchain_event_jobs",
    "indexer_sync_state", "indexer_heartbeat_state", "indexer_heartbeat_watermarks", "alarm_incidents", "compliance_alerts",
    "spv_issuance_jobs", "worker_heartbeats"].map((t) => `public.${t}`).join(", ")} cascade`);
  sql(`insert into public.indexer_heartbeat_state(network, mode) values ('devnet', 'on')`);
  h.chain = new IndexerChain();
  for (const f of fixtures) h.chain.set(f.pda, { owner: AR, data: f.bytes });
  // Program history at and below the first reconcile's slot (the floor).
  h.chain.list([AR], { signature: sig(900), slot: 900, blockTime: Math.floor(Date.now() / 1000) - 7200, err: null });
  h.chain.list([TH], { signature: sig(950), slot: 950, blockTime: Math.floor(Date.now() / 1000) - 7100, err: null });
}
/** The time between two heartbeat runs: the stamps the next run judges by move back. */
const tick = (seconds = 120) => sql(`update public.indexer_heartbeat_state set
  planned_at = planned_at - make_interval(secs => ${seconds}), tip_seen_at = tip_seen_at - make_interval(secs => ${seconds})`);

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("6.4 indexer resilience on the migration chain", () => {
  beforeAll(async () => {
    try {
      db.initialize();
      sql(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
      h.sb = pgSupabase(db).client;
      fixtures = await Promise.all(indexerFixtures().map(async (f) => {
        const row = await INDEXER_ENTITIES.find((e) => e.table === f.table)!.decode(f.bytes, f.address);
        return { table: f.table, pda: String(row.pda), bytes: f.bytes };
      }));
    } catch (error) {
      db.close();
      throw error;
    }
  }, 120_000);
  afterAll(() => db.close());
  beforeEach(() => reset());

  it("1. a redelivered transaction is one event, one job, one alarm job and one mirror write", async () => {
    const P = fixture("offers").pda;
    const S1 = sig(1);
    const body = [heliusEvent(S1, 990, [P, PAYER])];
    // Helius retries a delivery it saw no 2xx for; two may even overlap.
    expect(await Promise.all([deliver(body), deliver(body)])).toEqual([202, 202]);
    expect(await deliver(body)).toBe(202);
    expect(count("indexer_events", `signature = '${S1}'`)).toBe(1);
    expect(count("indexer_jobs", `signature = '${S1}'`)).toBe(1);
    expect(count("onchain_event_jobs", `signature = '${S1}'`)).toBe(1);

    expect(await reconcileIndexerJobs(10, deadline())).toEqual({ complete: 1, pending: 0, invalid: 0 });
    expect(deposited(P)).toBe("8@1000");
    expect(sql(`select status || ':' || attempts from public.indexer_jobs where signature = '${S1}'`)).toBe("complete:1");
    expect(sql(`select decoded from public.indexer_events where signature = '${S1}'`)).toBe("t");
    const snapshots = h.chain.calls.filter((c) => c.method === "getMultipleAccounts").length;

    // Redelivered after completion (a late Helius retry, or a manual resend):
    // nothing reopens, nothing is read or written again.
    h.chain.set(P, offer(3));
    expect(await deliver(body)).toBe(202);
    expect(sql(`select status || ':' || attempts from public.indexer_jobs where signature = '${S1}'`)).toBe("complete:1");
    expect(await reconcileIndexerJobs(10, deadline())).toEqual({ complete: 0, pending: 0, invalid: 0 });
    expect(h.chain.calls.filter((c) => c.method === "getMultipleAccounts")).toHaveLength(snapshots);
    expect(deposited(P)).toBe("8@1000");
    expect(count("onchain_event_jobs")).toBe(1);

    // A batch mixing the old transaction with a new one adds only the new one.
    const S2 = sig(2);
    h.chain.slot = 1_020;
    expect(await deliver([...body, heliusEvent(S2, 1_010, [P, PAYER])])).toBe(202);
    expect(sql("select string_agg(status, ',' order by status) from public.indexer_jobs")).toBe("complete,pending");
    expect(count("indexer_events")).toBe(2);
    expect(count("onchain_event_jobs")).toBe(2);
    expect(await reconcileIndexerJobs(10, deadline())).toMatchObject({ complete: 1, pending: 0 });
    expect(deposited(P)).toBe("3@1020");
  });

  it("2. a lost delivery: the heartbeat declines UNINDEXED_SIGNATURE, the gap scan enqueues it, the job repairs the mirror, the heartbeat proves again", async () => {
    const P = fixture("offers").pda;
    // The index starts from a complete reconcile at slot 1000 (the floor).
    await reconcileAllIndexerAccounts(deadline());
    expect(sql("select status || ':' || last_slot from public.indexer_sync_state where network = 'devnet'")).toBe("ready:1000");
    expect(await runIndexerHeartbeat(deadline())).toMatchObject({ status: "declined", reason: "TIP_BASELINE" });
    tick();

    // A transaction lands (slot 1100) and changes the offer; its delivery is lost.
    h.chain.slot = 1_200;
    h.chain.set(P, offer(5));
    const S3 = landed(3, 1_100, [P, PAYER]);
    const checkedBefore = sql("select checked_at from public.indexer_sync_state where network = 'devnet'");
    expect(await runIndexerHeartbeat(deadline())).toMatchObject({ status: "declined", reason: "UNINDEXED_SIGNATURE" });
    expect(sql("select checked_at from public.indexer_sync_state where network = 'devnet'")).toBe(checkedBefore);
    expect(deposited(P)).toBe("8@1000");

    // The alarm worker's gap scan (window: 20 to 5 minutes ago) finds it.
    const scan = await gapScan(h.sb as never, "devnet", Date.now(), AbortSignal.timeout(10_000));
    expect(scan).toMatchObject({ missing: 1, repaired: 1, ignored: 0, complete: true });
    expect(sql(`select ix_name || ':' || (payload->>'source') || ':' || slot from public.indexer_events where signature = '${S3}'`))
      .toBe("GAP_SCAN:gap-scan:1100");
    expect(sql(`select source from public.onchain_event_jobs where signature = '${S3}'`)).toBe("gap-scan");
    expect(sql(`select status from public.indexer_jobs where signature = '${S3}'`)).toBe("pending");
    // A second scan finds nothing new: the repair is idempotent.
    expect(await gapScan(h.sb as never, "devnet", Date.now(), AbortSignal.timeout(10_000))).toMatchObject({ missing: 0, repaired: 0 });

    // The retry worker's job loop repairs the mirror from the finalized chain.
    expect(await reconcileIndexerJobs(10, deadline())).toMatchObject({ complete: 1, pending: 0 });
    expect(deposited(P)).toBe("5@1200");

    // The next heartbeat run proves the network quiet up to the chain's time.
    tick();
    h.chain.slot = 1_400;
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "bumped" });
    expect(sql("select last_outcome || ':' || coalesce(last_reason, '-') from public.indexer_heartbeat_state")).toBe("bumped:-");
    expect(sql(`select checked_at > '${checkedBefore}'::timestamptz from public.indexer_sync_state where network = 'devnet'`)).toBe("t");
  });

  it("3. events missed past the retry window: the full reconcile refreshes, rebuilds and deletes to the chain's state", async () => {
    const P = fixture("offers").pda;
    const issuer = fixture("issuers").pda;
    const entry = fixture("kyc_entries").pda;
    await reconcileAllIndexerAccounts(deadline());
    expect(count("offers") + count("issuers") + count("kyc_entries")).toBe(3);
    const before = mirrored("kyc_entries", entry);

    // Missed for good: the offer changed, the issuer account was closed, and
    // the KYC entry's row was lost (it exists on chain, not in the mirror).
    h.chain.slot = 2_000;
    h.chain.set(P, offer(2));
    h.chain.set(issuer, null);
    sql(`delete from public.kyc_entries where pda = '${entry}'`);
    const result = await reconcileAllIndexerAccounts(deadline());
    expect(result.slot).toBe(2_000);
    expect(result.report.offers).toMatchObject({ onchain: 1, refreshed: 1, deleted: 0 });
    expect(result.report.issuers).toMatchObject({ onchain: 0, deleted: 1 });
    expect(result.report.kyc_entries).toMatchObject({ onchain: 1, missing: 1, rebuilt: 1 });
    expect(deposited(P)).toBe("2@2000");
    expect(count("issuers")).toBe(0);
    expect(mirrored("kyc_entries", entry).replace(/"last_slot": \d+/, "")).toBe(before.replace(/"last_slot": \d+/, ""));
    expect(sql("select status || ':' || last_slot from public.indexer_sync_state where network = 'devnet'")).toBe("ready:2000");
    // Every mirror row now carries the chain's own bytes.
    for (const f of fixtures.filter((x) => x.table !== "issuers")) {
      const onChain = Buffer.from(h.chain.accounts.get(f.pda)!.data).toString("base64");
      expect(sql(`select raw->>'base64' from public.${f.table} where pda = '${f.pda}'`), f.table).toBe(onChain);
    }
  });

  it("4. out of order: an older snapshot never overwrites a newer row or a closure; a node behind the event retries", async () => {
    const P = fixture("offers").pda;
    await reconcileAllIndexerAccounts(deadline());
    // Two transactions: 1250 (deposited 4) and 1300 (deposited 3). Helius
    // delivers the newer one first; the older one's job then reads a node
    // that has only reached slot 1260.
    const OLD = sig(20);
    const NEW = sig(21);
    h.chain.slot = 1_310;
    h.chain.set(P, offer(3));
    expect(await deliver([heliusEvent(NEW, 1_300, [P, PAYER])])).toBe(202);
    expect(await reconcileIndexerJobs(1, deadline())).toMatchObject({ complete: 1 });
    expect(deposited(P)).toBe("3@1310");
    expect(await deliver([heliusEvent(OLD, 1_250, [P, PAYER])])).toBe(202);
    h.chain.lag(1_260, { [P]: offer(4) });
    expect(await reconcileIndexerJobs(1, deadline())).toMatchObject({ complete: 1 });
    expect(deposited(P)).toBe("3@1310");
    expect(count("indexer_jobs", "status = 'complete'")).toBe(2);

    // A closure (slot 1400) applied first, then a delayed older snapshot that
    // still shows the account: the tombstone keeps it closed.
    const CLOSE = sig(22);
    const LATE = sig(23);
    h.chain.slot = 1_410;
    h.chain.set(P, null);
    expect(await deliver([heliusEvent(CLOSE, 1_400, [P, PAYER])])).toBe(202);
    expect(await reconcileIndexerJobs(1, deadline())).toMatchObject({ complete: 1 });
    expect(count("offers")).toBe(0);
    expect(sql(`select closed || ':' || slot from public.indexer_account_versions where pda = '${P}'`)).toBe("true:1410");
    expect(await deliver([heliusEvent(LATE, 1_350, [P, PAYER])])).toBe(202);
    h.chain.lag(1_360, { [P]: offer(1) });
    expect(await reconcileIndexerJobs(1, deadline())).toMatchObject({ complete: 1 });
    expect(count("offers")).toBe(0);
    expect(count("indexer_closed_rows", "table_name = 'offers'")).toBe(1);

    // A node behind the event's own slot cannot prove anything: the job stays
    // pending (degraded index, retry with backoff), and the retry completes.
    const AHEAD = sig(24);
    h.chain.set(P, offer(6));
    h.chain.slot = 1_500;
    expect(await deliver([heliusEvent(AHEAD, 1_520, [P, PAYER])])).toBe(202);
    expect(await reconcileIndexerJobs(1, deadline())).toMatchObject({ complete: 0, pending: 1 });
    expect(sql(`select status || ':' || attempts || ':' || (last_error is not null) from public.indexer_jobs where signature = '${AHEAD}'`)).toBe("pending:1:true");
    expect(sql("select status from public.indexer_sync_state where network = 'devnet'")).toBe("degraded");
    expect(count("offers")).toBe(0);
    h.chain.slot = 1_530;
    sql(`update public.indexer_jobs set next_attempt_at = now() - interval '1 second' where signature = '${AHEAD}'`);
    expect(await reconcileIndexerJobs(1, deadline())).toMatchObject({ complete: 1 });
    expect(deposited(P)).toBe("6@1530");
    expect(sql("select status from public.indexer_sync_state where network = 'devnet'")).toBe("ready");
  });

  it("the Edge adapter's enqueue refuses another network's batch (0071): the receiver answers 503 and Helius retries", async () => {
    const status = await handleIndexerWebhook(new Request("https://edge.test/", {
      method: "POST", headers: { authorization: SECRET }, body: JSON.stringify([heliusEvent(sig(30), 1_000, [fixture("offers").pda])]),
    }), {
      secret: SECRET, network: "mainnet",
      enqueue: async (batch: IndexerEvent[]) => {
        const { data, error } = await (h.sb as ReturnType<typeof pgSupabase>["client"]).rpc("enqueue_indexer_events", { p_network: "mainnet", p_events: batch });
        if (error || typeof data !== "number") throw new Error("Durable enqueue failed");
        return data;
      },
    });
    expect(status.status).toBe(503);
    expect(count("indexer_events")).toBe(0);
  });
});

