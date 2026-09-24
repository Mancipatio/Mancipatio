"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { type Address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findAssetPda,
  getDepositOtcPaymentInstructionAsync,
  getExpireOtcDealInstructionAsync,
  OtcDealStatus,
  type Asset,
} from "@/lib/generated/asset_registry";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { hookTransferMetas } from "@/lib/hook-metas";
import { buildDepositOtcAssetInstructions } from "@/lib/otc-transactions";
import { findShareClassPda } from "@/lib/pdas";
import {
  detectTokenProgram,
  listOtcRequestsByWallet,
  loadOtcDeals,
  withArchivedOtcDeals,
  TOKEN_2022_PROGRAM,
  type LoadedOtcDeal,
  type OtcRequest,
} from "@/lib/otc";
import { walletSigner } from "@/lib/wallet-signer";
import { detectNetwork } from "@/lib/network";
import { inspectPaymentMint } from "@/lib/transaction-builders";
import { explainSendError } from "@/lib/tx-error";
import { SkeletonTable } from "@/components/skeleton";
import { ConfirmModal } from "@/components/confirm-modal";
import { useToast } from "@/lib/toast";

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

function fmtCountdown(expiresAt: bigint, nowMs: number): string {
  const ms = Number(expiresAt) * 1000 - nowMs;
  if (ms <= 0) return "expired";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function MyDealsPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [deals, setDeals] = useState<
    (LoadedOtcDeal & { closed?: boolean })[] | null
  >(null);
  const [requests, setRequests] = useState<OtcRequest[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [labelByShareClass, setLabelByShareClass] = useState<
    Map<string, string>
  >(new Map());
  // deal PDA → payment token program + connected wallet's payment balance.
  const [payInfo, setPayInfo] = useState<
    Map<string, { program: Address; balance: bigint | null }>
  >(new Map());
  // "now" captured at load time (render must stay pure) — expiry checks.
  const [nowMs, setNowMs] = useState(0);
  // Funds-moving actions go through a confirm dialog (SCOPE 1.6).
  const [confirmAction, setConfirmAction] = useState<{
    kind: "asset" | "payment" | "expire";
    row: LoadedOtcDeal;
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!wallet) {
      setDeals([]);
      setRequests([]);
      return;
    }
    try {
      const rpc = client.runtime.rpc;
      // 2D: archived (rent-reclaimed) deals stay visible as history.
      const all = await withArchivedOtcDeals(await loadOtcDeals(rpc));
      setNowMs(Date.now());
      const mine = all.filter(
        (d) =>
          d.deal.buyer.toString() === wallet.toString() ||
          d.deal.seller.toString() === wallet.toString(),
      );
      setDeals(mine);
      setRequests(await listOtcRequestsByWallet(conn.wallet));

      // Asset-name labels (share-class PDA → asset name).
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
            asset
              ? `${asset.name} · #${sc.classIndex}`
              : `class #${sc.classIndex}`,
          );
        }
        setLabelByShareClass(labels);
      } catch {
        /* labels are best-effort */
      }

      // Payment token program per deal + the buyer's payment balance for
      // deals where the connected wallet still owes the payment leg.
      const info = new Map<string, { program: Address; balance: bigint | null }>();
      for (const row of mine) {
        const program = await detectTokenProgram(rpc, row.deal.paymentMint);
        let balance: bigint | null = null;
        if (
          row.deal.buyer.toString() === wallet.toString() &&
          row.deal.status === OtcDealStatus.Open &&
          !row.deal.paymentDeposited
        ) {
          try {
            const [ata] = await findAssociatedTokenPda({
              owner: wallet,
              tokenProgram: program,
              mint: row.deal.paymentMint,
            });
            const res = await rpc.getTokenAccountBalance(ata).send();
            balance = BigInt(res.value.amount);
          } catch {
            balance = null;
          }
        }
        info.set(row.pda.toString(), { program, balance });
      }
      setPayInfo(info);
    } catch {
      setFailed(true);
    }
  }, [client, wallet, conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const sortedDeals = useMemo(
    () =>
      (deals ?? []).slice().sort((a, b) => Number(b.deal.dealId - a.deal.dealId)),
    [deals],
  );

  const pendingRequests = useMemo(
    () => (requests ?? []).filter((r) => r.status === "requested"),
    [requests],
  );

  /** The permissive owner check (exits and the seller's leg); throws, never guesses. */
  async function payTokenProgramFor(row: LoadedOtcDeal): Promise<Address> {
    return (
      payInfo.get(row.pda.toString())?.program ??
      (await detectTokenProgram(client.runtime.rpc, row.deal.paymentMint))
    );
  }

  /**
   * Seller deposits the share units (deposit leg + settle leg hook tails,
   * settlement ATAs created idempotently) — built by
   * buildDepositOtcAssetInstructions, which the size test measures.
   */
  async function depositAsset(row: LoadedOtcDeal) {
    if (!wallet || !conn.wallet) return;
    const { pda, deal } = row;
    const pendingId = toast.showPending(
      `Depositing ${String(deal.amount)} share units…`,
    );
    try {
      const signer = walletSigner(conn.wallet);
      const payTokenProgram = await payTokenProgramFor(row);
      const instructions = await buildDepositOtcAssetInstructions(
        client.runtime.rpc,
        {
          seller: signer,
          dealPda: pda,
          deal,
          paymentTokenProgram: payTokenProgram,
        },
      );
      const sig = await tx.send({
        instructions,
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig ?? "", {
        title: deal.paymentDeposited ? "Deal settled" : "Asset deposited",
      });
      void refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to deposit asset", explainSendError(err));
      console.error("[deposit_otc_asset]", err);
    }
  }

  /**
   * Buyer deposits the payment. remaining_accounts, per
   * deposit_otc_payment.rs: only read when this deposit completes the pair —
   * the settle leg's hook tail (source authority = deal PDA, mode-aware).
   * Always passed.
   */
  async function depositPayment(row: LoadedOtcDeal) {
    if (!wallet || !conn.wallet) return;
    const { pda, deal } = row;
    const pendingId = toast.showPending(
      `Depositing ${String(deal.price)} payment units…`,
    );
    try {
      const signer = walletSigner(conn.wallet);
      // Entry path: the payment mint must pass the plain-payment rule (and,
      // on mainnet, the allowlist) before the buyer deposits. A deal whose
      // mint fails it expires and refunds through the exit paths.
      const { owner: payTokenProgram } = await inspectPaymentMint(
        client.runtime.rpc,
        deal.paymentMint,
        detectNetwork(),
        { commitment: "finalized", abortSignal: AbortSignal.timeout(10_000) },
      );
      const [buyerPaymentAta] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram: payTokenProgram,
        mint: deal.paymentMint,
      });
      // Settlement destination accounts — required by the Rust account
      // structs even when this deposit doesn't settle; create idempotently.
      const [buyerShareAta] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram: TOKEN_2022_PROGRAM,
        mint: deal.mint,
      });
      const [sellerPaymentAta] = await findAssociatedTokenPda({
        owner: deal.seller,
        tokenProgram: payTokenProgram,
        mint: deal.paymentMint,
      });
      const createBuyerShareAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: wallet,
          mint: deal.mint,
          tokenProgram: TOKEN_2022_PROGRAM,
        });
      const createSellerPaymentAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: deal.seller,
          mint: deal.paymentMint,
          tokenProgram: payTokenProgram,
        });
      // escrowMarker (["escrow_marker", deal PDA]) is auto-derived by the
      // async builder — closed on-chain when this deposit settles the deal.
      const baseIx = await getDepositOtcPaymentInstructionAsync({
        buyer: signer,
        deal: pda,
        mint: deal.mint,
        paymentMint: deal.paymentMint,
        buyerPaymentAccount: buyerPaymentAta,
        paymentEscrow: deal.paymentEscrow,
        assetEscrow: deal.assetEscrow,
        buyerShareAccount: buyerShareAta,
        sellerPaymentAccount: sellerPaymentAta,
        shareTokenProgram: TOKEN_2022_PROGRAM,
        paymentTokenProgram: payTokenProgram,
      });
      const depositIx = {
        ...baseIx,
        accounts: [
          ...baseIx.accounts,
          // Settle leg: asset escrow (deal PDA) → buyer (this wallet).
          ...(await hookTransferMetas(client.runtime.rpc, deal.mint, {
            sourceTokenAccount: deal.assetEscrow,
            destTokenAccount: buyerShareAta,
            transferAuthority: pda,
            sourceOwner: pda,
            destOwner: wallet,
          })),
        ],
      };
      const sig = await tx.send({
        instructions: [createBuyerShareAtaIx, createSellerPaymentAtaIx, depositIx],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig ?? "", {
        title: deal.assetDeposited ? "Deal settled" : "Payment deposited",
      });
      void refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to deposit payment", explainSendError(err));
      console.error("[deposit_otc_payment]", err);
    }
  }

  /** Permissionless refund of an expired open deal (expire_otc_deal). */
  async function expireDeal(row: LoadedOtcDeal) {
    if (!wallet || !conn.wallet) return;
    const { pda, deal } = row;
    const pendingId = toast.showPending(
      `Refunding expired deal #${String(deal.dealId)}…`,
    );
    try {
      const signer = walletSigner(conn.wallet);
      const payTokenProgram = await payTokenProgramFor(row);
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
      // escrowMarker (["escrow_marker", deal PDA]) is auto-derived by the
      // async builder — closed on-chain by this terminal path.
      const baseIx = await getExpireOtcDealInstructionAsync({
        payer: signer,
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
      // remaining_accounts: the refund leg's hook tail (source authority =
      // deal PDA) — used only if the asset leg is refunded.
      const expireIx = {
        ...baseIx,
        accounts: [
          ...baseIx.accounts,
          ...(await hookTransferMetas(client.runtime.rpc, deal.mint, {
            sourceTokenAccount: deal.assetEscrow,
            destTokenAccount: sellerShareAta,
            transferAuthority: pda,
            sourceOwner: pda,
            destOwner: deal.seller,
          })),
        ],
      };
      const sig = await tx.send({
        instructions: [createSellerShareAtaIx, createBuyerPaymentAtaIx, expireIx],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig ?? "", { title: "Expired deal refunded" });
      void refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to refund deal", explainSendError(err));
      console.error("[expire_otc_deal]", err);
    }
  }

  if (!conn.isReady || !wallet) {
    return (
      <main className="min-w-0 flex-1">
        <WalletRequired />
      </main>
    );
  }

  return (
    <main className="min-w-0 flex-1">
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
        OTC escrow
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-slate-900">My deals</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        Bilateral escrow deals opened by the platform. Each side deposits its
        leg; once both are funded the swap settles automatically. If a deal
        expires unfunded, either side can trigger the refund.
      </p>

      {failed ? (
        <p className="mt-8 text-sm text-red-600">Failed to load.</p>
      ) : deals === null || requests === null ? (
        <div className="mt-8">
          <SkeletonTable rows={3} cols={6} />
        </div>
      ) : (
        <>
          {pendingRequests.length > 0 && (
            <section className="mt-8">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Waiting for the platform
              </h2>
              <div className="mt-3 space-y-2">
                {pendingRequests.map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        {r.asset_label || shortAddr(r.mint)} ·{" "}
                        {r.buyer_wallet === wallet.toString()
                          ? "you are the buyer"
                          : "you are the seller"}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                        {String(r.amount)} units for {String(r.price)} · with{" "}
                        {shortAddr(
                          r.buyer_wallet === wallet.toString()
                            ? r.seller_wallet
                            : r.buyer_wallet,
                        )}
                      </p>
                    </div>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-500">
                      Requested — waiting for the platform to create the escrow
                      contract
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {sortedDeals.length === 0 && pendingRequests.length === 0 ? (
            <div className="mt-8 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
              <p className="text-sm text-slate-600">
                No OTC escrow deals yet. Request one from a holder post on the{" "}
                <Link href="/markets/resell" className="underline">
                  resell board
                </Link>
                .
              </p>
            </div>
          ) : sortedDeals.length > 0 ? (
            <section className="mt-8">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                On-chain deals
              </h2>
              <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">Deal</th>
                      <th className="px-4 py-3 text-right font-medium">
                        Amount / price
                      </th>
                      <th className="px-4 py-3 font-medium">Deposits</th>
                      <th className="px-4 py-3 font-medium">Expires</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 text-right font-medium">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sortedDeals.map((row) => {
                      const { pda, deal } = row;
                      const isBuyer =
                        deal.buyer.toString() === wallet.toString();
                      const isOpen = deal.status === OtcDealStatus.Open;
                      const expired =
                        isOpen &&
                        deal.expiresAt > BigInt(0) &&
                        nowMs > Number(deal.expiresAt) * 1000;
                      const info = payInfo.get(pda.toString());
                      const owes =
                        isBuyer && isOpen && !deal.paymentDeposited && !expired;
                      const paymentMissing = !owes
                        ? null
                        : !info || info.balance === null
                          ? "You have no payment-token account for this mint. Create one and fund it before depositing."
                          : info.balance < deal.price
                            ? `Your payment balance (${String(info.balance)}) is below the price (${String(deal.price)}).`
                            : null;
                      return (
                        <tr key={pda.toString()} className="text-slate-700">
                          <td className="px-4 py-3">
                            <p className="font-medium text-slate-900">
                              {labelByShareClass.get(
                                deal.shareClass.toString(),
                              ) ?? shortAddr(deal.mint.toString())}
                            </p>
                            <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                              deal #{String(deal.dealId)} · you are the{" "}
                              {isBuyer ? "buyer" : "seller"}
                            </p>
                            <p className="mt-0.5 font-mono text-[11px] text-slate-400">
                              pay mint {shortAddr(deal.paymentMint.toString())}
                            </p>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs">
                            <p>{String(deal.amount)} units</p>
                            <p className="mt-0.5 text-slate-500">
                              {String(deal.price)} payment
                            </p>
                          </td>
                          {/* Ledgered amounts, not just the flags: the refund
                              paths pay out at most these numbers to each
                              depositor, so they are what a participant needs
                              to see. */}
                          <td className="px-4 py-3 text-xs">
                            <span
                              className={`mr-1 inline-flex rounded-full border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                                deal.assetDeposited
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : "border-slate-200 bg-slate-50 text-slate-400"
                              }`}
                              title={`Recorded asset deposit: ${deal.assetDepositedAmount} of ${deal.amount} unit(s) — refunds to the seller are capped at this.`}
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
                              title={`Recorded payment deposit: ${deal.paymentDepositedAmount} of ${deal.price} base unit(s) — refunds to the buyer are capped at this.`}
                            >
                              pay {String(deal.paymentDepositedAmount)}/
                              {String(deal.price)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-500">
                            {deal.expiresAt > BigInt(0)
                              ? expired
                                ? "expired — refundable"
                                : `in ${fmtCountdown(deal.expiresAt, nowMs)}`
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
                            {row.closed && (
                              <span className="ml-2 text-[11px] text-slate-500">
                                closed (rent reclaimed)
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right text-xs">
                            {isOpen && !expired && !isBuyer && !deal.assetDeposited && (
                              <button
                                type="button"
                                disabled={tx.isSending}
                                onClick={() =>
                                  setConfirmAction({ kind: "asset", row })
                                }
                                className="text-slate-700 underline-offset-2 hover:underline disabled:opacity-50"
                              >
                                Deposit asset
                              </button>
                            )}
                            {isOpen && !expired && isBuyer && !deal.paymentDeposited && (
                              <>
                                <button
                                  type="button"
                                  disabled={tx.isSending || !!paymentMissing}
                                  onClick={() =>
                                    setConfirmAction({ kind: "payment", row })
                                  }
                                  className="text-slate-700 underline-offset-2 hover:underline disabled:opacity-50"
                                >
                                  Deposit payment
                                </button>
                                {paymentMissing && (
                                  <p className="mt-1 max-w-[220px] text-[11px] leading-snug text-amber-700">
                                    {paymentMissing}
                                  </p>
                                )}
                              </>
                            )}
                            {expired && (
                              <button
                                type="button"
                                disabled={tx.isSending}
                                onClick={() =>
                                  setConfirmAction({ kind: "expire", row })
                                }
                                className="text-amber-700 underline-offset-2 hover:underline disabled:opacity-50"
                              >
                                Refund expired deal
                              </button>
                            )}
                            {!isOpen && (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      )}

      {confirmAction && (
        <ConfirmModal
          open
          onClose={() => setConfirmAction(null)}
          onConfirm={() => {
            const { kind, row } = confirmAction;
            setConfirmAction(null);
            if (kind === "asset") void depositAsset(row);
            else if (kind === "payment") void depositPayment(row);
            else void expireDeal(row);
          }}
          title={
            confirmAction.kind === "asset"
              ? "Deposit share units into escrow"
              : confirmAction.kind === "payment"
                ? "Deposit payment into escrow"
                : "Refund expired deal"
          }
          kind={confirmAction.kind === "expire" ? "warning" : "info"}
          requireReason={false}
          confirmLabel={
            confirmAction.kind === "expire" ? "Refund" : "Deposit"
          }
          description={
            <p>
              {confirmAction.kind === "asset"
                ? `Deposit ${String(confirmAction.row.deal.amount)} share units of deal #${String(confirmAction.row.deal.dealId)} into escrow. Once both legs are funded the swap settles atomically.`
                : confirmAction.kind === "payment"
                  ? `Deposit ${String(confirmAction.row.deal.price)} payment units into deal #${String(confirmAction.row.deal.dealId)}. Once both legs are funded the swap settles atomically.`
                  : `Trigger the expiry of deal #${String(confirmAction.row.deal.dealId)} and refund whichever leg was deposited to its depositor.`}
            </p>
          }
          busy={tx.isSending}
        />
      )}
    </main>
  );
}
