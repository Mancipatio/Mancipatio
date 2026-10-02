import path from "node:path";
import { defineConfig } from "vitest/config";

// Explicit operator command only (`npm run ops:inspect-tx`); excluded from the
// normal offline CI suite, which tests scripts/ops/inspect-tx.ts directly.
export default defineConfig({
  envDir: false,
  resolve: { alias: { "@": path.resolve(__dirname, "../..") } },
  test: {
    environment: "node",
    include: ["scripts/ops/inspect-tx.test.ts"],
    fileParallelism: false,
    disableConsoleIntercept: true,
    testTimeout: 30_000,
  },
});
