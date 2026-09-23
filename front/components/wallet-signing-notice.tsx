"use client";

import { useEffect, useState } from "react";
import { onSigningEvent, preferOffchainEnvelope, type SigningTarget } from "@/lib/siws-signing";

type Notice = { kind: "retry" | "offer" | "enabled"; target: SigningTarget };

const DURATION_MS: Record<Notice["kind"], number> = { retry: 30_000, offer: 45_000, enabled: 12_000 };

/** Site-wide hardware-wallet signing notices (mounted once in app/providers).
 * lib/siws-signing.ts emits the events from every signed request, so account,
 * ToS, /apply, the per-send wallet check and every other screen get them:
 *   - "retry": explains the second wallet prompt (our off-chain envelope);
 *   - "offer": after a wallet failure auto-detection could not classify,
 *     offers hardware-wallet signing by hand (Ledger behind Phantom/Solflare). */
export function WalletSigningNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => onSigningEvent((event) => {
    setNotice({ kind: event.type === "envelope-retry" ? "retry" : "offer", target: event.target });
  }), []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), DURATION_MS[notice.kind]);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <div
      className="pointer-events-none fixed bottom-6 left-6 z-50 w-96 max-w-[calc(100vw-2rem)]"
      role="status"
      aria-live="polite"
    >
      {notice && (
        <div className="pointer-events-auto rounded-lg border border-slate-200 bg-white px-4 py-3 text-slate-900 shadow-card-lg">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              {notice.kind === "retry" && (
                <>
                  <p className="text-sm font-semibold">Approve once more</p>
                  <p className="mt-0.5 text-xs text-slate-600">
                    Your wallet could not sign the plain message, so Manci is asking again as a Solana
                    off-chain message, the format a Ledger shows on its screen. Check that the device shows
                    the request starting with mancipatio:v2 and this site&apos;s address before you approve.
                  </p>
                </>
              )}
              {notice.kind === "offer" && (
                <>
                  <p className="text-sm font-semibold">Signing with a Ledger?</p>
                  <p className="mt-0.5 text-xs text-slate-600">
                    If this wallet uses a Ledger through Phantom or Solflare, switch it to hardware-wallet
                    signing and try the action again. The Ledger will then show the full request.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      preferOffchainEnvelope(notice.target);
                      setNotice({ kind: "enabled", target: notice.target });
                    }}
                    className="mt-2 rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    Use hardware-wallet signing
                  </button>
                </>
              )}
              {notice.kind === "enabled" && (
                <>
                  <p className="text-sm font-semibold">Hardware-wallet signing is on</p>
                  <p className="mt-0.5 text-xs text-slate-600">
                    Try the action again. If this wallet cannot sign that way, Manci switches it back to
                    standard signing automatically.
                  </p>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="shrink-0 text-xs opacity-50 hover:opacity-100"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
