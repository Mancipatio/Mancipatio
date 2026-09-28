// Migration 0078 (sanctions screening) on an isolated PostgreSQL built from
// the real migration chain: the list is replaced atomically, an empty list is
// refused and keeps the previous one, a failure is stamped with a code, a hit
// opens one alert per wallet while it is open, and nothing is readable by the
// browser roles. Re-running the migration is a no-op.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, MIGRATIONS_DIR, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const db = new LocalPostgres();
const q = (sql: string) => db.query(sql);
const A = "6t3xLqAFPZoE4mzWzxabrKxK8cGoHxAmaCj3MigJpWh5";
const B = "8yY7nAbZip1FPakFXDh5sTsxhXnxKdSMo4D8Zybf6GbQ";
const C = "B52HDW2t44DGiPVz3UoZtbFsakcKeSUH8CQaQpKeoxWZ";
const SHA = "a".repeat(64);
const list = (...addresses: string[]) =>
  `'${JSON.stringify(addresses.map((address, i) => ({ address, currency: "SOL", entry_uid: String(90000 + i), entry_name: `Fixture ${i}`, programs: ["SDGT"] })))}'::jsonb`;
const replace = (published: string, ...addresses: string[]) =>
  q(`select public.replace_sanctions_list('ofac-sdn', '${published}', 19391, '${SHA}', ${list(...addresses)})::text`);
const hit = (wallet: string) =>
  q(`select public.raise_sanctions_hit('devnet', '${wallet}', 'ofac-sdn', 'OFAC SDN', 'Sanctions screening hit', '{"route":"test"}'::jsonb)->>'inserted'`);

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("sanctions screening (migration 0078)", () => {
  beforeAll(() => {
    db.initialize();
    try {
      q(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
      q(`insert into public.clients(id, network, wallet, display_name, type, kyc_status)
         values ('10000000-0000-4000-8000-000000000001', 'devnet', '${A}', 'Fixture', 'investor', 'pending')`);
    } catch (error) {
      db.close();
      throw error;
    }
  }, 60_000);
  afterAll(() => db.close());

  it("loads a list and stamps its state", () => {
    expect(JSON.parse(replace("2026-09-23", A, B, A))).toMatchObject({ source: "ofac-sdn", addresses: 2, removed: 0 });
    expect(q("select string_agg(address, ',' order by address) from public.sanctions_addresses")).toBe([A, B].sort().join(","));
    expect(q("select published_on||'|'||address_count||'|'||last_status||'|'||(refreshed_at is not null) from public.sanctions_list_state"))
      .toBe("2026-09-23|2|ok|true");
  });

  it("replaces the set: delisted addresses go, new ones come", () => {
    expect(JSON.parse(replace("2026-09-24", B, C))).toMatchObject({ addresses: 2, removed: 1 });
    expect(q("select string_agg(address, ',' order by address) from public.sanctions_addresses")).toBe([B, C].sort().join(","));
  });

  it("refuses an empty list and keeps the previous one", () => {
    expect(() => q(`select public.replace_sanctions_list('ofac-sdn', '2026-09-25', 19391, '${SHA}', '[]'::jsonb)`))
      .toThrow(/without a single address/);
    expect(q("select count(*) from public.sanctions_addresses")).toBe("2");
    expect(q("select published_on::text from public.sanctions_list_state")).toBe("2026-09-24");
  });

  it("stamps a failed attempt with a code, keeping the last good refresh", () => {
    q("select public.record_sanctions_refresh_failure('ofac-sdn', 'HTTP_ERROR')");
    expect(q("select last_status||'|'||last_error||'|'||address_count||'|'||(refreshed_at is not null) from public.sanctions_list_state"))
      .toBe("failed|HTTP_ERROR|2|true");
    expect(() => q("select public.record_sanctions_refresh_failure('ofac-sdn', 'not a code')")).toThrow(/Invalid/);
  });

  it("opens one critical, emailed alert per wallet while it is open, linked to the dossier", () => {
    expect(hit(A)).toBe("true");
    expect(hit(A)).toBe("false");
    expect(q(`select severity||'|'||status||'|'||notify_state||'|'||hit_list||'|'||(client_id is not null)
              from public.compliance_alerts where wallet = '${A}'`)).toBe("critical|open|pending|OFAC SDN|true");
    q(`update public.compliance_alerts set status = 'resolved' where wallet = '${A}'`);
    expect(hit(A)).toBe("true");
    expect(hit(B)).toBe("true");
    expect(q(`select (client_id is null)::text from public.compliance_alerts where wallet = '${B}'`)).toBe("true");
    expect(() => q("select public.raise_sanctions_hit('devnet', 'not-a-wallet', 'ofac-sdn', 'OFAC SDN', 'x', '{}'::jsonb)")).toThrow(/Invalid/);
  });

  it("is service_role only", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["sanctions_addresses", "sanctions_list_state"]) {
        expect(q(`select has_table_privilege('${role}', 'public.${table}', 'SELECT')::text`), `${role} ${table}`).toBe("false");
      }
      for (const fn of [
        "replace_sanctions_list(text, date, integer, text, jsonb)",
        "record_sanctions_refresh_failure(text, text)",
        "raise_sanctions_hit(text, text, text, text, text, jsonb, text)",
      ]) {
        expect(q(`select has_function_privilege('${role}', 'public.${fn}', 'EXECUTE')::text`), `${role} ${fn}`).toBe("false");
      }
    }
    expect(q("select has_function_privilege('service_role', 'public.raise_sanctions_hit(text, text, text, text, text, jsonb, text)', 'EXECUTE')::text"))
      .toBe("true");
  });

  it("is idempotent", () => {
    expect(() => q(readFileSync(join(MIGRATIONS_DIR, "0078_sanctions_screening.sql"), "utf8"))).not.toThrow();
    expect(q("select count(*) from public.sanctions_addresses")).toBe("2");
  });
});
