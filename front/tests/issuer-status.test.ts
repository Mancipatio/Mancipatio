import { describe, expect, it } from "vitest";
import { issuerStatus } from "@/lib/issuer-status";
import { KybStatus } from "@/lib/generated/asset_registry/types/kybStatus";

describe("issuer verification next step", () => {
  it("unlocks preparation only for the verified chain status", () => {
    expect(issuerStatus(KybStatus.Verified)).toMatchObject({ label: "Verified", verified: true });
    for (const status of [KybStatus.Pending, KybStatus.Rejected, KybStatus.Suspended, null, undefined, 99]) {
      expect(issuerStatus(status).verified).toBe(false);
    }
  });

  it("keeps rejected, suspended and pending decisions distinct", () => {
    expect(issuerStatus(KybStatus.Pending)).toMatchObject({ label: "Pending", title: "Company verification is pending" });
    expect(issuerStatus(KybStatus.Rejected)).toMatchObject({ label: "Rejected", title: "Company verification was rejected" });
    expect(issuerStatus(KybStatus.Suspended)).toMatchObject({ label: "Suspended", title: "Issuer access is suspended" });
    expect(issuerStatus(99).label).toBe("Unknown");
  });
});
