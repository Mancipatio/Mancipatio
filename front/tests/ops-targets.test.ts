// Explicit ops targets (Talas 4.3 §5): scripts/ops/targets.json, target.mjs,
// and the shell tools that resolve a target through it (db.sh,
// maintenance.sh, backup.sh, supabase.sh). The shell tools run for real in a
// sandbox copy of front/ whose PATH holds stub psql / pg_dump / pg_restore /
// age / supabase binaries that only record how they were called: nothing
// here reaches a database or the network.
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  loadTargets, resolveTarget, targetLine, TargetError, validateTargets,
} from "../scripts/ops/target.mjs";
import {
  applyReconcileEnv, otherNetwork, reconcileRpcUrl, reconcileTarget, smokeTarget,
} from "../scripts/ops/live-targets";

const FRONT = process.cwd();
const REAL_TARGETS = JSON.parse(readFileSync(join(FRONT, "scripts/ops/targets.json"), "utf8"));
const DEVNET_REF = "gvnckuzmuwozlcohtuhx";
const DEVNET_HOST = "aws-0-eu-west-1.pooler.supabase.com";
const MAINNET_REF = "mainnetprojectref001";
const MAINNET_HOST = "aws-1-eu-west-1.pooler.supabase.com";
const AGE_KEY = `age1${"q".repeat(58)}`;
/** A configured mainnet next to the real devnet target (only in sandboxes). */
const CONFIGURED = {
  ...REAL_TARGETS,
  mainnet: {
    network: "mainnet", projectRef: MAINNET_REF, poolerHost: MAINNET_HOST, poolerPort: 5432,
    siteOrigin: "https://mainnet.manci.test", backupAgeRecipient: null,
  },
};

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

const STUB = `#!/bin/bash
name="$(basename "$0")"
# One write per call: stubs run concurrently in pipelines (pg_dump | age), and
# several small writes to the shared log interleave between processes.
line="$name"
for a in "$@"; do line="$line"$'\\t'"$a"; done
line="$line"$'\\t'"ENV PGPASSFILE=\${PGPASSFILE:-} PGPASSWORD=\${PGPASSWORD:+set} PGSSLMODE=\${PGSSLMODE:-} PGAPPNAME=\${PGAPPNAME:-}"
printf '%s\\n' "$line" >> "$STUB_LOG"
case "$name" in
  psql)
    case "$*" in *server_version_num*) echo "\${STUB_SERVER_VERSION:-170004}" ;; esac
    exit "\${STUB_PSQL_EXIT:-0}" ;;
  pg_dump)
    if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) \${STUB_PG_DUMP_VERSION:-17.2}"; exit 0; fi
    out=""; prev=""
    for a in "$@"; do [ "$prev" = "-f" ] && out="$a"; prev="$a"; done
    if [ -n "$out" ]; then printf 'PGDMP' > "$out"; else printf 'PGDMP-DATA'; fi ;;
  age) cat ;;
esac
exit 0
`;

type Run = { status: number | null; stdout: string; stderr: string; calls: string[][] };

