"use client";

import type { ChainRecordState, PendingChainRecord } from "@/lib/chain-record-recovery";
import { explorerTxUrl } from "@/lib/network";

/** What the network says about a receipt's transaction, in the holder's words. */
function stateNote(state: ChainRecordState | undefined): { text: string; tone: "dead" | "wait" } | null {
  switch (state) {
    case "failed":
      return { text: "Failed on the network — nothing moved.", tone: "dead" };
    case "did_not_land":
      return { text: "Not found on the network 24 hours after sending; it can no longer land — nothing moved.", tone: "dead" };
    case "pending":
      return { text: "Waiting for the network to finalize…", tone: "wait" };
    default:
      return null;
  }
}

export function ChainRecordRecoveryPanel({
  receipts,
  busy,
  onRetry,
  states,
  onDiscard,
}: {
  receipts: PendingChainRecord[];
  busy: boolean;
  onRetry: (receipt: PendingChainRecord) => Promise<void>;
  /** Per signature (lib/use-chain-record-recovery `states`); without it every receipt only offers Retry. */
  states?: ReadonlyMap<string, ChainRecordState>;
  /** Removes a receipt whose transaction failed or can no longer land (the hook re-reads the network first). */
  onDiscard?: (receipt: PendingChainRecord) => Promise<void>;
}) {
  if (!receipts.length) return null;
  return (
    <section className="mt-6 rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm text-slate-700">
      <h2 className="font-semibold text-slate-900">
        Transactions awaiting recording
      </h2>
      <p className="mt-1 text-xs leading-relaxed">
        These transactions were sent. Retry recording their receipts to update
        your requests. This action does not send funds again.
      </p>
      <div className="mt-3 space-y-3">
        {receipts.map((receipt) => {
          const note = stateNote(states?.get(receipt.signature));
          const dead = note?.tone === "dead";
          return (
            <div
              key={`${receipt.entityId}:${receipt.signature}`}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="text-xs">Request {receipt.entityId.slice(0, 8)}</p>
                <a
                  href={explorerTxUrl(receipt.signature, receipt.network)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all font-mono text-xs text-brand-700 underline underline-offset-2"
                >
                  {receipt.signature}
                </a>
                {note && (
                  <p
                    role={dead ? "alert" : "status"}
                    className={`mt-1 text-xs ${dead ? "text-red-700" : "text-slate-600"}`}
                  >
                    {note.text}
                  </p>
                )}
              </div>
              {dead && onDiscard ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onDiscard(receipt)}
                  className="min-h-9 rounded-lg border border-red-300 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  Discard and try again
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy || note?.tone === "wait"}
                  onClick={() => void onRetry(receipt)}
                  className="min-h-9 rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
                >
                  Retry recording
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
