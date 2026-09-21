import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { lookupCompanyKyb, requireVerifiedCompany } from "@/lib/server/kyc-gate";

const wallet = "7xGLjBL7VWYNmBZxmPBv9YJSQd8FywuRyAnGoC9mhjjs";
function sb(client: { id: string; kyc_status: string; kyc_expires_at: string | null } | null, kyb: { status: string } | null, openDocs = 0) {
  return {
    from(table: string) {
      const c: Record<string, unknown> = {};
      const self = () => c;
      Object.assign(c, {
        select: self, eq: self, limit: async () => ({ data: Array.from({ length: openDocs }, (_, i) => ({ id: i })), error: null }),
        order: async () => ({ data: table === "clients" && client ? [client] : [], error: null }),
        maybeSingle: async () => ({ data: kyb, error: null }),
      });
      return c;
    },
  } as never;
}
const verifiedKyc = { id: "c1", kyc_status: "verified", kyc_expires_at: "2099-01-01T00:00:00Z" };

describe("company (KYB) apply gate", () => {
  it("does NOT let an individual KYC approval stand in for KYB", async () => {
    expect(await lookupCompanyKyb(sb(verifiedKyc, null), wallet)).toMatchObject({ kybStatus: "none", eligible: false });
    await expect(requireVerifiedCompany(sb(verifiedKyc, { status: "pending" }), wallet)).rejects.toMatchObject({ status: 403 });
  });

  it("reports documents still owed as more_info", async () => {
    expect(await lookupCompanyKyb(sb(verifiedKyc, { status: "pending" }, 2), wallet)).toMatchObject({ kybStatus: "more_info" });
  });

  it("passes only an approved KYB", async () => {
    await expect(requireVerifiedCompany(sb({ ...verifiedKyc, kyc_status: "more_info" }, { status: "verified" }), wallet)).resolves.toEqual({ clientId: "c1" });
  });

  it("a suspended dossier blocks even an approved KYB", async () => {
    const verdict = await lookupCompanyKyb(sb({ ...verifiedKyc, kyc_status: "suspended" }, { status: "verified" }), wallet);
    expect(verdict).toMatchObject({ kybStatus: "suspended", eligible: false });
  });

  it("no dossier at all is not eligible", async () => {
    expect(await lookupCompanyKyb(sb(null, null), wallet)).toMatchObject({ hasClient: false, eligible: false });
  });
});
