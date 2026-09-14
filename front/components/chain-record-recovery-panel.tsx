"use client";

import type { PendingChainRecord } from "@/lib/chain-record-recovery";
import { explorerTxUrl } from "@/lib/network";

export function ChainRecordRecoveryPanel({
  receipts,
  busy,
  onRetry,
}: {
  receipts: PendingChainRecord[];
  busy: boolean;
  onRetry: (receipt: PendingChainRecord) => Promise<void>;
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
        {receipts.map((receipt) => (
          <div
            key={`${receipt.entityId}:${receipt.signature}`}
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <div>
              <p className="text-xs">Request {receipt.entityId.slice(0, 8)}</p>
              <a
                href={explorerTxUrl(receipt.signature, receipt.network)}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all font-mono text-xs text-brand-700 underline underline-offset-2"
              >
                {receipt.signature}
              </a>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void onRetry(receipt)}
              className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
            >
              Retry recording
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