/** A copy of front/'s ops files with its own targets.json, HOME and stubs. */
function sandbox(targets: unknown = REAL_TARGETS) {
  const root = mkdtempSync(join(tmpdir(), "manci-ops-"));
  sandboxes.push(root);
  for (const dir of ["scripts/ops", "bin", "home", "supabase"]) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(join(FRONT, "scripts/db.sh"), join(root, "scripts/db.sh"));
  for (const file of ["target.mjs", "target-env.sh", "assert-target.sql", "maintenance.sh", "backup.sh", "supabase.sh"])
    copyFileSync(join(FRONT, "scripts/ops", file), join(root, "scripts/ops", file));
  writeFileSync(join(root, "scripts/ops/targets.json"), JSON.stringify(targets, null, 2));
  for (const tool of ["psql", "pg_dump", "pg_restore", "age", "supabase"]) {
    writeFileSync(join(root, "bin", tool), STUB);
    chmodSync(join(root, "bin", tool), 0o755);
  }
  const log = join(root, "calls.log");
  const run = (script: string, args: string[], env: Record<string, string> = {}): Run => {
    rmSync(log, { force: true });
    const result = spawnSync("bash", [join(root, script), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        NODE_ENV: "test",
        PATH: `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: join(root, "home"),
        STUB_LOG: log,
        MANCI_PG_BIN: join(root, "bin"),
        ...env,
      },
    });
    const calls = existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").map((line) => line.split("\t"))
      : [];
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  };
  const pgpass = (mode = 0o600) => {
    const file = join(root, "home/pgpass");
    writeFileSync(file, `${DEVNET_HOST}:5432:postgres:postgres.${DEVNET_REF}:secret\n`);
    chmodSync(file, mode);
    return file;
  };
  return { root, run, pgpass };
}

const named = (run: Run, tool: string) => run.calls.filter((call) => call[0] === tool);
const after = (call: string[], flag: string) => call[call.indexOf(flag) + 1];

describe("targets.json and target.mjs", () => {
  it("the tracked file is valid: unique refs and origins, session pooler port, mainnet not configured yet", () => {
    expect(() => loadTargets()).not.toThrow();
    expect(Object.keys(REAL_TARGETS).sort()).toEqual(["devnet", "mainnet"]);
    expect(REAL_TARGETS.devnet).toEqual({
      network: "devnet", projectRef: DEVNET_REF, poolerHost: DEVNET_HOST, poolerPort: 5432,
      siteOrigin: "https://www.manci.io", backupAgeRecipient: null,
    });
    expect(REAL_TARGETS.mainnet).toMatchObject({ network: "mainnet", projectRef: null, poolerHost: null, siteOrigin: null });
  });

  it.each([
    ["a shared projectRef", { a: { ...REAL_TARGETS.devnet, network: "devnet", siteOrigin: null }, devnet: REAL_TARGETS.devnet }, /share a projectRef/],
    ["a shared siteOrigin", { devnet: REAL_TARGETS.devnet, other: { ...REAL_TARGETS.devnet, projectRef: MAINNET_REF } }, /share a siteOrigin/],
    ["the transaction pooler port", { devnet: { ...REAL_TARGETS.devnet, poolerPort: 6543 } }, /poolerPort must be 5432/],
    ["an origin with a path", { devnet: { ...REAL_TARGETS.devnet, siteOrigin: "https://www.manci.io/app" } }, /siteOrigin/],
    ["a plain-http origin", { devnet: { ...REAL_TARGETS.devnet, siteOrigin: "http://www.manci.io" } }, /siteOrigin/],
    ["a malformed ref", { devnet: { ...REAL_TARGETS.devnet, projectRef: "GVNCKUZMUWOZLCOHTUHX" } }, /projectRef/],
    ["an unknown field", { devnet: { ...REAL_TARGETS.devnet, password: "x" } }, /exactly these fields/],
    ["a devnet target on mainnet", { devnet: { ...REAL_TARGETS.devnet, network: "mainnet" } }, /must have network "devnet"/],
    ["an invalid age recipient", { devnet: { ...REAL_TARGETS.devnet, backupAgeRecipient: "ssh-ed25519 AAAA" } }, /backupAgeRecipient/],
    ["a bad target name", { "Dev Net": REAL_TARGETS.devnet }, /Invalid target name/],
  ])("rejects %s", (_label, file, message) => {
    expect(() => validateTargets(file)).toThrow(message);
  });

  it("resolves a target, refusing unknown, unconfigured, and mainnet without MANCI_ALLOW_MAINNET=1", () => {
    expect(targetLine(resolveTarget(REAL_TARGETS, "devnet", {})))
      .toBe(`devnet|${DEVNET_REF}|${DEVNET_HOST}|5432|https://www.manci.io`);
    expect(() => resolveTarget(REAL_TARGETS, "", {})).toThrow(/no default/);
    expect(() => resolveTarget(REAL_TARGETS, "staging", {})).toThrow(/Unknown target "staging"/);
    expect(() => resolveTarget(REAL_TARGETS, "mainnet", {})).toThrow(/MANCI_ALLOW_MAINNET=1/);
    expect(() => resolveTarget(REAL_TARGETS, "mainnet", { MANCI_ALLOW_MAINNET: "1" })).toThrow(/not configured yet/);
    expect(() => resolveTarget(CONFIGURED, "mainnet", { MANCI_ALLOW_MAINNET: "true" })).toThrow(TargetError);
    const noOrigin = { ...CONFIGURED, mainnet: { ...CONFIGURED.mainnet, siteOrigin: null } };
    expect(targetLine(resolveTarget(noOrigin, "mainnet", { MANCI_ALLOW_MAINNET: "1" })))
      .toBe(`mainnet|${MAINNET_REF}|${MAINNET_HOST}|5432|-`);
  });

  it("prints one line, '-' for null, and exits non-zero on any refusal", () => {
    const cli = (args: string[], env: Record<string, string> = {}, cwd = FRONT) =>
      spawnSync(process.execPath, [join(cwd, "scripts/ops/target.mjs"), ...args], {
        encoding: "utf8", env: { NODE_ENV: "test", PATH: dirname(process.execPath), ...env },
      });
    const ok = cli(["devnet"]);
    expect([ok.status, ok.stdout]).toEqual([0, `devnet|${DEVNET_REF}|${DEVNET_HOST}|5432|https://www.manci.io\n`]);
    expect(cli(["devnet", "--age-recipient"]).stdout).toBe("-\n");
    const mainnet = cli(["mainnet"]);
    expect(mainnet.status).toBe(1);
    expect(mainnet.stdout).toBe("");
    expect(mainnet.stderr).toMatch(/MANCI_ALLOW_MAINNET=1/);
    expect(cli(["mainnet"], { MANCI_ALLOW_MAINNET: "1" }).stderr).toMatch(/not configured yet/);
    expect(cli([]).status).toBe(2);
    expect(cli(["devnet", "extra"]).status).toBe(2);
    const box = sandbox({ ...CONFIGURED, mainnet: { ...CONFIGURED.mainnet, siteOrigin: null } });
    expect(cli(["mainnet"], { MANCI_ALLOW_MAINNET: "1" }, box.root).stdout).toBe(`mainnet|${MAINNET_REF}|${MAINNET_HOST}|5432|-\n`);
    const broken = sandbox({ devnet: { ...REAL_TARGETS.devnet, poolerPort: 6543 } });
    expect(cli(["devnet"], {}, broken.root)).toMatchObject({ status: 1, stdout: "" });
  });
});

