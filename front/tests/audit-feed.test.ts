// lib/audit-feed: a "Send to wallets" transaction can have several final
// audit rows (the browser's, a resume's, the retry worker's); a feed shows
// one per signature — the server's chain-checked row when there is one, else
// the earliest — and counts the others on it. Pending rows and other kinds
// of rows pass through. The admin audit page reads through it. Which row is
// the server's comes from /api/audit/list (chain_checked), never from the
// metadata a caller of the unsigned /api/audit can write. A recorded
// document anchor is noted from /api/audit/list's anchor_verified (the row id
// the record route derives), never from its category alone.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collapseDistributionFinals, isChainChecked, isVerifiedDocumentAnchor, type FeedAuditRow } from "@/lib/audit-feed";
import { DOCUMENT_ANCHOR_AUDIT } from "@/lib/document-anchor-audit";
import { DOCUMENT_ANCHOR_AUDIT as REEXPORTED } from "@/lib/document-anchor";

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

/** The retry worker's row as /api/audit/list returns it (chain_checked computed by the server). */
const serverRow = (over: Partial<FeedAuditRow> = {}) =>
  row({
    actor_wallet: "server",
    chain_checked: true,
    metadata: { reconciled_by_server: true, actor_source: "retry-worker", chain_outcome: "finalized" },
    ...over,
  });

/** A row posted to /api/audit with the worker's markers in its metadata: the route stamps actor_source. */
const forgedRow = (over: Partial<FeedAuditRow> = {}) =>
  row({
    actor_wallet: "server",
    status: "failed",
    metadata: { reconciled_by_server: true, chain_outcome: "finalized_with_error", actor_source: "client-unsigned" },
    ...over,
  });

describe("collapseDistributionFinals", () => {
  it("keeps the server's chain-checked row of a signature and counts the browser's and the resume's on it", () => {
    const pending = row({ status: "pending" });
    const browser = row({});
    const server = serverRow();
    const resume = row({ metadata: { reconciled_on_resume: true } });
    const out = collapseDistributionFinals([resume, server, browser, pending]);
    expect(out.map((r) => r.id)).toEqual([server.id, pending.id]);
    expect(out[0]).toMatchObject({ duplicates: 2 });
    expect(out[1]).toMatchObject({ duplicates: 0, status: "pending" });
    expect(isChainChecked(out[0])).toBe(true);
  });

  it("a forged row with the worker's metadata markers never stands for the signature: the earliest row does", () => {
    const browser = row({});
    const forged = forgedRow();
    const out = collapseDistributionFinals([forged, browser]);
    expect(out.map((r) => [r.id, r.duplicates])).toEqual([[browser.id, 1]]);
    expect(out.every((r) => !isChainChecked(r))).toBe(true);
    // Next to the real server row it is one more duplicate.
    const server = serverRow();
    expect(collapseDistributionFinals([forged, server, browser]).map((r) => [r.id, r.duplicates])).toEqual([[server.id, 2]]);
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

  it("isChainChecked is the server's verdict (chain_checked), never a metadata marker", () => {
    const worker = { reconciled_by_server: true, actor_source: "retry-worker" };
    expect(isChainChecked({ chain_checked: true, actor_wallet: "server", metadata: worker })).toBe(true);
    // What anyone can post to /api/audit: the marker, the server's actor, but actor_source stamped by the route.
    expect(isChainChecked({ actor_wallet: "server", metadata: { reconciled_by_server: true, actor_source: "client-unsigned" } })).toBe(false);
    expect(isChainChecked({ metadata: { reconciled_by_server: true } })).toBe(false);
    // Even the worker's exact metadata is nothing without the server's flag…
    expect(isChainChecked({ actor_wallet: "server", metadata: worker })).toBe(false);
    expect(isChainChecked({ chain_checked: false, actor_wallet: "server", metadata: worker })).toBe(false);
    // …and the flag needs the worker's actor and actor_source too.
    expect(isChainChecked({ chain_checked: true, actor_wallet: "server", metadata: { reconciled_by_server: true, actor_source: "client-unsigned" } })).toBe(false);
    expect(isChainChecked({ chain_checked: true, actor_wallet: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2", metadata: worker })).toBe(false);
    expect(isChainChecked({ chain_checked: true, actor_wallet: "server", metadata: null })).toBe(false);
    expect(isChainChecked({})).toBe(false);
  });
});

describe("isVerifiedDocumentAnchor", () => {
  it("is the anchor route's row: /api/audit/list said so (anchor_verified), and category and ix agree", () => {
    expect(DOCUMENT_ANCHOR_AUDIT).toEqual({ category: "operator", ixName: "document_anchor" });
    expect(REEXPORTED).toBe(DOCUMENT_ANCHOR_AUDIT);
    const anchor = { category: "operator", ix_name: "document_anchor", anchor_verified: true };
    expect(isVerifiedDocumentAnchor(anchor)).toBe(true);
    // The category alone is not enough: the server did not find the derived id
    // (tests/document-anchor-routes.test.ts, "/api/audit/list: anchor_verified").
    expect(isVerifiedDocumentAnchor({ ...anchor, anchor_verified: false })).toBe(false);
    expect(isVerifiedDocumentAnchor({ category: "operator", ix_name: "document_anchor" })).toBe(false);
    expect(isVerifiedDocumentAnchor({ ...anchor, anchor_verified: "true" })).toBe(false);
    // Anything else is not one, whatever the flag says.
    expect(isVerifiedDocumentAnchor({ ...anchor, category: "other" })).toBe(false);
    expect(isVerifiedDocumentAnchor({ ...anchor, category: "platform" })).toBe(false);
    expect(isVerifiedDocumentAnchor({ ix_name: "document_anchor", anchor_verified: true })).toBe(false);
    expect(isVerifiedDocumentAnchor({ ...anchor, ix_name: "share_class_distribution" })).toBe(false);
  });

  it("keeps the feed helper free of the anchor builder (kit, compute budget): only the constants module", () => {
    const feed = fs.readFileSync(path.join(__dirname, "..", "lib/audit-feed.ts"), "utf8");
    expect(feed).toContain('from "@/lib/document-anchor-audit"');
    expect(feed).not.toContain('from "@/lib/document-anchor"');
  });
});

describe("the admin audit page reads through it", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "app/admin/audit/page.tsx"), "utf8");

  it("collapses duplicate finals, and shows a server row as the server's, its claims unverified", () => {
    expect(src).toContain("collapseDistributionFinals(auditR).map(");
    expect(src).toContain("chain_checked: isChainChecked(r),");
    expect(src).toContain("From the chain; the sender&apos;s claims are unverified");
    expect(src).toMatch(/\{r\.chain_checked \? \([\s\S]*?Server[\s\S]*?\) : r\.actor_wallet \?/);
    // The label comes from the server's flag, never from a metadata marker a caller can post.
    expect(src).not.toContain("reconciled_by_server");
  });

  it("notes a recorded document anchor as verified on chain (finalized), from the server's anchor_verified", () => {
    expect(src).toContain("anchor_verified: isVerifiedDocumentAnchor(r),");
    expect(src).toMatch(/\{r\.anchor_verified && \([\s\S]*?Verified on chain \(finalized\)/);
  });
});
