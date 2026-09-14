import path from "node:path";
import { defineConfig } from "vitest/config";

// Explicit operator command only; the normal offline CI suite never runs these
// live calls. Authentication consumes disposable SIWS nonces in the real DB.
export default defineConfig({
  envDir: false,
  resolve: { alias: { "@": path.resolve(__dirname, "../..") } },
  test: {
    environment: "node",
    include: ["scripts/ops/deployment-smoke.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
