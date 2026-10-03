"use client";

import { SalePublicationRecovery } from "./publication-recovery";
import { detectNetwork } from "@/lib/network";
import { featureDisabledMessage, features } from "@/lib/features";
import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
import { USDC } from "@/lib/payment-mints";
import { roomToCreate } from "@/lib/distribution-supply";
import { openApprovedSale, OpenSaleError } from "@/lib/open-sale";
import { approvalUnits, paymentAmountLabel, usdcDecimalsOf } from "@/lib/public-sale";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  findAssetPda,
  findIssuerPda,
  RaiseType,
  SaleStatus,
  type Issuer,
  type Sale,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { buildCloseSaleInstruction, buildOpenPayoutVaultInstruction } from "@/lib/proceeds-exits";
import { saleEndInputBounds } from "@/lib/deadline-bounds";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { findSalePda, findShareClassPda } from "@/lib/pdas";
import { formatTokens } from "@/lib/tokenize-shares";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { SkeletonTable } from "@/components/skeleton";
import { ConfirmModal } from "@/components/confirm-modal";
import { useToast } from "@/lib/toast";
import { fetchPlainPaymentMintTokenProgram } from "@/lib/transaction-builders";
import { syncSaleIfNeeded } from "@/lib/issuer-authority";
import { useIssuerFreezes } from "@/lib/use-issuer-freeze";
import { ProceedsFrozenNotice } from "@/components/proceeds-frozen-notice";
import {
  isApprovalLive,
  listIssuerSaleApprovals,
  maxUnitsAt,
  mySaleApprovals,
  fromBaseUnits,
  toBaseUnits,
  type MyApproval,
  type SaleApprovalAccount,
} from "@/lib/sale-approvals";

/** Startup (vested payout-vault) raises are feature-flagged per network
 *  (lib/features.ts; off on mainnet unless NEXT_PUBLIC_FEATURE_STARTUP_RAISES
 *  =true). With it off, a startup sale is neither opened nor closed into a
 *  payout vault from this page — proceeds stay in the program escrow. */
const STARTUP_RAISES = features().startupRaises;
const ISSUER_ROTATION = features().issuerRotation;

const CLASS_TYPE = [
  "Common",
  "Preferred A",
  "Preferred B",
  "Senior debt",
  "Junior debt",
  "Rev-share tier",
  "Royalty tier",
];

type ScMeta = { assetName: string; assetId: string; classIndex: number; sc: ShareClass };

export default function MyLaunchpadPage() {
  return (
    <Suspense fallback={null}>
      <LaunchpadInner />
    </Suspense>
  );
}

