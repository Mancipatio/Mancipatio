// Shared validation for /api/vesting-series/* — the off-chain intake mirror of
// the on-chain create_vesting_series validation (fail fast, same rules).

import { isAddress } from "@solana/kit";
import { MAX_WALLET_VESTING_TRANCHES, U64_MAX } from "@/lib/vesting-terms";
import { SiwsError } from "@/lib/server/siws";

export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const MAX_TRANCHES = MAX_WALLET_VESTING_TRANCHES;
export const MAX_RECIPIENTS = 200;
export const MIN_WINDOW = 3_600;
export const MAX_WINDOW = 7_776_000;

export type ScheduleEntry = { unlock_ts: number; amount: string };
export type RecipientEntry = { wallet: string; allocation: string };

export type ValidatedSeriesForm = {
  tokenMint: string;
  tokenLabel: string;
  timingMode: "auto" | "approval";
  deliveryMode: "push" | "claim";
  approvalWindowSecs: number;
  recoveryEnabled: boolean;
  cancellationEnabled: boolean;
  preCliffBps: number;
  schedule: ScheduleEntry[];
  recipients: RecipientEntry[];
};

function asPositiveIntString(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^\d+$/.test(v)) {
    throw new SiwsError(400, `${field} must be a positive integer string`);
  }
  const n = BigInt(v);
  if (n <= BigInt(0) || n > BigInt("18446744073709551615")) {
    throw new SiwsError(400, `${field} out of u64 range`);
  }
  return n.toString();
}

/** Narrow and validate the full series form from route params. THROWS. */
export function validateSeriesForm(
  params: Record<string, unknown>,
): ValidatedSeriesForm {
  const tokenMint =
    typeof params.token_mint === "string" ? params.token_mint.trim() : "";
  if (!isAddress(tokenMint)) {
    throw new SiwsError(400, "token_mint must be a base58 address");
  }
  const tokenLabel =
    typeof params.token_label === "string" ? params.token_label.trim() : "";
  if (tokenLabel.length > 120) {
    throw new SiwsError(400, "token_label must be at most 120 characters");
  }

  const timingMode = params.timing_mode;
  if (timingMode !== "auto" && timingMode !== "approval") {
    throw new SiwsError(400, "timing_mode must be auto or approval");
  }
  const deliveryMode = params.delivery_mode;
  if (deliveryMode !== "push" && deliveryMode !== "claim") {
    throw new SiwsError(400, "delivery_mode must be push or claim");
  }

  const approvalWindowSecs =
    typeof params.approval_window_secs === "number" &&
    Number.isInteger(params.approval_window_secs)
      ? params.approval_window_secs
      : NaN;
  if (timingMode === "approval") {
    if (
      !(approvalWindowSecs >= MIN_WINDOW && approvalWindowSecs <= MAX_WINDOW)
    ) {
      throw new SiwsError(
        400,
        `approval_window_secs must be between ${MIN_WINDOW} and ${MAX_WINDOW} for an approval series`,
      );
    }
  } else if (approvalWindowSecs !== 0) {
    throw new SiwsError(
      400,
      "approval_window_secs must be 0 for an auto series",
    );
  }

  const preCliffBps =
    typeof params.pre_cliff_bps === "number" &&
    Number.isInteger(params.pre_cliff_bps)
      ? params.pre_cliff_bps
      : NaN;
  if (!(preCliffBps >= 0 && preCliffBps <= 10_000)) {
    throw new SiwsError(400, "pre_cliff_bps must be 0–10000");
  }

  const scheduleRaw = Array.isArray(params.schedule) ? params.schedule : null;
  if (
    !scheduleRaw ||
    scheduleRaw.length === 0 ||
    scheduleRaw.length > MAX_TRANCHES
  ) {
    throw new SiwsError(400, `schedule must have 1–${MAX_TRANCHES} entries`);
  }
  const schedule: ScheduleEntry[] = scheduleRaw.map((e, i) => {
    const o = e as Record<string, unknown>;
    const unlockTs =
      typeof o?.unlock_ts === "number" && Number.isInteger(o.unlock_ts)
        ? o.unlock_ts
        : NaN;
    if (!(unlockTs > 0 && unlockTs <= Number.MAX_SAFE_INTEGER)) {
      throw new SiwsError(
        400,
        `schedule[${i}].unlock_ts must be a positive integer`,
      );
    }
    return {
      unlock_ts: unlockTs,
      amount: asPositiveIntString(o?.amount, `schedule[${i}].amount`),
    };
  });
  for (let i = 1; i < schedule.length; i += 1) {
    if (schedule[i - 1].unlock_ts >= schedule[i].unlock_ts) {
      throw new SiwsError(
        400,
        "schedule unlock times must be strictly ascending",
      );
    }
  }

  const recipientsRaw = Array.isArray(params.recipients)
    ? params.recipients
    : null;
  if (
    !recipientsRaw ||
    recipientsRaw.length === 0 ||
    recipientsRaw.length > MAX_RECIPIENTS
  ) {
    throw new SiwsError(
      400,
      `recipients must have 1–${MAX_RECIPIENTS} entries`,
    );
  }
  const recipients: RecipientEntry[] = recipientsRaw.map((e, i) => {
    const o = e as Record<string, unknown>;
    const wallet = typeof o?.wallet === "string" ? o.wallet.trim() : "";
    if (!isAddress(wallet)) {
      throw new SiwsError(
        400,
        `recipients[${i}].wallet must be a base58 address`,
      );
    }
    return {
      wallet,
      allocation: asPositiveIntString(
        o?.allocation,
        `recipients[${i}].allocation`,
      ),
    };
  });

  // On-chain invariant (checked at release time): the schedule's grand total
  // must equal the sum of allocations — catch a mis-configured series here.
  const scheduleTotal = schedule.reduce(
    (a, t) => a + BigInt(t.amount),
    BigInt(0),
  );
  const allocationTotal = recipients.reduce(
    (a, r) => a + BigInt(r.allocation),
    BigInt(0),
  );
  if (scheduleTotal > U64_MAX || allocationTotal > U64_MAX)
    throw new SiwsError(400, "The total allocation exceeds u64");
  if (scheduleTotal !== allocationTotal) {
    throw new SiwsError(
      400,
      `schedule total (${scheduleTotal.toString()}) must equal the sum of recipient allocations (${allocationTotal.toString()})`,
    );
  }

  return {
    tokenMint,
    tokenLabel,
    timingMode,
    deliveryMode,
    approvalWindowSecs,
    recoveryEnabled: params.recovery_enabled === true,
    cancellationEnabled: params.cancellation_enabled === true,
    preCliffBps,
    schedule,
    recipients,
  };
}
