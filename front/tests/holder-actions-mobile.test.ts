// Holders on phones (Phantom in-app browser) could not reach "Deposit tokens":
// the trailing Actions column was clipped by an overflow-hidden container.
// The row actions now render under the status, and the table scrolls sideways.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pages = ["conversion", "delivery"];

describe.each(pages)("/portfolio/%s holder actions", (page) => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "app", "portfolio", page, "page.tsx"),
    "utf8",
  );

  it("has no trailing Actions column and a horizontally scrollable table", () => {
    expect(src).not.toMatch(/>Actions<\/th>/);
    expect(src).toContain('className="mt-8 overflow-x-auto rounded-xl');
    expect(src).not.toContain('className="mt-8 overflow-hidden rounded-xl');
  });

  it("renders each action once, inside the status cell (before the Transactions cell)", () => {
    const statusHint = src.indexOf("STATUS_HINT[r.status]");
    const txCell = src.indexOf('<TxLink sig={r.deposit_tx} label="deposit" />');
    expect(statusHint).toBeGreaterThan(-1);
    expect(txCell).toBeGreaterThan(statusHint);
    for (const label of [
      "Deposit tokens",
      "Reclaim tokens after deadline",
      "Cancel request\n",
      "Vault closed — deposit disabled",
      "Receipt saved — retry recording above",
    ]) {
      const at = src.indexOf(label);
      expect(at, label).toBeGreaterThan(statusHint);
      expect(at, label).toBeLessThan(txCell);
      expect(src.indexOf(label, at + 1), label).toBe(-1);
    }
  });
});
