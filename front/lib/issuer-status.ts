import { KybStatus } from "@/lib/generated/asset_registry/types/kybStatus";

/** Unknown and unsuccessful KYB states must never unlock issuer actions. */
export function issuerStatus(status: number | null | undefined) {
  switch (status) {
    case KybStatus.Verified:
      return {
        label: "Verified",
        verified: true,
        title: "Ready to prepare your asset",
        description:
          "Your issuer is verified. Create an asset, define its share classes and prepare the sale documents before opening a sale.",
      };
    case KybStatus.Pending:
      return {
        label: "Pending",
        verified: false,
        title: "Company verification is pending",
        description:
          "Complete the company document checklist provided by the team. Registration alone does not submit a KYB dossier. Once the review is complete, refresh this status to see the decision.",
      };
    case KybStatus.Rejected:
      return {
        label: "Rejected",
        verified: false,
        title: "Company verification was rejected",
        description:
          "Contact the team with your legal entity ID to understand the decision and arrange a new review. Creating another registration does not resolve this decision.",
      };
    case KybStatus.Suspended:
      return {
        label: "Suspended",
        verified: false,
        title: "Issuer access is suspended",
        description:
          "Contact the team with your legal entity ID to resolve the suspension. Existing registration and company documents remain separate from the decision to restore issuer access.",
      };
    default:
      return {
        label: "Unknown",
        verified: false,
        title: "Company verification status is unavailable",
        description:
          "Refresh the status before continuing. If the status remains unavailable, contact the team with your legal entity ID.",
      };
  }
}
