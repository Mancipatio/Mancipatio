// What the site says about the security review of the on-chain programs.
//
// /risks and /about used to say both programs "went through a systematic
// security review before they were deployed". The reviews so far are internal
// (engineering and AI-assisted reviews, LiteSVM tests); no independent
// auditor has reviewed the programs, and the sentence could be read as if one
// had. Until an external audit of the deployed release is complete, the pages
// say exactly that; afterwards they name the auditor, the scope and the
// report — set SECURITY_AUDIT below, one edit, no page changes.
//
// Directive-free and import-free.

export type SecurityAudit = {
  /** The audit firm, e.g. "OtterSec". */
  firm: string;
  /** What was audited, e.g. "asset_registry and transfer_hook at release v1.0.0". */
  scope: string;
  /** Date the final report was delivered, yyyy-mm-dd. */
  completedOn: string;
  /** Public URL of the report. */
  reportUrl: string;
};

/** null until an independent external audit of the deployed release is complete. */
export const SECURITY_AUDIT: SecurityAudit | null = null;

/** The /risks paragraph on program security (after "Software can contain defects."). */
export function securityReviewStatement(audit: SecurityAudit | null = SECURITY_AUDIT): string {
  if (!audit) {
    return (
      "Both on-chain programs have been through internal security reviews and automated testing. " +
      "No independent external audit has been completed yet. Reviews reduce the risk of a " +
      "contract-level failure; they do not remove it."
    );
  }
  return (
    `The on-chain programs were audited by ${audit.firm} (${audit.scope}); the report was ` +
    `delivered on ${audit.completedOn}. An audit reduces the risk of a contract-level failure; ` +
    "it does not remove it."
  );
}

/** The short line for the /about "Where things stand" band. */
export function securityReviewFact(audit: SecurityAudit | null = SECURITY_AUDIT): string {
  return audit
    ? `Externally audited by ${audit.firm} (${audit.completedOn})`
    : "Internal security reviews only; no external audit completed yet";
}
