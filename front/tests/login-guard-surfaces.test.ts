// Email sign-in client body, the Turnstile widget's opt-in wiring and the
// Securities Commission approval label on the public document surfaces.
// Pages are client components (no jsdom here), so wiring is pinned by source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startEmailSignIn } from "@/lib/account-login";
import { SSC_NOT_APPROVED_LABEL, sscDecisionRef } from "@/lib/whitepaper-approval";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("startEmailSignIn", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function sentBody(...args: Parameters<typeof startEmailSignIn>) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { sent: true } })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(startEmailSignIn(...args)).resolves.toEqual({ sent: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/email/start");
    return JSON.parse(String(init.body));
  }

  it("sends the Turnstile token with the address when there is one", async () => {
    expect(await sentBody("ana@example.com", "tok")).toEqual({ email: "ana@example.com", turnstile_token: "tok" });
  });

  it("sends only the address when Turnstile is off", async () => {
    expect(await sentBody("ana@example.com")).toEqual({ email: "ana@example.com" });
    expect(await sentBody("ana@example.com", null)).toEqual({ email: "ana@example.com" });
  });
});

describe("Turnstile widget wiring", () => {
  it("loads Cloudflare's script only from the widget, which renders nothing without a site key", () => {
    const widget = src("components/turnstile-widget.tsx");
    expect(widget).toContain("if (!siteKey) return null;");
    expect(widget).toContain("if (!siteKey || !element) return;");
    expect(widget).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    for (const page of ["components/sign-in.tsx", "app/(marketing)/contact/contact-form.tsx"]) {
      const text = src(page);
      expect(text).not.toContain("challenges.cloudflare.com");
      expect(text).toContain("turnstileSiteKey() !== null");
      // A new widget (and token) after every attempt: tokens are single-use.
      expect(text).toMatch(/<TurnstileWidget key=\{challengeRound\}/);
    }
  });
});

describe("Securities Commission approval label", () => {
  it("is approved only with status ssc_approved AND a non-blank decision reference", () => {
    expect(sscDecisionRef({ whitepaper_status: "ssc_approved", ssc_decision_ref: " KHoV 1/2026 " })).toBe("KHoV 1/2026");
    expect(sscDecisionRef({ whitepaper_status: "ssc_approved", ssc_decision_ref: "   " })).toBeNull();
    expect(sscDecisionRef({ whitepaper_status: "ssc_approved", ssc_decision_ref: null })).toBeNull();
    expect(sscDecisionRef({ whitepaper_status: "published", ssc_decision_ref: "KHoV 1/2026" })).toBeNull();
    expect(sscDecisionRef({ whitepaper_status: "ssc_approval_pending", ssc_decision_ref: "KHoV 1/2026" })).toBeNull();
  });

  it("labels unapproved whitepapers on the board and the asset page instead of plain 'Published'", () => {
    expect(SSC_NOT_APPROVED_LABEL).toBe("Not approved by the Securities Commission");
    const board = src("app/(marketing)/markets/whitepapers/whitepapers-board.tsx");
    expect(board).toContain("sscDecisionRef(profile)");
    expect(board).toContain('decisionRef ? "SSC approved" : whitepaper ? SSC_NOT_APPROVED_LABEL : "Published"');
    const asset = src("app/marketplace/assets/[id]/page.tsx");
    expect(asset).toContain("const decisionRef = sscDecisionRef(profile);");
    expect(asset).toContain("{SSC_NOT_APPROVED_LABEL}");
    expect(src("app/(marketing)/markets/whitepapers/page.tsx")).toMatch(/approved by the Securities Commission only where a\s+decision reference is shown/);
  });
});
