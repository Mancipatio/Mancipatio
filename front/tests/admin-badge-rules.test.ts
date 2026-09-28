// lib/admin-badge-rules.ts and lib/indexer-freshness.ts — the pure rules the
// admin menu counts and the matching page filters share.
import { describe, expect, it } from "vitest";
import {
  adminGrantBadge,
  assetActivationBlock,
  clientReviewReasons,
  conversionWaitsForAdmin,
  deliveryWaitsForAdmin,
  platformChangeBadge,
  proposalAwaitsFinalize,
  saleExpiredOpen,
  vestingSeriesNeedsReview,
} from "@/lib/admin-badge-rules";
import { isIndexerStateFresh } from "@/lib/indexer-freshness";

const reqs = (...statuses: string[]) => statuses.map((status) => ({ status }));

describe("clientReviewReasons", () => {
  const admin = { includeKyb: true };
  const provider = { includeKyb: false };

  it("a pending dossier is a KYC decision only once every document is approved and something was submitted", () => {
    expect(clientReviewReasons({ kyc_status: "pending", requirements: reqs("approved", "approved"), details: [] }, admin)).toEqual(["final"]);
    expect(clientReviewReasons({ kyc_status: "pending", requirements: [], details: [{ kind: "kyc", status: "pending" }] }, admin)).toEqual(["final"]);
    // M3: an admin-created dossier that has not onboarded waits on the client.
    expect(clientReviewReasons({ kyc_status: "pending", requirements: [], details: [] }, admin)).toEqual([]);
    // A requested or rejected document waits on the client (verify needs all approved).
    expect(clientReviewReasons({ kyc_status: "pending", requirements: reqs("approved", "requested"), details: [] }, admin)).toEqual([]);
    expect(clientReviewReasons({ kyc_status: "pending", requirements: reqs("rejected"), details: [] }, admin)).toEqual([]);
  });

  it("an uploaded document is the reviewer's next step, whatever the open KYC state", () => {
    expect(clientReviewReasons({ kyc_status: "pending", requirements: reqs("submitted", "requested"), details: [] }, admin)).toEqual(["documents"]);
    expect(clientReviewReasons({ kyc_status: "more_info", requirements: reqs("submitted"), details: [] }, admin)).toEqual(["documents"]);
    expect(clientReviewReasons({ kyc_status: "verified", requirements: reqs("submitted"), details: [] }, admin)).toEqual(["documents"]);
    expect(clientReviewReasons({ kyc_status: "more_info", requirements: reqs("requested"), details: [] }, admin)).toEqual([]);
  });

  it("KYB is admin-only and waits for the company documents (S6)", () => {
    const kyb = [{ kind: "kyb", status: "pending" }];
    expect(clientReviewReasons({ kyc_status: "verified", requirements: reqs("approved"), details: kyb }, admin)).toEqual(["kyb"]);
    expect(clientReviewReasons({ kyc_status: "verified", requirements: reqs("approved"), details: kyb }, provider)).toEqual([]);
    expect(clientReviewReasons({ kyc_status: "verified", requirements: reqs("requested"), details: kyb }, admin)).toEqual([]);
    expect(clientReviewReasons({ kyc_status: "verified", requirements: reqs("approved"), details: [{ kind: "kyb", status: "verified" }] }, admin)).toEqual([]);
    expect(clientReviewReasons({ kyc_status: "pending", requirements: reqs("approved"), details: kyb }, admin)).toEqual(["final", "kyb"]);
  });

  it("suspended and rejected dossiers never wait", () => {
    for (const kyc_status of ["suspended", "rejected"]) {
      expect(clientReviewReasons({ kyc_status, requirements: reqs("submitted"), details: [{ kind: "kyb", status: "pending" }] }, admin)).toEqual([]);
    }
  });
});

describe("custody, assets, sales, proposals, vesting", () => {
  it("custody statuses with an admin step (M5: no vault_opened, no legacy approved)", () => {
    expect(["requested", "deposited", "in_delivery"].every(deliveryWaitsForAdmin)).toBe(true);
    expect(["vault_opened", "approved", "delivered", "cancelled", "returned"].some(deliveryWaitsForAdmin)).toBe(false);
    expect(["requested", "deposited"].every(conversionWaitsForAdmin)).toBe(true);
    expect(["vault_opened", "approved", "converted", "in_delivery"].some(conversionWaitsForAdmin)).toBe(false);
  });

  it("an asset is ready only as a Draft of a verified issuer with a share class (M2)", () => {
    expect(assetActivationBlock({ status: 0, shareClassesCount: 1, issuerVerified: true })).toBeNull();
    expect(assetActivationBlock({ status: 0, shareClassesCount: 0, issuerVerified: true })).toBe("noShareClasses");
    expect(assetActivationBlock({ status: 0, shareClassesCount: 3, issuerVerified: false })).toBe("issuerNotVerified");
    expect(assetActivationBlock({ status: 1, shareClassesCount: 3, issuerVerified: true })).toBe("notDraft");
  });

  it("expired open sales and ended proposals", () => {
    const now = 1_800_000_000;
    expect(saleExpiredOpen({ status: 0, endTs: BigInt(now) }, now)).toBe(true);
    expect(saleExpiredOpen({ status: 0, endTs: BigInt(now + 1) }, now)).toBe(false);
    expect(saleExpiredOpen({ status: 0, endTs: BigInt(0) }, now)).toBe(false);
    expect(saleExpiredOpen({ status: 1, endTs: BigInt(now - 10) }, now)).toBe(false);
    expect(proposalAwaitsFinalize({ status: 0, endTs: now - 1 }, now)).toBe(true);
    expect(proposalAwaitsFinalize({ status: 1, endTs: now - 1 }, now)).toBe(false);
    expect(proposalAwaitsFinalize({ status: 0, endTs: 0 }, now)).toBe(false);
  });

  it("vesting review mirrors the page's queue", () => {
    expect(vestingSeriesNeedsReview({ status: "submitted" })).toBe(true);
    expect(vestingSeriesNeedsReview({ status: "approved", approved_terms_hash: null, series_pda: null })).toBe(true);
    expect(vestingSeriesNeedsReview({ status: "approved", approved_terms_hash: "ab", series_pda: null })).toBe(false);
    expect(vestingSeriesNeedsReview({ status: "approved", approved_terms_hash: null, series_pda: "pda" })).toBe(false);
    expect(vestingSeriesNeedsReview({ status: "needs_changes" })).toBe(false);
  });
});

