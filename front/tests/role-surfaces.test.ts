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

describe("/account/roles and the rotation surface (D, K8, K10)", () => {
  it("the page lives outside the admin gate and hands over the operational authorities", () => {
    const page = src("app/account/roles/page.tsx");
    expect(page).toContain('<AppShell section="account">');
    expect(page).not.toMatch(/RequireRole|AdminGate/);
    const roles = src("components/account-roles.tsx");
    expect(roles).toContain('{role.isSuperAdmin && <AuthorityRotation kind="platform" />}');
    expect(roles).toContain('{role.isBlocklistAuthority && <AuthorityRotation kind="blocklist" />}');
    expect(roles).toContain('href="/admin/kyc"');
    // The maintenance banner, and the panels are disabled meanwhile.
    expect(roles).toContain("inMaintenance &&");
    expect(roles).toContain("<PendingRolesPanel maintenance={inMaintenance} />");
  });

  it("every panel action re-reads through its builder, audits and drops the role cache", () => {
    const panel = src("components/pending-roles-panel.tsx");
    expect(panel).toContain("buildAcceptPendingRole(rpc, row, signer)");
    expect(panel).toContain("buildCancelKycRegistryProposal(rpc, p.target, signer)");
    expect(panel.match(/invalidateRoles\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(panel.match(/recordAudit\(/g)?.length).toBeGreaterThanOrEqual(4);
    expect(panel).toContain("<ConfirmModal");
    // Issuer rows go to /issuer/rotation (or the CLI), never an inline accept.
    expect(panel).toContain("/issuer/rotation?issuer=");
    expect(panel).toContain("Issuer key, not a platform role · KYB:");
  });

  it("AuthorityRotation points the successor at /account/roles and shows the platform checklist", () => {
    const rotation = src("app/admin/platform/authority-rotation.tsx");
    expect(rotation).toContain("href={ACCOUNT_ROLES_PATH}");
    expect(rotation).not.toContain('href="/issuer/authority"');
    expect(rotation).toContain("<PlatformAcceptChecklist />");
    expect(rotation).toContain("recordAudit(");
  });

  it("custody: a stale proposal hides Accept and offers the Super Admin a re-proposal", () => {
    const custody = src("components/custody-authority-transfer.tsx");
    expect(custody).toContain("!state.stale && state.proposed === wallet");
    expect(custody).toContain("Re-propose");
  });
});

describe("K5 registry creation (E)", () => {
  it("/admin/kyc: the bootstrap card is open to admin|kycProvider; create needs an Admin; OD6 fast path", () => {
    const page = src("app/admin/kyc/page.tsx");
    expect(page).toMatch(
      /<RequireRole anyOf=\{\["admin", "kycProvider"\]\} fallback=\{<><\/>\}>\s*<KycRegistryBootstrap/,
    );
    expect(page).not.toContain('<RequireRole role="superAdmin"');
    expect(page).toContain("if (!wallet || !conn.wallet || !isAdmin) return;");
    // A pin that is not this wallet's seed slot goes to the envelope page.
    expect(page).toContain('setRegistryState({ status: "envelope", pinned: ctx.pinned });');
    expect(page).toContain('const REGISTRY_ENVELOPE_PATH = "/account/roles/kyc-registry";');
    expect(page).toContain('registryState.status === "missing" && isAdmin');
    expect(page).not.toContain("The connected wallet signs twice");
  });

  it("the envelope page sits outside the admin gate and finishes with the cache drops and the audit", () => {
    const page = src("app/account/roles/kyc-registry/page.tsx");
    expect(page).toContain('<AppShell section="account">');
    expect(page).not.toMatch(/RequireRole|AdminGate/);
    const flow = src("components/kyc-registry-creation-flow.tsx");
    const submit = flow.slice(flow.indexOf("await submitKycRegistryCreation("));
    for (const step of ["recordAudit(", "invalidateKycAuthorityContext(rpc)", "waitForKycRegistry(rpc)", "invalidateRoles()"]) {
      expect(submit).toContain(step);
    }
    expect(flow).toContain("<ConfirmModal");
  });
});

describe("K2/K3 bootstrap (F)", () => {
  it("/issuer/authority is a dedicated bootstrap page, not the platform console", () => {
    const page = src("app/issuer/authority/page.tsx");
    expect(page).not.toContain('export { default } from "@/app/admin/platform/page"');
    expect(page).toContain("{platformExists === false && (");
    expect(page).toContain("<PlatformInitCard");
    expect(page).toContain("<BlocklistBootstrap hideWhenInitialized");
    expect(page).toContain('kind="platform"');
    expect(page).toContain('kind="blocklist"');
    expect(page).toContain("href={ACCOUNT_ROLES_PATH}");
    // /admin/platform keeps using the same extracted card.
    const console = src("app/admin/platform/page.tsx");
    expect(console).toContain("<PlatformInitCard");
    expect(console).not.toContain("buildInitializePlatformInstruction");
  });

  it("platform init: explicit treasury, acknowledged self-appointment, refused on mainnet", () => {
    const card = src("app/admin/platform/platform-init-card.tsx");
    expect(card).not.toContain("Super Admin (you)");
    expect(card).not.toMatch(/Super Admin and treasury/);
    expect(card).toContain("protocolTreasury: treasury.trim() as Address");
    expect(card).not.toContain("protocolTreasury: walletAddress");
    expect(card).toContain("This wallet becomes Super Admin and admin #1; I will propose the");
    expect(card).toContain("disabled={tx.isSending || !ack || check.errors.length > 0 || upgrade.status !== \"ok\"}");
    expect(card).toContain('surface: "browser"');
    expect(card).toContain("{refused ? (");
    expect(card).toContain("metadata = { treasury: treasury.trim(), upgradeAuthority: wallet, permanentSuperAdmin }");
  });

  it("blocklist init: only the connected upgrade authority, acknowledged, refused on mainnet", () => {
    const card = src("app/admin/platform/blocklist-bootstrap.tsx");
    expect(card).toContain("authority: signer.address");
    expect(card).toContain("I will propose the permanent blocklist authority next.");
    expect(card).toContain("!ack ||");
    expect(card).toContain("MAINNET_BOOTSTRAP_REFUSAL");
    expect(card).toContain('surface: "browser"');
  });

  it("the successor entered at init pre-fills the rotation panel", () => {
    const rotation = src("app/admin/platform/authority-rotation.tsx");
    expect(rotation).toContain('useState(initialNext ?? "")');
    expect(rotation).toContain("next.trim() === DEFAULT_ADDRESS");
  });
});

describe("review follow-ups (3.1)", () => {
  it("K17: Grant and Revoke on the Admins page are Super Admin only", () => {
    const page = src("app/admin/admins/page.tsx");
    expect(page).toContain("const { isSuperAdmin } = useRole();");
    expect(page).toContain("disabled={!isSuperAdmin || tx.isSending || !grantAddr.trim()}");
    expect(page).toContain("disabled={!isSuperAdmin || tx.isSending || !revokeAddr.trim()}");
    expect(page.match(/if \(!isSuperAdmin \|\| !wallet/g)?.length).toBe(2);
  });

  it("K18: issuer registration asks for a dedicated issuer key", () => {
    expect(src("app/admin/issuers/page.tsx")).toContain("Use a dedicated issuer key, not an Admin key");
  });

  it("RequireRole decides through gateOutcome and remembers only fresh decisions", () => {
    const gate = src("components/require-role.tsx");
    expect(gate).toContain("gateOutcome(state, requirement, last)");
    expect(gate).toContain("!state.stale && state.walletAddress");
  });

  it("Access denied points operators to /account/roles and an uninitialized platform to the setup page", () => {
    const gate = src("components/require-role.tsx");
    expect(gate).toContain("holdsOperatorRole(state) && (");
    expect(gate).toContain("{!state.platformInitialized && (");
    expect(gate).toContain('AUTHORITY_SETUP_PATH = "/issuer/authority"');
  });

  it("the pending roles panel shows only the connected wallet's latest load", () => {
    const panel = src("components/pending-roles-panel.tsx");
    expect(panel).toContain("const current = valueForWallet(loaded, wallet);");
    expect(panel).toContain("const isLatest = latest.begin();");
    expect(panel).not.toContain("setResult(");
  });

  it("bootstrap cards wait for finality instead of offering a second init", () => {
    const card = src("app/admin/platform/blocklist-bootstrap.tsx");
    expect(card).toContain("const waiting = submitted && !authority;");
    expect(card).toContain("startFinalityPoll(refresh,");
    expect(card).toContain(") : waiting ? (");
    const rotation = src("app/admin/platform/authority-rotation.tsx");
    expect(rotation).toContain("const waitingForInit = awaitInitialization && state === null;");
    for (const rel of ["app/issuer/authority/page.tsx", "app/admin/platform/page.tsx"]) {
      const page = src(rel);
      expect(page).toContain("awaitInitialization={blocklistSuccessor !== undefined}");
      expect(page).toContain("awaitInitialization={platformSuccessor !== undefined}");
    }
  });

  it("an imported registry-creation document is verified before review", () => {
    const flow = src("components/kyc-registry-creation-flow.tsx");
    expect(flow).toContain("await inspectKycRegistryCreation(raw, network)");
    expect(flow).not.toContain("verified before use");
  });
});
