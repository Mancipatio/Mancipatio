// /admin/otc: an escrow opened on-chain whose request flip did not land (the
// finalized read timed out, or the route refused) is remembered per request,
// so the request offers "Retry flip" instead of a second "Create contract"
// (which would open a SECOND deal). app/admin/otc/unsynced-deals.ts.
import { describe, expect, it } from "vitest";
import {
  parseUnsyncedDeals,
  pendingUnsyncedDeal,
  serializeUnsyncedDeals,
  type UnsyncedDeal,
} from "@/app/admin/otc/unsynced-deals";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const DEAL: UnsyncedDeal = {
  dealPda: "Dea1Pda111111111111111111111111111111111111",
  dealId: "1790000000000",
  sig: "5igSig",
  expiresAt: new Date(NOW + 7 * 86_400_000).toISOString(),
};
const open = () => true;

describe("unsynced OTC deals", () => {
  it("round-trips through storage, keyed by request id", () => {
    const raw = serializeUnsyncedDeals(new Map([["req-1", DEAL]]));
    expect(parseUnsyncedDeals(raw, NOW)).toEqual(new Map([["req-1", DEAL]]));
    expect(serializeUnsyncedDeals(new Map())).toBeNull();
  });

  it("drops malformed and expired entries, and survives corrupt storage", () => {
    const raw = JSON.stringify([
      ["req-1", DEAL],
      ["req-2", { ...DEAL, expiresAt: new Date(NOW - 1).toISOString() }],
      ["req-3", { ...DEAL, dealId: "12abc" }],
      ["req-4", { dealPda: DEAL.dealPda }],
      ["", DEAL],
      "junk",
    ]);
    expect([...parseUnsyncedDeals(raw, NOW).keys()]).toEqual(["req-1"]);
    expect(parseUnsyncedDeals("{not json", NOW).size).toBe(0);
    expect(parseUnsyncedDeals(null, NOW).size).toBe(0);
  });

  it("is pending only for its own request, while that request is still requested and its deal still Open", () => {
    const map = new Map([["req-1", DEAL]]);
    expect(pendingUnsyncedDeal(map, { id: "req-1", status: "requested" }, open)).toEqual(DEAL);
    expect(pendingUnsyncedDeal(map, { id: "req-2", status: "requested" }, open)).toBeNull();
    // Flipped (elsewhere) or declined: nothing left to retry.
    expect(pendingUnsyncedDeal(map, { id: "req-1", status: "created" }, open)).toBeNull();
    expect(pendingUnsyncedDeal(map, { id: "req-1", status: "cancelled" }, open)).toBeNull();
    // The deal was cancelled, expired or settled on-chain: "Create contract" is offered again.
    expect(pendingUnsyncedDeal(map, { id: "req-1", status: "requested" }, () => false)).toBeNull();
    // Not listed yet (a lagging read): still pending, so no second contract.
    expect(pendingUnsyncedDeal(map, { id: "req-1", status: "requested" }, () => null)).toEqual(DEAL);
  });
});
