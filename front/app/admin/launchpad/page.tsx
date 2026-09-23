"use client";

import { type Address } from "@solana/kit";
import { useRouter } from "next/navigation";
import { walletSigner } from "@/lib/wallet-signer";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findAssetPda,
  findIssuerPda,
  getCloseSaleInstruction,
  findPlatformPda,
  getOpenSaleInstructionAsync,
  fetchMaybeSaleApproval,
  findSaleApprovalPda,
  RaiseType,
  SaleStatus,
  type Asset,
  type Sale,
  type SaleApproval,
} from "@/lib/generated/asset_registry";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { fromBytes32, toBytes32 } from "@/lib/format";
import { findSalePda, findShareClassPda } from "@/lib/pdas";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonTable } from "@/components/skeleton";
import { RequireRole } from "@/components/require-role";
import { useToast } from "@/lib/toast";
import { detectNetwork } from "@/lib/network";
import { fetchPlainPaymentMintTokenProgram } from "@/lib/transaction-builders";
import { explainSendError } from "@/lib/tx-error";
import { useChainClock } from "@/lib/use-chain-clock";

const TOKEN_CLASSIC_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

type SaleLifecycle = "open" | "closing-soon" | "expired-open" | "closed";
type StatusFilter = "all" | SaleLifecycle;

const STATUS_BADGE: Record<SaleLifecycle, string> = {
  open: "bg-emerald-100 text-emerald-800 border-emerald-200",
  "closing-soon": "bg-amber-100 text-amber-800 border-amber-200",
  "expired-open": "bg-red-100 text-red-800 border-red-200",
  closed: "bg-slate-200 text-slate-800 border-slate-300",
};

const STATUS_LABEL: Record<SaleLifecycle, string> = {
  open: "Open",
  "closing-soon": "Closing < 24h",
  "expired-open": "Expired (open)",
  closed: "Closed",
};

const CLOSING_WINDOW_SEC = BigInt(60 * 60 * 24);

function lifecycleOf(sale: Sale): SaleLifecycle {
  if (sale.status === SaleStatus.Closed) return "closed";
  if (sale.endTs === BigInt(0)) return "open";
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (sale.endTs <= now) return "expired-open";
  if (sale.endTs - now < CLOSING_WINDOW_SEC) return "closing-soon";
  return "open";
}

export default function LaunchpadPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Launchpad
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Primary sales
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Every primary sale on Manci — price, raised, status and lifecycle
          actions (open, buy, close).
        </p>
      </div>
      <RequireRole role="admin">
        <SalesOps />
      </RequireRole>
    </section>
  );
}

