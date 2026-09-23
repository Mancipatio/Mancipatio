// Serbian Securities Commission approval as shown to the public (whitepaper
// board and asset page). A whitepaper counts as approved only when the platform recorded
// the decision evidence: status "ssc_approved" AND a decision reference
// (migration 0026). Everything else is labeled as not approved — never just
// "Published", which reads like an endorsement.

import type { AssetProfile } from "@/lib/asset-profiles";

/** Named in full, like the approved badge ("Approved by the Serbian Securities
 *  Commission"), so it cannot be read as another country's regulator. */
export const SSC_NOT_APPROVED_LABEL = "Not approved by the Serbian Securities Commission";

/** The recorded Securities Commission decision reference, or null when the
 *  whitepaper is not approved (no decision evidence). */
export function sscDecisionRef(
  profile: Pick<AssetProfile, "whitepaper_status" | "ssc_decision_ref">,
): string | null {
  if (profile.whitepaper_status !== "ssc_approved") return null;
  return profile.ssc_decision_ref?.trim() || null;
}