describe("isIndexerStateFresh (one rule for lib/indexer.ts and the badges)", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");
  const row = (patch: Record<string, unknown> = {}) => ({
    status: "ready", completed_at: "2026-09-25T10:00:00.000Z", checked_at: "2026-09-25T11:59:00.000Z", ...patch,
  });

  it("ready, completed and checked within 5 minutes", () => {
    expect(isIndexerStateFresh(row(), now)).toBe(true);
    expect(isIndexerStateFresh(row({ checked_at: "2026-09-25T11:55:00.000Z" }), now)).toBe(true);
    expect(isIndexerStateFresh(row({ checked_at: "2026-09-25T12:00:30.000Z" }), now)).toBe(true);
  });

  it.each([
    ["missing", null],
    ["warming", row({ status: "warming" })],
    ["never completed", row({ completed_at: null })],
    ["stale", row({ checked_at: "2026-09-25T11:54:59.000Z" })],
    ["future", row({ checked_at: "2026-09-25T12:00:31.000Z" })],
    ["garbage", row({ checked_at: "soon" })],
  ])("%s is not fresh", (_label, value) => {
    expect(isIndexerStateFresh(value, now)).toBe(false);
  });
});

// v1.0.0-rc (0079): the Admins and Platform badges over the role-state mirror.
describe("staged role changes (adminGrantBadge, platformChangeBadge)", () => {
  const now = 1_000_000;
  const SA = "SuperAdmin1111111111111111111111";
  const ctx = { superAdmin: SA, pauseFlags: 0x40, nowSec: now };
  const row = (proposedAt: number, eta: number | null, expiresAt: number, extra: Record<string, string> = {}) =>
    ({ proposed_at: proposedAt, eta, expires_at: expiresAt, ...extra });

  it("admins: a grant in its 48 h window counts, a stale live one counts, an executable one waits on the new key, an expired one is gone", () => {
    const badge = adminGrantBadge([
      row(now - 10, now + 100, now + 1_000, { proposed_by: SA }),         // timelock
      row(now - 200, now - 100, now + 1_000, { proposed_by: SA }),        // executable: aside
      row(now - 10, now + 100, now + 1_000, { proposed_by: "Earlier1" }), // stale
      row(now - 999, now - 900, now - 1, { proposed_by: "Earlier1" }),    // expired
    ], ctx);
    expect(badge).toEqual({ count: 2, parts: { timelock: 1, stale: 1 }, aside: { awaitingKey: 1 } });
  });

  it("admins: the open bootstrap window waives the timelock (executable at once), never the expiry; string timestamps work", () => {
    const grant = [row(now - 10, now + 100, now + 1_000, { proposed_by: SA })];
    expect(adminGrantBadge(grant, { ...ctx, pauseFlags: 0xff })).toEqual({ count: 0, parts: { timelock: 0, stale: 0 }, aside: { awaitingKey: 1 } });
    expect(adminGrantBadge([{ proposed_at: String(now - 10), eta: String(now + 100), expires_at: String(now + 1_000), proposed_by: SA }], ctx).count).toBe(1);
    // Super Admin unknown (no Platform mirrored): nothing is called stale.
    expect(adminGrantBadge([row(now - 10, now + 100, now + 1_000, { proposed_by: "Earlier1" })], { ...ctx, superAdmin: null }).parts)
      .toEqual({ timelock: 1, stale: 0 });
  });

  it("platform: a Super Admin rotation in its window and every live recovery count; executable and blocklist rotations wait on the key", () => {
    const badge = platformChangeBadge({
      rotations: [
        row(now - 10, now + 100, now + 1_000, { current_authority: SA }),    // rotation
        row(now - 10, now + 100, now + 1_000, { current_authority: "Old1" }), // dead: the SA moved on
        row(now - 999, now - 998, now - 1, { current_authority: SA }),        // expired
      ],
      recoveries: [row(now - 10, now + 600_000, now + 2_000_000), row(now - 700_000, now - 90_000, now + 10), row(now - 9, now - 8, now - 1)],
      blocklistRotations: [row(now - 10, null, now + 1_209_600), row(now - 10, null, now - 1)],
    }, ctx);
    expect(badge).toEqual({ count: 3, parts: { rotation: 1, recovery: 2 }, aside: { awaitingKey: 1 } });
    // Past its eta the rotation waits on the new Super Admin.
    expect(platformChangeBadge({ rotations: [row(now - 300, now - 100, now + 1_000, { current_authority: SA })], recoveries: [], blocklistRotations: [] }, ctx))
      .toEqual({ count: 0, parts: { rotation: 0, recovery: 0 }, aside: { awaitingKey: 1 } });
  });
});