function LaunchpadInner() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const searchParams = useSearchParams();
  // /issuer/launchpad?application=ID (from /apply or the admin queue) opens
  // the form and preselects the approval Manci granted for that application.
  const applicationId = searchParams.get("application");
  const wallet = conn.wallet?.account.address;
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [me, setMe] = useState<Issuer | null>(null);
  const [issuerPda, setIssuerPda] = useState<Address | null>(null);
  const [myShareClasses, setMyShareClasses] = useState<ShareClass[]>([]);
  const [scPdaMap, setScPdaMap] = useState<Map<string, ScMeta>>(new Map());
  // Live (unexpired, unused) Admin sale approvals of this issuer, read from
  // chain. open_sale consumes one; without one no sale can be opened.
  const [approvals, setApprovals] = useState<SaleApprovalAccount[] | null>(null);
  const [showOpen, setShowOpen] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);
  const [confirmClose, setConfirmClose] = useState<Sale | null>(null);
  const issuerFreeze = useIssuerFreezes({ issuers: [issuerPda] });

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);
      if (wallet) {
        const found = network.issuers.find(
          (i) => i.authority.toString() === wallet.toString(),
        );
        setMe(found ?? null);
        if (found) {
          const [pda] = await findIssuerPda({
            legalEntityId: found.legalEntityId,
          });
          setIssuerPda(pda);
          const myAssets = network.assets.filter(
            (a) => a.issuer.toString() === pda.toString(),
          );
          const m = new Map<string, ScMeta>();
          const mySc: ShareClass[] = [];
          for (const a of myAssets) {
            const [apda] = await findAssetPda({
              issuer: a.issuer,
              assetId: a.assetId,
            });
            for (const sc of network.shareClasses) {
              if (sc.asset.toString() !== apda.toString()) continue;
              const scPda = await findShareClassPda(apda, sc.classIndex);
              m.set(scPda.toString(), {
                assetName: a.name,
                assetId: a.assetId,
                classIndex: sc.classIndex,
                sc,
              });
              mySc.push(sc);
            }
          }
          setScPdaMap(m);
          setMyShareClasses(mySc);
          try {
            setApprovals(
              (await listIssuerSaleApprovals(client.runtime.rpc, pda)).filter(
                (a) => isApprovalLive(a) && m.has(a.shareClass.toString()),
              ),
            );
          } catch {
            setApprovals([]);
          }
        }
      }
    } catch {
      setFailed(true);
    }
  }, [client, wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Arriving from an approved application: open the form once approvals load.
  useEffect(() => {
    if (!applicationId || autoOpened || approvals === null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoOpened(true);
    setShowOpen(true);
  }, [applicationId, autoOpened, approvals]);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.sales
      .filter((s) => scPdaMap.has(s.shareClass.toString()))
      .sort((a, b) => Number(b.saleId - a.saleId));
  }, [data, scPdaMap]);

  // Open Startup sales that can't be closed into a vested vault from here
  // while startup raises are off (opened while the flag was on, or outside
  // this UI). Explained in a visible note above the table — the disabled
  // Close & vest button alone would give no reason on touch or keyboard.
  const stuckStartupSales = STARTUP_RAISES
    ? 0
    : rows.filter(
        (s) => s.status === SaleStatus.Open && s.raiseType === RaiseType.Startup,
      ).length;

  const verified = me?.kybStatus === 1;
  const mintableScs = myShareClasses.filter((sc) => sc.mintInitialized);
  // D1: a frozen issuer can neither open nor close a sale (6143); the send
  // path refuses again before the wallet opens (lib/proceeds-gate.ts).
  const proceedsFrozen = issuerFreeze.isFrozen({ issuer: issuerPda }) === true;
  const canOpen = verified && mintableScs.length > 0 && !proceedsFrozen;

  // After a sale closes (instant close_sale for Mature, or the
  // open_payout_vault close flow for Startup) the server alone books what was
  // sold against the raise cap, at the FX rate locked when Manci approved the
  // sale and at the proven close date: the indexer enqueues the closed sale
  // and the retry worker books it (Talas 5.1). Nothing to do here.

  async function closeSale(s: Sale) {
    if (!wallet || !conn.wallet) return;
    const isStartup = s.raiseType === RaiseType.Startup;
    if (isStartup && !STARTUP_RAISES) {
      toast.showError(
        "Startup raises unavailable",
        `${featureDisabledMessage("startupRaises")} The sale stays open and its proceeds stay in escrow — contact the Manci team.`,
      );
      setConfirmClose(null);
      return;
    }
    const pendingId = toast.showPending(
      isStartup
        ? `Closing sale #${s.saleId} & opening vested vault…`
        : `Closing sale #${s.saleId}…`,
    );
    try {
      const signer = walletSigner(conn.wallet);
      const salePda = await findSalePda(s.shareClass, s.saleId);
      const paymentTokenProgram = await fetchPlainPaymentMintTokenProgram(client.runtime.rpc, s.paymentMint);
      // 2C-2: a sale opened under a previous issuer key still names it; copy
      // the live key in first (atomic with the close below).
      const syncIxs =
        ISSUER_ROTATION && s.authority !== wallet
          ? await syncSaleIfNeeded(client.runtime.rpc, {
              address: salePda,
              shareClass: s.shareClass,
              authority: s.authority,
            })
          : [];

      if (isStartup) {
        // STARTUP raises do NOT sweep proceeds to the founder. Instead the
        // proceeds escrow is swept into a program-owned PayoutVault escrow that
        // releases on a vesting schedule (open_payout_vault: sale.status==Open
        // && raise_type==Startup → vault init, sale → Closed). The founder draws
        // tranches later from /issuer/payouts.
        const openVaultIx = await buildOpenPayoutVaultInstruction(client.runtime.rpc, {
          authority: signer,
          sale: { address: salePda, shareClass: s.shareClass, proceeds: s.proceeds, paymentMint: s.paymentMint },
          paymentTokenProgram,
          metadataHash: new Uint8Array(32),
        });
        const sig = await tx.send({
          instructions: [...syncIxs, openVaultIx],
          feePayer: signer,
        });
        toast.dismiss(pendingId);
        toast.showTx(sig, { title: "Vault opened" });
        setConfirmClose(null);
        await refresh();
        return;
      }

      // Established / Mature raises: instant disbursement — sweep proceeds
      // straight to the founder's payment ATA and close the sale.
      const [destAta] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram: paymentTokenProgram,
        mint: s.paymentMint,
      });
      const createDestAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: wallet,
          mint: s.paymentMint,
          tokenProgram: paymentTokenProgram,
        });
      // The pause gate, the issuer's proceeds freeze and both parties'
      // blocklist entries (lib/proceeds-exits).
      const closeIx = await buildCloseSaleInstruction(client.runtime.rpc, {
        authority: signer,
        sale: { address: salePda, shareClass: s.shareClass, proceeds: s.proceeds, paymentMint: s.paymentMint },
        destination: destAta,
        destinationOwner: wallet,
        paymentTokenProgram,
      });
      const sig = await tx.send({
        instructions: [...syncIxs, createDestAtaIx, closeIx],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Sale closed" });
      setConfirmClose(null);
      await refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        isStartup ? "Failed to open vault" : "Failed to close sale",
        explainSendError(err),
      );
    }
  }

  if (!wallet)
    return (
      <main>
        <WalletRequired />
      </main>
    );

  return (
    <main className="min-w-0 flex-1">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            My sales
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">
            Primary sales
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Open or closed launchpad sales under your share classes.
          </p>
        </div>
        <button
          type="button"
          disabled={!canOpen}
          onClick={() => setShowOpen(true)}
          title={
            !verified
              ? "Verify KYB first."
              : mintableScs.length === 0
                ? "Initialize a share-class mint first."
                : proceedsFrozen
                  ? "Manci has frozen this issuer's proceeds: no sale can be opened until the Super Admin lifts the freeze."
                  : undefined
          }
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          + Open sale
        </button>
      </div>

      {!verified && me && (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          KYB pending — sale creation locked.
        </div>
      )}
      {proceedsFrozen && (
        <ProceedsFrozenNotice className="mt-6" closed="no sale can be opened or closed, and no payout vault opened," />
      )}
      {verified && mintableScs.length === 0 && (
        <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
          You need at least one share class with an initialized Token-2022 mint
          before opening a sale.{" "}
          <Link
            href="/issuer/share-classes"
            className="font-semibold underline"
          >
            Go to share classes →
          </Link>
        </div>
      )}
      {verified && approvals !== null && approvals.length > 0 && (
        <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
          Manci approved {approvals.length === 1 ? "a sale" : `${approvals.length} sales`} for
          your share classes. Use &quot;+ Open sale&quot; to open{" "}
          {approvals.length === 1 ? "it" : "them"} before the approval expires.
        </div>
      )}

      <SalePublicationRecovery />

      {failed ? (
        <p className="mt-8 text-sm text-red-600">Failed to load.</p>
      ) : data === null ? (
        <div className="mt-8">
          <SkeletonTable rows={3} cols={5} />
        </div>
      ) : !me ? (
        <NotIssuer />
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <>
        {stuckStartupSales > 0 && (
          <div
            id="startup-close-unavailable"
            className="mt-8 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900"
          >
            <p className="font-semibold">Startup raises unavailable</p>
            <p className="mt-1 text-amber-700">
              {featureDisabledMessage("startupRaises")}{" "}
              {stuckStartupSales === 1
                ? "Your open startup sale can't"
                : `Your ${stuckStartupSales} open startup sales can't`}{" "}
              be closed and vested from this page, so the proceeds stay in the
              program escrow. Contact the Manci team.
            </p>
          </div>
        )}
        <div className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Sale</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 text-right font-medium">
                  Sold / total
                </th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((s, i) => {
                const asset = scPdaMap.get(s.shareClass.toString());
                const isOpen = s.status === SaleStatus.Open;
                const pct =
                  s.totalForSale > BigInt(0)
                    ? Number((s.sold * BigInt(1000)) / s.totalForSale) / 10
                    : 0;
                return (
                  <tr key={i} className="text-slate-700">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {asset?.assetName ?? "—"}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        sale #{String(s.saleId)} · {asset?.assetId ?? "—"} ·
                        class #{asset?.classIndex ?? "?"}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {paymentAmountLabel(s.pricePerUnit, s.paymentMint, USDC[detectNetwork()]?.mint)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <p className="font-mono">
                        {String(s.sold)} / {String(s.totalForSale)}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {pct.toFixed(1)}%
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          isOpen
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-slate-300 bg-slate-200 text-slate-700"
                        }`}
                      >
                        {isOpen ? "Open" : "Closed"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isOpen && (
                        <button
                          type="button"
                          disabled={
                            tx.isSending ||
                            proceedsFrozen ||
                            (s.raiseType === RaiseType.Startup && !STARTUP_RAISES)
                          }
                          title={
                            proceedsFrozen
                              ? "Proceeds frozen: the sale cannot be closed until the Super Admin lifts the freeze."
                              : s.raiseType === RaiseType.Startup && !STARTUP_RAISES
                                ? featureDisabledMessage("startupRaises")
                                : undefined
                          }
                          aria-describedby={
                            s.raiseType === RaiseType.Startup && !STARTUP_RAISES
                              ? "startup-close-unavailable"
                              : undefined
                          }
                          onClick={() => setConfirmClose(s)}
                          className="text-xs text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          {s.raiseType === RaiseType.Startup
                            ? "Close & vest"
                            : "Close"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}

      {showOpen &&
        me &&
        issuerPda &&
        (approvals && approvals.length > 0 ? (
          <OpenSaleModal
            issuerPda={issuerPda}
            scPdaMap={scPdaMap}
            approvals={approvals}
            sales={data?.sales ?? []}
            preselectApplicationId={applicationId}
            onClose={() => setShowOpen(false)}
            onSuccess={() => {
              void refresh();
              setShowOpen(false);
            }}
          />
        ) : (
          <NoApprovalDialog
            loading={approvals === null}
            onClose={() => setShowOpen(false)}
          />
        ))}

      {confirmClose && (
        <ConfirmModal
          open
          onClose={() => setConfirmClose(null)}
          onConfirm={() => closeSale(confirmClose)}
          title={
            confirmClose.raiseType === RaiseType.Startup
              ? `Close sale #${confirmClose.saleId} & open vested vault`
              : `Close sale #${confirmClose.saleId}`
          }
          kind="warning"
          confirmLabel={
            confirmClose.raiseType === RaiseType.Startup
              ? "Close & open vault"
              : "Close sale"
          }
          requireReason={false}
          description={
            confirmClose.raiseType === RaiseType.Startup ? (
              <>
                <p>
                  This is a <strong>startup raise</strong>. Closing does{" "}
                  <strong>not</strong> pay you out directly — instead all
                  proceeds are swept into a program-owned{" "}
                  <strong>payout vault</strong> that releases on the vesting
                  schedule from the approved application.
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  You draw tranches from{" "}
                  <code className="rounded bg-slate-100 px-1">
                    /issuer/payouts
                  </code>{" "}
                  after posting each monthly update. Further{" "}
                  <code className="rounded bg-slate-100 px-1">buy</code> calls
                  stop immediately.
                </p>
              </>
            ) : (
              <p>
                Closing withdraws all proceeds to your authority wallet and
                stops further{" "}
                <code className="rounded bg-slate-100 px-1">buy</code> calls.
              </p>
            )
          }
          busy={tx.isSending}
        />
      )}
    </main>
  );
}

