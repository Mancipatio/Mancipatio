import path from "node:path";
import { defineConfig } from "vitest/config";

// Offline full-reconcile benchmark (isolated PostgreSQL, in-memory chain);
// excluded from the normal suite: `npm run ops:reconcile-bench`.
export default defineConfig({
  envDir: false,
  resolve: { alias: { "@": path.resolve(__dirname, "../..") } },
  test: {
    environment: "node",
    include: ["scripts/ops/reconcile-bench.test.ts"],
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    hookTimeout: 180_000,
  },
});
