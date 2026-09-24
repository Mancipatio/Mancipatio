// Talas 3.1 page wiring (no jsdom harness here, so the guards read the page
// sources, like tests/passport-surfaces): each operator role opens only its
// own pages, admin-only actions stay hidden for it, and every blocklist /
// hook-mode change re-checks the finalized blocklist authority before
// building.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("admin area gate (A)", () => {
  it("the layout gates by the path table, not by a fixed role", () => {
    const layout = src("app/admin/layout.tsx");
    expect(layout).toContain("<AdminGate>");
    expect(layout).not.toContain('<RequireRole role="admin">');
    expect(layout).toContain("adminRouteRequirement(item.href)");
    const gate = src("components/admin-gate.tsx");
    expect(gate).toContain("adminRouteRequirement(pathname)");
  });

  it("the overview falls back to the operator landing; no bootstrap bypass is left", () => {
    expect(src("app/admin/page.tsx")).toContain('fallback={<OperatorLanding />}');
    expect(src("components/require-role.tsx")).not.toContain("allowBootstrap");
  });
});

describe("KYC provider pages (B, K6)", () => {
  it("/admin/kyc: triage for admin|kycProvider, clawback admin-only", () => {
    const page = src("app/admin/kyc/page.tsx");
    expect(page).toContain('<RequireRole anyOf={["admin", "kycProvider"]}>');
    expect(page).toMatch(/<RequireRole role="admin" fallback=\{<><\/>\}>\s*<ClawbackPanel \/>/);
    // Send-time re-read of this wallet's blocklist entry and alert status.
    expect(page).toContain("fetchBlockEntry(client.runtime.rpc, req.wallet as Address)");
    expect(page).toContain("listWalletsWithOpenAlerts(conn.wallet, [req.wallet])");
    expect(page).not.toContain("listAlerts(");
    expect(page).not.toContain("listBlockEntries(");
  });

  it("client pages: admin|kycProvider, admin-only actions behind isAdmin", () => {
    const list = src("app/admin/clients/page.tsx");
    expect(list).toContain('<RequireRole anyOf={["admin", "kycProvider"]}>');
    expect(list).toContain("{showAdd && isAdmin && (");
    const detail = src("app/admin/clients/[id]/page.tsx");
    expect(detail).toContain('<RequireRole anyOf={["admin", "kycProvider"]}>');
    expect(detail).toContain("{!editing && isAdmin && (");
    expect(detail).toContain("const statusLocked = !isAdmin && TERMINAL_KYC_STATUSES.has(client.kyc_status);");
    expect(detail).toContain("fetchBlockEntry(solanaClient.runtime.rpc, client.wallet as Address)");
    expect(detail).toContain("hasOpenAlert: gateAlert,");
    expect(detail).not.toContain("listAlerts(");
    expect(src("components/client-privacy-panel.tsx")).toContain("{isAdmin && (");
  });

  it("the wrong 'chain enforces the blocklist on every transfer' rationale is gone", () => {
    for (const rel of ["app/admin/kyc/page.tsx", "app/admin/clients/[id]/page.tsx"]) {
      const page = src(rel);
      expect(page).not.toMatch(/chain still enforces (both|the registry bitmap and blocklist)/);
      expect(page).toMatch(/sender-only/);
    }
  });
});

describe("blocklist authority pages (C, K7/K8)", () => {
  it("/admin/blocklist: admin|blocklistAuthority; changes only for the authority, re-checked", () => {
    const page = src("app/admin/blocklist/page.tsx");
    expect(page).toContain('<RequireRole anyOf={["admin", "blocklistAuthority"]}>');
    expect(page).toContain("!isAuthority ||");
    expect(page).toContain("BA only");
    const send = page.slice(page.indexOf("async function send("));
    expect(send.indexOf("await assertBlocklistAuthority(client.runtime.rpc, signer);")).toBeGreaterThan(-1);
    expect(send.indexOf("await assertBlocklistAuthority(")).toBeLessThan(
      send.indexOf("getAddToBlocklistInstructionAsync("),
    );
  });

  it("/admin/share-classes: the hook mode follows the blocklist authority, not the Super Admin", () => {
    const page = src("app/admin/share-classes/page.tsx");
    expect(page).toContain('<RequireRole anyOf={["admin", "blocklistAuthority"]}>');
    expect(page).not.toContain("isSuperAdmin");
    expect(page).toContain("!isBlocklistAuthority ||");
    const update = page.slice(page.indexOf("async function updateHookMode("));
    expect(update.indexOf("await assertBlocklistAuthority(client.runtime.rpc, signer);")).toBeLessThan(
      update.indexOf("getUpdateTransferHookConfigInstructionAsync("),
    );
    // Re-point: pinned deployments only, holder warning, BA re-checked.
    const repoint = page.slice(page.indexOf("async function repointHookRegistry("));
    expect(repoint).toContain("await assertBlocklistAuthority(client.runtime.rpc, signer);");
    expect(repoint).toContain("const pin = configuredKycRegistry();");
    expect(page).toContain("stop passing the hook as soon as this lands.");
    expect(page).toContain("setPlatformRegistry(ctx.registry?.address === pin ? pin : null)");
    // Other share-class actions need an Admin.
    expect(page).toContain("{isAdmin && (<>");
  });

  it("the Admins page no longer says Admins operate the blocklist", () => {
    const page = src("app/admin/admins/page.tsx");
    expect(page).not.toMatch(/issuance, custody and the blocklist/);
    expect(page).toMatch(/blocklist authority/);
  });
});
