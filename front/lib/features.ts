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
// The mainnet scope is narrow: primary sales (Mature, USDC) and nothing else
// (Terms clause 2, lib/legal/mainnet-copy.ts). Every other module is a switch
// here, OFF on mainnet
// unless its NEXT_PUBLIC_FEATURE_* variable reads as on, and ON elsewhere
// unless it reads as off (so devnet can rehearse the pilot scope). Same
// spellings and build guard as the flags above (next.config.ts
// FEATURE_FLAG_NAMES). Payout airdrops and Startup raises keep their own
// flags (features()). Primary sales have no switch: they are the pilot.
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

/**
 * The switches as set. What is in force is moduleEnabled() (KYC-only mode
 * overrides); every gate reads that.
 */
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
  // KYC-only mode (below) turns every module off, whatever its own switch says.
  return !kycOnly(network) && pilotModules(network)[name];
}

/** User-facing sentence for a module that is switched off. */
export function moduleDisabledMessage(name: PilotModule, network: Network = detectNetwork()): string {
  if (kycOnly(network)) return KYC_ONLY_MESSAGE;
  return network === "mainnet"
    ? `${PILOT_MODULE_LABELS[name]}: not available on Solana mainnet.`
    : `${PILOT_MODULE_LABELS[name]}: switched off on Solana ${network}.`;
}

// ── KYC-only mode: the one switch over everything but sign-up and KYC ─────
//
// Owner decision 2026-10-10: while it is on, the public can sign in (wallet,
// email, Google), manage the account, accept the Terms and submit a
// verification (KYC) request; everything else is paused. On mainnet it is ON
// unless NEXT_PUBLIC_FEATURE_KYC_ONLY reads as off (fail closed: an unset
// value keeps the platform locked, and a production build refuses a
// misspelling: next.config.ts FEATURE_FLAG_NAMES); on devnet, testnet and
// localnet it is OFF unless the variable reads as on (a rehearsal).
//
// While on:
//   - every pilot module is off (moduleEnabled), whatever its own switch
//     says; pilotModules() still reports the switches themselves (the build
//     guards read those, never the runtime scope);
//   - the two core areas without a switch of their own, primary sales and
//     issuance, are off (scopeEnabled): their pages carry the notice or are
//     replaced by it (lib/pilot-scope.ts KYC_ONLY_ROUTES), their entry routes
//     answer 403 (lib/server/feature-gate.ts requireArea), and their on-chain
//     entries are refused before the wallet opens (lib/pause-gate.ts
//     KYC_ONLY_FLOWS);
//   - the verification request is KYC (a person) only: a new KYB request (a
//     company that wants to raise or issue) is an issuance entry, refused by
//     /api/verification/submit and not offered on /verify; a KYB dossier
//     that exists stays visible and its documents can still be uploaded
//     (components/account-verification.tsx kybShown);
//   - exits of existing positions, the verification request, the portfolio
//     overview and the admin console keep working.
// Every notice of the mode, a module page's included, is labelled "Paused."
// (components/pilot-module-notice.tsx), and every notice, 403 and wallet
// refusal says the one sentence below. Neither says which services the
// Terms offer, so both hold under whichever Terms are in force: a version
// that offers more (trading, conversion) makes nothing here false.
// Off, nothing here changes anything. The program's pause flags stay the
// on-chain authority (the lockdown needs 0x7F: issuer onboarding 0x01 is
// stopped on-chain only by its bit; ops/env-vars.md); this is the
// platform's scope.

export const KYC_ONLY_ENV = "NEXT_PUBLIC_FEATURE_KYC_ONLY";

export const KYC_ONLY_MESSAGE =
  "Manci is open for sign-up and identity verification only. Sales, trading, issuance and the other services are paused for now.";

export function kycOnly(network: Network = detectNetwork()): boolean {
  // Literal process.env.NEXT_PUBLIC_* read so Next inlines it client-side.
  const value = parseFeatureFlag(process.env.NEXT_PUBLIC_FEATURE_KYC_ONLY);
  return network === "mainnet" ? value !== false : value === true;
}

/** Core areas without a module switch of their own: only KYC-only mode turns them off. */
export type ScopeArea = "primarySales" | "issuance";
export const SCOPE_AREAS: readonly ScopeArea[] = ["primarySales", "issuance"];
export type ScopeName = PilotModule | ScopeArea;
export const SCOPE_LABELS: Record<ScopeName, string> = {
  ...PILOT_MODULE_LABELS,
  primarySales: "Primary sales",
  issuance: "Issuance (issuer onboarding, assets, share classes and sale requests)",
};
function isScopeArea(name: ScopeName): name is ScopeArea {
  return (SCOPE_AREAS as readonly string[]).includes(name);
}
/** A module (its switch, under KYC-only mode) or a core area (KYC-only mode alone). */
export function scopeEnabled(name: ScopeName, network: Network = detectNetwork()): boolean {
  return isScopeArea(name) ? !kycOnly(network) : moduleEnabled(name, network);
}
export function scopeDisabledMessage(name: ScopeName, network: Network = detectNetwork()): string {
  return isScopeArea(name) ? KYC_ONLY_MESSAGE : moduleDisabledMessage(name, network);
}
