import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";

const db = new LocalPostgres();
const key = (n: number) => n.toString(16).padStart(64, "0");
const consume = (hash = key(1), minute = 8, daily = 500) =>
  `select public.consume_assistant_quota('${hash}', ${minute}, ${daily});`;
const dailyCount = () => db.query("select request_count from public.assistant_quota where bucket='day';");

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0083 assistant quota on isolated PostgreSQL", () => {
  beforeAll(() => {
    try {
      db.initialize();
      db.query(`create role anon; create role authenticated; create role service_role bypassrls;
        alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
      db.query(readFileSync(join(process.cwd(), "supabase/migrations/0083_assistant_quota.sql"), "utf8"));
    } catch (error) { db.close(); throw error; }
  }, 30_000);
  afterAll(() => db.close());
  beforeEach(() => db.query("truncate public.assistant_quota;"));

  it("caps concurrent requests from one IP without spending rejected global quota", async () => {
    const results = await Promise.all(Array.from({ length: 16 }, () =>
      db.queryAsync(`set role service_role; ${consume(key(1), 3, 10)}`)));
    expect(results.filter((result) => result === "t")).toHaveLength(3);
    expect(results.filter((result) => result === "f")).toHaveLength(13);
    expect(dailyCount()).toBe("3");
    expect(db.query("select request_count from public.assistant_quota where bucket='minute';")).toBe("3");
  });

  it("enforces the shared daily cap across concurrent independent IPs", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      db.queryAsync(`set role service_role; ${consume(key(index + 1), 1, 7)}`)));
    expect(results.filter((result) => result === "t")).toHaveLength(7);
    expect(results.filter((result) => result === "f")).toHaveLength(13);
    expect(dailyCount()).toBe("7");
    // A rejected new key does not create a row, so flooding cannot grow storage.
    expect(db.query("select count(*) from public.assistant_quota;")).toBe("8");
  });

  it("leaves other visitors' daily capacity intact after an IP hits its limit", () => {
    expect(db.query(consume(key(1), 1, 3))).toBe("t");
    expect(db.query(consume(key(1), 1, 3))).toBe("f");
    expect(dailyCount()).toBe("1");
    expect(db.query(consume(key(2), 1, 3))).toBe("t");
    expect(db.query(consume(key(3), 1, 3))).toBe("t");
    expect(db.query(consume(key(4), 1, 3))).toBe("f");
    expect(dailyCount()).toBe("3");
  });

  it("resets expired windows, prunes their hashes and uses a UTC day in every session timezone", () => {
    db.query(`insert into public.assistant_quota values
      ('minute','${key(1)}',date_trunc('minute',now(),'UTC')-interval '2 minutes',8),
      ('minute','${key(2)}',date_trunc('minute',now(),'UTC')-interval '1 day',8),
      ('day','global',date_trunc('day',now(),'UTC')-interval '1 day',500);`);
    expect(db.query(`set timezone='Pacific/Honolulu'; ${consume()}`)).toBe("t");
    expect(db.query("select count(*) from public.assistant_quota;")).toBe("2");
    expect(dailyCount()).toBe("1");
    expect(db.query("select window_start=date_trunc('day',now(),'UTC') from public.assistant_quota where bucket='day';")).toBe("t");
  });

  it("persists reservations across process restarts", () => {
    expect(db.query(consume(key(1), 8, 1))).toBe("t");
    db.stop(); db.start();
    expect(db.query(consume(key(2), 8, 1))).toBe("f");
    expect(dailyCount()).toBe("1");
  });

  it.each(["anon", "authenticated"])("denies table access and RPC execution to %s", (role) => {
    expect(() => db.query(`set role ${role}; select * from public.assistant_quota;`)).toThrow(/permission denied/);
    expect(() => db.query(`set role ${role}; ${consume()}`)).toThrow(/permission denied/);
    expect(() => db.query(`set role ${role}; insert into public.assistant_quota values ('day','global',now(),0);`)).toThrow(/permission denied/);
  });

  it("allows service-role reservations but no direct table bypass and has RLS enabled", () => {
    expect(db.query(`set role service_role; ${consume()}`)).toBe("t");
    expect(() => db.query("set role service_role; update public.assistant_quota set request_count=0;")).toThrow(/permission denied/);
    expect(() => db.query("set role service_role; select * from public.assistant_quota;")).toThrow(/permission denied/);
    expect(db.query("select relrowsecurity from pg_class where oid='public.assistant_quota'::regclass;")).toBe("t");
    expect(db.query("select prosecdef from pg_proc where oid='public.consume_assistant_quota(text,integer,integer)'::regprocedure;")).toBe("t");
  });

  it("cannot be redirected through caller-controlled search_path objects", () => {
    expect(db.query(`create temp table assistant_quota (request_count integer);
      set search_path=pg_temp; ${consume()}`)).toBe("t");
    expect(dailyCount()).toBe("1");
  });

  it("rejects invalid hashes and limits without storing anything", () => {
    for (const sql of [consume("raw-ip"), consume(key(1), 0), consume(key(1), 61),
      consume(key(1), 8, 0), consume(key(1), 8, 10001),
      "select public.consume_assistant_quota(null,8,500);",
      `select public.consume_assistant_quota('${key(1)}',null,500);`]) {
      expect(() => db.query(sql)).toThrow(/Invalid assistant quota arguments/);
    }
    expect(db.query("select count(*) from public.assistant_quota;")).toBe("0");
  });

  it("stores only the counter identity, window and count", () => {
    expect(db.query(`select column_name from information_schema.columns
      where table_schema='public' and table_name='assistant_quota' order by ordinal_position;`))
      .toBe("bucket\nkey_hash\nwindow_start\nrequest_count");
  });
});
