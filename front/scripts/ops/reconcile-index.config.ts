import path from "node:path";
import { defineConfig } from "vitest/config";

// Explicit operator invocation only; excluded from the normal offline CI suite.
export default defineConfig({
  envDir: false,
  resolve: { alias: { "@": path.resolve(__dirname, "../..") } },
  test: {
    environment: "node",
    include: ["scripts/ops/reconcile-index.test.ts"],
    fileParallelism: false,
    testTimeout: 50_000,
  },
});
