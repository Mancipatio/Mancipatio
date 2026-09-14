"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { Kpi } from "@/components/kpi";
import { RequireRole } from "@/components/require-role";
import { SkeletonTable } from "@/components/skeleton";
import {
  INQUIRY_STATUSES,
  listInquiries,
  updateInquiry,
  type CustomInquiry,
  type InquiryStatus,
} from "@/lib/inquiries";
import { useToast } from "@/lib/toast";

const STATUS_BADGE: Record<InquiryStatus, string> = {
  new: "bg-emerald-100 text-emerald-800 border-emerald-200",
  in_review: "bg-amber-100 text-amber-800 border-amber-200",
  proposed: "bg-brand-100 text-brand-800 border-brand-200",
  agreed: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
  archived: "bg-slate-200 text-slate-700 border-slate-300",
};

const STATUS_LABEL: Record<InquiryStatus, string> = {
  new: "New",
  in_review: "In review",
  proposed: "Proposed",
  agreed: "Agreed",
  rejected: "Rejected",
  archived: "Archived",
};

type Tab = InquiryStatus | "all";

export default function InquiriesPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          People
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Custom tokenization inquiries
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Contact-form submissions and &quot;Other&quot; asset ideas. Evaluate
          each one, propose a solution, and track it through to agreed or
          rejected — the full flow stays off-chain.
        </p>
      </div>
      <RequireRole role="admin">
        <InquiriesOps />
      </RequireRole>
    </section>
  );
}

