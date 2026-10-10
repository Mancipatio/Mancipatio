// Email sign-in client body, the Turnstile widget's opt-in wiring and the
// Securities Commission approval label on the public document surfaces.
// Pages are client components (no jsdom here), so wiring is pinned by source;
// the whitepapers board's row, which has no effects, is also rendered.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startEmailSignIn } from "@/lib/account-login";
import { SSC_NOT_APPROVED_LABEL, sscApprovalRef, sscDecisionRef } from "@/lib/whitepaper-approval";

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

  it("on mainnet, is approved only with the verified decision document as well", () => {
    const approved = { whitepaper_status: "ssc_approved", ssc_decision_ref: "KHoV 1/2026" } as const;
    // A bare reference typed into the profile is not the Commission's approval on mainnet.
    expect(sscApprovalRef({ ...approved, ssc_decision_version_id: null }, "mainnet")).toBeNull();
    expect(sscApprovalRef({ ...approved, ssc_decision_version_id: "v-1" }, "mainnet")).toBe("KHoV 1/2026");
    expect(sscApprovalRef({ ...approved, ssc_decision_version_id: null }, "devnet")).toBe("KHoV 1/2026");
  });

  it("labels unapproved whitepapers on the board and the asset page instead of plain 'Published'", () => {
    // Named in full, like the approved badge, so no other regulator is implied.
    expect(SSC_NOT_APPROVED_LABEL).toBe("Not approved by the Serbian Securities Commission");
    // Every public surface applies the rule of the launchpad and the sale
    // page (sscApprovalRef): on mainnet no page shows an approval without
    // the verified decision document.
    const board = src("app/(marketing)/markets/whitepapers/whitepapers-board.tsx");
    expect(board).toContain("sscApprovalRef(profile, detectNetwork())");
    expect(board).not.toContain("sscDecisionRef(");
    expect(board).toContain('decisionRef ? "SSC approved" : whitepaper ? SSC_NOT_APPROVED_LABEL : "Published"');
    const asset = src("app/marketplace/assets/[id]/page.tsx");
    expect(asset).toContain("const decisionRef = sscApprovalRef(profile, detectNetwork());");
    expect(asset).not.toContain("sscDecisionRef(");
    expect(src("app/marketplace/launchpad/page.tsx")).toContain("sscApprovalRef(profile, detectNetwork())");
    expect(asset).toContain("{SSC_NOT_APPROVED_LABEL}");
    expect(asset).toContain("Approved by the Serbian Securities Commission");
    // The disclaimer points at what the board shows (the approved badge, with
    // the reference in its details), not only at the reference.
    expect(src("app/(marketing)/markets/whitepapers/page.tsx")).toMatch(
      /approved by the Serbian Securities Commission \(SSC\)\s+only where it is marked as approved, with the decision reference\s+given/,
    );
  });

  describe("the whitepapers board on mainnet, from the public profile projection", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    /** One board row for an ssc_approved whitepaper, as /api/profiles/public projects it. */
    async function boardLabel(decisionVersionId: string | null): Promise<string> {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
      vi.resetModules();
      const { projectPublicAssetProfile } = await import("@/lib/profile-public");
      const { DocumentRow } = await import("@/app/(marketing)/markets/whitepapers/whitepapers-board");
      const profile = projectPublicAssetProfile({
        asset_pda: "Asset1111111111111111111111111111111111111",
        network: "mainnet",
        category: "equity",
        display_name: "Example",
        status: "published",
        is_published: true,
        whitepaper_status: "ssc_approved",
        whitepaper_sha256: "a".repeat(64),
        whitepaper_version_id: "11111111-1111-1111-1111-111111111111",
        whitepaper_published_at: "2026-10-01T00:00:00Z",
        ssc_decision_ref: "KHoV 1/2026",
        ssc_decision_version_id: decisionVersionId,
      });
      expect(profile).not.toBeNull();
      const html = renderToStaticMarkup(
        createElement(DocumentRow, {
          item: { profile: profile!, linkId: null, whitepaper: true, documentUrl: null },
        }),
      );
      return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    }

    it("shows the approval only with the verified decision document, which the projection carries", async () => {
      // The projection keeps the field the label needs; a narrower one would
      // turn every mainnet approval into "not approved".
      const { PUBLIC_ASSET_PROFILE_FIELDS } = await import("@/lib/profile-public");
      expect(PUBLIC_ASSET_PROFILE_FIELDS).toContain("ssc_decision_version_id");

      const approved = await boardLabel("22222222-2222-2222-2222-222222222222");
      expect(approved).toContain("SSC approved");
      expect(approved).toContain("KHoV 1/2026");
      expect(approved).not.toContain(SSC_NOT_APPROVED_LABEL);

      const bareReference = await boardLabel(null);
      expect(bareReference).toContain(SSC_NOT_APPROVED_LABEL);
      expect(bareReference).not.toContain("SSC approved");
    });
  });
});
