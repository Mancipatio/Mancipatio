import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import bootstrapConfig from "@/scripts/chain/bootstrap.config";
import idlConfig from "@/scripts/chain/idl.config";
import inventoryConfig from "@/scripts/chain/inventory.config";
import squadsConfig from "@/scripts/chain/squads-export.config";
import { runTool } from "@/scripts/chain/lib/context";
import { inventoryTool } from "@/scripts/chain/lib/inventory";
import { DEFAULT_DEADLINE_MIN, MAX_DEADLINE_MIN, repoRoot, type ChainTool } from "@/scripts/chain/lib/safety";
import { FakeChain, tempDir } from "./helpers/chain-fake";

const configs: Record<ChainTool, typeof bootstrapConfig> = {
  bootstrap: bootstrapConfig,
  idl: idlConfig,
  inventory: inventoryConfig,
  "squads-export": squadsConfig,
};

describe("chain runner configs (§3.8)", () => {
  it.each(Object.keys(configs) as ChainTool[])("%s: timeouts exceed the internal deadline; one serial fork", (tool) => {
    const test = configs[tool].test!;
    const deadlineMs = DEFAULT_DEADLINE_MIN[tool] * 60_000;
    expect(test.testTimeout).toBeGreaterThan(deadlineMs);
    expect(test.hookTimeout).toBeGreaterThan(deadlineMs);
    expect(test.testTimeout).toBeGreaterThan(MAX_DEADLINE_MIN * 60_000);
    expect(test.teardownTimeout).toBe(60_000);
    expect(test.include).toEqual([`scripts/chain/${tool}.test.ts`]);
    expect(test.environment).toBe("node");
    expect(test.fileParallelism).toBe(false);
    expect(test.pool).toBe("forks");
    expect(test.bail).toBe(1);
    expect(test.disableConsoleIntercept).toBe(true);
    expect(configs[tool].envDir).toBe(false);
  });

  it("package.json exposes one script per tool, each on its own config", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    for (const tool of Object.keys(configs)) {
      expect(pkg.scripts[`chain:${tool}`]).toBe(`vitest run --config scripts/chain/${tool}.config.ts --reporter=verbose`);
    }
  });

  it("the offline suite never includes the runners", () => {
    const config = fs.readFileSync(path.resolve(__dirname, "../vitest.config.ts"), "utf8");
    expect(config).toContain('include: ["tests/**/*.test.ts"]');
  });

  it("an abort still flushes the evidence file", async () => {
    const chain = new FakeChain();
    const dir = tempDir();
    const output = path.join(dir, "aborted.json");
    const controller = new AbortController();
    controller.abort();
    const evidence = await runTool(
      "inventory",
      { CHAIN_NETWORK: "devnet", CHAIN_RPC_URL: "https://rpc.example.test/", CHAIN_OUTPUT: output, CHAIN_STATE_DIR: dir },
      inventoryTool,
      { transport: chain.transport, rps: Infinity, root: repoRoot(), signal: controller.signal, log: () => {} },
    );
    expect(evidence.status).toBe("aborted");
    const written = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(written.status).toBe("aborted");
    expect(written.schema).toBe("mancipatio-chain-inventory-v1");
    expect(written.error).toMatch(/aborted/i);
    expect(written.finishedUtc).toBeTruthy();
    expect(JSON.stringify(written)).not.toContain("https://rpc.example.test");
  });
});
