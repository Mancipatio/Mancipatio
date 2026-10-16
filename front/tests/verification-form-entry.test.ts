import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ query: "type=kyb&next=/apply" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.query),
}));
vi.mock("@solana/react-hooks", () => ({ useWalletConnection: () => ({ isReady: true, wallet: null }) }));
vi.mock("@/lib/account-login", () => ({
  accountFetch: vi.fn(), useSignedInAccount: () => ({ status: "signed_out", account: null }),
}));
vi.mock("@/components/wallet-required", () => ({ WalletRequired: () => null }));

import { VerificationForm } from "@/components/verification-form";

afterEach(() => vi.unstubAllEnvs());
describe("verification entry", () => {
  it("preserves issuer KYB and the application destination across email/Google sign-in", () => {
    const html = renderToStaticMarkup(createElement(VerificationForm, { context: "issuer" }));
    expect(html).toContain(`href="/login?next=${encodeURIComponent("/issuer/verification?type=kyb&next=/apply")}"`);
    expect(html).toContain("After approval, continue with your token issuance request.");
  });
  it("hides unavailable physical delivery from the shared verification entry", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_CUSTODY_DELIVERY", "false");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION", "true");
    const html = renderToStaticMarkup(createElement(VerificationForm));
    expect(html).not.toContain("physical goods");
    expect(html).toContain("convert tokens into company shares");
  });
});
