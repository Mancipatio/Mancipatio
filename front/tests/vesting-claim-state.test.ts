// Regression tests for F04: claim-state derivation over a moving clock and
// per-series read errors that must surface instead of dropping the position.
import { describe, expect, it } from "vitest";
import { address, getBase58Decoder, type Address } from "@solana/kit";
import {
  VestingDeliveryMode,
  VestingSeriesStatus,
  VestingTimingMode,
  type VestingPosition,
  type VestingSeries,
} from "@/lib/generated/asset_registry";
import {
  deriveClaimState,
  formatCountdown,
  hasTranchePendingApproval,
  loadPositionEntries,
} from "@/lib/vesting-claim-state";
import type { LoadedPosition } from "@/lib/vesting-series";

const key = (n: number) =>
  address(getBase58Decoder().decode(new Uint8Array(32).fill(n)));

const T0 = 1_800_000_000;

function series(over: Partial<VestingSeries> = {}): VestingSeries {
  return {
    status: VestingSeriesStatus.Active,
    timingMode: VestingTimingMode.Auto,
    deliveryMode: VestingDeliveryMode.Claim,
    totalAllocated: BigInt(1_000),
    deposited: BigInt(1_000),
    finalCumulative: BigInt(0),
    approvedMask: BigInt(0),
    approvalWindowSecs: BigInt(3_600),
    tranches: [
      { unlockTs: BigInt(T0 + 100), amount: BigInt(400) },
      { unlockTs: BigInt(T0 + 200), amount: BigInt(600) },
    ],
    tokenMint: key(9),
    escrow: key(8),
    ...over,
  } as unknown as VestingSeries;
}

function position(over: Partial<VestingPosition> = {}): VestingPosition {
  return {
    allocation: BigInt(500),
    released: BigInt(0),
    series: key(7),
    index: 0,
    ...over,
  } as unknown as VestingPosition;
}

