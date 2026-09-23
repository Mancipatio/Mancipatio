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
  getCancelOfferInstructionAsync,
  getCreateOfferInstructionAsync,
  getDepositToOfferEscrowInstruction,
  findPlatformPda,
  OfferStatus,
  type Asset,
  type Offer,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { remainingDeposit } from "@/lib/escrow-ledger";
import { hookTransferMetas } from "@/lib/hook-metas";
import { findOfferPda, findShareClassPda } from "@/lib/pdas";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonTable } from "@/components/skeleton";
import { useToast } from "@/lib/toast";

const TOKEN_2022_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

const STATUS_LABEL = ["Open", "Filled", "Cancelled", "Expired"];
const STATUS_BADGE: Record<number, string> = {
  0: "bg-emerald-100 text-emerald-800 border-emerald-200",
  1: "bg-slate-200 text-slate-800 border-slate-300",
  2: "bg-red-100 text-red-800 border-red-200",
  3: "bg-amber-100 text-amber-800 border-amber-200",
};

type ShareClassRef = {
  pda: string;
  mint: string;
  classIndex: number;
  asset: Asset;
};

export default function MyOffersPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<Offer | null>(null);
  const [fundTarget, setFundTarget] = useState<Offer | null>(null);
  const [myShareClasses, setMyShareClasses] = useState<ShareClassRef[]>([]);
  const [shareClassByMint, setShareClassByMint] = useState<
    Map<string, ShareClass>
  >(new Map());
  const [assetPdaMap, setAssetPdaMap] = useState<Map<string, Asset>>(new Map());
  // `${shareClass}-${offerId}` → derived Offer PDA, for the public taker link.
  const [offerPdaByKey, setOfferPdaByKey] = useState<Map<string, string>>(
    new Map(),
  );

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);

      const am = new Map<string, Asset>();
      for (const a of network.assets) {
        const [pda] = await findAssetPda({
          issuer: a.issuer,
          assetId: a.assetId,
        });
        am.set(pda.toString(), a);
      }
      setAssetPdaMap(am);

      const scm = new Map<string, ShareClass>();
      for (const sc of network.shareClasses) {
        scm.set(sc.mint.toString(), sc);
      }
      setShareClassByMint(scm);

      // Derive each offer's PDA so rows can deep-link to the public taker page.
      const opm = new Map<string, string>();
      for (const o of network.offers) {
        const pda = await findOfferPda(o.shareClass, o.offerId);
        opm.set(`${o.shareClass.toString()}-${o.offerId}`, pda.toString());
      }
      setOfferPdaByKey(opm);

      // Build dropdown of share classes the connected wallet currently holds.
      if (wallet) {
        const { loadHoldings } = await import("@/lib/holdings");
        const holdings = await loadHoldings(client.runtime.rpc, wallet);
        const mineByMint = new Set(holdings.map((h) => h.mint));
        const refs: ShareClassRef[] = [];
        for (const sc of network.shareClasses) {
          if (!sc.mintInitialized) continue;
          if (!mineByMint.has(sc.mint.toString())) continue;
          const asset = am.get(sc.asset.toString());
          if (!asset) continue;
          const scPda = await findShareClassPda(sc.asset, sc.classIndex);
          refs.push({
            pda: scPda.toString(),
            mint: sc.mint.toString(),
            classIndex: sc.classIndex,
            asset,
          });
        }
        setMyShareClasses(refs);
      }
    } catch {
      setFailed(true);
    }
  }, [client, wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const myOffers = useMemo(() => {
    if (!data || !wallet) return [];
    return data.offers
      .filter((o) => o.maker.toString() === wallet.toString())
      .sort((a, b) => Number(b.offerId - a.offerId));
  }, [data, wallet]);

  /**
   * Funds the offer escrow through `deposit_to_offer_escrow` — NOT a bare
   * `transfer_checked`.
   *
   * The program keeps a deposit ledger (`offer.deposited`) and this is the
   * only instruction that credits it. Everything downstream is decided from
   * that ledger, not from the escrow's token balance:
   *
   *   * `cancel_offer` / `expire_offer` refund at most `deposited` without a
   *     receiver-KYC check — so units pushed in with a raw transfer would be
   *     stuck behind a KYC check the maker may not pass, or simply not
   *     refunded at all if `deposited` is zero;
   *   * `take_offer` requires `deposited >= offer.amount`, so a raw-funded
   *     escrow is untakeable no matter what its balance says.
   *
   * The hook tail rides along as `remaining_accounts` (the on-chain handler
   * forwards it to the `transfer_checked` CPI), exactly like every other
   * program instruction that moves share units.
   */
  async function fundEscrow(offer: Offer, amount: bigint) {
    if (!wallet || !conn.wallet) return;
    const offerPda = await findOfferPda(offer.shareClass, offer.offerId);
    const pendingId = toast.showPending(
      `Depositing ${amount} unit(s) into offer #${offer.offerId} escrow…`,
    );
    try {
      const signer = walletSigner(conn.wallet);
      const [makerShareAta] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram: TOKEN_2022_ADDRESS,
        mint: offer.mint,
      });
      // Emergency-pause gate (read-only) — the last named account.
      const [platform] = await findPlatformPda();
      const baseIx = getDepositToOfferEscrowInstruction({
        platform,
        maker: signer,
        offer: offerPda,
        mint: offer.mint,
        escrow: offer.escrow,
        makerShareAccount: makerShareAta,
        tokenProgram: TOKEN_2022_ADDRESS,
        amount,
      });
      // Funding leg: maker wallet → offer escrow (owned by the offer PDA,
      // whose EscrowMarker exempts the escrow from receiver-KYC when gated).
      const fundIx = {
        ...baseIx,
        accounts: [
          ...baseIx.accounts,
          ...(await hookTransferMetas(client.runtime.rpc, offer.mint, {
            sourceTokenAccount: makerShareAta,
            destTokenAccount: offer.escrow,
            transferAuthority: wallet,
            sourceOwner: wallet,
            destOwner: offerPda,
          })),
        ],
      };
      const sig = await tx.send({ instructions: [fundIx], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig ?? "", { title: "Escrow funded" });
      setFundTarget(null);
      void refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to fund escrow", explainSendError(err));
    }
  }

  async function cancelOffer(offer: Offer, reason: string) {
    if (!wallet || !conn.wallet) return;
    const offerPda = await findOfferPda(offer.shareClass, offer.offerId);
    const pendingId = toast.showPending(
      `Cancelling offer #${offer.offerId}…`,
      reason,
    );
    try {
      const signer = walletSigner(conn.wallet);
      const [makerShareAta] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram: TOKEN_2022_ADDRESS,
        mint: offer.mint,
      });
      const createAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: wallet,
          mint: offer.mint,
          tokenProgram: TOKEN_2022_ADDRESS,
        });
      // escrowMarker (["escrow_marker", offer PDA]) is auto-derived by the
      // async builder — closed on-chain by this terminal path.
      const baseIx = await getCancelOfferInstructionAsync({
        maker: signer,
        offer: offerPda,
        mint: offer.mint,
        escrow: offer.escrow,
        makerShareAccount: makerShareAta,
        shareTokenProgram: TOKEN_2022_ADDRESS,
      });
      const cancelIx = {
        ...baseIx,
        accounts: [
          ...baseIx.accounts,
          // Refund leg: offer escrow (offer PDA) → maker wallet.
          ...(await hookTransferMetas(client.runtime.rpc, offer.mint, {
            sourceTokenAccount: offer.escrow,
            destTokenAccount: makerShareAta,
            transferAuthority: offerPda,
            sourceOwner: offerPda,
            destOwner: wallet,
          })),
        ],
      };
      const sig = await tx.send({
        instructions: [createAtaIx, cancelIx],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig ?? "", { title: "Offer cancelled" });
      setConfirmCancel(null);
      void refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to cancel", explainSendError(err));
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
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            OTC offers
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">
            My offers
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Sell share-class units to other holders through hook-aware OTC
            settlement.
          </p>
        </div>
        <button
          type="button"
          disabled={myShareClasses.length === 0}
          onClick={() => setShowCreate(true)}
          title={
            myShareClasses.length === 0
              ? "You need to hold at least one Manci share-class token before posting an offer."
              : undefined
          }
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          + Create offer
        </button>
      </div>

      {failed ? (
        <p className="mt-8 text-sm text-red-600">Failed to load.</p>
      ) : data === null ? (
        <div className="mt-8">
          <SkeletonTable rows={3} cols={5} />
        </div>
      ) : myOffers.length === 0 ? (
        <Empty
          onClick={() => setShowCreate(true)}
          canCreate={myShareClasses.length > 0}
        />
      ) : (
        <div className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Offer</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Deposited</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {myOffers.map((o, i) => {
                const sc = shareClassByMint.get(o.mint.toString());
                const asset = sc ? assetPdaMap.get(sc.asset.toString()) : undefined;
                const offerPda = offerPdaByKey.get(
                  `${o.shareClass.toString()}-${o.offerId}`,
                );
                // Ledgered deposit (`offer.deposited`), NOT the escrow token
                // balance: the program caps it at `offer.amount`, refunds at
                // most this much KYC-free and refuses a take below it.
                const remaining = remainingDeposit(o.amount, o.deposited);
                const fullyFunded = remaining === BigInt(0);
                return (
                  <tr key={i} className="text-slate-700">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {asset?.name ?? "—"}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                        offer #{String(o.offerId)} · {asset?.assetId ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {String(o.amount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      <span
                        className={
                          fullyFunded ? "text-emerald-700" : "text-amber-700"
                        }
                        title={
                          fullyFunded
                            ? "Escrow fully funded — the offer can be taken."
                            : `${remaining} more unit(s) must be deposited before this offer can be taken.`
                        }
                      >
                        {String(o.deposited)} / {String(o.amount)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {String(o.price)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[o.status] ?? STATUS_BADGE[0]}`}
                      >
                        {STATUS_LABEL[o.status] ?? "?"}
                      </span>
                    </td>
                    <td className="space-x-3 px-4 py-3 text-right text-xs">
                      {o.status === OfferStatus.Open && (
                        <>
                          {offerPda && (
                            <Link
                              href={`/marketplace/otc/${offerPda}`}
                              className="text-slate-600 underline-offset-2 hover:underline"
                            >
                              Take →
                            </Link>
                          )}
                          <button
                            type="button"
                            disabled={tx.isSending || fullyFunded}
                            onClick={() => setFundTarget(o)}
                            title={
                              fullyFunded
                                ? "The escrow already holds the full offer amount."
                                : undefined
                            }
                            className="text-slate-700 underline-offset-2 hover:underline disabled:opacity-50"
                          >
                            Fund escrow
                          </button>
                          <button
                            type="button"
                            disabled={tx.isSending}
                            onClick={() => setConfirmCancel(o)}
                            className="text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateOfferModal
          myShareClasses={myShareClasses}
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            void refresh();
            setShowCreate(false);
          }}
        />
      )}

      {fundTarget && (
        <FundEscrowModal
          offer={fundTarget}
          busy={tx.isSending}
          onClose={() => setFundTarget(null)}
          onConfirm={(amount) => fundEscrow(fundTarget, amount)}
        />
      )}

      {confirmCancel && (
        <ConfirmModal
          open
          onClose={() => setConfirmCancel(null)}
          onConfirm={(reason) => cancelOffer(confirmCancel, reason)}
          title={`Cancel offer #${confirmCancel.offerId}`}
          kind="warning"
          confirmLabel="Cancel offer"
          description={
            <p>
              Cancelling returns the escrowed share units to your wallet and
              marks the offer as Cancelled.
            </p>
          }
          busy={tx.isSending}
        />
      )}

      <p className="mt-6 text-xs text-slate-400">
        After creating an offer, fund the escrow with the share units you want
        to sell — always through <strong>Fund escrow</strong>, which records the
        deposit on-chain. Only recorded deposits are refunded to you on cancel
        or expiry, and an offer can only be taken once the recorded deposit
        reaches its full amount. Takers then buy through{" "}
        <Link href="/marketplace/otc" className="underline">
          /marketplace/otc
        </Link>
        .
      </p>
    </main>
  );
}

/**
 * Amount picker for `deposit_to_offer_escrow`.
 *
 * Deposits are ADDITIVE while the offer is `Open` and the program caps the
 * running total at `offer.amount` (over-funding would strand the excess: a
 * fill drains exactly `amount` and then no instruction accepts the offer
 * again). The input is therefore bounded by what is still outstanding —
 * offering more would only produce an on-chain `InvalidDepositAmount`.
 */
function FundEscrowModal({
  offer,
  busy,
  onClose,
  onConfirm,
}: {
  offer: Offer;
  busy: boolean;
  onClose: () => void;
  onConfirm: (amount: bigint) => void | Promise<void>;
}) {
  const remaining = remainingDeposit(offer.amount, offer.deposited);
  const [value, setValue] = useState(String(remaining));

  const parsed = /^\d+$/.test(value.trim()) ? BigInt(value.trim()) : null;
  const invalid =
    parsed === null || parsed === BigInt(0) || parsed > remaining;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Fund offer #{String(offer.offerId)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {String(offer.deposited)} of {String(offer.amount)} unit(s) already
            deposited — {String(remaining)} outstanding.
          </p>
        </div>
        <div className="space-y-3 px-5 py-4">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Units to deposit
            </span>
            <input
              value={value}
              inputMode="numeric"
              onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              Maximum {String(remaining)} — the on-chain ledger is capped at the
              offer amount, so anything beyond it is rejected.
            </span>
          </label>
          <p className="rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-[11px] text-brand-900">
            This records the deposit on-chain. Only recorded deposits come back
            to you on cancel or expiry, and the offer stays untakeable until the
            recorded total reaches {String(offer.amount)}.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (parsed !== null && !invalid) void onConfirm(parsed);
            }}
            disabled={busy || invalid}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? "Sending…" : "Deposit"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateOfferModal({
  myShareClasses,
  onClose,
  onSuccess,
}: {
  myShareClasses: ShareClassRef[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [selectedScPda, setSelectedScPda] = useState(
    myShareClasses[0]?.pda ?? "",
  );
  const [offerId, setOfferId] = useState("1");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [paymentMint, setPaymentMint] = useState("");
  const [expiryDate, setExpiryDate] = useState("");

  const selectedRef = myShareClasses.find((r) => r.pda === selectedScPda);

  async function create() {
    if (
      !wallet ||
      !conn.wallet ||
      !selectedRef ||
      !amount.trim() ||
      !price.trim() ||
      !paymentMint.trim()
    )
      return;
    const pendingId = toast.showPending(`Creating offer #${offerId}…`);
    try {
      const signer = walletSigner(conn.wallet);
      const ix = await getCreateOfferInstructionAsync({
        maker: signer,
        shareClass: selectedRef.pda as Address,
        mint: selectedRef.mint as Address,
        paymentMint: paymentMint.trim() as Address,
        tokenProgram: TOKEN_2022_ADDRESS,
        offerId: BigInt(offerId || "0"),
        amount: BigInt(amount),
        price: BigInt(price),
        expiresAt: expiryDate.trim()
          ? BigInt(Math.floor(new Date(expiryDate).getTime() / 1000))
          : BigInt(0),
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig ?? "", { title: "Offer created" });
      onSuccess();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to create offer", explainSendError(err));
      console.error("[create_offer]", err);
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
            Create OTC offer
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Sell share-class tokens you currently hold to another wallet.
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Share class
            </span>
            <select
              value={selectedScPda}
              onChange={(e) => setSelectedScPda(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              {myShareClasses.map((r) => (
                <option key={r.pda} value={r.pda}>
                  {r.asset.name} · #{r.classIndex} · {r.asset.assetId}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-slate-400">
              Only share classes you currently hold appear here.
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Offer ID
              </span>
              <input
                value={offerId}
                inputMode="numeric"
                onChange={(e) => setOfferId(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Amount (share units)
              </span>
              <input
                value={amount}
                inputMode="numeric"
                onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Total price (payment units)
              </span>
              <input
                value={price}
                inputMode="numeric"
                onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Payment mint
            </span>
            <input
              value={paymentMint}
              onChange={(e) => setPaymentMint(e.target.value)}
              placeholder="USDC mint address"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono text-xs focus:border-slate-400 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Expires at (optional)
            </span>
            <input
              type="datetime-local"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              After expiry the offer can no longer be taken and anyone can
              trigger the escrow refund.
            </span>
          </label>

          <p className="text-[11px] text-slate-400">
            After creation, click <strong>Fund escrow</strong> on the row to
            move your share units into the escrow account. Without funding the
            offer can&apos;t be taken.
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
            onClick={() => void create()}
            disabled={
              tx.isSending ||
              !selectedRef ||
              !amount.trim() ||
              !price.trim() ||
              !paymentMint.trim()
            }
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {tx.isSending ? "Sending…" : "Create offer"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Empty({
  onClick,
  canCreate,
}: {
  onClick: () => void;
  canCreate: boolean;
}) {
  return (
    <div className="mt-8 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
      <p className="text-sm text-slate-600">
        You haven&apos;t posted any OTC offers yet.
      </p>
      {canCreate ? (
        <button
          type="button"
          onClick={onClick}
          className="mt-4 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Create your first offer →
        </button>
      ) : (
        <p className="mt-2 text-xs text-slate-400">
          You need to hold at least one Manci share-class token first.
        </p>
      )}
    </div>
  );
}
