// app/admin/kyc/unsynced-issues.ts — persistence contract of the "Retry
// off-chain sync" queue (e2e §4 fix follow-up): entries are keyed by passport
// request id, matched only against that exact request, and dropped once the
// on-chain expiry they would replay has passed. A stale wallet-level entry
// must never block "Issue passport" for a later re-KYC request of the same
// wallet, nor let "Retry" stamp the old signature/expiry onto that request.
import { describe, expect, it } from "vitest";
import {
  parseUnsyncedIssues,
  pendingUnsyncedIssue,
  serializeUnsyncedIssues,
  type UnsyncedIssueMap,
} from "@/app/admin/kyc/unsynced-issues";

const WALLET = "So11111111111111111111111111111111111111112";
const SIG =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmMZmNGyXSf6TXzE";
const OLD_REQ = "10000000-0000-4000-8000-000000000001";
const NEW_REQ = "10000000-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const FUTURE = "2027-09-10T12:00:00.000Z";
const PAST = "2026-09-01T00:00:00.000Z";

function mapWith(entries: Array<[string, { wallet: string; sig: string; expiresAt: string }]>): UnsyncedIssueMap {
  return new Map(entries);
}

describe("parseUnsyncedIssues", () => {
  it("round-trips a live entry keyed by request id", () => {
    const map = mapWith([[OLD_REQ, { wallet: WALLET, sig: SIG, expiresAt: FUTURE }]]);
    const raw = serializeUnsyncedIssues(map);
    expect(raw).not.toBeNull();
    expect(parseUnsyncedIssues(raw, NOW)).toEqual(map);
    expect(serializeUnsyncedIssues(new Map())).toBeNull();
  });

  it("drops entries whose on-chain expiry has passed (or is exactly now)", () => {
    const raw = serializeUnsyncedIssues(
      mapWith([
        [OLD_REQ, { wallet: WALLET, sig: SIG, expiresAt: PAST }],
        [NEW_REQ, { wallet: WALLET, sig: SIG, expiresAt: new Date(NOW).toISOString() }],
      ]),
    );
    expect(parseUnsyncedIssues(raw, NOW).size).toBe(0);
    // …but the same entries are still pending before the expiry.
    expect(parseUnsyncedIssues(raw, Date.parse(PAST) - 1).size).toBe(2);
  });

  it("ignores the pre-fix wallet-keyed shape and malformed / corrupt input", () => {
    const legacy = JSON.stringify([[WALLET, { sig: SIG, expiresAt: FUTURE }]]);
    expect(parseUnsyncedIssues(legacy, NOW).size).toBe(0);
    expect(parseUnsyncedIssues(JSON.stringify([[OLD_REQ, { wallet: WALLET, sig: SIG, expiresAt: "soon" }]]), NOW).size).toBe(0);
    expect(parseUnsyncedIssues(JSON.stringify([[OLD_REQ, { wallet: "", sig: SIG, expiresAt: FUTURE }]]), NOW).size).toBe(0);
    expect(parseUnsyncedIssues(JSON.stringify({ [OLD_REQ]: {} }), NOW).size).toBe(0);
    expect(parseUnsyncedIssues("{not json", NOW).size).toBe(0);
    expect(parseUnsyncedIssues(null, NOW).size).toBe(0);
    expect(parseUnsyncedIssues("", NOW).size).toBe(0);
  });
});

describe("pendingUnsyncedIssue", () => {
  const stale = mapWith([[OLD_REQ, { wallet: WALLET, sig: SIG, expiresAt: FUTURE }]]);

  it("offers the repair only for the exact request whose approve_holder produced it", () => {
    expect(pendingUnsyncedIssue(stale, { id: OLD_REQ, wallet: WALLET })).toEqual({
      wallet: WALLET,
      sig: SIG,
      expiresAt: FUTURE,
    });
  });

  it("does not attach a stale entry to a later re-KYC request for the same wallet", () => {
    // Pre-fix: keyed by wallet → NEW_REQ was blocked from "Issue passport" and
    // "Retry" would have replayed OLD sig/expiry onto NEW_REQ.
    expect(pendingUnsyncedIssue(stale, { id: NEW_REQ, wallet: WALLET })).toBeNull();
  });

  it("refuses an entry whose wallet does not match the request row", () => {
    const edited = mapWith([[OLD_REQ, { wallet: "other", sig: SIG, expiresAt: FUTURE }]]);
    expect(pendingUnsyncedIssue(edited, { id: OLD_REQ, wallet: WALLET })).toBeNull();
  });

  it("a successful retry clears exactly that request and nothing else", () => {
    const both = mapWith([
      [OLD_REQ, { wallet: WALLET, sig: SIG, expiresAt: FUTURE }],
      [NEW_REQ, { wallet: "other", sig: SIG, expiresAt: FUTURE }],
    ]);
    const next = new Map(both);
    next.delete(OLD_REQ);
    expect(pendingUnsyncedIssue(next, { id: OLD_REQ, wallet: WALLET })).toBeNull();
    expect(pendingUnsyncedIssue(next, { id: NEW_REQ, wallet: "other" })).not.toBeNull();
  });
});
