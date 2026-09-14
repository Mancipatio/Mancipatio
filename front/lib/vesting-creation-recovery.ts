"use client";
import { isSignature } from "@solana/kit";
import type { VestingCreationIntent } from "@/lib/vesting-creation";
export type VestingStepReceipt = {
  step: string;
  signature: string;
  lastValidBlockHeight?: string;
};
function key(row: VestingCreationIntent) {
  return `mancipatio:vesting-creation:v1:${row.network}:${row.client_wallet}:${row.id}`;
}
export function readVestingStepReceipts(
  row: VestingCreationIntent,
): VestingStepReceipt[] {
  const raw = window.localStorage.getItem(key(row));
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (r) =>
        !r ||
        typeof r.step !== "string" ||
        !/^(create|finalize|cancel|deposit|positions:\d+:\d+)$/.test(r.step) ||
        !isSignature(r.signature),
    )
  )
    throw new Error(
      "Saved vesting receipts are unreadable. Preserve this browser's storage and reconcile the prepared series before continuing.",
    );
  return parsed;
}
export function saveVestingStepReceipt(
  row: VestingCreationIntent,
  receipt: VestingStepReceipt,
) {
  if (!isSignature(receipt.signature))
    throw new Error("Invalid transaction receipt");
  const receipts = readVestingStepReceipts(row).filter(
    (r) => r.signature !== receipt.signature,
  );
  window.localStorage.setItem(
    key(row),
    JSON.stringify([
      ...receipts,
      {
        step: receipt.step,
        signature: receipt.signature,
        lastValidBlockHeight: receipt.lastValidBlockHeight,
      },
    ]),
  );
}
export function clearVestingStepReceipt(
  row: VestingCreationIntent,
  signature: string,
) {
  const next = readVestingStepReceipts(row).filter(
    (r) => r.signature !== signature,
  );
  if (next.length) window.localStorage.setItem(key(row), JSON.stringify(next));
  else window.localStorage.removeItem(key(row));
}
