"use client";

import Link from "next/link";
import { useSolanaClient } from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findAssetPda,
  OfferStatus,
  type Asset,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { findOfferPda } from "@/lib/pdas";
import { SkeletonTable } from "@/components/skeleton";

export default function PublicOtcPage() {
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [assetByMint, setAssetByMint] = useState<
    Map<string, { name: string; assetId: string; classIndex: number }>
  >(new Map());
  // `${shareClass}-${offerId}` → derived Offer PDA, for routing to the taker page.
  const [offerPdaByKey, setOfferPdaByKey] = useState<Map<string, string>>(
    new Map(),
  );

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    async function build() {
      if (!data) return;
      const assetByPda = new Map<string, Asset>();
      for (const a of data.assets) {
        const [pda] = await findAssetPda({
          issuer: a.issuer,
          assetId: a.assetId,
        });
        assetByPda.set(pda.toString(), a);
      }
      const map = new Map<
        string,
        { name: string; assetId: string; classIndex: number }
      >();
      for (const sc of data.shareClasses as ShareClass[]) {
        const a = assetByPda.get(sc.asset.toString());
        if (!a) continue;
        map.set(sc.mint.toString(), {
          name: a.name,
          assetId: a.assetId,
          classIndex: sc.classIndex,
        });
      }
      // Derive each offer's PDA so rows can deep-link to the taker page.
      const pdaMap = new Map<string, string>();
      for (const o of data.offers) {
        const pda = await findOfferPda(o.shareClass, o.offerId);
        pdaMap.set(`${o.shareClass.toString()}-${o.offerId}`, pda.toString());
      }
      if (!cancelled) {
        setAssetByMint(map);
        setOfferPdaByKey(pdaMap);
      }
    }
    void build();
    return () => {
      cancelled = true;
    };
  }, [data]);

  const openOffers = useMemo(() => {
    if (!data) return [];
    return data.offers
      .filter((o) => o.status === OfferStatus.Open)
      .sort((a, b) => Number(b.offerId - a.offerId));
  }, [data]);

  return (
    <section>
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
          OTC
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-mx-ink">
          Open OTC offers
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-mx-ink-soft">
          Buy share-class units from existing holders. Settlement runs through
          the Manci transfer hook with the issuer-set whitelist still
          enforced.
        </p>
      </div>

      {failed ? (
        <p className="mt-8 text-sm text-red-600">Failed to load.</p>
      ) : data === null ? (
        <div className="mt-8">
          <SkeletonTable rows={3} cols={4} />
        </div>
      ) : openOffers.length === 0 ? (
        <Empty />
      ) : (
        <div className="mt-8 overflow-hidden rounded-[3px] border border-mx-rule bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-mx-rule bg-mx-paper text-left text-xs uppercase tracking-wider text-mx-ink-faint">
              <tr>
                <th className="px-4 py-3 font-medium">Offer</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 font-medium">Maker</th>
                <th className="px-4 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mx-rule">
              {openOffers.map((o, i) => {
                const asset = assetByMint.get(o.mint.toString());
                const offerPda = offerPdaByKey.get(
                  `${o.shareClass.toString()}-${o.offerId}`,
                );
                return (
                  <tr key={i} className="text-mx-ink-soft">
                    <td className="px-4 py-3">
                      <p className="font-medium text-mx-ink">
                        {asset?.name ?? "—"}
                      </p>
                      <p className="mt-0.5 text-xs text-mx-ink-faint">
                        offer #{String(o.offerId)} · {asset?.assetId ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {String(o.amount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {String(o.price)}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-mx-ink-faint">
                      {o.maker.toString().slice(0, 6)}…
                      {o.maker.toString().slice(-4)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {offerPda ? (
                        <Link
                          href={`/marketplace/otc/${offerPda}`}
                          className="text-xs text-mx-ink-soft underline-offset-2 hover:underline"
                        >
                          Take →
                        </Link>
                      ) : (
                        <span className="text-xs text-mx-ink-faint">Take →</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Empty() {
  return (
    <div className="mt-8 rounded-[3px] border border-mx-rule bg-white p-12 text-center">
      <p className="text-sm text-mx-ink-soft">No open OTC offers right now.</p>
    </div>
  );
}
