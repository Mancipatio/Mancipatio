// Local-only integration harness. It never reads DATABASE_URL or connects to an
// existing server. Tests opt in through RUN_LOCAL_POSTGRES_TESTS=1. POSTGRES_BIN
// can point at a platform-specific installation directory.
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PsqlVariables = Record<string, string>;

export class LocalPostgres {
  private readonly bin = process.env.POSTGRES_BIN ?? "/opt/homebrew/opt/postgresql@15/bin";
  private dir = "";
  private data = "";
  private socket = "";
  private started = false;

  private command(name: string, args: string[], input?: string) {
    const result = spawnSync(join(this.bin, name), args, { encoding: "utf8", input, timeout: 20_000 });
    if (result.error || result.status !== 0) {
      throw new Error(`${name} failed: ${result.error?.message ?? result.stderr}`);
    }
    return result.stdout.trim();
  }
  private args(vars: PsqlVariables = {}) {
    if (!this.started) throw new Error("The isolated PostgreSQL cluster is not running");
    return [
      "-X", "-h", this.socket, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq",
      ...Object.entries(vars).flatMap(([name, value]) => ["-v", `${name}=${value}`]),
    ];
  }
  initialize() {
    if (this.dir) throw new Error("This isolated PostgreSQL cluster is already initialized");
    this.dir = mkdtempSync(join(tmpdir(), "manci-pg-test-"));
    this.data = join(this.dir, "data");
    // Keep socket paths short enough for macOS's Unix-domain socket limit.
    this.socket = mkdtempSync("/tmp/manci-pg-");
    try {
      this.command("initdb", ["-D", this.data, "--username=postgres", "--auth=trust", "--no-locale", "--encoding=UTF8", "--no-sync"]);
      appendFileSync(join(this.data, "postgresql.conf"), `\nlisten_addresses = ''\nunix_socket_directories = '${this.socket.replaceAll("'", "''")}'\nfsync = off\n`);
      this.start();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  start() {
    if (!this.data || this.started) throw new Error("Invalid isolated PostgreSQL start state");
    this.command("pg_ctl", ["-D", this.data, "-l", join(this.dir, "postgres.log"), "-w", "start"]);
    this.started = true;
  }
  stop() {
    if (this.started) {
      this.command("pg_ctl", ["-D", this.data, "-m", "immediate", "-w", "stop"]);
      this.started = false;
    }
  }
  /** Run SQL (psql meta-commands allowed) from stdin. `vars` become psql
   * variables (`-v name=value`), read in SQL as :'name'. */
  query(query: string, vars?: PsqlVariables) {
    return this.command("psql", this.args(vars), query);
  }
  /** Run psql with extra arguments (e.g. several `-f`), never throwing: the
   * caller inspects the exit status and output. */
  psql(extra: string[], vars?: PsqlVariables): SpawnSyncReturns<string> {
    return spawnSync(join(this.bin, "psql"), [...this.args(vars), ...extra], { encoding: "utf8", timeout: 20_000 });
  }
  queryAsync(query: string, vars?: PsqlVariables): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(join(this.bin, "psql"), this.args(vars));
      let out = ""; let err = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { err += chunk; });
      child.on("error", reject);
      // A process may exit before its pipe buffers have been consumed. Resolve
      // only after stdout/stderr close, including on a busy Linux CI runner.
      child.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
      child.stdin.end(query);
    });
  }
  close() {
    this.stop();
    if (this.socket) rmSync(this.socket, { recursive: true, force: true });
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.socket = "";
    this.dir = "";
    this.data = "";
  }
}
