// Network-scoped feature flags (lib/features.ts): every flag is on off
// mainnet (issuerRotation unless its kill switch reads as off); on mainnet a
// flag is on only with its NEXT_PUBLIC_FEATURE_* reading as on. Since 8.4
// (front-app-8) "on" is true/1/yes/on and "off" false/0/no/off, any case:
// the old exact-"true" rule silently kept `TRUE` off (the issuer recovery
// panel with it); next.config.ts refuses any other value at build time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBuildFeatureFlags, FEATURE_FLAG_NAMES, FEATURE_FLAG_VALUES, permissionsPolicy } from "@/next.config";
import { featureDisabledMessage, features, LEDGER_USB_ENV, ledgerUsbWalletEnabled, parseFeatureFlag } from "@/lib/features";

afterEach(() => vi.unstubAllEnvs());

// The "Ledger (USB)" wallet: on everywhere (mainnet included) unless its kill
// switch reads as off; next.config.ts denies WebHID exactly when it is off.
describe("ledgerUsbWalletEnabled()", () => {
  it.each(["mainnet", "devnet"])("is on by default on %s and off only for a value that reads as off", (network) => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", network);
    for (const value of [undefined, "", "true", "1", "yes", "on", "TRUE", "ture", "enabled"]) {
      vi.stubEnv(LEDGER_USB_ENV, value);
      expect(ledgerUsbWalletEnabled(), String(value)).toBe(true);
    }
    for (const value of ["false", "0", "no", "off", " OFF "]) {
      vi.stubEnv(LEDGER_USB_ENV, value);
      expect(ledgerUsbWalletEnabled(), value).toBe(false);
    }
  });

  it("agrees with the Permissions-Policy (hid) and the build guard", () => {
    for (const value of [undefined, "", " off ", "garbage", ...FEATURE_FLAG_VALUES, ...FEATURE_FLAG_VALUES.map((v) => v.toUpperCase())]) {
      vi.stubEnv(LEDGER_USB_ENV, value);
      expect(permissionsPolicy(process.env).endsWith(ledgerUsbWalletEnabled() ? "hid=(self)" : "hid=()"), String(value)).toBe(true);
    }
    expect(FEATURE_FLAG_NAMES).toContain(LEDGER_USB_ENV);
    expect(() => assertBuildFeatureFlags("phase-production-build", { [LEDGER_USB_ENV]: "of" })).toThrow(LEDGER_USB_ENV);
    expect(() => assertBuildFeatureFlags("phase-production-build", { [LEDGER_USB_ENV]: "off" })).not.toThrow();
  });
});

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
    "turns issuer rotation off on %s only for a kill-switch value that reads as off",
    (network) => {
      for (const value of [" false ", "FALSE", "0", "off", "no"]) {
        vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", value);
        expect(features(network).issuerRotation, value).toBe(false);
      }
      for (const value of ["", "true", "falsy"]) {
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

  it("enables a mainnet flag only for a value that reads as on", () => {
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

    for (const [value, on] of [["TRUE", true], ["True", true], [" 1 ", true], ["yes", true], ["On", true],
      ["truthy", false], ["false", false], ["off", false]] as const) {
      vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", value);
      vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", value);
      vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", value);
      vi.stubEnv("NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE", value);
      expect(features("mainnet"), value).toEqual({
        payoutAirdrop: on,
        startupRaises: on,
        issuerRotation: on,
        passportClose: on,
      });
    }
  });

  it("reads exactly the spellings the build guard accepts (next.config.ts FEATURE_FLAG_VALUES)", () => {
    for (const value of FEATURE_FLAG_VALUES) expect(parseFeatureFlag(value.toUpperCase()), value).not.toBeNull();
    for (const value of ["", undefined, "ture", "enabled", "2"]) expect(parseFeatureFlag(value), String(value)).toBeNull();
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
