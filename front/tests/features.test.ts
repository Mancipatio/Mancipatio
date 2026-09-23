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
      vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "false");
      expect(features(network)).toEqual({ payoutAirdrop: true, startupRaises: true, issuerRotation: true });
    },
  );

  it("disables every flag on mainnet by default", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "");
    expect(features("mainnet")).toEqual({ payoutAirdrop: false, startupRaises: false, issuerRotation: false });
  });

  it("enables a mainnet flag only for the exact value \"true\"", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "true");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "");
    expect(features("mainnet")).toEqual({ payoutAirdrop: true, startupRaises: false, issuerRotation: false });

    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", " true ");
    expect(features("mainnet")).toEqual({ payoutAirdrop: false, startupRaises: true, issuerRotation: false });

    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "true");
    expect(features("mainnet")).toEqual({ payoutAirdrop: false, startupRaises: false, issuerRotation: true });

    for (const value of ["TRUE", "True", "1", "yes", "on", "truthy"]) {
      vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", value);
      vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", value);
      vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", value);
      expect(features("mainnet"), value).toEqual({
        payoutAirdrop: false,
        startupRaises: false,
        issuerRotation: false,
      });
    }
  });

  it("defaults to the build's network (NEXT_PUBLIC_NETWORK)", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "true");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "");
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    expect(features()).toEqual({ payoutAirdrop: false, startupRaises: true, issuerRotation: false });
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    expect(features()).toEqual({ payoutAirdrop: true, startupRaises: true, issuerRotation: true });
  });

  it("names the feature and the network in the refusal copy", () => {
    // Lower-case network, like the stage badge ("Solana mainnet · v0.1").
    expect(featureDisabledMessage("payoutAirdrop", "mainnet")).toBe(
      "Admin-wallet payout airdrops are not enabled on Solana mainnet.",
    );
    expect(featureDisabledMessage("startupRaises", "mainnet")).toBe(
      "Startup raises are not enabled on Solana mainnet.",
    );
    expect(featureDisabledMessage("issuerRotation", "mainnet")).toBe(
      "Issuer key rotation and recovery are not enabled on Solana mainnet.",
    );
  });
});