describe("scripts/db.sh", () => {
  it("refuses without MANCI_TARGET, for an unknown target, and for mainnet without the allow flag", () => {
    const box = sandbox(CONFIGURED);
    box.pgpass();
    const none = box.run("scripts/db.sh", ["-c", "select 1"]);
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/MANCI_TARGET is required/);
    const unknown = box.run("scripts/db.sh", ["-c", "select 1"], { MANCI_TARGET: "staging" });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown target "staging"/);
    const mainnet = box.run("scripts/db.sh", ["-c", "select 1"], { MANCI_TARGET: "mainnet" });
    expect(mainnet.status).toBe(1);
    expect(mainnet.stderr).toMatch(/MANCI_ALLOW_MAINNET=1/);
    for (const run of [none, unknown, mainnet]) expect(named(run, "psql")).toEqual([]);
  });

  it("stops when target.mjs fails (an invalid targets.json)", () => {
    const box = sandbox({ devnet: { ...REAL_TARGETS.devnet, poolerPort: 6543 } });
    box.pgpass();
    const run = box.run("scripts/db.sh", ["-c", "select 1"], { MANCI_TARGET: "devnet" });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/poolerPort must be 5432/);
    expect(named(run, "psql")).toEqual([]);
  });

  it("connects to the target's host and user with TLS and the pgpass file, asserting the target first", () => {
    const box = sandbox();
    const pgpass = box.pgpass();
    const run = box.run("scripts/db.sh", ["-f", "supabase/migrations/0071_network_guard.sql"], {
      MANCI_TARGET: "devnet", MANCI_PGPASSFILE: pgpass,
      // Inherited libpq settings must not redirect the connection.
      PGHOST: "evil.example", PGHOSTADDR: "10.0.0.1", PGSERVICE: "other", PGPASSWORD: "leaked",
    });
    expect(run.status).toBe(0);
    const [call] = named(run, "psql");
    expect(after(call, "-h")).toBe(DEVNET_HOST);
    expect(after(call, "-p")).toBe("5432");
    expect(after(call, "-U")).toBe(`postgres.${DEVNET_REF}`);
    expect(after(call, "-d")).toBe("postgres");
    expect(call).toContain("ON_ERROR_STOP=1");
    for (const v of ["target_network=devnet", `target_ref=${DEVNET_REF}`, "target_origin=https://www.manci.io", "bootstrap=0"])
      expect(call).toContain(v);
    const files = call.flatMap((arg, i) => (call[i - 1] === "-f" ? [arg] : []));
    expect(files).toEqual(["scripts/ops/assert-target.sql", "supabase/migrations/0071_network_guard.sql"]);
    expect(call.at(-1)).toBe(`ENV PGPASSFILE=${pgpass} PGPASSWORD= PGSSLMODE=require PGAPPNAME=manci-ops-devnet`);
  });

  it("passes bootstrap mode through and validates it", () => {
    const box = sandbox();
    box.pgpass();
    const env = { MANCI_TARGET: "devnet", MANCI_PGPASSFILE: join(box.root, "home/pgpass") };
    expect(named(box.run("scripts/db.sh", ["-c", "select 1"], { ...env, MANCI_DB_BOOTSTRAP: "1" }), "psql")[0]).toContain("bootstrap=1");
    const bad = box.run("scripts/db.sh", ["-c", "select 1"], { ...env, MANCI_DB_BOOTSTRAP: "yes" });
    expect([bad.status, named(bad, "psql")]).toEqual([1, []]);
  });

  it("runs the assert as its own call before an interactive session", () => {
    const box = sandbox();
    const run = box.run("scripts/db.sh", [], { MANCI_TARGET: "devnet", MANCI_PGPASSFILE: box.pgpass() });
    const calls = named(run, "psql");
    expect(calls).toHaveLength(2);
    expect(after(calls[0], "-f")).toBe("scripts/ops/assert-target.sql");
    expect(calls[1]).not.toContain("-f");
  });

  it.each([
    [["-h", "db.other.supabase.co", "-c", "select 1"]],
    [["--host=db.other.supabase.co", "-c", "select 1"]],
    [["-U", "postgres", "-c", "select 1"]],
    [["-d", "postgres://x@y/z", "-c", "select 1"]],
    [["-c", "select 1", "otherdb"]],
    [["-v", "target_ref=otherprojectref00001", "-c", "select 1"]],
    [["-vbootstrap=1", "-c", "select 1"]],
    [["--set=ON_ERROR_STOP=0", "-f", "x.sql"]],
    [["--variable", "ON_ERROR_STOP=0", "-f", "x.sql"]],
    [["-qAtc"]],
    // psql (getopt_long) takes any unambiguous abbreviation of a long option,
    // and a later option overrides db.sh's -h/-p/-U/-d/-v.
    [["--hos=db.other.supabase.co", "-c", "select 1"]],
    [["--hos", "db.other.supabase.co", "-c", "select 1"]],
    [["--po=6543", "-c", "select 1"]],
    [["--use=postgres", "-c", "select 1"]],
    [["--d=postgresql://postgres.otherprojectref0001@aws-0-eu-west-1.pooler.supabase.com/postgres", "-c", "select 1"]],
    [["--va=ON_ERROR_STOP=0", "-f", "x.sql"]],
    [["--var", "target_ref=otherprojectref00001", "-c", "select 1"]],
    [["--se=bootstrap=1", "-c", "select 1"]],
    [["--comm=select 1"]],
    [["--Host=db.other.supabase.co", "-c", "select 1"]],
    [["--", "-c", "select 1"]],
    [["--=x", "-c", "select 1"]],
  ])("refuses caller connection overrides and reserved variables: %j", (args) => {
    const box = sandbox();
    const run = box.run("scripts/db.sh", args, { MANCI_TARGET: "devnet", MANCI_PGPASSFILE: box.pgpass() });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^db\.sh: /);
    expect(named(run, "psql")).toEqual([]);
  });

  it("accepts ordinary psql options, including bundled ones and long options spelled out in full", () => {
    const box = sandbox();
    const env = { MANCI_TARGET: "devnet", MANCI_PGPASSFILE: box.pgpass() };
    const run = box.run("scripts/db.sh", ["-X", "-qAt", "-P", "pager=off", "-v", "network=devnet", "-f", "-"], env);
    expect(run.status).toBe(0);
    expect(named(run, "psql")).toHaveLength(1);
    const long = box.run("scripts/db.sh", [
      "--no-psqlrc", "--quiet", "--tuples-only", "--pset", "pager=off", "--set=network=devnet",
      "--variable", "operator=ops", "--file=-", "--command", "select 1", "--help=variables",
    ], env);
    expect(long.status, long.stderr).toBe(0);
    const [call] = named(long, "psql");
    expect(named(long, "psql")).toHaveLength(1);
    expect(call.slice(call.indexOf("--no-psqlrc"), -1)).toEqual([
      "--no-psqlrc", "--quiet", "--tuples-only", "--pset", "pager=off", "--set=network=devnet",
      "--variable", "operator=ops", "--file=-", "--command", "select 1", "--help=variables",
    ]);
  });

  it("refuses a pgpass file readable by others", () => {
    const box = sandbox();
    const run = box.run("scripts/db.sh", ["-c", "select 1"], { MANCI_TARGET: "devnet", MANCI_PGPASSFILE: box.pgpass(0o644) });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/must be mode 600/);
    expect(named(run, "psql")).toEqual([]);
  });

  it("never reads .env.local for mainnet, even when it names the mainnet project", () => {
    const box = sandbox(CONFIGURED);
    writeFileSync(join(box.root, ".env.local"), `SUPABASE_DB_URL=postgresql://postgres.${MAINNET_REF}:SENTINEL_PW_7d1@${MAINNET_HOST}:5432/postgres\n`);
    const run = box.run("scripts/db.sh", ["-c", "select 1"], { MANCI_TARGET: "mainnet", MANCI_ALLOW_MAINNET: "1" });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/No pgpass file/);
    expect(run.stderr).not.toContain("SENTINEL_PW_7d1");
    expect(named(run, "psql")).toEqual([]);
  });

  it("devnet without pgpass (transitional): uses .env.local only when it names the devnet project", () => {
    const box = sandbox();
    for (const url of [
      `postgresql://postgres.${DEVNET_REF}:p%40ss@${DEVNET_HOST}:5432/postgres`,
      `"postgresql://postgres:pw@db.${DEVNET_REF}.supabase.co:5432/postgres"`,
    ]) {
      writeFileSync(join(box.root, ".env.local"), `OTHER=1\nSUPABASE_DB_URL=${url}\n`);
      const run = box.run("scripts/db.sh", ["-c", "select 1"], { MANCI_TARGET: "devnet" });
      expect(run.status, url).toBe(0);
      expect(named(run, "psql")[0].at(-1)).toBe("ENV PGPASSFILE=/dev/null PGPASSWORD=set PGSSLMODE=require PGAPPNAME=manci-ops-devnet");
    }
    writeFileSync(join(box.root, ".env.local"), `SUPABASE_DB_URL=postgresql://postgres.${MAINNET_REF}:pw@${DEVNET_HOST}:5432/postgres\n`);
    const other = box.run("scripts/db.sh", ["-c", "select 1"], { MANCI_TARGET: "devnet" });
    expect(other.status).toBe(1);
    expect(other.stderr).toMatch(/does not belong to target devnet/);
    expect(named(other, "psql")).toEqual([]);
  });

  // db.sh classifies long options by exact name, so its tables must be
  // psql's own: every long option `psql --help` lists, with the same
  // "takes a value" split. Runs against the local client when one exists
  // (POSTGRES_BIN, as the PostgreSQL suites use).
  const realPsql = join(process.env.POSTGRES_BIN ?? "/opt/homebrew/opt/postgresql@15/bin", "psql");
  it.skipIf(!existsSync(realPsql))("its long-option tables match the installed psql exactly", () => {
    const help = spawnSync(realPsql, ["--help"], { encoding: "utf8" }).stdout;
    const psqlValue = new Set<string>();
    const psqlFlag = new Set<string>();
    for (const [, name, suffix] of help.matchAll(/--([a-z][a-z-]*)(=|\[=)?/g)) {
      (suffix === "=" ? psqlValue : psqlFlag).add(name);
    }
    // --help[=topic]: the value is optional, so it never takes the next argument.
    for (const name of psqlFlag) psqlValue.delete(name);
    const script = readFileSync(join(FRONT, "scripts/db.sh"), "utf8");
    const table = (name: string) => new Set(new RegExp(`^${name}="([^"]*)"$`, "m").exec(script)![1].trim().split(/\s+/));
    const dbValue = table("VALUE_LONG");
    const dbFlag = table("FLAG_LONG");
    expect(psqlValue.size + psqlFlag.size).toBeGreaterThanOrEqual(36);
    expect([...dbValue].sort()).toEqual([...psqlValue].sort());
    expect([...dbFlag].sort()).toEqual([...psqlFlag].sort());
  });
});

