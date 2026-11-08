"use client";

// The fee schedule on /admin/fees (migration 0089): drafts, the price in
// force per kind, and retired prices. Any Admin prepares drafts (by hand or
// "Load suggested defaults", the owner's suggested numbers as drafts);
// only the Super Admin publishes or retires (the routes enforce it, the
// buttons follow). Publishing asks for an explicit confirmation that names
// what goes public, the price it replaces and the Terms / pricing-page
// commitments that must already be met: publication is a business and legal
// decision (ops/env-vars.md "Fee schedule").

import { useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonTable } from "@/components/skeleton";
import { useRole } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { describeFee, formatFeeDate, formatRateBps } from "@/lib/fees/quote";
import {
  FEE_KINDS,
  FEE_KIND_DEFAULT_PAYER,
  FEE_KIND_LABEL,
  FEE_KIND_UNIT,
  FEE_PAYERS,
  FEE_PAYER_LABEL,
  SUGGESTED_FEE_DRAFTS,
  type FeeDraftInput,
  type FeeKind,
  type FeePayer,
  type FeeScheduleRow,
} from "@/lib/fees/schedule";
import {
  deleteFeeDraft,
  loadSuggestedFeeDrafts,
  publishFeeDraft,
  retireFee,
  saveFeeDraft,
} from "@/lib/fees/client";

const STATUS_STYLE: Record<FeeScheduleRow["status"], string> = {
  published: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  draft: "bg-slate-100 text-slate-700 ring-slate-200",
  retired: "bg-white text-slate-400 ring-slate-200",
};
const STATUS_LABEL: Record<FeeScheduleRow["status"], string> = {
  published: "Published",
  draft: "Draft",
  retired: "Retired",
};

/** describeFee, or the reason a row cannot be priced (never throws in a render). */
function amountText(fee: Pick<FeeScheduleRow, "kind" | "fixed_eur" | "rate_bps" | "min_eur" | "max_eur">): string {
  try {
    return describeFee(fee);
  } catch (err) {
    return err instanceof Error ? err.message : "Cannot be priced";
  }
}

function effectiveText(fee: FeeScheduleRow, readAt: number): string {
  if (fee.status === "draft") return fee.effective_from ? `Planned ${formatFeeDate(fee.effective_from)}` : "On publication";
  if (!fee.effective_from) return "—";
  return Date.parse(fee.effective_from) > readAt ? `From ${formatFeeDate(fee.effective_from)}` : formatFeeDate(fee.effective_from);
}

