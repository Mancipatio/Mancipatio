"use client";

import Link from "next/link";
import { useSolanaClient } from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findAssetPda,
  type Asset,
  type Offer,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { findOfferPda } from "@/lib/pdas";
import { SkeletonTable } from "@/components/skeleton";
import { detectNetwork } from "@/lib/network";
import { formatPaymentForDisplay } from "@/lib/payment-price";
// The availability rule (Open, funded, unexpired, accepted payment mint) is
// the resell board's; one source for both public lists.
import {
  listedOpenOffer,
  offerHold,
  type OfferHold,
} from "@/app/(marketing)/markets/resell/resell-board";

/** One line for the viewer, in the take page's wording. */
function offerHoldText(
  hold: OfferHold,
  o: Pick<Offer, "amount" | "deposited">,
): string {
  switch (hold) {
    case "expired":
      return "Past its expiry. Anyone can expire it to refund the maker.";
    case "unfunded":
      return `Escrow not funded: ${String(o.deposited)} of ${String(o.amount)} units deposited.`;
    case "payment-token":
      return "Priced in a token Manci does not accept on mainnet.";
  }
}

type HeldOffer = { offer: Offer; hold: OfferHold };

export default function PublicOtcPage() {
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  // "now" captured at load time (render must stay pure) — expiry checks.
  const [nowSec, setNowSec] = useState<bigint>(BigInt(0));
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
      setNowSec(BigInt(Math.floor(Date.now() / 1000)));
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

  // Open offers split into the ones a taker can fill now and the ones held
  // back (unfunded, expired, foreign payment mint), so "Take →" never ends at
  // a dead end. The id order is arbitrary but stable (ids are random).
  const { takeable, held } = useMemo(() => {
    const takeable: Offer[] = [];
    const held: HeldOffer[] = [];
    if (!data) return { takeable, held };
    const network = detectNetwork();
    for (const o of data.offers
      .slice()
      .sort((a, b) => Number(b.offerId - a.offerId))) {
      if (!listedOpenOffer(o)) continue;
      const hold = offerHold(o, nowSec, network);
      if (hold) held.push({ offer: o, hold });
      else takeable.push(o);
    }
    return { takeable, held };
  }, [data, nowSec]);

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
      ) : takeable.length === 0 ? (
        <Empty anyHeld={held.length > 0} />
      ) : (
        <div className="mt-8 overflow-x-auto rounded-[3px] border border-mx-rule bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-mx-rule bg-mx-paper text-left text-xs uppercase tracking-wider text-mx-ink-faint">
              <tr>
                <th className="px-4 py-3 font-medium">Offer</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 font-medium">Maker</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mx-rule">
              {takeable.map((o) => {
                const asset = assetByMint.get(o.mint.toString());
                const key = `${o.shareClass.toString()}-${o.offerId}`;
                const offerPda = offerPdaByKey.get(key);
                return (
                  <tr key={key} className="text-mx-ink-soft">
                    <td className="px-4 py-3">
                      <p className="font-medium text-mx-ink">
                        {asset?.name ?? "—"}
                      </p>
                      <p className="mt-0.5 text-xs text-mx-ink-faint">
                        offer #{String(o.offerId)} · {asset?.assetId ?? "—"}
                      </p>
                      {/* The action sits under the offer, not in a trailing column, so
                          a taker on a phone reaches it without horizontal scrolling. */}
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs empty:hidden">
                        {offerPda ? (
                          <Link
                            href={`/marketplace/otc/${offerPda}`}
                            className="text-mx-ink-soft underline-offset-2 hover:underline"
                          >
                            Take →
                          </Link>
                        ) : (
                          <span className="text-mx-ink-faint">Take →</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {String(o.amount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {formatPaymentForDisplay(o.price, o.paymentMint.toString(), detectNetwork())}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-mx-ink-faint">
                      {o.maker.toString().slice(0, 6)}…
                      {o.maker.toString().slice(-4)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data !== null && !failed && held.length > 0 && (
        <HeldOffers
          rows={held}
          assetByMint={assetByMint}
          offerPdaByKey={offerPdaByKey}
        />
      )}
    </section>
  );
}

/**
 * Open on-chain but not takeable right now, collapsed under the table with
 * the reason per offer. An expired offer links to its page, where anyone can
 * expire it to refund the maker.
 */
function HeldOffers({
  rows,
  assetByMint,
  offerPdaByKey,
}: {
  rows: HeldOffer[];
  assetByMint: Map<string, { name: string; assetId: string }>;
  offerPdaByKey: Map<string, string>;
}) {
  return (
    <details className="mt-4 rounded-[3px] border border-mx-rule bg-white px-4 py-3">
      <summary className="cursor-pointer text-sm text-mx-ink-soft">
        Not takeable right now ({rows.length})
      </summary>
      <ul className="mt-3 divide-y divide-mx-rule text-sm">
        {rows.map(({ offer: o, hold }) => {
          const asset = assetByMint.get(o.mint.toString());
          const key = `${o.shareClass.toString()}-${o.offerId}`;
          const offerPda = offerPdaByKey.get(key);
          return (
            <li
              key={key}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2"
            >
              <div className="min-w-0">
                <p className="font-medium text-mx-ink">{asset?.name ?? "—"}</p>
                <p className="mt-0.5 text-xs text-mx-ink-faint">
                  offer #{String(o.offerId)} · {String(o.amount)} units for{" "}
                  {formatPaymentForDisplay(o.price, o.paymentMint.toString(), detectNetwork())}
                </p>
                <p className="mt-0.5 text-xs text-mx-ink-soft">
                  {offerHoldText(hold, o)}
                </p>
              </div>
              {offerPda && (
                <Link
                  href={`/marketplace/otc/${offerPda}`}
                  className="text-xs text-mx-ink-soft underline-offset-2 hover:underline"
                >
                  {hold === "expired" ? "Expire →" : "View →"}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function Empty({ anyHeld }: { anyHeld: boolean }) {
  return (
    <div className="mt-8 rounded-[3px] border border-mx-rule bg-white p-12 text-center">
      <p className="text-sm text-mx-ink-soft">
        {anyHeld
          ? "No takeable OTC offers right now."
          : "No open OTC offers right now."}
      </p>
    </div>
  );
}
