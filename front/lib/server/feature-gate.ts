// SERVER-ONLY — the API half of lib/features.ts. The UI hides a feature that
// is off on this network; the routes behind it call requireFeature() so a
// hand-crafted signed request cannot reach it either. Pilot-scope modules
// (lib/features.ts pilotModules) work the same way through requireModule(),
// and the core areas KYC-only mode pauses (primary sales, issuance) through
// requireArea().

import "server-only";

import {
  featureDisabledMessage,
  features,
  moduleDisabledMessage,
  moduleEnabled,
  scopeDisabledMessage,
  scopeEnabled,
  type FeatureName,
  type PilotModule,
  type ScopeArea,
} from "@/lib/features";
import { RaiseType } from "@/lib/generated/asset_registry";
import { SiwsError } from "@/lib/server/siws";

/** Throws a 403 SiwsError when `name` is disabled on the current network. */
export function requireFeature(name: FeatureName): void {
  if (!features()[name]) {
    throw new SiwsError(403, featureDisabledMessage(name));
  }
}

/**
 * Throws a 403 SiwsError when the pilot-scope module is switched off. Called
 * by the module's ENTRY routes only (new requests, listings, deals, plans);
 * exits of existing positions stay open.
 */
export function requireModule(name: PilotModule): void {
  if (!moduleEnabled(name)) {
    throw new SiwsError(403, moduleDisabledMessage(name));
  }
}

/**
 * Throws a 403 SiwsError while a core area (primary sales, issuance) is
 * paused: KYC-only mode (lib/features.ts kycOnly). Called first by the
 * area's ENTRY routes, like requireModule; a route an admin also uses calls
 * it on its non-admin branch only. Exits stay open.
 */
export function requireArea(name: ScopeArea): void {
  if (!scopeEnabled(name)) throw new SiwsError(403, scopeDisabledMessage(name));
}

/**
 * An on-chain Startup sale belongs to the `startupRaises` feature, whoever
 * opened it: open_sale accepts raise_type=Startup from any KYB-verified issuer
 * authority (the issuer UI hiding it is not a control), and a sale opened while
 * the flag was on outlives the flag. Routes that act on a sale on the
 * platform's side (soft commitments, listing publication) call this with the
 * sale's on-chain raise type. Mature sales are unaffected.
 */
export function requireRaiseTypeEnabled(raiseType: RaiseType): void {
  if (raiseType === RaiseType.Startup) requireFeature("startupRaises");
}
