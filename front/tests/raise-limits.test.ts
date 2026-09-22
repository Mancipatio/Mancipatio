import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { assertWithinCapacity, raiseLimitError, type RaiseCapacity } from "@/lib/server/raise-limits";
import { lookupApplicant, requireVerifiedApplicant } from "@/lib/server/kyc-gate";

const cap = (over: Partial<RaiseCapacity> = {}): RaiseCapacity => ({
  year: 2026, cap: 3_000_000, used: 2_000_000, remaining: 1_000_000, max_equity_percent: 30, cap_source: "platform", ...over,
});

describe("raise limits", () => {
  it("allows an amount within the remaining yearly capacity and max equity", () => {
    expect(() => assertWithinCapacity(cap(), 1_000_000, 30)).not.toThrow();
  });
  it("rejects an amount above the remaining capacity with the remaining figure", () => {
    expect(() => assertWithinCapacity(cap(), 1_050_000, 10)).toThrow(/at most €1,000,000 more in 2026/);
  });
  it("rejects when the yearly limit is used up", () => {
    expect(() => assertWithinCapacity(cap({ used: 3_000_000, remaining: 0 }), 50_000, 10)).toThrow(/reached the €3,000,000 raise limit/);
  });
  it("rejects equity above the configured maximum", () => {
    expect(() => assertWithinCapacity(cap(), 100_000, 31)).toThrow(/at most 30%/);
  });
  it("maps the database trigger errors to friendly messages", () => {
    expect(raiseLimitError({ code: "P0001", message: "RAISE_CAP_EXCEEDED remaining=500000.00 cap=3000000.00" })?.message)
      .toMatch(/€500,000 more/);
    expect(raiseLimitError({ code: "P0001", message: "EQUITY_CAP_EXCEEDED max=25.00" })?.message).toMatch(/25%/);
    expect(raiseLimitError({ code: "23505", message: "dup" })).toBeNull();
  });
});

const wallet = "7xGLjBL7VWYNmBZxmPBv9YJSQd8FywuRyAnGoC9mhjjs";
function sb(client: { id: string; kyc_status: string; kyc_expires_at: string | null } | null, kyb: { status: string } | null) {
  return {
    from(table: string) {
      const c: Record<string, unknown> = {};
      const self = () => c;
      Object.assign(c, {
        select: self, eq: self, limit: async () => ({ data: [], error: null }),
        order: async () => ({ data: table === "clients" && client ? [client] : [], error: null }),
        maybeSingle: async () => ({ data: kyb, error: null }),
      });
      return c;
    },
  } as never;
}
const live = "2099-01-01T00:00:00Z";

describe("applicant gate (/apply)", () => {
  it("a verified individual (live KYC, no KYB) may apply as an individual", async () => {
    const verdict = await lookupApplicant(sb({ id: "c1", kyc_status: "verified", kyc_expires_at: live }, null), wallet);
    expect(verdict).toMatchObject({ eligible: true, applicantKind: "individual" });
    await expect(requireVerifiedApplicant(sb({ id: "c1", kyc_status: "verified", kyc_expires_at: live }, null), wallet))
      .resolves.toEqual({ clientId: "c1", kind: "individual" });
  });
  it("an approved KYB applies as a company even while individual KYC is pending", async () => {
    const verdict = await lookupApplicant(sb({ id: "c1", kyc_status: "pending", kyc_expires_at: null }, { status: "verified" }), wallet);
    expect(verdict).toMatchObject({ eligible: true, applicantKind: "company" });
  });
  it("expired KYC without KYB cannot apply", async () => {
    const verdict = await lookupApplicant(sb({ id: "c1", kyc_status: "verified", kyc_expires_at: "2000-01-01T00:00:00Z" }, null), wallet);
    expect(verdict).toMatchObject({ eligible: false, applicantKind: null, individualKycStatus: "expired" });
  });
  it("unverified wallets are refused", async () => {
    await expect(requireVerifiedApplicant(sb(null, null), wallet)).rejects.toMatchObject({ status: 403 });
  });
});
