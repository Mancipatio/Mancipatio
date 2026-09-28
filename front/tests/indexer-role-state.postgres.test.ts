// 0079 (8.3, v1.0.0-rc): the indexer mirror of the pending role changes and
// the issuer proceeds freezes, on the complete migration chain.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, MIGRATIONS_DIR, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";
import { indexerFixtures, roleStateFixtures } from "./helpers/indexer-fixtures";
import { ALL_INDEXER_ENTITIES, ROLE_STATE_ENTITIES, type DecodedIndexerAccount } from "@/lib/server/indexer-accounts";

const db = new LocalPostgres();
const q = (v: unknown) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const ROLE_TABLES = ROLE_STATE_ENTITIES.map((e) => e.table);
let market: DecodedIndexerAccount[] = [];
let roles: DecodedIndexerAccount[] = [];
function apply(slot: number, values: DecodedIndexerAccount[], closed: string[] = [], network = "devnet") {
  return `select public.apply_indexer_snapshot('${network}',${slot},${q(values)},array[${closed.map((v) => `'${v}'`).join(",")}]::text[],null,2);`;
}
async function decodeAll(fixtures: { table: string; bytes: Uint8Array; address: string | null }[]) {
  return Promise.all(fixtures.map(async (f) => {
    const row = await ALL_INDEXER_ENTITIES.find((e) => e.table === f.table)!.decode(f.bytes, f.address);
    return { table: f.table, row: { ...row, raw: { base64: Buffer.from(f.bytes).toString("base64") } } };
  }));
}

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0079 role-state mirror on the complete migration chain", () => {
  beforeAll(async () => {
    try {
      db.initialize();
      db.query(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
      market = await decodeAll(indexerFixtures());
      roles = await decodeAll(roleStateFixtures());
    } catch (error) { db.close(); throw error; }
  }, 60_000);
  afterAll(() => db.close());
  beforeEach(() => {
    db.query(`truncate ${ALL_INDEXER_ENTITIES.map((e) => `public.${e.table}`).join(",")},public.indexer_account_versions,public.indexer_closed_rows;`);
  });

  it("writes the six role-state tables with typed columns next to the 14 market tables", () => {
    expect(ROLE_TABLES).toEqual(["issuer_freezes", "pending_admins", "authority_proposals", "platform_recoveries",
      "blocklist_authority_proposals", "blocklist_recoveries"]);
    expect(JSON.parse(db.query(apply(20, [...market, ...roles]))).written).toBe(20);
    for (const table of ROLE_TABLES) {
      expect(db.query(`select count(*) from public.${table} where network='devnet' and layout_version=2 and last_slot=20;`), table).toBe("1");
    }
    expect(db.query("select issuer_pda||':'||frozen_at||':'||reason_hash||':'||account_version from public.issuer_freezes;"))
      .toBe(`11111111111111111111111111111111:1234:${"07".repeat(32)}:1`);
    expect(db.query("select proposed_at||':'||eta||':'||expires_at||':'||pg_typeof(eta) from public.pending_admins;")).toBe("1000:2000:3000:bigint");
    expect(db.query("select kind||':'||target||':'||new_authority from public.authority_proposals;"))
      .toBe("0:11111111111111111111111111111111:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    expect(db.query("select platform_pda||':'||eta from public.platform_recoveries;")).toBe("11111111111111111111111111111111:2000");
    // The hook singletons carry no version field.
    expect(db.query("select account_version||':'||expires_at from public.blocklist_authority_proposals;")).toBe("0:3000");
    expect(db.query("select account_version||':'||eta from public.blocklist_recoveries;")).toBe("0:2000");
  });

  it("deletes a row when its account closes, and an older snapshot never resurrects it", () => {
    db.query(apply(20, roles));
    for (const { table, row } of roles) {
      const pda = String(row.pda);
      expect(JSON.parse(db.query(apply(19, [], [pda])))).toMatchObject({ closed: 0, stale: 1 });
      expect(JSON.parse(db.query(apply(21, [], [pda])))).toMatchObject({ closed: 1, deleted: { [table]: [pda] } });
      expect(JSON.parse(db.query(apply(21, [{ table, row }]))).stale).toBe(1);
      expect(db.query(`select count(*) from public.${table};`), table).toBe("0");
      // A new proposal at the same PDA later is a new row.
      db.query(apply(22, [{ table, row }]));
      expect(db.query(`select count(*) from public.${table};`), table).toBe("1");
    }
    // Role-state closures are never archived (0069 archives offers, custody vaults and deals only).
    expect(db.query("select count(*) from public.indexer_closed_rows;")).toBe("0");
  });

  it("rolls the whole batch back on schema drift or a malformed hash", () => {
    const drift = structuredClone(roles); drift[1].row.unexpected = "x";
    expect(() => db.query(apply(20, drift))).toThrow(/missing a decoded column/);
    const bad = structuredClone(roles); bad[0].row.reason_hash = "not-a-hash";
    expect(() => db.query(apply(20, bad))).toThrow(/reason_hash/);
    expect(db.query("select count(*) from public.indexer_account_versions;")).toBe("0");
  });

  it.each(["anon", "authenticated"])("keeps every role-state table away from %s", (role) => {
    db.query(apply(20, roles));
    for (const table of ROLE_TABLES) {
      expect(() => db.query(`set role ${role}; select count(*) from public.${table};`), table).toThrow(/permission denied/);
    }
    expect(() => db.query(`set role ${role}; ${apply(21, roles)}`)).toThrow();
  });

  it("service_role reads them; RLS is on and the 0071 guard is installed", () => {
    db.query(apply(20, roles));
    for (const table of ROLE_TABLES) {
      expect(db.query(`set role service_role; select count(*) from public.${table};`), table).toBe("1");
      expect(db.query(`select relrowsecurity from pg_class where oid='public.${table}'::regclass;`), table).toBe("t");
      expect(db.query(`select count(*) from pg_trigger where tgrelid='public.${table}'::regclass and tgname='manci_network_guard';`), table).toBe("1");
      expect(db.query(`select pg_get_expr(adbin,adrelid) from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
        where d.adrelid='public.${table}'::regclass and a.attname='network';`), table).toBe("deployment_network()");
    }
  });

  it("the devnet project refuses a mainnet row (0071 guard)", () => {
    expect(() => db.query(apply(20, roles, [], "mainnet"))).toThrow(/does not belong/);
    expect(db.query("select count(*) from public.pending_admins;")).toBe("0");
  });

  it("re-applying 0079 keeps the rows and the function", () => {
    db.query(apply(20, [...market, ...roles]));
    db.query(readFileSync(join(MIGRATIONS_DIR, "0079_indexer_role_state.sql"), "utf8"));
    for (const table of ROLE_TABLES) expect(db.query(`select count(*) from public.${table};`), table).toBe("1");
    expect(JSON.parse(db.query(apply(21, [...market, ...roles]))).written).toBe(20);
  });
});
