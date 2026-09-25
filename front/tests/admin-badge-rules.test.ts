// lib/admin-badge-rules.ts and lib/indexer-freshness.ts — the pure rules the
// admin menu counts and the matching page filters share.
import { describe, expect, it } from "vitest";
import {
  assetActivationBlock,
  clientReviewReasons,
  conversionWaitsForAdmin,
  deliveryWaitsForAdmin,
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
