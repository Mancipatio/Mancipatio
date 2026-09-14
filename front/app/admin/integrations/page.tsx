"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { Kpi } from "@/components/kpi";
import { RequireRole } from "@/components/require-role";
import { SkeletonCard } from "@/components/skeleton";
import { useRole } from "@/lib/auth";
import { signedFetch } from "@/lib/siws-client";
import { useToast } from "@/lib/toast";

type IntegrationKind =
  | "rpc"
  | "indexer"
  | "kyc"
  | "email"
  | "oracle"
  | "onramp"
  | "multisig"
  | "monitoring"
  | "analytics"
  | "storage"
  | "other";

type Status =
  | "not_configured"
  | "configured"
  | "degraded"
  | "failing"
  | "disabled";

type Integration = {
  slug: string;
  kind: IntegrationKind;
  label: string;
  status: Status;
  config: Record<string, unknown>;
  notes: string;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

const KIND_LABEL: Record<IntegrationKind, string> = {
  rpc: "RPC",
  indexer: "Indexer / DB",
  kyc: "KYC / KYB",
  email: "Email",
  oracle: "Oracle",
  onramp: "Onramp",
  multisig: "Multisig",
  monitoring: "Monitoring",
  analytics: "Analytics",
  storage: "Storage",
  other: "Other",
};

const STATUS_LABEL: Record<Status, string> = {
  not_configured: "Not configured",
  configured: "Configured",
  degraded: "Degraded",
  failing: "Failing",
  disabled: "Disabled",
};

const STATUS_BADGE: Record<Status, string> = {
  not_configured: "bg-slate-100 text-slate-600 border-slate-300",
  configured: "bg-emerald-100 text-emerald-800 border-emerald-200",
  degraded: "bg-amber-100 text-amber-800 border-amber-200",
  failing: "bg-red-100 text-red-800 border-red-200",
  disabled: "bg-slate-200 text-slate-700 border-slate-300",
};

export default function IntegrationsPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Integrations
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Vendor configuration
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Per-vendor status, non-secret config and notes. Secrets themselves
          live in Vercel env / Supabase Vault — this registry just declares
          which integrations are live.
        </p>
      </div>
      <RequireRole role="admin">
        <IntegrationsOps />
      </RequireRole>
    </section>
  );
}

