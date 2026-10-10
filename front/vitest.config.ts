// Vitest config — pure unit tests over lib/ (no jsdom, no React).
// The suites in tests/** exercise browser-agnostic modules only; Node 22's
// global WebCrypto covers the `crypto.subtle` usage in lib/merkle.ts.
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The suites of what KYC-only mode keeps open (lib/features.ts kycOnly):
 * sign-in, the account, the Terms, the verification (KYC) request, the
 * passport, the contact form, the admin console's KYC processing, purchase
 * recovery and the exits of existing positions. Run a second time with the
 * mode ON (project "kyc-only-on"), as mainnet runs: a gate that lands on one
 * of these paths by mistake fails here, not on the mainnet deploy. A suite
 * that expects the mode's own refusal reads kycOnly() (a new KYB in
 * verification-submit-route). tests/kyc-only*.test.ts stub the mode
 * themselves and run once.
 */
const KYC_ONLY_OPEN_SUITES = [
  // Sign-in and the account.
  "tests/account-auth.test.ts",
  "tests/account-client.test.ts",
  "tests/account-google.test.ts",
  "tests/account-origin.test.ts",
  "tests/account-profile.test.ts",
  "tests/account-wallet-attach-passport.test.ts",
  "tests/account-wallet-link.test.ts",
  "tests/email-start-route.test.ts",
  "tests/identity-link-route.test.ts",
  "tests/login-guard-surfaces.test.ts",
  "tests/siws-client.test.ts",
  "tests/siws-client-session.test.ts",
  "tests/siws-offchain.test.ts",
  "tests/siws-signing.test.ts",
  // The Terms, the verification request, its documents and the passport.
  "tests/tos-server-gate.test.ts",
  "tests/verification-submit-purpose.test.ts",
  "tests/verification-submit-route.test.ts",
  "tests/client-privacy-routes.test.ts",
  "tests/passport-*.test.ts",
  // The admin console's KYC processing.
  "tests/kyc-pipeline.test.ts",
  "tests/kyc-provider-gate.test.ts",
  "tests/kyc-provider-routes.test.ts",
  "tests/route-guard-matrix.test.ts",
  // Support.
  "tests/inquiries-create-route.test.ts",
  // Purchase recovery, custody recording and the exits of existing positions.
  "tests/chain-record-recovery.test.ts",
  "tests/custody-evidence-server.test.ts",
  "tests/onchain-screening.test.ts",
  "tests/reclaim-rent.test.ts",
  "tests/reclaim-ui-gates.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the `@/*` path alias from tsconfig.json.
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "default",
          include: ["tests/**/*.test.ts"],
          // KYC-only mode is ON on mainnet unless this reads as off. The suite
          // pins today's behaviour with the mode off; the tests of the mode
          // stub it ("" = unset, "on"). See tests/kyc-only*.test.ts.
          env: { NEXT_PUBLIC_FEATURE_KYC_ONLY: "off" },
        },
      },
      {
        extends: true,
        test: {
          name: "kyc-only-on",
          include: KYC_ONLY_OPEN_SUITES,
          // On for every network, as mainnet runs while the variable is unset.
          env: { NEXT_PUBLIC_FEATURE_KYC_ONLY: "on" },
        },
      },
    ],
  },
});
