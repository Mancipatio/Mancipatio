// SERVER-ONLY — the API half of lib/features.ts. The UI hides a feature that
// is off on this network; the routes behind it call requireFeature() so a
// hand-crafted signed request cannot reach it either.

import "server-only";

import { featureDisabledMessage, features, type FeatureName } from "@/lib/features";
import { RaiseType } from "@/lib/generated/asset_registry";
import { SiwsError } from "@/lib/server/siws";

/** Throws a 403 SiwsError when `name` is disabled on the current network. */
export function requireFeature(name: FeatureName): void {
  if (!features()[name]) {
    throw new SiwsError(403, featureDisabledMessage(name));
  }
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
