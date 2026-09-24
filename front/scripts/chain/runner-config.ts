/**
 * Shared vitest config for the chain CLI runners (design-3.3 §3.8). The
 * runners are explicit operator commands (`npm run chain:*`); the offline CI
 * suite (vitest.config.ts, include `tests/**`) never picks them up.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import type { ChainTool } from "./lib/safety";

/** 4 h: always above the internal CHAIN_DEADLINE_MIN (at most 230 min). */
export const RUNNER_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const RUNNER_TEARDOWN_MS = 60_000;

const here = path.dirname(fileURLToPath(import.meta.url));

export function chainRunnerConfig(tool: ChainTool) {
  return defineConfig({
    // Never load .env files: every input is an explicit CHAIN_* variable.
    envDir: false,
    resolve: { alias: { "@": path.resolve(here, "../..") } },
    test: {
      environment: "node",
      include: [`scripts/chain/${tool}.test.ts`],
      fileParallelism: false,
      pool: "forks",
      bail: 1,
      disableConsoleIntercept: true,
      testTimeout: RUNNER_TIMEOUT_MS,
      hookTimeout: RUNNER_TIMEOUT_MS,
      teardownTimeout: RUNNER_TEARDOWN_MS,
    },
  });
}
