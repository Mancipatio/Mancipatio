import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountVerification } from "@/lib/account";
import { issuerWorkflowState } from "@/lib/issuer-workflow";
import { IssuerReviewDetails, IssuerWorkflow, type WorkflowData } from "@/app/issuer/issuer-workflow";

function verification(overrides: Partial<AccountVerification> = {}): AccountVerification {
  return { kyc: "none", kyb: "none", documents_requested: 0, ...overrides };
}
function workflow(overrides: Partial<WorkflowData> = {}): WorkflowData {
  return {
    data: null, me: undefined, refresh: async () => {}, failed: false,
    verification: null, verificationLoading: false, verificationError: null,
    needsSignature: false, refreshVerification: () => {}, signedIn: false,
    authLoading: false, accountMode: false, walletMatchesAccount: true,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("issuer workflow decisions", () => {
  it("never treats wallet connection or missing private data as verification", () => {
    expect(issuerWorkflowState(null, null)).toMatchObject({ approved: false, submitted: false, canManageIssuer: false });
    expect(issuerWorkflowState(null, 1)).toMatchObject({ approved: false, canManageIssuer: false });
    expect(issuerWorkflowState(verification(), 1).canManageIssuer).toBe(false);
  });
  it("distinguishes an approved individual application from company issuer approval", () => {
    expect(issuerWorkflowState(verification({ kyc: "verified" }), 1)).toMatchObject({ approved: true, canManageIssuer: false });
    expect(issuerWorkflowState(verification({ kyb: "verified" }), null)).toMatchObject({ approved: true, canManageIssuer: false });
    expect(issuerWorkflowState(verification({ kyb: "verified" }), 0).canManageIssuer).toBe(false);
    expect(issuerWorkflowState(verification({ kyb: "verified" }), 1).canManageIssuer).toBe(true);
  });
  it("keeps corrections actionable even after a separate verification was approved", () => {
    expect(issuerWorkflowState(verification({ kyc: "verified", kyb: "more_info", documents_requested: 2 }), null))
      .toMatchObject({ approved: true, needsDocuments: true, canManageIssuer: false });
  });
  it("does not advance a suspended issuer or account", () => {
    expect(issuerWorkflowState(verification({ kyc: "suspended", kyb: "verified" }), 1))
      .toMatchObject({ blocked: true, approved: false, canManageIssuer: false });
    expect(issuerWorkflowState(verification({ kyb: "verified" }), 3))
      .toMatchObject({ blocked: true, approved: false, canManageIssuer: false });
  });
});

describe("issuer journey rendering", () => {
  it("shows the process and a working verification entry without a wallet", () => {
    const html = renderToStaticMarkup(createElement(IssuerWorkflow, { workflow: workflow() }));
    for (const text of ["KYC / KYB", "Review &amp; approval", "Token issuance request", "Primary sale", "email, Google or your wallet"])
      expect(html).toContain(text);
    expect(html).toContain('href="/issuer/verification"');
    expect(html).toContain('href="/issuer/request"');
    expect(html).not.toContain("Other asset types");
  });
  it("shows email/Google verification and document requests without an issuer wallet", () => {
    const html = renderToStaticMarkup(createElement(IssuerReviewDetails, { workflow: workflow({
      signedIn: true, accountMode: true, walletMatchesAccount: false,
      verification: verification({ kyb: "more_info", documents_requested: 2 }),
    }) }));
    expect(html).toContain("2 requested documents");
    expect(html).toContain("Supply documents / corrections");
    expect(html).toContain("connect a wallet linked to this account");
    expect(html).not.toContain("Verification approved");
  });
  it("makes an unavailable read explicit instead of presenting an empty or approved dossier", () => {
    const html = renderToStaticMarkup(createElement(IssuerReviewDetails, { workflow: workflow({
      signedIn: true, verificationError: "Could not load your verification status. Please try again.",
    }) }));
    expect(html).toContain("Verification status unavailable");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Identity verification (KYC)");
    expect(html).not.toContain("Verification approved");
  });
  it("keeps trading and holder conversion conditional on their real scope", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_SECONDARY_TRADING", "false");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION", "false");
    const hidden = renderToStaticMarkup(createElement(IssuerWorkflow, { workflow: workflow() }));
    expect(hidden).not.toContain('href="/portfolio/conversion"');
    expect(hidden).not.toContain('href="/marketplace/otc"');
    vi.stubEnv("NEXT_PUBLIC_FEATURE_SECONDARY_TRADING", "true");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION", "true");
    const visible = renderToStaticMarkup(createElement(IssuerWorkflow, { workflow: workflow() }));
    expect(visible).toContain('href="/portfolio/conversion"');
    expect(visible).toContain('href="/marketplace/otc"');
    expect(visible).toContain('href="/markets/resell"');
    expect(visible).toContain("token balance, verification");
  });
});