describe("scripts/ops/maintenance.sh", () => {
  it("refuses a MANCI_TARGET that differs from the network argument", () => {
    const box = sandbox(CONFIGURED);
    box.pgpass();
    const run = box.run("scripts/ops/maintenance.sh", ["devnet", "status"], { MANCI_TARGET: "mainnet", MANCI_ALLOW_MAINNET: "1" });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/does not match the network argument devnet/);
    expect(named(run, "psql")).toEqual([]);
  });

  it("uses the target named after the network, and mainnet still needs the allow flag", () => {
    const box = sandbox(CONFIGURED);
    const pgpass = box.pgpass();
    const status = box.run("scripts/ops/maintenance.sh", ["devnet", "status"], { MANCI_PGPASSFILE: pgpass });
    expect(status.status).toBe(0);
    expect(after(named(status, "psql")[0], "-h")).toBe(DEVNET_HOST);
    expect(named(status, "psql")[0]).toContain("network=devnet");
    const mainnet = box.run("scripts/ops/maintenance.sh", ["mainnet", "on", "Upgrade"], { MANCI_PGPASSFILE: pgpass });
    expect(mainnet.status).toBe(1);
    expect(mainnet.stderr).toMatch(/MANCI_ALLOW_MAINNET=1/);
    expect(named(mainnet, "psql")).toEqual([]);
  });

  it("needs an explicit, non-mainnet MANCI_TARGET for testnet and localnet flags", () => {
    const box = sandbox(CONFIGURED);
    box.pgpass();
    expect(box.run("scripts/ops/maintenance.sh", ["testnet", "status"]).stderr).toMatch(/set MANCI_TARGET/);
    const onMainnet = box.run("scripts/ops/maintenance.sh", ["localnet", "status"], { MANCI_TARGET: "mainnet", MANCI_ALLOW_MAINNET: "1" });
    expect(onMainnet.status).toBe(1);
    expect(named(onMainnet, "psql")).toEqual([]);
    const onDevnet = box.run("scripts/ops/maintenance.sh", ["testnet", "status"], { MANCI_TARGET: "devnet", MANCI_PGPASSFILE: join(box.root, "home/pgpass") });
    expect(onDevnet.status).toBe(0);
    expect(named(onDevnet, "psql")[0]).toContain("network=testnet");
  });
});

