// scripts/ops/assert-target.sql with real psql and several -f files, the way
// scripts/db.sh runs it: a failed assertion must stop psql before the next
// file (here a sentinel insert) runs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, insertDeploymentIdentity, MIGRATIONS_DIR, TEST_PROJECT_REFS } from "./helpers/migrations";

const withIdentity = new LocalPostgres();
const withoutIdentity = new LocalPostgres();
const empty = new LocalPostgres();
const ASSERT = join(process.cwd(), "scripts/ops/assert-target.sql");
let dir = "";
let SENTINEL = "";
let SETTINGS = "";

const vars = (network: string, ref: string, bootstrap = "0") =>
  ({ target_network: network, target_ref: ref, target_origin: "https://www.manci.io", bootstrap });
const sentinels = (db: LocalPostgres) => db.query("select count(*) from public.sentinel");

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("assert-target.sql (real psql, several -f)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "manci-assert-"));
    SENTINEL = join(dir, "sentinel.sql");
    SETTINGS = join(dir, "settings.sql");
    writeFileSync(SENTINEL, "insert into public.sentinel values (1);\n");
    writeFileSync(SETTINGS, "select current_setting('manci.target_network') || '|' || current_setting('manci.target_ref') || '|' || current_setting('manci.bootstrap');\n");
    try {
      for (const db of [withIdentity, withoutIdentity, empty]) {
        db.initialize();
        db.query("create role anon; create role authenticated; create role service_role bypassrls; create table public.sentinel(x int);");
      }
      // 0070 followed by the identity row, as applyMigrations does.
      applyMigrations(withIdentity, { network: "devnet", files: ["0070_deployment_identity.sql"] });
      // 0070 applied, identity not inserted yet: the bootstrap window.
      withoutIdentity.query(readFileSync(join(MIGRATIONS_DIR, "0070_deployment_identity.sql"), "utf8"));
    } catch (error) {
      for (const db of [withIdentity, withoutIdentity, empty]) db.close();
      throw error;
    }
  }, 60_000);
  afterAll(() => {
    for (const db of [withIdentity, withoutIdentity, empty]) db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a matching target passes, runs the following files, and leaves the session settings", () => {
    const result = withIdentity.psql(["-f", ASSERT, "-f", SENTINEL, "-f", SETTINGS], vars("devnet", TEST_PROJECT_REFS.devnet));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n").at(-1)).toBe(`devnet|${TEST_PROJECT_REFS.devnet}|0`);
    expect(sentinels(withIdentity)).toBe("1");
  });

  it.each([
    ["the network", vars("mainnet", TEST_PROJECT_REFS.devnet)],
    ["the project ref", vars("devnet", "otherprojectref00001")],
  ])("a mismatch in %s stops psql before the next file", (_label, v) => {
    const before = sentinels(withIdentity);
    const result = withIdentity.psql(["-f", ASSERT, "-f", SENTINEL], v);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(new RegExp(`Target mismatch: database is devnet \\(${TEST_PROJECT_REFS.devnet}\\)`));
    expect(sentinels(withIdentity)).toBe(before);
  });

  it("bootstrap is refused once the identity exists", () => {
    const before = sentinels(withIdentity);
    const result = withIdentity.psql(["-f", ASSERT, "-f", SENTINEL], vars("devnet", TEST_PROJECT_REFS.devnet, "1"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Bootstrap refused: the identity is already set; unset MANCI_DB_BOOTSTRAP/);
    expect(sentinels(withIdentity)).toBe(before);
  });

  it.each([
    ["0070 applied but no identity row", withoutIdentity],
    ["no 0070 at all", empty],
  ])("without an identity (%s) only bootstrap mode passes", (_label, db) => {
    const refused = db.psql(["-f", ASSERT, "-f", SENTINEL], vars("devnet", TEST_PROJECT_REFS.devnet));
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/No deployment identity/);
    expect(sentinels(db)).toBe("0");
    const bootstrap = db.psql(["-f", ASSERT, "-f", SENTINEL], vars("devnet", TEST_PROJECT_REFS.devnet, "1"));
    expect(bootstrap.status, bootstrap.stderr).toBe(0);
    expect(bootstrap.stderr).toMatch(/BOOTSTRAP MODE: no identity to verify/);
    expect(sentinels(db)).toBe("1");
  });

  it("bootstrap mode then inserts the identity through deployment-identity.sql, after which bootstrap is refused", () => {
    const identity = join(process.cwd(), "scripts/ops/deployment-identity.sql");
    const inserted = withoutIdentity.psql(["-f", ASSERT, "-f", identity], vars("devnet", TEST_PROJECT_REFS.devnet, "1"));
    expect(inserted.status, inserted.stderr).toBe(0);
    expect(withoutIdentity.query("select public.deployment_network()")).toBe("devnet");
    expect(withoutIdentity.psql(["-f", ASSERT, "-f", identity], vars("devnet", TEST_PROJECT_REFS.devnet, "1")).status).not.toBe(0);
    const again = withoutIdentity.psql(["-f", ASSERT, "-f", identity], vars("devnet", TEST_PROJECT_REFS.devnet));
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/duplicate key/);
    expect(() => insertDeploymentIdentity(withoutIdentity, "devnet")).toThrow(/duplicate key/);
  });
});