export function FeeScheduleSection({
  schedule,
  readAt,
  error,
  onChanged,
}: {
  schedule: FeeScheduleRow[] | null;
  /** When the schedule was read (what "in effect" is judged against). */
  readAt: number;
  error: string | null;
  onChanged: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const { isSuperAdmin } = useRole();
  const toast = useToast();
  const [editing, setEditing] = useState<{ row: FeeScheduleRow | null; initial: FeeDraftInput } | null>(null);
  const [publishing, setPublishing] = useState<FeeScheduleRow | null>(null);
  const [retiring, setRetiring] = useState<FeeScheduleRow | null>(null);
  const [deleting, setDeleting] = useState<FeeScheduleRow | null>(null);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [showRetired, setShowRetired] = useState(false);

  const groups = useMemo(() => {
    const rows = schedule ?? [];
    const byKind = (a: FeeScheduleRow, b: FeeScheduleRow) => FEE_KINDS.indexOf(a.kind) - FEE_KINDS.indexOf(b.kind);
    return {
      published: rows.filter((r) => r.status === "published").sort(byKind),
      drafts: rows.filter((r) => r.status === "draft").sort(byKind),
      retired: rows.filter((r) => r.status === "retired"),
    };
  }, [schedule]);

  const publishedByKind = useMemo(() => new Map(groups.published.map((r) => [r.kind, r])), [groups.published]);

  async function run(label: string, action: () => Promise<string>) {
    try {
      const message = await action();
      toast.show({ kind: "success", title: label, description: message });
      await onChanged();
      return true;
    } catch (err) {
      toast.showError(`${label} failed`, err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  const rowsToShow = [...groups.published, ...groups.drafts, ...(showRetired ? groups.retired : [])];

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-slate-900">Fee schedule (public price list)</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            What <code>/pricing</code> and the quote shown before a client commits display. Drafts
            are private. Publishing (Super Admin) makes a price public and lets charges be priced
            from it; publishing a new version of a kind retires the old one. Nothing publishes on
            its own, and publication is a business and legal decision.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={loadingDefaults || schedule === null}
            onClick={() => setLoadingDefaults(true)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Load suggested defaults
          </button>
          <button
            type="button"
            disabled={schedule === null}
            onClick={() => setEditing({ row: null, initial: blankDraft("conversion") })}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            + New draft
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          The fee schedule could not be loaded: {error}
        </p>
      ) : schedule === null ? (
        <div className="mt-4">
          <SkeletonTable rows={3} cols={6} />
        </div>
      ) : schedule.length === 0 ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-8 text-center">
          <p className="text-sm text-slate-600">
            No fee is published: <code>/pricing</code> shows the launch-phase text and no charge can
            be booked. Start with a draft or load the suggested defaults.
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Fee</th>
                <th className="px-4 py-2 font-medium">Public label</th>
                <th className="px-4 py-2 font-medium">Amount (public text)</th>
                <th className="px-4 py-2 font-medium">Payer</th>
                <th className="px-4 py-2 font-medium">Effective</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rowsToShow.map((fee) => (
                <tr key={fee.id} className={fee.status === "retired" ? "text-slate-400" : "text-slate-700"}>
                  <td className="px-4 py-2 text-xs font-medium">{FEE_KIND_LABEL[fee.kind]}</td>
                  <td className="px-4 py-2">
                    {fee.public_label}
                    {fee.public_note ? <span className="block text-[11px] text-slate-500">{fee.public_note}</span> : null}
                  </td>
                  <td className="px-4 py-2 text-xs">{amountText(fee)}</td>
                  <td className="px-4 py-2 text-xs">{FEE_PAYER_LABEL[fee.payer]}</td>
                  <td className="px-4 py-2 text-xs">{effectiveText(fee, readAt)}</td>
                  <td className="px-4 py-2 text-xs">
                    <span className={`inline-flex rounded-full px-2 py-0.5 ring-1 ${STATUS_STYLE[fee.status]}`}>{STATUS_LABEL[fee.status]}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right text-xs">
                    {fee.status === "draft" && (
                      <span className="inline-flex gap-3">
                        <button type="button" onClick={() => setEditing({ row: fee, initial: draftOf(fee) })} className="text-slate-700 underline-offset-2 hover:underline">
                          Edit
                        </button>
                        {isSuperAdmin && (
                          <button type="button" onClick={() => setPublishing(fee)} className="font-medium text-emerald-700 underline-offset-2 hover:underline">
                            Publish
                          </button>
                        )}
                        <button type="button" onClick={() => setDeleting(fee)} className="text-red-700 underline-offset-2 hover:underline">
                          Delete
                        </button>
                      </span>
                    )}
                    {fee.status === "published" && (
                      <span className="inline-flex gap-3">
                        <button type="button" onClick={() => setEditing({ row: null, initial: draftOf(fee) })} className="text-slate-700 underline-offset-2 hover:underline">
                          New version
                        </button>
                        {isSuperAdmin && (
                          <button type="button" onClick={() => setRetiring(fee)} className="text-red-700 underline-offset-2 hover:underline">
                            Retire
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {groups.retired.length > 0 && (
            <div className="border-t border-slate-100 bg-slate-50 px-4 py-2 text-xs">
              <button type="button" onClick={() => setShowRetired((v) => !v)} className="text-slate-600 underline-offset-2 hover:underline">
                {showRetired ? "Hide retired prices" : `Show ${groups.retired.length} retired price${groups.retired.length === 1 ? "" : "s"}`}
              </button>
            </div>
          )}
        </div>
      )}
      {!isSuperAdmin && groups.drafts.length > 0 && (
        <p className="mt-3 text-xs text-slate-500">Only the Super Admin can publish or retire a price.</p>
      )}

      {editing && (
        <FeeDraftModal
          row={editing.row}
          initial={editing.initial}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            const ok = await run(editing.row ? "Draft saved" : "Draft created", async () => {
              const saved = await saveFeeDraft(conn.wallet, draft, editing.row);
              return `${saved.public_label}: ${amountText(saved)}. Not public until published.`;
            });
            if (ok) setEditing(null);
          }}
        />
      )}

      {publishing && (
        <PublishModal
          fee={publishing}
          readAt={readAt}
          replaces={publishedByKind.get(publishing.kind) ?? null}
          onClose={() => setPublishing(null)}
          onConfirm={async () => {
            const ok = await run("Fee published", async () => {
              const { fee, replaced } = await publishFeeDraft(conn.wallet, publishing);
              return `${fee.public_label} is public${replaced ? ` and replaces ${amountText(replaced)}` : ""}.`;
            });
            if (ok) setPublishing(null);
          }}
        />
      )}

      {retiring && (
        <ConfirmModal
          open
          kind="destructive"
          title={`Retire ${retiring.public_label}`}
          confirmLabel="Retire"
          requireReason={false}
          onClose={() => setRetiring(null)}
          onConfirm={async () => {
            const ok = await run("Fee retired", async () => {
              const fee = await retireFee(conn.wallet, retiring);
              return `${fee.public_label} is no longer public.`;
            });
            if (ok) setRetiring(null);
          }}
          description={
            <p>
              {amountText(retiring)} leaves <code>/pricing</code> and the quotes, and no new charge
              can be priced from it; charges already booked keep it. Until another price of this
              kind is published, the service shows no fee.
            </p>
          }
        />
      )}

      {deleting && (
        <ConfirmModal
          open
          kind="destructive"
          title={`Delete draft ${deleting.public_label}`}
          confirmLabel="Delete"
          requireReason={false}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const ok = await run("Draft deleted", async () => {
              await deleteFeeDraft(conn.wallet, deleting);
              return `${deleting.public_label} was removed.`;
            });
            if (ok) setDeleting(null);
          }}
          description={<p>The draft was never public. Published and retired prices stay as the price history.</p>}
        />
      )}

      {loadingDefaults && (
        <ConfirmModal
          open
          kind="info"
          title="Load suggested defaults"
          confirmLabel="Create drafts"
          requireReason={false}
          onClose={() => setLoadingDefaults(false)}
          onConfirm={async () => {
            const ok = await run("Suggested defaults", async () => {
              const { created, skipped } = await loadSuggestedFeeDrafts(conn.wallet);
              if (created.length === 0) return "Nothing created: every suggested fee already has a draft or a published price.";
              return `${created.length} draft${created.length === 1 ? "" : "s"} created${skipped.length ? `; ${skipped.length} kind${skipped.length === 1 ? "" : "s"} already had one` : ""}. Nothing was published.`;
            });
            if (ok) setLoadingDefaults(false);
          }}
          description={
            <div className="space-y-2">
              <p>
                Creates DRAFTS with the owner&apos;s suggested prices, for the kinds that have no draft
                and no published price yet. Nothing is published or charged.
              </p>
              <ul className="list-disc space-y-0.5 pl-5">
                {SUGGESTED_FEE_DRAFTS.map((fee) => (
                  <li key={fee.kind}>
                    {fee.public_label}: {amountText(fee)} ({FEE_PAYER_LABEL[fee.payer].toLowerCase()})
                  </li>
                ))}
              </ul>
            </div>
          }
        />
      )}
    </section>
  );
}

function blankDraft(kind: FeeKind): FeeDraftInput {
  return {
    kind,
    payer: FEE_KIND_DEFAULT_PAYER[kind],
    fixed_eur: "0",
    rate_bps: 0,
    min_eur: null,
    max_eur: null,
    public_label: "",
    public_note: "",
    effective_from: null,
  };
}

/** A row as editor input (a published row seeds a new version's draft). */
function draftOf(fee: FeeScheduleRow): FeeDraftInput {
  const planned = fee.status === "draft" && fee.effective_from ? fee.effective_from.slice(0, 10) : null;
  return {
    kind: fee.kind,
    payer: fee.payer,
    fixed_eur: String(fee.fixed_eur),
    rate_bps: fee.rate_bps,
    min_eur: fee.min_eur === null ? null : String(fee.min_eur),
    max_eur: fee.max_eur === null ? null : String(fee.max_eur),
    public_label: fee.public_label,
    public_note: fee.public_note,
    effective_from: planned,
  };
}

const INPUT = "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none";
const LABEL = "text-xs font-medium uppercase tracking-wide text-slate-500";

function FeeDraftModal({
  row,
  initial,
  onClose,
  onSave,
}: {
  row: FeeScheduleRow | null;
  initial: FeeDraftInput;
  onClose: () => void;
  onSave: (draft: FeeDraftInput) => Promise<void>;
}) {
  const [form, setForm] = useState<FeeDraftInput>(initial);
  const [rate, setRate] = useState(String(initial.rate_bps));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof FeeDraftInput>(key: K, value: FeeDraftInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const draft: FeeDraftInput = { ...form, rate_bps: Number(rate) || 0 };
  let preview: string;
  let previewOk = true;
  try {
    preview = describeFee({ ...draft, fixed_eur: draft.fixed_eur.trim() || "0" });
  } catch (err) {
    preview = err instanceof Error ? err.message : "Cannot be priced";
    previewOk = false;
  }
  const canSave = !saving && previewOk && draft.public_label.trim() !== "" && Number(rate) <= 10_000;
  const unit = FEE_KIND_UNIT[form.kind];

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
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">{row ? "Edit draft" : "New draft"}</p>
          <p className="mt-1 text-xs text-slate-500">A draft is private until the Super Admin publishes it.</p>
        </div>
        <div className="grid gap-3 px-5 py-4 sm:grid-cols-2">
          <label className="block">
            <span className={LABEL}>Fee</span>
            <select
              value={form.kind}
              onChange={(e) => {
                const kind = e.target.value as FeeKind;
                setForm((f) => ({ ...f, kind, payer: FEE_KIND_DEFAULT_PAYER[kind] }));
              }}
              className={INPUT}
            >
              {FEE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {FEE_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={LABEL}>Who pays</span>
            <select value={form.payer} onChange={(e) => set("payer", e.target.value as FeePayer)} className={INPUT}>
              {FEE_PAYERS.map((p) => (
                <option key={p} value={p}>
                  {FEE_PAYER_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={LABEL}>Fixed EUR{unit ? ` per ${unit}` : ""}</span>
            <input value={form.fixed_eur} inputMode="decimal" onChange={(e) => set("fixed_eur", e.target.value.replace(/[^\d.]/g, ""))} className={INPUT} />
          </label>
          <label className="block">
            <span className={LABEL}>Rate (bps; 100 = 1 %)</span>
            <input value={rate} inputMode="numeric" onChange={(e) => setRate(e.target.value.replace(/\D/g, ""))} className={INPUT} />
            <span className="mt-1 block text-[11px] text-slate-400">
              {Number(rate) <= 10_000 ? formatRateBps(Number(rate) || 0) : "At most 10000 bps"}
            </span>
          </label>
          <label className="block">
            <span className={LABEL}>Minimum EUR (optional)</span>
            <input value={form.min_eur ?? ""} inputMode="decimal" onChange={(e) => set("min_eur", e.target.value.replace(/[^\d.]/g, "") || null)} className={INPUT} />
          </label>
          <label className="block">
            <span className={LABEL}>Maximum EUR (optional)</span>
            <input value={form.max_eur ?? ""} inputMode="decimal" onChange={(e) => set("max_eur", e.target.value.replace(/[^\d.]/g, "") || null)} className={INPUT} />
          </label>
          <label className="block sm:col-span-2">
            <span className={LABEL}>Public label</span>
            <input value={form.public_label} maxLength={120} onChange={(e) => set("public_label", e.target.value)} placeholder="e.g. Conversion into registered ownership" className={INPUT} />
          </label>
          <label className="block sm:col-span-2">
            <span className={LABEL}>Public note (optional)</span>
            <textarea value={form.public_note} maxLength={500} rows={2} onChange={(e) => set("public_note", e.target.value)} placeholder="Shown under the price, e.g. which third-party costs are passed through at cost" className={INPUT} />
          </label>
          <label className="block">
            <span className={LABEL}>Effective from (optional)</span>
            <input type="date" value={form.effective_from ?? ""} onChange={(e) => set("effective_from", e.target.value || null)} className={INPUT} />
            <span className="mt-1 block text-[11px] text-slate-400">Empty: from the moment it is published. A past date becomes the publication time.</span>
          </label>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 sm:self-end">
            <span className="block font-medium uppercase tracking-wide text-slate-500">Public text</span>
            <span className={previewOk ? "text-slate-800" : "text-red-700"}>{preview}</span>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave({ ...draft, fixed_eur: draft.fixed_eur.trim() || "0", public_label: draft.public_label.trim(), public_note: draft.public_note.trim() });
              } finally {
                setSaving(false);
              }
            }}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save draft"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** What publishing commits to, spelled out before the Super Admin signs. */
function PublishModal({
  fee,
  readAt,
  replaces,
  onClose,
  onConfirm,
}: {
  fee: FeeScheduleRow;
  readAt: number;
  replaces: FeeScheduleRow | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const paidByClient = fee.payer !== "issuer";
  const from = fee.effective_from && Date.parse(fee.effective_from) > readAt ? formatFeeDate(fee.effective_from) : "the moment it is published";
  return (
    <ConfirmModal
      open
      kind="warning"
      title={`Publish ${fee.public_label}`}
      confirmLabel="Publish"
      requireReason={false}
      confirmDisabled={!confirmed}
      onClose={onClose}
      onConfirm={onConfirm}
      description={
        <div className="space-y-2">
          <p>
            <strong>{amountText(fee)}</strong>, paid by the {FEE_PAYER_LABEL[fee.payer].toLowerCase()}, becomes public
            on <code>/pricing</code> and in the quote shown before a client commits. It applies from {from};
            charges of this kind are then priced from it.
          </p>
          {replaces && (
            <p>
              It replaces the published {FEE_KIND_LABEL[replaces.kind].toLowerCase()} fee ({amountText(replaces)}), which is
              retired in the same step.
            </p>
          )}
          {paidByClient ? (
            <p>
              The Terms in force (clause 11) say the Operator charges buyers and holders no fee and will publish a
              new version of the Terms before it introduces one. Publish a fee paid by a {FEE_PAYER_LABEL[fee.payer].toLowerCase()}{" "}
              only once Terms that provide for it are in force.
            </p>
          ) : (
            <p>
              The pricing page promises that existing issuers are told before platform fees are introduced, and the
              Terms say issuers pay what their engagement agreement provides. Publish only once existing issuers
              were told and their agreements allow it.
            </p>
          )}
          <label className="flex items-start gap-2 pt-1">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
            <span>Publishing this price is decided, and the Terms and the commitments above are met.</span>
          </label>
        </div>
      }
    />
  );
}
