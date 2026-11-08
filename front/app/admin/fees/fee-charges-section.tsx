"use client";

// Charges on /admin/fees (migration 0089): what Manci bills, priced by the
// server from the published fee when the charge is booked. Collection is by
// invoice, off-chain: Due -> Invoiced (with the invoice number) -> Paid, or
// Waived with a reason. The amount never changes after booking; a charge
// booked by mistake is waived, never deleted.
//
// A new charge starts from a conversion request or an application (or
// another reference). The pickers read the existing admin lists (session
// reads, no extra prompt) only when the form opens. The amount shown before
// booking comes from the same quoteFee the route prices with.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonTable } from "@/components/skeleton";
import { useToast } from "@/lib/toast";
import type { ClientRow } from "@/lib/clients";
import { adminListConversionRequests, type ConversionRequest } from "@/lib/conversion";
import { listApplications, type LaunchApplication } from "@/lib/launchpad";
import { describeFee, formatEur, formatEurCents, formatFeeDate, quoteFee, type FeeQuote } from "@/lib/fees/quote";
import {
  FEE_CHARGE_STATUS_LABEL,
  FEE_KINDS,
  FEE_KIND_BASE,
  FEE_KIND_LABEL,
  FEE_KIND_REF_TYPES,
  FEE_KIND_UNIT,
  FEE_PAYER_LABEL,
  FEE_REF_TYPE_LABEL,
  type FeeChargeRow,
  type FeeKind,
  type FeeRefType,
  type FeeScheduleRow,
} from "@/lib/fees/schedule";
import { createFeeCharge, updateFeeCharge, type FeeChargeMove } from "@/lib/fees/client";

const STATUS_STYLE: Record<FeeChargeRow["status"], string> = {
  due: "bg-amber-50 text-amber-800 ring-amber-200",
  invoiced: "bg-sky-50 text-sky-800 ring-sky-200",
  paid: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  waived: "bg-white text-slate-500 ring-slate-200",
};

const INPUT = "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none";
const LABEL = "text-xs font-medium uppercase tracking-wide text-slate-500";

const short = (value: string) => (value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value);

