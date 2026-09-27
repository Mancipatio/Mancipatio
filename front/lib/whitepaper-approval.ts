// Serbian Securities Commission approval as shown to the public (whitepaper
// board, asset page, launchpad list and sale page). A whitepaper counts as
// approved only when the platform recorded the decision evidence: status
// "ssc_approved" AND a decision reference (migration 0026). Everything else is
// labeled as not approved — never just "Published", which reads like an
// endorsement.
//
// On MAINNET the same evidence gates the offering itself (lansiranje-2):
// offeringClearance below is checked when an admin reserves a sale approval
// (/api/sale-approvals/reserve) and whenever the sale's document is served
// for a purchase or commitment (lib/server/sale-document.ts).

import type { AssetProfile } from "@/lib/asset-profiles";
import type { Network } from "@/lib/network";

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

export type OfferingClearanceProfile = Pick<AssetProfile, "whitepaper_status" | "ssc_decision_ref"> &
  Pick<AssetProfile, "offering_exemption_ref" | "offering_exemption_reason">;

export type OfferingClearance =
  | { cleared: true; basis: "ssc_approved" | "exemption"; ref: string }
  | { cleared: true; basis: "test_network" }
  | { cleared: false; reason: string };

export const OFFERING_NOT_CLEARED =
  "On mainnet a sale needs a whitepaper approved by the Serbian Securities Commission (with its decision " +
  "reference recorded) or an offering exemption recorded by the super admin with counsel's reference.";

/**
 * Whether a sale of the asset behind `profile` may be approved, opened for
 * purchases or take commitments on `network`. Mainnet: an SSC-approved
 * whitepaper with a decision reference, or a recorded exemption (counsel's
 * reference AND the reason, both set). Test networks: always (unchanged).
 */
export function offeringClearance(
  profile: OfferingClearanceProfile | null,
  network: Network,
): OfferingClearance {
  if (network !== "mainnet") return { cleared: true, basis: "test_network" };
  if (!profile) return { cleared: false, reason: OFFERING_NOT_CLEARED };
  const decision = sscDecisionRef(profile);
  if (decision) return { cleared: true, basis: "ssc_approved", ref: decision };
  const ref = profile.offering_exemption_ref?.trim();
  const reason = profile.offering_exemption_reason?.trim();
  if (ref && reason) return { cleared: true, basis: "exemption", ref };
  return { cleared: false, reason: OFFERING_NOT_CLEARED };
}
