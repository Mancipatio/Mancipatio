import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";

// 0064 on a database that already holds Platform rows: its paused -> bit0
// backfill must not abort on a pre-0047 (legacy, non-v2) row, which the 0047
// stale-slot trigger refuses to UPDATE, and must copy `paused` on v2 rows.
const db = new LocalPostgres();
const migration = (file: string) =>
  readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8");
const row = (pda: string, paused: boolean, extra = "") =>
  `insert into public.platforms(pda,network,admin,protocol_treasury,protocol_fee_bps,paused,version${extra ? ",layout_version,last_slot" : ""}) values ('${pda}','devnet','A','T',250,${paused},1${extra});`;
const flags = () =>
  db.query("select string_agg(pda||':'||pause_flags||':'||paused, ',' order by pda) from public.platforms;");

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0064 platforms.pause_flags on pre-existing rows", () => {
  beforeAll(() => {
    try {
      db.initialize();
      db.query("create role anon; create role authenticated; create role service_role bypassrls;");
      for (const file of ["0002_indexer.sql", "0014_asset_profiles.sql", "0015_issuer_profiles.sql", "0037_indexer_integrity.sql", "0038_indexer_composite_key.sql", "0039_indexer_events_wallets.sql", "0040_indexer_kyc.sql", "0042_indexer_deposit_ledgers.sql"]) {
        db.query(migration(file));
      }
      // Indexed before 0047: no layout_version, never re-snapshotted since.
      db.query(row("legacy-paused", true));
      db.query(migration("0047_indexer_retry.sql"));
      db.query(row("v2-paused", true, ",2,5"));
      db.query(row("v2-active", false, ",2,5"));
      // A newer snapshot of this account is already recorded: the trigger
      // skips the update instead of failing.
      db.query(row("v2-superseded", true, ",2,5"));
      db.query("insert into public.indexer_account_versions(network,pda,slot,table_name,closed) values ('devnet','v2-superseded',9,'platforms',false) on conflict (network,pda) do update set slot=9;");
    } catch (error) {
      db.close();
      throw error;
    }
  }, 30_000);
  afterAll(() => db.close());

  it("backfills bit0 on v2 rows and leaves legacy rows to the next snapshot", () => {
    expect(() => db.query(migration("0064_platform_pause_flags.sql"))).not.toThrow();
    expect(flags()).toBe(
      "legacy-paused:0:true,v2-active:0:false,v2-paused:1:true,v2-superseded:0:true",
    );
  });

  it("is re-runnable and keeps the u8 range check", () => {
    expect(() => db.query(migration("0064_platform_pause_flags.sql"))).not.toThrow();
    expect(flags()).toContain("v2-paused:1:true");
    expect(() =>
      db.query("update public.platforms set pause_flags=256,last_slot=6 where pda='v2-active';"),
    ).toThrow(/check constraint/);
    db.query("update public.platforms set pause_flags=255,last_slot=6 where pda='v2-active';");
    expect(db.query("select pause_flags from public.platforms where pda='v2-active';")).toBe("255");
  });
});
