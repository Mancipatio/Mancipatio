// The release guard (ops/release-checklist.md step 1): release/mainnet must
// be a fast-forward of main. scripts/check-release-ancestry.sh runs against
// throwaway git repositories in the shapes a release can take (equal, behind,
// ahead, diverged, as on 2026-10-15), and the Release guard workflow is
// pinned to the script, to a full checkout and to no secret.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "..");
const SCRIPT = join(ROOT, "scripts/check-release-ancestry.sh");
const WORKFLOW = join(ROOT, ".github/workflows/release-guard.yml");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Fixture = { clone: string; env: NodeJS.ProcessEnv; sha: (ref: string) => string };

/** A git identity and a HOME of its own, so the machine's config (signing, hooks) stays out. */
function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "release-guard-test",
    GIT_AUTHOR_EMAIL: "release-guard@example.invalid",
    GIT_COMMITTER_NAME: "release-guard-test",
    GIT_COMMITTER_EMAIL: "release-guard@example.invalid",
  };
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A seed repository whose `main` is A ← B, shaped further by `shape` (which
 * may add commits and must leave a `release/mainnet` branch), published as a
 * bare origin, and a clone of that origin for the script to run in.
 */
function fixture(shape: (seed: string, env: NodeJS.ProcessEnv) => void): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "manci-release-guard-")));
  roots.push(root);
  const env = gitEnv(root);
  const seed = join(root, "seed");
  git(root, env, "init", "-q", "-b", "main", seed);
  git(seed, env, "commit", "-q", "--allow-empty", "-m", "A: base");
  git(seed, env, "commit", "-q", "--allow-empty", "-m", "B: lockdown (#78)");
  shape(seed, env);
  const origin = join(root, "origin.git");
  git(root, env, "clone", "-q", "--bare", seed, origin);
  const clone = join(root, "clone");
  git(root, env, "clone", "-q", origin, clone);
  return { clone, env, sha: (ref) => git(clone, env, "rev-parse", ref) };
}

function run(f: Fixture, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], { cwd: f.clone, env: { ...f.env, ...extraEnv }, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("scripts/check-release-ancestry.sh", () => {
  it("parses (bash -n)", () => {
    const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("passes when release/mainnet is main itself", () => {
    const f = fixture((seed, env) => git(seed, env, "branch", "release/mainnet", "main"));
    const r = run(f);
    expect(r.out).toContain("ok: origin/main is an ancestor of origin/release/mainnet");
    expect(r.out).not.toContain("::warning::");
    expect(r.status).toBe(0);
  });

  it("fails when the release is behind main, listing the commits of main it misses", () => {
    const f = fixture((seed, env) => git(seed, env, "branch", "release/mainnet", "main~1"));
    const r = run(f);
    expect(r.status).toBe(1);
    expect(r.out).toContain("::error::origin/release/mainnet does not contain origin/main");
    expect(r.out).toContain("B: lockdown (#78)");
    expect(r.out).not.toContain("::warning::");
    expect(r.out).toContain("git push origin <main sha>:refs/heads/release/mainnet");
  });

  it("passes with a warning when the release is ahead of main (a hotfix main receives next)", () => {
    const f = fixture((seed, env) => {
      git(seed, env, "checkout", "-q", "-b", "release/mainnet");
      git(seed, env, "commit", "-q", "--allow-empty", "-m", "C: hotfix on the release");
      git(seed, env, "checkout", "-q", "main");
    });
    const r = run(f);
    expect(r.status).toBe(0);
    expect(r.out).toContain("::warning::commits on origin/release/mainnet that are not on origin/main");
    expect(r.out).toContain("C: hotfix on the release");
    expect(r.out).toContain("ok: origin/main is an ancestor");
  });

  it("fails when the branches diverged (the 2026-10-15 shape): main's commits missing, the release-only ones as a warning", () => {
    const f = fixture((seed, env) => {
      git(seed, env, "checkout", "-q", "-b", "release/mainnet", "main~1");
      git(seed, env, "commit", "-q", "--allow-empty", "-m", "E: pushed from a diverged branch");
      git(seed, env, "checkout", "-q", "main");
      git(seed, env, "commit", "-q", "--allow-empty", "-m", "D: merged to main after");
    });
    const r = run(f);
    expect(r.status).toBe(1);
    expect(r.out).toContain("::warning::");
    expect(r.out).toContain("E: pushed from a diverged branch");
    expect(r.out).toContain("::error::");
    expect(r.out).toContain("B: lockdown (#78)");
    expect(r.out).toContain("D: merged to main after");
  });

  it("checks the ref it is given (the workflow passes the pushed commit) and prints both shas", () => {
    const f = fixture((seed, env) => git(seed, env, "branch", "release/mainnet", "main"));
    const behind = f.sha("origin/main~1");
    const r = run(f, [behind]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`release: ${behind} = ${behind}`);
    expect(r.out).toContain(`main:    origin/main = ${f.sha("origin/main")}`);
    const tip = run(f, [f.sha("origin/main")]);
    expect(tip.status).toBe(0);
  });

  it("skips the fetch with RELEASE_GUARD_NO_FETCH=1 and exits 2 for a ref it cannot resolve", () => {
    const f = fixture((seed, env) => git(seed, env, "branch", "release/mainnet", "main"));
    const r = run(f, ["refs/heads/nope"], { RELEASE_GUARD_NO_FETCH: "1" });
    expect(r.status).toBe(2);
    expect(r.out).toContain("::error::cannot resolve refs/heads/nope");
  });
});

describe(".github/workflows/release-guard.yml", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  it("runs the script on every push to release/mainnet and on demand, from a full checkout, read-only, without secrets", () => {
    expect(workflow).toMatch(/on:\n\s+push:\n\s+branches: \[release\/mainnet\]\n\s+workflow_dispatch:/);
    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain('run: bash scripts/check-release-ancestry.sh "$RELEASE_REF"');
    expect(workflow).toMatch(/RELEASE_REF: \$\{\{ github\.event_name == 'push' && github\.sha \|\| 'origin\/release\/mainnet' \}\}/);
    expect(workflow).not.toContain("secrets.");
  });

  it("pins actions/checkout to the same commit as Front CI (Dependabot bumps both)", () => {
    const frontCi = readFileSync(join(ROOT, ".github/workflows/front-ci.yml"), "utf8");
    const pin = /uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+/;
    const expected = frontCi.match(pin)?.[0];
    expect(expected).toBeDefined();
    expect(workflow.match(pin)?.[0]).toBe(expected);
  });
});

describe("the runbook and the release checklist point at the guard", () => {
  it("names the script, the workflow and the fast-forward rule", () => {
    const runbook = readFileSync(join(ROOT, "ops/runbook-mainnet.md"), "utf8");
    const checklist = readFileSync(join(ROOT, "ops/release-checklist.md"), "utf8");
    for (const doc of [runbook, checklist]) {
      expect(doc).toContain("scripts/check-release-ancestry.sh");
      expect(doc).toContain(".github/workflows/release-guard.yml");
    }
    expect(runbook).toMatch(/never\s+cherry-picked/);
    expect(checklist).toMatch(/never\s+cherry-picked/);
    expect(checklist.match(/^\d+\. \*\*/gm)).toHaveLength(8);
    expect(checklist).toContain("git push origin <40-hex main sha>:refs/heads/release/mainnet");
    expect(checklist).toContain("/api/health");
    expect(checklist).toContain("0x7F");
  });
});
