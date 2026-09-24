// Talas 6.3: chain:e2e configuration gates — devnet and localnet only (even
// with CHAIN_ALLOW_MAINNET), an explicit payer, sane groups and run ids, and
// the state/key files (mode 600 inside a 700 directory, atomic, resumable).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readE2eConfig } from "@/scripts/chain/lib/e2e/config";
import { keysDir, loadOrCreateRoleKey } from "@/scripts/chain/lib/e2e/keys";
import { assertStateMatches, entity, loadState, newState, saveState, statePath } from "@/scripts/chain/lib/e2e/state";
import { readChainConfig } from "@/scripts/chain/lib/safety";
import { tempDir } from "./helpers/chain-fake";

const PAYER = "CekAgg4nCW8tgUETKstwBxKXcWDC5SFRTaZPyQ1vM8vA";
const ROOT = "/nonexistent-root";

describe("readE2eConfig", () => {
  it("refuses mainnet and testnet", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      expect(() => readE2eConfig({ E2E_PAYER: PAYER }, network, ROOT)).toThrow(/devnet or localnet only/);
    }
  });

  it("refuses the e2e tool on mainnet in the shared config too, whatever CHAIN_ALLOW_MAINNET says", () => {
    expect(() =>
      readChainConfig(
        "e2e",
        { CHAIN_NETWORK: "mainnet", CHAIN_ALLOW_MAINNET: "1", CHAIN_RPC_URL: "https://example.invalid", CHAIN_OUTPUT: "/tmp/x.json" },
        { root: ROOT },
      ),
    ).toThrow(/devnet or localnet only/);
  });

  it("needs a valid payer", () => {
    expect(() => readE2eConfig({}, "devnet", ROOT)).toThrow(/E2E_PAYER is required/);
    expect(() => readE2eConfig({ E2E_PAYER: "not-an-address" }, "devnet", ROOT)).toThrow(/not a valid address/);
  });

  it("defaults: devnet groups 1-3, localnet 0-3, per-network directory, budgets", () => {
    const devnet = readE2eConfig({ E2E_PAYER: PAYER }, "devnet", ROOT);
    expect(devnet.groups).toEqual([1, 2, 3]);
    expect(devnet.dir).toBe(path.join(ROOT, "docs", "mainnet-readiness", "e2e-6.3", "devnet"));
    expect(devnet.checkpointWaitMin).toBe(0);
    expect(devnet.minPayerLamports).toBe(BigInt(1_000_000_000));
    expect(devnet.maxRequests).toBe(2500);
    const localnet = readE2eConfig({ E2E_PAYER: PAYER }, "localnet", ROOT);
    expect(localnet.groups).toEqual([0, 1, 2, 3]);
    expect(localnet.maxRequests).toBe(20000);
  });

  it("group 0 is refused on devnet; run ids and numbers are validated", () => {
    expect(() => readE2eConfig({ E2E_PAYER: PAYER, E2E_GROUPS: "0-1" }, "devnet", ROOT)).toThrow(/localnet only/);
    expect(() => readE2eConfig({ E2E_PAYER: PAYER, E2E_GROUPS: "x" }, "devnet", ROOT)).toThrow(/E2E_GROUPS/);
    expect(() => readE2eConfig({ E2E_PAYER: PAYER, E2E_RUN_ID: "UPPER" }, "devnet", ROOT)).toThrow(/E2E_RUN_ID/);
    expect(readE2eConfig({ E2E_PAYER: PAYER, E2E_RUN_ID: "abc123" }, "devnet", ROOT).runId).toBe("abc123");
    expect(() => readE2eConfig({ E2E_PAYER: PAYER, E2E_CHECKPOINT_WAIT_MIN: "-1" }, "devnet", ROOT)).toThrow(/E2E_CHECKPOINT_WAIT_MIN/);
    expect(() => readE2eConfig({ E2E_PAYER: PAYER, E2E_MAX_REQUESTS: "1e9" }, "devnet", ROOT)).toThrow(/E2E_MAX_REQUESTS/);
  });
});

describe("e2e role keys", () => {
  it("creates a 64-byte keypair once (700 dir, 600 file) and reloads the same key", async () => {
    const dir = tempDir("e2e-keys-");
    const first = await loadOrCreateRoleKey(dir, "buyer1");
    const again = await loadOrCreateRoleKey(dir, "buyer1");
    expect(again.address).toBe(first.address);
    const file = path.join(keysDir(dir), "buyer1.json");
    expect(fs.statSync(keysDir(dir)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const bytes = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
    expect(bytes).toHaveLength(64);
    const other = await loadOrCreateRoleKey(dir, "buyer2");
    expect(other.address).not.toBe(first.address);
  });

  it("refuses bad role names and corrupt files without echoing their content", async () => {
    const dir = tempDir("e2e-keys-");
    await expect(loadOrCreateRoleKey(dir, "../evil")).rejects.toThrow(/Invalid e2e role name/);
    fs.mkdirSync(keysDir(dir), { recursive: true });
    fs.writeFileSync(path.join(keysDir(dir), "broken.json"), "[1,2,3]");
    await expect(loadOrCreateRoleKey(dir, "broken")).rejects.toThrow(/not a 64-byte keypair/);
    fs.writeFileSync(path.join(keysDir(dir), "garbage.json"), "secret-looking-text");
    const error = await loadOrCreateRoleKey(dir, "garbage").catch((e: Error) => e);
    expect(String(error)).toMatch(/details withheld/);
    expect(String(error)).not.toContain("secret-looking-text");
  });
});

describe("e2e state", () => {
  it("round-trips atomically with mode 600 and no temporary file left", () => {
    const dir = tempDir("e2e-state-");
    const state = newState({ network: "devnet", genesis: "G", runId: "abcd12" });
    state.entities.issuer = "I";
    state.steps["1.2"] = { status: "passed", signature: "sig", actual: null, at: "t" };
    saveState(dir, state);
    expect(fs.statSync(statePath(dir)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const loaded = loadState(dir)!;
    expect(loaded).toEqual(state);
    expect(entity(loaded, "issuer")).toBe("I");
    expect(() => entity(loaded, "asset")).toThrow(/no asset yet/);
    expect(loadState(tempDir("e2e-empty-"))).toBeNull();
  });

  it("refuses a state from another network, genesis or run, and a malformed one", () => {
    const state = newState({ network: "devnet", genesis: "G", runId: "abcd12" });
    expect(() => assertStateMatches(state, { network: "localnet", genesis: "G", runId: null })).toThrow(/belongs to devnet/);
    expect(() => assertStateMatches(state, { network: "devnet", genesis: "H", runId: null })).toThrow(/belongs to devnet/);
    expect(() => assertStateMatches(state, { network: "devnet", genesis: "G", runId: "zzzz99" })).toThrow(/differs from the run/);
    expect(() => assertStateMatches(state, { network: "devnet", genesis: "G", runId: "abcd12" })).not.toThrow();
    const dir = tempDir("e2e-bad-");
    fs.writeFileSync(statePath(dir), "{");
    expect(() => loadState(dir)).toThrow(/not valid JSON/);
    fs.writeFileSync(statePath(dir), JSON.stringify({ schema: "other" }));
    expect(() => loadState(dir)).toThrow(/unexpected shape/);
  });
});
