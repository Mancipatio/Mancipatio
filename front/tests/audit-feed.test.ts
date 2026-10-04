// lib/audit-feed: a "Send to wallets" transaction can have several final
// audit rows (the browser's, a resume's, the retry worker's); a feed shows
// one per signature — the server's chain-checked row when there is one, else
// the earliest — and counts the others on it: duplicates when they say the
// same status, a status conflict when they do not. Pending rows and other
// kinds of rows pass through. The admin audit page reads through it, and
// shows a chain-checked row's client_claims (actor, target) as unverified
// claims it can be searched by. Which row is
// the server's comes from /api/audit/list (chain_checked), never from the
// metadata a caller of the unsigned /api/audit can write.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clientClaimsOf, collapseDistributionFinals, isChainChecked, type FeedAuditRow } from "@/lib/audit-feed";

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
});
