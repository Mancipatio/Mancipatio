// Full-reconcile duration benchmark (6.4, podaci-infra-11): the REAL
// reconcileAllIndexerAccounts on the REAL migration chain (an isolated
// PostgreSQL cluster, never a project) against a synthetic chain of N
// program accounts, answered in memory. Offline, opt-in:
//
//   RUN_LOCAL_POSTGRES_TESTS=1 POSTGRES_BIN=<PostgreSQL 17 bin/> \
//     [RECONCILE_BENCH_SIZES=1000,5000,20000] [RECONCILE_BENCH_OUTPUT=<file.json>] \
//     npm run ops:reconcile-bench
//
// Measured per size, for a cold mirror (every row rebuilt) and a warm one
// (every row refreshed): the wall time, the database's own time (psql
// \timing), statement and RPC call counts, and the RPC response bytes. The
// local psql process each statement starts is not a deployment cost, so it
// is taken out (`node_ms` = wall − psql wall). The production estimate adds
// what a laptop cannot measure, as stated parameters (override by env):
//   RECONCILE_BENCH_DB_RTT_MS     per statement, Vercel → PostgREST → Postgres (default 20)
//   RECONCILE_BENCH_RPC_BASE_MS   per RPC call, provider scan + first byte (default 1000)
//   RECONCILE_BENCH_RPC_MBPS      response transfer, MB/s (default 20)
// and checks it against the route's 45 s budget and the 12 s per-RPC-call
// bound (lib/server/indexer-sync.ts signalFor). The live runner
// (scripts/ops/reconcile-index.test.ts, `elapsed_ms`) measures the real thing
// on devnet or mainnet: runbook §16 "6.4 drill".
import { writeFileSync } from "node:fs";
import path from "node:path";
import { getAddressDecoder } from "@solana/kit";
import { afterAll, beforeAll, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_NETWORK = "devnet";
  return { chain: null as unknown as import("../../tests/helpers/indexer-chain").IndexerChain, sb: null as unknown };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => h.chain.rpc() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => h.sb }));

import * as registry from "@/lib/generated/asset_registry";
import { INDEXER_ENTITIES } from "@/lib/server/indexer-accounts";
import { reconcileAllIndexerAccounts } from "@/lib/server/indexer-sync";
import { IndexerChain } from "../../tests/helpers/indexer-chain";
import { indexerFixtures } from "../../tests/helpers/indexer-fixtures";
import { LocalPostgres } from "../../tests/helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "../../tests/helpers/migrations";
import { pgSupabase, type PgStats } from "../../tests/helpers/pg-supabase";

const AR = registry.ASSET_REGISTRY_PROGRAM_ADDRESS;
const SIZES = (process.env.RECONCILE_BENCH_SIZES ?? "1000,5000,20000").split(",").map((s) => Number(s.trim()));
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
  return v;
};
const MODEL = {
  dbRttMs: num("RECONCILE_BENCH_DB_RTT_MS", 20),
  rpcBaseMs: num("RECONCILE_BENCH_RPC_BASE_MS", 1_000),
  rpcMBps: num("RECONCILE_BENCH_RPC_MBPS", 20),
};
const BUDGET_MS = 45_000;
const RPC_CALL_BOUND_MS = 12_000;

/**
 * The account mix of a grown mainnet registry: KYC entries (one per verified
 * holder) and offers dominate, and 30 % are program accounts the mirror does
 * not keep (claim records here) that the complete scan still downloads.
 */
const MIX: { table: string | null; share: number }[] = [
  { table: "kyc_entries", share: 0.35 }, { table: "offers", share: 0.15 }, { table: "vote_records", share: 0.1 },
  { table: "milestone_claims", share: 0.05 }, { table: "custody_vaults", share: 0.02 }, { table: "sales", share: 0.02 },
  { table: "share_classes", share: 0.01 }, { table: null, share: 0.3 },
];

const randomAddress = () => getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));
type Variant = (i: number) => Record<string, unknown>;
const CODECS: Record<string, { enc: () => { encode(v: never): ArrayLike<number> }; dec: () => { decode(b: Uint8Array): unknown }; vary: Variant }> = {
  kyc_entries: { enc: registry.getKycEntryEncoder, dec: registry.getKycEntryDecoder, vary: () => ({ holder: randomAddress() }) },
  offers: { enc: registry.getOfferEncoder, dec: registry.getOfferDecoder, vary: (i) => ({ offerId: BigInt(i) }) },
  vote_records: { enc: registry.getVoteRecordEncoder, dec: registry.getVoteRecordDecoder, vary: () => ({ voter: randomAddress() }) },
  milestone_claims: { enc: registry.getMilestoneClaimEncoder, dec: registry.getMilestoneClaimDecoder, vary: () => ({ claimer: randomAddress() }) },
  custody_vaults: { enc: registry.getCustodyVaultEncoder, dec: registry.getCustodyVaultDecoder, vary: (i) => ({ vaultId: BigInt(i) }) },
  sales: { enc: registry.getSaleEncoder, dec: registry.getSaleDecoder, vary: (i) => ({ saleId: BigInt(i) }) },
  share_classes: { enc: registry.getShareClassEncoder, dec: registry.getShareClassDecoder, vary: () => ({ asset: randomAddress() }) },
};

