// Regression guards for the page-level wiring behind e2e §5 (KYC provider vs
// platform admin) and §6 (asset identity in links/keys). The pages are React
// client components (no jsdom harness here), so the guards read their source
// and pin the invariants the reviewers flagged:
//   - passport surfaces target the LIVE registry (never one derived from the
//     connected wallet or Platform.admin) and gate issue/revoke on
//     isKycProvider, not isSuperAdmin;
//   - useRole() does not pay a getProgramAccounts scan per mount;
//   - marketing links and admin list keys use the asset PDA.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("admin client detail — on-chain passport surface (§5)", () => {
  const page = src("app/admin/clients/[id]/page.tsx");

  it("resolves the registry from the live KycRegistry, not the wallet or Platform.admin", () => {
    expect(page).toContain("loadKycAuthorityContext(");
    expect(page).toMatch(/passportAuthorityFor\(wallet, kycCtx\)/);
    expect(page).not.toMatch(/getRegistryPda\(/);
    expect(page).not.toMatch(/platform\.data\.admin/);
  });

  it("signs approve/revoke with the registry's own authority", () => {
    expect(page).not.toMatch(/registryAuthority:\s*wallet/);
    expect(page.match(/^\s*registryAuthority,\s*$/gm)).toHaveLength(2);
  });

  it("gates issue/revoke on isKycProvider instead of the Super Admin role", () => {
    expect(page).not.toContain("isSuperAdmin");
    expect(page).not.toContain("useRole");
    expect(page).toContain("if (!isKycProvider || !registryAuthority)");
    expect(page).toContain("client.wallet && isKycProvider && (");
  });
});

describe("admin share classes — KycGated hook registry (§5)", () => {
  const page = src("app/admin/share-classes/page.tsx");

  it("pins the hook to the live registry address", () => {
    expect(page).toContain("kycRegistry = ctx.registry.address");
    expect(page).not.toMatch(/getRegistryPda\(/);
    expect(page).not.toContain("fetchMaybeKycRegistry");
  });
});

describe("useRole stays cheap", () => {
  const auth = src("lib/auth.ts");

  it("does not scan KycRegistry accounts on every role compute", () => {
    expect(auth).not.toMatch(/from "@\/lib\/kyc-authority"/);
    expect(auth).not.toContain("loadKycAuthorityContext(");
    expect(auth).not.toContain("isKycProvider:");
  });
});

describe("KYC bootstrap and rotation copy", () => {
  it("re-reads with fresh scans after create_kyc_registry", () => {
    const page = src("app/admin/kyc/page.tsx");
    expect(page).toContain("waitForKycRegistry(client.runtime.rpc)");
    expect(page).toContain("invalidateKycAuthorityContext(client.runtime.rpc)");
  });

  it("tells the operator the provider must be re-added via add_admin after rotation", () => {
    expect(src("app/admin/kyc/page.tsx")).toMatch(/add_admin/);
    expect(src("app/admin/platform/page.tsx")).toMatch(/add_admin/);
  });
});

describe("asset identity in links and keys (§6)", () => {
  it("marketing boards link by asset PDA", () => {
    const offers = src("app/(marketing)/markets/[slug]/category-offers.tsx");
    const docs = src("app/(marketing)/markets/whitepapers/whitepapers-board.tsx");
    expect(offers).toContain("assetHref(profile.asset_pda)");
    expect(docs).toContain("marketplaceAssetHref(profile.asset_pda)");
    expect(offers).not.toMatch(/\/marketplace\/assets\/\$\{/);
    expect(docs).not.toMatch(/\/marketplace\/assets\/\$\{/);
  });

  it("admin asset rows are keyed by PDA (two issuers may share an assetId)", () => {
    const page = src("app/admin/assets/page.tsx");
    expect(page).toContain("key={assetPda ?? `${asset.issuer}:${asset.assetId}`}");
    expect(page).not.toContain("key={asset.assetId}");
  });
});
