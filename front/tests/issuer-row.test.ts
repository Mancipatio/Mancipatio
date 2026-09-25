// /admin/issuers row (app/admin/issuers/issuer-row): the Actions column has
// real controls (Review + KYB dossier), a pending issuer is flagged, and the
// review detail opens INLINE, in a full-width row right under its own row.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { address } from "@solana/kit";
import { KybStatus, type Issuer } from "@/lib/generated/asset_registry";
import { toBytes32 } from "@/lib/format";
import type { KybOverride } from "@/lib/issuer-directory";
import {
  ISSUER_TABLE_COLUMNS,
  IssuerRowGroup,
  returnsFocusOnClose,
  reviewScrollOptions,
} from "@/app/admin/issuers/issuer-row";

const AUTHORITY = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";

function issuer(kybStatus: KybStatus): Issuer {
  return {
    discriminator: new Uint8Array(8),
    authority: address(AUTHORITY),
    legalEntityId: toBytes32("ACME-DOO-2026"),
    jurisdiction: 688,
    kybStatus,
    kybDocHash: new Uint8Array(32),
    assetsCount: BigInt(3),
    version: 1,
    bump: 255,
  };
}

function render(
  kybStatus: KybStatus,
  opts: { expanded?: boolean; sync?: KybOverride["phase"] | null } = {},
): string {
  return renderToStaticMarkup(
    createElement(
      "table",
      null,
      createElement(
        IssuerRowGroup,
        {
          issuer: issuer(kybStatus),
          legalId: "ACME-DOO-2026",
          sync: opts.sync ?? null,
          expanded: opts.expanded ?? false,
          onToggle: () => undefined,
        },
        createElement("p", null, "ISSUER-DETAIL"),
      ),
    ),
  );
}

describe("issuer row actions", () => {
  it("offers Review and a KYB dossier link for the authority wallet", () => {
    const html = render(KybStatus.Verified);
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Review<\/button>/);
    expect(html).toContain(`href="/admin/clients?q=${AUTHORITY}"`);
    expect(html).toContain("KYB dossier →");
    expect(html).not.toContain("Needs review");
    expect(html).not.toContain("ISSUER-DETAIL");
  });

  it("flags a pending issuer as needing review", () => {
    const html = render(KybStatus.Pending);
    expect(html).toContain("Needs review");
    expect(html).toContain(">Pending<");
  });

  it("marks a row whose status came from the chain while the indexer catches up", () => {
    expect(render(KybStatus.Verified, { sync: "syncing" })).toContain("syncing…");
    expect(render(KybStatus.Verified, { sync: "chain" })).toContain("on-chain");
  });
});

describe("inline review detail", () => {
  it("opens in a full-width row directly under its own row", () => {
    const html = render(KybStatus.Pending, { expanded: true });
    const body = html.match(/<tbody[^>]*>([\s\S]*)<\/tbody>/)?.[1] ?? "";
    const rows = body.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("ACME-DOO-2026");
    expect(rows[1]).toContain(`colSpan="${ISSUER_TABLE_COLUMNS}"`);
    expect(rows[1]).toContain("ISSUER-DETAIL");
  });

  it("the Review button says it is expanded and controls the detail region", () => {
    const html = render(KybStatus.Pending, { expanded: true });
    const button = html.match(/<button[^>]*>Close<\/button>/)?.[0] ?? "";
    expect(button).toContain('aria-expanded="true"');
    const controls = button.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}" role="region"`);
  });

  it("counts the table's columns (the detail row spans them all)", () => {
    const html = render(KybStatus.Verified);
    const cells = html.match(/<td[\s>]/g) ?? [];
    expect(cells).toHaveLength(ISSUER_TABLE_COLUMNS);
  });
});

describe("focus and scroll when reviews open and close", () => {
  const closed = { wasExpanded: true, expanded: false };

  it("hands the focus back only when the detail took it along and nothing else opened", () => {
    // Close ✕ inside the detail: the focus went with the unmounted detail.
    expect(returnsFocusOnClose({ ...closed, anotherOpen: false, focusDropped: true })).toBe(true);
    // Opening row B closes row A: A must not pull the focus (and the page) back.
    expect(returnsFocusOnClose({ ...closed, anotherOpen: true, focusDropped: true })).toBe(false);
    // The focus is somewhere else already (e.g. on the button that closed it).
    expect(returnsFocusOnClose({ ...closed, anotherOpen: false, focusDropped: false })).toBe(false);
    // Not a close.
    expect(
      returnsFocusOnClose({ wasExpanded: false, expanded: true, anotherOpen: false, focusDropped: true }),
    ).toBe(false);
    expect(
      returnsFocusOnClose({ wasExpanded: false, expanded: false, anotherOpen: false, focusDropped: true }),
    ).toBe(false);
  });

  it("scrolls an opened review to the top, so its row and decision block show", () => {
    expect(reviewScrollOptions(false)).toEqual({ block: "start", behavior: "smooth" });
    expect(reviewScrollOptions(true)).toEqual({ block: "start", behavior: "auto" });
  });

  it("gives the group a scroll margin for the maintenance banner", () => {
    expect(render(KybStatus.Pending, { expanded: true })).toMatch(
      /<tbody class="[^"]*scroll-mt-\[calc\(16px\+var\(--maintenance-banner-h,0px\)\)\]/,
    );
  });
});
