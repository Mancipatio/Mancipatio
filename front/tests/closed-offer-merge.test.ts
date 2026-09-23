import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddressDecoder, type Address } from "@solana/kit";

const mocks = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      range: async () => ({ data: mocks.rows, error: null }),
    };
    return { from: () => builder };
  },
}));

import {
  getOfferEncoder,
  OfferStatus,
  type Offer,
} from "@/lib/generated/asset_registry";
import { mergeableArchivedOffers } from "@/lib/closed-account";
import { withClosedOffers } from "@/lib/indexer";
import type { NetworkData } from "@/lib/enumerate";

const key = (n: number) =>
  getAddressDecoder().decode(new Uint8Array(32).fill(n)) as Address;

function offer(offerId: number, status: OfferStatus): Offer {
  return {
    maker: key(1),
    shareClass: key(2),
    mint: key(3),
    escrow: key(4),
    paymentMint: key(5),
    amount: BigInt(8),
    price: BigInt(90),
    status,
    offerId: BigInt(offerId),
    expiresAt: BigInt(0),
    version: 1,
    bump: 255,
    deposited: BigInt(8),
  } as Offer;
}

function archiveRow(o: Offer) {
  return {
    pda: `pda-${o.offerId}`,
    closed_at: "2026-09-23T00:00:00Z",
    row: {
      raw: {
        base64: Buffer.from(getOfferEncoder().encode(o)).toString("base64"),
      },
    },
  };
}

describe("2D archived offers never count as open", () => {
  beforeEach(() => {
    mocks.rows = [];
  });

  it("drops an archived row whose last indexed status is still Open", () => {
    const live = [offer(1, OfferStatus.Open)];
    const archived = [
      offer(1, OfferStatus.Filled), // duplicate of a live row: live wins
      offer(2, OfferStatus.Open), // stale snapshot (crank bundled terminal + reclaim)
      offer(3, OfferStatus.Filled),
      offer(4, OfferStatus.Cancelled),
      offer(5, OfferStatus.Expired),
    ];
    expect(
      mergeableArchivedOffers(live, archived).map((o) => Number(o.offerId)),
    ).toEqual([3, 4, 5]);
  });

  it("withClosedOffers keeps a stale Open archive row off the resell board's open rows", async () => {
    mocks.rows = [
      archiveRow(offer(7, OfferStatus.Open)),
      archiveRow(offer(8, OfferStatus.Filled)),
    ];
    const data = { offers: [offer(9, OfferStatus.Open)] } as unknown as NetworkData;
    const merged = await withClosedOffers(data);
    // Same filter as app/(marketing)/markets/resell/resell-board.tsx.
    const open = merged.offers.filter((o) => o.status === OfferStatus.Open);
    expect(open.map((o) => Number(o.offerId))).toEqual([9]);
    expect(merged.offers.map((o) => Number(o.offerId))).toEqual([9, 8]);
  });
});