function IntegrationsOps() {
  const conn = useWalletConnection();
  const { isSuperAdmin } = useRole();
  const [rows, setRows] = useState<Integration[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edit, setEdit] = useState<Integration | null>(null);

  const refresh = useCallback(async () => {
    if (!conn.wallet) return;
    try {
      // Signed admin read — the registry is no longer anon-readable.
      const data = await signedFetch<{ integrations: Integration[] }>(
        conn.wallet,
        "/api/admin-config/read",
        "adminConfig.read",
        { scope: "integrations" },
      );
      setRows(data.integrations ?? []);
      setLoadError(null);
    } catch (err) {
      // Distinguish a rejected signature / auth failure from an empty
      // registry — otherwise the page silently renders nothing.
      setRows(null);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const counts = useMemo(() => {
    if (!rows) return null;
    return {
      total: rows.length,
      configured: rows.filter((r) => r.status === "configured").length,
      pending: rows.filter((r) => r.status === "not_configured").length,
      degraded: rows.filter(
        (r) => r.status === "degraded" || r.status === "failing",
      ).length,
    };
  }, [rows]);

  const grouped = useMemo(() => {
    if (!rows) return [];
    const map = new Map<IntegrationKind, Integration[]>();
    for (const r of rows) {
      const list = map.get(r.kind) ?? [];
      list.push(r);
      map.set(r.kind, list);
    }
    return Array.from(map.entries());
  }, [rows]);

  return (
    <div className="mt-8 space-y-6">
      {counts && (
        <section className="grid gap-3 sm:grid-cols-4">
          <Kpi label="Total" value={String(counts.total)} />
          <Kpi
            label="Configured"
            value={String(counts.configured)}
            tone={counts.configured > 0 ? "good" : "default"}
          />
          <Kpi
            label="Not configured"
            value={String(counts.pending)}
            tone={counts.pending > 0 ? "warn" : "default"}
          />
          <Kpi
            label="Degraded / failing"
            value={String(counts.degraded)}
            tone={counts.degraded > 0 ? "bad" : "default"}
          />
        </section>
      )}

      {loadError !== null ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6">
          <p className="text-sm font-semibold text-red-900">
            Could not load integrations
          </p>
          <p className="mt-1 text-xs text-red-800">{loadError}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            Retry
          </button>
        </div>
      ) : rows === null ? (
        <SkeletonCard rows={6} />
      ) : (
        <div className="space-y-6">
          {grouped.map(([kind, items]) => (
            <section key={kind}>
              <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                {KIND_LABEL[kind]}
              </h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((i) => (
                  <div
                    key={i.slug}
                    className="rounded-xl border border-slate-200 bg-white p-5 shadow-card"
                  >
                    <div className="flex items-baseline justify-between">
                      <p className="text-base font-semibold text-slate-900">
                        {i.label}
                      </p>
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_BADGE[i.status]}`}
                      >
                        {STATUS_LABEL[i.status]}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-slate-500">
                      {i.slug}
                    </p>
                    {i.notes && (
                      <p className="mt-3 text-xs leading-relaxed text-slate-600">
                        {i.notes}
                      </p>
                    )}
                    {Object.keys(i.config).length > 0 && (
                      <pre className="mt-3 overflow-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700">
                        {JSON.stringify(i.config, null, 2)}
                      </pre>
                    )}
                    <div className="mt-4 flex items-baseline justify-between gap-3 text-xs">
                      <span className="text-slate-400">
                        {i.last_checked_at
                          ? `Last checked ${new Date(i.last_checked_at).toISOString().slice(0, 16).replace("T", " ")}`
                          : "Never checked"}
                      </span>
                      {isSuperAdmin && (
                        <button
                          type="button"
                          onClick={() => setEdit(i)}
                          className="text-slate-600 underline-offset-2 hover:underline"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {edit && (
        <EditModal
          row={edit}
          onClose={() => setEdit(null)}
          onSuccess={() => {
            void refresh();
            setEdit(null);
          }}
        />
      )}

      <p className="text-xs text-slate-400">
        &quot;Test connection&quot; buttons appear once a vendor SDK ships in
        the front-end. Until then, status is operator-asserted; check{" "}
        <a href="/admin/health" className="underline">
          /admin/health
        </a>{" "}
        for live probes that don&apos;t need an SDK.
      </p>
    </div>
  );
}

function EditModal({
  row,
  onClose,
  onSuccess,
}: {
  row: Integration;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const [status, setStatus] = useState<Status>(row.status);
  const [notes, setNotes] = useState(row.notes);
  const [configText, setConfigText] = useState(JSON.stringify(row.config, null, 2));
  const [submitting, setSubmitting] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  async function submit() {
    let parsed: Record<string, unknown>;
    try {
      parsed = configText.trim() ? JSON.parse(configText) : {};
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setParseError("Config must be a JSON object");
      return;
    }
    setSubmitting(true);
    try {
      // last_checked_at is stamped server-side.
      await signedFetch(
        conn.wallet,
        "/api/admin-config/integrations-update",
        "adminConfig.integrationsUpdate",
        { slug: row.slug, status, notes, config: parsed },
      );
      toast.show({ kind: "success", title: "Saved" });
      onSuccess();
    } catch (err) {
      toast.showError(
        "Save failed",
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
            {row.label}
          </p>
          <p className="mt-1 font-mono text-[11px] text-slate-500">{row.slug}</p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Status
            </span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Status)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              {Object.entries(STATUS_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Notes
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Config (JSON — non-secret bits only)
            </span>
            <textarea
              value={configText}
              onChange={(e) => {
                setConfigText(e.target.value);
                setParseError(null);
              }}
              rows={8}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
            />
            {parseError && (
              <p className="mt-1 text-[11px] text-red-700">JSON parse: {parseError}</p>
            )}
            <p className="mt-1 text-[11px] text-slate-400">
              Secrets must NOT go here. Keep API keys in Vercel env / Supabase
              Vault and reference them by name in config (e.g.{" "}
              <code>{`{ "api_key_env": "RESEND_API_KEY" }`}</code>).
            </p>
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
            disabled={submitting}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
