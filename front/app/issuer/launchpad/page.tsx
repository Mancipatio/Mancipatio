"use client";

import { assertChainRecordStorageAvailable } from "@/lib/chain-record-recovery";
import {
  listSalePublications,
  saveSalePublication,
  clearSalePublication,
  type PendingSalePublication,
} from "@/lib/sale-publication-recovery";
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
import { fetchMaybeMint as fetchMaybeClassicMint } from "@solana-program/token";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  findAssetPda,
  findIssuerPda,
  getCloseSaleInstruction,
  getOpenPayoutVaultInstructionAsync,
  getOpenSaleInstructionAsync,
  RaiseType,
  SaleStatus,
  type Issuer,
  type Sale,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { findSalePda, findShareClassPda } from "@/lib/pdas";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { SkeletonTable } from "@/components/skeleton";
import { ConfirmModal } from "@/components/confirm-modal";
import { useToast } from "@/lib/toast";
import { useRole } from "@/lib/auth";
import { recordAudit } from "@/lib/supabase";
import { getPrivateAssetProfile as getAssetProfile } from "@/lib/asset-profiles";
import { recordSaleIssuance } from "@/lib/spvs";
import {
  upsertListing,
  getMyApplicationWithEvents,
  type LaunchApplication,
} from "@/lib/launchpad";

/** Startup (vested payout-vault) raises are feature-flagged per network
 *  (lib/features.ts; off on mainnet unless NEXT_PUBLIC_FEATURE_STARTUP_RAISES
 *  =true). With it off, a startup sale is neither opened nor closed into a
 *  payout vault from this page — proceeds stay in the program escrow. */
const STARTUP_RAISES = features().startupRaises;

const TOKEN_CLASSIC_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

