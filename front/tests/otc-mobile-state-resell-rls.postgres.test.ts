// 0082 on a real cluster: after the whole migration chain, the browser roles
// read only active resell listings (so a withdrawn, matched or removed post's
// contact is private), cannot write, and the service role — the signed routes
// behind the admin board and the seller's own history — still sees every row.
// Opt-in, like tests/migration-chain.postgres.test.ts (RUN_LOCAL_POSTGRES_TESTS=1).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const db = new LocalPostgres();
const STATUSES = ["active", "matched", "withdrawn", "removed"] as const;
const insert = (status: string) =>
  `insert into public.resell_listings(network, seller_wallet, mint, asset_label, amount, contact, note, status)
   values ('devnet', 'seller-${status}', 'mint-1', 'Fixture', 10, '${status}@example.com', 'note ${status}', '${status}');`;
/** One psql session per call: the role switch and the statement go together. */
const asRole = (role: string, sql: string) => db.query(`set role ${role}; ${sql}`);
/** A browser-role write must be refused by RLS (or by a missing grant); never applied. */
const denied = (role: string, sql: string) => {
  try {
    asRole(role, sql);
  } catch (error) {
    expect(String(error)).toMatch(/row-level security|permission denied/);
  }
};

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")(
  "0082 resell_listings read scope on isolated PostgreSQL",
  () => {
    beforeAll(() => {
      try {
        db.initialize();
        db.query(SUPABASE_PLATFORM_SQL);
        applyMigrations(db, { network: "devnet" });
        for (const status of STATUSES) db.query(insert(status));
      } catch (error) {
        db.close();
        throw error;
      }
    }, 90_000);
    afterAll(() => db.close());

    it("leaves exactly one policy on the table: the active-only read for the browser roles", () => {
      expect(
        db.query(
          "select policyname||'|'||cmd||'|'||roles::text||'|'||qual from pg_policies where schemaname='public' and tablename='resell_listings' order by policyname",
        ),
      ).toBe("resell_listings_active_read|SELECT|{anon,authenticated}|(status = 'active'::text)");
      expect(
        db.query("select relrowsecurity from pg_class where oid='public.resell_listings'::regclass"),
      ).toBe("t");
    });

    it.each(["anon", "authenticated"])(
      "%s reads the active listing with its contact; matched, withdrawn and removed rows are invisible",
      (role) => {
        expect(
          asRole(role, "select status||'|'||contact from public.resell_listings order by status;"),
        ).toBe("active|active@example.com");
        expect(
          asRole(role, "select count(*) from public.resell_listings where status <> 'active';"),
        ).toBe("0");
      },
    );

    it.each(["anon", "authenticated"])("%s cannot insert, update or delete", (role) => {
      denied(role, insert("active"));
      denied(role, "update public.resell_listings set contact = 'x' where status = 'active';");
      denied(role, "delete from public.resell_listings;");
      expect(asRole("service_role", "select count(*) from public.resell_listings;")).toBe("4");
      expect(
        asRole("service_role", "select count(*) from public.resell_listings where contact = 'x';"),
      ).toBe("0");
    });

    it("the service role (the signed routes) still reads every status", () => {
      expect(
        asRole(
          "service_role",
          "select string_agg(status, ',' order by status) from public.resell_listings;",
        ),
      ).toBe("active,matched,removed,withdrawn");
    });
  },
);
