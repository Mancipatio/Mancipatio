// Talas 6.3 review of the G4–G8 package: the 3012 expectations bound to
// their account, the pause coverage added to G5 (0x10 alone) and G7 (entries
// that land without their bit), the warp script's time limit derived from
// its own settle timeout, and e2e-localnet.sh refusing a start without a
// v1.0.0-rc Release or a warp of any validator but the run's own. The script
// runs for real in a sandbox copy with a fake validator process; nothing
// here starts a validator or reaches a network.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { failedAccount, matchesExpectation } from "@/scripts/chain/lib/e2e/errors";
import { ANCHOR_ACCOUNT_NOT_INITIALIZED, E2E_STEPS, stepSpec, stepsFor } from "@/scripts/chain/lib/e2e/matrix";
import { DEFAULT_WARP_SETTLE_TIMEOUT_S, localnetWarp, warpTimeoutMs } from "@/scripts/chain/lib/e2e/warp";
import type { Journal } from "@/scripts/chain/lib/journal";
import type { ChainRpc } from "@/scripts/chain/lib/rpc";

const REGISTRY = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";
const caused = (account: string, code = 3012, name = "AccountNotInitialized") =>
  `Program log: AnchorError caused by account: ${account}. Error Code: ${name}. Error Number: ${code}. Error Message: x.`;

describe("3012 bound to the missing account", () => {
  const expectKyc = { ok: false as const, program: "asset_registry" as const, code: 3012, name: "AccountNotInitialized", account: "kyc_entry" };
  const failure = { program: "asset_registry", code: 3012, name: "AccountNotInitialized" };

  it("matches only when the logs name the expected account for that code", () => {
    const logs = [`Program ${REGISTRY} invoke [1]`, caused("kyc_entry"), `Program ${REGISTRY} failed: custom program error: 0xbc4`];
    expect(matchesExpectation(expectKyc, failure, logs)).toBe(true);
    expect(matchesExpectation(expectKyc, failure, [caused("escrow_marker")])).toBe(false);
    // The code alone (no logs) no longer passes an account-bound expectation.
    expect(matchesExpectation(expectKyc, failure)).toBe(false);
    // Another code's line for the same account does not count.
    expect(matchesExpectation(expectKyc, failure, [caused("kyc_entry", 6069, "ReceiverNotApproved")])).toBe(false);
  });

  it("reads the account of the failure's code; expectations without an account ignore the logs", () => {
    expect(failedAccount([caused("platform", 6000, "PlatformPaused"), caused("admin_record")], 3012)).toBe("admin_record");
    expect(failedAccount(["Program log: AnchorError occurred. Error Code: SaleSoldOut. Error Number: 6021. Error Message: x."], 6021)).toBeNull();
    const plain = { ok: false as const, program: "asset_registry" as const, code: 3012, name: "AccountNotInitialized" };
    expect(matchesExpectation(plain, failure, [caused("anything")])).toBe(true);
  });

  it("every 3012 step of the matrix names its account", () => {
    const bound = E2E_STEPS.filter((s) => !s.expect.ok && s.expect.code === ANCHOR_ACCOUNT_NOT_INITIALIZED).map((s) => [
      s.id,
      s.expect.ok ? null : s.expect.account,
    ]);
    expect(bound).toEqual([
      ["2.6", "admin_record"],
      ["3.3c", "escrow_marker"],
      ["4.8", "kyc_entry"],
      ["4.11d", "kyc_entry"],
      ["8.6f", "approver_admin_record"],
    ]);
  });
});

describe("pause coverage", () => {
  const outcome = (id: string) => {
    const spec = stepSpec(id);
    return `${spec.signer} ${spec.expect.ok ? "ok" : `${spec.expect.code} ${spec.expect.name}`}`;
  };

  it("G5 refuses both rights entries under 0x10 alone, between the rights issuance and its milestone", () => {
    expect(["5.5f", "5.5g", "5.5h", "5.5i"].map(outcome)).toEqual([
      "admin ok",
      "admin 6000 PlatformPaused",
      "admin 6000 PlatformPaused",
      "superAdmin ok",
    ]);
    const g5 = stepsFor("localnet", [5]).map((s) => s.id);
    // 0x40 is already clear (5.4d) and the issuance exists (5.5a, funded 5.5b);
    // 5.5c then publishes the same milestone the pause refused.
    expect(g5.indexOf("5.4d")).toBeLessThan(g5.indexOf("5.5f"));
    expect(g5.indexOf("5.5b")).toBeLessThan(g5.indexOf("5.5f"));
    expect(g5.indexOf("5.5i")).toBeLessThan(g5.indexOf("5.5c"));
    expect(g5[g5.length - 1]).toBe("5.7");
  });

  it("G7 stages targets that land without their bit and refuses them under 0x01 and 0x04", () => {
    expect(["7.2d", "7.2e", "7.4f", "7.4g"].map(outcome)).toEqual([
      "issuer 6000 PlatformPaused",
      "issuer 6000 PlatformPaused",
      "buyer1 6000 PlatformPaused",
      "buyer2 6000 PlatformPaused",
    ]);
    expect(["7.2f", "7.4h"].map(outcome)).toEqual(["superAdmin ok", "superAdmin ok"]);
    const g7 = stepsFor("localnet", [7]).map((s) => s.id);
    for (const staged of ["7.0m", "7.0n", "7.0o", "7.0p"]) {
      expect(stepSpec(staged).expect.ok, staged).toBe(true);
      expect(g7.indexOf(staged), staged).toBeLessThan(g7.indexOf("7.1a"));
    }
  });
});

