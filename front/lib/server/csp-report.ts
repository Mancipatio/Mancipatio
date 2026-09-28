// SERVER-ONLY — CSP violation reports (front-app-6), pure.
//
// Browsers POST them to /api/csp-report while the policy is report-only
// (next.config.ts contentSecurityPolicy), in either format:
//   - legacy `report-uri`: {"csp-report": {"document-uri", "effective-directive"
//     or "violated-directive", "blocked-uri", "disposition", ...}}
//   - Reporting API `report-to`: [{"type": "csp-violation", "body":
//     {"documentURL", "effectiveDirective", "blockedURL", "disposition"}}]
// Only what is needed to extend or fix the policy survives: the directive,
// the blocked ORIGIN (or a keyword such as inline, eval, data) and the page
// PATH. Never a query string or fragment (/login/email?token=… carries a
// credential), never the sample, the referrer or a user agent.

import "server-only";

export type CspViolation = { directive: string; blocked: string; page: string; disposition: "report" | "enforce" };

const KEYWORD = /^[a-z-]{1,20}$/;

function blockedOf(value: unknown): string {
  if (typeof value !== "string" || !value) return "unknown";
  if (KEYWORD.test(value)) return value; // inline, eval, self, data, blob, wasm-eval, trusted-types-…
  try {
    const url = new URL(value);
    if (url.protocol === "data:" || url.protocol === "blob:") return url.protocol.slice(0, -1);
    return url.origin === "null" ? url.protocol.slice(0, -1) : url.origin;
  } catch {
    return "unknown";
  }
}

function pageOf(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  try {
    return new URL(value).pathname.slice(0, 200);
  } catch {
    return "unknown";
  }
}

function directiveOf(value: unknown): string {
  const d = typeof value === "string" ? value.trim().split(/\s+/)[0] : "";
  return /^[a-z-]{1,40}$/.test(d) ? d : "unknown";
}

/** The violations of one report body (at most `max`); [] for anything else. */
export function summarizeCspReport(body: unknown, max = 10): CspViolation[] {
  const out: CspViolation[] = [];
  const push = (r: Record<string, unknown>, legacy: boolean) => {
    const directive = directiveOf(legacy ? r["effective-directive"] ?? r["violated-directive"] : r.effectiveDirective);
    out.push({
      directive,
      blocked: blockedOf(legacy ? r["blocked-uri"] : r.blockedURL),
      page: pageOf(legacy ? r["document-uri"] : r.documentURL),
      disposition: (legacy ? r.disposition : r.disposition) === "enforce" ? "enforce" : "report",
    });
  };
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const legacy = (body as Record<string, unknown>)["csp-report"];
    if (legacy && typeof legacy === "object") push(legacy as Record<string, unknown>, true);
  } else if (Array.isArray(body)) {
    for (const item of body.slice(0, max)) {
      const report = item as { type?: unknown; body?: unknown };
      if (report?.type === "csp-violation" && report.body && typeof report.body === "object") {
        push(report.body as Record<string, unknown>, false);
      }
    }
  }
  return out.slice(0, max);
}