function SalesOps() {
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [assetPdaMap, setAssetPdaMap] = useState<Map<string, Asset>>(new Map());
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [showOpen, setShowOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);
      const next = new Map<string, Asset>();
      for (const asset of network.assets) {
        const [pda] = await findAssetPda({
          issuer: asset.issuer,
          assetId: asset.assetId,
        });
        next.set(pda.toString(), asset);
      }
      setAssetPdaMap(next);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // share_class.asset → Asset (already mapped). Need share_class PDA → Asset
  // via the share class on-chain account. shareClasses already include `asset`.
  const shareClassToAsset = useMemo(() => {
    if (!data) return new Map<string, Asset>();
    const m = new Map<string, Asset>();
    for (const sc of data.shareClasses) {
      const asset = assetPdaMap.get(sc.asset.toString());
      if (asset) {
        // share-class PDA — derived asynchronously elsewhere; here key by sc.mint to allow lookup
        m.set(sc.mint.toString(), asset);
      }
    }
    return m;
  }, [data, assetPdaMap]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.sales
      .map((sale, i) => ({
        sale,
        asset: shareClassToAsset.get(sale.mint.toString()),
        originalIndex: i,
      }))
      .filter(({ sale, asset }) => {
        const lc = lifecycleOf(sale);
        if (status !== "all" && lc !== status) return false;
        if (!q) return true;
        return (
          (asset?.name ?? "").toLowerCase().includes(q) ||
          (asset?.assetId ?? "").toLowerCase().includes(q) ||
          sale.mint.toString().toLowerCase().includes(q) ||
          String(sale.saleId).includes(q)
        );
      })
      .sort((a, b) => Number(b.sale.saleId - a.sale.saleId));
  }, [data, shareClassToAsset, query, status]);

  const selectedRow = useMemo(() => {
    if (selectedIdx === null) return null;
    return rows.find((r) => r.originalIndex === selectedIdx) ?? null;
  }, [rows, selectedIdx]);

  if (failed) {
    return (
      <p className="mt-8 text-sm text-red-600">
        Failed to load sales directory.
      </p>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by asset, mint or sale ID…"
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(
            ["all", "open", "closing-soon", "expired-open", "closed"] as const
          ).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                status === s
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {s === "all" ? "All" : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowOpen(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + Open sale
        </button>
      </div>

      {data === null ? (
        <SkeletonTable rows={5} cols={6} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {data.sales.length === 0
              ? "No primary sales opened yet."
              : "No sales match the current filter."}
          </p>
          {data.sales.length === 0 && (
            <button
              type="button"
              onClick={() => setShowOpen(true)}
              className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Open the first sale
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Sale</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 text-right font-medium">
                  Sold / total
                </th>
                <th className="px-4 py-3 font-medium">Payment</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ sale, asset, originalIndex }) => {
                const lc = lifecycleOf(sale);
                const isSelected = selectedIdx === originalIndex;
                const pctSold =
                  sale.totalForSale > BigInt(0)
                    ? Number((sale.sold * BigInt(1000)) / sale.totalForSale) /
                      10
                    : 0;
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
                        sale #{String(sale.saleId)} · {asset?.assetId ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {String(sale.pricePerUnit)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <p className="font-mono text-slate-700">
                        {String(sale.sold)} / {String(sale.totalForSale)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {pctSold.toFixed(1)}%
                      </p>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {sale.paymentMint.toString().slice(0, 6)}…
                      {sale.paymentMint.toString().slice(-4)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[lc]}`}
                      >
                        {STATUS_LABEL[lc]}
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
        <SaleDetail
          sale={selectedRow.sale}
          asset={selectedRow.asset}
          onRefresh={refresh}
          onClose={() => setSelectedIdx(null)}
        />
      )}

      {showOpen && data && (
        <OpenSaleModal
          data={data}
          onClose={() => setShowOpen(false)}
          onSuccess={() => {
            void refresh();
            setShowOpen(false);
          }}
        />
      )}
    </div>
  );
}

function SaleDetail({
  sale,
  asset,
  onRefresh,
  onClose,
}: {
  sale: Sale;
  asset: Asset | undefined;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const router = useRouter();
  const [confirmClose, setConfirmClose] = useState(false);

  const lc = lifecycleOf(sale);

  async function close(reason: string) {
    if (!wallet) return;
    const pendingId = toast.showPending(
      `Closing sale #${sale.saleId}…`,
      reason,
    );
    try {
      const signer = walletSigner(conn.wallet);
      const salePda = await findSalePda(sale.shareClass, sale.saleId);
      const paymentTokenProgram = await fetchPlainPaymentMintTokenProgram(
        client.runtime.rpc,
        sale.paymentMint,
      );
      const [destAta] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram: paymentTokenProgram,
        mint: sale.paymentMint,
      });
      const createDestAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: wallet,
          mint: sale.paymentMint,
          tokenProgram: paymentTokenProgram,
        });
      // Emergency-pause gate (read-only) — the last named account.
      const [platform] = await findPlatformPda();
      const closeIx = getCloseSaleInstruction({
        platform,
        authority: signer,
        sale: salePda,
        proceeds: sale.proceeds,
        paymentMint: sale.paymentMint,
        destination: destAta,
        paymentTokenProgram: paymentTokenProgram,
      });
      const sig = await tx.send({
        instructions: [createDestAtaIx, closeIx],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Sale closed" });
      setConfirmClose(false);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to close sale",
        explainSendError(err),
      );
    }
  }

  const remaining = sale.totalForSale - sale.sold;
  const endsAt =
    sale.endTs === BigInt(0)
      ? "no end"
      : new Date(Number(sale.endTs) * 1000).toISOString().slice(0, 16) + "Z";

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Sale detail
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">
            {asset?.name ?? "(asset unknown)"} · sale #{String(sale.saleId)}
          </h3>
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
        <Field label="Status" value={STATUS_LABEL[lc]} />
        <Field label="Ends at" value={endsAt} />
        <Field label="Price per unit" value={String(sale.pricePerUnit)} />
        <Field label="Sold" value={String(sale.sold)} />
        <Field label="Total for sale" value={String(sale.totalForSale)} />
        <Field label="Remaining" value={String(remaining)} />
        <Field label="Mint" value={sale.mint.toString()} mono />
        <Field label="Payment mint" value={sale.paymentMint.toString()} mono />
        <Field label="Proceeds escrow" value={sale.proceeds.toString()} mono />
        <Field label="Authority" value={sale.authority.toString()} mono />
      </dl>

      {sale.status === SaleStatus.Open && (
        <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Sale actions
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                void findSalePda(sale.shareClass, sale.saleId).then((pda) =>
                  router.push(`/marketplace/launchpad/${pda}`),
                )
              }
              className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white"
            >
              Review terms and buy
            </button>
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() => setConfirmClose(true)}
              className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
            >
              Close sale
            </button>
          </div>
          <p className="text-[11px] text-slate-400">
            Purchases use the marketplace document acceptance and receipt flow.
            Closing withdraws proceeds to the issuer authority.
          </p>
        </div>
      )}

      <ConfirmModal
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        onConfirm={(reason) => close(reason)}
        title={`Close sale #${sale.saleId}`}
        kind="warning"
        confirmLabel="Close sale"
        description={
          <>
            <p>
              Closing the sale withdraws all proceeds to the issuer authority
              and prevents any further{" "}
              <code className="rounded bg-slate-100 px-1">buy</code> calls.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />
    </div>
  );
}

