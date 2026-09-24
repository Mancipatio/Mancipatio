import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  candidateMatchesArtifact,
  parseHashesTxt,
  parseSbfSha256Txt,
  readArtifactProvenance,
} from "../scripts/ops/artifact-provenance.mjs";

// 2E ops hardening of the rollout inventory. Every spawned run below stops
// before RPC: either at argument validation or in dry-metadata mode.
const SCRIPT = join(process.cwd(), "scripts/ops/devnet-rollout-inventory.mjs");
const PROGRAMS = ["asset_registry", "transfer_hook"];
const tmp = mkdtempSync(join(tmpdir(), "manci-inventory-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A present env file pinning another network: if the script read it before
// validating arguments, it would fail with the devnet error instead.
const mainnetEnv = join(tmp, "mainnet.conf");
writeFileSync(mainnetEnv, "NEXT_PUBLIC_NETWORK=mainnet\n");

// `--` stops Node 22 from checking `--env-file` itself (see the script header).
function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, "--", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });
}

const HASHES_2D = [
  "base image: solanafoundation/solana-verifiable-build:3.1.13",
  "commit: e6d95593258943312099433356400282f4185b49",
  "asset_registry: 5b4c4859d0252681bc01e76e1394e3b51c37960a996da569fc8a3fbdfd770f03",
  "transfer_hook: 9b1d225d51a147ab8d66566451328bfb4d1340ba7e01035759680173e58fc9ea",
  "",
].join("\n");
const SBF_2D = [
  "151b19adfb93a64e4280c480d6e64612be6281555714a2afad030a6acc45dfe8  target/deploy/asset_registry.so",
  "afaa99c888e730f5835b3237f3f6a45a2623d7029e692c6b8ee09c77c34bfdee  target/deploy/transfer_hook.so",
  "",
].join("\n");

describe("devnet rollout inventory: evidence-run arguments", () => {
  it("requires --program-dir before reading the env file", () => {
    const out = run("--output", join(tmp, "a.json"), "--env-file", mainnetEnv);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("--program-dir PATH is required");
    expect(existsSync(join(tmp, "a.json"))).toBe(false);
  });

  it("requires --output before reading the env file", () => {
    const out = run("--program-dir", "../program", "--env-file", mainnetEnv);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("--output NEW_FILE is required");
  });

  it("refuses an existing output file and leaves it untouched", () => {
    const existing = join(tmp, "existing.json");
    writeFileSync(existing, "prior evidence\n");
    const out = run("--program-dir", "../program", "--output", existing, "--env-file", mainnetEnv);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("Refusing to overwrite existing evidence");
    expect(readFileSync(existing, "utf8")).toBe("prior evidence\n");
  });

  it("requires the env file for an evidence run", () => {
    const out = run("--program-dir", "../program", "--output", join(tmp, "b.json"), "--env-file", join(tmp, "missing.conf"));
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("Env file not found");
  });

  it("dry-metadata runs without an env file, RPC or output write", () => {
    const out = run("--dry-metadata", "--program-dir", "../program", "--env-file", join(tmp, "missing.conf"));
    expect(out.status, out.stderr).toBe(0);
    const report = JSON.parse(out.stdout);
    expect(report).toMatchObject({
      mode: "dry-metadata",
      rpc_calls: 0,
      output_written: false,
      output_file: null,
      env_file_present: false,
      network: null,
      rpc_hostname: null,
    });
    expect(report.script_git_head).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(report.candidates)).toEqual(PROGRAMS);
  });

  it("dry-metadata still rejects a present env file that is not devnet", () => {
    const out = run("--dry-metadata", "--program-dir", "../program", "--env-file", mainnetEnv);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("explicitly configured devnet network");
  });
});

describe("devnet rollout inventory: 2E blockers and write mode (static)", () => {
  const script = readFileSync(SCRIPT, "utf8");
  it("has no default evidence path and never overwrites", () => {
    expect(script).toContain("arg('--output', null)");
    expect(script).toContain("arg('--program-dir', null)");
    expect(script).toMatch(/writeFileSync\(outputFile, [^\n]*\{ flag: 'wx' \}\)/);
    expect(script).not.toContain("devnet-inventory.json");
  });
  it("turns v1 layouts and a missing EscrowIdentity into blockers", () => {
    for (const type of ["ShareClass", "PayoutVault", "VaultVote"]) {
      expect(script).toContain(`evidence.blockers.push(\`${type} \${addr}: version \${v.version} (v1 layout); the 2E program has no v1 path\`)`);
    }
    expect(script).toContain("evidence.blockers.push(`${ref.parent_type} ${ref.parent}: EscrowIdentity missing; no attach instruction after 2E`)");
  });
});

describe("candidate artifact provenance", () => {
  it("parses the verifiable-build hashes.txt and sbf-sha256.txt", () => {
    const hashes = parseHashesTxt(HASHES_2D, PROGRAMS);
    expect(hashes).toMatchObject({
      commit: "e6d95593258943312099433356400282f4185b49",
      base_image: "solanafoundation/solana-verifiable-build:3.1.13",
      verify_hashes: {
        asset_registry: "5b4c4859d0252681bc01e76e1394e3b51c37960a996da569fc8a3fbdfd770f03",
        transfer_hook: "9b1d225d51a147ab8d66566451328bfb4d1340ba7e01035759680173e58fc9ea",
      },
      errors: [],
    });
    const sbf = parseSbfSha256Txt(SBF_2D, PROGRAMS);
    expect(sbf.sha256.asset_registry).toBe("151b19adfb93a64e4280c480d6e64612be6281555714a2afad030a6acc45dfe8");
    expect(sbf.errors).toEqual([]);
  });

  it("reports malformed or missing fields as errors, not values", () => {
    const hashes = parseHashesTxt("commit: main\nasset_registry: xyz\n", PROGRAMS);
    expect(hashes.commit).toBeNull();
    expect(hashes.verify_hashes).toEqual({ asset_registry: null, transfer_hook: null });
    expect(hashes.errors).toHaveLength(3);
    expect(parseSbfSha256Txt("", PROGRAMS).errors).toHaveLength(2);
  });

  it("reads a directory and compares candidates only when there is a recorded hash", () => {
    const dir = mkdtempSync(join(tmp, "artifact-"));
    expect(readArtifactProvenance(dir, PROGRAMS)).toEqual({ hashes_txt: { present: false }, sbf_sha256_txt: { present: false } });
    writeFileSync(join(dir, "hashes.txt"), HASHES_2D);
    writeFileSync(join(dir, "sbf-sha256.txt"), SBF_2D);
    const provenance = readArtifactProvenance(dir, PROGRAMS);
    expect(provenance.hashes_txt.present && provenance.hashes_txt.commit).toBe("e6d95593258943312099433356400282f4185b49");
    const good = { sha256: "151b19adfb93a64e4280c480d6e64612be6281555714a2afad030a6acc45dfe8" };
    expect(candidateMatchesArtifact(good, provenance, "asset_registry")).toBe(true);
    expect(candidateMatchesArtifact({ sha256: "0".repeat(64) }, provenance, "asset_registry")).toBe(false);
    expect(candidateMatchesArtifact({ missing: true }, provenance, "asset_registry")).toBeNull();
    expect(candidateMatchesArtifact(good, readArtifactProvenance(tmp, PROGRAMS), "asset_registry")).toBeNull();
  });
});
