// Vitest config — pure unit tests over lib/ (no jsdom, no React).
// The suites in tests/** exercise browser-agnostic modules only; Node 22's
// global WebCrypto covers the `crypto.subtle` usage in lib/merkle.ts.
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the `@/*` path alias from tsconfig.json.
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // KYC-only mode is ON on mainnet unless this reads as off. The suite pins
    // today's behaviour with the mode off; the tests of the mode stub it
    // ("" = unset, "on"). See tests/kyc-only*.test.ts.
    env: { NEXT_PUBLIC_FEATURE_KYC_ONLY: "off" },
  },
});