const CLASS_TYPE = [
  "Common",
  "Preferred A",
  "Preferred B",
  "Senior debt",
  "Junior debt",
  "Rev-share tier",
  "Royalty tier",
];

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
  const role = useRole();
  const searchParams = useSearchParams();
  const applicationId = searchParams.get("application");
  const wallet = conn.wallet?.account.address;
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [me, setMe] = useState<Issuer | null>(null);
  const [myShareClasses, setMyShareClasses] = useState<ShareClass[]>([]);
  const [scPdaMap, setScPdaMap] = useState<
    Map<string, { assetName: string; assetId: string; classIndex: number }>
  >(new Map());
  const [showOpen, setShowOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState<Sale | null>(null);
  // openSale gate (P1 item 3b): opening a sale requires a linked APPROVED
  // application owned by the connected wallet. Super admins may override with
  // a mandatory audited reason; the reason is kept so the modal knows the gate
  // was consciously bypassed.
  const [gateOverrideReason, setGateOverrideReason] = useState<string | null>(
    null,
  );
  const [showGateOverride, setShowGateOverride] = useState(false);
  // When arriving from an approved application (/issuer/launchpad?application=ID),
  // fetch it so the open-sale modal can prefill and thread the id onto the listing.
  // Only honoured when the application is approved AND owned by the connected wallet.
  const [linkedApp, setLinkedApp] = useState<LaunchApplication | null>(null);
  const [applicationLoadError, setApplicationLoadError] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (!applicationId || !wallet) return;
    let cancelled = false;
    void (async () => {
      // Signed self-read — the route only ever returns the signer's own
      // applications (launch_applications has no anon SELECT).
      try {
        setLinkedApp(null);
        setApplicationLoadError(null);
        const { application: a } = await getMyApplicationWithEvents(
          conn.wallet,
          applicationId,
        );
        if (cancelled || !a) return;
        if (
          a.status !== "approved" ||
          a.applicant_wallet !== wallet.toString()
        ) {
          console.warn(
            "[launchpad] Ignoring ?application=: application is not approved or does not belong to the connected wallet.",
          );
          return;
        }
        setLinkedApp(a);
        setShowOpen(true);
      } catch {
        if (!cancelled) {
          setLinkedApp(null);
          setApplicationLoadError(
            "Application eligibility could not be verified. Retry after the service recovers; opening a new sale remains unavailable.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applicationId, wallet, conn.wallet]);

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
          const [issuerPda] = await findIssuerPda({
            legalEntityId: found.legalEntityId,
          });
          const myAssets = network.assets.filter(
            (a) => a.issuer.toString() === issuerPda.toString(),
          );
          const m = new Map<
            string,
            { assetName: string; assetId: string; classIndex: number }
          >();
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
              });
              mySc.push(sc);
            }
          }
          setScPdaMap(m);
          setMyShareClasses(mySc);
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

  const rows = useMemo(() => {
    if (!data) return [];
    return data.sales
      .filter((s) => scPdaMap.has(s.shareClass.toString()))
      .sort((a, b) => Number(b.saleId - a.saleId));
  }, [data, scPdaMap]);

  const verified = me?.kybStatus === 1;
  const mintableScs = myShareClasses.filter((sc) => sc.mintInitialized);
  const canOpen = verified && mintableScs.length > 0;

  // AUTO-BOOK (P1 item 4): after a sale closes (instant close_sale for
  // Established/Mature, or the open_payout_vault close flow for Startup), if
  // the sale's asset profile is linked to an SPV (asset_profiles.spv_id) the
  // gross proceeds are booked against that SPV's EUR 3M annual cap via
  // recordSaleIssuance (W1-F3, source='sale'; the 0027 DB trigger rejects
  // over-cap inserts).
  //
  // FX note (documented per spec): devnet payment mints are USDC-like, not
  // EUR-denominated. We book the UI amount (base units / 10^decimals) as-is
  // and stamp the note with "FX unconverted" + the payment mint so the ledger
  // is auditable. Fire-and-forget: a booking failure never blocks the
  // on-chain close (which has already succeeded), it only surfaces a toast
  // asking for a manual entry on /admin/spvs.
  async function autoBookSpvIssuance(s: Sale) {
    try {
      if (!me) return;
      const meta = scPdaMap.get(s.shareClass.toString());
      if (!meta) return;
      const [issuerPda] = await findIssuerPda({
        legalEntityId: me.legalEntityId,
      });
      const [assetPda] = await findAssetPda({
        issuer: issuerPda,
        assetId: meta.assetId,
      });
      const profile = await getAssetProfile(conn.wallet, assetPda.toString());
      if (!profile?.spv_id) return; // no SPV linked — nothing to book
      const grossBaseUnits = s.sold * s.pricePerUnit;
      let decimals = 6; // USDC/USDT default — the common devnet payment mints
      try {
        const maybe = await fetchMaybeClassicMint(
          client.runtime.rpc,
          s.paymentMint,
        );
        if (maybe.exists) decimals = maybe.data.decimals;
      } catch {
        // keep the 6-decimal fallback
      }
      const amount = Number(grossBaseUnits) / 10 ** decimals;
      if (!(amount > 0)) return; // nothing sold — nothing to book
      const ok = await recordSaleIssuance(conn.wallet, {
        spvId: profile.spv_id,
        amountEur: amount,
        assetPda: assetPda.toString(),
        note: `Auto-booked on close of sale #${s.saleId} (${meta.assetId}) — FX unconverted; amount is payment-mint units (mint ${s.paymentMint})`,
      });
      if (ok) {
        toast.show({
          kind: "success",
          title: "SPV issuance booked",
          description: `${amount.toLocaleString("en-US")} recorded against the SPV annual cap (sale #${s.saleId}).`,
        });
      } else {
        toast.showError(
          "SPV issuance NOT booked",
          `The sale closed on-chain, but booking ${amount.toLocaleString("en-US")} against the SPV annual cap was rejected (cap reached or database unreachable). Please contact the Manci team so it can be recorded.`,
        );
      }
    } catch (err) {
      console.warn("[launchpad] SPV auto-book failed:", err);
    }
  }

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

      if (isStartup) {
        // STARTUP raises do NOT sweep proceeds to the founder. Instead the
        // proceeds escrow is swept into a program-owned PayoutVault escrow that
        // releases on a vesting schedule (open_payout_vault: sale.status==Open
        // && raise_type==Startup → vault init, sale → Closed). The founder draws
        // tranches later from /issuer/payouts.
        const openVaultIx = await getOpenPayoutVaultInstructionAsync({
          authority: signer,
          sale: salePda,
          proceeds: s.proceeds,
          paymentMint: s.paymentMint,
          paymentTokenProgram: TOKEN_CLASSIC_ADDRESS,
          metadataHash: new Uint8Array(32),
        });
        const sig = await tx.send({
          instructions: [openVaultIx],
          feePayer: signer,
        });
        toast.dismiss(pendingId);
        toast.showTx(sig, { title: "Vault opened" });
        setConfirmClose(null);
        void autoBookSpvIssuance(s);
        await refresh();
        return;
      }

      // Established / Mature raises: instant disbursement — sweep proceeds
      // straight to the founder's payment ATA and close the sale.
      const [destAta] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram: TOKEN_CLASSIC_ADDRESS,
        mint: s.paymentMint,
      });
      const createDestAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: wallet,
          mint: s.paymentMint,
          tokenProgram: TOKEN_CLASSIC_ADDRESS,
        });
      const closeIx = getCloseSaleInstruction({
        authority: signer,
        sale: salePda,
        proceeds: s.proceeds,
        paymentMint: s.paymentMint,
        destination: destAta,
        paymentTokenProgram: TOKEN_CLASSIC_ADDRESS,
      });
      const sig = await tx.send({
        instructions: [createDestAtaIx, closeIx],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Sale closed" });
      setConfirmClose(null);
      void autoBookSpvIssuance(s);
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
          onClick={() => {
            if (!applicationLoadError) setShowOpen(true);
          }}
          title={
            !verified
              ? "Verify KYB first."
              : mintableScs.length === 0
                ? "Initialize a share-class mint first."
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

      {applicationLoadError && (
        <p className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {applicationLoadError}
        </p>
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
                      {String(s.pricePerUnit)}
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
                            (s.raiseType === RaiseType.Startup && !STARTUP_RAISES)
                          }
                          title={
                            s.raiseType === RaiseType.Startup && !STARTUP_RAISES
                              ? featureDisabledMessage("startupRaises")
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
      )}

      {showOpen &&
        !applicationLoadError &&
        me &&
        (linkedApp || gateOverrideReason ? (
          <OpenSaleModal
            issuer={me}
            mintableScs={mintableScs}
            scPdaMap={scPdaMap}
            existingSales={data?.sales ?? []}
            applicationId={linkedApp ? applicationId : null}
            linkedApp={linkedApp}
            gateOverrideReason={gateOverrideReason}
            onClose={() => {
              setShowOpen(false);
              // An override is single-use: closing the form re-arms the gate.
              setGateOverrideReason(null);
            }}
            onSuccess={() => {
              void refresh();
              setShowOpen(false);
              setGateOverrideReason(null);
            }}
          />
        ) : (
          // openSale gate (P1 item 3b): no approved application linked — block.
          <div
            className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setShowOpen(false);
            }}
          >
            <div className="mx-auto w-full max-w-lg overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
              <div className="border-b border-amber-200 bg-amber-50 px-5 py-4">
                <p className="text-sm font-semibold uppercase tracking-wide text-amber-900">
                  Approved application required
                </p>
              </div>
              <div className="space-y-3 px-5 py-4 text-sm leading-relaxed text-slate-700">
                <p>
                  Opening a primary sale requires an{" "}
                  <strong>approved launch application</strong> linked to this
                  wallet. Sale terms (raise type, vesting, cliff) are taken from
                  the approved application — sales cannot be opened ad hoc.
                </p>
                <p className="text-xs text-slate-500">
                  If your application has been approved, open it from{" "}
                  <Link
                    href="/apply"
                    className="font-semibold text-slate-700 underline underline-offset-2"
                  >
                    /apply
                  </Link>{" "}
                  — the &quot;Open sale&quot; link there returns here with the
                  application attached. If you have not applied yet, start
                  there.
                </p>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
                {role.isSuperAdmin ? (
                  <button
                    type="button"
                    onClick={() => setShowGateOverride(true)}
                    className="rounded-md px-3 py-1.5 text-xs font-medium text-red-700 underline-offset-2 hover:underline"
                  >
                    Override (super admin)…
                  </button>
                ) : (
                  <span />
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowOpen(false)}
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
          </div>
        ))}

      {showGateOverride && (
        <ConfirmModal
          open
          onClose={() => setShowGateOverride(false)}
          onConfirm={(reason) => {
            if (wallet) {
              // legalEntityId is a fixed-width byte array on-chain — decode
              // and strip NUL padding for a human-readable audit label.
              const entityId = me
                ? new TextDecoder()
                    .decode(new Uint8Array(me.legalEntityId))
                    .replace(/\0+$/, "")
                : null;
              void recordAudit({
                ix_name: "open_sale_gate_override",
                category: "launchpad",
                actor_wallet: wallet.toString(),
                reason,
                target_label: entityId ?? undefined,
                metadata: { issuer_legal_entity_id: entityId },
              });
            }
            setGateOverrideReason(reason);
            setShowGateOverride(false);
          }}
          title="Override the application gate"
          kind="destructive"
          confirmLabel="Override & open sale form"
          requireReason
          reasonPlaceholder="Why is a sale being opened without an approved application? (audit log)"
          description={
            <p>
              You are opening a primary sale{" "}
              <strong>without a linked approved application</strong>. This
              bypasses the platform&apos;s review gate and is recorded in the
              audit log with your wallet and reason.
            </p>
          }
        />
      )}

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

function OpenSaleModal({
  issuer,
  mintableScs,
  scPdaMap,
  existingSales,
  applicationId,
  linkedApp,
  gateOverrideReason,
  onClose,
  onSuccess,
}: {
  issuer: Issuer;
  mintableScs: ShareClass[];
  scPdaMap: Map<
    string,
    { assetName: string; assetId: string; classIndex: number }
  >;
  existingSales: Sale[];
  applicationId: string | null;
  linkedApp: LaunchApplication | null;
  /** Non-null when a super admin overrode the approved-application gate. */
  gateOverrideReason: string | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  // Default to first share class — but we need its PDA as the key.
  const firstScPda = useMemo(() => {
    return Array.from(scPdaMap.keys())[0] ?? "";
  }, [scPdaMap]);
  const [selectedScPda, setSelectedScPda] = useState<string>(firstScPda);

  const [saleId, setSaleId] = useState("");
  const [saleIdTouched, setSaleIdTouched] = useState(false);
  const [pricePerUnit, setPricePerUnit] = useState("");
  const [totalForSale, setTotalForSale] = useState("");
  const [paymentMint, setPaymentMint] = useState("");
  const [endTs, setEndTs] = useState("");

  // For the chosen scPda, lookup metadata.
  const meta = scPdaMap.get(selectedScPda);

  // The ShareClass struct for the selected PDA (matched by classIndex).
  const selectedSc = useMemo(
    () =>
      meta
        ? (mintableScs.find((x) => x.classIndex === meta.classIndex) ?? null)
        : null,
    [meta, mintableScs],
  );

  // Auto-suggest the next free sale id for the chosen share class so a second
  // sale never collides with an existing (shareClass, saleId) PDA.
  const nextSaleId = useMemo(() => {
    if (!selectedScPda) return BigInt(1);
    let max = BigInt(0);
    for (const s of existingSales) {
      if (s.shareClass.toString() === selectedScPda && s.saleId > max) {
        max = s.saleId;
      }
    }
    return max + BigInt(1);
  }, [existingSales, selectedScPda]);

  // Keep the sale-id field defaulted to the next free id until the user edits it.
  useEffect(() => {
    if (!saleIdTouched) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSaleId(nextSaleId.toString());
    }
  }, [nextSaleId, saleIdTouched]);

  // Raise terms from the linked (approved) application, if any.
  const raiseType =
    linkedApp?.raise_type === "startup" ? RaiseType.Startup : RaiseType.Mature;
  const cliffMonths = linkedApp?.cliff_months ?? 0;
  const vestingMonths = linkedApp?.vesting_months ?? 0;
  // A Startup raise closes into a PayoutVault (open_payout_vault), which the
  // program rejects unless vesting > cliff and vesting > 0. Catch it here with a
  // clear message instead of letting the founder hit a raw on-chain error at close.
  const startupTermsInvalid =
    raiseType === RaiseType.Startup &&
    !(vestingMonths > cliffMonths && vestingMonths > 0);
  const startupDisabled = raiseType === RaiseType.Startup && !STARTUP_RAISES;

  async function openSale() {
    if (
      !wallet ||
      !conn.wallet ||
      !selectedScPda ||
      !paymentMint.trim() ||
      !pricePerUnit.trim() ||
      !totalForSale.trim()
    )
      return;
    // Defense in depth for the application gate (item 3b): the modal is only
    // rendered with a linked approved application or an audited super-admin
    // override, but never send the transaction without one of the two.
    if (!linkedApp && !gateOverrideReason) {
      toast.showError(
        "Approved application required",
        "Open the sale from an approved application on /apply, or use the super-admin override.",
      );
      return;
    }
    if (startupDisabled) {
      toast.showError(
        "Startup raises unavailable",
        featureDisabledMessage("startupRaises"),
      );
      return;
    }
    if (startupTermsInvalid) {
      toast.showError(
        "Invalid vesting terms",
        "Startup raises need vesting months greater than the cliff (at least 1). Update the approved application before opening this sale.",
      );
      return;
    }
    const pendingId = toast.showPending(`Opening sale #${saleId}…`);
    let publication: PendingSalePublication | null = null;
    let submittedSignature: string | null = null;
    try {
      assertChainRecordStorageAvailable();
      if (listSalePublications(detectNetwork(), wallet).length)
        throw new Error(
          "A sale opening is already pending publication. Close this dialog and use Publish existing sale, or verify that its unsent intent expired.",
        );
      const [issuerPda] = await findIssuerPda({
        legalEntityId: issuer.legalEntityId,
      });
      if (!meta) throw new Error("Share class not found in PDA map");
      const [assetPda] = await findAssetPda({
        issuer: issuerPda,
        assetId: meta.assetId,
      });
      // The ShareClass struct for the selected PDA (matched by classIndex).
      const matched = selectedSc;
      if (!matched) throw new Error("Share class lookup failed");

      const endTsBig = endTs.trim()
        ? BigInt(Math.floor(new Date(endTs).getTime() / 1000))
        : BigInt(0);
      const signer = walletSigner(conn.wallet);
      const saleIdBig = BigInt(saleId || "0");
      const ix = await getOpenSaleInstructionAsync({
        authority: signer,
        issuer: issuerPda,
        asset: assetPda,
        shareClass: selectedScPda as Address,
        mint: matched.mint,
        paymentMint: paymentMint.trim() as Address,
        paymentTokenProgram: TOKEN_CLASSIC_ADDRESS,
        saleId: saleIdBig,
        pricePerUnit: BigInt(pricePerUnit),
        totalForSale: BigInt(totalForSale),
        startTs: BigInt(0),
        endTs: endTsBig,
        raiseType,
        cliffMonths,
        vestingMonths,
      });
      const salePda = await findSalePda(selectedScPda as Address, saleIdBig);
      const lifetime = (
        await client.runtime.rpc
          .getLatestBlockhash({ commitment: "confirmed" })
          .send()
      ).value;
      publication = {
        version: 1,
        network: detectNetwork(),
        wallet: wallet.toString(),
        salePda,
        signature: null,
        lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
        listing: {
          sale_pubkey: salePda,
          application_id: applicationId,
          logo_letter: (
            linkedApp?.company_name?.[0] ??
            meta.assetName?.[0] ??
            "•"
          ).toUpperCase(),
          is_published: true,
        },
      };
      // Persist the intended PDA before the wallet prompt; a lost response cannot silently advance to another sale id.
      saveSalePublication(publication);
      const sig = await tx.send({
        instructions: [ix],
        feePayer: signer,
        lifetime,
        prepareTransaction: { blockhashReset: false },
      });
      submittedSignature = sig;
      publication = { ...publication, signature: sig };
      try {
        saveSalePublication(publication);
      } catch {
        toast.showError(
          "Keep your sale receipt",
          `Sale ${salePda}; transaction ${sig}. Publish this existing address after storage recovery.`,
        );
      }
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Sale opening submitted" });
      try {
        await upsertListing(conn.wallet, publication.listing);
        clearSalePublication(publication);
      } catch (error) {
        toast.showError(
          "Sale publication pending",
          error instanceof Error
            ? `${error.message} Close this dialog and use Publish existing sale; no second opening transaction is needed.`
            : "Use Publish existing sale to retry the saved address.",
        );
      }
      onSuccess();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        submittedSignature
          ? "Sale submitted — publication pending"
          : publication
            ? "Sale opening needs checking"
            : "Failed to open sale",
        explainSendError(err),
      );
      console.error("[open_sale]", err);
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
          {linkedApp && (
            <div className="rounded-md border border-brand-200 bg-brand-50 px-4 py-3 text-xs text-brand-900">
              <p className="font-semibold">
                Fulfilling application: {linkedApp.company_name}
              </p>
              <p className="mt-1 text-brand-700">
                {raiseType === RaiseType.Startup
                  ? `Startup raise — vested payout over ${vestingMonths} month${
                      vestingMonths === 1 ? "" : "s"
                    }${cliffMonths > 0 ? `, ${cliffMonths}mo cliff` : ""}.`
                  : "Established raise — instant payout on close."}{" "}
                Terms are taken from the approved application.
              </p>
            </div>
          )}
          {!linkedApp && gateOverrideReason && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900">
              <p className="font-semibold">Super-admin override active</p>
              <p className="mt-1 text-red-700">
                No approved application is linked — this sale is being opened
                under an audited override (&quot;{gateOverrideReason}&quot;).
              </p>
            </div>
          )}
          {raiseType === RaiseType.Startup && (
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
                {featureDisabledMessage("startupRaises")} This application is a
                startup raise, so its sale cannot be opened here — contact the
                Manci team.
              </p>
            </div>
          )}
          {startupTermsInvalid && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              <p className="font-semibold">Vesting terms need fixing</p>
              <p className="mt-1 text-amber-700">
                A startup raise closes into a vested payout vault, which
                requires vesting months greater than the cliff (at least 1).
                This application has {vestingMonths}mo vesting / {cliffMonths}mo
                cliff. Update the application before opening the sale.
              </p>
            </div>
          )}
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Share class (Token-2022 mint must be initialized)
            </span>
            <select
              value={selectedScPda}
              onChange={(e) => setSelectedScPda(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              {Array.from(scPdaMap.entries()).map(([pda, info]) => (
                <option key={pda} value={pda}>
                  {info.assetName} · #{info.classIndex} ·{" "}
                  {
                    CLASS_TYPE[
                      mintableScs.find((x) => x.classIndex === info.classIndex)
                        ?.classType ?? 0
                    ]
                  }
                </option>
              ))}
            </select>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Sale ID
              </span>
              <input
                value={saleId}
                inputMode="numeric"
                onChange={(e) => {
                  setSaleIdTouched(true);
                  setSaleId(e.target.value.replace(/\D/g, ""));
                }}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                End date (optional)
              </span>
              <input
                type="datetime-local"
                value={endTs}
                onChange={(e) => setEndTs(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Payment mint (e.g. USDC {detectNetwork()})
              </span>
              <input
                value={paymentMint}
                onChange={(e) => setPaymentMint(e.target.value)}
                placeholder="Mint address"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono text-xs focus:border-slate-400 focus:outline-none"
              />
            </label>
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
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
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
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          </div>
          <p className="text-[11px] text-slate-400">
            Payment token program is classic SPL Token (USDC is classic SPL on
            Solana).
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
              !selectedScPda ||
              !paymentMint.trim() ||
              !pricePerUnit.trim() ||
              !totalForSale.trim() ||
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
