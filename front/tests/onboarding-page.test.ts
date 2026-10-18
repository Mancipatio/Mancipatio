// The onboarding page's step gates (lib/clients.ts onboardingGates) and the
// page wiring that uses them: a dossier owned by a wallet-less (email/Google)
// account accepts the Terms and uploads its documents without a wallet, with
// the wallet link offered as optional; a wallet dossier keeps the connect →
// Terms → link → upload path. No jsdom here: the gates are pure, and the
// wiring is pinned by source, the repo's way of testing page wiring (see
// tests/role-surfaces.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { onboardingGates, type OnboardingGateInput } from "@/lib/clients";

const base: OnboardingGateInput = {
  accountOwned: false, walletConnected: false, alreadyConnected: false, linked: false, sameWallet: false, tosAccepted: false,
};
const gates = (overrides: Partial<OnboardingGateInput>) => onboardingGates({ ...base, ...overrides });

describe("onboardingGates — a dossier owned by a wallet-less account", () => {
  it("no wallet: the Terms first, with their own Accept button, then the documents; no connect step", () => {
    expect(gates({ accountOwned: true })).toEqual({
      showConnect: false, showTerms: true, showTermsAccept: true, showLink: false, linkOptional: true,
      showWrongWallet: false, showNext: false, uploadsOpen: false,
    });
    expect(gates({ accountOwned: true, tosAccepted: true })).toMatchObject({
      showConnect: false, showTerms: true, showTermsAccept: false, showLink: false, uploadsOpen: true, showNext: true,
    });
  });

  it("a wallet connected: linking is offered as optional, and nothing waits for it", () => {
    expect(gates({ accountOwned: true, walletConnected: true, tosAccepted: true })).toMatchObject({
      showLink: true, linkOptional: true, showWrongWallet: false, uploadsOpen: true, showNext: true,
    });
    expect(gates({ accountOwned: true, walletConnected: true, linked: true, tosAccepted: true }).showLink).toBe(false);
    // The Terms come first even with a wallet connected.
    expect(gates({ accountOwned: true, walletConnected: true })).toMatchObject({ uploadsOpen: false, showNext: false, showTermsAccept: true });
  });
});

describe("onboardingGates — the wallet path, unchanged", () => {
  it("an invitation without an account needs connect, the Terms and the link before any upload", () => {
    expect(gates({})).toEqual({
      showConnect: true, showTerms: false, showTermsAccept: false, showLink: false, linkOptional: false,
      showWrongWallet: false, showNext: false, uploadsOpen: false,
    });
    expect(gates({ walletConnected: true })).toMatchObject({
      showConnect: false, showTerms: true, showTermsAccept: false, showLink: true, uploadsOpen: false, showNext: false,
    });
    // Terms accepted, not linked yet: the link step is still the gate.
    expect(gates({ walletConnected: true, tosAccepted: true })).toMatchObject({ showLink: true, uploadsOpen: false, showNext: false });
    expect(gates({ walletConnected: true, linked: true, sameWallet: true, tosAccepted: true })).toMatchObject({
      showLink: false, uploadsOpen: true, showNext: true,
    });
  });

  it("a dossier that already carries a wallet (also a legacy one with an account) stays on the wallet path", () => {
    // onboarding-view answers account_owned false as soon as the dossier has a wallet (isAccountOwnedDossier).
    expect(gates({ walletConnected: true, alreadyConnected: true, sameWallet: true })).toMatchObject({
      showConnect: false, showTermsAccept: true, showLink: false, showWrongWallet: false, uploadsOpen: true, showNext: true, linkOptional: false,
    });
    expect(gates({ walletConnected: true, alreadyConnected: true, sameWallet: false })).toMatchObject({
      showWrongWallet: true, showNext: false, showTermsAccept: false, showLink: false,
    });
    expect(gates({ alreadyConnected: true })).toMatchObject({ showConnect: true, showTerms: false, uploadsOpen: false });
  });
});

describe("the page wiring", () => {
  const page = readFileSync(join(process.cwd(), "app/onboarding/[id]/page.tsx"), "utf8");

  it("every step reads from onboardingGates; the wallet-only upload gate is gone", () => {
    expect(page).toContain("const gates = onboardingGates({");
    expect(page).toContain("const canUpload = needsUpload && gates.uploadsOpen;");
    expect(page).not.toContain("needsUpload && !!wallet && (alreadyConnected || linked)");
    for (const gate of ["showConnect", "showTerms", "showTermsAccept", "showLink", "showWrongWallet"]) {
      expect(page, gate).toContain(`{gates.${gate} && (`);
    }
    expect(page).toContain("{gates.showNext && next && (");
    expect(page).toContain("if (!file || !client || !gates.uploadsOpen) return;");
  });

  it("an account-owned dossier accepts the Terms and uploads without a wallet, and the copy says so", () => {
    expect(page).toContain("if (!client || (!client.account_owned && !wallet)) return;");
    expect(page).toContain('client.account_owned ? "" : (wallet?.toString() ?? "")');
    expect(page).toContain("Accept the Terms and upload the requested documents — no wallet needed.");
    expect(page).toContain("Accept the Terms of Service and Privacy Policy above to upload this document.");
    expect(page).toContain("Optional: connect a wallet to link it now, or add wallets later in");
    expect(page).toContain("Link this wallet to your Manci account (optional)");
    // A refused optional link explains itself in place, with a way to sign in.
    expect(page).toContain("{linkError && (");
    expect(page).toContain('href="/login"');
    // An account-owned issuer did not link a wallet here, so its next step must not say so.
    expect(page).toContain("NEXT_STEP_ACCOUNT_BODY[client.type]");
    expect(page).not.toMatch(/accountOwned[^\n]*"The wallet you just linked/);
  });

  it("the file picker offers only what the server accepts and refuses a bad file before the upload", () => {
    expect(page).toContain("accept={KYC_UPLOAD_ACCEPT}");
    expect(page).not.toContain('accept="image/*,.pdf,.doc,.docx"');
    expect(page).toContain("const problem = f ? kycUploadProblem(f) : null;");
    expect(page).toContain("PDF, PNG, JPG or DOCX, up to 4 MB.");
    // The failure toast shows the server's reason (lib/clients.ts always sets `error`).
    expect(page).toContain('toast.showError("Upload failed", error ??');
  });
});
