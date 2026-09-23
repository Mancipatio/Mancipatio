// SERVER-ONLY — the API half of lib/features.ts. The UI hides a feature that
// is off on this network; the routes behind it call requireFeature() so a
// hand-crafted signed request cannot reach it either.

import "server-only";

import { featureDisabledMessage, features, type FeatureName } from "@/lib/features";
import { SiwsError } from "@/lib/server/siws";

/** Throws a 403 SiwsError when `name` is disabled on the current network. */
export function requireFeature(name: FeatureName): void {
  if (!features()[name]) {
    throw new SiwsError(403, featureDisabledMessage(name));
  }
}
