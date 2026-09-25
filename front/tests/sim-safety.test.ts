// The simulator's safety gates (scripts/sim/lib/safety.ts): devnet only,
// the exact origin, SIM_SEND, the two-origin fetch guard, STOP/PAUSE, the
// git-ignored private directory and the journal redaction.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userSigner } from "@/scripts/sim/lib/identity";
import {
  StopControl,
  acquireSimLock,
  assertIgnoredDir,
  installSimFetchGuard,
  journalBody,
  readSimConfig,
  redact,
  simFetchAllowed,
  writePrivateFile,
} from "@/scripts/sim/lib/safety";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sim-safety-"));
const RPC = "https://devnet.helius-rpc.com/?api-key=test";
const base = { CHAIN_NETWORK: "devnet", CHAIN_RPC_URL: RPC, SIM_SEND: "1" };
const read = (env: Record<string, string | undefined>) => readSimConfig(env, { root: ROOT, home: ROOT });

describe("config gates", () => {
  it("runs plan and report offline, without keys or RPC", () => {
    expect(read({ SIM_CMD: "plan" })).toMatchObject({ cmd: "plan", send: false, rpcUrl: null });
    expect(read({ SIM_CMD: "report" }).simRoot).toBe(path.join(ROOT, "docs", "mainnet-readiness", "sim"));
  });

  it("accepts a devnet pilot with SIM_SEND=1 and defaults to CHAIN_RPS=1 and 2 workers", () => {
    const cfg = read({ SIM_CMD: "pilot", ...base });
    expect(cfg).toMatchObject({ cmd: "pilot", rps: 1, workers: 2, send: true, rpcHost: "devnet.helius-rpc.com" });
    expect(cfg.deployerKeypair).toBe(path.join(ROOT, ".config", "solana", "id-devnet.json"));
    expect(cfg.adminKeypair).toBe(path.join(ROOT, ".config", "solana", "manci-e2e-admin.json"));
  });

  it.each([
    ["no SIM_CMD", {}, /SIM_CMD/],
    ["an unknown command", { SIM_CMD: "sweep" }, /SIM_CMD/],
    ["mainnet", { SIM_CMD: "pilot", ...base, CHAIN_NETWORK: "mainnet" }, /devnet only/],
    ["testnet", { SIM_CMD: "pilot", ...base, CHAIN_NETWORK: "testnet" }, /devnet only/],
    ["localnet", { SIM_CMD: "watch", ...base, CHAIN_NETWORK: "localnet" }, /devnet only/],
    ["mainnet even with the flag", { SIM_CMD: "pilot", ...base, CHAIN_NETWORK: "mainnet", CHAIN_ALLOW_MAINNET: "1" }, /never runs on mainnet/],
    ["CHAIN_ALLOW_MAINNET on devnet", { SIM_CMD: "pilot", ...base, CHAIN_ALLOW_MAINNET: "1" }, /never runs on mainnet/],
    ["a conflicting NEXT_PUBLIC_NETWORK", { SIM_CMD: "pilot", ...base, NEXT_PUBLIC_NETWORK: "mainnet" }, /conflicts/],
    ["the apex origin", { SIM_CMD: "pilot", ...base, SIM_SITE: "https://manci.io" }, /exactly https:\/\/www\.manci\.io/],
    ["a preview origin", { SIM_CMD: "pilot", ...base, SIM_SITE: "https://front-git-x.vercel.app" }, /exactly/],
    ["a pilot without SIM_SEND", { SIM_CMD: "pilot", CHAIN_NETWORK: "devnet", CHAIN_RPC_URL: RPC }, /SIM_SEND=1/],
    ["plan with SIM_SEND", { SIM_CMD: "plan", SIM_SEND: "1" }, /never sends/],
    ["a pilot without CHAIN_NETWORK", { SIM_CMD: "pilot", CHAIN_RPC_URL: RPC, SIM_SEND: "1" }, /CHAIN_NETWORK=devnet/],
    ["a plain-http RPC", { SIM_CMD: "pilot", ...base, CHAIN_RPC_URL: "http://api.devnet.solana.com" }, /https/],
    ["an RPC naming mainnet", { SIM_CMD: "pilot", ...base, CHAIN_RPC_URL: "https://api.mainnet-beta.solana.com" }, /another cluster/],
    ["a mainnet genesis pin", { SIM_CMD: "pilot", ...base, CHAIN_GENESIS_HASH: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }, /conflicts/],
    ["CHAIN_RPS above 5", { SIM_CMD: "pilot", ...base, CHAIN_RPS: "6" }, /CHAIN_RPS/],
    ["a wave without SIM_WAVE", { SIM_CMD: "wave", ...base }, /SIM_WAVE/],
    ["wave 6", { SIM_CMD: "wave", ...base, SIM_WAVE: "6" }, /SIM_WAVE/],
    ["SIM_WAVE outside a wave", { SIM_CMD: "pilot", ...base, SIM_WAVE: "1" }, /only read/],
    ["a malformed run id", { SIM_CMD: "report", SIM_RUN_ID: "../x" }, /SIM_RUN_ID/],
  ])("refuses %s", (_label, env, message) => {
    expect(() => read(env as Record<string, string>)).toThrow(message);
  });

  it("never echoes the RPC URL (it can carry an API key)", () => {
    try {
      read({ SIM_CMD: "pilot", ...base, CHAIN_RPC_URL: "https://user:secret@devnet.example.com" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});

describe("fetch guard", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each([
    ["https://www.manci.io/api/clients/me", true],
    ["https://www.manci.io/", true],
    ["https://devnet.helius-rpc.com/?api-key=test", true],
    ["https://manci.io/api/clients/me", false],
    ["http://www.manci.io/api/clients/me", false],
    ["https://www.manci.io.evil.example/", false],
    ["https://front-git-sim.vercel.app/api/auth/session", false],
    ["https://gvnckuzmuwozlcohtuhx.supabase.co/storage/v1/upload", false],
    ["https://api.devnet.solana.com/", false],
    ["https://devnet.helius-rpc.com/other", false],
  ])("%s → %s", (url, allowed) => {
    expect(simFetchAllowed(new URL(url), RPC)).toBe(allowed);
  });

  it("refuses before a socket opens and restores fetch", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("ok");
    }) as typeof fetch;
    const restore = installSimFetchGuard(RPC);
    await expect(fetch("https://manci.io/")).rejects.toThrow(/only https:\/\/www\.manci\.io/);
    await expect(fetch("https://example.com/")).rejects.toThrow(/refused/);
    await fetch("https://www.manci.io/api/health");
    expect(calls).toEqual(["https://www.manci.io/api/health"]);
    restore();
    await fetch("https://example.com/");
    expect(calls).toHaveLength(2);
  });
});

describe("files and switches", () => {
  it("writes private files atomically (600) in private dirs (700)", () => {
    const dir = path.join(ROOT, "private", "run");
    const file = path.join(dir, "state.json");
    writePrivateFile(file, "{}\n");
    writePrivateFile(file, '{"a":1}\n');
    expect(fs.readFileSync(file, "utf8")).toBe('{"a":1}\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
  });

  it("creates user keys once (wx), 600 in a 700 keys dir, and reloads the same key", async () => {
    const runDir = path.join(ROOT, "keys-run");
    const a = await userSigner(runDir, "u017");
    const b = await userSigner(runDir, "u017");
    expect(b.address).toBe(a.address);
    const file = path.join(runDir, "keys", "u017.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toHaveLength(64);
  });

  it("requires the sim directory to be inside the repository and git-ignored", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sim-repo-"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, ".gitignore"), "/docs/\n");
    expect(() => assertIgnoredDir(path.join(repo, "docs", "mainnet-readiness", "sim"), repo)).not.toThrow();
    expect(() => assertIgnoredDir(path.join(repo, "front", "sim"), repo)).toThrow(/not git-ignored/);
    expect(() => assertIgnoredDir(path.join(os.tmpdir(), "elsewhere"), repo)).toThrow(/inside the repository/);
  });

  it("allows one simulator process: a live lock is refused, a stale one taken over", () => {
    const simRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sim-lock-"));
    const release = acquireSimLock(simRoot);
    expect(() => acquireSimLock(simRoot)).toThrow(/Another simulator process/);
    release();
    expect(fs.existsSync(path.join(simRoot, "sim.lock"))).toBe(false);
    fs.writeFileSync(path.join(simRoot, "sim.lock"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    const again = acquireSimLock(simRoot);
    expect(JSON.parse(fs.readFileSync(path.join(simRoot, "sim.lock"), "utf8")).pid).toBe(process.pid);
    again();
  });

  it("reports STOP (file or signal) and PAUSE", () => {
    const simRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sim-stop-"));
    const controller = new AbortController();
    const stop = new StopControl(simRoot, controller.signal);
    expect(stop.stopReason()).toBeNull();
    expect(stop.paused()).toBe(false);
    fs.writeFileSync(stop.pauseFile, "");
    expect(stop.paused()).toBe(true);
    fs.writeFileSync(stop.stopFile, "");
    expect(stop.stopReason()).toMatch(/STOP file/);
    fs.rmSync(stop.stopFile);
    controller.abort();
    expect(stop.stopReason()).toMatch(/SIGINT/);
  });
});

describe("redaction", () => {
  it("removes tokens, cookies and signatures and keeps onboarding paths without their token", () => {
    const out = redact({
      ok: true,
      data: { token: "abc", onboarding_path: "/onboarding/1?t=deadbeef", nested: [{ signature: "sig", cookie: "c" }], tos_version: "2026-07-18" },
    }) as { data: Record<string, unknown> };
    expect(out.data.token).toBe("[redacted]");
    expect(out.data.onboarding_path).toBe("/onboarding/1?t=[redacted]");
    expect(out.data.nested).toEqual([{ signature: "[redacted]", cookie: "[redacted]" }]);
    expect(out.data.tos_version).toBe("2026-07-18");
  });

  it("caps journal bodies at 2 KB and redacts non-JSON text too", () => {
    expect(journalBody(JSON.stringify({ error: "x".repeat(5_000) })).length).toBeLessThanOrEqual(2_049);
    expect(journalBody("see /onboarding/1?t=secret")).toBe("see /onboarding/1?t=[redacted]");
  });
});
