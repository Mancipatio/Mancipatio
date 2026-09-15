"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { RequireRole } from "@/components/require-role";
import { ConfirmModal } from "@/components/confirm-modal";
import { Kpi } from "@/components/kpi";
import { SkeletonTable } from "@/components/skeleton";
import {
  createAlert,
  listAlerts,
  resolveAlert,
  type AlertSeverity,
  type AlertStatus,
  type ComplianceAlert,
} from "@/lib/compliance";
import { listClients, type ClientRow } from "@/lib/clients";
import { useToast } from "@/lib/toast";
import { detectNetwork, explorerTxUrl } from "@/lib/network";

const SEVERITY_BADGE: Record<AlertSeverity, string> = {
  low: "bg-slate-100 text-slate-700 border-slate-300",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  high: "bg-orange-100 text-orange-700 border-orange-200",
  critical: "bg-red-100 text-red-800 border-red-200",
};

const STATUS_BADGE: Record<AlertStatus, string> = {
  open: "bg-emerald-100 text-emerald-800 border-emerald-200",
  dismissed: "bg-slate-200 text-slate-700 border-slate-300",
  escalated: "bg-red-100 text-red-800 border-red-200",
  resolved: "bg-brand-100 text-brand-800 border-brand-200",
};

type Tab = "open" | "escalated" | "all";

export default function CompliancePage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Compliance
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          AML & sanctions alerts
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Daily screening results, manually tagged events and SAR-relevant
          activity. Resolve each alert with a written reason — it lands in the
          audit timeline of the linked client.
        </p>
      </div>
      <RequireRole role="admin">
        <ComplianceOps />
      </RequireRole>
    </section>
  );
}