describe("scripts/ops/backup.sh", () => {
  const backups = (root: string, target: string) => {
    const dir = join(root, "home/Backups/mancipatio", target);
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  };

  it("devnet: a full and a schema-only dump, verified, private, with a manifest", () => {
    const box = sandbox();
    const run = box.run("scripts/ops/backup.sh", ["devnet", "pre-0071"], { MANCI_PGPASSFILE: box.pgpass() });
    expect(run.status, run.stderr).toBe(0);
    const files = backups(box.root, "devnet");
    expect(files.map((f) => f.replace(/\d{8}T\d{6}Z/, "T"))).toEqual([
      "devnet-pre-0071-T.dump", "devnet-pre-0071-T.schema.dump", "devnet-pre-0071-T.sha256",
    ]);
    const dir = join(box.root, "home/Backups/mancipatio/devnet");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of files) expect(statSync(join(dir, file)).mode & 0o777, file).toBe(0o600);
    const assert = named(run, "psql")[0];
    expect(assert).toContain("scripts/ops/assert-target.sql");
    const dumps = named(run, "pg_dump").filter((call) => call[1] !== "--version");
    expect(dumps).toHaveLength(2);
    for (const call of dumps) {
      expect(after(call, "-h")).toBe(DEVNET_HOST);
      expect(after(call, "-U")).toBe(`postgres.${DEVNET_REF}`);
      expect(call).toEqual(expect.arrayContaining(["-Fc", "--lock-wait-timeout=15000", "public", "storage", "mancipatio_ops"]));
    }
    expect(named(run, "pg_restore")).toHaveLength(2);
    expect(readFileSync(join(dir, files[2]), "utf8")).toMatch(/^[0-9a-f]{64} {2}5 {2}devnet-pre-0071-\d{8}T\d{6}Z\.schema\.dump$/m);
  });

  it("mainnet: schema only by default; --data without an age recipient is refused before connecting", () => {
    const box = sandbox(CONFIGURED);
    const env = { MANCI_ALLOW_MAINNET: "1", MANCI_PGPASSFILE: box.pgpass() };
    const refused = box.run("scripts/ops/backup.sh", ["mainnet", "weekly", "--data"], env);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/needs backupAgeRecipient/);
    expect(refused.calls).toEqual([]);
    const schema = box.run("scripts/ops/backup.sh", ["mainnet", "post-bootstrap"], env);
    expect(schema.status, schema.stderr).toBe(0);
    expect(backups(box.root, "mainnet").map((f) => f.replace(/\d{8}T\d{6}Z/, "T")))
      .toEqual(["mainnet-post-bootstrap-T.schema.dump", "mainnet-post-bootstrap-T.sha256"]);
    const dumps = named(schema, "pg_dump").filter((call) => call[1] !== "--version");
    expect(dumps).toHaveLength(1);
    expect(dumps[0]).toContain("--schema-only");
    const noAllow = box.run("scripts/ops/backup.sh", ["mainnet", "x"], { MANCI_PGPASSFILE: env.MANCI_PGPASSFILE });
    expect([noAllow.status, noAllow.calls]).toEqual([1, []]);
  });

  it("mainnet --data is encrypted to the recipient; no plaintext dump is written", () => {
    const box = sandbox({ ...CONFIGURED, mainnet: { ...CONFIGURED.mainnet, backupAgeRecipient: AGE_KEY } });
    const run = box.run("scripts/ops/backup.sh", ["mainnet", "weekly", "--data"], { MANCI_ALLOW_MAINNET: "1", MANCI_PGPASSFILE: box.pgpass() });
    expect(run.status, run.stderr).toBe(0);
    expect(backups(box.root, "mainnet").map((f) => f.replace(/\d{8}T\d{6}Z/, "T")))
      .toEqual(["mainnet-weekly-T.dump.age", "mainnet-weekly-T.schema.dump", "mainnet-weekly-T.sha256"]);
    expect(named(run, "age")[0]).toEqual(expect.arrayContaining(["-r", AGE_KEY]));
    const dataDump = named(run, "pg_dump").find((call) => call[1] !== "--version" && !call.includes("--schema-only"))!;
    expect(dataDump).not.toContain("-f");
  });

  it("refuses an older pg_dump than the server, a mismatched MANCI_TARGET and a bad label", () => {
    const box = sandbox();
    const pgpass = box.pgpass();
    const old = box.run("scripts/ops/backup.sh", ["devnet", "x"], { MANCI_PGPASSFILE: pgpass, STUB_PG_DUMP_VERSION: "15.4" });
    expect(old.status).toBe(1);
    expect(old.stderr).toMatch(/older than the server/);
    expect(backups(box.root, "devnet")).toEqual([]);
    const mismatch = box.run("scripts/ops/backup.sh", ["devnet", "x"], { MANCI_TARGET: "mainnet", MANCI_PGPASSFILE: pgpass });
    expect([mismatch.status, mismatch.calls]).toEqual([1, []]);
    expect(box.run("scripts/ops/backup.sh", ["devnet", "../x"], { MANCI_PGPASSFILE: pgpass }).status).toBe(2);
    const failedAssert = box.run("scripts/ops/backup.sh", ["devnet", "x"], { MANCI_PGPASSFILE: pgpass, STUB_PSQL_EXIT: "3" });
    expect(failedAssert.status).toBe(1);
    expect(named(failedAssert, "pg_dump").filter((call) => call[1] !== "--version")).toEqual([]);
  });
});

