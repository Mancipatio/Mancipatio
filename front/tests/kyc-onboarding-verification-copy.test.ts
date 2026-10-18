// What /verify says a verification covers must match the chain: identity
// verification belongs to the account, the investor passport is issued per
// wallet (to the one the verification is linked to), and a conversion checks
// the wallet that deposits (realize_custody_vault reads the beneficiary's own
// KycEntry). The signed-out card used to promise that one verification would
// "cover every wallet you add later".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@solana/react-hooks", () => ({ useWalletConnection: () => ({ isReady: true, wallet: null }) }));
vi.mock("@/lib/account-login", () => ({
  accountFetch: vi.fn(), useSignedInAccount: () => ({ status: "signed_out", account: null }),
}));
vi.mock("@/components/wallet-required", () => ({ WalletRequired: () => null }));

import { VerificationForm } from "@/components/verification-form";

afterEach(() => vi.unstubAllEnvs());

describe("the signed-out verification card", () => {
  it.each(["on", "off"])("KYC-only mode %s: the passport is per wallet, the verification stays with the account", (mode) => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_KYC_ONLY", mode);
    const html = renderToStaticMarkup(createElement(VerificationForm));
    expect(html).toContain("Use your email or Google — no wallet needed.");
    expect(html).toContain("Your verification stays with your account");
    expect(html).toContain("the investor passport is issued per wallet, to a wallet you link");
    expect(html).toContain("a conversion checks the wallet that deposits");
    expect(html).not.toContain("cover every wallet you add later");
    expect(html).not.toMatch(/open later|Open now/);
  });

  it("the source carries no promise of account-wide coverage", () => {
    const source = readFileSync(join(process.cwd(), "components/verification-form.tsx"), "utf8");
    expect(source).not.toMatch(/cover every wallet|covers every wallet/);
  });
});
