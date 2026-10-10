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

// ── Pilot scope: one switch per product module (lansiranje-6) ─────────────
//
// The mainnet scope is what Terms clause 2 offers (lib/legal/mainnet-copy.ts):
// primary sales (Mature, USDC) and, from version 2026-10-10, trading through
// Manci (secondaryTrading) and conversion into company shares
// (custodyConversion); the other modules are not offered. Every module is a
// switch here, OFF on mainnet
// unless its NEXT_PUBLIC_FEATURE_* variable reads as on, and ON elsewhere
// unless it reads as off (so devnet can rehearse the pilot scope). Same
// spellings and build guard as the flags above (next.config.ts
// FEATURE_FLAG_NAMES). Payout airdrops and Startup raises keep their own
// flags (features()). Primary sales have no switch: they are the pilot.
//
// On mainnet a module switched on must be one the Terms offer: a mainnet
// build refuses a module flag that is on (these switches, and the payout
// airdrop and Startup raise flags) while its module is not in
// MAINNET_TERMS.offeredModules (lib/legal/mainnet-copy.ts; next.config.ts
// assertBuildMainnetModules). One-way: an offered module may be switched off.
//
// Off means: the module's ENTRY routes answer 403 with moduleDisabledMessage
// (lib/server/feature-gate.ts requireModule), the navigation hides the
// module, and its pages say it is not available on mainnet. Exits of
// positions that already exist (cancels, withdrawals, claims, refunds) stay
// open, like the program's emergency pause. The program is the authority
// for what can happen on-chain; these switches are the platform's scope.

export type PilotModules = {
  /** OTC escrow deals, the resell board and on-chain OTC offers. */
  secondaryTrading: boolean;
  /** Proposals and votes (/marketplace/governance, /portfolio/governance). */
  governance: boolean;
  /** Issuer vesting series (/issuer/vesting-series, /admin/vesting). */
  vesting: boolean;
  /** Rights-Token issuances, their milestone builder (/admin/rights) and vesting schedules (/issuer/vesting). */
  rights: boolean;
  /**
   * Distributions to holders: distribution plans (push distributions on
   * /admin/payouts), payout schedules and yield routing (route_yield). The
   * Startup payout vault itself (vault votes, snapshots, tranche releases)
   * belongs to `startupRaises` (features()).
   */
  distributions: boolean;
  /** Converting units into company equity (custody entry). */
  custodyConversion: boolean;
  /** Physical delivery of goods (custody entry). */
  custodyDelivery: boolean;
};

export type PilotModule = keyof PilotModules;

export const PILOT_MODULES: readonly PilotModule[] = [
  "secondaryTrading", "governance", "vesting", "rights", "distributions", "custodyConversion", "custodyDelivery",
];

export const PILOT_MODULE_LABELS: Record<PilotModule, string> = {
  secondaryTrading: "Secondary trading (OTC deals, offers and the resell board)",
  governance: "Governance",
  vesting: "Vesting series",
  rights: "Rights-Token issuances",
  distributions: "Distributions to holders",
  custodyConversion: "Conversion into company shares",
  custodyDelivery: "Physical delivery",
};

/** The variable behind each module switch (ops/env-vars.md "Pilot scope"). */
export const PILOT_MODULE_ENV: Record<PilotModule, string> = {
  secondaryTrading: "NEXT_PUBLIC_FEATURE_SECONDARY_TRADING",
  governance: "NEXT_PUBLIC_FEATURE_GOVERNANCE",
  vesting: "NEXT_PUBLIC_FEATURE_VESTING",
  rights: "NEXT_PUBLIC_FEATURE_RIGHTS",
  distributions: "NEXT_PUBLIC_FEATURE_DISTRIBUTIONS",
  custodyConversion: "NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION",
  custodyDelivery: "NEXT_PUBLIC_FEATURE_CUSTODY_DELIVERY",
};

export function pilotModules(network: Network = detectNetwork()): PilotModules {
  // Literal process.env.NEXT_PUBLIC_* reads so Next inlines them client-side.
  const raw: Record<PilotModule, string | undefined> = {
    secondaryTrading: process.env.NEXT_PUBLIC_FEATURE_SECONDARY_TRADING,
    governance: process.env.NEXT_PUBLIC_FEATURE_GOVERNANCE,
    vesting: process.env.NEXT_PUBLIC_FEATURE_VESTING,
    rights: process.env.NEXT_PUBLIC_FEATURE_RIGHTS,
    distributions: process.env.NEXT_PUBLIC_FEATURE_DISTRIBUTIONS,
    custodyConversion: process.env.NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION,
    custodyDelivery: process.env.NEXT_PUBLIC_FEATURE_CUSTODY_DELIVERY,
  };
  const on = (value: string | undefined) => (network === "mainnet" ? mainnetOptIn(value) : !killSwitchOff(value));
  return Object.fromEntries(PILOT_MODULES.map((name) => [name, on(raw[name])])) as PilotModules;
}

export function moduleEnabled(name: PilotModule, network: Network = detectNetwork()): boolean {
  return pilotModules(network)[name];
}

/** User-facing sentence for a module that is switched off. */
export function moduleDisabledMessage(name: PilotModule, network: Network = detectNetwork()): string {
  return network === "mainnet"
    ? `${PILOT_MODULE_LABELS[name]}: not available on Solana mainnet.`
    : `${PILOT_MODULE_LABELS[name]}: switched off on Solana ${network}.`;
}