function OpenSaleModal({
  data,
  onClose,
  onSuccess,
}: {
  data: NetworkData;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const chainNow = useChainClock();

  const [issuerLegalId, setIssuerLegalId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [classIndex, setClassIndex] = useState("0");
  const [saleId, setSaleId] = useState("1");
  const [pricePerUnit, setPricePerUnit] = useState("");
  const [totalForSale, setTotalForSale] = useState("");
  const [endTs, setEndTs] = useState("");
  // The Admin SaleApproval for (share class, sale id): open_sale consumes it,
  // and it fixes the payment mint, price range, maximum raise and raise type.
  const [approval, setApproval] = useState<SaleApproval | null>(null);
  const [approvalState, setApprovalState] = useState<
    "idle" | "loading" | "missing" | "found" | "error"
  >("idle");

  const matchedIssuer = useMemo(() => {
    if (!issuerLegalId.trim()) return null;
    return (
      data.issuers.find(
        (i) => fromBytes32(i.legalEntityId) === issuerLegalId.trim(),
      ) ?? null
    );
  }, [data, issuerLegalId]);

  useEffect(() => {
    if (!issuerLegalId.trim() || !assetId.trim() || !/^\d+$/.test(saleId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setApproval(null);
      setApprovalState("idle");
      return;
    }
    let cancelled = false;
    setApprovalState("loading");
    void (async () => {
      try {
        const [ip] = await findIssuerPda({
          legalEntityId: toBytes32(issuerLegalId.trim()),
        });
        const [ap] = await findAssetPda({ issuer: ip, assetId: assetId.trim() });
        const scPda = await findShareClassPda(ap, Number(classIndex) || 0);
        const [approvalPda] = await findSaleApprovalPda({
          shareClass: scPda,
          saleId: BigInt(saleId),
        });
        const found = await fetchMaybeSaleApproval(
          client.runtime.rpc,
          approvalPda,
          { commitment: "confirmed" },
        );
        if (cancelled) return;
        setApproval(found.exists ? found.data : null);
        setApprovalState(found.exists ? "found" : "missing");
      } catch {
        if (!cancelled) {
          setApproval(null);
          setApprovalState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, issuerLegalId, assetId, classIndex, saleId]);

  const price = /^\d+$/.test(pricePerUnit.trim())
    ? BigInt(pricePerUnit.trim())
    : null;
  const total = /^\d+$/.test(totalForSale.trim())
    ? BigInt(totalForSale.trim())
    : null;
  // open_sale rejects a zero price on-chain (InvalidSalePrice).
  const priceIsZero = price === BigInt(0);
  const priceOutOfRange =
    approval !== null &&
    price !== null &&
    price > BigInt(0) &&
    (price < approval.minPricePerUnit || price > approval.maxPricePerUnit);
  const maxUnits =
    approval && price !== null && price > BigInt(0)
      ? approval.maxGrossRaise / price
      : null;
  const totalTooLarge = maxUnits !== null && total !== null && total > maxUnits;
  const approvalExpired = approval !== null && approval.expiresAt < chainNow;
  const isStartup = approval?.raiseType === RaiseType.Startup;

  async function open() {
    if (
      !wallet ||
      !issuerLegalId.trim() ||
      !assetId.trim() ||
      !approval ||
      price === null ||
      total === null
    )
      return;
    if (priceIsZero) {
      toast.showError(
        "Invalid price",
        "The price per unit must be greater than zero.",
      );
      return;
    }
    if (priceOutOfRange || totalTooLarge || approvalExpired || isStartup) {
      toast.showError(
        "Outside the approval",
        isStartup
          ? "This approval is for a startup raise; open it from the issuer launchpad, which carries its vesting terms."
          : "The price, the total or the expiry is outside the sale approval.",
      );
      return;
    }
    const pendingId = toast.showPending(`Opening sale #${saleId}…`);
    try {
      const [ip] = await findIssuerPda({
        legalEntityId: toBytes32(issuerLegalId.trim()),
      });
      const [ap] = await findAssetPda({
        issuer: ip,
        assetId: assetId.trim(),
      });
      const scPda = await findShareClassPda(ap, Number(classIndex) || 0);
      const sc = data.shareClasses.find(
        (x) =>
          x.classIndex === (Number(classIndex) || 0) &&
          x.asset.toString() === ap.toString(),
      );
      if (!sc) {
        toast.dismiss(pendingId);
        toast.showError(
          "Share class not found",
          "Verify issuer ID, asset ID and class index.",
        );
        return;
      }
      const endTsBig = endTs.trim()
        ? BigInt(Math.floor(new Date(endTs).getTime() / 1000))
        : BigInt(0);
      const signer = walletSigner(conn.wallet);
      const ix = await getOpenSaleInstructionAsync({
        authority: signer,
        issuer: ip,
        asset: ap,
        shareClass: scPda,
        mint: sc.mint,
        paymentMint: approval.paymentMint,
        paymentTokenProgram: TOKEN_CLASSIC_ADDRESS,
        saleId: BigInt(saleId || "0"),
        pricePerUnit: price,
        totalForSale: total,
        startTs: BigInt(0),
        endTs: endTsBig,
        raiseType: RaiseType.Mature,
        cliffMonths: 0,
        vestingMonths: 0,
        // The consumed approval's rent returns to the approving admin.
        approvedBy: approval.approvedBy,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Sale opened" });
      onSuccess();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to open sale",
        explainSendError(err),
      );
    }
  }

  if (!wallet) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !tx.isSending) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Open primary sale
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Issuer legal entity ID
              </span>
              <input
                value={issuerLegalId}
                maxLength={32}
                onChange={(e) => setIssuerLegalId(e.target.value)}
                placeholder="e.g. ACME-DOO-2026"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              {issuerLegalId.trim() && matchedIssuer === null && (
                <span className="mt-1 block text-[11px] text-amber-700">
                  No issuer with this legal entity ID.
                </span>
              )}
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Class index
              </span>
              <input
                value={classIndex}
                inputMode="numeric"
                onChange={(e) =>
                  setClassIndex(e.target.value.replace(/\D/g, ""))
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Asset ID
              </span>
              <input
                value={assetId}
                maxLength={32}
                onChange={(e) => setAssetId(e.target.value)}
                placeholder="e.g. SERIES-A"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Sale ID
              </span>
              <input
                value={saleId}
                inputMode="numeric"
                onChange={(e) => setSaleId(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          </div>
          <div
            className={`rounded-md border px-4 py-3 text-xs ${
              approvalState === "found" && !approvalExpired
                ? "border-brand-200 bg-brand-50 text-brand-900"
                : "border-amber-200 bg-amber-50 text-amber-900"
            }`}
          >
            <p className="font-semibold">Sale approval</p>
            {approvalState === "idle" && (
              <p className="mt-1">
                Enter the issuer, asset, class and sale id to load the approval.
              </p>
            )}
            {approvalState === "loading" && (
              <p className="mt-1">Loading the approval…</p>
            )}
            {approvalState === "error" && (
              <p className="mt-1">
                The approval could not be read. Check the inputs and the
                connection.
              </p>
            )}
            {approvalState === "missing" && (
              <p className="mt-1">
                No live approval for this share class and sale id: approve the
                sale from the application on{" "}
                <code className="rounded bg-amber-100 px-1">
                  /admin/applications
                </code>{" "}
                first.
              </p>
            )}
            {approval && (
              <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                <dt className="opacity-70">Payment mint ({detectNetwork()})</dt>
                <dd className="break-all font-mono">{approval.paymentMint}</dd>
                <dt className="opacity-70">Price per unit (base units)</dt>
                <dd className="font-mono">
                  {String(approval.minPricePerUnit)}
                  {approval.maxPricePerUnit !== approval.minPricePerUnit
                    ? ` – ${approval.maxPricePerUnit}`
                    : ""}
                </dd>
                <dt className="opacity-70">Maximum raise (base units)</dt>
                <dd className="font-mono">{String(approval.maxGrossRaise)}</dd>
                <dt className="opacity-70">Raise type</dt>
                <dd>
                  {isStartup
                    ? "Startup (open from the issuer launchpad)"
                    : "Established"}
                </dd>
                <dt className="opacity-70">Open by</dt>
                <dd>
                  {new Date(Number(approval.expiresAt) * 1000).toLocaleString(
                    "en-GB",
                  )}
                  {approvalExpired ? " — expired" : ""}
                </dd>
                <dt className="opacity-70">Approved by</dt>
                <dd className="break-all font-mono">{approval.approvedBy}</dd>
              </dl>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Price per unit (payment base units)
              </span>
              <input
                value={pricePerUnit}
                inputMode="numeric"
                onChange={(e) =>
                  setPricePerUnit(e.target.value.replace(/\D/g, ""))
                }
                aria-invalid={priceIsZero || priceOutOfRange ? true : undefined}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              {priceIsZero && (
                <span className="mt-1 block text-xs text-red-600">
                  Must be greater than zero.
                </span>
              )}
              {priceOutOfRange && approval && (
                <span className="mt-1 block text-xs text-red-600">
                  Must be between {String(approval.minPricePerUnit)} and{" "}
                  {String(approval.maxPricePerUnit)}.
                </span>
              )}
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Total units for sale
              </span>
              <input
                value={totalForSale}
                inputMode="numeric"
                onChange={(e) =>
                  setTotalForSale(e.target.value.replace(/\D/g, ""))
                }
                aria-invalid={totalTooLarge ? true : undefined}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              {maxUnits !== null && !priceOutOfRange && (
                <span
                  className={`mt-1 block text-xs ${totalTooLarge ? "text-red-600" : "text-slate-500"}`}
                >
                  At this price the approval allows at most{" "}
                  {maxUnits.toString()} units.
                </span>
              )}
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              End date (optional, leave blank for no end)
            </span>
            <input
              type="datetime-local"
              value={endTs}
              onChange={(e) => setEndTs(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <p className="text-[11px] text-slate-400">
            Payment token program is classic SPL Token (v0.1 assumption — USDC
            is classic SPL on Solana).
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={tx.isSending}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void open()}
            disabled={
              tx.isSending ||
              !issuerLegalId.trim() ||
              !assetId.trim() ||
              !approval ||
              approvalExpired ||
              isStartup ||
              price === null ||
              total === null ||
              priceIsZero ||
              priceOutOfRange ||
              totalTooLarge
            }
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {tx.isSending ? "Sending…" : "Open sale"}
          </button>
        </div>
      </div>
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
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd
        className={`mt-0.5 break-all text-slate-800 ${mono ? "font-mono text-xs" : "text-sm"}`}
      >
        {value}
      </dd>
    </div>
  );
}
