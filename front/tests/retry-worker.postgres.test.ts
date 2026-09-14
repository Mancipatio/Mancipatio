// Opt-in, real PostgreSQL. Uses a new socket-only cluster, never an existing DB.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
const db = new LocalPostgres();
const FIRST = "10000000-0000-4000-8000-000000000001";
const SECOND = "10000000-0000-4000-8000-000000000002";
const acquire = (owner = FIRST, network = "devnet", ttl = 120) => `select public.acquire_retry_worker_lease('${network}','${owner}',${ttl});`;
const release = (owner = FIRST, network = "devnet") => `select public.release_retry_worker_lease('${network}','${owner}');`;

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0047 worker leases on isolated PostgreSQL", () => {
  beforeAll(() => {
    try {
      db.initialize();
      db.query("create role anon; create role authenticated; create role service_role bypassrls;");
      const migration = readFileSync(join(process.cwd(), "supabase/migrations/0047_indexer_retry.sql"), "utf8");
      const fragment = migration.match(/-- BEGIN retry-worker leases[\s\S]*?-- END retry-worker leases/)?.[0];
      if (!fragment) throw new Error("Worker lease SQL is missing from migration 0047");
      db.query(fragment);
    } catch (error) { db.close(); throw error; }
  }, 30_000);
  afterAll(() => db.close());
  beforeEach(() => db.query("delete from public.retry_worker_leases;"));

  it("collects complete asynchronous query output beyond the pipe buffer", async () => {
    const size = 512 * 1024;
    const expected = "x".repeat(size);
    const results = await Promise.all(Array.from({ length: 4 }, () => db.queryAsync(`select repeat('x', ${size});`)));
    expect(results).toEqual(Array(4).fill(expected));
  });

  it("admits one concurrent worker across separate connections and preserves the lease after restart", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => db.queryAsync(`set role service_role; ${acquire(i % 2 ? FIRST : SECOND)}`)));
    expect(results.filter((v) => v === "t")).toHaveLength(1); expect(results.filter((v) => v === "f")).toHaveLength(7);
    db.stop(); db.start();
    expect(db.query(acquire())).toBe("f"); expect(db.query(acquire(SECOND))).toBe("f");
  });
  it("isolates network leases and prevents another owner from releasing work", () => {
    expect(db.query(acquire())).toBe("t"); expect(db.query(acquire(SECOND, "mainnet"))).toBe("t");
    expect(db.query(release(SECOND))).toBe("f"); expect(db.query(acquire(SECOND))).toBe("f");
    expect(db.query(release())).toBe("t"); expect(db.query(acquire(SECOND))).toBe("t");
  });
  it("permits takeover only after expiry and rejects stale-owner release", () => {
    expect(db.query(acquire())).toBe("t");
    db.query("update public.retry_worker_leases set expires_at=clock_timestamp()-interval '1 second';");
    expect(db.query(acquire(SECOND))).toBe("t"); expect(db.query(release())).toBe("f");
    expect(db.query("select owner from public.retry_worker_leases where network='devnet';")).toBe(SECOND);
  });
  it("rejects invalid network and unsafe lease durations", () => {
    expect(() => db.query(acquire(FIRST, "anything"))).toThrow();
    expect(() => db.query(acquire(FIRST, "devnet", 0))).toThrow();
    expect(() => db.query(acquire(FIRST, "devnet", 301))).toThrow();
    expect(db.query("select count(*) from public.retry_worker_leases;")).toBe("0");
  });
  it.each(["anon", "authenticated"])("denies table and RPC access to %s", (role) => {
    expect(() => db.query(`set role ${role}; select * from public.retry_worker_leases;`)).toThrow();
    expect(() => db.query(`set role ${role}; ${acquire()}`)).toThrow();
    expect(() => db.query(`set role ${role}; ${release()}`)).toThrow();
  });
});
