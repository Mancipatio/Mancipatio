// Talas 3.1 §3 K6: the exact authorization gate of every client-dossier and
// compliance route. Read from the route sources, so a later edit that widens
// (or narrows) a route without updating this matrix fails here. The runtime
// behaviour of the widened routes is covered by tests/kyc-provider-routes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SESSION_READ_ACTIONS } from "@/lib/siws-session";

type Gate = "requireAdmin" | "requireAdminOrKycProvider" | "requireSuperAdmin" | "requireKycProvider";

const MATRIX: Record<string, Gate> = {
  // Widened for the KYC provider (K6).
  "clients/admin-list": "requireAdminOrKycProvider",
  "clients/admin-detail": "requireAdminOrKycProvider",
  "clients/doc-url": "requireAdminOrKycProvider",
  "clients/note": "requireAdminOrKycProvider",
  "clients/status": "requireAdminOrKycProvider",
  "clients/request-docs": "requireAdminOrKycProvider",
  "clients/review-requirement": "requireAdminOrKycProvider",
  "clients/upload": "requireAdminOrKycProvider",
  "compliance/open-wallets": "requireAdminOrKycProvider",
  "passport/list": "requireAdminOrKycProvider",
  "passport/update": "requireAdminOrKycProvider",
  // The admin menu counts: the role picks the sources (lib/server/admin-badges.ts).
  "admin/badges": "requireAdminOrKycProvider",
  // Unchanged: Admin only (incl. every AML read/write).
  "clients/create": "requireAdmin",
  "clients/update": "requireAdmin",
  "clients/export": "requireAdmin",
  "clients/kyb-decision": "requireAdmin",
  "clients/raise-limits": "requireAdmin",
  "clients/lookup": "requireAdmin",
  "compliance/list": "requireAdmin",
  "compliance/create": "requireAdmin",
  "compliance/resolve": "requireAdmin",
  // Super Admin only.
  "clients/anonymize": "requireSuperAdmin",
  // The passport write-back: the registry authority only.
  "clients/passport-sync": "requireKycProvider",
};

const GATES: Gate[] = ["requireAdmin", "requireAdminOrKycProvider", "requireSuperAdmin", "requireKycProvider"];

const src = (route: string) => readFileSync(join(process.cwd(), "app/api", route, "route.ts"), "utf8");

/** Gate functions the route awaits (word-exact: requireAdmin ≠ requireAdminOrKycProvider). */
function gatesCalled(source: string): Gate[] {
  return GATES.filter((g) => new RegExp(`await ${g}\\(wallet\\)`).test(source));
}

describe("route guard matrix", () => {
  for (const [route, gate] of Object.entries(MATRIX)) {
    it(`${route} is gated by ${gate} only`, () => {
      const source = src(route);
      expect(gatesCalled(source)).toEqual([gate]);
      // The gate runs right after the signature check.
      const verify = source.indexOf("verifySigned(");
      const guard = source.search(new RegExp(`await ${gate}\\(wallet\\)`));
      expect(verify).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(verify);
    });
  }

  it("the two routes that can move a status pass the transition rule for a provider", () => {
    for (const route of ["clients/status", "clients/request-docs"]) {
      const source = src(route);
      expect(source).toContain("const role = await requireAdminOrKycProvider(wallet);");
      expect(source).toContain("forbidLeavingTerminal: provider");
    }
  });

  it("admin badges: a session read whose gate role narrows the counts it computes", () => {
    const source = src("admin/badges");
    expect(source).toContain('verifySigned(request, "admin.badges")');
    expect(source).toContain("const role = await requireAdminOrKycProvider(wallet);");
    expect(source).toContain("readAdminBadges({ wallet, role,");
    expect(source).toContain('"Cache-Control": "private, no-store"');
    expect(SESSION_READ_ACTIONS.has("admin.badges")).toBe(true);
    // admin-list reads the review reasons for the role that passed its gate.
    expect(src("clients/admin-list")).toContain("readClientReviewQueue(sb, network, role)");
  });

  it("open-wallets returns addresses only and is a session read", () => {
    const source = src("compliance/open-wallets");
    expect(source).toContain('.select("wallet")');
    expect(source).toContain('.eq("network", detectNetwork())');
    expect(source).toContain('["open", "escalated"]');
    expect(SESSION_READ_ACTIONS.has("compliance.openWallets")).toBe(true);
    // The full alert table stays behind requireAdmin.
    expect(src("compliance/list")).toContain('.select("*")');
  });
});