describe("deriveClaimState", () => {
  it("flips from locked (with countdown) to claimable as the clock passes the unlock", () => {
    const s = series();
    const p = position();
    const before = deriveClaimState(s, p, T0 + 99);
    expect(before.status).toBe("locked");
    expect(before.claimable).toBe(BigInt(0));
    expect(before.nextUnlockTs).toBe(T0 + 100);
    expect(before.secondsToNextUnlock).toBe(1);

    const at = deriveClaimState(s, p, T0 + 100);
    expect(at.status).toBe("claimable");
    expect(at.claimable).toBe(BigInt(200)); // 500 * 400 / 1000
    expect(at.nextUnlockTs).toBe(T0 + 200);
    expect(at.secondsToNextUnlock).toBe(100);

    const all = deriveClaimState(s, p, T0 + 200);
    expect(all.claimable).toBe(BigInt(500));
    expect(all.nextUnlockTs).toBeNull();
    expect(all.secondsToNextUnlock).toBeNull();
  });

  it("reports done when everything is released and draft/unfunded before that", () => {
    expect(
      deriveClaimState(series(), position({ released: BigInt(500) }), T0 + 999)
        .status,
    ).toBe("done");
    expect(
      deriveClaimState(
        series({ status: VestingSeriesStatus.Draft }),
        position(),
        T0 + 999,
      ).status,
    ).toBe("draft");
    expect(
      deriveClaimState(series({ deposited: BigInt(999) }), position(), T0 + 999)
        .status,
    ).toBe("unfunded");
  });

  it("distinguishes an unlocked-but-unapproved tranche from a locked one", () => {
    const s = series({ timingMode: VestingTimingMode.Approval });
    expect(deriveClaimState(s, position(), T0 + 50).status).toBe("locked");
    const waiting = deriveClaimState(s, position(), T0 + 150);
    expect(waiting.status).toBe("awaiting_approval");
    expect(waiting.claimable).toBe(BigInt(0));
    // Window lapses → deliverable without approval.
    expect(deriveClaimState(s, position(), T0 + 100 + 3_600).status).toBe(
      "claimable",
    );
  });

  it("reports locked, not awaiting_approval, once the unlocked tranche is approved and claimed", () => {
    // Approval mode, tranche 1 approved (bit 0) and fully claimed, tranche 2
    // still in the future — the common state after the first claim.
    const s = series({
      timingMode: VestingTimingMode.Approval,
      approvedMask: BigInt(1),
    });
    const p = position({ released: BigInt(200) }); // 500 * 400 / 1000
    const st = deriveClaimState(s, p, T0 + 150);
    expect(st.status).toBe("locked");
    expect(st.claimable).toBe(BigInt(0));
    expect(st.nextUnlockTs).toBe(T0 + 200);
    expect(st.secondsToNextUnlock).toBe(50);
    expect(hasTranchePendingApproval(s, T0 + 150)).toBe(false);

    // Approved but not yet claimed → claimable (not awaiting).
    expect(deriveClaimState(s, position(), T0 + 150).status).toBe("claimable");

    // Tranche 2 unlocks unapproved → awaiting again, with no further unlock.
    const second = deriveClaimState(s, p, T0 + 250);
    expect(second.status).toBe("awaiting_approval");
    expect(second.nextUnlockTs).toBeNull();
    expect(hasTranchePendingApproval(s, T0 + 250)).toBe(true);

    // Both approved and claimed → done.
    expect(
      deriveClaimState(
        series({
          timingMode: VestingTimingMode.Approval,
          approvedMask: BigInt(3),
        }),
        position({ released: BigInt(500) }),
        T0 + 250,
      ).status,
    ).toBe("done");
  });

  it("does not count a lapsed-window tranche as pending approval", () => {
    // Tranche 1 window lapsed (deliverable without approval) and claimed;
    // tranche 2 still locked → locked with countdown, not awaiting.
    const s = series({
      timingMode: VestingTimingMode.Approval,
      approvalWindowSecs: BigInt(10),
    });
    const p = position({ released: BigInt(200) });
    const st = deriveClaimState(s, p, T0 + 150);
    expect(st.status).toBe("locked");
    expect(st.nextUnlockTs).toBe(T0 + 200);
    expect(hasTranchePendingApproval(s, T0 + 150)).toBe(false);
    // Auto mode never reports pending approval.
    expect(hasTranchePendingApproval(series(), T0 + 150)).toBe(false);
  });

  it("keeps the vested share claimable after cancellation", () => {
    const s = series({
      status: VestingSeriesStatus.Cancelled,
      finalCumulative: BigInt(400),
    });
    const st = deriveClaimState(s, position(), T0 + 999);
    expect(st.status).toBe("claimable");
    expect(st.claimable).toBe(BigInt(200));
    expect(
      deriveClaimState(s, position({ released: BigInt(200) }), T0 + 999).status,
    ).toBe("cancelled");
  });

  it("push delivery is reflected in the state", () => {
    expect(
      deriveClaimState(
        series({ deliveryMode: VestingDeliveryMode.Push }),
        position(),
        T0,
      ).push,
    ).toBe(true);
  });
});

describe("formatCountdown", () => {
  it("renders h:m:s and days", () => {
    expect(formatCountdown(0)).toBe("00:00:00");
    expect(formatCountdown(59)).toBe("00:00:59");
    expect(formatCountdown(3_661)).toBe("01:01:01");
    expect(formatCountdown(86_400 + 5)).toBe("1d 00:00:05");
    expect(formatCountdown(-10)).toBe("00:00:00");
  });
});

describe("loadPositionEntries", () => {
  const rpc = {} as Parameters<typeof loadPositionEntries>[0];
  const wallet = key(1) as Address;
  const posA: LoadedPosition = {
    pda: key(11),
    account: position({ series: key(21) }),
  };
  const posB: LoadedPosition = {
    pda: key(12),
    account: position({ series: key(22), index: 1 }),
  };
  const posC: LoadedPosition = {
    pda: key(13),
    account: position({ series: key(23), index: 2 }),
  };

  it("keeps a failed or missing series read as an explicit error entry", async () => {
    const good = series();
    const entries = await loadPositionEntries(rpc, wallet, {
      positions: async () => [posA, posB, posC],
      series: async (_rpc, pda) => {
        if (pda === key(21).toString()) return good;
        if (pda === key(22).toString()) throw new Error("RPC 429 rate limited");
        return null; // account gone
      },
    });
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ kind: "ok", position: posA, series: good });
    expect(entries[1]).toMatchObject({
      kind: "error",
      position: posB,
      seriesPda: key(22).toString(),
      error: "RPC 429 rate limited",
    });
    expect(entries[2]).toMatchObject({
      kind: "error",
      position: posC,
      error: "Series account not found on this network.",
    });
  });

  it("propagates a positions read failure to the caller", async () => {
    await expect(
      loadPositionEntries(rpc, wallet, {
        positions: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
  });
});
