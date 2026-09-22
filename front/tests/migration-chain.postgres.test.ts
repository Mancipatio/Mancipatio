import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
const db = new LocalPostgres();
describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")(
  "complete repository migration chain on isolated PostgreSQL",
  () => {
    const applied: string[] = [];
    beforeAll(() => {
      try {
        db.initialize();
        // Model the platform-owned Storage schema and default Supabase grants.
        // All application tables/functions are created from actual migrations.
        db.query(`create role anon;create role authenticated;create role service_role bypassrls;
        create schema storage;
        create table storage.buckets(id text primary key,name text,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
        create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
        alter table storage.objects enable row level security;
        grant usage on schema public,storage to anon,authenticated,service_role;
        alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
        alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
        grant all on storage.objects,storage.buckets to service_role;
        grant all on storage.objects to anon,authenticated;`);
        const dir = join(process.cwd(), "supabase/migrations");
        for (const file of readdirSync(dir)
          .filter((f) => /^\d+.*\.sql$/.test(f))
          .sort()) {
          try {
            db.query(readFileSync(join(dir, file), "utf8"));
            applied.push(file);
          } catch (error) {
            throw new Error(
              `Migration ${file} failed: ${error instanceof Error ? error.message : error}`,
            );
          }
        }
      } catch (error) {
        db.close();
        throw error;
      }
    }, 60_000);
    afterAll(() => db.close());
    it("applies every actual migration in order", () => {
      expect(applied[0]).toBe("0001_audit_events.sql");
      expect(applied).toContain("0049_launchpad_network_links.sql");
      expect(applied).toContain("0061_maintenance_mode.sql");
      expect(
        db.query(
          "select count(*) from information_schema.tables where table_schema='public'",
        ),
      ).not.toBe("0");
    });
    it("keeps sensitive tables unreadable to browser roles after the entire chain", () => {
      for (const table of [
        "clients",
        "client_documents",
        "otc_requests",
        "audit_events",
        "vesting_series",
        "document_uploads",
        "document_versions",
        "purchase_evidence_jobs",
        "payout_snapshots",
        "distribution_plans",
      ]) {
        for (const role of ["anon", "authenticated"]) {
          const privileges = db.query(
            `select has_table_privilege('${role}','public.${table}','SELECT')`,
          );
          if (privileges === "t") {
            expect(
              db.query(
                `select relrowsecurity from pg_class where oid='public.${table}'::regclass`,
              ),
            ).toBe("t");
            expect(
              db.query(
                `select count(*) from pg_policies where schemaname='public' and tablename='${table}' and cmd in ('SELECT','ALL') and roles && array['public','${role}']::name[] and coalesce(qual,'true') <> 'false'`,
              ),
            ).toBe("0");
          } else
            expect(() =>
              db.query(`set role ${role};select * from public.${table}`),
            ).toThrow(/permission denied/);
        }
      }
    });
    it("publishes the maintenance flag read-only, without the operator, and re-applies cleanly", () => {
      const table = "public.platform_maintenance";
      db.query(readFileSync(join(process.cwd(), "supabase/migrations/0061_maintenance_mode.sql"), "utf8"));
      db.query(`set role service_role;insert into ${table}(network,enabled,message,updated_by) values ('devnet',true,'Upgrade','ops')`);
      for (const role of ["anon", "authenticated"]) {
        expect(db.query(`set role ${role};select network,enabled,message from ${table}`)).toBe("devnet|t|Upgrade");
        expect(() => db.query(`set role ${role};select updated_by from ${table}`)).toThrow(/permission denied/);
        for (const write of [
          `insert into ${table}(network) values ('mainnet')`,
          `update ${table} set enabled=false`,
          `delete from ${table}`,
        ])
          expect(() => db.query(`set role ${role};${write}`)).toThrow(/permission denied/);
      }
      expect(() => db.query(`insert into ${table}(network) values ('prod')`)).toThrow(/check constraint/);
      expect(() => db.query(`update ${table} set message=repeat('x',501)`)).toThrow(/check constraint/);
      db.query(`delete from ${table}`);
    });
  },
);
