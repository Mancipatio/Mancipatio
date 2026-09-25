"use client";

import Link from "next/link";
import { type Address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import {
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findAssetPda,
  findDealPda,
  getCancelOtcDealInstructionAsync,
  OfferStatus,
  OtcDealStatus,
  type Asset,
  type Offer,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { Kpi } from "@/components/kpi";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer, withClosedOffers } from "@/lib/indexer";
import { hookTransferMetas } from "@/lib/hook-metas";
import { findOfferPda, findShareClassPda } from "@/lib/pdas";
import {
  adminScreenOtcRequest,
  adminUpdateOtcRequest,
  detectTokenProgram,
  listOtcRequests,
  loadOtcDeals,
  archiveOtcDealRecord,
  withArchivedOtcDeals,
  TOKEN_2022_PROGRAM,
  type LoadedOtcDeal,
  type OtcRequest,
} from "@/lib/otc";
import { checkReceiverEligibility } from "@/lib/passport";
import { detectNetwork } from "@/lib/network";
import { createOtcDealInstruction, newDealId, resolveDealExpiry } from "@/lib/otc-deal";
import { inspectPaymentMint } from "@/lib/transaction-builders";
import { recordAudit } from "@/lib/supabase";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { reclaimOtcDeal } from "@/lib/reclaim-rent";
import { ConfirmModal } from "@/components/confirm-modal";
import { useToast } from "@/lib/toast";
import { SkeletonTable } from "@/components/skeleton";
import { RequireRole } from "@/components/require-role";

const STATUS_LABEL = ["Open", "Filled", "Cancelled", "Expired"];
const STATUS_BADGE: Record<number, string> = {
  0: "bg-emerald-100 text-emerald-800 border-emerald-200",
  1: "bg-slate-200 text-slate-800 border-slate-300",
  2: "bg-red-100 text-red-800 border-red-200",
  3: "bg-amber-100 text-amber-800 border-amber-200",
};

type StatusFilter = "all" | "open" | "filled" | "cancelled";

const STATUS_TO_FILTER: Record<number, StatusFilter> = {
  0: "open",
  1: "filled",
  2: "cancelled",
  3: "cancelled",
};

export default function AdminOtcPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          OTC
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Secondary market oversight
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Read-only view of every hook-aware peer-to-peer offer on the
          platform. Maker actions (create, fund, cancel) and taker actions
          (buy) live in{" "}
          <Link
            href="/portfolio/offers"
            className="text-slate-700 underline-offset-2 hover:underline"
          >
            /portfolio/offers
          </Link>
          .
        </p>
      </div>
      <RequireRole role="admin">
        <OtcEscrowAdmin />
        <OtcOversight />
      </RequireRole>
    </section>
  );
}

