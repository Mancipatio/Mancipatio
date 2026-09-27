// Migration 0076 (offering exemption) on an isolated PostgreSQL built from the
// real migration chain: the four columns are added, existing rows are valid,
// and the CHECK keeps them all-set or all-null; re-running is a no-op.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, MIGRATIONS_DIR, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const db = new LocalPostgres();
const q = (sql: string) => db.query(sql);

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("offering exemption (migration 0076)", () => {
  beforeAll(() => {
    db.initialize();
    try {
      q(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
      q("insert into public.asset_profiles(network, asset_pda, category) values ('devnet', 'asset-a', 'equity'), ('devnet', 'asset-b', 'equity')");
    } catch (error) {
      db.close();
      throw error;
    }
  }, 60_000);
  afterAll(() => db.close());

  it("adds nullable columns that stay null on existing rows", () => {
    expect(q(`select count(*) from public.asset_profiles where offering_exemption_ref is null
      and offering_exemption_reason is null and offering_exemption_recorded_by is null and offering_exemption_recorded_at is null`)).toBe("2");
  });

  it("accepts a complete exemption and its clearing", () => {
    q(`update public.asset_profiles set offering_exemption_ref = 'Opinion 12/2026',
         offering_exemption_reason = 'Fewer than 20 investors', offering_exemption_recorded_by = 'SuperAdmin1',
         offering_exemption_recorded_at = now() where asset_pda = 'asset-a'`);
    expect(q("select offering_exemption_ref from public.asset_profiles where asset_pda = 'asset-a'")).toBe("Opinion 12/2026");
    q(`update public.asset_profiles set offering_exemption_ref = null, offering_exemption_reason = null,
         offering_exemption_recorded_by = null, offering_exemption_recorded_at = null where asset_pda = 'asset-a'`);
  });

  it("refuses half an exemption", () => {
    expect(() => q("update public.asset_profiles set offering_exemption_ref = 'Opinion 12/2026' where asset_pda = 'asset-b'"))
      .toThrow(/asset_profiles_offering_exemption_complete/);
    expect(() => q(`update public.asset_profiles set offering_exemption_ref = 'Opinion 12/2026',
         offering_exemption_reason = 'Fewer than 20 investors' where asset_pda = 'asset-b'`))
      .toThrow(/asset_profiles_offering_exemption_complete/);
  });

  it("is idempotent", () => {
    expect(() => q(readFileSync(join(MIGRATIONS_DIR, "0076_offering_exemption.sql"), "utf8"))).not.toThrow();
  });
});
