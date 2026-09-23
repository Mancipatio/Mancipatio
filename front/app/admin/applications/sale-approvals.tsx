"use client";

// Admin sale approvals for one approved application (program package 2B).
//
// "Approve sale": reserve the EUR value against the raise cap (server, under a
// per-subject lock) → approve_sale (this admin's wallet) → confirm (server
// compares the on-chain approval with the reservation). A failed send releases
// the reservation. "Revoke": revoke_sale_approval (any admin; rent returns to
// the approver) → release. The retry worker finishes any step left undone.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { WalletSession } from "@solana/client";
import { type Address } from "@solana/kit";
import { useSendTransaction, useSolanaClient } from "@solana/react-hooks";
import {
  findAssetPda,
  findIssuerPda,
  getApproveSaleInstructionAsync,
  getRevokeSaleApprovalInstructionAsync,
  RaiseType,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { findShareClassPda } from "@/lib/pdas";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { recordAudit } from "@/lib/supabase";
import type { useToast } from "@/lib/toast";
import type { LaunchApplication } from "@/lib/launchpad";
import {
  confirmSaleApproval,
  fromBaseUnits,
  listSaleReservations,
  listShareClassSaleApprovals,
  readFxRates,
  releaseSaleApproval,
  reserveSaleApproval,
  saleCapacityFor,
  toBaseUnits,
  SALE_APPROVAL_MAX_TTL_SECS,
  type Capacity,
  type FxRate,
  type ReservationRow,
} from "@/lib/sale-approvals";

type Toast = ReturnType<typeof useToast>;
type ClassOption = { pda: Address; label: string; sc: ShareClass };

const eur = (n: number) => `€${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const STATUS_LABEL: Record<ReservationRow["status"], string> = {
  reserved: "Approved (unused)",
  consumed: "Sale opened",
  booked: "Booked",
  released: "Released",
};

export function SaleApprovalsSection({
  app,
  session,
  adminWallet,
  toast,
}: {
  app: LaunchApplication;
  session: WalletSession | null | undefined;
  adminWallet: string;
  toast: Toast;
}) {
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const [rows, setRows] = useState<ReservationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showApprove, setShowApprove] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await listSaleReservations(session, { application_id: app.id }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the approvals");
    }
  }, [session, app.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function revoke(row: ReservationRow) {
    if (!session || !row.approval_pda) return;
    const pendingId = toast.showPending(`Revoking the approval for sale #${row.sale_id}…`);
    try {
      const signer = walletSigner(session);
      const ix = await getRevokeSaleApprovalInstructionAsync({
        authority: signer,
        saleApproval: row.approval_pda as Address,
        // The rent always returns to the approving admin.
        approvedBy: row.reserved_by as Address,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Sale approval revoked" });
      void recordAudit({
        ix_name: "revoke_sale_approval",
        category: "launchpad",
        actor_wallet: adminWallet,
        reason: `Revoked the sale approval for ${app.company_name}`,
        target_label: row.approval_pda,
        tx_signature: sig,
        metadata: { application_id: app.id, reservation_id: row.id, sale_id: String(row.sale_id) },
      });
      try {
        await releaseSaleApproval(session, row.id, "revoked");
      } catch {
        // The worker releases it once the closed account is visible.
      }
      await load();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Revoke failed", explainSendError(err));
    }
  }

  return (
    <div className="mt-6 border-t border-slate-100 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          Sale approvals
        </p>
        <button
          type="button"
          onClick={() => setShowApprove(true)}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          Approve sale
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {rows === null && !error ? (
        <p className="mt-2 text-xs text-slate-400">Loading approvals…</p>
      ) : rows && rows.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">
          No sale approved yet. The issuer can only open a sale after Manci approves it on-chain.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {(rows ?? []).map((row) => (
            <li key={row.id} className="rounded-md border border-slate-200 px-3 py-2 text-xs text-slate-700">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium text-slate-900">Sale #{String(row.sale_id)}</span> ·{" "}
                  {STATUS_LABEL[row.status]}
                  {row.release_reason ? ` (${row.release_reason})` : ""} · counted{" "}
                  {eur(Number(row.booked_amount_eur ?? row.amount_eur))}
                  {row.expires_at && row.status === "reserved"
                    ? ` · open by ${new Date(row.expires_at).toLocaleDateString("en-GB")}`
                    : ""}
                </span>
                {row.status === "reserved" && row.kind === "sale" && (
                  <button
                    type="button"
                    disabled={tx.isSending}
                    onClick={() => void revoke(row)}
                    className="text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    Revoke
                  </button>
                )}
              </div>
              {row.last_error && <p className="mt-1 text-amber-700">{row.last_error}</p>}
            </li>
          ))}
        </ul>
      )}
      {showApprove && (
        <ApproveSaleModal
          app={app}
          session={session}
          adminWallet={adminWallet}
          toast={toast}
          rpc={client.runtime.rpc}
          onClose={() => setShowApprove(false)}
          onDone={() => {
            setShowApprove(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ApproveSaleModal({
  app,
  session,
  adminWallet,
  toast,
  rpc,
  onClose,
  onDone,
}: {
  app: LaunchApplication;
  session: WalletSession | null | undefined;
  adminWallet: string;
  toast: Toast;
  rpc: ReturnType<typeof useSolanaClient>["runtime"]["rpc"];
  onClose: () => void;
  onDone: () => void;
}) {
  const tx = useSendTransaction();
  const [network, setNetwork] = useState<NetworkData | null>(null);
  const [classes, setClasses] = useState<ClassOption[] | null>(null);
  const [rates, setRates] = useState<FxRate[] | null>(null);
  const [shareClass, setShareClass] = useState("");
  const [saleId, setSaleId] = useState("");
  const [paymentMint, setPaymentMint] = useState("");
  const [maxGross, setMaxGross] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [days, setDays] = useState("30");
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [capacityError, setCapacityError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const raiseType = app.raise_type === "startup" ? "startup" : "mature";

  // The applicant's issuer(s): share classes whose issuer authority is the
  // applicant wallet (or the wallet already linked to the application). The
  // server re-checks every linked wallet of the applicant's account.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadNetworkPreferIndexer(() => loadNetwork(rpc));
        const owners = new Set([app.applicant_wallet, app.linked_issuer].filter(Boolean) as string[]);
        const out: ClassOption[] = [];
        for (const issuer of data.issuers) {
          if (!owners.has(issuer.authority.toString())) continue;
          const [issuerPda] = await findIssuerPda({ legalEntityId: issuer.legalEntityId });
          for (const asset of data.assets) {
            if (asset.issuer !== issuerPda) continue;
            const [apda] = await findAssetPda({ issuer: asset.issuer, assetId: asset.assetId });
            for (const sc of data.shareClasses) {
              if (sc.asset !== apda || !sc.mintInitialized) continue;
              const pda = await findShareClassPda(apda, sc.classIndex);
              out.push({ pda, label: `${asset.name} · class #${sc.classIndex}`, sc });
            }
          }
        }
        if (cancelled) return;
        setNetwork(data);
        setClasses(out);
        if (out[0]) setShareClass(out[0].pda);
      } catch {
        if (!cancelled) setClasses([]);
      }
    })();
    readFxRates(session)
      .then((r) => {
        if (cancelled) return;
        setRates(r);
        if (r[0]) setPaymentMint(r[0].payment_mint);
      })
      .catch(() => {
        if (!cancelled) setRates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, session, app.applicant_wallet, app.linked_issuer]);

  // Capacity panel + the next free sale id for the chosen share class.
  useEffect(() => {
    if (!shareClass || !network) return;
    let cancelled = false;
    void (async () => {
      try {
        const [cap, onChain] = await Promise.all([
          saleCapacityFor(session, shareClass),
          listShareClassSaleApprovals(rpc, shareClass as Address),
        ]);
        if (cancelled) return;
        setCapacity(cap.capacity);
        setCapacityError(null);
        let max = BigInt(0);
        for (const s of network.sales) if (s.shareClass === shareClass && s.saleId > max) max = s.saleId;
        for (const a of onChain) if (a.saleId > max) max = a.saleId;
        if (cap.max_reserved_sale_id && BigInt(cap.max_reserved_sale_id) > max) max = BigInt(cap.max_reserved_sale_id);
        setSaleId((max + BigInt(1)).toString());
      } catch (e) {
        if (!cancelled) setCapacityError(e instanceof Error ? e.message : "Could not load the capacity");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, rpc, shareClass, network]);

  const rate = useMemo(() => rates?.find((r) => r.payment_mint === paymentMint) ?? null, [rates, paymentMint]);
  const decimals = rate?.decimals ?? null;
  const gross = decimals === null ? null : toBaseUnits(maxGross, decimals);
  const min = decimals === null ? null : toBaseUnits(minPrice, decimals);
  const max = decimals === null ? null : toBaseUnits(maxPrice, decimals);
  const daysNum = Number(days);
  const daysValid = Number.isInteger(daysNum) && daysNum >= 1 && daysNum <= 89;
  const termsValid =
    gross !== null && gross > BigInt(0) && min !== null && min > BigInt(0) && max !== null && min <= max && daysValid;
  const grossEur = gross !== null && rate ? Math.ceil(Number(fromBaseUnits(gross, rate.decimals)) * Number(rate.eur_per_token) * 100) / 100 : null;
  const overCap = grossEur !== null && capacity !== null && grossEur > capacity.remaining;
  const overApplication = grossEur !== null && grossEur > Number(app.raise_amount);

  async function approve() {
    if (!session || !termsValid || gross === null || min === null || max === null || !/^\d+$/.test(saleId)) return;
    setBusy(true);
    const pendingId = toast.showPending(`Approving sale #${saleId}…`);
    let reservationId: string | null = null;
    let sent = false;
    try {
      const expiresAt = Math.floor(Date.now() / 1000) + Math.min(daysNum * 86_400, SALE_APPROVAL_MAX_TTL_SECS - 3_600);
      const reserved = await reserveSaleApproval(session, {
        application_id: app.id,
        share_class: shareClass,
        sale_id: saleId,
        payment_mint: paymentMint,
        max_gross_raise: gross.toString(),
        min_price_per_unit: min.toString(),
        max_price_per_unit: max.toString(),
        raise_type: raiseType,
        expires_at: String(expiresAt),
      });
      reservationId = reserved.reservation_id;
      const signer = walletSigner(session);
      const hash = new Uint8Array(reserved.application_hash.match(/../g)!.map((h) => parseInt(h, 16)));
      const ix = await getApproveSaleInstructionAsync({
        authority: signer,
        issuer: reserved.issuer,
        asset: reserved.asset,
        shareClass: shareClass as Address,
        paymentMint: paymentMint as Address,
        saleId: BigInt(saleId),
        maxGrossRaise: gross,
        minPricePerUnit: min,
        maxPricePerUnit: max,
        raiseType: raiseType === "startup" ? RaiseType.Startup : RaiseType.Mature,
        expiresAt: BigInt(expiresAt),
        applicationHash: hash,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      sent = true;
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Sale approved" });
      void recordAudit({
        ix_name: "approve_sale",
        category: "launchpad",
        actor_wallet: adminWallet,
        reason: `Approved sale #${saleId} for ${app.company_name}: up to ${eur(reserved.amount_eur)}`,
        target_label: reserved.approval_pda,
        tx_signature: sig,
        metadata: { application_id: app.id, reservation_id: reservationId, application_hash: reserved.application_hash },
      });
      try {
        await confirmSaleApproval(session, reservationId, sig);
      } catch (e) {
        toast.show({
          kind: "info",
          title: "Approval sent — confirmation pending",
          description: e instanceof Error ? `${e.message} The retry worker confirms it shortly.` : undefined,
        });
      }
      onDone();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Sale approval failed", explainSendError(err));
      if (reservationId && !sent) {
        // Nothing reached the chain: free the reserved capacity again.
        await releaseSaleApproval(session, reservationId, "tx_failed").catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Approve a sale for {app.company_name}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            The approval is recorded on-chain; the issuer can open exactly one sale within these terms before it expires.
          </p>
        </div>
        <div className="space-y-4 px-5 py-4 text-sm">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Share class</span>
            {classes === null ? (
              <p className="mt-1 text-xs text-slate-400">Loading the applicant&apos;s share classes…</p>
            ) : classes.length === 0 ? (
              <>
                <p className="mt-1 text-xs text-amber-700">
                  No initialized share class found for the applicant&apos;s wallet. Enter the share class address:
                </p>
                <input
                  value={shareClass}
                  onChange={(e) => setShareClass(e.target.value.trim())}
                  placeholder="Share class address"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </>
            ) : (
              <select
                value={shareClass}
                onChange={(e) => setShareClass(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                {classes.map((c) => (
                  <option key={c.pda} value={c.pda}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Sale id</span>
              <input
                value={saleId}
                inputMode="numeric"
                onChange={(e) => setSaleId(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Payment token</span>
              {rates !== null && rates.length === 0 ? (
                <p className="mt-1 text-xs text-amber-700">
                  No EUR rate is configured. A super admin adds payment tokens on the Raise limits page.
                </p>
              ) : (
                <select
                  value={paymentMint}
                  onChange={(e) => setPaymentMint(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs"
                >
                  {(rates ?? []).map((r) => (
                    <option key={r.payment_mint} value={r.payment_mint}>
                      {r.payment_mint.slice(0, 6)}…{r.payment_mint.slice(-4)} · {r.kind === "eur_peg" ? "EUR 1:1" : `${r.eur_per_token} EUR`} · {r.source}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Max raise (tokens)</span>
              <input value={maxGross} inputMode="decimal" onChange={(e) => setMaxGross(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Min price / unit</span>
              <input value={minPrice} inputMode="decimal" onChange={(e) => setMinPrice(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Max price / unit</span>
              <input value={maxPrice} inputMode="decimal" onChange={(e) => setMaxPrice(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Valid for (days, max 89)</span>
              <input value={days} inputMode="numeric" onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <div className="text-xs text-slate-600">
              <span className="block font-medium uppercase tracking-wide text-slate-500">Raise type</span>
              <span className="mt-2 block">
                {raiseType === "startup"
                  ? `Startup — ${app.vesting_months} months vesting, ${app.cliff_months} months cliff (from the application)`
                  : "Established (from the application)"}
              </span>
            </div>
          </div>
          <div className={`rounded-md border px-4 py-3 text-xs ${overCap || overApplication ? "border-red-200 bg-red-50 text-red-900" : "border-slate-200 bg-slate-50 text-slate-700"}`}>
            <p className="font-semibold">Raise limit (rolling 12 months)</p>
            {capacityError ? (
              <p className="mt-1">{capacityError}</p>
            ) : capacity ? (
              <p className="mt-1">
                {capacity.cap_source === "spv" ? "SPV" : "Issuer"} limit {eur(capacity.cap)} · used {eur(capacity.used)} (
                {eur(capacity.reserved)} reserved) · remaining {eur(capacity.remaining)}
              </p>
            ) : (
              <p className="mt-1">Loading…</p>
            )}
            {grossEur !== null && (
              <p className="mt-1">
                This approval counts {eur(grossEur)}
                {overCap ? " — more than the remaining limit" : ""}
                {overApplication ? ` — more than the application's raise of ${eur(Number(app.raise_amount))}` : ""}.
              </p>
            )}
          </div>
          {!termsValid && (maxGross || minPrice || maxPrice) && (
            <p className="text-xs text-red-600">
              Enter a max raise above zero and a min price at least one base unit and not above the max price
              {decimals !== null ? ` (at most ${decimals} decimals)` : ""}.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void approve()}
            disabled={busy || !termsValid || !shareClass || !paymentMint || !rate || !/^\d+$/.test(saleId) || overCap || overApplication}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? "Approving…" : "Reserve & approve on-chain"}
          </button>
        </div>
      </div>
    </div>
  );
}