describe("scripts/ops/supabase.sh", () => {
  it("runs the allowlisted commands against the target's project only", () => {
    const box = sandbox();
    const deploy = box.run("scripts/ops/supabase.sh", ["devnet", "functions", "deploy", "helius-webhook"]);
    expect(deploy.status, deploy.stderr).toBe(0);
    expect(named(deploy, "supabase")[0].slice(1, -1)).toEqual(["functions", "deploy", "helius-webhook", "--project-ref", DEVNET_REF]);
    // Server-side bundling for a machine without Docker; the project still comes from the target.
    const viaApi = box.run("scripts/ops/supabase.sh", ["devnet", "functions", "deploy", "helius-webhook", "--use-api"]);
    expect(viaApi.status, viaApi.stderr).toBe(0);
    expect(named(viaApi, "supabase")[0].slice(1, -1)).toEqual(["functions", "deploy", "helius-webhook", "--use-api", "--project-ref", DEVNET_REF]);
    const env = join(box.root, "secrets.env");
    writeFileSync(env, "MANCI_SUPABASE_SECRET_KEY=x\n");
    chmodSync(env, 0o600);
    const set = box.run("scripts/ops/supabase.sh", ["devnet", "secrets", "set", "--env-file", env]);
    expect(named(set, "supabase")[0].slice(1, -1)).toEqual(["secrets", "set", "--env-file", env, "--project-ref", DEVNET_REF]);
    expect(named(box.run("scripts/ops/supabase.sh", ["devnet", "secrets", "list"]), "supabase")).toHaveLength(1);
    expect(named(box.run("scripts/ops/supabase.sh", ["devnet", "secrets", "unset", "OLD_KEY"]), "supabase")).toHaveLength(1);
  });

  it.each([
    [["devnet", "functions", "deploy", "helius-webhook", "--project-ref", "otherprojectref00001"]],
    [["devnet", "--project-ref=otherprojectref00001", "secrets", "list"]],
    [["devnet", "db", "push"]],
    [["devnet", "db", "push", "--db-url", "postgres://x"]],
    [["devnet", "secrets", "set", "MANCI_SUPABASE_SECRET_KEY=sb_secret_x"]],
    [["devnet", "secrets", "unset", "lower-case"]],
    [["devnet", "functions", "deploy", "other-function"]],
    [["devnet", "functions", "deploy", "other-function", "--use-api"]],
    [["devnet", "functions", "deploy", "--use-api", "helius-webhook"]],
    [["devnet", "functions", "deploy", "helius-webhook", "--no-verify-jwt"]],
    [["devnet", "functions", "deploy", "helius-webhook", "--prune"]],
    [["devnet", "functions", "deploy", "helius-webhook", "--use-api", "--prune"]],
    [["devnet", "functions", "deploy", "helius-webhook", "--workdir", "/tmp"]],
    [["devnet", "projects", "list"]],
    [["mainnet", "secrets", "list"]],
    [["staging", "secrets", "list"]],
  ])("refuses %j", (args) => {
    const box = sandbox(CONFIGURED);
    const run = box.run("scripts/ops/supabase.sh", args);
    expect(run.status).not.toBe(0);
    expect(named(run, "supabase")).toEqual([]);
  });

  it("refuses a world-readable env file and a leftover linked project", () => {
    const box = sandbox();
    const env = join(box.root, "secrets.env");
    writeFileSync(env, "A=1\n");
    chmodSync(env, 0o644);
    expect(named(box.run("scripts/ops/supabase.sh", ["devnet", "secrets", "set", "--env-file", env]), "supabase")).toEqual([]);
    mkdirSync(join(box.root, "supabase/.temp"));
    writeFileSync(join(box.root, "supabase/.temp/project-ref"), "otherprojectref00001");
    const linked = box.run("scripts/ops/supabase.sh", ["devnet", "secrets", "list"]);
    expect(linked.stderr).toMatch(/Delete front\/supabase\/\.temp\//);
    expect(named(linked, "supabase")).toEqual([]);
  });
});

describe("live operator runners (deployment smoke, index reconcile)", () => {
  it("smoke: explicit network, the target's origin, mainnet only with the allow flag", () => {
    expect(smokeTarget({ MANCIPATIO_LIVE_SMOKE: "devnet" })).toEqual({ network: "devnet", origin: "https://www.manci.io" });
    expect(() => smokeTarget({})).toThrow(/Explicit MANCIPATIO_LIVE_SMOKE/);
    expect(() => smokeTarget({ MANCIPATIO_LIVE_SMOKE: "testnet" })).toThrow(/Explicit/);
    expect(() => smokeTarget({ MANCIPATIO_LIVE_SMOKE: "mainnet" })).toThrow(/MANCI_ALLOW_MAINNET=1/);
    // The tracked mainnet target has no origin yet.
    expect(() => smokeTarget({ MANCIPATIO_LIVE_SMOKE: "mainnet", MANCI_ALLOW_MAINNET: "1" })).toThrow(/no siteOrigin for mainnet/);
    expect(smokeTarget({ MANCIPATIO_LIVE_SMOKE: "mainnet", MANCI_ALLOW_MAINNET: "1" }, CONFIGURED))
      .toEqual({ network: "mainnet", origin: "https://mainnet.manci.test" });
    expect(otherNetwork("devnet")).toBe("mainnet");
    expect(otherNetwork("mainnet")).toBe("devnet");
  });

  it("smoke: SMOKE_ORIGIN may name a preview, never another target's origin or a non-https URL", () => {
    const env = { MANCIPATIO_LIVE_SMOKE: "mainnet", MANCI_ALLOW_MAINNET: "1" };
    expect(smokeTarget({ ...env, SMOKE_ORIGIN: "https://manci-git-x.vercel.app" }, CONFIGURED).origin).toBe("https://manci-git-x.vercel.app");
    expect(() => smokeTarget({ ...env, SMOKE_ORIGIN: "https://www.manci.io" }, CONFIGURED)).toThrow(/another target's origin/);
    for (const bad of ["http://preview.manci.test", "https://preview.manci.test/path", "https://preview.manci.test:8443"])
      expect(() => smokeTarget({ ...env, SMOKE_ORIGIN: bad }, CONFIGURED), bad).toThrow(/https:\/\/<host>/);
  });

  it("reconcile: pinned project, env file rules, per-network RPC keys and no public mainnet RPC", () => {
    expect(reconcileTarget({ MANCIPATIO_RECONCILE: "devnet", MANCIPATIO_RECONCILE_PROJECT: DEVNET_REF }))
      .toEqual({ network: "devnet", project: DEVNET_REF, envFile: ".env.local" });
    expect(() => reconcileTarget({ MANCIPATIO_RECONCILE: "devnet", MANCIPATIO_RECONCILE_PROJECT: MAINNET_REF })).toThrow(/must equal the devnet projectRef/);
    expect(() => reconcileTarget({ MANCIPATIO_RECONCILE: "mainnet", MANCIPATIO_RECONCILE_PROJECT: MAINNET_REF }, CONFIGURED)).toThrow(/MANCI_ALLOW_MAINNET=1/);
    const mainnet = { MANCIPATIO_RECONCILE: "mainnet", MANCI_ALLOW_MAINNET: "1", MANCIPATIO_RECONCILE_PROJECT: MAINNET_REF };
    expect(() => reconcileTarget(mainnet, CONFIGURED)).toThrow(/MANCIPATIO_RECONCILE_ENV_FILE is required for mainnet/);
    expect(reconcileTarget({ ...mainnet, MANCIPATIO_RECONCILE_ENV_FILE: "/secure/mainnet.env" }, CONFIGURED).envFile).toBe("/secure/mainnet.env");
    expect(() => reconcileTarget({ ...mainnet, MANCIPATIO_RECONCILE_ENV_FILE: "x" })).toThrow(/no projectRef for mainnet/);

    const env: Record<string, string | undefined> = {
      HELIUS_DEVNET_RPC: "https://devnet.helius-rpc.com/?api-key=d", HELIUS_TESTNET_RPC: "https://t", SOLANA_LOCALNET_RPC: "http://l",
      SUPABASE_SERVICE_ROLE_KEY: "inherited", UNRELATED: "kept",
    };
    applyReconcileEnv({ NEXT_PUBLIC_NETWORK: "mainnet", HELIUS_MAINNET_RPC: "https://mainnet.helius-rpc.com/?api-key=m", HELIUS_DEVNET_RPC: "https://x" }, "mainnet", env);
    expect(env).toEqual({ NEXT_PUBLIC_NETWORK: "mainnet", HELIUS_MAINNET_RPC: "https://mainnet.helius-rpc.com/?api-key=m", UNRELATED: "kept" });
    expect(reconcileRpcUrl(env, "mainnet").hostname).toBe("mainnet.helius-rpc.com");
    expect(() => reconcileRpcUrl({}, "mainnet")).toThrow(/no public fallback/);
    expect(reconcileRpcUrl({}, "devnet").href).toBe("https://api.devnet.solana.com/");
    expect(() => reconcileRpcUrl({ HELIUS_DEVNET_RPC: "http://insecure.example" }, "devnet")).toThrow(/Invalid RPC/);
  });
});