function InquiriesOps() {
  const conn = useWalletConnection();
  const toast = useToast();
  const [inquiries, setInquiries] = useState<CustomInquiry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [selected, setSelected] = useState<CustomInquiry | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInquiries(await listInquiries(conn.wallet));
      setLoadError(null);
    } catch (err) {
      // Distinguish an auth/transport failure from a genuinely empty inbox —
      // otherwise a rejected signature silently renders "No inquiries yet".
      setInquiries(null);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const counts = useMemo(() => {
    const c: Record<Tab, number> = {
      all: inquiries?.length ?? 0,
      new: 0,
      in_review: 0,
      proposed: 0,
      agreed: 0,
      rejected: 0,
      archived: 0,
    };
    for (const i of inquiries ?? []) c[i.status] += 1;
    return c;
  }, [inquiries]);

  const filtered = useMemo(() => {
    if (!inquiries) return [];
    return tab === "all"
      ? inquiries
      : inquiries.filter((i) => i.status === tab);
  }, [inquiries, tab]);

  async function setStatus(inquiry: CustomInquiry, status: InquiryStatus) {
    try {
      // handled_by / handled_at are stamped server-side from the verified wallet.
      const ok = await updateInquiry(conn.wallet, inquiry.id, { status });
      if (!ok) throw new Error("Update failed — see console.");
      toast.show({
        kind: "success",
        title: `Marked as ${STATUS_LABEL[status].toLowerCase()}`,
      });
      setSelected(null);
      await refresh();
    } catch (err) {
      toast.showError(
        "Failed to update inquiry",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return (
    <div className="mt-8 space-y-6">
      {/* KPI tiles */}
      <section className="grid gap-3 sm:grid-cols-3">
        <Kpi
          label="New"
          value={String(counts.new)}
          tone={counts.new > 0 ? "warn" : "default"}
        />
        <Kpi label="In review" value={String(counts.in_review)} />
        <Kpi label="Total" value={String(counts.all)} />
      </section>

      {/* Status filter */}
      <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
        {(["all", ...INQUIRY_STATUSES] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              tab === t
                ? "bg-slate-900 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {t === "all" ? "All" : STATUS_LABEL[t]} ({counts[t]})
          </button>
        ))}
      </div>

      {/* Table */}
      {loadError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center shadow-card">
          <p className="text-sm font-medium text-red-800">
            Could not load inquiries
          </p>
          <p className="mt-1 text-xs text-red-600">{loadError}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-4 rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            Sign to load
          </button>
        </div>
      ) : inquiries === null ? (
        <SkeletonTable rows={4} cols={5} />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {tab === "all"
              ? "No inquiries yet — the contact form feeds this inbox."
              : "No inquiries in this view."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Contact</th>
                <th className="px-4 py-3 font-medium">Asset kind</th>
                <th className="px-4 py-3 font-medium">Idea</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((i) => (
                <tr
                  key={i.id}
                  className="cursor-pointer text-slate-700 transition-colors hover:bg-slate-50/60"
                  onClick={() => setSelected(i)}
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">{i.name}</p>
                    <p className="text-xs text-slate-500">
                      {i.company ?? i.email}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {i.asset_kind || "—"}
                  </td>
                  <td className="max-w-[280px] truncate px-4 py-3 text-xs text-slate-600">
                    {i.idea}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[i.status]}`}
                    >
                      {STATUS_LABEL[i.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {new Date(i.created_at)
                      .toISOString()
                      .slice(0, 16)
                      .replace("T", " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <InquiryDetail
          inquiry={selected}
          onClose={() => setSelected(null)}
          onSetStatus={(s) => void setStatus(selected, s)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

function InquiryDetail({
  inquiry,
  onClose,
  onSetStatus,
  onSaved,
}: {
  inquiry: CustomInquiry;
  onClose: () => void;
  onSetStatus: (status: InquiryStatus) => void;
  onSaved: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const [note, setNote] = useState(inquiry.admin_note ?? "");
  const [saving, setSaving] = useState(false);

  async function saveNote() {
    setSaving(true);
    try {
      const ok = await updateInquiry(conn.wallet, inquiry.id, {
        admin_note: note,
      });
      if (!ok) throw new Error("Update failed — see console.");
      toast.show({ kind: "success", title: "Note saved" });
      await onSaved();
    } catch (err) {
      toast.showError(
        "Failed to save note",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Inquiry detail
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">
            {inquiry.name}
            {inquiry.company ? (
              <span className="text-slate-500"> · {inquiry.company}</span>
            ) : null}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Received{" "}
            {new Date(inquiry.created_at)
              .toISOString()
              .slice(0, 16)
              .replace("T", " ")}{" "}
            UTC · status {STATUS_LABEL[inquiry.status].toLowerCase()}
          </p>
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
        <Field label="Email" value={inquiry.email} />
        <Field label="Asset kind" value={inquiry.asset_kind || "—"} />
        {inquiry.handled_by && (
          <Field
            label="Handled by"
            value={`${inquiry.handled_by.slice(0, 6)}…${inquiry.handled_by.slice(-4)}${
              inquiry.handled_at
                ? ` on ${new Date(inquiry.handled_at).toISOString().slice(0, 10)}`
                : ""
            }`}
            mono
          />
        )}
      </dl>

      <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 p-4 text-sm text-slate-700">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Idea
        </p>
        <p className="mt-1 whitespace-pre-wrap">{inquiry.idea}</p>
      </div>

      <label className="mt-4 block">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Admin note (internal)
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Evaluation, proposed solution, next steps…"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
        />
      </label>
      <div className="mt-2">
        <button
          type="button"
          onClick={() => void saveNote()}
          disabled={saving || note === (inquiry.admin_note ?? "")}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:border-slate-400 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save note"}
        </button>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 text-xs">
        <span className="mr-1 font-medium uppercase tracking-wide text-slate-500">
          Move to
        </span>
        {INQUIRY_STATUSES.filter((s) => s !== inquiry.status).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSetStatus(s)}
            className={`rounded-md border px-3 py-1.5 font-medium transition-colors ${
              s === "rejected"
                ? "border-red-200 text-red-700 hover:bg-red-50"
                : s === "archived"
                  ? "border-slate-200 text-slate-600 hover:bg-slate-100"
                  : "border-slate-300 text-slate-800 hover:border-slate-400"
            }`}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>
    </section>
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
