// Migrations 0070 (deployment identity) and 0071 (network defaults + guard)
// on isolated PostgreSQL clusters built from the real migration chain: one
// devnet project, one mainnet project, and a bare one that has only 0070 and
// no identity row yet. Writes go through `set role service_role`, the role
// the Data API and the edge function use.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import {
  applyMigrations,
  ALL_DYNAMIC_DEFAULT_TABLES,
  DYNAMIC_DEFAULT_TABLES,
  insertDeploymentIdentity,
  MIGRATIONS_DIR,
  SUPABASE_PLATFORM_SQL,
  TEST_PROJECT_REFS,
} from "./helpers/migrations";

const clusters = { devnet: new LocalPostgres(), mainnet: new LocalPostgres() };
const bare = new LocalPostgres();
const migration = (file: string) => readFileSync(join(MIGRATIONS_DIR, file), "utf8");
const script = (file: string) => readFileSync(join(process.cwd(), "scripts/ops", file), "utf8");
const SIGNATURE = "5".repeat(88);
const event = (signature = SIGNATURE) =>
  JSON.stringify([{ signature, slot: 1, block_time: null, ix_name: null, wallets: ["11111111111111111111111111111111"], payload: {} }]);

/** Evaluates every dynamic `network` default as `role`, the way an INSERT does,
 * and returns {table: value}. */
function evaluateDefaults(db: LocalPostgres, role: string): Record<string, string> {
  const out = db.query(`set role ${role};
    create temporary table if not exists evaluated(relname text, value text);
    do $$ declare r record; v text; begin
      for r in select c.relname, pg_get_expr(d.adbin, d.adrelid) as expr
        from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
        join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where n.nspname = 'public' and c.relkind in ('r','p') and a.attname = 'network'
      loop
        execute 'select ' || r.expr into v;
        insert into evaluated values (r.relname, v);
      end loop;
    end $$;
    select coalesce(jsonb_object_agg(relname, value), '{}'::jsonb) from evaluated;`);
  return JSON.parse(out);
}

const defaultsOf = (db: LocalPostgres) =>
  db.query(`select string_agg(distinct pg_get_expr(d.adbin, d.adrelid), ',')
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'public' and a.attname = 'network' and c.relname = any(array[${DYNAMIC_DEFAULT_TABLES.map((t) => `'${t}'`).join(",")}])`);
const guards = (db: LocalPostgres) =>
  Number(db.query("select count(*) from pg_trigger where tgname = 'manci_network_guard' and not tgisinternal"));