function OtcOversight() {
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [assetPdaMap, setAssetPdaMap] = useState<Map<string, Asset>>(new Map());
  const [shareClassByMint, setShareClassByMint] = useState<
    Map<string, ShareClass>
  >(new Map());
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const network = await withClosedOffers(await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      ));
      setData(network);
      const am = new Map<string, Asset>();
      for (const asset of network.assets) {
        const [pda] = await findAssetPda({
          issuer: asset.issuer,
          assetId: asset.assetId,
        });
        am.set(pda.toString(), asset);
      }
      setAssetPdaMap(am);
      const scm = new Map<string, ShareClass>();
      for (const sc of network.shareClasses) {
        scm.set(sc.mint.toString(), sc);
      }
      setShareClassByMint(scm);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.offers
      .map((offer, i) => {
        const sc = shareClassByMint.get(offer.mint.toString());
        const asset = sc ? assetPdaMap.get(sc.asset.toString()) : undefined;
        return { offer, sc, asset, originalIndex: i };
      })
      .filter(({ offer, asset }) => {
        if (
          statusFilter !== "all" &&
          STATUS_TO_FILTER[offer.status] !== statusFilter
        )
          return false;
        if (!q) return true;
        return (
          (asset?.name ?? "").toLowerCase().includes(q) ||
          (asset?.assetId ?? "").toLowerCase().includes(q) ||
          offer.maker.toString().toLowerCase().includes(q) ||
          String(offer.offerId).includes(q)
        );
      })
      .sort((a, b) => Number(b.offer.offerId - a.offer.offerId));
  }, [data, assetPdaMap, shareClassByMint, query, statusFilter]);

  const selectedRow = useMemo(() => {
    if (selectedIdx === null) return null;
    return rows.find((r) => r.originalIndex === selectedIdx) ?? null;
  }, [rows, selectedIdx]);

  const counts = useMemo(() => {
    if (!data) return null;
    return {
      total: data.offers.length,
      open: data.offers.filter((o) => o.status === OfferStatus.Open).length,
      filled: data.offers.filter((o) => o.status === OfferStatus.Filled).length,
      cancelled: data.offers.filter((o) => o.status === OfferStatus.Cancelled)
        .length,
    };
  }, [data]);

  if (failed) {
    return (
      <p className="mt-8 text-sm text-red-600">
        Failed to load OTC directory.
      </p>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      {counts && (
        <section className="grid gap-3 sm:grid-cols-4">
          <Kpi label="Total offers" value={String(counts.total)} />
          <Kpi label="Open" value={String(counts.open)} />
          <Kpi label="Filled" value={String(counts.filled)} />
          <Kpi label="Cancelled" value={String(counts.cancelled)} />
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by asset, maker, or offer ID…"
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(["all", "open", "filled", "cancelled"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                statusFilter === s
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {data === null ? (
        <SkeletonTable rows={5} cols={6} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {data.offers.length === 0
              ? "No OTC offers posted yet."
              : "No offers match the current filter."}
          </p>
          {data.offers.length === 0 && (
            <Link
              href="/portfolio/offers"
              className="mt-4 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Open /portfolio/offers
            </Link>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Offer</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 font-medium">Maker</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ offer, asset, originalIndex }) => {
                const isSelected = selectedIdx === originalIndex;
                return (
                  <tr
                    key={originalIndex}
                    onClick={() =>
                      setSelectedIdx(isSelected ? null : originalIndex)
                    }
                    className={`cursor-pointer transition-colors ${
                      isSelected ? "bg-slate-50" : "hover:bg-slate-50/60"
                    }`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {asset?.name || "(asset unknown)"}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        offer #{String(offer.offerId)} · {asset?.assetId ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {String(offer.amount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {String(offer.price)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {offer.maker.toString().slice(0, 6)}…
                      {offer.maker.toString().slice(-4)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          STATUS_BADGE[offer.status] ?? STATUS_BADGE[0]
                        }`}
                      >
                        {STATUS_LABEL[offer.status] ?? "?"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-xs text-slate-500">
                        {isSelected ? "▾ collapse" : "▸ expand"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedRow && (
        <OfferDetail
          offer={selectedRow.offer}
          asset={selectedRow.asset}
          onClose={() => setSelectedIdx(null)}
        />
      )}
    </div>
  );
}

function OfferDetail({
  offer,
  asset,
  onClose,
}: {
  offer: Offer;
  asset: Asset | undefined;
  onClose: () => void;
}) {
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;
  const [offerPda, setOfferPda] = useState<Address | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const pda = await findOfferPda(offer.shareClass, offer.offerId);
      if (!cancelled) setOfferPda(pda);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [offer.shareClass, offer.offerId]);

  const isMaker =
    wallet && wallet.toString() === offer.maker.toString();

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Offer detail
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">
            {asset?.name ?? "(asset unknown)"} · offer #{String(offer.offerId)}
          </h3>
          {isMaker && (
            <p className="mt-1 text-xs text-brand-700">
              You are the maker — open{" "}
              <Link
                href="/portfolio/offers"
                className="underline underline-offset-2"
              >
                /portfolio/offers
              </Link>{" "}
              to fund or cancel.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-400 hover:text-slate-700"
        >
          Close ✕
        </button>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Field label="Amount (share units)" value={String(offer.amount)} />
        <Field label="Price (payment units)" value={String(offer.price)} />
        <Field label="Status" value={STATUS_LABEL[offer.status] ?? "?"} />
        <Field
          label="Unit price"
          value={
            offer.amount > BigInt(0)
              ? `${Number(offer.price) / Number(offer.amount)}`
              : "—"
          }
        />
        <Field label="Maker" value={offer.maker.toString()} mono />
        <Field label="Mint" value={offer.mint.toString()} mono />
        <Field label="Payment mint" value={offer.paymentMint.toString()} mono />
        <Field label="Escrow" value={offer.escrow.toString()} mono />
        <Field label="Offer PDA" value={offerPda?.toString() ?? "…"} mono />
      </dl>

      <p className="mt-5 border-t border-slate-100 pt-4 text-[11px] text-slate-400">
        Read-only oversight. All maker / taker actions live in{" "}
        <Link
          href="/portfolio/offers"
          className="underline underline-offset-2"
        >
          /portfolio/offers
        </Link>{" "}
        — they require the wallet that owns the share units or the buy-side
        payment account.
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-slate-500">
        {label}
      </dt>
      <dd
        className={`mt-1 ${mono ? "break-all font-mono text-xs" : "text-sm"} text-slate-900`}
      >
        {value}
      </dd>
    </div>
  );
}

// ── Bilateral OTC escrow (business-doc §9) ──────────────────────────────────

const DEAL_STATUS_LABEL = ["Open", "Completed", "Expired", "Cancelled"];
const DEAL_STATUS_BADGE: Record<number, string> = {
  [OtcDealStatus.Open]: "bg-emerald-100 text-emerald-800 border-emerald-200",
  [OtcDealStatus.Completed]: "bg-slate-200 text-slate-800 border-slate-300",
  [OtcDealStatus.Expired]: "bg-amber-100 text-amber-800 border-amber-200",
  [OtcDealStatus.Cancelled]: "bg-red-100 text-red-800 border-red-200",
};

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function OtcEscrowAdmin() {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [requests, setRequests] = useState<OtcRequest[] | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [deals, setDeals] = useState<
    (LoadedOtcDeal & { closed?: boolean })[] | null
  >(null);
  const [labelByShareClass, setLabelByShareClass] = useState<
    Map<string, string>
  >(new Map());
  const [confirmCancel, setConfirmCancel] = useState<LoadedOtcDeal | null>(
    null,
  );
  const [rejectReq, setRejectReq] = useState<OtcRequest | null>(null);

  const refresh = useCallback(async () => {
    if (!conn.wallet) { setRequests([]); return; }
    try {
      const rpc = client.runtime.rpc;
      const [reqs, onchain] = await Promise.all([
        listOtcRequests(conn.wallet, "requested"),
        loadOtcDeals(rpc).catch(() => [] as LoadedOtcDeal[]),
      ]);
      setRequests(reqs);
      setRequestError(null);
      setDeals(await withArchivedOtcDeals(onchain));

      // Asset-name labels for the deal rows (share-class PDA → asset name).
      try {
        const network = await loadNetworkPreferIndexer(() => loadNetwork(rpc));
        const assetByPda = new Map<string, Asset>();
        for (const a of network.assets) {
          const [pda] = await findAssetPda({
            issuer: a.issuer,
            assetId: a.assetId,
          });
          assetByPda.set(pda.toString(), a);
        }
        const labels = new Map<string, string>();
        for (const sc of network.shareClasses) {
          const pda = await findShareClassPda(sc.asset, sc.classIndex);
          const asset = assetByPda.get(sc.asset.toString());
          labels.set(
            pda.toString(),
            asset ? `${asset.name} · #${sc.classIndex}` : `class #${sc.classIndex}`,
          );
        }
        setLabelByShareClass(labels);
      } catch {
        /* labels are best-effort */
      }
    } catch (err) {
      setRequests([]);
      setRequestError(err instanceof Error ? err.message : "Could not load OTC requests");
    }
  }, [client, conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const sortedDeals = useMemo(
    () =>
      (deals ?? [])
        .slice()
        .sort((a, b) => Number(b.deal.dealId - a.deal.dealId)),
    [deals],
  );

  /**
   * Opens the on-chain escrow for a request (business-doc §9: "one submits a
   * request for smart-contract creation; the platform creates the contract").
   * deal_id is a timestamp-based unique u64 (ms since epoch) — the deal PDA
   * is seeded by (share_class, deal_id). expires_at: the request's own expiry
   * when set, otherwise 7 days from now. amount/price are already integer
   * base units (share units / payment-token units — see lib/otc.ts).
   */
  async function createContract(req: OtcRequest) {
    if (!wallet || !conn.wallet) return;
    const pendingId = toast.showPending(
      `Creating escrow for ${req.asset_label || "share class"}…`,
    );
    try {
      const rpc = client.runtime.rpc;
      const signer = walletSigner(conn.wallet);
      const dealId = newDealId();
      // Entry path: the payment mint must pass the plain-payment rule (and,
      // on mainnet, the allowlist) before an escrow names it. Throws with the
      // reason (missing mint, hook, not allowed…); nothing is opened.
      const { owner: payTokenProgram } = await inspectPaymentMint(
        rpc,
        req.payment_mint as Address,
        detectNetwork(),
        { commitment: "finalized", abortSignal: AbortSignal.timeout(10_000) },
      );
      // Compliance re-screen BEFORE the deal exists. /api/otc/create refused
      // a suspended party when the request was filed, but compliance may have
      // suspended one since. Fails closed: if the screen cannot run, the
      // throw lands in the catch below and no escrow is opened.
      const screen = await adminScreenOtcRequest(conn.wallet, req.id);
      if (!screen.cleared) {
        const parties = [
          screen.seller === "suspended" ? "seller" : null,
          screen.buyer === "suspended" ? "buyer" : null,
        ].filter(Boolean).join(" and ");
        toast.dismiss(pendingId);
        toast.showError(
          "A party is suspended",
          `The ${parties}'s client profile is suspended by compliance. Decline this request instead of opening an escrow.`,
        );
        return;
      }
      // Buyer eligibility BEFORE the deal exists.
      //
      // `settle_otc_deal` enforces receiver KYC on the asset leg (the deal
      // PDA's EscrowMarker exempts it from the hook, so the handler checks it
      // itself). Opening a deal whose buyer cannot pass that check produces a
      // deal both parties can fund and NOBODY can settle — the only way out is
      // cancel/expire, after both legs have been moved into escrow. Refuse to
      // open it in the first place; the parties can be told to fix the
      // passport first.
      const buyerGate = await checkReceiverEligibility(
        rpc,
        req.mint as Address,
        req.buyer_wallet as Address,
      );
      if (!buyerGate.ok) {
        toast.dismiss(pendingId);
        toast.showError(
          "Buyer cannot receive this token",
          `${buyerGate.reason} Issue or renew the buyer's investor passport before creating the escrow — a deal opened now could be funded but never settled.`,
        );
        return;
      }
      const expiresAt = resolveDealExpiry(req.expires_at);
      // The shared builder (lib/otc-deal.ts): the simulator's owner actor
      // opens its escrows with exactly this instruction.
      const ix = await createOtcDealInstruction({
        authority: signer,
        request: req,
        dealId,
        expiresAt,
        paymentTokenProgram: payTokenProgram,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      const [dealPda] = await findDealPda({
        shareClass: req.share_class_pda as Address,
        dealId,
      });
      // Signed + admin-gated route; decided_by/at are stamped server-side and
      // the server notifies both parties (email when known + in-app rows). If
      // this fails the on-chain deal already exists — surface it loudly so the
      // operator retries the row flip/notification rather than clicking "Create
      // contract" again (which would mint a SECOND deal).
      const flipped = await adminUpdateOtcRequest(conn.wallet, req.id, {
        status: "created",
        deal_pda: dealPda.toString(),
        deal_id: Number(dealId),
        decide: true,
      });
      if (!flipped) {
        toast.showError(
          "Deal created, but the request wasn't updated",
          `The on-chain deal ${dealPda.toString().slice(0, 8)}… exists, but the request row and party notifications did not update. Do NOT click "Create contract" again — contact support to reconcile.`,
        );
      }
      void recordAudit({
        ix_name: "create_otc_deal",
        category: "otc",
        actor_wallet: wallet.toString(),
        reason: `OTC escrow request ${req.id}`,
        target_label: req.asset_label || req.mint.slice(0, 8),
        tx_signature: sig,
        metadata: {
          request_id: req.id,
          deal_pda: dealPda.toString(),
          deal_id: dealId.toString(),
          amount: req.amount,
          price: req.price,
        },
      });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Escrow deal created" });
      void refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to create deal", explainSendError(err));
      console.error("[create_otc_deal]", err);
    }
  }

  /**
   * Decline a pending request without creating an on-chain deal (off-chain
   * only). Flips the request row to 'cancelled' with the operator's reason and
   * notifies the parties (server-side). Clears it from the pending queue.
   */
  async function rejectRequest(req: OtcRequest, reason: string) {
    if (!wallet || !conn.wallet) return;
    const pendingId = toast.showPending("Declining OTC request…", reason);
    const ok = await adminUpdateOtcRequest(conn.wallet, req.id, {
      status: "cancelled",
      admin_note: reason || null,
      decide: true,
    });
    toast.dismiss(pendingId);
    if (!ok) {
      toast.showError("Decline failed", "Could not update the request.");
      return;
    }
    toast.show({ kind: "success", title: "Request declined" });
    void recordAudit({
      ix_name: "otc_request_reject",
      category: "otc",
      actor_wallet: wallet.toString(),
      reason: reason || "Declined",
      target_label: req.asset_label || req.mint.slice(0, 8),
      metadata: { request_id: req.id },
    });
    setRejectReq(null);
    void refresh();
  }

  /**
   * Admin cancel & refund of an open deal (cancel_otc_deal). Both refund
   * destination token accounts are required by the Rust account constraints,
   * so they are created idempotently (admin pays the rent) even when their
   * leg was never deposited.
   */
  async function cancelDeal(row: LoadedOtcDeal, reason: string) {
    if (!wallet || !conn.wallet) return;
    const { pda, deal } = row;
    const pendingId = toast.showPending(
      `Cancelling deal #${String(deal.dealId)}…`,
      reason,
    );
    try {
      const rpc = client.runtime.rpc;
      const signer = walletSigner(conn.wallet);
      // Exit path: the permissive owner check, so any deal can be unwound.
      const payTokenProgram = await detectTokenProgram(rpc, deal.paymentMint);
      const [sellerShareAta] = await findAssociatedTokenPda({
        owner: deal.seller,
        tokenProgram: TOKEN_2022_PROGRAM,
        mint: deal.mint,
      });
      const [buyerPaymentAta] = await findAssociatedTokenPda({
        owner: deal.buyer,
        tokenProgram: payTokenProgram,
        mint: deal.paymentMint,
      });
      const createSellerShareAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: deal.seller,
          mint: deal.mint,
          tokenProgram: TOKEN_2022_PROGRAM,
        });
      const createBuyerPaymentAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: deal.buyer,
          mint: deal.paymentMint,
          tokenProgram: payTokenProgram,
        });
      const baseIx = await getCancelOtcDealInstructionAsync({
        authority: signer,
        deal: pda,
        mint: deal.mint,
        assetEscrow: deal.assetEscrow,
        sellerShareAccount: sellerShareAta,
        paymentMint: deal.paymentMint,
        paymentEscrow: deal.paymentEscrow,
        buyerPaymentAccount: buyerPaymentAta,
        shareTokenProgram: TOKEN_2022_PROGRAM,
        paymentTokenProgram: payTokenProgram,
      });
      const cancelIx = {
        ...baseIx,
        accounts: [
          ...baseIx.accounts,
          // Refund leg: asset escrow (deal PDA) → seller's share account.
          ...(await hookTransferMetas(rpc, deal.mint, {
            sourceTokenAccount: deal.assetEscrow,
            destTokenAccount: sellerShareAta,
            transferAuthority: pda,
            sourceOwner: pda,
            destOwner: deal.seller,
          })),
        ],
      };
      const sig = await tx.send({
        instructions: [createSellerShareAtaIx, createBuyerPaymentAtaIx, cancelIx],
        feePayer: signer,
      });
      // Best-effort: flip the matching request row, if one exists.
      const all = await listOtcRequests(conn.wallet);
      const match = all.find(
        (r) => r.deal_pda === pda.toString() && r.status === "created",
      );
      if (match) {
        await adminUpdateOtcRequest(conn.wallet, match.id, {
          status: "cancelled",
          decide: true,
        });
      }
      void recordAudit({
        ix_name: "cancel_otc_deal",
        category: "otc",
        actor_wallet: wallet.toString(),
        reason,
        target_label: `deal #${String(deal.dealId)}`,
        tx_signature: sig,
        metadata: { deal_pda: pda.toString(), deal_id: String(deal.dealId) },
      });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Deal cancelled & refunded" });
      setConfirmCancel(null);
      void refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to cancel deal", explainSendError(err));
      console.error("[cancel_otc_deal]", err);
    }
  }

  /**
   * 2D: archive a terminal deal's record, THEN return all its rent (both
   * escrows + the deal, left as an 8-byte tombstone) to deal.admin. The
   * archive must land first: OTC deals are scanned live, so the tombstone
   * would otherwise erase the deal's history.
   */
  async function closeAndReclaim(row: LoadedOtcDeal) {
    if (!wallet || !conn.wallet) return;
    const { pda, deal } = row;
    const pendingId = toast.showPending(
      `Closing deal #${String(deal.dealId)} and reclaiming its rent…`,
    );
    try {
      const rpc = client.runtime.rpc;
      const signer = walletSigner(conn.wallet);
      // Exit path: the permissive owner check.
      const payTokenProgram = await detectTokenProgram(rpc, deal.paymentMint);
      const [asset, payment] = await Promise.all([
        fetchMaybeToken(rpc, deal.assetEscrow, { commitment: "confirmed" }),
        fetchMaybeToken(rpc, deal.paymentEscrow, { commitment: "confirmed" }),
      ]);
      if (
        !asset.exists ||
        !payment.exists ||
        asset.data.amount !== BigInt(0) ||
        payment.data.amount !== BigInt(0)
      )
        throw new Error(
          "An escrow still holds tokens (a withheld surplus or dust), so this deal cannot be closed.",
        );
      await archiveOtcDealRecord(conn.wallet, pda.toString());
      const ix = reclaimOtcDeal({
        admin: signer,
        deal: pda,
        data: deal,
        paymentTokenProgram: payTokenProgram,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      void recordAudit({
        ix_name: "reclaim_rent",
        category: "otc",
        actor_wallet: wallet.toString(),
        reason: "Close a terminal OTC deal and reclaim its rent",
        target_label: `deal #${String(deal.dealId)}`,
        tx_signature: sig,
        metadata: { deal_pda: pda.toString(), deal_id: String(deal.dealId) },
      });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Deal closed, rent reclaimed" });
      void refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to close the deal", explainSendError(err));
    }
  }

  return (
    <div className="mt-8 space-y-6">
      {/* ── Requested escrow contracts (off-chain queue) ── */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          OTC escrow requests
        </h2>
        <p className="mt-1 text-[13px] text-slate-600">
          Buyer and seller agreed on terms off-chain and asked the platform to
          open the smart-contract escrow. Creating the contract shares the deal
          PDA with both parties so they can deposit their legs.
        </p>
        {requestError ? (
          <div role="alert" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900"><p>{requestError}</p><button type="button" onClick={() => void refresh()} className="btn-brand mt-3">Try again</button></div>
        ) : requests === null ? (
          <div className="mt-4">
            <SkeletonTable rows={2} cols={6} />
          </div>
        ) : requests.length === 0 ? (
          <p className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            No pending escrow requests.
          </p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Asset</th>
                  <th className="px-4 py-3 font-medium">Parties</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3 text-right font-medium">Price</th>
                  <th className="px-4 py-3 font-medium">Payment mint</th>
                  <th className="px-4 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {requests.map((r) => (
                  <tr key={r.id} className="text-slate-700">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {r.asset_label || "(unnamed)"}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                        {shortAddr(r.mint)} ·{" "}
                        {new Date(r.created_at).toLocaleDateString()}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      <p title={r.seller_wallet}>
                        seller {shortAddr(r.seller_wallet)}
                      </p>
                      <p className="mt-0.5" title={r.buyer_wallet}>
                        buyer {shortAddr(r.buyer_wallet)}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {String(r.amount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {String(r.price)}
                    </td>
                    <td
                      className="px-4 py-3 font-mono text-xs text-slate-500"
                      title={r.payment_mint}
                    >
                      {shortAddr(r.payment_mint)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={tx.isSending || !wallet}
                          onClick={() => void createContract(r)}
                          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                        >
                          Create contract
                        </button>
                        <button
                          type="button"
                          disabled={tx.isSending || !wallet}
                          onClick={() => setRejectReq(r)}
                          className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── On-chain escrow deals ── */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          On-chain escrow deals
        </h2>
        <p className="mt-1 text-[13px] text-slate-600">
          Every <code>OtcDeal</code> account on this network. Open deals can be
          cancelled here — whichever leg was deposited is refunded; participant
          actions (deposit, expire-refund) live in{" "}
          <Link
            href="/portfolio/deals"
            className="text-slate-700 underline-offset-2 hover:underline"
          >
            /portfolio/deals
          </Link>
          .
        </p>
        {deals === null ? (
          <div className="mt-4">
            <SkeletonTable rows={3} cols={7} />
          </div>
        ) : sortedDeals.length === 0 ? (
          <p className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            No escrow deals created yet.
          </p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Deal</th>
                  <th className="px-4 py-3 font-medium">Buyer / seller</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3 text-right font-medium">Price</th>
                  <th className="px-4 py-3 font-medium">Deposits</th>
                  <th className="px-4 py-3 font-medium">Expires</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sortedDeals.map(({ pda, deal, closed }) => (
                  <tr key={pda.toString()} className="text-slate-700">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {labelByShareClass.get(deal.shareClass.toString()) ??
                          shortAddr(deal.mint.toString())}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                        deal #{String(deal.dealId)} · {shortAddr(pda.toString())}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      <p title={deal.buyer.toString()}>
                        b {shortAddr(deal.buyer.toString())}
                      </p>
                      <p className="mt-0.5" title={deal.seller.toString()}>
                        s {shortAddr(deal.seller.toString())}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {String(deal.amount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {String(deal.price)}
                    </td>
                    {/* Ledgered amounts, not just the flags: cancel / expire
                        refund at most these numbers to each depositor (the
                        escrows are ordinary token accounts anyone can push
                        into, so their balances are NOT the payout basis). */}
                    <td className="px-4 py-3 text-xs">
                      <span
                        className={`mr-1 inline-flex rounded-full border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                          deal.assetDeposited
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-slate-200 bg-slate-50 text-slate-400"
                        }`}
                        title={`Recorded asset deposit: ${deal.assetDepositedAmount} of ${deal.amount} unit(s) — the seller's KYC-free refund is capped at this.`}
                      >
                        asset {String(deal.assetDepositedAmount)}/
                        {String(deal.amount)}
                      </span>
                      <span
                        className={`inline-flex rounded-full border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                          deal.paymentDeposited
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-slate-200 bg-slate-50 text-slate-400"
                        }`}
                        title={`Recorded payment deposit: ${deal.paymentDepositedAmount} of ${deal.price} base unit(s) — the buyer's refund is capped at this.`}
                      >
                        pay {String(deal.paymentDepositedAmount)}/
                        {String(deal.price)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {deal.expiresAt > BigInt(0)
                        ? new Date(
                            Number(deal.expiresAt) * 1000,
                          ).toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          DEAL_STATUS_BADGE[deal.status] ??
                          DEAL_STATUS_BADGE[OtcDealStatus.Open]
                        }`}
                      >
                        {DEAL_STATUS_LABEL[deal.status] ?? "?"}
                      </span>
                      {closed && (
                        <span className="ml-2 text-[11px] text-slate-500">
                          closed (rent reclaimed)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!closed &&
                        deal.status !== OtcDealStatus.Open &&
                        wallet?.toString() === deal.admin.toString() && (
                          <button
                            type="button"
                            disabled={tx.isSending}
                            onClick={() => void closeAndReclaim({ pda, deal })}
                            title="Archives the deal record, closes both empty escrows and returns their rent to you (the deal's admin)."
                            className="text-xs text-slate-700 underline-offset-2 hover:underline disabled:opacity-50"
                          >
                            Close &amp; reclaim
                          </button>
                        )}
                      {!closed && deal.status === OtcDealStatus.Open && (
                        <button
                          type="button"
                          disabled={tx.isSending || !wallet}
                          onClick={() => setConfirmCancel({ pda, deal })}
                          className="text-xs text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          Cancel &amp; refund
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirmCancel && (
        <ConfirmModal
          open
          onClose={() => setConfirmCancel(null)}
          onConfirm={(reason) => cancelDeal(confirmCancel, reason)}
          title={`Cancel OTC deal #${confirmCancel.deal.dealId}`}
          kind="destructive"
          confirmLabel="Cancel & refund"
          description={
            <p>
              Cancelling marks the deal as Cancelled and refunds whichever leg
              was deposited: escrowed share units return to the seller,
              escrowed payment returns to the buyer.
            </p>
          }
          busy={tx.isSending}
        />
      )}

      {rejectReq && (
        <ConfirmModal
          open
          onClose={() => setRejectReq(null)}
          onConfirm={(reason) => rejectRequest(rejectReq, reason)}
          title="Decline OTC request"
          kind="warning"
          confirmLabel="Decline request"
          description={
            <p>
              Declines the request without creating an on-chain deal. The
              parties are notified and the request leaves the pending queue.
            </p>
          }
        />
      )}
    </div>
  );
}
