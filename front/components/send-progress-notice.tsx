"use client";

import { sendStageLabel, useSendStage } from "@/lib/send-stage";

/** Site-wide progress of the wallet send in progress (mounted once in
 * app/providers, next to WalletSigningNotice). lib/verified-solana-client
 * emits a stage at each step between the click and the wallet sheet
 * (lib/send-stage.ts), so every wallet button says what it is waiting for:
 * the network checks, the wait for the previous transaction, the simulation,
 * the account check (a sign-in message prompt is possible), the wallet, the
 * broadcast. Hides on its own once the send is done or failed. One small
 * line at the top of the screen, where neither the toasts nor the signing
 * notice sit (both at the bottom), under them in the stacking order (z-40),
 * and it never takes a click: pointer-events-none. */
export function SendProgressNotice() {
  const label = sendStageLabel(useSendStage());

  return (
    <div className="pointer-events-none fixed inset-x-4 top-4 z-40 flex justify-center" role="status" aria-live="polite">
      {label && (
        <div
          className="flex max-w-full items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs text-slate-600 shadow-card-lg"
          data-send-progress
        >
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-slate-900" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </div>
      )}
    </div>
  );
}
