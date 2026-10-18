"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { SkeletonTable } from "@/components/skeleton";
import { Kpi } from "@/components/kpi";
import { assetClassOffered } from "@/lib/pilot-scope";
import { ASSET_TYPES, slugForEnum } from "@/lib/asset-types";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer, withClosedOffers } from "@/lib/indexer";
import {
  findAssetPda,
  OfferStatus,
  type Asset,
  type Offer,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { findOfferPda } from "@/lib/pdas";
import { isOfferFunded } from "@/lib/escrow-ledger";
import { isAllowedPaymentMint } from "@/lib/payment-mints";
import { listResellListings, type ResellListing } from "@/lib/resell";
import {
  createOtcRequest,
  listOtcRequestsByWallet,
  type OtcRequest,
} from "@/lib/otc";
import { useToast } from "@/lib/toast";
import {
  detectNetwork,
  isTestNetwork,
  networkLabel,
  type Network,
} from "@/lib/network";
import { formatPaymentForDisplay, resellAskNote } from "@/lib/payment-price";
import {
  PaymentMintPicker,
  PaymentPriceField,
  TradeConfirmation,
  usePaymentPriceForm,
} from "@/components/payment-price-fields";

type Row = {
  offer: Offer;
  asset?: Asset;
  shareClass?: ShareClass;
};

// ── Offer availability ───────────────────────────────────────────────────────
// Pure, no RPC. Shared with the public list (app/marketplace/otc/page.tsx),
// which imports it from here because a page module exports only its page;
// the natural home is lib/offer-availability.ts. A snapshot only: the take
// page and the program re-check at take time.

/** Why an Open offer cannot be taken right now. */
export type OfferHold = "expired" | "unfunded" | "payment-token";

/** An offer the public lists show at all: Open with a non-zero amount. */
export function listedOpenOffer(o: Pick<Offer, "status" | "amount">): boolean {
  return o.status === OfferStatus.Open && o.amount > BigInt(0);
}

/**
 * The reason an Open offer cannot be taken, or null when it can, in the take
 * page's order (app/marketplace/otc/[offer]/page.tsx, take_offer.rs): past
 * its expiry (an expiry equal to `now` can still be taken), the deposit
 * ledger below the amount, a payment mint the network does not accept (on
 * mainnet the allowlist; every other network accepts any mint). It does not
 * check the viewer's wallet (KYC-gated class, balance, blocklist, the
 * secondary-trading pause), the same caveat as lib/market-overview.ts.
 */
export function offerHold(
  o: Pick<Offer, "expiresAt" | "amount" | "deposited" | "paymentMint">,
  nowSec: bigint,
  network: Network,
): OfferHold | null {
  if (o.expiresAt !== BigInt(0) && nowSec > o.expiresAt) return "expired";
  if (!isOfferFunded(o.amount, o.deposited)) return "unfunded";
  if (!isAllowedPaymentMint(network, o.paymentMint.toString())) return "payment-token";
  return null;
}

export function ResellBoard() {
  const sp = useSearchParams();
  const requestedType = sp.get("type") ?? "";
  const initialType = assetClassOffered(requestedType) ? requestedType : "";

  const client = useSolanaClient();
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address?.toString();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [pdaMap, setPdaMap] = useState<Map<string, Asset>>(new Map());
  const [scByMint, setScByMint] = useState<Map<string, ShareClass>>(new Map());
  // `${mint}-${offerId}` → offer PDA, so each open offer deep-links to its own
  // take page (/marketplace/otc/<pda>) instead of the generic list.
  const [offerPdaByKey, setOfferPdaByKey] = useState<Map<string, string>>(
    new Map(),
  );
  const [typeFilter, setTypeFilter] = useState<string>(initialType);
  const [posts, setPosts] = useState<ResellListing[] | null>(null);
  const [myOtcRequests, setMyOtcRequests] = useState<OtcRequest[]>([]);
  const [requestFor, setRequestFor] = useState<ResellListing | null>(null);
  // "now" captured at load time (render must stay pure) — expiry checks.
  const [nowSec, setNowSec] = useState<bigint>(BigInt(0));

  // OTC escrow requests the connected wallet is already a party to — used to
  // grey out repeat requests for the same seller+mint pair.
  useEffect(() => {
    let cancelled = false;
    async function loadMine() {
      if (!wallet) {
        setMyOtcRequests([]);
        return;
      }
      setMyOtcRequests([]);
      try {
        const rows = await listOtcRequestsByWallet(conn.wallet);
        if (!cancelled) setMyOtcRequests(rows);
      } catch (err) { console.warn("Private OTC requests unavailable", err); }
    }
    void loadMine();
    return () => {
      cancelled = true;
    };
  }, [wallet, conn.wallet]);

  const requestedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const r of myOtcRequests) {
      // Only block on the genuinely-pending 'requested' state. A 'created' row
      // means the on-chain deal already exists (managed on /portfolio/deals) —
      // and since otc_requests are never reconciled to completed/expired, a
      // 'created' row would otherwise block repeat requests for that seller:mint
      // pair forever after the deal settled or expired.
      if (r.status !== "requested") continue;
      set.add(`${r.seller_wallet}:${r.mint}`);
    }
    return set;
  }, [myOtcRequests]);

  const onOtcRequested = useCallback((r: OtcRequest) => {
    setMyOtcRequests((prev) => [r, ...prev]);
    setRequestFor(null);
  }, []);

  // Holder posts (off-chain classifieds). The ?type= filter is applied by
  // deriving each post's asset type on-chain: asset_pda -> Asset when known,
  // otherwise mint -> ShareClass -> Asset.
  useEffect(() => {
    let cancelled = false;
    async function loadPosts() {
      try { const rows = await listResellListings({ status: "active" });
        if (!cancelled) setPosts(rows);
      } catch { if (!cancelled) setFailed(true); }
    }
    void loadPosts();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const network = await withClosedOffers(await loadNetworkPreferIndexer(() =>
          loadNetwork(client.runtime.rpc),
        ));
        if (cancelled) return;
        const am = new Map<string, Asset>();
        for (const a of network.assets) {
          const [pda] = await findAssetPda({
            issuer: a.issuer,
            assetId: a.assetId,
          });
          am.set(pda.toString(), a);
        }
        const scm = new Map<string, ShareClass>();
        for (const sc of network.shareClasses) {
          scm.set(sc.mint.toString(), sc);
        }
        if (!cancelled) {
          setNowSec(BigInt(Math.floor(Date.now() / 1000)));
          setData(network);
          setPdaMap(am);
          setScByMint(scm);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Only offers a taker can fill now: Open, funded, unexpired and priced in
  // a token this network accepts (offerHold). The rest are counted below.
  const rows: Row[] = useMemo(() => {
    if (!data) return [];
    const network = detectNetwork();
    return data.offers
      .filter((o) => listedOpenOffer(o) && offerHold(o, nowSec, network) === null)
      .map((offer) => {
        const sc = scByMint.get(offer.mint.toString());
        const asset = sc ? pdaMap.get(sc.asset.toString()) : undefined;
        return { offer, asset, shareClass: sc };
      })
      .filter((r) => {
        if (!typeFilter) return true;
        const slug = slugForEnum(r.asset?.assetType);
        return slug === typeFilter;
      })
      .sort((a, b) => Number(b.offer.offerId - a.offer.offerId));
  }, [data, pdaMap, scByMint, typeFilter, nowSec]);

  // Derive each visible offer's PDA (async) for deep-linking to its take page.
  useEffect(() => {
    let cancelled = false;
    async function derive() {
      const entries: Array<[string, string]> = [];
      await Promise.all(
        rows.map(async (r) => {
          try {
            const pda = await findOfferPda(r.offer.shareClass, r.offer.offerId);
            entries.push([
              `${r.offer.mint.toString()}-${String(r.offer.offerId)}`,
              pda.toString(),
            ]);
          } catch {
            /* skip — falls back to the generic list link */
          }
        }),
      );
      if (!cancelled) setOfferPdaByKey(new Map(entries));
    }
    void derive();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const totals = useMemo(() => {
    if (!data) return null;
    const network = detectNetwork();
    const listed = data.offers.filter(listedOpenOffer);
    // The overview's "Funded OTC offers": takeable now.
    const funded = listed.filter((o) => offerHold(o, nowSec, network) === null).length;
    const filled = data.offers.filter(
      (o) => o.status === OfferStatus.Filled,
    ).length;
    // Open on-chain but not takeable (unfunded, expired, foreign payment mint).
    return { funded, heldBack: listed.length - funded, filled };
  }, [data, nowSec]);

  const filteredPosts = useMemo(() => {
    if (!posts) return null;
    if (!typeFilter) return posts;
    return posts.filter(
      (p) =>
        slugForEnum(assetForPost(p, pdaMap, scByMint)?.assetType) ===
        typeFilter,
    );
  }, [posts, pdaMap, scByMint, typeFilter]);

  if (failed) {
    return (
      <p className="text-sm text-red-600">
        Could not load market data. The network or listings service is unavailable; refresh to retry.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {totals && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Kpi label="Funded offers" value={String(totals.funded)} />
          <Kpi label="Filled (lifetime)" value={String(totals.filled)} />
          <Kpi
            label="Active asset types"
            value={String(activeTypeCount(rows))}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-[12px] text-slate-500">
          Type
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="ml-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] focus:border-slate-400 focus:outline-none"
          >
            <option value="">All</option>
            {ASSET_TYPES.filter((type) => assetClassOffered(type.slug)).map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        {typeFilter && (
          <button
            type="button"
            onClick={() => setTypeFilter("")}
            className="text-[12px] text-brand-700 hover:underline"
          >
            Clear filter
          </button>
        )}
      </div>

      {data === null ? (
        <SkeletonTable rows={4} cols={6} />
      ) : rows.length === 0 ? (
        <EmptyState typeFilter={typeFilter} heldBack={totals?.heldBack ?? 0} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">#</th>
                <th className="px-4 py-3 font-medium">Asset</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 text-right font-medium">Unit</th>
                <th className="px-4 py-3 font-medium">Maker</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                // Human units for the network's USDC, exact base units otherwise.
                const unitPrice =
                  r.offer.amount > BigInt(0)
                    ? formatPaymentForDisplay(r.offer.price / r.offer.amount, r.offer.paymentMint.toString(), detectNetwork())
                    : "—";
                const slug = slugForEnum(r.asset?.assetType);
                const typeRecord = ASSET_TYPES.find((t) => t.slug === slug);
                return (
                  <tr
                    key={`${r.offer.mint.toString()}-${String(r.offer.offerId)}`}
                    className="hover:bg-slate-50"
                  >
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-500">
                      #{String(r.offer.offerId)}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-[13px] font-medium text-slate-900">
                        {r.asset?.name ?? "(unknown)"}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {typeRecord?.code ?? "—"}
                      </p>
                      {/* The action sits under the asset, not in a trailing column, so
                          a reader on a phone reaches it without horizontal scrolling. */}
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs empty:hidden">
                        <Link
                          href={
                            offerPdaByKey.get(
                              `${r.offer.mint.toString()}-${String(r.offer.offerId)}`,
                            )
                              ? `/marketplace/otc/${offerPdaByKey.get(
                                  `${r.offer.mint.toString()}-${String(r.offer.offerId)}`,
                                )}`
                              : "/marketplace/otc"
                          }
                          className="text-[12px] font-medium text-brand-700 hover:underline"
                        >
                          Open ↗
                        </Link>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700">
                      {String(r.offer.amount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700">
                      {formatPaymentForDisplay(r.offer.price, r.offer.paymentMint.toString(), detectNetwork())}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-500">
                      {unitPrice}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-500">
                      {r.offer.maker.toString().slice(0, 6)}…
                      {r.offer.maker.toString().slice(-4)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totals && totals.heldBack > 0 && (
        <p className="text-[12.5px] text-slate-500">
          {totals.heldBack} more open{" "}
          {totals.heldBack === 1 ? "offer is" : "offers are"} not takeable yet
          (escrow not funded, past expiry or priced in a token this network
          does not accept).{" "}
          <Link
            href="/marketplace/otc"
            className="font-medium text-brand-700 hover:underline"
          >
            See all on /marketplace/otc →
          </Link>
        </p>
      )}

      {/* Holder posts — off-chain classifieds from token holders who want to
          sell ("Token holders can post about the tokens they have and want to
          sell on Manci"). Negotiation happens off-platform or via the
          contact below; settlement can use the on-chain OTC escrow. */}
      <section className="pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
            Holder posts
          </h2>
          <Link
            href="/portfolio/listings"
            className="text-[12px] font-medium text-brand-700 hover:underline"
          >
            Post your tokens →
          </Link>
        </div>
        <p className="mt-1 text-[12.5px] text-slate-500">
          Token holders looking for buyers. Reach out directly — when you agree
          on terms, settle safely through the on-chain OTC escrow.
        </p>
        {filteredPosts === null ? (
          <div className="mt-4">
            <SkeletonTable rows={2} cols={4} />
          </div>
        ) : filteredPosts.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
            {typeFilter && (posts?.length ?? 0) > 0 ? (
              <p className="text-[13px] text-slate-500">
                No{" "}
                {ASSET_TYPES.find((t) => t.slug === typeFilter)?.title ??
                  typeFilter}{" "}
                holder posts right now — clear the filter to see all.
              </p>
            ) : (
              <p className="text-[13px] text-slate-500">
                No holder posts yet. Holding Manci tokens?{" "}
                <Link
                  href="/portfolio/listings"
                  className="font-medium text-brand-700 hover:underline"
                >
                  Post the first one →
                </Link>
              </p>
            )}
          </div>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...filteredPosts]
              .sort((a, b) => b.created_at.localeCompare(a.created_at))
              .map((p) => (
                <HolderPostCard
                  key={p.id}
                  post={p}
                  viewerWallet={wallet}
                  alreadyRequested={requestedKeys.has(
                    `${p.seller_wallet}:${p.mint}`,
                  )}
                  onRequestOtc={() => setRequestFor(p)}
                />
              ))}
          </div>
        )}
      </section>

      {requestFor && wallet && (
        <RequestOtcModal
          post={requestFor}
          buyerWallet={wallet}
          onClose={() => setRequestFor(null)}
          onRequested={onOtcRequested}
        />
      )}
    </div>
  );
}

function HolderPostCard({
  post,
  viewerWallet,
  alreadyRequested,
  onRequestOtc,
}: {
  post: ResellListing;
  viewerWallet: string | undefined;
  alreadyRequested: boolean;
  onRequestOtc: () => void;
}) {
  const [showContact, setShowContact] = useState(false);
  const label =
    post.asset_label || `${post.mint.slice(0, 6)}…${post.mint.slice(-4)}`;
  const isAuthor =
    !!viewerWallet && viewerWallet === post.seller_wallet;
  // Enough data to open an escrow deal: share-class PDA + amount. Price is
  // confirmed/edited in the request modal (the ask may be "Negotiable").
  const canRequest =
    !!viewerWallet && !isAuthor && !!post.share_class_pda && post.amount > 0;
  return (
    <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-semibold text-slate-900">{label}</p>
        <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
          For sale
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-[13px]">
        <div>
          <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
            Amount
          </dt>
          <dd className="mt-0.5 font-mono tabular-nums text-slate-800">
            {String(post.amount)}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
            Asking
          </dt>
          <dd className="mt-0.5 font-mono tabular-nums text-slate-800">
            {post.ask_price !== null
              ? `${post.ask_price} ${post.ask_currency}`
              : "Negotiable"}
          </dd>
        </div>
      </dl>
      {post.note && (
        <p className="mt-3 text-[12.5px] leading-relaxed text-slate-600">
          {post.note}
        </p>
      )}
      <div className="mt-auto pt-4">
        <p className="font-mono text-[11px] text-slate-400">
          Seller {post.seller_wallet.slice(0, 6)}…{post.seller_wallet.slice(-4)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {showContact ? (
            <p className="w-full break-all rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12.5px] text-slate-800">
              {post.contact || "No contact left — settle via an on-chain OTC offer."}
            </p>
          ) : (
            <button
              type="button"
              onClick={() => setShowContact(true)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:border-slate-400"
            >
              Show contact
            </button>
          )}
          {canRequest &&
            (alreadyRequested ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-[12px] font-medium text-slate-500">
                ✓ OTC escrow requested
              </span>
            ) : (
              <button
                type="button"
                onClick={onRequestOtc}
                className="rounded-md border border-brand-300 bg-brand-50 px-3 py-1.5 text-[12px] font-medium text-brand-700 hover:border-brand-400"
              >
                Request OTC escrow
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Small modal to request an OTC escrow for a holder post (business-doc §9):
 * the buyer confirms amount + price and picks the payment token; the platform
 * then creates the on-chain escrow deal from the request queue.
 * Share units are whole units (decimals 0); the price is typed in the payment
 * token's units and sent as base units (components/payment-price-fields.tsx),
 * after a review step that shows both.
 */
function RequestOtcModal({
  post,
  buyerWallet,
  onClose,
  onRequested,
}: {
  post: ResellListing;
  buyerWallet: string;
  onClose: () => void;
  onRequested: (r: OtcRequest) => void;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const toast = useToast();
  const network = detectNetwork();
  const [amount, setAmount] = useState(String(post.amount));
  // The price is typed in the payment token's own units (lansiranje-16):
  // "1500" means 1 500 USDC, converted exactly with the decimals read from
  // chain. The token comes from the network's allowed list (mainnet: USDC).
  // Base units stay internal (the request payload and the confirmation's
  // last line). The listing's ask is shown as a reference, not prefilled.
  const payment = usePaymentPriceForm(client.runtime.rpc, network);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const amountOk = /^[1-9]\d*$/.test(amount.trim());
  const priceBase = payment.priceBase;
  const paymentMint = payment.check.status === "ok" ? payment.check.mint : null;
  // The request carries JSON numbers: the price must stay a safe integer.
  const priceOk = priceBase !== null && priceBase <= BigInt(Number.MAX_SAFE_INTEGER);
  const valid = amountOk && priceOk && paymentMint !== null;

  async function submit() {
    if (!valid || busy || priceBase === null || paymentMint === null) return;
    const price = Number(priceBase);
    setBusy(true);
    let id: string;
    try {
      // Signed route — requested_by is stamped server-side from the signature.
      id = await createOtcRequest(conn.wallet, {
        share_class_pda: post.share_class_pda!,
        mint: post.mint,
        asset_label: post.asset_label,
        seller_wallet: post.seller_wallet,
        buyer_wallet: buyerWallet,
        amount: Number(amount.trim()),
        price,
        payment_mint: paymentMint,
      });
    } catch (err) {
      setBusy(false);
      toast.showError(
        "Could not submit the request",
        err instanceof Error
          ? err.message
          : "The request queue is unavailable — try again later.",
      );
      return;
    }
    setBusy(false);
    toast.show({
      kind: "success",
      title: "OTC escrow requested",
      description:
        "The platform will create the escrow contract and share the deposit details with both parties.",
    });
    onRequested({
      id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      network: "",
      share_class_pda: post.share_class_pda!,
      mint: post.mint,
      asset_label: post.asset_label,
      seller_wallet: post.seller_wallet,
      buyer_wallet: buyerWallet,
      amount: Number(amount.trim()),
      price,
      payment_mint: paymentMint,
      requested_by: buyerWallet,
      status: "requested",
      deal_pda: null,
      deal_id: null,
      expires_at: null,
      admin_note: null,
      decided_by: null,
      decided_at: null,
    });
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Request OTC escrow
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {post.asset_label || "Share-class tokens"} — seller{" "}
            {post.seller_wallet.slice(0, 6)}…{post.seller_wallet.slice(-4)}.
            The platform opens a smart-contract escrow; you and the seller each
            deposit your side, and the swap settles automatically once both
            legs are funded.
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          {reviewing && valid && priceBase !== null && payment.decimals !== null ? (
            <>
              <p className="text-sm text-slate-700">
                Check the request before you sign it. You deposit the total
                into escrow once the platform opens the deal.
              </p>
              <TradeConfirmation
                units={BigInt(amount.trim())}
                priceBase={priceBase}
                decimals={payment.decimals}
                label={payment.label}
                role="buyer"
              />
            </>
          ) : (
            <>
              <PaymentMintPicker form={payment} />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Amount (share units)
                  </span>
                  <input
                    value={amount}
                    inputMode="numeric"
                    onChange={(e) => setAmount(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                  />
                </label>
                <PaymentPriceField
                  form={payment}
                  note={resellAskNote(post.ask_price, post.ask_currency, detectNetwork())}
                />
              </div>
              {priceBase !== null && !priceOk && (
                <p className="text-xs text-red-700" role="alert">That price is too large for a request.</p>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={reviewing ? () => setReviewing(false) : onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            {reviewing ? "Back" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => (reviewing ? void submit() : setReviewing(true))}
            disabled={!valid || busy}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? "Submitting…" : reviewing ? "Confirm and sign request" : "Review request"}
          </button>
        </div>
      </div>
    </div>
  );
}

function activeTypeCount(rows: Row[]): number {
  const set = new Set<string>();
  for (const r of rows) {
    const s = slugForEnum(r.asset?.assetType);
    if (s) set.add(s);
  }
  return set.size;
}

/** Resolve the on-chain Asset behind a holder post — via its asset PDA when
 *  known, otherwise via its mint's ShareClass. */
function assetForPost(
  p: ResellListing,
  pdaMap: Map<string, Asset>,
  scByMint: Map<string, ShareClass>,
): Asset | undefined {
  if (p.asset_pda) {
    const a = pdaMap.get(p.asset_pda);
    if (a) return a;
  }
  const sc = scByMint.get(p.mint);
  return sc ? pdaMap.get(sc.asset.toString()) : undefined;
}

/** "Devnet is quiet." on a test network; on mainnet the network name would
 *  read as a claim about Solana itself, so the line is about the board. */
function quietLead(): string {
  const network = detectNetwork();
  return isTestNetwork(network) ? `${networkLabel(network)} is quiet.` : "It's quiet here.";
}

function EmptyState({
  typeFilter,
  heldBack,
}: {
  typeFilter: string;
  /** Open offers that exist but cannot be taken right now (see offerHold). */
  heldBack: number;
}) {
  const typed = typeFilter
    ? ASSET_TYPES.find((t) => t.slug === typeFilter)?.title
    : null;
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
      <p className="text-[14px] font-medium text-slate-900">
        {typed
          ? `No open ${typed} offers right now.`
          : heldBack > 0
            ? "No takeable offers right now."
            : "No open offers yet."}
      </p>
      <p className="mt-2 text-[12.5px] text-slate-500">
        {typed
          ? "Try the full list or open the platform to post one."
          : heldBack > 0
            ? `${heldBack} open ${heldBack === 1 ? "offer is" : "offers are"} not takeable yet: escrow not funded, past expiry or priced in a token this network does not accept.`
            : `${quietLead()} The platform is live but no issuer has posted a secondary offer yet.`}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Link href="/marketplace" className="btn-brand">
          Open the platform
        </Link>
        <Link href="/markets/types" className="btn-ghost">
          See asset types
        </Link>
      </div>
    </div>
  );
}
