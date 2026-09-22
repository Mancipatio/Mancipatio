"use client";

import Link from "next/link";
import type { AccountVerification, AccountWalletKycStatus } from "@/lib/account";
import { IconArrowUpRight, IconBuilding, IconCheck, IconShield, IconUsers } from "@/components/icons";

export const VERIFICATION_LABEL: Record<AccountWalletKycStatus, string> = {
  none: "Not started", pending: "In review", more_info: "Documents needed", verified: "Verified",
  expired: "Expired", suspended: "Suspended", rejected: "Rejected",
};

function Row({ kind, status, documents }: { kind: "kyc" | "kyb"; status: AccountWalletKycStatus; documents: number }) {
  const company = kind === "kyb";
  const action = status === "none" || status === "expired" ? (company ? "Verify your company" : "Verify your identity")
    : status === "pending" || status === "more_info" ? (documents > 0 ? "Continue verification" : "View progress") : null;
  return <div className="verification-row">
    <span className="account-feature-icon">{company ? <IconBuilding size={19} /> : <IconUsers size={19} />}</span>
    <div className="verification-row-text">
      <strong>{company ? "Company verification (KYB)" : "Identity verification (KYC)"}</strong>
      <p>{status === "verified" ? (company ? "Your company is verified for issuing and raising on Manci." : "You can invest in verified offerings and receive deliveries.")
        : status === "none" ? (company ? "Needed to create a raise or issue assets as a company." : "Needed to invest, trade gated assets and receive deliveries.")
        : status === "more_info" ? `We need ${documents || "some"} document${documents === 1 ? "" : "s"} before we can review.`
        : status === "pending" ? "Our compliance team is reviewing your submission."
        : status === "expired" ? "Your verification has expired. Renew it to keep access."
        : "Contact the compliance team about your verification."}</p>
    </div>
    <span className={`account-status ${status === "verified" ? "account-status--verified" : ""}`}>{status === "verified" && <IconCheck size={12} />}{VERIFICATION_LABEL[status]}</span>
    {action && <Link href={`/verify?type=${kind}`} className={`account-button ${status === "none" || status === "expired" ? "account-button--primary" : "account-button--secondary"}`}>{action}<IconArrowUpRight size={15} /></Link>}
  </div>;
}

export function AccountVerificationCard({ verification }: { verification: AccountVerification | null | undefined }) {
  return <section className="account-card" aria-labelledby="account-verification-heading">
    <div className="account-card-heading"><div><p className="account-eyebrow">TRUST &amp; COMPLIANCE</p><h2 id="account-verification-heading">Verification</h2></div><IconShield size={21} /></div>
    {!verification ? <p className="account-card-description">Verification status is temporarily unavailable. Refresh the page to try again.</p> : <>
      <p className="account-card-description">Verification is optional for browsing. It is required to invest, raise capital or issue assets. It applies to the wallet you are connected with.</p>
      <div className="verification-rows">
        <Row kind="kyc" status={verification.kyc} documents={verification.documents_requested} />
        <Row kind="kyb" status={verification.kyb} documents={verification.documents_requested} />
      </div>
    </>}
  </section>;
}
