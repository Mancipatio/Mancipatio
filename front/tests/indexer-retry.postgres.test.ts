import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { LocalPostgres } from "./helpers/local-postgres";
import { indexerFixtures } from "./helpers/indexer-fixtures";
import { INDEXER_ENTITIES, type DecodedIndexerAccount } from "@/lib/server/indexer-accounts";
const db = new LocalPostgres();
const q = (v: unknown) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const OWNER = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const sig = "2".repeat(88);
let rows: DecodedIndexerAccount[] = [];
function apply(slot: number, values = rows, closed: string[] = [], network = "devnet") {
  return `select public.apply_indexer_snapshot('${network}',${slot},${q(values)},array[${closed.map((v) => `'${v}'`).join(",")}]::text[],null,2);`;
}
const batch = (signature = sig) => [{ signature, slot: 10, block_time: null, ix_name: "TEST", wallets: [String(rows[0].row.pda)], payload: { signature } }];
const enqueue = (events = batch(), network = "devnet") => `select public.enqueue_indexer_events('${network}',${q(events)});`;
const claim = (owner = OWNER) => `select id from public.claim_indexer_jobs('devnet','${owner}',1,90);`;
function finish(id: string, complete: boolean, owner = OWNER) { return `select public.finish_indexer_job('${id}','${owner}',${complete},'RPC unavailable');`; }

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0047 complete snapshot and durable queue on isolated PostgreSQL", () => {
  beforeAll(async () => {
    try {
      db.initialize(); db.query("create role anon; create role authenticated; create role service_role bypassrls;");
      for (const file of ["0002_indexer.sql", "0014_asset_profiles.sql", "0015_issuer_profiles.sql", "0037_indexer_integrity.sql", "0038_indexer_composite_key.sql", "0039_indexer_events_wallets.sql", "0040_indexer_kyc.sql", "0042_indexer_deposit_ledgers.sql", "0047_indexer_retry.sql", "0064_platform_pause_flags.sql", "0067_sales_sale_approval.sql", "0068_custody_vault_kyc_registry.sql"]) {
        db.query(readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8"));
      }
      for (const fixture of indexerFixtures()) {
        const row = await INDEXER_ENTITIES.find((e) => e.table === fixture.table)!.decode(fixture.bytes, fixture.address);
        rows.push({ table: fixture.table, row: { ...row, raw: { base64: Buffer.from(fixture.bytes).toString("base64") } } });
      }
    } catch (error) { db.close(); throw error; }
  }, 30_000);
  afterAll(() => { db.close(); rows = []; });
  beforeEach(() => {
    db.query(`truncate ${INDEXER_ENTITIES.map((e) => `public.${e.table}`).join(",")},public.indexer_account_versions,public.indexer_jobs,public.indexer_events,public.indexer_sync_state,public.asset_profiles,public.issuer_profiles;`);
  });
  it("inserts and refreshes full generated typed rows in every existing mirror", () => {
    expect(JSON.parse(db.query(apply(20))).written).toBe(14);
    expect(JSON.parse(db.query(apply(21))).written).toBe(14);
    expect(db.query("select lifetime_minted||':'||cumulative_cap||':'||last_slot from public.share_classes;")).toBe("44:true:21");
    expect(db.query("select deposited from public.offers;")).toBe("8");
    expect(db.query("select pause_flags||':'||paused from public.platforms;")).toBe("12:true");
    for (const { table } of rows) expect(db.query(`select count(*) from public.${table} where layout_version=2;`)).toBe("1");
  });
  it("keeps newest slots and closure tombstones even when old snapshots finish later", async () => {
    db.query(apply(20)); const pda = String(rows[0].row.pda);
    expect(JSON.parse(db.query(apply(19))).stale).toBe(14);
    db.query(apply(22, [], [pda]));
    expect(JSON.parse(db.query(apply(21, [rows[0]]))).stale).toBe(1);
    expect(JSON.parse(db.query(apply(22, [rows[0]]))).stale).toBe(1);
    expect(db.query("select count(*) from public.platforms;")).toBe("0");
    await Promise.all([db.queryAsync(apply(23, [rows[0]])), db.queryAsync(apply(24, [], [pda]))]);
    expect(db.query("select closed||':'||slot from public.indexer_account_versions where table_name is null;")).toBe("true:24");
    expect(db.query("select count(*) from public.platforms;")).toBe("0");
    db.query(apply(25, [rows[0]])); expect(db.query("select count(*) from public.platforms;")).toBe("1");
  });
  it("does not delete newer snapshots and reports only actual deletions", () => {
    db.query(apply(30)); const pda = String(rows[0].row.pda);
    const stale = JSON.parse(db.query(apply(29, [], [pda]))); expect(stale).toMatchObject({ closed: 0, stale: 1, deleted: {} });
    const removed = JSON.parse(db.query(apply(31, [], [pda]))); expect(removed).toMatchObject({ closed: 1, deleted: { platforms: [pda] } });
    expect(JSON.parse(db.query(apply(31, [], [pda]))).closed).toBe(0);
  });
  it("rolls back a complete batch on schema drift or legacy financial layout", () => {
    const bad = structuredClone(rows); bad[13].row.unknown_column = "schema mismatch";
    expect(() => db.query(apply(20, bad))).toThrow(/missing a decoded column/);
    expect(db.query("select count(*) from public.indexer_account_versions;")).toBe("0");
    const legacy = structuredClone(rows[3]); legacy.row.account_version = 1;
    expect(() => db.query(apply(20, [legacy]))).toThrow(/unknown ledger/);
  });
  it("keeps legacy share-class balances as read-only with unknown cumulative issuance", () => {
    const legacy = structuredClone(rows[3]); legacy.row.account_version = 1; legacy.row.readonly_legacy = true;
    legacy.row.lifetime_minted = null; legacy.row.cumulative_cap = null;
    db.query(apply(20, [legacy]));
    expect(db.query("select account_version||':'||readonly_legacy||':'||circulating_supply from public.share_classes;")).toBe("1:true:9");
    expect(db.query("select lifetime_minted is null and cumulative_cap is null from public.share_classes;")).toBe("t");
    db.query(apply(21, [rows[3]]));
    expect(db.query("select account_version||':'||readonly_legacy||':'||lifetime_minted from public.share_classes;")).toBe("2:false:44");
  });
  it("enqueues events and jobs atomically, deduplicates delivery and persists after restart", async () => {
    const result = await Promise.all([db.queryAsync(enqueue()), db.queryAsync(enqueue())]); expect(result).toEqual(["1", "1"]);
    expect(db.query("select count(*) from public.indexer_events;")).toBe("1"); expect(db.query("select count(*) from public.indexer_jobs;")).toBe("1");
    const malformed = [...batch("3".repeat(88)), ...batch("invalid")];
    expect(() => db.query(enqueue(malformed))).toThrow(); expect(db.query("select count(*) from public.indexer_jobs;")).toBe("1");
    db.stop(); db.start(); expect(db.query("select status||':'||attempts from public.indexer_jobs;")).toBe("pending:0");
  });
  it("leases one worker, retries pending failures and acknowledges events only after completion", () => {
    db.query(enqueue()); const id = db.query(claim()); expect(id).toMatch(/^[a-f0-9-]{36}$/); expect(db.query(claim(OTHER))).toBe("");
    expect(db.query(finish(id, true, OTHER))).toBe("f"); expect(db.query(finish(id, false))).toBe("t");
    expect(db.query("select decoded from public.indexer_events;")).toBe("f"); expect(db.query(claim())).toBe("");
    db.query("update public.indexer_jobs set next_attempt_at=now()-interval '1 second';"); expect(db.query(claim())).toBe(id);
    expect(db.query(finish(id, true))).toBe("t"); expect(db.query("select decoded from public.indexer_events;")).toBe("t");
    expect(db.query("select status||':'||attempts from public.indexer_jobs;")).toBe("complete:2");
  });
  it("isolates identical PDAs and signatures across networks, including profiles", () => {
    db.query(apply(20)); db.query(apply(30, rows, [], "mainnet"));
    expect(db.query("select count(*) from public.platforms;")).toBe("2");
    db.query(enqueue()); db.query(enqueue(batch(), "mainnet")); expect(db.query("select count(*) from public.indexer_jobs;")).toBe("2");
    db.query("insert into public.asset_profiles(network,asset_pda,category) values('devnet','same','equity'),('mainnet','same','equity'); insert into public.issuer_profiles(network,issuer_pda) values('devnet','same'),('mainnet','same');");
    expect(db.query("select count(*) from public.asset_profiles;")).toBe("2"); expect(db.query("select count(*) from public.issuer_profiles;")).toBe("2");
  });
  it.each(["anon", "authenticated"])("denies job/snapshot mutations and private queue reads for %s", (role) => {
    expect(() => db.query(`set role ${role}; ${enqueue()}`)).toThrow();
    expect(() => db.query(`set role ${role}; ${apply(20)}`)).toThrow();
    expect(() => db.query(`set role ${role}; select * from public.indexer_jobs;`)).toThrow();
    expect(() => db.query(`set role ${role}; select * from public.indexer_account_versions;`)).toThrow();
  });
});