/** N synthetic registry accounts in the MIX, each a valid mirrored layout at its derived PDA (or an unmirrored claim record). */
async function syntheticAccounts(n: number) {
  const base = new Map(indexerFixtures().map((f) => [f.table, f.bytes]));
  const out: { address: string; data: Uint8Array }[] = [];
  for (const { table, share } of MIX) {
    const count = Math.round(n * share);
    for (let i = 0; i < count; i++) {
      if (table === null) {
        const data = crypto.getRandomValues(new Uint8Array(registry.getClaimRecordSize()));
        data.set(registry.getClaimRecordDiscriminatorBytes(), 0);
        out.push({ address: randomAddress(), data });
        continue;
      }
      const codec = CODECS[table];
      const value = { ...(codec.dec().decode(base.get(table)!) as object), ...codec.vary(i + 1) };
      const data = Uint8Array.from(codec.enc().encode(value as never));
      const row = await INDEXER_ENTITIES.find((e) => e.table === table)!.decode(data, null);
      out.push({ address: String(row.pda), data });
    }
  }
  return out;
}

const db = new LocalPostgres();
const results: Record<string, unknown>[] = [];
let pg: ReturnType<typeof pgSupabase>;

function snapshot(stats: PgStats) {
  return { calls: stats.calls, ms: stats.ms, wallMs: stats.wallMs };
}

async function measure(n: number, run: "cold" | "warm") {
  const before = snapshot(pg.stats);
  const rpcBefore = h.chain.calls.length;
  const started = performance.now();
  const result = await reconcileAllIndexerAccounts(Date.now() + 30 * 60_000);
  const wall = performance.now() - started;
  const db = { calls: pg.stats.calls - before.calls, ms: pg.stats.ms - before.ms, wallMs: pg.stats.wallMs - before.wallMs };
  const rpc = h.chain.calls.slice(rpcBefore);
  const rpcBytes = rpc.reduce((s, c) => s + c.bytes, 0);
  const largest = Math.max(0, ...rpc.map((c) => c.bytes));
  const nodeMs = wall - db.wallMs;
  const transfer = (bytes: number) => (bytes / (MODEL.rpcMBps * 1_000_000)) * 1_000;
  const projected = nodeMs + db.ms + db.calls * MODEL.dbRttMs + rpc.length * MODEL.rpcBaseMs + transfer(rpcBytes);
  const largestCall = MODEL.rpcBaseMs + transfer(largest);
  const mirrored = Object.values(result.report).reduce((s, r) => s + r.onchain, 0);
  return {
    accounts: n, mirrored, run,
    wall_ms: Math.round(wall), node_ms: Math.round(nodeMs), db_server_ms: Math.round(db.ms), db_calls: db.calls,
    rpc_calls: rpc.length, rpc_bytes: rpcBytes, largest_rpc_bytes: largest,
    projected_ms: Math.round(projected), largest_rpc_call_projected_ms: Math.round(largestCall),
    fits_budget: projected < BUDGET_MS, fits_rpc_call_bound: largestCall < RPC_CALL_BOUND_MS,
  };
}

beforeAll(async () => {
  if (process.env.RUN_LOCAL_POSTGRES_TESTS !== "1") throw new Error("Set RUN_LOCAL_POSTGRES_TESTS=1 and POSTGRES_BIN (PostgreSQL 17 bin/)");
  db.initialize();
  db.query(SUPABASE_PLATFORM_SQL);
  applyMigrations(db, { network: "devnet" });
  pg = pgSupabase(db);
  h.sb = pg.client;
}, 180_000);
/**
 * A straight line through the smallest and the largest cold run: the
 * projected cost per account, and the size at which the projection reaches
 * the 45 s budget (null with fewer than two sizes).
 */
function capacity() {
  const cold = results.filter((r) => r.run === "cold") as { accounts: number; projected_ms: number }[];
  if (cold.length < 2) return null;
  const [a, b] = [cold[0], cold[cold.length - 1]];
  const slope = (b.projected_ms - a.projected_ms) / (b.accounts - a.accounts);
  const intercept = a.projected_ms - slope * a.accounts;
  return { per_account_ms: Number(slope.toFixed(3)), fixed_ms: Math.round(intercept),
    accounts_at_budget: slope > 0 ? Math.floor((BUDGET_MS - intercept) / slope) : null };
}

afterAll(() => {
  db.close();
  const output = process.env.RECONCILE_BENCH_OUTPUT;
  const summary = { schema: "mancipatio-reconcile-bench-v1", model: MODEL, budget_ms: BUDGET_MS, rpc_call_bound_ms: RPC_CALL_BOUND_MS,
    results, capacity: capacity() };
  if (output) writeFileSync(path.resolve(output), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
});

it.each(SIZES)("reconciles %i synthetic program accounts", async (n) => {
  db.query(`truncate ${INDEXER_ENTITIES.map((e) => `public.${e.table}`).join(", ")}, public.indexer_account_versions,
    public.indexer_closed_rows, public.indexer_sync_state cascade`);
  h.chain = new IndexerChain();
  h.chain.slot = 5_000;
  for (const account of await syntheticAccounts(n)) h.chain.set(account.address, { owner: AR, data: account.data });
  results.push(await measure(n, "cold"));
  h.chain.slot = 5_100;
  results.push(await measure(n, "warm"));
}, 30 * 60_000);
