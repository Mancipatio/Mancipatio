// Custody vault realization support — the single source of truth for which
// `RealizeAction` values the program can actually execute.
//
// Why: `open_custody_vault` records any of the three actions, but
// `realize_custody_vault` only implements BurnAndAttest. A non-delivery vault
// opened with TransferToBeneficiary or BurnAndPayout can be triggered but
// never realized, reverted (needs Active) or returned (needs DeliveryEscrow)
// — any tokens it holds are stuck. The admin form therefore must not be able
// to create such a vault; the checks below are what the form and its tests
// share.
import { RealizeAction } from "@/lib/generated/asset_registry";

export const REALIZE_ACTION_LABEL: Record<RealizeAction, string> = {
  [RealizeAction.BurnAndAttest]: "Burn & attest",
  [RealizeAction.TransferToBeneficiary]: "Transfer to beneficiary",
  [RealizeAction.BurnAndPayout]: "Burn & payout",
};

/** Actions `realize_custody_vault` implements today. Extend only together
 *  with the program. */
export const SUPPORTED_REALIZE_ACTIONS: readonly RealizeAction[] = [
  RealizeAction.BurnAndAttest,
];

export const UNSUPPORTED_REALIZE_ACTION_REASON =
  "not implemented by realize_custody_vault — a vault opened with it could never be realized, reverted or returned";

export function isSupportedRealizeAction(
  action: unknown,
): action is RealizeAction {
  return (
    typeof action === "number" &&
    (SUPPORTED_REALIZE_ACTIONS as readonly number[]).includes(action)
  );
}

/** Human-readable reason a value cannot be used to open a vault, or null. */
export function unsupportedRealizeActionReason(action: unknown): string | null {
  if (isSupportedRealizeAction(action)) return null;
  const label =
    typeof action === "number" && action in REALIZE_ACTION_LABEL
      ? REALIZE_ACTION_LABEL[action as RealizeAction]
      : `Realize action ${String(action)}`;
  return `${label} is ${UNSUPPORTED_REALIZE_ACTION_REASON}.`;
}

/** Throws before any wallet interaction when the action is unrealizable. */
export function assertSupportedRealizeAction(
  action: unknown,
): asserts action is RealizeAction {
  const reason = unsupportedRealizeActionReason(action);
  if (reason) throw new Error(reason);
}

export type RealizeActionOption = {
  value: RealizeAction;
  label: string;
  disabled: boolean;
  /** Present only when `disabled`. */
  reason: string | null;
};

/** Every program-defined action, with the unsupported ones marked disabled so
 *  the form can show them (and why) without letting anyone pick them. */
export function realizeActionOptions(): RealizeActionOption[] {
  return (
    Object.keys(REALIZE_ACTION_LABEL).map(Number) as RealizeAction[]
  ).map((value) => {
    const reason = unsupportedRealizeActionReason(value);
    return {
      value,
      label: REALIZE_ACTION_LABEL[value],
      disabled: reason !== null,
      reason,
    };
  });
}
