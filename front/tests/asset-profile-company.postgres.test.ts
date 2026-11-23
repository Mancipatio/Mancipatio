// Migration 0093 (the company behind a token) on an isolated PostgreSQL built
// from the real migration chain: the nine columns are added and stay null on
// existing rows, the CHECKs keep the company fields within their limits, a
// logo is the asset's own file with its hash, and an approval names a file
// and carries both stamps; re-running is a no-op.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, MIGRATIONS_DIR, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const db = new LocalPostgres();
const q = (sql: string) => db.query(sql);
const SHA = "ab".repeat(32);
const set = (assignments: string, asset = "asset-a") => q(`update public.asset_profiles set ${assignments} where asset_pda = '${asset}'`);

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("the company behind a token (migration 0093)", () => {
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
    expect(q(`select count(*) from public.asset_profiles where company_name is null and team is null
      and link_x is null and link_linkedin is null and link_github is null
      and logo_path is null and logo_sha256 is null and logo_approved_at is null and logo_approved_by is null`)).toBe("2");
  });

  it("leaves the table unreadable for the browser roles: no SELECT on the new columns, RLS on with no policy", () => {
    expect(q(`select count(*) from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'asset_profiles' and privilege_type = 'SELECT'
        and column_name in ('company_name', 'team', 'link_x', 'logo_path', 'logo_approved_at', 'logo_approved_by')
        and grantee in ('anon', 'authenticated')`)).toBe("0");
    expect(q("select relrowsecurity from pg_class where oid = 'public.asset_profiles'::regclass")).toBe("t");
    expect(q("select count(*) from pg_policies where schemaname = 'public' and tablename = 'asset_profiles'")).toBe("0");
  });

  it("accepts the company's name, team and links within their limits", () => {
    set(`company_name = 'Mancipatio d.o.o.', team = array['Mladen Rakić — CEO & CTO', 'Vladimir Rajković — Legal'],
         link_x = 'https://x.com/Manci_rwa', link_linkedin = 'https://www.linkedin.com/company/manci', link_github = 'https://github.com/Mancipatio'`);
    expect(q("select cardinality(team) from public.asset_profiles where asset_pda = 'asset-a'")).toBe("2");
    set("company_name = null, team = null, link_x = null, link_linkedin = null, link_github = null");
  });

  it("refuses a blank or over-long name, an empty or over-long team and a link that is not https", () => {
    for (const bad of [
      "company_name = '   '", `company_name = '${"a".repeat(201)}'`,
      "team = array[]::text[]", `team = array[${Array.from({ length: 13 }, (_, i) => `'p${i}'`).join(",")}]`,
      "team = array['Ana', null]", `team = array['${"a".repeat(1441)}']`,
      "link_x = 'http://x.com/a'", "link_github = 'javascript:alert(1)'", `link_linkedin = 'https://linkedin.com/${"a".repeat(300)}'`,
    ]) {
      expect(() => set(bad), bad).toThrow(/asset_profiles_company_fields/);
    }
  });

  it("accepts a logo that is the asset's own file with its hash, and its removal", () => {
    set(`logo_path = 'logos/asset-a/devnet/${SHA}/logo.png', logo_sha256 = '${SHA}'`);
    expect(q("select logo_sha256 from public.asset_profiles where asset_pda = 'asset-a'")).toBe(SHA);
    set("logo_path = null, logo_sha256 = null");
  });

  it("refuses another asset's file, a path elsewhere and a logo without its hash", () => {
    for (const bad of [
      `logo_path = 'logos/asset-b/devnet/${SHA}/logo.png', logo_sha256 = '${SHA}'`,
      `logo_path = 'whitepapers/asset-a/logo.png', logo_sha256 = '${SHA}'`,
      `logo_path = 'https://evil.example/logos/asset-a/logo.png', logo_sha256 = '${SHA}'`,
      `logo_path = 'logos/asset-a/devnet/${SHA}/logo.png'`,
      `logo_path = 'logos/asset-a/devnet/${SHA}/logo.png', logo_sha256 = 'nothex'`,
      `logo_sha256 = '${SHA}'`,
    ]) {
      expect(() => set(bad), bad).toThrow(/asset_profiles_logo_complete/);
    }
  });

  it("an approval names a file and carries both stamps", () => {
    expect(() => set("logo_approved_at = now(), logo_approved_by = 'Admin1'")).toThrow(/asset_profiles_logo_complete/);
    set(`logo_path = 'logos/asset-a/devnet/${SHA}/logo.png', logo_sha256 = '${SHA}'`);
    expect(() => set("logo_approved_at = now()")).toThrow(/asset_profiles_logo_complete/);
    expect(() => set("logo_approved_by = 'Admin1'")).toThrow(/asset_profiles_logo_complete/);
    set("logo_approved_at = now(), logo_approved_by = 'Admin1'");
    // The file cannot go while its approval stays.
    expect(() => set("logo_path = null, logo_sha256 = null")).toThrow(/asset_profiles_logo_complete/);
    set("logo_path = null, logo_sha256 = null, logo_approved_at = null, logo_approved_by = null");
  });

  it("is idempotent", () => {
    expect(() => q(readFileSync(join(MIGRATIONS_DIR, "0093_asset_profile_company.sql"), "utf8"))).not.toThrow();
    expect(q(`select count(*) from pg_constraint where conrelid = 'public.asset_profiles'::regclass
      and conname in ('asset_profiles_company_fields', 'asset_profiles_logo_complete')`)).toBe("2");
  });
});
