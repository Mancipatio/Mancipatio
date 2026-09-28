// The environment of the smoke's `next build` (build.mjs) and `next start`
// (serve.mjs): from the shell only what node and the OS need, then the
// placeholders of env.json, then __NEXT_PROCESSED_ENV. Placeholders alone
// would not isolate a run: Next's env loader (@next/env) fills every key the
// process does not set from .env.production.local, .env.local,
// .env.production and .env, so a developer's front/.env.local would add its
// NEXT_PUBLIC_* settings to the build and its server secrets (Supabase
// service key, Sentry DSN, mail and RPC credentials) to the server under
// test. __NEXT_PROCESSED_ENV tells the loader the environment is already
// loaded, and it then reads no .env* file; assertNoEnvFiles() proves that
// with Next's own loader before anything starts.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FRONT = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
export const NEXT_BIN = require.resolve("next/dist/bin/next");
const NEXT_ENV = require.resolve("@next/env");
const PLACEHOLDERS = JSON.parse(readFileSync(new URL("./env.json", import.meta.url), "utf8"));

// What node, Next and the OS need from the shell; none of it is read by the app.
const PASSED = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "CI",
  "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
]);

/** "localnet" (the default build) or "mainnet"; anything else is refused. */
export function smokeNetwork(value) {
  if (value !== "localnet" && value !== "mainnet") throw new Error(`unknown UI smoke network: ${value}`);
  return value;
}

/** The complete environment of a smoke build or server for `network`. */
export function hermeticEnv(network) {
  const shell = Object.entries(process.env).filter(([name]) => PASSED.has(name.toUpperCase()));
  const env = { ...Object.fromEntries(shell), ...PLACEHOLDERS[network], __NEXT_PROCESSED_ENV: "true" };
  assertNoEnvFiles(env);
  return env;
}

// Runs Next's loader the way `next build` / `next start` do (production) in a
// child with `env`, and refuses if it adds any variable from a .env* file:
// the guard against a Next release that stops honouring __NEXT_PROCESSED_ENV.
// Only variable and file names are reported, never values.
function assertNoEnvFiles(env) {
  const probe = `
    const before = new Set(Object.keys(process.env));
    const silent = { info() {}, warn() {}, error() {} };
    const { loadedEnvFiles } = require(${JSON.stringify(NEXT_ENV)}).loadEnvConfig(process.cwd(), false, silent);
    const added = Object.keys(process.env).filter((name) => !before.has(name));
    process.stdout.write(JSON.stringify({ added, files: loadedEnvFiles.map((file) => file.path) }));`;
  const result = spawnSync(process.execPath, ["-e", probe], { cwd: FRONT, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`the .env* probe failed:\n${result.stderr}`);
  const { added, files } = JSON.parse(result.stdout);
  if (added.length > 0) {
    throw new Error(
      `Next would load ${added.join(", ")} from ${files.join(", ")} into the UI smoke ` +
        "(__NEXT_PROCESSED_ENV no longer keeps .env* files out): move those files out of front/ to run it",
    );
  }
}

/**
 * Refuses a .next/ that is not the placeholder build of `network` (a regular
 * build would serve real settings): its client chunks must carry the browser
 * RPC endpoint of env.json, a reserved .invalid host no other build names.
 */
export function assertSmokeBuild(network) {
  const chunks = path.join(FRONT, ".next", "static", "chunks");
  const rpc = PLACEHOLDERS[network].NEXT_PUBLIC_SOLANA_RPC_URL;
  let files = [];
  try {
    files = readdirSync(chunks, { recursive: true }).filter((name) => name.endsWith(".js"));
  } catch {
    // No build at all: refused below.
  }
  if (!files.some((name) => readFileSync(path.join(chunks, name), "utf8").includes(rpc))) {
    const build = network === "mainnet" ? "CI=1 bash scripts/ci/mainnet-build.sh" : "npm run ui-smoke:build";
    throw new Error(`.next/ is not the UI smoke's ${network} build (no ${rpc} in its client chunks): run \`${build}\` first`);
  }
}