describe("warp time limit", () => {
  it("is both snapshot waits plus the script's overhead, from the same E2E_WARP_SETTLE_TIMEOUT_S", () => {
    expect(DEFAULT_WARP_SETTLE_TIMEOUT_S).toBe(900);
    expect(warpTimeoutMs({})).toBe((2 * 900 + 300) * 1000);
    expect(warpTimeoutMs({ E2E_WARP_SETTLE_TIMEOUT_S: "1800" })).toBe((2 * 1800 + 300) * 1000);
    // Longer than the script's own bound (two waits + 90 s launch + 15 s halt).
    for (const settle of [1, 60, 900, 7200]) {
      expect(warpTimeoutMs({ E2E_WARP_SETTLE_TIMEOUT_S: String(settle) })).toBeGreaterThan((2 * settle + 105) * 1000);
    }
    for (const bad of ["0", "-5", "1.5", "abc", "86401"]) {
      expect(() => warpTimeoutMs({ E2E_WARP_SETTLE_TIMEOUT_S: bad }), bad).toThrow(/E2E_WARP_SETTLE_TIMEOUT_S/);
    }
  });

  it("is checked when the warp is set up, not at the first warp", () => {
    const base = {
      enabled: true,
      network: "localnet",
      rpcUrl: "http://127.0.0.1:18300",
      env: { E2E_RPC_PORT: "18300", E2E_WARP_SETTLE_TIMEOUT_S: "soon" },
      frontDir: "/nonexistent-front",
      rpc: {} as ChainRpc,
      journal: { append: () => undefined } as unknown as Journal,
      log: () => undefined,
    };
    expect(() => localnetWarp(base)).toThrow(/E2E_WARP_SETTLE_TIMEOUT_S/);
  });
});

