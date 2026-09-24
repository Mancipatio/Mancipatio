import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import {
  applyMigrations,
  DYNAMIC_DEFAULT_TABLES,
  migrationFiles,
  migrationNumber,
  MIGRATIONS_DIR,
  SUPABASE_PLATFORM_SQL,
} from "./helpers/migrations";
const db = new LocalPostgres();
// Every public table with a `network` column, and its default expression.
const NETWORK_COLUMNS = `select c.relname||'|'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where n.nspname='public' and c.relkind in ('r','p') and a.attname='network' and a.attnum>0 and not a.attisdropped
  order by c.relname`;
const GUARDED = `select c.relname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and t.tgname='manci_network_guard' and not t.tgisinternal order by c.relname`;
describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")(
  "complete repository migration chain on isolated PostgreSQL",
  () => {
    const applied: string[] = [];
    beforeAll(() => {
      try {
        db.initialize();
        // Model the platform-owned Storage schema and default Supabase grants.
        // All application tables/functions are created from actual migrations.
        db.query(SUPABASE_PLATFORM_SQL);
        applied.push(...applyMigrations(db, { network: "devnet" }));
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
      expect(applied).toContain("0062_verified_pledge_totals.sql");
      expect(applied).toContain("0063_operational_retention.sql");
      expect(applied).toContain("0064_platform_pause_flags.sql");
      expect(applied).toContain("0066_sale_capacity.sql");
      expect(applied).toContain("0067_sales_sale_approval.sql");
      expect(applied).toContain("0068_custody_vault_kyc_registry.sql");
      expect(applied).toContain("0069_indexer_closed_rows.sql");
      expect(applied).toContain("0070_deployment_identity.sql");
      expect(applied).toContain("0071_network_guard.sql");
      // One file per migration number: migrations are applied and tracked by
      // number, so a duplicate would be ambiguous ("0063 applied").
      const numbers = applied.map((file) => file.slice(0, 4));
      expect(new Set(numbers).size).toBe(numbers.length);
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
        "sale_capacity_reservations",
        "fx_rates",
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
      db.query(readFileSync(join(MIGRATIONS_DIR, "0061_maintenance_mode.sql"), "utf8"));
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
    it("guards every public network table and leaves no literal network default (0071 rules)", () => {
      const columns = db.query(NETWORK_COLUMNS).split("\n").map((line) => line.split("|"));
      expect(columns.length).toBeGreaterThanOrEqual(DYNAMIC_DEFAULT_TABLES.length);
      // Rule 1: deployment_network() or no default, never a literal.
      for (const [table, fallback] of columns)
        expect(["", "deployment_network()"], `${table} default`).toContain(fallback);
      expect(columns.filter(([, fallback]) => fallback === "deployment_network()").map(([table]) => table).sort())
        .toEqual([...DYNAMIC_DEFAULT_TABLES].sort());
      // Rule 2: every network table carries the guard.
      expect(db.query(GUARDED).split("\n")).toEqual(columns.map(([table]) => table));
      // Re-applying 0070 and 0071 is a no-op that keeps the identity and the guard.
      for (const file of ["0070_deployment_identity.sql", "0071_network_guard.sql"])
        db.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      expect(db.query("select public.deployment_network()")).toBe("devnet");
      expect(db.query(GUARDED).split("\n")).toHaveLength(columns.length);
    });
    it("keeps the deployment identity private while every API role can read the network", () => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(() => db.query(`set role ${role};select * from mancipatio_ops.deployment_identity`)).toThrow(/permission denied/);
        expect(db.query(`set role ${role};select public.deployment_network()`)).toBe("devnet");
        expect(() => db.query(`set role ${role};select mancipatio_ops.install_network_guards()`)).toThrow(/permission denied/);
      }
    });
    it("never seeds a literal network after 0071 (rule 3, source check)", () => {
      for (const file of migrationFiles().filter((f) => migrationNumber(f) > 71)) {
        const source = readFileSync(join(MIGRATIONS_DIR, file), "utf8").replace(/--.*$/gm, "");
        expect(source, file).not.toMatch(/default\s+'(mainnet|devnet|testnet|localnet)'/i);
      }
    });
  },
);

// The same chain on a project whose identity is mainnet. A later migration
// that seeds a literal 'devnet' row (or defaults to one) fails here.
const mainnet = new LocalPostgres();
describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")(
  "complete repository migration chain under a mainnet identity",
  () => {
    let applied: string[] = [];
    beforeAll(() => {
      try {
        mainnet.initialize();
        mainnet.query(SUPABASE_PLATFORM_SQL);
        applied = applyMigrations(mainnet, { network: "mainnet" });
      } catch (error) {
        mainnet.close();
        throw error;
      }
    }, 60_000);
    afterAll(() => mainnet.close());
    it("applies every migration, and every network default resolves to mainnet", () => {
      expect(applied).toEqual(migrationFiles());
      expect(mainnet.query("select public.deployment_network()")).toBe("mainnet");
      expect(mainnet.query(GUARDED).split("\n")).toEqual(
        mainnet.query(NETWORK_COLUMNS).split("\n").map((line) => line.split("|")[0]),
      );
    });
  },
);
