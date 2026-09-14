// lib/custody-realization.ts — the admin custody form must not be able to
// open a vault whose realize action the program cannot execute
// (2026-09-08 end-to-end assessment §2).
import { describe, expect, it } from "vitest";
import { RealizeAction } from "@/lib/generated/asset_registry";
import {
  REALIZE_ACTION_LABEL,
  SUPPORTED_REALIZE_ACTIONS,
  assertSupportedRealizeAction,
  isSupportedRealizeAction,
  realizeActionOptions,
  unsupportedRealizeActionReason,
} from "@/lib/custody-realization";

describe("supported realize actions", () => {
  it("only BurnAndAttest is realizable by the program today", () => {
    expect(SUPPORTED_REALIZE_ACTIONS).toEqual([RealizeAction.BurnAndAttest]);
    expect(isSupportedRealizeAction(RealizeAction.BurnAndAttest)).toBe(true);
    expect(isSupportedRealizeAction(RealizeAction.TransferToBeneficiary)).toBe(
      false,
    );
    expect(isSupportedRealizeAction(RealizeAction.BurnAndPayout)).toBe(false);
  });

  it("rejects values that are not program enum members at all", () => {
    expect(isSupportedRealizeAction(7)).toBe(false);
    expect(isSupportedRealizeAction("0")).toBe(false);
    expect(isSupportedRealizeAction(Number.NaN)).toBe(false);
    expect(isSupportedRealizeAction(undefined)).toBe(false);
  });

  it("explains why an unsupported action cannot open a vault", () => {
    expect(unsupportedRealizeActionReason(RealizeAction.BurnAndAttest)).toBeNull();
    expect(
      unsupportedRealizeActionReason(RealizeAction.TransferToBeneficiary),
    ).toMatch(/^Transfer to beneficiary is not implemented by realize_custody_vault/);
    expect(unsupportedRealizeActionReason(RealizeAction.BurnAndPayout)).toMatch(
      /^Burn & payout is not implemented/,
    );
    expect(unsupportedRealizeActionReason(9)).toMatch(/^Realize action 9 is not implemented/);
  });

  it("assert throws before any wallet interaction for unsupported actions", () => {
    expect(() => assertSupportedRealizeAction(RealizeAction.BurnAndAttest)).not.toThrow();
    expect(() => assertSupportedRealizeAction(RealizeAction.BurnAndPayout)).toThrow(
      /never be realized, reverted or returned/,
    );
    // A `Number(e.target.value)` of a tampered <option> is still caught.
    expect(() => assertSupportedRealizeAction(Number("2"))).toThrow();
  });
});

describe("form options", () => {
  it("lists every program action, disabling the unrealizable ones with a reason", () => {
    const options = realizeActionOptions();
    expect(options.map((o) => o.value)).toEqual([
      RealizeAction.BurnAndAttest,
      RealizeAction.TransferToBeneficiary,
      RealizeAction.BurnAndPayout,
    ]);
    expect(options.map((o) => o.label)).toEqual(
      Object.values(REALIZE_ACTION_LABEL),
    );
    const enabled = options.filter((o) => !o.disabled);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({
      value: RealizeAction.BurnAndAttest,
      reason: null,
    });
    for (const option of options.filter((o) => o.disabled))
      expect(option.reason).toMatch(/not implemented by realize_custody_vault/);
  });
});
