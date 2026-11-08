// 0088 notification_log on an isolated cluster with the whole migration chain:
// claim_notification() hands one caller per key the right to send (also under
// concurrency), finish_notification() records the outcome once, the guard
// keeps the key immutable, nothing stores an address or a body, and only the
// service role may read the table or run the two functions.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/0088_notification_log.sql"), "utf8");
const REF = "6f9619ff-8b86-4d11-b42d-00c04fc964ff";
const claim = (event = "requested", role = "holder", ref = REF, kind = "conversion") =>
  `select coalesce(public.claim_notification('${kind}','${ref}','${event}','${role}')::text,'null');`;
const finish = (id: string, status: string, error: string | null, source: string | null) =>
  `select public.finish_notification(${id},'${status}',${error === null ? "null" : `'${error}'`},${source === null ? "null" : `'${source}'`});`;

const db = new LocalPostgres();
describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0088 notification log on isolated PostgreSQL", () => {
  beforeAll(() => {
    try {
      db.initialize();
      db.query(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
    } catch (error) { db.close(); throw error; }
  }, 90_000);
  afterAll(() => db.close());
  beforeEach(() => db.query("delete from public.notification_log;"));

  it("claims a key once: the first call gets the id, a retry gets null, another event or role its own row", () => {
    const first = db.query(`set role service_role; ${claim()}`);
    expect(first).toMatch(/^\d+$/);
    expect(db.query(`set role service_role; ${claim()}`)).toBe("null");
    expect(db.query(`set role service_role; ${claim("requested", "operator")}`)).toMatch(/^\d+$/);
    expect(db.query(`set role service_role; ${claim("vault_opened")}`)).toMatch(/^\d+$/);
    expect(db.query("select network||'|'||kind||'|'||event||'|'||recipient_role||'|'||status from public.notification_log order by id"))
      .toBe("devnet|conversion|requested|holder|pending\ndevnet|conversion|requested|operator|pending\ndevnet|conversion|vault_opened|holder|pending");
  });

  it("lets exactly one of many concurrent claims of a key send", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => db.queryAsync(`set role service_role; ${claim("deposited")}`)));
    expect(results.filter((r) => /^\d+$/.test(r))).toHaveLength(1);
    expect(results.filter((r) => r === "null")).toHaveLength(11);
    expect(db.query("select count(*) from public.notification_log")).toBe("1");
  });

  it("records one outcome per claim; a second finish changes nothing", () => {
    const id = db.query(`set role service_role; ${claim()}`);
    expect(db.query(`set role service_role; ${finish(id, "sent", null, "account")}`)).toBe("t");
    expect(db.query(`set role service_role; ${finish(id, "failed", "TIMEOUT", "account")}`)).toBe("f");
    expect(db.query(`select status||'|'||coalesce(error,'-')||'|'||recipient_source||'|'||(finished_at is not null) from public.notification_log where id=${id}`))
      .toBe("sent|-|account|true");
    const skipped = db.query(`set role service_role; ${claim("converted")}`);
    expect(db.query(`set role service_role; ${finish(skipped, "skipped", "NO_RECIPIENT", null)}`)).toBe("t");
    const failed = db.query(`set role service_role; ${claim("returned")}`);
    expect(db.query(`set role service_role; ${finish(failed, "failed", "TIMEOUT", "dossier")}`)).toBe("t");
    expect(db.query("select status||'|'||coalesce(error,'-') from public.notification_log order by id"))
      .toBe("sent|-\nskipped|NO_RECIPIENT\nfailed|TIMEOUT");
  });

  it("refuses an outcome that is not one, an error that is not a class and a sent row without a source", () => {
    const id = db.query(`set role service_role; ${claim()}`);
    expect(() => db.query(`set role service_role; ${finish(id, "pending", null, null)}`)).toThrow(/Invalid notification outcome/);
    expect(() => db.query(`set role service_role; ${finish(id, "bounced", null, null)}`)).toThrow(/Invalid notification outcome/);
    expect(() => db.query(`set role service_role; ${finish(id, "failed", "SMTP 550 user@example.org unknown", "account")}`)).toThrow(/check constraint/);
    expect(() => db.query(`set role service_role; ${finish(id, "failed", null, "account")}`)).toThrow(/notification_log_outcome/);
    expect(() => db.query(`set role service_role; ${finish(id, "sent", null, null)}`)).toThrow(/notification_log_outcome/);
    expect(() => db.query(`set role service_role; ${finish(id, "sent", null, "holder@example.org")}`)).toThrow(/check constraint/);
    expect(db.query(`select status from public.notification_log where id=${id}`)).toBe("pending");
  });

  it("refuses malformed keys without storing anything", () => {
    for (const sql of [
      claim("requested", "admin"),
      claim("Requested"),
      claim("requested", "holder", "holder@example.org"),
      claim("requested", "holder", REF, "Conversion"),
      "select public.claim_notification(null,'x','requested','holder');",
    ]) {
      expect(() => db.query(`set role service_role; ${sql}`)).toThrow();
    }
    expect(db.query("select count(*) from public.notification_log")).toBe("0");
  });

  it("keeps the key immutable and a finished row final, even for the table owner", () => {
    const id = db.query(`set role service_role; ${claim()}`);
    expect(() => db.query(`update public.notification_log set event='converted' where id=${id}`)).toThrow(/key is immutable/);
    expect(() => db.query(`update public.notification_log set ref_id='other' where id=${id}`)).toThrow(/key is immutable/);
    expect(() => db.query(`update public.notification_log set error=null where id=${id}`)).toThrow(/can only leave pending/);
    db.query(`set role service_role; ${finish(id, "sent", null, "contact")}`);
    expect(() => db.query(`update public.notification_log set status='failed', error='TIMEOUT' where id=${id}`)).toThrow(/already sent/);
  });

  it("is guarded to the deployment network and finishes only this network's rows", () => {
    expect(() => db.query(`insert into public.notification_log(network,kind,ref_id,event,recipient_role) values ('mainnet','conversion','${REF}','requested','holder')`))
      .toThrow(/mainnet/);
    expect(db.query("select pg_get_expr(adbin,adrelid) from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum where d.adrelid='public.notification_log'::regclass and a.attname='network'"))
      .toBe("deployment_network()");
    expect(db.query("select count(*) from pg_trigger where tgrelid='public.notification_log'::regclass and tgname='manci_network_guard'")).toBe("1");
  });

  it.each(["anon", "authenticated"])("gives %s nothing: no table, no functions", (role) => {
    expect(() => db.query(`set role ${role}; select * from public.notification_log`)).toThrow(/permission denied/);
    expect(() => db.query(`set role ${role}; ${claim()}`)).toThrow(/permission denied/);
    expect(() => db.query(`set role ${role}; select public.finish_notification(1,'sent',null,'account')`)).toThrow(/permission denied/);
    expect(() => db.query(`set role ${role}; insert into public.notification_log(kind,ref_id,event,recipient_role) values ('conversion','x','requested','holder')`))
      .toThrow(/permission denied/);
  });

  it("lets the service role read and run the functions, but not write the table directly", () => {
    const id = db.query(`set role service_role; ${claim()}`);
    expect(db.query("set role service_role; select count(*) from public.notification_log")).toBe("1");
    expect(() => db.query(`set role service_role; update public.notification_log set status='sent' where id=${id}`)).toThrow(/permission denied/);
    expect(() => db.query("set role service_role; insert into public.notification_log(kind,ref_id,event,recipient_role) values ('conversion','x','requested','holder')"))
      .toThrow(/permission denied/);
    expect(() => db.query(`set role service_role; delete from public.notification_log where id=${id}`)).toThrow(/permission denied/);
    expect(db.query("select relrowsecurity from pg_class where oid='public.notification_log'::regclass")).toBe("t");
    expect(db.query("select bool_and(prosecdef) from pg_proc where proname in ('claim_notification','finish_notification')")).toBe("t");
  });

  it("cannot be redirected through caller-controlled search_path objects", () => {
    expect(db.query(`create temp table notification_log (id bigint); set search_path=pg_temp; ${claim()}`)).toMatch(/^\d+$/);
    expect(db.query("set search_path=public; select count(*) from public.notification_log")).toBe("1");
  });

  it("stores no subject, body, address or wallet", () => {
    expect(db.query(`select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
      where table_schema='public' and table_name='notification_log'`))
      .toBe("id,network,kind,ref_id,event,recipient_role,status,recipient_source,error,created_at,finished_at");
  });

  it("re-applies cleanly and keeps its rows", () => {
    db.query(`set role service_role; ${claim()}`);
    db.query(migration);
    expect(db.query("select count(*) from public.notification_log")).toBe("1");
    expect(db.query(`set role service_role; ${claim()}`)).toBe("null");
  });
});