const maintenanceRow = (network: string) =>
  `set role service_role; insert into public.platform_maintenance(network, enabled, updated_by) values ('${network}', false, 'test')
    on conflict (network) do update set updated_by = excluded.updated_by returning network`;

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("deployment identity and network guard (0070/0071)", () => {
  beforeAll(() => {
    try {
      for (const [network, db] of Object.entries(clusters) as [keyof typeof clusters, LocalPostgres][]) {
        db.initialize();
        db.query(SUPABASE_PLATFORM_SQL);
        applyMigrations(db, { network });
      }
      bare.initialize();
      bare.query("create role anon; create role authenticated; create role service_role bypassrls;");
      bare.query(migration("0070_deployment_identity.sql"));
    } catch (error) {
      for (const db of [...Object.values(clusters), bare]) db.close();
      throw error;
    }
  }, 120_000);
  afterAll(() => {
    for (const db of [...Object.values(clusters), bare]) db.close();
  });

  it("the identity preflight reports the identity, foreign rows, guards, defaults and browser insert paths", () => {
    const preflight = (db: LocalPostgres) =>
      JSON.parse(db.query(readFileSync(join(process.cwd(), "scripts/preflight/supabase-readonly-identity.sql"), "utf8")));
    for (const network of ["devnet", "mainnet"] as const) {
      const report = preflight(clusters[network]);
      expect(report.identity, network).toMatchObject({ network, project_ref: TEST_PROJECT_REFS[network] });
      expect(report.deployment_network_function).toBe(true);
      expect(report.tables_without_guard).toEqual([]);
      expect(report.defaults_not_dynamic).toEqual({});
      // 0071 does not rewrite history: 0056 seeded both networks' raise limits.
      expect(report.rows_of_other_networks).toEqual({ platform_raise_limits: { other_network: 1, guard_would_refuse: 1 } });
      expect(report.retry_worker_config).toBeNull();
      expect(report.network_tables).toBeGreaterThan(DYNAMIC_DEFAULT_TABLES.length);
      expect(Array.isArray(report.browser_insert_paths)).toBe(true);
    }
    // Before the identity row (and with no network tables at all).
    expect(preflight(bare)).toMatchObject({ identity: null, rows_of_other_networks: {}, tables_without_guard: [], network_tables: 0 });
  });

  it.each(["devnet", "mainnet"] as const)("%s: every dynamic default (0071's 33 and later tables') resolves to the project's network for every API role", (network) => {
    const db = clusters[network];
    for (const role of ["anon", "authenticated", "service_role"]) {
      const values = evaluateDefaults(db, role);
      expect(Object.keys(values).sort(), role).toEqual([...ALL_DYNAMIC_DEFAULT_TABLES].sort());
      expect(new Set(Object.values(values)), role).toEqual(new Set([network]));
    }
    // An actual insert that leaves network out.
    expect(db.query(`set role service_role; insert into public.audit_events(ix_name, actor_wallet, reason)
      values ('set_pause', 'Wallet', 'test') returning network`)).toBe(network);
  });

  it("mainnet accepts only mainnet rows and refuses a network update", () => {
    const db = clusters.mainnet;
    expect(db.query(maintenanceRow("mainnet"))).toBe("mainnet");
    for (const other of ["devnet", "testnet", "localnet"])
      expect(() => db.query(maintenanceRow(other)), other).toThrow(/network \w+ does not belong to this mainnet project/);
    expect(() => db.query("set role service_role; update public.platform_maintenance set network = 'devnet'"))
      .toThrow(/does not belong to this mainnet project/);
    expect(() => db.query(`set role service_role; insert into public.audit_events(network, ix_name, actor_wallet, reason)
      values ('devnet', 'x', 'Wallet', 'test')`)).toThrow(/does not belong/);
    // Updates that leave network alone never fire the guard.
    expect(db.query("set role service_role; update public.platform_maintenance set message = 'ok' returning network")).toBe("mainnet");
  });

  it("devnet refuses mainnet rows and accepts devnet and testnet (a testnet front may share the devnet project)", () => {
    const db = clusters.devnet;
    expect(db.query(maintenanceRow("devnet"))).toBe("devnet");
    expect(db.query(maintenanceRow("testnet"))).toBe("testnet");
    expect(() => db.query(maintenanceRow("mainnet"))).toThrow(/network mainnet does not belong to this devnet project/);
    expect(() => db.query("set role service_role; update public.platform_maintenance set network = 'mainnet' where network = 'testnet'"))
      .toThrow(/does not belong to this devnet project/);
    // 0056's pre-existing 'mainnet' raise-limit row stays; touching other columns is fine.
    expect(db.query("set role service_role; update public.platform_raise_limits set updated_at = now() where network = 'mainnet' returning network"))
      .toBe("mainnet");
  });

  it("stops a misconfigured indexer receiver and retry worker on the mainnet project", () => {
    const db = clusters.mainnet;
    expect(() => db.query(`set role service_role; select public.enqueue_indexer_events('devnet', '${event()}'::jsonb)`))
      .toThrow(/does not belong to this mainnet project/);
    expect(db.query(`set role service_role; select public.enqueue_indexer_events('mainnet', '${event()}'::jsonb)`)).toBe("1");
    // 0072: the lease asserts the deployment network before the guard would refuse the row.
    expect(() => db.query("set role service_role; select public.acquire_retry_worker_lease('devnet', gen_random_uuid(), 120)"))
      .toThrow(/DEPLOYMENT_NETWORK_MISMATCH database=mainnet deployment=devnet/);
    expect(db.query("set role service_role; select public.acquire_retry_worker_lease('mainnet', gen_random_uuid(), 120)")).toBe("t");
    // And the reverse on devnet.
    expect(() => clusters.devnet.query(`set role service_role; select public.enqueue_indexer_events('mainnet', '${event()}'::jsonb)`))
      .toThrow(/does not belong to this devnet project/);
  });

  it("keeps the identity row immutable", () => {
    for (const db of Object.values(clusters)) {
      expect(() => db.query("update mancipatio_ops.deployment_identity set network = 'testnet'")).toThrow(/immutable/);
      expect(() => db.query("delete from mancipatio_ops.deployment_identity")).toThrow(/immutable/);
      expect(() => db.query("truncate mancipatio_ops.deployment_identity")).toThrow(/immutable/);
      expect(() => insertDeploymentIdentity(db, "devnet")).toThrow(/duplicate key/);
    }
    expect(clusters.mainnet.query("select network || '|' || project_ref from mancipatio_ops.deployment_identity"))
      .toBe("mainnet|mainnettestproject01");
  });

  it("without the identity row: deployment_network() raises, 0071 and both rollbacks refuse", () => {
    expect(() => bare.query("select public.deployment_network()")).toThrow(/Deployment identity is not set/);
    expect(() => bare.query(migration("0071_network_guard.sql"))).toThrow(/Insert the deployment identity \(scripts\/ops\/deployment-identity.sql\) before 0071/);
    expect(() => bare.query(script("rollback-0071.sql"))).toThrow(/Rollback refused: the deployment identity is not set/);
    expect(() => bare.query(script("rollback-0071-defaults.sql"))).toThrow(/Rollback refused: the deployment identity is not set/);
    // The row's shape is checked before anything else.
    expect(() => insertDeploymentIdentity(bare, "devnet", "not-a-ref")).toThrow(/check constraint/);
    expect(() => bare.query(readFileSync(join(process.cwd(), "scripts/ops/deployment-identity.sql"), "utf8"), { target_network: "prod", target_ref: "abcdefghij0123456789" }))
      .toThrow(/check constraint/);
    insertDeploymentIdentity(bare, "testnet");
    expect(bare.query("select public.deployment_network()")).toBe("testnet");
    // 0070 is re-runnable and keeps the row.
    bare.query(migration("0070_deployment_identity.sql"));
    expect(bare.query("select public.deployment_network()")).toBe("testnet");
  });

  describe("rollback on the mainnet project", () => {
    it("level 1 drops the guard only: defaults still give mainnet, and a devnet row is no longer refused", () => {
      const db = clusters.mainnet;
      expect(guards(db)).toBeGreaterThan(DYNAMIC_DEFAULT_TABLES.length);
      db.query(script("rollback-0071.sql"));
      expect(guards(db)).toBe(0);
      expect(db.query("select to_regprocedure('mancipatio_ops.enforce_deployment_network()') is null and to_regprocedure('mancipatio_ops.install_network_guards()') is null")).toBe("t");
      expect(db.query(`set role service_role; insert into public.audit_events(ix_name, actor_wallet, reason)
        values ('x', 'Wallet', 'after level 1') returning network`)).toBe("mainnet");
      expect(db.query(maintenanceRow("devnet"))).toBe("devnet");
      expect(defaultsOf(db)).toBe("deployment_network()");
    });

    it("level 2 pins the defaults to the project's own network, never 'devnet'", () => {
      const db = clusters.mainnet;
      db.query(script("rollback-0071-defaults.sql"));
      expect(defaultsOf(db)).toBe("'mainnet'::text");
      expect(db.query(`set role service_role; insert into public.audit_events(ix_name, actor_wallet, reason)
        values ('x', 'Wallet', 'after level 2') returning network`)).toBe("mainnet");
    });

    it("re-applying 0071 restores the dynamic defaults and the guard", () => {
      const db = clusters.mainnet;
      db.query("delete from public.platform_maintenance where network = 'devnet'");
      db.query(migration("0071_network_guard.sql"));
      expect(defaultsOf(db)).toBe("deployment_network()");
      expect(guards(db)).toBeGreaterThan(DYNAMIC_DEFAULT_TABLES.length);
      expect(() => db.query(maintenanceRow("devnet"))).toThrow(/does not belong/);
    });
  });
});
