import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";

type Rule = { source: string; headers: { key: string; value: string }[] };

// Mirrors Next's matching for the rules used here: every matching rule
// applies in order and a later rule overrides the same header key.
function headersFor(rules: Rule[], path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) {
    const prefix = rule.source.replace(/\/:path\*$/, "");
    if (path === prefix || path.startsWith(`${prefix}/`) || prefix === "") {
      for (const { key, value } of rule.headers) out[key.toLowerCase()] = value;
    }
  }
  return out;
}

describe("security headers", async () => {
  const rules = (await nextConfig.headers!()) as Rule[];

  it.each(["/", "/marketplace", "/api/health", "/account", "/api/account/profile"])("hardens %s", (path) => {
    expect(headersFor(rules, path)).toMatchObject({
      "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "cross-origin-opener-policy": "same-origin-allow-popups",
    });
  });

  it("uses strict-origin-when-cross-origin site-wide and keeps no-referrer, no-store on sensitive pages", () => {
    expect(headersFor(rules, "/marketplace")["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headersFor(rules, "/marketplace")["cache-control"]).toBeUndefined();
    for (const path of [
      "/account", "/account/security", "/api/account/profile", "/api/account/google/callback",
      "/login", "/login/email", "/onboarding/3f2b8c1e-9a4d-4c2b-8e1f-0a1b2c3d4e5f",
      "/admin", "/admin/kyc", "/admin/clients/42", "/api/auth/email/verify", "/api/auth/google/start",
    ]) {
      expect(headersFor(rules, path)).toMatchObject({
        "referrer-policy": "no-referrer", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow",
      });
    }
    expect(rules[0].source).toBe("/:path*");
  });

  it("does not treat look-alike paths as sensitive", () => {
    for (const path of ["/loginhelp", "/administration", "/issuer/onboarding"]) {
      expect(headersFor(rules, path)["cache-control"]).toBeUndefined();
    }
  });

  it("does not ship a Content-Security-Policy yet", () => {
    for (const rule of rules) for (const { key } of rule.headers) expect(key.toLowerCase()).not.toMatch(/content-security-policy/);
  });
});
