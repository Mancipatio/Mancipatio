/**
 * `npm run sim`: the devnet 100-user simulator (docs/mainnet-readiness/sim).
 * Like the chain CLI runners (scripts/chain/runner-config.ts), vitest only
 * runs TypeScript with the `@/` alias; the offline CI suite (vitest.config.ts,
 * include `tests/**`) never picks this runner up.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { RUNNER_TEARDOWN_MS, RUNNER_TIMEOUT_MS } from "../chain/runner-config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Never load .env files: every input is an explicit SIM_* / CHAIN_* variable.
  envDir: false,
  resolve: { alias: { "@": path.resolve(here, "../..") } },
  test: {
    environment: "node",
    include: ["scripts/sim/sim.test.ts"],
    fileParallelism: false,
    pool: "forks",
    bail: 1,
    disableConsoleIntercept: true,
    testTimeout: RUNNER_TIMEOUT_MS,
    hookTimeout: RUNNER_TIMEOUT_MS,
    teardownTimeout: RUNNER_TEARDOWN_MS,
  },
});