/** No live approval: a sale needs Manci's on-chain approval first. */
function NoApprovalDialog({
  loading,
  onClose,
}: {
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-lg overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-amber-900">
            Ask Manci to approve your sale
          </p>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm leading-relaxed text-slate-700">
          {loading ? (
            <p>Checking your sale approvals…</p>
          ) : (
            <>
              <p>
                A primary sale can only be opened with a{" "}
                <strong>sale approval from Manci</strong>. Manci approves a sale
                after reviewing your launch application: the approval fixes the
                share class, the payment token, the price range and the most
                the sale may raise.
              </p>
              <p className="text-xs text-slate-500">
                There is no live approval for your share classes. If your
                application was approved, ask the Manci team to approve the
                sale. If you have not applied yet, start at{" "}
                <Link
                  href="/apply"
                  className="font-semibold text-slate-700 underline underline-offset-2"
                >
                  /apply
                </Link>
                .
              </p>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200"
          >
            Close
          </button>
          <Link
            href="/apply"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            Go to application →
          </Link>
        </div>
      </div>
    </div>
  );
}

const digits = (s: string) => /^\d+$/.test(s.trim());

function OpenSaleModal({
  issuerPda,
  scPdaMap,
  approvals,
  sales,
  preselectApplicationId,
  onClose,
  onSuccess,
}: {
  issuerPda: Address;
  scPdaMap: Map<string, ScMeta>;
  approvals: SaleApprovalAccount[];
  /** Every sale on the network (the Open ones of the class count against its room). */
  sales: Sale[];
  preselectApplicationId: string | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  // What only the ledger knows about each approval: its application (for the
  // listing) and the committed cliff / vesting terms. The chain decides which
  // approvals exist; this is read once per form (a wallet-session read).
  const [mine, setMine] = useState<Map<string, MyApproval> | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    mySaleApprovals(conn.wallet, issuerPda)
      .then((rows) => {
        if (!cancelled) setMine(new Map(rows.map((r) => [r.approval_pda, r])));
      })
      .catch((e) => {
        if (!cancelled) {
          setMine(new Map());
          setMineError(e instanceof Error ? e.message : "Could not load the approval details");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [conn.wallet, issuerPda]);

  const [selected, setSelected] = useState<string>(approvals[0]?.address ?? "");
  const [picked, setPicked] = useState(false);
  // Preselect the approval Manci granted for ?application=ID, once known.
  useEffect(() => {
    if (picked || !mine || !preselectApplicationId) return;
    const match = approvals.find((a) => mine.get(a.address)?.application_id === preselectApplicationId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (match) setSelected(match.address);
    setPicked(true);
  }, [mine, preselectApplicationId, approvals, picked]);

  const approval = approvals.find((a) => a.address === selected) ?? null;
  const info = approval ? (mine?.get(approval.address) ?? null) : null;
  const meta = approval ? (scPdaMap.get(approval.shareClass.toString()) ?? null) : null;
  // The approved share class itself (resolved by its PDA, never by class
  // index alone: two assets can both have a class #0).
  const selectedSc = meta && meta.sc.mintInitialized ? meta.sc : null;

  const [pricePerUnit, setPricePerUnit] = useState("");
  const [totalForSale, setTotalForSale] = useState("");
  // v1: every sale ends, at most 365 days out (6145); the input starts at a
  // 30-day default and cannot go past the cap minus the chain-clock margin.
  const [endBounds] = useState(() => saleEndInputBounds());
  const [endTs, setEndTs] = useState(endBounds.defaultValue);

  // Locked by the approval, including the payout schedule (on-chain since the
  // approval carries it; open_sale requires it exactly).
  const raiseType = approval?.raiseType ?? RaiseType.Mature;
  const isStartup = raiseType === RaiseType.Startup;
  const cliffMonths: number | null = approval ? approval.cliffMonths : null;
  const vestingMonths: number | null = approval ? approval.vestingMonths : null;
  // A Startup raise closes into a PayoutVault (open_payout_vault), which the
  // program rejects unless vesting > cliff and vesting > 0.
  const startupTermsMissing = isStartup && (cliffMonths === null || vestingMonths === null);
  const startupTermsInvalid =
    isStartup && !startupTermsMissing && !((vestingMonths ?? 0) > (cliffMonths ?? 0) && (vestingMonths ?? 0) > 0);
  const startupDisabled = isStartup && !STARTUP_RAISES;

  // USDC is entered in USDC (6 decimals); any other payment token in its base units.
  const usdcMint = USDC[detectNetwork()]?.mint ?? null;
  const priceDecimals = approval ? usdcDecimalsOf(approval.paymentMint, usdcMint) : null;
  const money = (v: bigint) => (approval ? paymentAmountLabel(v, approval.paymentMint, usdcMint) : v.toString());
  const price =
    priceDecimals !== null
      ? toBaseUnits(pricePerUnit, priceDecimals)
      : digits(pricePerUnit)
        ? BigInt(pricePerUnit.trim())
        : null;
  const total = digits(totalForSale) ? BigInt(totalForSale.trim()) : null;
  const priceOutOfRange =
    approval !== null && price !== null && (price < approval.minPricePerUnit || price > approval.maxPricePerUnit);
  const maxUnits = approval && price !== null && price > BigInt(0) ? maxUnitsAt(approval, price) : null;
  const totalTooLarge = maxUnits !== null && total !== null && total > maxUnits;
  const totalIsZero = total !== null && total === BigInt(0);
  // The room left in the class (the program does not check it: buys would fail late with MaxSupplyExceeded):
  // the cap minus everything created, what Open sales may still mint and what other live approvals hold.
  const room = selectedSc
    ? roomToCreate({
        maxSupply: selectedSc.maxSupply.__option === "Some" ? selectedSc.maxSupply.value : null,
        lifetimeMinted: selectedSc.lifetimeMinted,
        version: selectedSc.version,
        supplyLocked: selectedSc.supplyLocked,
        mintablePostLaunch: selectedSc.mintablePostLaunch,
        openSaleRemaining: sales
          .filter((s) => s.shareClass === approval?.shareClass && s.status === SaleStatus.Open)
          .reduce((sum, s) => sum + (s.totalForSale > s.sold ? s.totalForSale - s.sold : BigInt(0)), BigInt(0)),
        reservedUnminted: BigInt(0),
        approvedUnopened: approvals
          .filter((a) => a.shareClass === approval?.shareClass && a.address !== approval?.address)
          .reduce((sum, a) => sum + approvalUnits(a), BigInt(0)),
        treasuryBalance: BigInt(0),
      })
    : null;
  const totalOverRoom = room !== null && total !== null && total > room;

  async function openSale() {
    if (!wallet || !conn.wallet || !approval || price === null || total === null) return;
    if (priceOutOfRange || totalTooLarge || totalOverRoom || totalIsZero || startupDisabled || startupTermsMissing || startupTermsInvalid) return;
    const saleId = approval.saleId;
    const pendingId = toast.showPending(`Opening sale #${saleId}…`);
    try {
      if (!meta || !selectedSc) throw new Error("The approved share class has no initialized mint");
      const [assetPda] = await findAssetPda({
        issuer: issuerPda,
        assetId: meta.assetId,
      });
      const endTsBig = endTs.trim()
        ? BigInt(Math.floor(new Date(endTs).getTime() / 1000))
        : BigInt(0);
      // The intent is saved before the wallet opens; the end (≤ 365 days, chain-clock margin) is checked
      // there too (lib/open-sale).
      const result = await openApprovedSale({
        rpc: client.runtime.rpc,
        session: conn.wallet,
        send: (request) => tx.send(request),
        issuerPda,
        assetPda,
        approval,
        mint: selectedSc.mint,
        pricePerUnit: price,
        totalForSale: total,
        endTs: endTsBig,
        cliffMonths: cliffMonths ?? 0,
        vestingMonths: vestingMonths ?? 0,
        listing: {
          application_id: info?.application_id ?? null,
          logo_letter: (info?.company_name?.[0] ?? meta.assetName?.[0] ?? "•").toUpperCase(),
        },
      });
      toast.dismiss(pendingId);
      toast.showTx(result.signature, { title: "Sale opening submitted" });
      if (!result.published) {
        toast.showError(
          "Sale publication pending",
          `${result.publishError ?? ""} Close this dialog and use Publish existing sale; no second opening transaction is needed.`,
        );
      }
      onSuccess();
    } catch (err) {
      toast.dismiss(pendingId);
      const stage = err instanceof OpenSaleError ? err.stage : "before";
      toast.showError(
        stage === "submitted"
          ? "Sale submitted — publication pending"
          : stage === "intent-saved"
            ? "Sale opening needs checking"
            : "Failed to open sale",
        explainSendError(err instanceof OpenSaleError && err.cause ? err.cause : err),
      );
      console.error("[open_sale]", err);
    }
  }

  if (!wallet) return null;

  const label = (a: SaleApprovalAccount) => {
    const m = scPdaMap.get(a.shareClass.toString());
    const sc = m?.sc;
    const company = mine?.get(a.address)?.company_name;
    return `${company ? `${company} · ` : ""}${m?.assetName ?? "Share class"} · #${m?.classIndex ?? "?"} ${CLASS_TYPE[sc?.classType ?? 0]} · sale #${a.saleId}`;
  };

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
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Sale approval from Manci
            </span>
            <select
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setPicked(true);
              }}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              {approvals.map((a) => (
                <option key={a.address} value={a.address}>
                  {label(a)}
                </option>
              ))}
            </select>
          </label>

          {approval && (
            <div className="rounded-md border border-brand-200 bg-brand-50 px-4 py-3 text-xs text-brand-900">
              <p className="font-semibold">Approved terms</p>
              <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                <dt className="text-brand-700">Share class · sale id</dt>
                <dd className="font-mono">#{meta?.classIndex ?? "?"} · {String(approval.saleId)}</dd>
                <dt className="text-brand-700">Payment mint</dt>
                <dd className="break-all font-mono">{approval.paymentMint}</dd>
                <dt className="text-brand-700">Price per unit</dt>
                <dd className="font-mono">
                  {money(approval.minPricePerUnit)}
                  {approval.maxPricePerUnit !== approval.minPricePerUnit ? ` – ${money(approval.maxPricePerUnit)}` : ""}
                </dd>
                <dt className="text-brand-700">Maximum raise</dt>
                <dd className="font-mono">{money(approval.maxGrossRaise)}</dd>
                <dt className="text-brand-700">Raise type</dt>
                <dd>
                  {isStartup
                    ? `Startup — vested payout${vestingMonths !== null ? ` over ${vestingMonths} months` : ""}${cliffMonths ? `, ${cliffMonths}mo cliff` : ""}`
                    : "Established — instant payout on close"}
                </dd>
                <dt className="text-brand-700">Open by</dt>
                <dd>{new Date(Number(approval.expiresAt) * 1000).toLocaleString("en-GB")}</dd>
              </dl>
            </div>
          )}
          {mineError && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              The approval&apos;s application details could not be loaded ({mineError}). The sale can still be opened,
              but it will not be linked to your application listing.
            </p>
          )}
          {isStartup && (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-800">
              <p className="font-semibold">Startup raise disclosure</p>
              <p className="mt-1 text-slate-600">
                Startup raises settle through an escrowed payout vault: revenue
                routed through the vault is split 1/3 founder · 1/3 investor
                pool · 1/3 platform. Proceeds unlock monthly against posted
                progress updates; investors can freeze and vote after 3 missed
                updates.
              </p>
            </div>
          )}
          {startupDisabled && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              <p className="font-semibold">Startup raises unavailable</p>
              <p className="mt-1 text-amber-700">
                {featureDisabledMessage("startupRaises")} This approval is for a
                startup raise, so its sale cannot be opened here — contact the
                Manci team.
              </p>
            </div>
          )}
          {startupTermsMissing && !startupDisabled && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              <p className="font-semibold">Vesting terms unavailable</p>
              <p className="mt-1 text-amber-700">
                The cliff and vesting months of this startup approval could not be loaded. Reload the page and try again.
              </p>
            </div>
          )}
          {startupTermsInvalid && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              <p className="font-semibold">Vesting terms need fixing</p>
              <p className="mt-1 text-amber-700">
                A startup raise closes into a vested payout vault, which
                requires vesting months greater than the cliff (at least 1).
                This approval has {vestingMonths}mo vesting / {cliffMonths}mo
                cliff. Ask Manci to approve the sale again with corrected terms.
              </p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {priceDecimals !== null ? "Price per unit (USDC)" : "Price per unit (payment base units)"}
              </span>
              <input
                value={pricePerUnit}
                inputMode={priceDecimals !== null ? "decimal" : "numeric"}
                onChange={(e) =>
                  setPricePerUnit(
                    priceDecimals !== null ? e.target.value.replace(/[^\d.]/g, "") : e.target.value.replace(/\D/g, ""),
                  )
                }
                placeholder={
                  approval
                    ? priceDecimals !== null
                      ? fromBaseUnits(approval.minPricePerUnit, priceDecimals)
                      : String(approval.minPricePerUnit)
                    : undefined
                }
                aria-invalid={priceOutOfRange ? true : undefined}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              {priceOutOfRange && approval && (
                <span className="mt-1 block text-xs text-red-600">
                  Must be between {money(approval.minPricePerUnit)} and {money(approval.maxPricePerUnit)}.
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
                aria-invalid={totalTooLarge || totalOverRoom || totalIsZero ? true : undefined}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              {maxUnits !== null && !priceOutOfRange && (
                <span className={`mt-1 block text-xs ${totalTooLarge ? "text-red-600" : "text-slate-500"}`}>
                  At this price the approval allows at most {maxUnits.toString()} units.
                </span>
              )}
              {totalIsZero && (
                <span className="mt-1 block text-xs text-red-600">Must be at least 1.</span>
              )}
              {room !== null && (
                <span className={`mt-1 block text-xs ${totalOverRoom ? "text-red-600" : "text-slate-500"}`}>
                  {formatTokens(room)} tokens can still be created in this class (the cap minus everything created, on sale or
                  approved).
                </span>
              )}
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                End date (required: every sale ends, at most 365 days out)
              </span>
              <input
                type="datetime-local"
                required
                value={endTs}
                min={endBounds.min}
                max={endBounds.max}
                onChange={(e) => setEndTs(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          </div>
          <p className="text-[11px] text-slate-400">
            The payment token (and its token program) is fixed by the approval.
            Opening the sale uses up the approval.
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
            onClick={() => void openSale()}
            disabled={
              tx.isSending ||
              !approval ||
              !selectedSc ||
              mine === null ||
              price === null ||
              total === null ||
              priceOutOfRange ||
              totalTooLarge ||
              totalOverRoom ||
              totalIsZero ||
              startupTermsMissing ||
              startupTermsInvalid ||
              startupDisabled
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

function NotIssuer() {
  return (
    <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-6">
      <p className="text-sm font-semibold text-amber-900">
        No issuer found for this wallet
      </p>
      <Link
        href="/issuer/onboarding"
        className="mt-3 inline-block rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-950"
      >
        Start onboarding →
      </Link>
    </div>
  );
}

function Empty() {
  return (
    <div className="mt-8 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
      <p className="text-sm text-slate-600">No primary sales yet.</p>
      <p className="mt-1 text-xs text-slate-400">
        Use &quot;+ Open sale&quot; above to launch one.
      </p>
    </div>
  );
}