/** "Conversion value (EUR)" from "the conversion value". */
function baseLabel(kind: FeeKind): string {
  const noun = FEE_KIND_BASE[kind].replace(/^the /, "");
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} (EUR)`;
}

function inEffect(fee: FeeScheduleRow, readAt: number): boolean {
  return fee.status === "published" && fee.effective_from !== null && Date.parse(fee.effective_from) <= readAt;
}

type Move = { charge: FeeChargeRow; move: FeeChargeMove["status"] };

export function FeeChargesSection({
  schedule,
  charges,
  readAt,
  clients,
  error,
  onChanged,
}: {
  schedule: FeeScheduleRow[] | null;
  charges: FeeChargeRow[] | null;
  /** When the data was read (what "in effect" is judged against). */
  readAt: number;
  clients: ClientRow[] | null;
  error: string | null;
  onChanged: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [moving, setMoving] = useState<Move | null>(null);

  const chargeable = useMemo(() => (schedule ?? []).filter((fee) => inEffect(fee, readAt)), [schedule, readAt]);
  const scheduleById = useMemo(() => new Map((schedule ?? []).map((fee) => [fee.id, fee])), [schedule]);
  const clientById = useMemo(() => new Map((clients ?? []).map((client) => [client.id, client])), [clients]);

  async function applyMove(charge: FeeChargeRow, move: FeeChargeMove) {
    try {
      const updated = await updateFeeCharge(conn.wallet, charge, move);
      toast.show({ kind: "success", title: `Charge ${FEE_CHARGE_STATUS_LABEL[updated.status].toLowerCase()}`, description: formatEur(updated.amount_eur) });
      setMoving(null);
      await onChanged();
    } catch (err) {
      toast.showError("Charge update failed", err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-slate-900">Charges</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            What Manci bills, priced from the published fee when the charge is booked. Collected by
            invoice, off-chain: Due, then Invoiced (with the invoice number), then Paid, or Waived
            with a reason. The amount never changes once booked.
          </p>
        </div>
        <button
          type="button"
          disabled={chargeable.length === 0}
          title={chargeable.length === 0 ? "Publish a fee (in effect) before booking a charge" : undefined}
          onClick={() => setCreating(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          + New charge
        </button>
      </div>

      {error ? null : charges === null ? (
        <div className="mt-4">
          <SkeletonTable rows={3} cols={7} />
        </div>
      ) : charges.length === 0 ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-8 text-center">
          <p className="text-sm text-slate-600">
            No charges yet.{chargeable.length === 0 ? " A charge can be booked once a fee of its kind is published and in effect." : ""}
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Booked</th>
                <th className="px-4 py-2 font-medium">Fee</th>
                <th className="px-4 py-2 font-medium">Reference</th>
                <th className="px-4 py-2 font-medium">Payer</th>
                <th className="px-4 py-2 text-right font-medium">Base</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {charges.map((charge) => {
                const client = charge.payer_client_id ? clientById.get(charge.payer_client_id) : undefined;
                const price = scheduleById.get(charge.schedule_id);
                return (
                  <tr key={charge.id} className="align-top text-slate-700">
                    <td className="px-4 py-2 text-xs text-slate-500">{charge.created_at.slice(0, 10)}</td>
                    <td className="px-4 py-2 text-xs">
                      {FEE_KIND_LABEL[charge.kind]}
                      {price ? <span className="block text-[11px] text-slate-400">{describeFee(price)}</span> : null}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {FEE_REF_TYPE_LABEL[charge.ref_type]}{" "}
                      <span className="font-mono text-[11px] text-slate-500" title={charge.ref_id}>{short(charge.ref_id)}</span>
                      {charge.note ? <span className="block text-[11px] text-slate-400">{charge.note}</span> : null}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {client ? (
                        <Link href={`/admin/clients/${client.id}`} className="underline-offset-2 hover:underline">
                          {client.display_name || short(client.id)}
                        </Link>
                      ) : charge.payer_client_id ? (
                        <span className="font-mono text-[11px] text-slate-500">{short(charge.payer_client_id)}</span>
                      ) : charge.issuer_pda ? (
                        <span className="font-mono text-[11px] text-slate-500" title={charge.issuer_pda}>issuer {short(charge.issuer_pda)}</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {charge.base_amount_eur > 0 ? formatEur(charge.base_amount_eur) : "—"}
                      {charge.quantity > 1 ? <span className="block text-[11px] text-slate-400">× {charge.quantity}</span> : null}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs font-medium">{formatEur(charge.amount_eur)}</td>
                    <td className="px-4 py-2 text-xs">
                      <span className={`inline-flex rounded-full px-2 py-0.5 ring-1 ${STATUS_STYLE[charge.status]}`}>
                        {FEE_CHARGE_STATUS_LABEL[charge.status]}
                      </span>
                      {charge.invoice_ref ? <span className="block text-[11px] text-slate-500">Invoice {charge.invoice_ref}</span> : null}
                      {charge.waived_reason ? <span className="block max-w-[220px] text-[11px] text-slate-500">{charge.waived_reason}</span> : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right text-xs">
                      <span className="inline-flex gap-3">
                        {charge.status === "due" && (
                          <button type="button" onClick={() => setMoving({ charge, move: "invoiced" })} className="text-slate-700 underline-offset-2 hover:underline">
                            Mark invoiced
                          </button>
                        )}
                        {charge.status === "invoiced" && (
                          <button type="button" onClick={() => setMoving({ charge, move: "paid" })} className="font-medium text-emerald-700 underline-offset-2 hover:underline">
                            Mark paid
                          </button>
                        )}
                        {(charge.status === "due" || charge.status === "invoiced") && (
                          <button type="button" onClick={() => setMoving({ charge, move: "waived" })} className="text-red-700 underline-offset-2 hover:underline">
                            Waive
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <NewChargeModal
          fees={chargeable}
          clients={clients ?? []}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await onChanged();
          }}
        />
      )}

      {moving?.move === "invoiced" && (
        <ConfirmModal
          open
          kind="info"
          title="Mark invoiced"
          confirmLabel="Mark invoiced"
          reasonPlaceholder="Invoice number, e.g. INV-2026-014"
          reasonMinLength={1}
          onClose={() => setMoving(null)}
          onConfirm={(reason) => applyMove(moving.charge, { status: "invoiced", invoice_ref: reason.trim() })}
          description={<p>Record the invoice issued for {formatEur(moving.charge.amount_eur)}. The invoice number stays on the charge.</p>}
        />
      )}
      {moving?.move === "paid" && (
        <ConfirmModal
          open
          kind="info"
          title="Mark paid"
          confirmLabel="Mark paid"
          requireReason={false}
          onClose={() => setMoving(null)}
          onConfirm={() => applyMove(moving.charge, { status: "paid" })}
          description={<p>Record that invoice {moving.charge.invoice_ref} for {formatEur(moving.charge.amount_eur)} was paid.</p>}
        />
      )}
      {moving?.move === "waived" && (
        <ConfirmModal
          open
          kind="warning"
          title="Waive charge"
          confirmLabel="Waive"
          reasonPlaceholder="Why is this charge waived? (kept on the charge and in the audit log)"
          reasonMinLength={4}
          onClose={() => setMoving(null)}
          onConfirm={(reason) => applyMove(moving.charge, { status: "waived", waived_reason: reason.trim() })}
          description={<p>{formatEur(moving.charge.amount_eur)} will not be collected. A waived charge stays in the ledger; a new charge for the same reference can then be booked.</p>}
        />
      )}
    </section>
  );
}

function NewChargeModal({
  fees,
  clients,
  onClose,
  onCreated,
}: {
  fees: FeeScheduleRow[];
  clients: ClientRow[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const ordered = useMemo(() => FEE_KINDS.flatMap((kind) => fees.filter((fee) => fee.kind === kind)), [fees]);
  const [kind, setKind] = useState<FeeKind>(ordered[0]?.kind ?? "conversion");
  const fee = ordered.find((f) => f.kind === kind) ?? null;
  const refTypes = FEE_KIND_REF_TYPES[kind];
  const [refType, setRefType] = useState<FeeRefType>(refTypes[0]);
  const [refId, setRefId] = useState("");
  const [base, setBase] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [payer, setPayer] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [conversions, setConversions] = useState<ConversionRequest[] | null>(null);
  const [applications, setApplications] = useState<LaunchApplication[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  // The reference lists load when their type is chosen (session reads).
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        if (refType === "conversion_request" && conversions === null) {
          const rows = await adminListConversionRequests(conn.wallet);
          if (live) setConversions(rows.filter((r) => r.status !== "cancelled" && r.status !== "returned"));
        }
        if (refType === "application" && applications === null) {
          const rows = await listApplications(conn.wallet);
          if (live) setApplications(rows.filter((r) => r.status !== "rejected"));
        }
      } catch (err) {
        if (live) setListError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [refType, conversions, applications, conn.wallet]);

  const hasRate = (fee?.rate_bps ?? 0) > 0;
  const unit = FEE_KIND_UNIT[kind];
  const qty = unit ? Number(quantity) : 1;
  let quote: FeeQuote | null = null;
  let quoteError: string | null = null;
  if (fee) {
    try {
      quote = quoteFee(fee, hasRate ? base.trim() || "0" : "0", qty);
    } catch (err) {
      quoteError = err instanceof Error ? err.message : "Cannot be priced";
    }
  }
  const canSave = !saving && fee !== null && quote !== null && refId.trim() !== "" && (!hasRate || base.trim() !== "");

  function chooseApplication(id: string) {
    setRefId(id);
    // Preselect the applicant's client dossier when the directory has it.
    const app = applications?.find((a) => a.id === id);
    const client = app ? clients.find((c) => c.wallet === app.applicant_wallet) : undefined;
    setPayer(client?.id ?? "");
  }

  async function submit() {
    if (!fee || !canSave) return;
    setSaving(true);
    try {
      const { charge, quote: priced } = await createFeeCharge(conn.wallet, {
        kind,
        ref_type: refType,
        ref_id: refId.trim(),
        base_amount_eur: hasRate ? base.trim() : "0",
        ...(unit ? { quantity: qty } : {}),
        ...(refType !== "conversion_request" && payer ? { payer_client_id: payer } : {}),
        note: note.trim(),
      });
      toast.show({
        kind: "success",
        title: "Charge booked",
        description: `${formatEur(charge.amount_eur)}${priced.basis === "formula" ? "" : ` (${priced.basis} applies)`}, due.`,
      });
      await onCreated();
    } catch (err) {
      toast.showError("Charge not booked", err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">New charge</p>
          <p className="mt-1 text-xs text-slate-500">
            Priced by the server from the published fee; the charge starts as Due. Nothing is collected here.
          </p>
        </div>
        <div className="grid gap-3 px-5 py-4 sm:grid-cols-2">
          <label className="block">
            <span className={LABEL}>Fee</span>
            <select
              value={kind}
              onChange={(e) => {
                const next = e.target.value as FeeKind;
                setKind(next);
                setRefType(FEE_KIND_REF_TYPES[next][0]);
                setRefId("");
                setPayer("");
              }}
              className={INPUT}
            >
              {ordered.map((f) => (
                <option key={f.id} value={f.kind}>
                  {FEE_KIND_LABEL[f.kind]}: {describeFee(f)}
                </option>
              ))}
            </select>
            {fee && (
              <span className="mt-1 block text-[11px] text-slate-400">
                Paid by the {FEE_PAYER_LABEL[fee.payer].toLowerCase()}; published, in effect since {formatFeeDate(fee.effective_from!)}.
              </span>
            )}
          </label>
          <label className="block">
            <span className={LABEL}>Reference</span>
            <select
              value={refType}
              onChange={(e) => {
                setRefType(e.target.value as FeeRefType);
                setRefId("");
                setPayer("");
              }}
              className={INPUT}
            >
              {refTypes.map((type) => (
                <option key={type} value={type}>
                  {FEE_REF_TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </label>

          {refType === "conversion_request" ? (
            <label className="block sm:col-span-2">
              <span className={LABEL}>Conversion request</span>
              <select value={refId} onChange={(e) => setRefId(e.target.value)} className={INPUT} disabled={conversions === null}>
                <option value="">{conversions === null ? "Loading…" : "Select a request"}</option>
                {(conversions ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.asset_label || short(r.share_class_pda)} · {r.amount} units · {r.status} · {short(r.holder_wallet)} · {r.created_at.slice(0, 10)}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-slate-400">Billed to the requesting holder&apos;s client dossier.</span>
            </label>
          ) : refType === "application" ? (
            <label className="block sm:col-span-2">
              <span className={LABEL}>Application</span>
              <select value={refId} onChange={(e) => chooseApplication(e.target.value)} className={INPUT} disabled={applications === null}>
                <option value="">{applications === null ? "Loading…" : "Select an application"}</option>
                {(applications ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.company_name} · {a.status}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="block sm:col-span-2">
              <span className={LABEL}>{refType === "asset" ? "Asset address" : `${FEE_REF_TYPE_LABEL[refType]} reference`}</span>
              <input value={refId} maxLength={120} onChange={(e) => setRefId(e.target.value)} className={`${INPUT} font-mono text-xs`} />
            </label>
          )}
          {listError && <p className="text-xs text-red-700 sm:col-span-2">The list could not be loaded: {listError}</p>}

          {hasRate && (
            <label className="block">
              <span className={LABEL}>{baseLabel(kind)}</span>
              <input value={base} inputMode="decimal" onChange={(e) => setBase(e.target.value.replace(/[^\d.]/g, ""))} className={INPUT} />
            </label>
          )}
          {unit && (
            <label className="block">
              <span className={LABEL}>Number of {unit}s</span>
              <input value={quantity} inputMode="numeric" onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ""))} className={INPUT} />
            </label>
          )}
          {refType !== "conversion_request" && (
            <label className="block">
              <span className={LABEL}>Payer client (optional)</span>
              <select value={payer} onChange={(e) => setPayer(e.target.value)} className={INPUT}>
                <option value="">None</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name || short(c.id)} ({c.type})
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block sm:col-span-2">
            <span className={LABEL}>Note (optional, internal)</span>
            <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} className={INPUT} />
          </label>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 sm:col-span-2">
            <span className="block font-medium uppercase tracking-wide text-slate-500">Amount</span>
            {quote ? (
              <span className="text-slate-800">
                {formatEurCents(quote.cents)}
                {quote.basis === "minimum" ? " (the minimum applies)" : quote.basis === "maximum" ? " (the maximum applies)" : ""}
              </span>
            ) : (
              <span className="text-red-700">{quoteError ?? "Choose a published fee"}</span>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => void submit()}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? "Booking…" : "Book charge"}
          </button>
        </div>
      </div>
    </div>
  );
}
