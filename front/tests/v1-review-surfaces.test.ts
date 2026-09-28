// v1.0.0-rc (8.3) review fixes on the pages (no jsdom here: the page sources
// are read, and the shared notice is rendered to static markup): the freeze
// badge and pre-wallet checks, the admin-grant window during bootstrap, the
// passport expiry cap on the client page, the sale end bounds, the recovery
// notice on /admin/platform, and the finality wait after a freeze.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PROCEEDS_FROZEN_BADGE, ProceedsFrozenNotice } from "@/components/proceeds-frozen-notice";
import { FROZEN_SALE_PAYMENTS_NOTE } from "@/lib/issuer-freeze";

const src = (file: string) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

describe("proceeds freeze on the issuer, launchpad, payout and rights pages (design 8.3 §3)", () => {
  it("the notice names what is closed and that money paid in stays in escrow", () => {
    const html = renderToStaticMarkup(createElement(ProceedsFrozenNotice, { closed: "this sale takes no purchases" }));
    expect(html).toContain(PROCEEDS_FROZEN_BADGE);
    expect(html).toContain("this sale takes no purchases until the Super Admin lifts the freeze");
    expect(html).toContain(FROZEN_SALE_PAYMENTS_NOTE.replace(/'/g, "&#x27;"));
  });

  it.each([
    ["app/marketplace/launchpad/[sale]/page.tsx", /!issuerFrozen &&/],
    ["app/issuer/launchpad/page.tsx", /proceedsFrozen \|\|/],
    ["app/issuer/payouts/page.tsx", /disabled=\{tx\.isSending \|\| !releaseReady \|\| proceedsFrozen\}/],
    ["app/portfolio/rights/page.tsx", /disabled=\{tx\.isSending \|\| proceedsFrozen\}/],
  ])("%s reads the freeze, shows the badge and disables the action", (file, disabled) => {
    const page = src(file);
    expect(page).toContain("useIssuerFreezes(");
    expect(page).toContain("<ProceedsFrozenNotice");
    expect(page).toMatch(disabled);
  });

  it("the sale page checks the gate accounts before its preparation transaction", () => {
    const page = src("app/marketplace/launchpad/[sale]/page.tsx");
    const gate = page.indexOf("await assertGateAccountsUnset(client.runtime.rpc, plan.purchaseInstructions);");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(page.indexOf("if (plan.preparationInstructions.length) {"));
  });

  it("the freeze panel waits for finality before it shows the new state, buttons off meanwhile", () => {
    const panel = src("app/admin/issuers/issuer-freeze-panel.tsx");
    expect(panel).toContain("startFinalityPoll(");
    expect(panel.match(/settling !== null \|\| gate\.(freeze|unfreeze) !== null/g)).toHaveLength(2);
    expect(panel).toContain("{FROZEN_SALE_PAYMENTS_NOTE}");
  });
});

describe("other page fixes", () => {
  it("/admin/admins judges a grant's window with the bootstrap waiver (util::effective_eta)", () => {
    expect(src("app/admin/admins/page.tsx")).toMatch(
      /proposalWindowState\(p, now, \{ pauseFlags: p\.platformPauseFlags, bootstrapWaived: true \}\)/,
    );
  });

  it("/admin/clients/[id] caps the passport expiry like /admin/kyc (6146) and refuses before signing", () => {
    const page = src("app/admin/clients/[id]/page.tsx");
    expect(page).toContain("passportExpirySeconds(client.kyc_expires_at, nowSec, KYC_VALIDITY_DAYS)");
    expect(page).toContain("kycExpiryError(expiry, BigInt(nowSec))");
    expect(page).not.toMatch(/storedExpirySec > nowSec/);
  });

  it.each(["app/admin/launchpad/page.tsx", "app/issuer/launchpad/page.tsx"])(
    "%s: the sale end date is required, bounded and defaulted (no 'optional' label)",
    (file) => {
      const page = src(file);
      expect(page).not.toMatch(/End date \(optional/);
      expect(page).toContain("End date (required: every sale ends, at most 365 days out)");
      expect(page).toMatch(/required\s+value=\{endTs\}\s+min=\{endBounds\.min\}\s+max=\{endBounds\.max\}/);
      expect(page).toContain("useState(endBounds.defaultValue)");
    },
  );

  it("/admin/platform renders the recovery notice (with its Cancel); a read error is shown, never hidden", () => {
    expect(src("app/admin/platform/page.tsx")).toContain("<RoleRecoveryNotice />");
    const notice = src("components/role-recovery-notice.tsx");
    expect(notice).toContain("RECOVERY_READ_ERROR(kind)");
    expect(notice).not.toMatch(/Best effort/);
    expect(notice).toContain("startFinalityPoll(");
  });

  it("the stale Super Admin / BA proposal is explained on the rotation panel, not an RPC error", () => {
    const panel = src("app/admin/platform/authority-rotation.tsx");
    expect(panel).toContain("Retired by a recovery");
    expect(panel).toContain("STALE_OPERATIONAL_PROPOSAL");
  });

  it("the KYC and issuer rotation screens judge the 14-day expiry on the chain clock", () => {
    expect(src("components/kyc-registry-panel.tsx")).toContain("kycTransferState(registryAddress.toString(), authority, pending, now)");
    const rotation = src("app/issuer/rotation/page.tsx");
    expect(rotation.match(/issuerTransferState\(.*, now\)/g)).toHaveLength(2);
    expect(rotation).toContain('t.state.kind === "expired"');
  });
});
