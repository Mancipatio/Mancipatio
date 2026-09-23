// Network-scoped feature flags (lib/features.ts): every flag is on off
// mainnet; on mainnet a flag is on only with its NEXT_PUBLIC_FEATURE_* set to
// exactly "true".
import { afterEach, describe, expect, it, vi } from "vitest";
import { featureDisabledMessage, features } from "@/lib/features";

afterEach(() => vi.unstubAllEnvs());

describe("features()", () => {
  it.each(["devnet", "testnet", "localnet"] as const)(
    "enables every flag on %s, even when the mainnet opt-ins say false",
    (network) => {
      vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "false");
      vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "false");
      expect(features(network)).toEqual({ payoutAirdrop: true, startupRaises: true });
    },
  );

  it("disables every flag on mainnet by default", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "");
    expect(features("mainnet")).toEqual({ payoutAirdrop: false, startupRaises: false });
  });

  it("enables a mainnet flag only for the exact value \"true\"", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "true");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "");
    expect(features("mainnet")).toEqual({ payoutAirdrop: true, startupRaises: false });

    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", " true ");
    expect(features("mainnet")).toEqual({ payoutAirdrop: false, startupRaises: true });

    for (const value of ["TRUE", "True", "1", "yes", "on", "truthy"]) {
      vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", value);
      vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", value);
      expect(features("mainnet"), value).toEqual({
        payoutAirdrop: false,
        startupRaises: false,
      });
    }
  });

  it("defaults to the build's network (NEXT_PUBLIC_NETWORK)", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "true");
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    expect(features()).toEqual({ payoutAirdrop: false, startupRaises: true });
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    expect(features()).toEqual({ payoutAirdrop: true, startupRaises: true });
  });

  it("names the feature and the network in the refusal copy", () => {
    expect(featureDisabledMessage("payoutAirdrop", "mainnet")).toBe(
      "Admin-wallet payout airdrops are not enabled on Solana Mainnet.",
    );
    expect(featureDisabledMessage("startupRaises", "mainnet")).toBe(
      "Startup raises are not enabled on Solana Mainnet.",
    );
  });
});
