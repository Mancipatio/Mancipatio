"use client";

// /issuer/cap-table: the issuer's own assets reconciled with the company
// register, read through /api/cap-table/issuer-read, which checks the
// asset's on-chain issuer authority. Wallets, units and decision references
// only: no holder names, identity data or staff notes reach this page. A
// read: in KYC-only mode the page keeps working under the mode's notice
// (lib/pilot-scope.ts KYC_ONLY_ROUTES), only its tab leaves the menu.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { WalletRequired } from "@/components/wallet-required";
import { SkeletonCard, SkeletonTable } from "@/components/skeleton";
import { CapTableView, StateBadge } from "@/components/cap-table-view";
import { loadAssetOptions, readIssuerCapTable, type AssetOption } from "@/lib/cap-table-client";
import type { AssetReconciliation } from "@/lib/cap-table";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong. Please try again.";
}

export default function IssuerCapTablePage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const wallet = conn.wallet;
  const address = wallet?.account.address.toString() ?? null;
  const [assets, setAssets] = useState<AssetOption[] | null>(null);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [table, setTable] = useState<AssetReconciliation | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    loadAssetOptions(client.runtime.rpc, { authority: address })
      .then((list) => { if (!cancelled) setAssets(list); })
      .catch((err) => { if (!cancelled) setAssetsError(errorText(err)); });
    return () => { cancelled = true; };
  }, [client, address]);

  const load = useCallback(async (assetPda: string) => {
    const request = ++generation.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await readIssuerCapTable(wallet, assetPda);
      if (request === generation.current) setTable(next);
    } catch (err) {
      if (request === generation.current) { setTable(null); setLoadError(errorText(err)); }
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [wallet]);

  if (!wallet) return <main><WalletRequired /></main>;

  return (
    <main className="min-w-0 flex-1">
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Cap table</p>
      <h1 className="mt-1 text-2xl font-semibold text-slate-900">On chain and in the company register</h1>
      <p className="mt-2 max-w-3xl text-sm text-slate-600">
        For each of your assets: the supply on chain, who holds the units (by wallet), the units burned through
        conversions, and the conversions recorded in the company register. Holder names and identity data are not
        shown here.
      </p>

      {assetsError ? (
        <p role="alert" className="mt-8 text-sm text-red-600">Could not load your assets: {assetsError}</p>
      ) : assets === null ? (
        <div className="mt-8"><SkeletonTable rows={2} cols={3} /></div>
      ) : assets.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-slate-900">No asset with issued units yet</p>
          <p className="mt-1 text-xs text-slate-500">
            The cap table lists the assets of the issuer this wallet is the authority of, once a share class has a mint.{" "}
            <Link href="/issuer/assets" className="underline">My assets</Link>
          </p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <label className="block max-w-xl">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Asset</span>
            <select value={selected}
              onChange={(e) => { setSelected(e.target.value); setTable(null); if (e.target.value) void load(e.target.value); }}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none">
              <option value="">Choose an asset</option>
              {assets.map((a) => <option key={a.pda} value={a.pda}>{a.name} · {a.assetId} · {a.symbol}</option>)}
            </select>
          </label>

          {loading && <SkeletonCard rows={6} />}
          {loadError && !loading && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
              {loadError}{" "}
              <button type="button" className="font-medium underline" onClick={() => void load(selected)}>Retry</button>
            </div>
          )}
          {table && !loading && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <StateBadge state={table.state} />
                <p className="text-sm text-slate-700"><span className="font-medium text-slate-900">{table.name}</span> · {table.asset_id}</p>
              </div>
              <CapTableView table={table} audience="issuer" />
            </>
          )}
        </div>
      )}
    </main>
  );
}
