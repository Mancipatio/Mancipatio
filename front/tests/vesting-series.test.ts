// Unit tests for lib/vesting-series.ts math — the off-chain mirror of the
// program's util.rs vesting math. Keep both in sync; the Rust side is covered
// by programs/asset_registry/tests/test_vesting_series.rs.

import { describe, expect, it } from "vitest";
import {
  positionClaimable,
  positionEntitlement,
  vestingCumulative,
  vestingDeliverableCumulative,
  VestingDeliveryMode,
  VestingSeriesStatus,
  VestingTimingMode,
  type VestingSeries,
} from "@/lib/vesting-series";

const B = BigInt;

function series(over: Partial<VestingSeries>): VestingSeries {
  return {
    authority: "auth" as VestingSeries["authority"],
    tokenMint: "mint" as VestingSeries["tokenMint"],
    escrow: "escrow" as VestingSeries["escrow"],
    seriesId: B(1),
    totalAllocated: B(400),
    deposited: B(400),
    totalReleased: B(0),
    timingMode: VestingTimingMode.Auto,
    deliveryMode: VestingDeliveryMode.Claim,
    status: VestingSeriesStatus.Active,
    approvalWindowSecs: B(3600),
    recoveryEnabled: false,
    cancellationEnabled: false,
    preCliffBps: 0,
    approvedMask: B(0),
    cancelledAt: B(0),
    finalCumulative: B(0),
    positionsCount: 2,
    createdAt: B(0),
    version: 1,
    bump: 255,
    tranches: [
      { unlockTs: B(1000), amount: B(100) },
      { unlockTs: B(2000), amount: B(300) },
    ],
    ...over,
  } as VestingSeries;
}

describe("vestingCumulative", () => {
  it("sums tranches up to ts", () => {
    const s = series({});
    expect(vestingCumulative(s.tranches, 500)).toBe(B(0));
    expect(vestingCumulative(s.tranches, 1000)).toBe(B(100));
    expect(vestingCumulative(s.tranches, 2500)).toBe(B(400));
  });
});

describe("vestingDeliverableCumulative", () => {
  it("blocks a fully funded Draft even after unlock and with all approval bits set", () => {
    expect(
      vestingDeliverableCumulative(
        series({ status: VestingSeriesStatus.Draft, approvedMask: BigInt(3) }),
        999999,
      ),
    ).toBe(BigInt(0));
  });
  it("blocks release until deposits cover allocations", () => {
    const s = series({ deposited: B(399) });
    expect(vestingDeliverableCumulative(s, 2500)).toBe(B(0));
    expect(
      vestingDeliverableCumulative(series({ deposited: B(400) }), 2500),
    ).toBe(B(400));
  });

  it("auto mode follows the schedule", () => {
    const s = series({});
    expect(vestingDeliverableCumulative(s, 1500)).toBe(B(100));
  });

  it("approval mode requires approval or a lapsed window", () => {
    const s = series({ timingMode: VestingTimingMode.Approval });
    // vested at 1000, unapproved, window (4600) not lapsed
    expect(vestingDeliverableCumulative(s, 1200)).toBe(B(0));
    // window lapsed
    expect(vestingDeliverableCumulative(s, 4600)).toBe(B(100));
    // approved
    expect(
      vestingDeliverableCumulative(
        series({ timingMode: VestingTimingMode.Approval, approvedMask: B(1) }),
        1200,
      ),
    ).toBe(B(100));
  });

  it("cancelled series delivers against final_cumulative regardless of funding", () => {
    const s = series({
      status: VestingSeriesStatus.Cancelled,
      deposited: B(0),
      finalCumulative: B(100),
    });
    expect(vestingDeliverableCumulative(s, 999_999)).toBe(B(100));
  });
});

describe("positionEntitlement / positionClaimable", () => {
  it("computes floored pro-rata shares", () => {
    expect(positionEntitlement(B(100), B(100), B(400))).toBe(B(25));
    expect(positionEntitlement(B(300), B(100), B(400))).toBe(B(75));
    expect(positionEntitlement(B(1), B(1), B(3))).toBe(B(0)); // floor
    expect(positionEntitlement(B(100), B(50), B(0))).toBe(B(0));
  });

  it("claimable is entitlement minus released, never negative", () => {
    const s = series({});
    const pos = {
      discriminator: new Uint8Array(8),
      series: "s" as never,
      index: 0,
      wallet: "w" as never,
      allocation: B(100),
      released: B(25),
      version: 1,
      bump: 255,
    } as const;
    // at 1500: entitlement 25 — already released 25 ⇒ 0
    expect(positionClaimable(s, pos, 1500)).toBe(B(0));
    // at 2500: entitlement 100 — released 25 ⇒ 75
    expect(positionClaimable(s, pos, 2500)).toBe(B(75));
  });
});
