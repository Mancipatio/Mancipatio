// Network-scoped feature flags. Importable from client components, server
// components and route handlers alike (no "use client" / "server-only"): the
// UI hides a disabled feature and the API routes refuse it, both from the one
// function below.
//
// Every flag is ON for devnet / testnet / localnet. On mainnet a flag is ON
// only when its NEXT_PUBLIC_FEATURE_* variable reads as on — true, 1, yes or
// on, any case, surrounding spaces ignored — so an unset, empty or misspelled
// value keeps the feature off (and a production build refuses a value that is
// neither on nor off: next.config.ts assertBuildFeatureFlags). `issuerRotation`
// also has a kill switch for every network: NEXT_PUBLIC_FEATURE_ISSUER_ROTATION
// set to false (0, no, off) turns it off on devnet / testnet / localnet too
// (the 2C-2 rollback step). The variables are
// NEXT_PUBLIC_ so the client bundle sees the same answer the server enforces;
// they are inlined at build time, so flipping one needs a rebuild.

import { detectNetwork, type Network } from "@/lib/network";

export type Features = {
  /** Admin-wallet push airdrop of a payout (/admin/payouts/[id]). */
  payoutAirdrop: boolean;
  /** Startup (vested payout-vault) raises: /apply option + issuer launchpad. */
  startupRaises: boolean;
  /**
   * Issuer authority rotation and timelocked recovery (program 2C-2):
   * /issuer/rotation, the admin recovery panel, and the sale / payout-vault
   * sync bundled into close / payout flows. Off hides the UI and stops the
   * sync bundling (the rollback switch; `=false` works on every network).
   * The issuer's recovery notice (IssuerRecoveryBanner) stays on regardless.
   */
  issuerRotation: boolean;
  /**
   * 2D "Close revoked passport" (the KycEntry arm of reclaim_rent) on
   * /admin/clients/[id]. Owner decision D13: the lawyer must confirm AML
   * retention versus the on-chain KycEntry close before it is enabled on
   * mainnet — set NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE=true only after that
   * sign-off. The UI hides the button and `closePassport` refuses when off.
   */
  passportClose: boolean;
};

export type FeatureName = keyof Features;

export const FEATURE_LABELS: Record<FeatureName, string> = {
  payoutAirdrop: "Admin-wallet payout airdrops",
  startupRaises: "Startup raises",
  issuerRotation: "Issuer key rotation and recovery",
  passportClose: "Revoked passport closes",
};

/** true / false for the accepted spellings (next.config.ts FEATURE_FLAG_VALUES), null otherwise. */
export function parseFeatureFlag(value: string | undefined): boolean | null {
  const v = value?.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return null;
}

function mainnetOptIn(value: string | undefined): boolean {
  return parseFeatureFlag(value) === true;
}

/** Off only when the variable reads as off (the non-mainnet kill switch). */
function killSwitchOff(value: string | undefined): boolean {
  return parseFeatureFlag(value) === false;
}

export function features(network: Network = detectNetwork()): Features {
  if (network !== "mainnet") {
    return {
      payoutAirdrop: true,
      startupRaises: true,
      issuerRotation: !killSwitchOff(process.env.NEXT_PUBLIC_FEATURE_ISSUER_ROTATION),
      passportClose: true,
    };
  }
  // Literal process.env.NEXT_PUBLIC_* reads so Next inlines them client-side.
  return {
    payoutAirdrop: mainnetOptIn(process.env.NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP),
    startupRaises: mainnetOptIn(process.env.NEXT_PUBLIC_FEATURE_STARTUP_RAISES),
    issuerRotation: mainnetOptIn(process.env.NEXT_PUBLIC_FEATURE_ISSUER_ROTATION),
    // D13: stays off on mainnet until the lawyer's sign-off.
    passportClose: mainnetOptIn(process.env.NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE),
  };
}

/** User-facing sentence for a feature that is off on this network. The
 *  network is lower case ("Solana mainnet"), like the stage badge
 *  (mxStageLabel) and the rest of the marketing copy. */
export function featureDisabledMessage(
  name: FeatureName,
  network: Network = detectNetwork(),
): string {
  return `${FEATURE_LABELS[name]} are not enabled on Solana ${network}.`;
}
