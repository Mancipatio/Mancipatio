import type { AccountVerification, AccountWalletKycStatus } from "@/lib/account";

export const ISSUER_WORKFLOW_TABS = [
  ["/issuer", "Process"],
  ["/issuer/verification", "1. KYC / KYB"],
  ["/issuer/status", "2. Review status"],
  ["/issuer/request", "3. Token request"],
  ["/issuer/launchpad", "4. Primary sales"],
  ["/issuer/assets", "My assets"],
] as const;

export const ISSUER_VERIFICATION_LABEL: Record<AccountWalletKycStatus, string> = {
  none: "Not started", pending: "Under review", more_info: "Documents needed",
  verified: "Approved", expired: "Expired", rejected: "Not approved", suspended: "Suspended",
};

/** Presentation only. Transaction and application endpoints retain their own gates. */
export function issuerWorkflowState(verification: AccountVerification | null, issuerKyb: number | null) {
  const statuses = verification ? [verification.kyc, verification.kyb] : [];
  const blocked = statuses.includes("suspended") || issuerKyb === 3;
  const approved = !blocked && statuses.includes("verified");
  const needsDocuments = !blocked && (statuses.includes("more_info") || (verification?.documents_requested ?? 0) > 0);
  const pending = !blocked && statuses.includes("pending");
  const submitted = statuses.some((status) => status !== "none");
  // A connected wallet or approved individual KYC is never an approved issuer.
  const canManageIssuer = !blocked && issuerKyb === 1 && verification?.kyb === "verified";
  return { approved, blocked, needsDocuments, pending, submitted, canManageIssuer };
}
