// Network-scoped feature flags. Importable from client components, server
// components and route handlers alike (no "use client" / "server-only"): the
// UI hides a disabled feature and the API routes refuse it, both from the one
// function below.
//
// Every flag is ON for devnet / testnet / localnet. On mainnet a flag is ON
// only when its NEXT_PUBLIC_FEATURE_* variable is exactly "true" — an unset,
// empty or misspelled value keeps the feature off. The variables are
// NEXT_PUBLIC_ so the client bundle sees the same answer the server enforces;
// they are inlined at build time, so flipping one needs a rebuild.

import { detectNetwork, networkLabel, type Network } from "@/lib/network";

export type Features = {
  /** Admin-wallet push airdrop of a payout (/admin/payouts/[id]). */
  payoutAirdrop: boolean;
  /** Startup (vested payout-vault) raises: /apply option + issuer launchpad. */
  startupRaises: boolean;
};

export type FeatureName = keyof Features;

export const FEATURE_LABELS: Record<FeatureName, string> = {
  payoutAirdrop: "Admin-wallet payout airdrops",
  startupRaises: "Startup raises",
};

function mainnetOptIn(value: string | undefined): boolean {
  return value?.trim() === "true";
}

export function features(network: Network = detectNetwork()): Features {
  if (network !== "mainnet") {
    return { payoutAirdrop: true, startupRaises: true };
  }
  // Literal process.env.NEXT_PUBLIC_* reads so Next inlines them client-side.
  return {
    payoutAirdrop: mainnetOptIn(process.env.NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP),
    startupRaises: mainnetOptIn(process.env.NEXT_PUBLIC_FEATURE_STARTUP_RAISES),
  };
}

/** User-facing sentence for a feature that is off on this network. */
export function featureDisabledMessage(
  name: FeatureName,
  network: Network = detectNetwork(),
): string {
  return `${FEATURE_LABELS[name]} are not enabled on Solana ${networkLabel(network)}.`;
}
