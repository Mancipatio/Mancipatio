// lib/audit-feed: a "Send to wallets" transaction can have several final
// audit rows (the browser's, a resume's, the retry worker's); a feed shows
// one per signature — the server's chain-checked row when there is one, else
// the earliest — and counts the others on it: duplicates when they say the
// same status, a status conflict when they do not. Pending rows and other
// kinds of rows pass through. The admin audit page reads through it, and
// shows a chain-checked row's client_claims (actor, target) as unverified
// claims it can be searched by. Which row is
// the server's comes from /api/audit/list (chain_checked), never from the
// metadata a caller of the unsigned /api/audit can write. A recorded
// document anchor is noted from /api/audit/list's anchor_verified (the row id
// the record route derives), never from its category alone.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clientClaimsOf,
  collapseDistributionFinals,
  isChainChecked,
  isVerifiedDocumentAnchor,
  type FeedAuditRow,
} from "@/lib/audit-feed";
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
    expect(out[0]).toMatchObject({ duplicates: 2, conflict: null });
    expect(out[1]).toMatchObject({ duplicates: 0, conflict: null, status: "pending" });
    expect(isChainChecked(out[0])).toBe(true);
  });

  it("a browser row whose status the chain contradicts is a status conflict on the server's row, never one more duplicate", () => {
    const browser = row({ status: "success" });
    const resume = row({ status: "success", metadata: { reconciled_on_resume: true } });
    const agreeing = row({ status: "failed" });
    const server = serverRow({ status: "failed", metadata: { reconciled_by_server: true, actor_source: "retry-worker", chain_outcome: "not_found_expired" } });
    const out = collapseDistributionFinals([server, agreeing, resume, browser]);
    expect(out.map((r) => r.id)).toEqual([server.id]);
    expect(out[0].duplicates).toBe(1);
    expect(out[0].conflict).toEqual({ status: "failed", chainChecked: true, statuses: ["success"], rows: 2 });
    // Without a server row, browser rows that disagree among themselves are a conflict too (the earliest stands).
    const first = row({ tx_signature: SIG_B, status: "failed" });
    const second = row({ tx_signature: SIG_B, status: "success" });
    expect(collapseDistributionFinals([second, first])).toEqual([
      expect.objectContaining({ id: first.id, duplicates: 0, conflict: { status: "failed", chainChecked: false, statuses: ["success"], rows: 1 } }),
    ]);
  });

  it("a forged row with the worker's metadata markers never stands for the signature: the earliest row does", () => {
    const browser = row({});
    const forged = forgedRow();
    const out = collapseDistributionFinals([forged, browser]);
    // It says "failed" where the earliest says "success": a conflict, not a duplicate.
    expect(out.map((r) => [r.id, r.duplicates, r.conflict?.rows ?? 0])).toEqual([[browser.id, 0, 1]]);
    expect(out[0].conflict).toMatchObject({ chainChecked: false, status: "success", statuses: ["failed"] });
    expect(out.every((r) => !isChainChecked(r))).toBe(true);
    // Next to the real server row it is a conflict with the chain; the browser's agreeing row a duplicate.
    const server = serverRow();
    const collapsed = collapseDistributionFinals([forged, server, browser]);
    expect(collapsed.map((r) => [r.id, r.duplicates])).toEqual([[server.id, 1]]);
    expect(collapsed[0].conflict).toEqual({ status: "success", chainChecked: true, statuses: ["failed"], rows: 1 });
  });

  it("without a server row keeps the earliest final row", () => {
    const first = row({});
    const second = row({});
    const out = collapseDistributionFinals([second, first]);
    expect(out.map((r) => [r.id, r.duplicates, r.conflict])).toEqual([[first.id, 1, null]]);
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
    expect(out.every((r) => r.duplicates === 0 && r.conflict === null)).toBe(true);
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

describe("clientClaimsOf: what the sender's pending row claimed, on a chain-checked row only", () => {
  const claims = { verified: false, actor_wallet: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2", target_label: "ScPda1111", total: "500" };

  it("the claimed actor and target of the server's row", () => {
    const server = serverRow({ metadata: { reconciled_by_server: true, actor_source: "retry-worker", client_claims: claims } });
    expect(clientClaimsOf(server)).toEqual({ actor: claims.actor_wallet, target: "ScPda1111" });
    expect(clientClaimsOf(serverRow({ metadata: { actor_source: "retry-worker", client_claims: { ...claims, target_label: null } } }))).toEqual({
      actor: claims.actor_wallet,
      target: null,
    });
  });

  it("nothing for a row that is not chain-checked (the same metadata posted to /api/audit), or without claims", () => {
    expect(clientClaimsOf(forgedRow({ metadata: { actor_source: "client-unsigned", client_claims: claims } }))).toBeNull();
    expect(clientClaimsOf(row({ metadata: { client_claims: claims } }))).toBeNull();
    expect(clientClaimsOf(serverRow({ metadata: { actor_source: "retry-worker", client_claims: null } }))).toBeNull();
    expect(clientClaimsOf(serverRow({ metadata: { actor_source: "retry-worker", client_claims: ["x"] } }))).toBeNull();
    expect(clientClaimsOf(serverRow({ metadata: { actor_source: "retry-worker", client_claims: { verified: false, actor_wallet: 7 } } }))).toBeNull();
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

describe("document anchors and distribution rows stay apart in the feed", () => {
  /** A recorded document anchor as /api/audit/list returns it (anchor_verified computed by the server). */
  const anchorRow = (over: Partial<FeedAuditRow> = {}) => ({
    ...row({
      ix_name: "document_anchor",
      actor_wallet: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2",
      anchor_verified: true,
      metadata: { actor_source: "siws-session", commitment: "finalized" },
      ...over,
    }),
    category: "operator",
  });

  it("an anchor row is never collapsed, counted or conflict-marked as a distribution, and has no claims", () => {
    // Two anchor rows on one signature, saying different statuses, next to a distribution's server row
    // and a contradicting browser row on that same signature.
    const first = anchorRow({ tx_signature: SIG_B });
    const second = anchorRow({ tx_signature: SIG_B, status: "failed", anchor_verified: false });
    const server = { ...serverRow({ tx_signature: SIG_B, status: "failed" }), category: "platform" };
    const browser = { ...row({ tx_signature: SIG_B, status: "success" }), category: "platform" };
    const out = collapseDistributionFinals([first, server, second, browser]);
    expect(out.map((r) => r.id)).toEqual([first.id, server.id, second.id]);
    expect(out[0]).toMatchObject({ duplicates: 0, conflict: null, anchor_verified: true });
    expect(out[2]).toMatchObject({ duplicates: 0, conflict: null, status: "failed" });
    // The distribution's conflict counts only its own browser row, never the anchors.
    expect(out[1].conflict).toEqual({ status: "failed", chainChecked: true, statuses: ["success"], rows: 1 });
    expect(out[1].duplicates).toBe(0);
    expect(isVerifiedDocumentAnchor(out[0])).toBe(true);
    expect(isVerifiedDocumentAnchor(out[2])).toBe(false);
    expect(isChainChecked(out[0])).toBe(false);
    expect(clientClaimsOf(out[0])).toBeNull();
  });

  it("a distribution row never gets the anchor note, whatever flag or category it carries", () => {
    const claims = { verified: false, actor_wallet: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2", target_label: "ScPda1111" };
    const server = { ...serverRow({ metadata: { actor_source: "retry-worker", client_claims: claims } }), category: "operator", anchor_verified: true };
    const browser = { ...row({}), category: "operator", anchor_verified: true };
    const out = collapseDistributionFinals([server, browser]);
    expect(out.map((r) => [r.id, r.duplicates, r.conflict])).toEqual([[server.id, 1, null]]);
    expect(isVerifiedDocumentAnchor(out[0])).toBe(false);
    expect(isVerifiedDocumentAnchor(browser)).toBe(false);
    expect(clientClaimsOf(out[0])).toEqual({ actor: claims.actor_wallet, target: "ScPda1111" });
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

  it("marks a status conflict explicitly, apart from the duplicates", () => {
    expect(src).toContain("conflict: r.conflict,");
    expect(src).toMatch(/\{r\.conflict && \([\s\S]*?Status conflict: \{r\.conflict\.chainChecked \? "the chain check says" : "this report says"\}/);
    expect(src).toMatch(/\{r\.duplicates > 0 && \([\s\S]*?duplicate/);
  });

  it("shows a chain-checked row's claimed actor and target as unverified claims, and searches them", () => {
    expect(src).toContain("const claims = clientClaimsOf(r);");
    expect(src).toContain("claimed_actor: claims?.actor ?? null,");
    expect(src).toContain("claimed_target: claims?.target ?? null,");
    expect(src).toMatch(/\{r\.chain_checked \? \([\s\S]*?\{r\.claimed_actor && \([\s\S]*?Unverified claim:[\s\S]*?\) : r\.actor_wallet \?/);
    expect(src).toMatch(/\{r\.claimed_target && \([\s\S]*?Unverified claim: <span className="font-mono">\{r\.claimed_target\}<\/span>/);
    expect(src).toContain('(r.claimed_actor ?? "").toLowerCase().includes(q) ||');
    expect(src).toContain('(r.claimed_target ?? "").toLowerCase().includes(q)');
  });

  it("notes a recorded document anchor as verified on chain (finalized), from the server's anchor_verified", () => {
    expect(src).toContain("anchor_verified: isVerifiedDocumentAnchor(r),");
    expect(src).toMatch(/\{r\.anchor_verified && \([\s\S]*?Verified on chain \(finalized\)/);
  });

  it("maps every audit row through both: the anchor flag and the conflict and claims, on the same collapsed rows", () => {
    // One mapping of collapseDistributionFinals' rows carries all of them (an anchor row passes through it
    // with no conflict; a distribution row is never a verified anchor: lib/audit-feed, tested above).
    expect(src).toMatch(
      /collapseDistributionFinals\(auditR\)\.map\(\(r\) => \{[\s\S]*?anchor_verified: isVerifiedDocumentAnchor\(r\),[\s\S]*?conflict: r\.conflict,[\s\S]*?claimed_target: claims\?\.target \?\? null,[\s\S]*?\}\);/,
    );
    // Indexer rows carry none of them.
    expect(src).toMatch(/anchor_verified: false,\s*duplicates: 0,\s*conflict: null,\s*claimed_actor: null,\s*claimed_target: null,/);
  });
});
