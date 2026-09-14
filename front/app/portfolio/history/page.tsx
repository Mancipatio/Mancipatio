"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { useWalletConnection } from "@solana/react-hooks";
import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { SkeletonTable } from "@/components/skeleton";

type Event = {
  id: number;
  created_at: string;
  signature: string;
  ix_name: string | null;
  decoded: boolean;
};

export default function PortfolioHistoryPage() {
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;
  const [events, setEvents] = useState<Event[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!wallet) return;
    const sb = getSupabase();
    if (!sb) {
      setFailed("Supabase env not configured.");
      return;
    }
    try {
      // Server-side wallet filter via the `wallets text[]` column + GIN index
      // (migration 0039): the webhook records the accounts each tx touched, so
      // we query `wallets @> {wallet}` directly — no full-payload download, no
      // client-side substring matching, and complete coverage (paginated).
      // Rows written before 0039 lack `wallets` and won't appear (documented).
      const { data, error } = await sb
        .from("indexer_events")
        .select("id, created_at, signature, ix_name, decoded")
        .eq("network", detectNetwork())
        .contains("wallets", [wallet.toString()])
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      setEvents((data ?? []) as Event[]);
      setFailed(null);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    }
  }, [wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  if (!conn.isReady || !wallet) {
    return (
      <main className="min-w-0 flex-1">
        <WalletRequired />
      </main>
    );
  }

  return (
    <main className="min-w-0 flex-1">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Activity
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">
          Transaction history
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          On-chain activity that touched{" "}
          <code className="font-mono text-xs">
            {wallet.toString().slice(0, 6)}…{wallet.toString().slice(-4)}
          </code>
          , newest first.
        </p>
      </div>

      {failed ? (
        <p className="mt-8 text-sm text-red-600">{failed}</p>
      ) : events === null ? (
        <div className="mt-8">
          <SkeletonTable rows={5} cols={3} />
        </div>
      ) : events.length === 0 ? (
        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            No activity for this wallet in the recent event window.
          </p>
          <p className="mt-1 text-xs text-slate-400">
            If you&apos;ve transacted before, older activity may be outside the
            scanned window. Buy, sell or claim something to see it here.
          </p>
          <Link
            href="/marketplace/launchpad"
            className="mt-4 inline-block rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:border-slate-400"
          >
            Browse launchpad →
          </Link>
        </div>
      ) : (
        <div className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Event</th>
                <th className="px-4 py-3 font-medium">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.map((e) => (
                <tr key={e.id} className="text-slate-700">
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-500">
                    {new Date(e.created_at).toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-mono text-xs font-semibold text-slate-900">
                      {e.ix_name ?? "unknown"}
                    </p>
                    {!e.decoded && (
                      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-amber-600">
                        raw
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={explorerTxUrl(e.signature, detectNetwork())}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs text-slate-600 underline-offset-2 hover:underline"
                    >
                      {e.signature.slice(0, 8)}…{e.signature.slice(-6)} ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