describe("e2e-localnet.sh (sandbox)", () => {
  const FRONT = process.cwd();
  const roots: string[] = [];
  const fakes: ChildProcess[] = [];
  afterAll(() => {
    for (const fake of fakes) fake.kill("SIGKILL");
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  /** A git repository holding only the script, a scratch and an E2E_DIR outside it. */
  function sandbox() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "manci-e2e-localnet-")));
    roots.push(root);
    const repo = join(root, "repo");
    mkdirSync(join(repo, "front/scripts/chain"), { recursive: true });
    copyFileSync(join(FRONT, "scripts/chain/e2e-localnet.sh"), join(repo, "front/scripts/chain/e2e-localnet.sh"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    const scratch = join(root, "scratch");
    const dir = join(root, "e2e");
    const bin = join(root, "bin");
    for (const d of [join(scratch, "ledger"), dir, bin]) mkdirSync(d, { recursive: true });
    // Every port looks free: the host's own listeners (a local validator) stay out of it.
    writeFileSync(join(bin, "lsof"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "lsof"), 0o755);
    const ports = { E2E_RPC_PORT: "18300", E2E_GOSSIP_PORT: "18302", E2E_DYNAMIC_PORTS: "18310-18380", E2E_FAUCET_PORT: "18301" };
    const recorded = {
      CHAIN_NETWORK: "localnet",
      CHAIN_RPC_URL: "http://127.0.0.1:18300",
      CHAIN_GENESIS_HASH: "7cchg9crDeDw9G9yXiDMhsjcngtrxtPAC8YbFWZ8cuCs",
      E2E_DIR: dir,
      E2E_SCRATCH: scratch,
      ...ports,
    };
    writeFileSync(join(dir, "validator.txt"), Object.entries(recorded).map(([k, v]) => `${k}=${v}\n`).join(""));
    const run = (args: string[], env: Record<string, string>) =>
      spawnSync("bash", [join(repo, "front/scripts/chain/e2e-localnet.sh"), ...args], {
        encoding: "utf8",
        timeout: 30_000,
        env: { NODE_ENV: "test", PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, ...env },
      });
    /** A process that looks like this script's validator on `scratch`, with the given ports. */
    const fakeValidator = (rpc: string, gossip: string) => {
      const exe = join(bin, "solana-test-validator");
      writeFileSync(exe, "#!/bin/bash\nwhile :; do sleep 1; done\n");
      chmodSync(exe, 0o755);
      const child = spawn(
        "bash",
        [exe, "--ledger", join(scratch, "ledger"), "--bind-address", "127.0.0.1", "--rpc-port", rpc, "--gossip-port", gossip,
          "--dynamic-port-range", ports.E2E_DYNAMIC_PORTS, "--faucet-port", ports.E2E_FAUCET_PORT],
        { stdio: "ignore" },
      );
      fakes.push(child);
      writeFileSync(join(scratch, "validator.pid"), `${child.pid}\n`);
      return child;
    };
    const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
    return { root, scratch, dir, ports, run, fakeValidator, alive };
  }

  it("start needs E2E_RELEASE_DIR, and a v1.0.0-rc registry in it", () => {
    const box = sandbox();
    const base = { E2E_DIR: box.dir, E2E_SCRATCH: box.scratch, ...box.ports };
    const missing = box.run(["start"], base);
    expect(missing.status).toBe(2);
    expect(missing.stdout).toMatch(/E2E_RELEASE_DIR is required: a v1\.0\.0-rc artefact/);

    const release = join(box.root, "release");
    mkdirSync(release);
    writeFileSync(join(release, "asset_registry.so"), "a pre-v1 registry\n");
    writeFileSync(join(release, "transfer_hook.so"), "a hook\n");
    const sums = spawnSync("shasum", ["-a", "256", "asset_registry.so", "transfer_hook.so"], { cwd: release, encoding: "utf8" });
    if (sums.status !== 0) return; // no shasum on this host: the refusal above still ran
    writeFileSync(join(release, "SHA256SUMS"), sums.stdout);
    const old = box.run(["start"], { ...base, E2E_RELEASE_DIR: release });
    expect(old.status).toBe(1);
    expect(old.stdout).toMatch(/not a v1\.0\.0-rc build/);
  });

  it("warp refuses, stopping nothing, when this environment is not the recorded run", async () => {
    const box = sandbox();
    const fake = box.fakeValidator(box.ports.E2E_RPC_PORT, box.ports.E2E_GOSSIP_PORT);
    const base = { E2E_DIR: box.dir, E2E_SCRATCH: box.scratch, ...box.ports };
    // Another RPC port, a default gossip port, no E2E_SCRATCH, another RPC URL.
    const refused: Record<string, string>[] = [
      { ...base, E2E_RPC_PORT: "18400" },
      { E2E_DIR: box.dir, E2E_SCRATCH: box.scratch, E2E_RPC_PORT: "18300", E2E_DYNAMIC_PORTS: "18310-18380", E2E_FAUCET_PORT: "18301" },
      { E2E_DIR: box.dir, ...box.ports, TMPDIR: box.root },
      { ...base, CHAIN_RPC_URL: "http://127.0.0.1:8999" },
      { ...base, CHAIN_GENESIS_HASH: "11111111111111111111111111111111" },
    ];
    for (const env of refused) {
      const result = box.run(["warp", "123456"], env);
      expect(result.status, JSON.stringify(env)).toBe(1);
      expect(result.stdout).toMatch(/not this run's validator .*nothing stopped/);
    }
    // Without its validator.txt there is no run to match.
    const elsewhere = join(box.root, "other-e2e");
    mkdirSync(elsewhere);
    const none = box.run(["warp", "123456"], { ...base, E2E_DIR: elsewhere });
    expect(none.status).toBe(1);
    expect(none.stdout).toMatch(/no .*validator\.txt/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(box.alive(fake)).toBe(true);
  });

  it("warp refuses when the pid file's validator does not run with the recorded ports", async () => {
    const box = sandbox();
    // On this ledger, but started with the default gossip port (another run's env).
    const fake = box.fakeValidator(box.ports.E2E_RPC_PORT, "18100");
    const result = box.run(["warp", "123456"], { E2E_DIR: box.dir, E2E_SCRATCH: box.scratch, ...box.ports });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/does not run with --gossip-port 18302/);
    expect(result.stdout).toMatch(/not restarting pid/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(box.alive(fake)).toBe(true);
  });
});
