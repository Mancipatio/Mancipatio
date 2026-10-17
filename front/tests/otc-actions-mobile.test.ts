// Every OTC table clipped its trailing Actions column on phones (Phantom's
// in-app browser leaves about 356 px): a holder could not fund or cancel an
// offer, deposit into or refund a deal, or reach "Take →". PR #76 moved the
// row actions under the status on /portfolio/conversion and
// /portfolio/delivery (tests/holder-actions-mobile.test.ts); this pins the
// same pattern on the five OTC tables: no trailing Actions column, every row
// action in the first (asset) cell at the left edge, and a wrapper that
// scrolls sideways instead of clipping.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** The #76 actions container; `empty:hidden` covers rows with nothing to do. */
const ACTIONS_ROW =
  'className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs empty:hidden"';

const specs = [
  {
    page: "/portfolio/deals",
    file: "app/portfolio/deals/page.tsx",
    cell: 1,
    labels: ["Deposit asset", "Deposit payment", "Refund expired deal"],
  },
  {
    page: "/portfolio/offers",
    file: "app/portfolio/offers/page.tsx",
    cell: 1,
    labels: ["Reclaim rent", "Take →", "Fund escrow", "Cancel\n"],
  },
  {
    page: "/portfolio/listings",
    file: "app/portfolio/listings/page.tsx",
    cell: 1,
    labels: ["Create on-chain offer", "Request escrow", "Mark matched", "Withdraw\n"],
  },
  {
    page: "/marketplace/otc",
    file: "app/marketplace/otc/page.tsx",
    cell: 1,
    labels: ["Take →"],
  },
  {
    page: "/markets/resell board",
    file: "app/(marketing)/markets/resell/resell-board.tsx",
    cell: 2,
    labels: ["Open ↗"],
  },
];

describe.each(specs)("$page row actions on a phone", ({ file, cell, labels }) => {
  const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  // The row template only: the confirm dialogs and help texts repeat labels.
  const tbody = src.slice(src.indexOf("<tbody"), src.indexOf("</tbody>"));
  // cells[1] is the first column of the row template, cells[2] the second…
  const cells = tbody.split("<td");

  it("has no trailing Actions column and a horizontally scrollable table", () => {
    expect(tbody.length).toBeGreaterThan(0);
    expect(src).not.toMatch(/>\s*Actions?\s*<\/th>/);
    expect(src).not.toMatch(/<th[^>]*><\/th>/);
    expect(src).toMatch(/overflow-x-auto rounded-(xl|\[3px\])/);
    expect(src).not.toMatch(/overflow-hidden rounded-(xl|\[3px\])/);
  });

  it(`renders each action in cell ${cell}, inside the shared actions row, and nowhere else in the row`, () => {
    expect(cells[cell]).toContain(ACTIONS_ROW);
    const actionsAt = cells[cell].indexOf(ACTIONS_ROW);
    for (const label of labels) {
      const owners = cells
        .map((c, i) => (c.includes(label) ? i : -1))
        .filter((i) => i >= 0);
      expect(owners, label).toEqual([cell]);
      expect(cells[cell].indexOf(label), label).toBeGreaterThan(actionsAt);
    }
  });
});
