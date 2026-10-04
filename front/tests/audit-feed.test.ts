// lib/audit-feed: a "Send to wallets" transaction can have several final
// audit rows (the browser's, a resume's, the retry worker's); a feed shows
// one per signature — the server's chain-checked row when there is one, else
// the earliest — and counts the others on it. Pending rows and other kinds
// of rows pass through. The admin audit page reads through it.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collapseDistributionFinals, isChainChecked, type FeedAuditRow } from "@/lib/audit-feed";

const SIG_A = "A".repeat(88);
const SIG_B = "B".repeat(88);

let n = 0;
function row(over: Partial<FeedAuditRow>): FeedAuditRow {
  n++;
  return {
    id: `row-${String(n).padStart(3, "0")}`,
    created_at: `2026-10-04T12:${String(n).padStart(2, "0")}:00.000Z`,
    ix_name: "share_class_distribution",
    tx_signature: SIG_A,
    status: "success",
    metadata: {},
    ...over,
  };
}

describe("collapseDistributionFinals", () => {
  it("keeps the server's chain-checked row of a signature and counts the browser's and the resume's on it", () => {
    const pending = row({ status: "pending" });
    const browser = row({});
    const server = row({ metadata: { reconciled_by_server: true } });
    const resume = row({ metadata: { reconciled_on_resume: true } });
    const out = collapseDistributionFinals([resume, server, browser, pending]);
    expect(out.map((r) => r.id)).toEqual([server.id, pending.id]);
    expect(out[0]).toMatchObject({ duplicates: 2 });
    expect(out[1]).toMatchObject({ duplicates: 0, status: "pending" });
    expect(isChainChecked(out[0])).toBe(true);
  });

  it("without a server row keeps the earliest final row", () => {
    const first = row({});
    const second = row({ status: "failed" });
    const out = collapseDistributionFinals([second, first]);
    expect(out.map((r) => [r.id, r.duplicates])).toEqual([[first.id, 1]]);
  });

  it("leaves one-row signatures, pending rows, other instructions and rows without a signature as they are, in order", () => {
    const rows = [
      row({ tx_signature: SIG_B }),
      row({ ix_name: "mint_to_treasury" }),
      row({ ix_name: "mint_to_treasury" }),
      row({ tx_signature: null }),
      row({ tx_signature: null }),
      row({ status: "pending" }),
      row({ status: "pending" }),
    ];
    const out = collapseDistributionFinals(rows);
    expect(out.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(out.every((r) => r.duplicates === 0)).toBe(true);
  });

  it("isChainChecked is only the worker's marker", () => {
    expect(isChainChecked({ metadata: { reconciled_by_server: true } })).toBe(true);
    expect(isChainChecked({ metadata: { reconciled_by_server: "true" } })).toBe(false);
    expect(isChainChecked({ metadata: null })).toBe(false);
    expect(isChainChecked({})).toBe(false);
  });
});

describe("the admin audit page reads through it", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "app/admin/audit/page.tsx"), "utf8");

  it("collapses duplicate finals, and shows a server row as the server's, its claims unverified", () => {
    expect(src).toContain("collapseDistributionFinals(auditR).map(");
    expect(src).toContain("chain_checked: isChainChecked(r),");
    expect(src).toContain("From the chain; the sender&apos;s claims are unverified");
    expect(src).toMatch(/\{r\.chain_checked \? \([\s\S]*?Server[\s\S]*?\) : r\.actor_wallet \?/);
  });
});
