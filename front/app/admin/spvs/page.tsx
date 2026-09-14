"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import {
  IconBuilding,
  IconCheck,
  IconCoins,
  IconWarning,
} from "@/components/icons";
import { Kpi } from "@/components/kpi";
import { RequireRole } from "@/components/require-role";
import { SkeletonTable } from "@/components/skeleton";
import { ConfirmModal } from "@/components/confirm-modal";
import { useRole } from "@/lib/auth";
import { listClients, type ClientRow } from "@/lib/clients";
import { COUNTRIES, countryName } from "@/lib/countries";
import {
  createSpv,
  listIssuances,
  listSpvs,
  recordIssuance,
  SPV_ANNUAL_CAP_EUR,
  updateSpv,
  yearIssuanceTotal,
  type SpvIssuance,
  type SpvRow,
  type SpvStatus,
} from "@/lib/spvs";
import { recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";

const STATUSES: SpvStatus[] = ["planned", "incorporating", "active", "retired"];

const STATUS_LABEL: Record<SpvStatus, string> = {
  planned: "Planned",
  incorporating: "Incorporating",
  active: "Active",
  retired: "Retired",
};

const STATUS_BADGE: Record<SpvStatus, string> = {
  planned: "bg-slate-100 text-slate-700 border-slate-300",
  incorporating: "bg-amber-100 text-amber-800 border-amber-200",
  active: "bg-emerald-100 text-emerald-800 border-emerald-200",
  retired: "bg-slate-300 text-slate-700 border-slate-400",
};

const EUR = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

function fmtEur(v: number): string {
  return EUR.format(v);
}

export default function SpvsPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="page-eyebrow">SPVs</p>
        <h1 className="page-title">SPV registry</h1>
        <p className="page-sub">
          Serbian special-purpose vehicles used for token issuance. Issuers
          without a Serbian company get an SPV incorporated by Mancipatio.
          Each SPV may issue at most EUR 3,000,000 per calendar year.
        </p>
      </div>
      <RequireRole role="admin">
        <SpvsOps />
      </RequireRole>
    </section>
  );
}

