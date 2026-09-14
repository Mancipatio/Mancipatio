"use client";
import { useCallback, useEffect, useState } from "react";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { upsertListing } from "@/lib/launchpad";
import { useToast } from "@/lib/toast";
import {
  listSalePublications,
  assertSaleIntentUnsent,
  clearSalePublication,
  SALE_PUBLICATION_EVENT,
  type PendingSalePublication,
} from "@/lib/sale-publication-recovery";
export function SalePublicationRecovery() {
  const client = useSolanaClient(),
    conn = useWalletConnection(),
    toast = useToast(),
    network = detectNetwork(),
    wallet = conn.wallet?.account.address;
  const [items, setItems] = useState<PendingSalePublication[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    try {
      setItems(wallet ? listSalePublications(network, wallet) : []);
      setError(null);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not read sale intents",
      );
    }
  }, [network, wallet]);
  useEffect(() => {
    // Synchronize browser receipts after hydration and changes in another tab.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
    window.addEventListener("storage", reload);
    window.addEventListener(SALE_PUBLICATION_EVENT, reload);
    return () => {
      window.removeEventListener("storage", reload);
      window.removeEventListener(SALE_PUBLICATION_EVENT, reload);
    };
  }, [reload]);
  async function publish(item: PendingSalePublication) {
    if (
      !conn.wallet ||
      item.wallet !== wallet ||
      item.network !== network ||
      busy
    )
      return;
    setBusy(true);
    try {
      await upsertListing(conn.wallet, item.listing);
      clearSalePublication(item);
      toast.show({ kind: "success", title: "Existing sale published" });
    } catch (error) {
      toast.showError(
        "Publication pending",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }
  async function discardUnsent(item: PendingSalePublication) {
    if (item.wallet !== wallet || item.network !== network || busy) return;
    setBusy(true);
    try {
      await assertSaleIntentUnsent(client.runtime.rpc, item);
      clearSalePublication(item);
      toast.show({
        kind: "success",
        title: "Expired unsent sale intent removed",
      });
    } catch (error) {
      toast.showError(
        "Keep this sale intent",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }
  if (error)
    return (
      <p className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        {error}
      </p>
    );
  const scoped = items.filter(
    (item) => item.wallet === wallet && item.network === network,
  );
  if (!scoped.length) return null;
  return (
    <section className="mt-5 space-y-3 rounded-xl border border-brand-200 bg-brand-50 p-4">
      <h2 className="text-sm font-semibold text-brand-900">
        Finish publishing the existing sale
      </h2>
      <p className="text-xs text-brand-800">
        The saved sale address is reused. Publishing sends only a signed API
        request and never opens another on-chain sale.
      </p>
      {scoped.map((item) => (
        <div
          key={item.salePda}
          className="rounded-lg bg-white p-3 text-xs text-slate-700"
        >
          <p className="break-all font-mono">Sale: {item.salePda}</p>
          {item.signature && (
            <a
              href={explorerTxUrl(item.signature, item.network)}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block break-all font-mono underline"
            >
              {item.signature}
            </a>
          )}
          <div className="mt-3 flex gap-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => void publish(item)}
              className="font-semibold text-brand-800 underline"
            >
              Publish existing sale
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void discardUnsent(item)}
              className="text-slate-500 underline"
            >
              Check and remove unsent intent
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
