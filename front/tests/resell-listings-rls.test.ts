// resell_listings was readable in full by the browser roles (0025: `using
// (true)`), so a withdrawn, matched or removed post — and its seller contact
// (email / Telegram handle) — stayed public to anyone holding the anon key.
// 0082 scopes the anon/authenticated read to active rows. This pins the
// migration text; tests/otc-mobile-state-resell-rls.postgres.test.ts (opt-in,
// RUN_LOCAL_POSTGRES_TESTS=1) proves it on a real cluster.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrationFiles, migrationNumber } from "./helpers/migrations";

const FILE = "0082_resell_listings_public_scope.sql";
const read = (file: string) => readFileSync(join(MIGRATIONS_DIR, file), "utf8");
/** Every `create policy … on public.resell_listings …;` statement of a file. */
const policiesOn = (sql: string) =>
  sql.match(/create policy[^;]*on public\.resell_listings[^;]*;/g) ?? [];

describe("0082: resell_listings is public only while a listing is active", () => {
  const sql = read(FILE);

  it("is the one 0082 migration, transactional, and says when it may be applied", () => {
    expect(migrationFiles().filter((f) => migrationNumber(f) === 82)).toEqual([FILE]);
    expect(sql).toMatch(/\nbegin;\n/);
    expect(sql.trim().endsWith("commit;")).toBe(true);
    // Order matters: the seller's own history and the admin board read
    // through the anon client until they move to a signed route, and the
    // service role bypasses RLS, so nothing changes for them before that.
    expect(sql).toMatch(/APPLY ONLY AFTER/);
    expect(sql).toMatch(/\/portfolio\/listings/);
    expect(sql).toMatch(/\/admin\/resell/);
    expect(sql).toMatch(/Restore button/);
  });

  it("drops every policy on the table, then recreates exactly one read policy scoped to active rows", () => {
    expect(sql).toMatch(
      /from pg_policies\s+where schemaname = 'public' and tablename = 'resell_listings'/,
    );
    expect(sql).toMatch(
      /execute format\('drop policy %I on public\.resell_listings', p\.policyname\)/,
    );
    expect(sql).toMatch(/alter table public\.resell_listings enable row level security;/);
    const policies = policiesOn(sql);
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatch(
      /^create policy resell_listings_active_read on public\.resell_listings\s+for select to anon, authenticated\s+using \(status = 'active'\);$/,
    );
    // Browser roles never write (every write is a signed route on the
    // service role): no insert, update, delete or all policy, no with check.
    expect(sql).not.toMatch(/for (insert|update|delete|all)\b/);
    expect(sql).not.toMatch(/with check/);
    expect(sql).not.toMatch(/using \(true\)/);
  });

  it("keeps the table-level grants (no column grant: select('*') keeps working) and the service role whole", () => {
    expect(sql).toMatch(/grant select on public\.resell_listings to anon, authenticated;/);
    expect(sql).toMatch(/grant all on public\.resell_listings to service_role;/);
    expect(sql).not.toMatch(/grant select \(/);
    expect(sql).not.toMatch(/\brevoke\b/);
    // No data change: contacts and notes stay for Restore and as evidence.
    expect(sql).not.toMatch(/\b(update|delete from|insert into|truncate) public\.resell_listings/);
  });

  it("replaces 0025's blanket read, and no later migration reopens it", () => {
    expect(policiesOn(read("0025_rls_lockdown.sql"))).toEqual([
      'create policy "resell_listings anon read"\n  on public.resell_listings for select using (true);',
    ]);
    for (const file of migrationFiles().filter((f) => migrationNumber(f) > 82)) {
      for (const policy of policiesOn(read(file))) {
        expect(policy, file).not.toMatch(/using \(true\)/);
      }
    }
  });

  it("matches the public board, which only ever asks for active listings", () => {
    const board = readFileSync(
      join(process.cwd(), "app/(marketing)/markets/resell/resell-board.tsx"),
      "utf8",
    );
    expect(board).toContain('listResellListings({ status: "active" })');
    expect(board).not.toMatch(/listResellListings\(\)/);
  });
});