function ComplianceOps() {
  const conn = useWalletConnection();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [alerts, setAlerts] = useState<ComplianceAlert[] | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [tab, setTab] = useState<Tab>("open");
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<ComplianceAlert | null>(null);
  const [confirm, setConfirm] = useState<{
    alert: ComplianceAlert;
    action: AlertStatus;
  } | null>(null);

  const refresh = useCallback(async () => {
    // Alerts are no longer anon-readable — the signed admin read needs the
    // connected wallet (one signature per refresh, same as /admin/fees).
    if (!conn.wallet) return;
    try {
      const [a, c] = await Promise.all([
        listAlerts(conn.wallet),
        listClients(conn.wallet),
      ]);
      setAlerts(a);
      setClients(c ?? []);
    } catch {
      setAlerts([]);
      setClients([]);
    }
  }, [conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const clientById = useMemo(() => {
    const m = new Map<string, ClientRow>();
    for (const c of clients) m.set(c.id, c);
    return m;
  }, [clients]);

  const counts = useMemo(() => {
    if (!alerts) return { open: 0, escalated: 0, total: 0 };
    return {
      open: alerts.filter((a) => a.status === "open").length,
      escalated: alerts.filter((a) => a.status === "escalated").length,
      total: alerts.length,
    };
  }, [alerts]);

  const filtered = useMemo(() => {
    if (!alerts) return [];
    if (tab === "open") return alerts.filter((a) => a.status === "open");
    if (tab === "escalated")
      return alerts.filter((a) => a.status === "escalated");
    return alerts;
  }, [alerts, tab]);

  async function applyResolution(
    alert: ComplianceAlert,
    action: AlertStatus,
    reason: string,
  ) {
    if (!wallet) return;
    try {
      await resolveAlert(conn.wallet, alert.id, action, reason, wallet.toString());
      toast.show({ kind: "success", title: `Alert ${action}` });
      setConfirm(null);
      setSelected(null);
      await refresh();
    } catch (err) {
      toast.showError(
        "Failed to resolve",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return (
    <div className="mt-8 space-y-6">
      {/* KPI tiles */}
      <section className="grid gap-3 sm:grid-cols-3">
        <Kpi
          label="Open alerts"
          value={String(counts.open)}
          tone={counts.open > 0 ? "warn" : "default"}
        />
        <Kpi
          label="Escalated"
          value={String(counts.escalated)}
          tone={counts.escalated > 0 ? "warn" : "default"}
        />
        <Kpi label="Total recorded" value={String(counts.total)} />
      </section>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(
            [
              ["open", `Open (${counts.open})`],
              ["escalated", `Escalated (${counts.escalated})`],
              ["all", `All (${counts.total})`],
            ] as [Tab, string][]
          ).map(([t, label]) => (
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
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + Tag activity
        </button>
        <Link
          href="/admin/blocklist"
          className="text-xs text-slate-600 underline-offset-2 hover:underline"
        >
          Sanctions blocklist →
        </Link>
        <button
          type="button"
          onClick={() => {
            const cols = [
              "id",
              "created_at",
              "client",
              "wallet",
              "source",
              "severity",
              "confidence",
              "hit_list",
              "status",
              "tx_signature",
              "resolution_note",
            ];
            const lines = [cols.join(",")];
            for (const a of filtered) {
              const c = a.client_id ? clientById.get(a.client_id) : null;
              lines.push(
                [
                  a.id,
                  a.created_at,
                  c?.display_name ?? "",
                  a.wallet ?? "",
                  a.source,
                  a.severity,
                  String(a.confidence),
                  `"${a.hit_list.replace(/"/g, '""')}"`,
                  a.status,
                  a.tx_signature ?? "",
                  `"${(a.resolution_note ?? "").replace(/"/g, '""')}"`,
                ].join(","),
              );
            }
            const blob = new Blob([lines.join("\n")], { type: "text/csv" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `manci-compliance-${new Date().toISOString().slice(0, 10)}.csv`;
            link.click();
            URL.revokeObjectURL(url);
          }}
          className="text-xs text-slate-600 underline-offset-2 hover:underline"
        >
          Export CSV
        </button>
      </div>

      {/* Table */}
      {alerts === null ? (
        <SkeletonTable rows={5} cols={6} />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {tab === "open"
              ? "No open compliance alerts — clean inbox 🎉"
              : "No alerts in this view."}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Use &quot;+ Tag activity&quot; to record a manual finding. Daily
            sanctions screening cron will fill this in production.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Severity</th>
                <th className="px-4 py-3 font-medium">Subject</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Hit</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((a) => {
                const c = a.client_id ? clientById.get(a.client_id) : null;
                return (
                  <tr
                    key={a.id}
                    className="cursor-pointer text-slate-700 transition-colors hover:bg-slate-50/60"
                    onClick={() => setSelected(a)}
                  >
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${SEVERITY_BADGE[a.severity]}`}
                      >
                        {a.severity}
                      </span>
                      <p className="mt-1 font-mono text-[11px] text-slate-500">
                        {a.confidence}%
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      {c ? (
                        <p className="font-medium text-slate-900">
                          {c.display_name}
                        </p>
                      ) : (
                        <p className="font-mono text-[11px] text-slate-700">
                          {a.wallet
                            ? `${a.wallet.slice(0, 6)}…${a.wallet.slice(-4)}`
                            : "(no subject)"}
                        </p>
                      )}
                      {a.summary && (
                        <p className="mt-0.5 truncate text-xs text-slate-500">
                          {a.summary}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs uppercase tracking-wider text-slate-600">
                      {a.source}
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-3 text-xs text-slate-700">
                      {a.hit_list || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[a.status]}`}
                      >
                        {a.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {new Date(a.created_at)
                        .toISOString()
                        .slice(0, 16)
                        .replace("T", " ")}
                    </td>
                    <td className="space-x-2 px-4 py-3 text-right text-xs">
                      {a.status === "open" && (
                        <>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirm({ alert: a, action: "dismissed" });
                            }}
                            className="text-slate-600 underline-offset-2 hover:underline"
                          >
                            Dismiss
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirm({ alert: a, action: "escalated" });
                            }}
                            className="text-red-700 underline-offset-2 hover:underline"
                          >
                            Escalate
                          </button>
                        </>
                      )}
                      {a.status === "escalated" && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirm({ alert: a, action: "resolved" });
                          }}
                          className="text-brand-700 underline-offset-2 hover:underline"
                        >
                          Resolve
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

      {/* Detail drawer (inline) */}
      {selected && (
        <AlertDetail
          alert={selected}
          client={selected.client_id ? clientById.get(selected.client_id) : null}
          onClose={() => setSelected(null)}
        />
      )}

      {showAdd && (
        <AddAlertModal
          clients={clients}
          onClose={() => setShowAdd(false)}
          onSuccess={() => {
            void refresh();
            setShowAdd(false);
          }}
        />
      )}

      {confirm && (
        <ConfirmModal
          open
          onClose={() => setConfirm(null)}
          onConfirm={(reason) => applyResolution(confirm.alert, confirm.action, reason)}
          title={
            confirm.action === "dismissed"
              ? "Dismiss alert"
              : confirm.action === "escalated"
                ? "Escalate alert"
                : "Resolve alert"
          }
          kind={confirm.action === "dismissed" ? "warning" : "destructive"}
          confirmLabel={
            confirm.action.charAt(0).toUpperCase() + confirm.action.slice(1)
          }
          description={
            <p>
              {confirm.action === "dismissed"
                ? "Marking this as a false positive — provide a short justification."
                : confirm.action === "escalated"
                  ? "Escalating routes this to legal / external review."
                  : "Resolution closes the alert."}
            </p>
          }
        />
      )}

      <p className="text-xs text-slate-400">
        SAR (Suspicious Activity Report) export and sanctions-list update
        tracking arrive once we wire a screening provider. CSV export above
        gives you the raw rows for now.
      </p>
    </div>
  );
}

function AlertDetail({
  alert,
  client,
  onClose,
}: {
  alert: ComplianceAlert;
  client: ClientRow | null | undefined;
  onClose: () => void;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Alert detail
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">
            {client?.display_name ?? alert.wallet ?? "(no subject)"}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {alert.source} · {alert.severity} severity · confidence {alert.confidence}%
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
        <Field
          label="Subject wallet"
          value={alert.wallet ?? "—"}
          mono={!!alert.wallet}
        />
        <Field label="Hit list" value={alert.hit_list || "—"} />
        <Field
          label="Tx signature"
          value={alert.tx_signature ?? "—"}
          mono={!!alert.tx_signature}
        />
        <Field label="Status" value={alert.status} />
        {alert.resolution_note && (
          <Field
            label="Resolution"
            value={`${alert.resolution_note} (by ${alert.resolved_by?.slice(0, 6)}…${alert.resolved_by?.slice(-4)})`}
          />
        )}
      </dl>

      {alert.summary && (
        <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 p-4 text-sm text-slate-700">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Summary
          </p>
          <p className="mt-1 whitespace-pre-wrap">{alert.summary}</p>
        </div>
      )}

      {alert.tx_signature && (
        <p className="mt-4 text-xs">
          <a
            href={explorerTxUrl(alert.tx_signature, detectNetwork())}
            target="_blank"
            rel="noopener noreferrer"
            className="text-slate-600 underline-offset-2 hover:underline"
          >
            View transaction on Explorer ↗
          </a>
        </p>
      )}

      {client && (
        <p className="mt-2 text-xs">
          <Link
            href={`/admin/clients/${client.id}`}
            className="text-slate-600 underline-offset-2 hover:underline"
          >
            Open client record →
          </Link>
        </p>
      )}
    </section>
  );
}

function AddAlertModal({
  clients,
  onClose,
  onSuccess,
}: {
  clients: ClientRow[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const [subject, setSubject] = useState<"client" | "wallet">("client");
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [wallet, setWallet] = useState("");
  const [source, setSource] = useState("manual");
  const [severity, setSeverity] = useState<AlertSeverity>("medium");
  const [confidence, setConfidence] = useState("80");
  const [hitList, setHitList] = useState("");
  const [summary, setSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      await createAlert(conn.wallet, {
        client_id: subject === "client" ? clientId : null,
        wallet: subject === "wallet" ? wallet.trim() : null,
        source,
        severity,
        confidence: Math.min(100, Math.max(0, Number(confidence) || 0)),
        hit_list: hitList,
        evidence: {},
        summary,
        tx_signature: null,
      });
      toast.show({ kind: "success", title: "Alert tagged" });
      onSuccess();
    } catch (err) {
      toast.showError(
        "Failed to tag",
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
            Tag suspicious activity
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="flex gap-2">
            {(["client", "wallet"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSubject(s)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  subject === s
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                }`}
              >
                {s === "client" ? "Known client" : "Raw wallet"}
              </button>
            ))}
          </div>

          {subject === "client" ? (
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Client
              </span>
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                {clients.length === 0 && (
                  <option value="">(no clients yet)</option>
                )}
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name} ({c.type})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Wallet address
              </span>
              <input
                value={wallet}
                onChange={(e) => setWallet(e.target.value)}
                placeholder="Solana address"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
              />
            </label>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Source
              </span>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                <option value="manual">Manual</option>
                <option value="ofac">OFAC</option>
                <option value="eu">EU CFSP</option>
                <option value="un">UN</option>
                <option value="tx-pattern">Tx pattern</option>
                <option value="kyb-discrepancy">KYB discrepancy</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Severity
              </span>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as AlertSeverity)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Confidence (0–100)
              </span>
              <input
                value={confidence}
                inputMode="numeric"
                onChange={(e) =>
                  setConfidence(e.target.value.replace(/\D/g, ""))
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Hit list
              </span>
              <input
                value={hitList}
                onChange={(e) => setHitList(e.target.value)}
                placeholder="OFAC SDN, EU CFSP, …"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Summary
            </span>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={3}
              placeholder="Short description of the finding"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
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
            disabled={
              submitting ||
              (subject === "client" && !clientId) ||
              (subject === "wallet" && !wallet.trim())
            }
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Create alert"}
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
