// Distribute guidance (lib/distribute-guidance): a direct link to where
// Primary issuance (0x02) is reopened next to every "only the super admin can
// reopen it" note, the order of "Both", and the note when an approved sale
// holds all the room left. Rendered to static markup; next/link is stubbed.
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) =>
    createElement("a", { href, className }, children),
}));

import { PrimaryReopenLink } from "@/components/primary-reopen-link";
import {
  APPROVED_SALE_HOLDS_ROOM,
  BOTH_MODE_STEPS,
  EMERGENCY_PAUSE_ANCHOR,
  PUBLIC_SALE_REQUESTS_ANCHOR,
  REOPEN_AT_LAUNCHPAD,
  REOPEN_AT_PLATFORM,
  primaryReopenPlace,
  roomHeldByApprovedSale,
} from "@/lib/distribute-guidance";
import { LIFETIME_COUNTER_VERSION, type SupplyFacts } from "@/lib/distribution-supply";

const src = (file: string) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

const supply = (over: Partial<SupplyFacts> = {}): SupplyFacts => ({
  maxSupply: BigInt(30000),
  lifetimeMinted: BigInt(0),
  version: LIFETIME_COUNTER_VERSION,
  supplyLocked: false,
  mintablePostLaunch: false,
  openSaleRemaining: BigInt(0),
  reservedUnminted: BigInt(0),
  approvedUnopened: BigInt(0),
  treasuryBalance: BigInt(0),
  ...over,
});

describe("where Primary issuance is reopened", () => {
  it("the pre-clear check on /admin/launchpad for a public sale, else the pause panel on /admin/platform", () => {
    expect(primaryReopenPlace({ publicSale: true })).toBe(REOPEN_AT_LAUNCHPAD);
    expect(primaryReopenPlace({ publicSale: false })).toBe(REOPEN_AT_PLATFORM);
    expect(REOPEN_AT_LAUNCHPAD.href).toBe(`/admin/launchpad#${PUBLIC_SALE_REQUESTS_ANCHOR}`);
    expect(REOPEN_AT_PLATFORM.href).toBe(`/admin/platform#${EMERGENCY_PAUSE_ANCHOR}`);
  });

  it("renders a direct link", () => {
    const sale = renderToStaticMarkup(createElement(PrimaryReopenLink, { publicSale: true }));
    expect(sale).toContain(`href="${REOPEN_AT_LAUNCHPAD.href}"`);
    expect(sale).toContain("pre-clear check");
    const platform = renderToStaticMarkup(createElement(PrimaryReopenLink, { publicSale: false }));
    expect(platform).toContain(`href="${REOPEN_AT_PLATFORM.href}"`);
    expect(platform).toContain("emergency pause panel");
  });

  it("the admin pages carry the anchors the links point to", () => {
    expect(src("app/admin/launchpad/public-sale-requests.tsx")).toContain("id={PUBLIC_SALE_REQUESTS_ANCHOR}");
    expect(src("app/admin/platform/page.tsx")).toMatch(/id=\{EMERGENCY_PAUSE_ANCHOR\}[\s\S]{0,120}<PauseFlagsPanel/);
  });

  it("every 'only the super admin can reopen it' note in Distribute carries the link", () => {
    const send = src("components/send-to-wallets-panel.tsx");
    expect(send).toMatch(/primaryPausedNote\(superAdmin\)\}\s*<PrimaryReopenLink publicSale=\{saleApproved\}/);
    expect(send).toMatch(/blockers\[0\] === pausedBlocker[\s\S]{0,80}<PrimaryReopenLink publicSale=\{saleApproved\}/);
    const sale = src("components/public-sale-panel.tsx");
    expect(sale).toMatch(/only \{superAdminText\} can reopen it[\s\S]{0,140}<PrimaryReopenLink publicSale/);
    expect(sale).toMatch(/Waiting for the operator: they approve the sale and reopen Primary issuance[\s\S]{0,260}<PrimaryReopenLink publicSale/);
  });
});

describe("Both, in order", () => {
  it("request → operator approves and reopens → send → open", () => {
    expect(BOTH_MODE_STEPS).toHaveLength(4);
    expect(BOTH_MODE_STEPS[0]).toMatch(/^Request the public sale/);
    expect(BOTH_MODE_STEPS[1]).toMatch(/operator approves it and reopens Primary issuance/);
    expect(BOTH_MODE_STEPS[2]).toMatch(/^Send to the wallets/);
    expect(BOTH_MODE_STEPS[3]).toMatch(/^Open the sale/);
    const card = src("components/distribute-card.tsx");
    expect(card).toContain("BOTH_MODE_STEPS.map(");
    expect(card).toContain("<ol");
  });
});

describe("an approved sale holding the room", () => {
  it("says so only when the room is 0 because of an approved sale not opened yet", () => {
    expect(APPROVED_SALE_HOLDS_ROOM).toBe("Open the sale first (or decline it) — the approved tokens are reserved for it.");
    expect(roomHeldByApprovedSale(supply({ approvedUnopened: BigInt(30000) }))).toBe(true);
    expect(roomHeldByApprovedSale(supply({ approvedUnopened: BigInt(40000) }))).toBe(true);
    // Room is left: nothing to say.
    expect(roomHeldByApprovedSale(supply({ approvedUnopened: BigInt(20000) }))).toBe(false);
    // No approval: the room is 0 for another reason (everything created).
    expect(roomHeldByApprovedSale(supply({ lifetimeMinted: BigInt(30000) }))).toBe(false);
    // Room 0 even without the approval: the approval is not why.
    expect(roomHeldByApprovedSale(supply({ lifetimeMinted: BigInt(30000), approvedUnopened: BigInt(10) }))).toBe(false);
    // Creation blocked (supply locked): not the approval either.
    expect(roomHeldByApprovedSale(supply({ supplyLocked: true, approvedUnopened: BigInt(30000) }))).toBe(false);
  });

  it("Send to wallets and the Distribute card use it", () => {
    expect(src("components/send-to-wallets-panel.tsx")).toContain("roomHeld && supplyNow.problem ? `${APPROVED_SALE_HOLDS_ROOM} ${supplyNow.problem}`");
    expect(src("components/distribute-card.tsx")).toContain("roomHeldByApprovedSale(supply) &&");
  });
});
