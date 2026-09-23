// Network-scoped feature flags (lib/features.ts): every flag is on off
// mainnet (issuerRotation unless its kill switch is exactly "false"); on
// mainnet a flag is on only with its NEXT_PUBLIC_FEATURE_* set to exactly
// "true".
import { afterEach, describe, expect, it, vi } from "vitest";
import { featureDisabledMessage, features } from "@/lib/features";

afterEach(() => vi.unstubAllEnvs());

describe("features()", () => {
  it.each(["devnet", "testnet", "localnet"] as const)(
    "enables every flag on %s, even when the mainnet opt-ins say false (except the rotation kill switch)",
    (network) => {
      vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "false");
      vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "false");
      vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "");
      vi.stubEnv("NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE", "false");
      expect(features(network)).toEqual({ payoutAirdrop: true, startupRaises: true, issuerRotation: true, passportClose: true });
    },
  );

  it.each(["devnet", "testnet", "localnet"] as const)(
    "turns issuer rotation off on %s only for the exact kill-switch value \"false\"",
    (network) => {
      vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", " false ");
      expect(features(network).issuerRotation).toBe(false);
      for (const value of ["", "true", "FALSE", "0", "off", "no"]) {
        vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", value);
        expect(features(network).issuerRotation, value).toBe(true);
      }
    },
  );

  it("disables every flag on mainnet by default", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE", "");
    expect(features("mainnet")).toEqual({ payoutAirdrop: false, startupRaises: false, issuerRotation: false, passportClose: false });
  });

  it("enables a mainnet flag only for the exact value \"true\"", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "true");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE", "");
    expect(features("mainnet")).toEqual({ payoutAirdrop: true, startupRaises: false, issuerRotation: false, passportClose: false });

    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", " true ");
    expect(features("mainnet")).toEqual({ payoutAirdrop: false, startupRaises: true, issuerRotation: false, passportClose: false });

    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "true");
    expect(features("mainnet")).toEqual({ payoutAirdrop: false, startupRaises: false, issuerRotation: true, passportClose: false });

    // D13: the passport close only after the lawyer's sign-off flips it.
    vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE", "true");
    expect(features("mainnet")).toEqual({ payoutAirdrop: false, startupRaises: false, issuerRotation: false, passportClose: true });
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE", "");

    for (const value of ["TRUE", "True", "1", "yes", "on", "truthy"]) {
      vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", value);
      vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", value);
      vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", value);
      vi.stubEnv("NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE", value);
      expect(features("mainnet"), value).toEqual({
        payoutAirdrop: false,
        startupRaises: false,
        issuerRotation: false,
        passportClose: false,
      });
    }
  });

  it("defaults to the build's network (NEXT_PUBLIC_NETWORK)", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "true");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE", "");
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    expect(features()).toEqual({ payoutAirdrop: false, startupRaises: true, issuerRotation: false, passportClose: false });
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    expect(features()).toEqual({ payoutAirdrop: true, startupRaises: true, issuerRotation: true, passportClose: true });
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
    expect(featureDisabledMessage("passportClose", "mainnet")).toBe(
      "Revoked passport closes are not enabled on Solana mainnet.",
    );
  });
});
