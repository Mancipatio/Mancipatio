import { isAddress } from "@solana/kit";

/** Wallet v0 transactions support this bounded schedule without lookup tables. */
export const MAX_WALLET_VESTING_TRANCHES = 48;
export const MAX_VESTING_RECIPIENTS = 200;
export const U64_MAX = BigInt("18446744073709551615");
export type VestingTerms = {
  network: string;
  client_wallet: string;
  token_mint: string;
  token_label: string;
  timing_mode: "auto" | "approval";
  delivery_mode: "push" | "claim";
  approval_window_secs: number;
  recovery_enabled: boolean;
  cancellation_enabled: boolean;
  pre_cliff_bps: number;
  schedule: { unlock_ts: number; amount: string }[];
  recipients: { wallet: string; allocation: string }[];
};

/** Stable field order and normalized integer strings; recipient ORDER is a PDA index. */
export function canonicalVestingTerms(row: VestingTerms): string {
  return JSON.stringify({
    schema: "mancipatio-vesting-v2",
    network: row.network,
    authority: row.client_wallet,
    mint: row.token_mint,
    label: row.token_label.trim(),
    timing: row.timing_mode,
    delivery: row.delivery_mode,
    approvalWindow: row.approval_window_secs,
    recovery: row.recovery_enabled,
    cancellation: row.cancellation_enabled,
    preCliffBps: row.pre_cliff_bps,
    tranches: row.schedule.map((t) => [
      t.unlock_ts,
      BigInt(t.amount).toString(),
    ]),
    positions: row.recipients.map((r) => [
      r.wallet,
      BigInt(r.allocation).toString(),
    ]),
  });
}
export async function hashVestingTerms(row: VestingTerms): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalVestingTerms(row)),
  );
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function assertSupportedVestingTerms(
  row: VestingTerms,
  now?: number,
): void {
  if (
    (row.timing_mode !== "auto" && row.timing_mode !== "approval") ||
    (row.delivery_mode !== "claim" && row.delivery_mode !== "push")
  )
    throw new Error("Unsupported vesting mode");
  if (
    !Number.isInteger(row.approval_window_secs) ||
    (row.timing_mode === "auto"
      ? row.approval_window_secs !== 0
      : row.approval_window_secs < 3600 || row.approval_window_secs > 7776000)
  )
    throw new Error("Invalid approval window");
  if (
    !Number.isInteger(row.pre_cliff_bps) ||
    row.pre_cliff_bps < 0 ||
    row.pre_cliff_bps > 10000 ||
    typeof row.recovery_enabled !== "boolean" ||
    typeof row.cancellation_enabled !== "boolean"
  )
    throw new Error("Invalid recovery or cancellation terms");
  if (!isAddress(row.client_wallet) || !isAddress(row.token_mint))
    throw new Error("Invalid authority or mint address");
  if (
    row.schedule.length < 1 ||
    row.schedule.length > MAX_WALLET_VESTING_TRANCHES
  )
    throw new Error(
      `This wallet flow supports 1–${MAX_WALLET_VESTING_TRANCHES} tranches`,
    );
  if (
    row.recipients.length < 1 ||
    row.recipients.length > MAX_VESTING_RECIPIENTS
  )
    throw new Error("Unsupported recipient count");
  if (now !== undefined && row.schedule[0].unlock_ts <= now)
    throw new Error(
      "The first unlock has passed. Submit a new schedule for review before creating a series.",
    );
  let previous = 0;
  for (const tranche of row.schedule) {
    if (
      !Number.isSafeInteger(tranche.unlock_ts) ||
      tranche.unlock_ts <= previous
    )
      throw new Error(
        "Unlock times must be positive, safe integers in ascending order",
      );
    previous = tranche.unlock_ts;
    if (
      !/^\d+$/.test(tranche.amount) ||
      BigInt(tranche.amount) <= BigInt(0) ||
      BigInt(tranche.amount) > U64_MAX
    )
      throw new Error("Invalid tranche amount");
  }
  for (const recipient of row.recipients) {
    if (
      !isAddress(recipient.wallet) ||
      !/^\d+$/.test(recipient.allocation) ||
      BigInt(recipient.allocation) <= BigInt(0) ||
      BigInt(recipient.allocation) > U64_MAX
    )
      throw new Error("Invalid recipient allocation");
  }
  const scheduled = row.schedule.reduce(
    (n, t) => n + BigInt(t.amount),
    BigInt(0),
  );
  const allocated = row.recipients.reduce(
    (n, r) => n + BigInt(r.allocation),
    BigInt(0),
  );
  if (scheduled !== allocated || scheduled > U64_MAX)
    throw new Error(
      "Schedule and allocations must have the same positive u64 total",
    );
}

/** Called at the event boundary; the program independently checks its own clock. */
export function assertVestingCreationOpen(row: VestingTerms) {
  assertSupportedVestingTerms(row, Math.floor(Date.now() / 1000));
}