function SpvsOps() {
  const conn = useWalletConnection();
  const [rows, setRows] = useState<SpvRow[] | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [yearTotals, setYearTotals] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SpvStatus | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const currentYear = new Date().getFullYear();

  const refresh = useCallback(async () => {
    if (!conn.wallet) return;
    const [spvs, clientRows] = await Promise.all([
      listSpvs(),
      listClients(conn.wallet),
    ]);
    setRows(spvs);
    setClients(clientRows);
    const totals = await Promise.all(
      spvs.map(async (s) => [s.id, await yearIssuanceTotal(s.id, currentYear)] as const),
    );
    setYearTotals(Object.fromEntries(totals));
  }, [currentYear, conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const clientName = useCallback(
    (id: string | null) => {
      if (!id) return null;
      return clients.find((c) => c.id === id)?.display_name ?? null;
    },
    [clients],
  );

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== "all" && r.status !== status) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        (r.registration_number ?? "").toLowerCase().includes(q) ||
        countryName(r.country).toLowerCase().includes(q) ||
        (clientName(r.client_id) ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, status, clientName]);

  const kpis = useMemo(() => {
    if (!rows) return null;
    const aggregate = rows.reduce(
      (sum, r) => sum + (yearTotals[r.id] ?? 0),
      0,
    );
    const nearCap = rows.filter((r) => {
      const cap = r.annual_cap_eur || SPV_ANNUAL_CAP_EUR;
      return (yearTotals[r.id] ?? 0) >= cap * 0.8;
    }).length;
    return {
      total: rows.length,
      active: rows.filter((r) => r.status === "active").length,
      aggregate,
      nearCap,
    };
  }, [rows, yearTotals]);

  const selected = useMemo(
    () => rows?.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  );

  return (
    <div className="mt-8 space-y-6">
      {/* KPIs */}
      {kpis && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Kpi
            label="Total SPVs"
            value={String(kpis.total)}
            icon={<IconBuilding />}
          />
          <Kpi
            label="Active"
            value={String(kpis.active)}
            icon={<IconCheck />}
            tone="good"
          />
          <Kpi
            label={`Issued ${currentYear} (all SPVs)`}
            value={fmtEur(kpis.aggregate)}
            icon={<IconCoins />}
          />
          <Kpi
            label="Over 80% of cap"
            value={String(kpis.nearCap)}
            icon={<IconWarning />}
            tone={kpis.nearCap > 0 ? "warn" : "quiet"}
          />
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, reg number, country or client…"
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(["all", ...STATUSES] as const).map((s) => (
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
          onClick={() => setShowAdd(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + Add SPV
        </button>
      </div>

      {/* Table */}
      {rows === null ? (
        <SkeletonTable rows={5} cols={6} />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {rows.length === 0
              ? "No SPVs on record yet — add the first one with + Add SPV."
              : "No SPVs match the current filter."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">SPV</th>
                <th className="px-4 py-3 font-medium">Country</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">{currentYear} issuance / cap</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((r) => {
                const isSelected = r.id === selectedId;
                const cap = r.annual_cap_eur || SPV_ANNUAL_CAP_EUR;
                const used = yearTotals[r.id] ?? 0;
                const pct = cap > 0 ? used / cap : 0;
                return (
                  <tr
                    key={r.id}
                    onClick={() => setSelectedId(isSelected ? null : r.id)}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? "bg-slate-50" : "hover:bg-slate-50/60"
                    }`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{r.name}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {r.registration_number
                          ? `Reg. ${r.registration_number}`
                          : "No registration number"}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {countryName(r.country)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[r.status]}`}
                      >
                        {STATUS_LABEL[r.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {clientName(r.client_id) ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <p
                        className={`text-xs font-medium ${
                          pct >= 1
                            ? "text-red-700"
                            : pct >= 0.8
                              ? "text-amber-700"
                              : "text-slate-700"
                        }`}
                      >
                        {fmtEur(used)}{" "}
                        <span className="font-normal text-slate-400">
                          / {fmtEur(cap)}
                        </span>
                      </p>
                      <CapBar pct={pct} className="mt-1.5 w-36" />
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

      {/* Detail */}
      {selected && (
        <SpvDetail
          key={selected.id}
          spv={selected}
          clients={clients}
          currentYearTotal={yearTotals[selected.id] ?? 0}
          onRefresh={refresh}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* Add modal */}
      {showAdd && (
        <AddSpvModal
          clients={clients}
          onClose={() => setShowAdd(false)}
          onSuccess={(id) => {
            void refresh();
            setSelectedId(id);
            setShowAdd(false);
          }}
        />
      )}
    </div>
  );
}

function CapBar({ pct, className = "" }: { pct: number; className?: string }) {
  const width = Math.min(pct, 1) * 100;
  const barCls =
    pct >= 1 ? "bg-red-500" : pct >= 0.8 ? "bg-amber-500" : "bg-slate-500";
  return (
    <div
      className={`h-1.5 overflow-hidden rounded-full bg-slate-100 ${className}`}
      role="progressbar"
      aria-valuenow={Math.round(pct * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-all ${barCls}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

function SpvDetail({
  spv,
  clients,
  currentYearTotal,
  onRefresh,
  onClose,
}: {
  spv: SpvRow;
  clients: ClientRow[];
  currentYearTotal: number;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const wallet = conn.wallet?.account.address?.toString() ?? "";

  // Edit fields
  const [name, setName] = useState(spv.name);
  const [regNumber, setRegNumber] = useState(spv.registration_number ?? "");
  const [country, setCountry] = useState(spv.country);
  const [statusVal, setStatusVal] = useState<SpvStatus>(spv.status);
  const [clientId, setClientId] = useState(spv.client_id ?? "");
  const [incorporatedAt, setIncorporatedAt] = useState(
    spv.incorporated_at ?? "",
  );
  const [notes, setNotes] = useState(spv.notes);
  const [saving, setSaving] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);

  // Issuance ledger
  const [issuances, setIssuances] = useState<SpvIssuance[] | null>(null);

  const loadIssuances = useCallback(async () => {
    setIssuances(await listIssuances(spv.id));
  }, [spv.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadIssuances();
  }, [loadIssuances]);

  const cap = spv.annual_cap_eur || SPV_ANNUAL_CAP_EUR;
  const pct = cap > 0 ? currentYearTotal / cap : 0;
  const currentYear = new Date().getFullYear();

  const priorYearTotals = useMemo(() => {
    if (!issuances) return [];
    const byYear = new Map<number, number>();
    for (const i of issuances) {
      const y = Number(String(i.issued_at).slice(0, 4));
      if (!Number.isFinite(y) || y >= currentYear) continue;
      byYear.set(y, (byYear.get(y) ?? 0) + Number(i.amount_eur ?? 0));
    }
    return [...byYear.entries()].sort((a, b) => b[0] - a[0]);
  }, [issuances, currentYear]);

  const isRetiring = statusVal === "retired" && spv.status !== "retired";

  async function doSave(reason: string) {
    setSaving(true);
    try {
      const ok = await updateSpv(conn.wallet, spv.id, {
        name: name.trim(),
        registration_number: regNumber.trim() || null,
        country,
        status: statusVal,
        client_id: clientId || null,
        incorporated_at: incorporatedAt || null,
        notes,
      });
      if (!ok) throw new Error("Update failed — Supabase unreachable?");
      toast.show({
        kind: "success",
        title: "SPV updated",
        description: `${name.trim()} saved.`,
      });
      void recordAudit({
        ix_name: "spv_update",
        category: "other",
        actor_wallet: wallet,
        reason,
        target_label: `${name.trim()} · ${STATUS_LABEL[statusVal]}`,
        status: "success",
        metadata: { spv_id: spv.id, new_status: statusVal },
      });
      setConfirmRetire(false);
      await onRefresh();
    } catch (err) {
      toast.showError(
        "Failed to update SPV",
        err instanceof Error ? err.message : String(err),
      );
      void recordAudit({
        ix_name: "spv_update",
        category: "other",
        actor_wallet: wallet,
        reason,
        target_label: name.trim(),
        status: "failed",
        metadata: {
          spv_id: spv.id,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      setSaving(false);
    }
  }

  function onSaveClick() {
    if (!name.trim()) return;
    if (isRetiring) {
      setConfirmRetire(true);
      return;
    }
    void doSave("SPV details updated via admin registry");
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            SPV detail
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">
            {spv.name}
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

      {/* Cap tracker */}
      <div
        className={`mt-5 rounded-lg border p-4 ${
          pct >= 1
            ? "border-red-200 bg-red-50"
            : pct >= 0.8
              ? "border-amber-200 bg-amber-50"
              : "border-slate-200 bg-slate-50"
        }`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">
            {currentYear} issuance cap
          </p>
          <p className="text-sm font-medium text-slate-900">
            {fmtEur(currentYearTotal)}{" "}
            <span className="font-normal text-slate-500">
              of {fmtEur(cap)} ({Math.round(pct * 100)}%)
            </span>
          </p>
        </div>
        <CapBar pct={pct} className="mt-2" />
        {pct >= 1 ? (
          <p className="mt-2 text-xs font-medium text-red-800">
            EUR 3M annual cap reached — issuance beyond this requires legal
            review.
          </p>
        ) : pct >= 0.8 ? (
          <p className="mt-2 text-xs font-medium text-amber-800">
            This SPV is approaching the EUR 3M annual cap.
          </p>
        ) : null}
        {priorYearTotals.length > 0 && (
          <p className="mt-2 text-[11px] text-slate-500">
            Prior years:{" "}
            {priorYearTotals
              .map(([y, total]) => `${y} — ${fmtEur(total)}`)
              .join(" · ")}
          </p>
        )}
      </div>

      {/* Edit form */}
      <div className="mt-6 border-t border-slate-100 pt-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Details
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Name *
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Registration number
            </span>
            <input
              value={regNumber}
              onChange={(e) => setRegNumber(e.target.value)}
              placeholder="e.g. 21999999"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Country
            </span>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Status
            </span>
            <select
              value={statusVal}
              onChange={(e) => setStatusVal(e.target.value as SpvStatus)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            {isRetiring && (
              <span className="mt-1 block text-[11px] text-red-700">
                Retiring an SPV requires a reason (recorded in the audit log).
              </span>
            )}
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Linked client
            </span>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              <option value="">No linked client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Incorporated at
            </span>
            <input
              type="date"
              value={incorporatedAt}
              onChange={(e) => setIncorporatedAt(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Notes
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onSaveClick}
            disabled={saving || !name.trim()}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      {/* Issuance ledger */}
      <div className="mt-6 border-t border-slate-100 pt-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Issuance ledger
        </p>
        {issuances === null ? (
          <p className="mt-3 text-xs text-slate-500">Loading…</p>
        ) : issuances.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">
            No issuances recorded against this SPV yet.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">
                    Amount (EUR)
                  </th>
                  <th className="px-3 py-2 font-medium">Asset / sale ref</th>
                  <th className="px-3 py-2 font-medium">Note</th>
                  <th className="px-3 py-2 font-medium">Recorded by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {issuances.map((i) => (
                  <tr key={i.id} className="text-slate-700">
                    <td className="px-3 py-2 whitespace-nowrap">
                      {String(i.issued_at).slice(0, 10)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {fmtEur(Number(i.amount_eur ?? 0))}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-500">
                      {i.asset_pda
                        ? `${i.asset_pda.slice(0, 6)}…${i.asset_pda.slice(-4)}`
                        : i.sale_pubkey
                          ? `${i.sale_pubkey.slice(0, 6)}…${i.sale_pubkey.slice(-4)}`
                          : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {i.cap_override && (
                        <span className="mr-1.5 inline-flex rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                          cap override
                        </span>
                      )}
                      {i.source === "sale" && (
                        <span className="mr-1.5 inline-flex rounded-full border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                          auto · sale
                        </span>
                      )}
                      {i.note ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-500">
                      {i.recorded_by
                        ? `${i.recorded_by.slice(0, 6)}…${i.recorded_by.slice(-4)}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <RecordIssuanceForm
          spv={spv}
          wallet={wallet}
          issuances={issuances}
          onRecorded={async () => {
            await Promise.all([loadIssuances(), onRefresh()]);
          }}
        />
      </div>

      <ConfirmModal
        open={confirmRetire}
        onClose={() => setConfirmRetire(false)}
        onConfirm={(reason) => void doSave(reason)}
        title="Retire SPV"
        kind="destructive"
        confirmLabel="Retire SPV"
        description={
          <>
            <p>
              Retiring marks <strong>{spv.name}</strong> as no longer usable
              for new issuance. Its issuance ledger stays on record.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log.
            </p>
          </>
        }
        busy={saving}
      />
    </div>
  );
}

function RecordIssuanceForm({
  spv,
  wallet,
  issuances,
  onRecorded,
}: {
  spv: SpvRow;
  wallet: string;
  issuances: SpvIssuance[] | null;
  onRecorded: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const { isSuperAdmin } = useRole();
  const today = new Date().toISOString().slice(0, 10);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmOverride, setConfirmOverride] = useState(false);

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;

  const cap = spv.annual_cap_eur || SPV_ANNUAL_CAP_EUR;
  const issuanceYear = Number(date.slice(0, 4));

  // Calendar-year total for the year of the selected issuance date, from the
  // already-loaded ledger (kept fresh by the parent's loadIssuances()).
  const yearTotal = useMemo(() => {
    if (!issuances || !Number.isFinite(issuanceYear)) return null;
    return issuances
      .filter((i) => Number(String(i.issued_at).slice(0, 4)) === issuanceYear)
      .reduce((sum, i) => sum + Number(i.amount_eur ?? 0), 0);
  }, [issuances, issuanceYear]);

  const projected = (yearTotal ?? 0) + (amountValid ? amountNum : 0);
  const overCap = amountValid && yearTotal !== null && projected > cap;

  async function submit(overrideReason?: string) {
    if (!amountValid || !date) return;
    setSubmitting(true);
    const pendingId = toast.showPending(
      "Recording issuance…",
      `${fmtEur(amountNum)} against ${spv.name}`,
    );
    try {
      // Fresh cap check at submit time (the loaded ledger may be stale if
      // another admin recorded in the meantime). The 0027 DB trigger is the
      // authoritative guard; this closes the gap client-side with a clear error.
      if (!overrideReason) {
        const freshTotal = await yearIssuanceTotal(spv.id, issuanceYear);
        if (freshTotal + amountNum > cap) {
          throw new Error(
            `Annual cap exceeded: ${fmtEur(freshTotal)} already issued in ${issuanceYear}; adding ${fmtEur(amountNum)} would exceed the ${fmtEur(cap)} cap. ${
              isSuperAdmin
                ? "Use the override flow to record anyway."
                : "Only a super admin can override the cap."
            }`,
          );
        }
      }
      const refTrim = ref.trim();
      const res = await recordIssuance(conn.wallet, {
        spv_id: spv.id,
        amount_eur: amountNum,
        issued_at: date,
        asset_pda: refTrim || undefined,
        note: note.trim() || undefined,
        recorded_by: wallet || undefined,
        cap_override: overrideReason ? true : undefined,
      });
      if (!res.ok) {
        throw new Error(res.error ?? "Insert failed — Supabase unreachable?");
      }
      toast.dismiss(pendingId);
      toast.show({
        kind: "success",
        title: overrideReason
          ? "Issuance recorded (cap override)"
          : "Issuance recorded",
        description: `${fmtEur(amountNum)} booked against ${spv.name} for ${date}.`,
      });
      void recordAudit({
        ix_name: overrideReason ? "spv_issuance_cap_override" : "spv_issuance",
        category: "other",
        actor_wallet: wallet,
        reason:
          overrideReason ??
          (note.trim() || "Issuance recorded via SPV registry"),
        target_label: `${spv.name} · ${fmtEur(amountNum)} · ${date}`,
        status: "success",
        metadata: {
          spv_id: spv.id,
          amount_eur: amountNum,
          ref: refTrim || null,
          cap_override: Boolean(overrideReason),
          annual_cap_eur: cap,
          year_total_before: yearTotal,
        },
      });
      setConfirmOverride(false);
      setAmount("");
      setDate(today);
      setRef("");
      setNote("");
      await onRecorded();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to record issuance",
        err instanceof Error ? err.message : String(err),
      );
      void recordAudit({
        ix_name: overrideReason ? "spv_issuance_cap_override" : "spv_issuance",
        category: "other",
        actor_wallet: wallet,
        reason:
          overrideReason ??
          (note.trim() || "Issuance recorded via SPV registry"),
        target_label: `${spv.name} · ${fmtEur(amountNum)}`,
        status: "failed",
        metadata: {
          spv_id: spv.id,
          cap_override: Boolean(overrideReason),
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      setSubmitting(false);
    }
  }

  function onRecordClick() {
    if (!amountValid || !date) return;
    if (overCap) {
      if (isSuperAdmin) setConfirmOverride(true);
      return; // non-super-admins are blocked (button is disabled anyway)
    }
    void submit();
  }

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        Record issuance
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Amount (EUR) *
          </span>
          <input
            value={amount}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 250000"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          />
          {amount.trim() !== "" && !amountValid && (
            <span className="mt-1 block text-[11px] text-red-700">
              Must be a positive number
            </span>
          )}
        </label>
        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Date
          </span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Asset / sale ref (optional)
          </span>
          <input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="Asset PDA or sale pubkey"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Note (optional)
          </span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. primary sale tranche 2"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          />
        </label>
      </div>
      {amountValid && yearTotal !== null && (
        <p
          className={`mt-2 text-[11px] font-medium ${
            overCap ? "text-red-700" : "text-slate-500"
          }`}
        >
          Projected {issuanceYear} total: {fmtEur(projected)} of {fmtEur(cap)}{" "}
          cap ({fmtEur(yearTotal)} already recorded)
        </p>
      )}
      {overCap && (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800">
          <p className="font-semibold">
            This issuance would exceed the {fmtEur(cap)} annual cap for{" "}
            {spv.name} in {issuanceYear}.
          </p>
          <p className="mt-1">
            {isSuperAdmin
              ? "As super admin you may record it anyway with a mandatory, audited override reason."
              : "Recording is blocked. Only the platform super admin can override the cap, and every override is recorded in the audit log."}
          </p>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] text-slate-400">
          Recorded by: {wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Not connected"}
        </p>
        <button
          type="button"
          onClick={onRecordClick}
          disabled={
            submitting || !amountValid || !date || (overCap && !isSuperAdmin)
          }
          className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${
            overCap && isSuperAdmin
              ? "bg-red-600 hover:bg-red-700"
              : "bg-slate-900 hover:bg-slate-800"
          }`}
        >
          {submitting
            ? "Saving…"
            : overCap && isSuperAdmin
              ? "Record with override…"
              : "Record issuance"}
        </button>
      </div>

      <ConfirmModal
        open={confirmOverride}
        onClose={() => setConfirmOverride(false)}
        onConfirm={(reason) => void submit(reason)}
        title="Override the EUR 3M annual cap"
        kind="destructive"
        confirmLabel="Record with override"
        reasonPlaceholder="Legal basis for exceeding the annual cap (visible in audit log)"
        description={
          <>
            <p>
              Recording {amountValid ? fmtEur(amountNum) : "this amount"}{" "}
              pushes <strong>{spv.name}</strong> to{" "}
              <strong>{fmtEur(projected)}</strong> for {issuanceYear} — over
              its annual cap of <strong>{fmtEur(cap)}</strong>.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              The row is permanently flagged as a cap override and your reason
              is recorded in the audit log. Issuance beyond the cap normally
              requires legal review.
            </p>
          </>
        }
        busy={submitting}
      />
    </div>
  );
}

function AddSpvModal({
  clients,
  onClose,
  onSuccess,
}: {
  clients: ClientRow[];
  onClose: () => void;
  onSuccess: (id: string) => void;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const wallet = conn.wallet?.account.address?.toString() ?? "";
  const [name, setName] = useState("");
  const [regNumber, setRegNumber] = useState("");
  const [country, setCountry] = useState("688");
  const [status, setStatus] = useState<SpvStatus>("planned");
  const [clientId, setClientId] = useState("");
  const [incorporatedAt, setIncorporatedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const id = await createSpv(conn.wallet, {
        name: name.trim(),
        registration_number: regNumber.trim() || undefined,
        country,
        status,
        client_id: clientId || undefined,
        incorporated_at: incorporatedAt || undefined,
        notes: notes.trim() || undefined,
      });
      if (!id) throw new Error("Insert failed — Supabase unreachable?");
      toast.show({
        kind: "success",
        title: "SPV added",
        description: `${name.trim()} created as ${STATUS_LABEL[status]}.`,
      });
      void recordAudit({
        ix_name: "spv_create",
        category: "other",
        actor_wallet: wallet,
        reason: "SPV added via admin registry",
        target_label: `${name.trim()} · ${STATUS_LABEL[status]}`,
        status: "success",
        metadata: { spv_id: id, country, client_id: clientId || null },
      });
      onSuccess(id);
    } catch (err) {
      toast.showError(
        "Failed to add SPV",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Add SPV
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-slate-600">
            SPV pipeline: planned → incorporating → active. If the issuer has
            no Serbian company, Mancipatio incorporates the SPV on their
            behalf. The annual issuance cap of EUR 3,000,000 applies per SPV.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Name *
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. ACME SPV d.o.o."
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                autoFocus
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Registration number
              </span>
              <input
                value={regNumber}
                onChange={(e) => setRegNumber(e.target.value)}
                placeholder="APR matični broj"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Country
              </span>
              <select
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Status
              </span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as SpvStatus)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Linked client (optional)
              </span>
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                <option value="">No linked client</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Incorporated at
              </span>
              <input
                type="date"
                value={incorporatedAt}
                onChange={(e) => setIncorporatedAt(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Notes
              </span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Internal notes — incorporation agent, timelines…"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || !name.trim()}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Create SPV"}
          </button>
        </div>
      </div>
    </div>
  );
}
