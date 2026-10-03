// How many tokens a distribution may create (lib/distribution-supply): room
// counted from lifetime_minted — a conversion burn never makes room to
// re-issue — minus what Open sales will still mint and what treasury-mint
// reservations still hold; the shortfall is what the treasury lacks.
import { describe, expect, it } from "vitest";
import { getAddressEncoder } from "@solana/kit";
import { getSaleEncoder, RaiseType, SaleStatus } from "@/lib/generated/asset_registry";
import {
  LIFETIME_COUNTER_VERSION,
  allocation,
  creationBlocker,
  remainingFromLifetime,
  roomToCreate,
  sendable,
  shortfall,
  supplyVerdict,
  type SupplyFacts,
} from "@/lib/distribution-supply";
import { SALE_SHARE_CLASS_OFFSET, SALE_STATUS_OFFSET, openSaleRemaining } from "@/lib/distribution-chain";
import { reservedTreasuryUnits, type ReservationRow } from "@/lib/sale-approvals";

const n = (v: number) => BigInt(v);
const facts = (over: Partial<SupplyFacts> = {}): SupplyFacts => ({
  maxSupply: n(5_000),
  lifetimeMinted: n(0),
  version: LIFETIME_COUNTER_VERSION,
  supplyLocked: false,
  mintablePostLaunch: false,
  openSaleRemaining: n(0),
  reservedUnminted: n(0),
  treasuryBalance: n(0),
  ...over,
});

describe("room to create", () => {
  it("is the cap minus everything ever created, on sale and reserved", () => {
    expect(roomToCreate(facts())).toBe(n(5_000));
    expect(roomToCreate(facts({ lifetimeMinted: n(1_000) }))).toBe(n(4_000));
    expect(roomToCreate(facts({ lifetimeMinted: n(1_000), openSaleRemaining: n(500), reservedUnminted: n(200) }))).toBe(n(3_300));
    expect(roomToCreate(facts({ lifetimeMinted: n(5_000) }))).toBe(n(0));
    expect(roomToCreate(facts({ lifetimeMinted: n(4_900), openSaleRemaining: n(500) }))).toBe(n(0));
    expect(roomToCreate(facts({ maxSupply: null }))).toBeNull();
  });

  it("does not grow after a conversion burn (lifetime_minted, not circulating)", () => {
    // 5,000 created, 1,000 converted and burned: circulating 4,000, lifetime 5,000.
    const afterBurn = facts({ lifetimeMinted: n(5_000), treasuryBalance: n(0) });
    expect(roomToCreate(afterBurn)).toBe(n(0));
    expect(supplyVerdict(n(1), afterBurn).problem).toMatch(/^Only 0 more tokens can be created/);
    expect(remainingFromLifetime(n(5_000), n(5_000))).toBe(n(0));
  });

  it("tokens already in the treasury are not subtracted twice", () => {
    // An unfinished run left 300 in the treasury: they are part of lifetime_minted only.
    const f = facts({ lifetimeMinted: n(1_300), treasuryBalance: n(300) });
    expect(roomToCreate(f)).toBe(n(3_700));
    expect(sendable(f)).toBe(n(4_000));
    expect(supplyVerdict(n(4_000), f)).toMatchObject({ shortfall: n(3_700), problem: null });
    expect(supplyVerdict(n(4_001), f).problem).toMatch(/Only 3,700 more tokens can be created/);
  });

  it("refuses creation on a locked supply or a class without the lifetime counter, but not a send from the treasury", () => {
    expect(creationBlocker(facts({ supplyLocked: true }))).toMatch(/locked/);
    expect(creationBlocker(facts({ supplyLocked: true, mintablePostLaunch: true }))).toBeNull();
    expect(creationBlocker(facts({ version: 1 }))).toMatch(/lifetime supply counter/);
    expect(roomToCreate(facts({ version: 1 }))).toBe(n(0));
    const locked = facts({ supplyLocked: true, lifetimeMinted: n(2_000), treasuryBalance: n(500) });
    expect(supplyVerdict(n(500), locked)).toMatchObject({ shortfall: n(0), problem: null });
    expect(supplyVerdict(n(501), locked).problem).toMatch(/^The supply is locked.*treasury holds 500; the list needs 501\.$/);
  });

  it("the shortfall is what the treasury lacks", () => {
    expect(shortfall(n(100), n(40))).toBe(n(60));
    expect(shortfall(n(100), n(400))).toBe(n(0));
  });

  it("the allocation line: in treasury · sent · on sale · not created · cap", () => {
    expect(allocation(facts({ lifetimeMinted: n(1_500), treasuryBalance: n(200), openSaleRemaining: n(300), reservedUnminted: n(100) }))).toEqual({
      inTreasury: n(200),
      out: n(1_300),
      onSale: n(300),
      notCreated: n(3_100),
      cap: n(5_000),
    });
  });
});

describe("what the room subtracts", () => {
  it("Open sales: total minus sold", () => {
    expect(
      openSaleRemaining([
        { address: "a" as never, shareClass: "s" as never, totalForSale: n(1_000), sold: n(250) },
        { address: "b" as never, shareClass: "s" as never, totalForSale: n(10), sold: n(10) },
      ]),
    ).toBe(n(750));
  });

  it("treasury-mint reservations still reserved (not booked, not released, not sales)", () => {
    const row = (over: Partial<ReservationRow>): ReservationRow =>
      ({ id: "r", kind: "treasury_mint", status: "reserved", amount_units: "100", ...over }) as ReservationRow;
    expect(
      reservedTreasuryUnits([
        row({ id: "1" }),
        row({ id: "2", amount_units: 50 }),
        row({ id: "3", status: "booked" }),
        row({ id: "4", status: "released" }),
        row({ id: "5", kind: "sale" }),
        row({ id: "6", amount_units: null }),
      ]),
    ).toBe(n(150));
    // This run's own reservation, once its mint is confirmed (part of lifetime_minted), is left out.
    expect(reservedTreasuryUnits([row({ id: "1" }), row({ id: "2" })], new Set(["2"]))).toBe(n(100));
  });

  it("the Sale filter offsets match the account layout (share class at 8, status at 216)", () => {
    const bytes = getSaleEncoder().encode({
      shareClass: "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC" as never,
      mint: "11111111111111111111111111111111" as never,
      paymentMint: "11111111111111111111111111111111" as never,
      proceeds: "11111111111111111111111111111111" as never,
      authority: "11111111111111111111111111111111" as never,
      saleId: 1, pricePerUnit: 1, totalForSale: 1, sold: 0, startTs: 0, endTs: 0,
      status: SaleStatus.Closed, raiseType: RaiseType.Mature, cliffMonths: 0, vestingMonths: 0, version: 1, bump: 255,
      saleApproval: "11111111111111111111111111111111" as never, applicationHash: new Uint8Array(32),
    });
    expect(bytes[SALE_STATUS_OFFSET]).toBe(SaleStatus.Closed);
    expect(Array.from(bytes.slice(SALE_SHARE_CLASS_OFFSET, SALE_SHARE_CLASS_OFFSET + 32))).toEqual(
      Array.from(getAddressEncoder().encode("HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC" as never)),
    );
    expect(bytes.length).toBe(286);
  });
});
