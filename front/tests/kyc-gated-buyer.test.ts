// lansiranje-7, the UI part of a KycGated class: the sale page's buyer gate
// (lib/passport.ts buyerPassportVerdict) refuses a buyer without an
// approved, unexpired passport in an approved jurisdiction, before any
// wallet prompt, and lets one with a passport buy. It mirrors the program's
// receiver_kyc_outcome (util.rs), which stays the authority; an unreadable
// registry fails closed.
import { describe, expect, it } from "vitest";
import { KycStatus } from "@/lib/generated/asset_registry";
import { buyerPassportVerdict } from "@/lib/passport";
import { jurisdictionBitmap } from "@/lib/jurisdiction-bitmap";

const NOW = 1_800_000_000;
const SERBIA = 688;
const GERMANY = 276;
const registry = (approved: number[], blocked: number[] = []) => ({
  exists: true as const,
  data: { approvedJurisdictions: jurisdictionBitmap(approved), blockedJurisdictions: jurisdictionBitmap(blocked) },
});
const passport = (status: KycStatus, expiry: number, jurisdiction = SERBIA) => ({ status, expiry: BigInt(expiry), jurisdiction });

describe("buyerPassportVerdict (the KycGated sale page)", () => {
  it("without a passport the buy is refused", () => {
    expect(buyerPassportVerdict(null, registry([SERBIA]), NOW)).toEqual({
      eligible: false,
      reason: "Your wallet does not have an investor passport on this registry.",
    });
  });

  it("with an approved, unexpired passport in an approved jurisdiction the buy goes on", () => {
    expect(buyerPassportVerdict(passport(KycStatus.Approved, NOW + 60), registry([SERBIA]), NOW)).toEqual({ eligible: true, reason: "" });
  });

  it.each([
    ["pending", passport(KycStatus.Pending, NOW + 60), /pending review/],
    ["revoked", passport(KycStatus.Revoked, NOW + 60), /revoked/],
    ["expired now", passport(KycStatus.Approved, NOW), /expired/],
    ["expiry 0 (always expired)", passport(KycStatus.Approved, 0), /expired/],
    ["an unapproved jurisdiction", passport(KycStatus.Approved, NOW + 60, GERMANY), /is not approved for this sale/],
  ])("refuses a %s passport", (_label, entry, reason) => {
    const verdict = buyerPassportVerdict(entry, registry([SERBIA]), NOW);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(reason);
  });

  it("refuses a blocked jurisdiction even when it is also approved, and fails closed on an unreadable registry", () => {
    expect(buyerPassportVerdict(passport(KycStatus.Approved, NOW + 60), registry([SERBIA], [SERBIA]), NOW).eligible).toBe(false);
    expect(buyerPassportVerdict(passport(KycStatus.Approved, NOW + 60), { exists: false }, NOW)).toEqual({
      eligible: false,
      reason: "Could not read this sale's KYC registry — please try again.",
    });
  });
});
