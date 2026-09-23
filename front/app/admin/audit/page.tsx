"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { listAuditEvents } from "@/lib/audit-read";
import { RequireRole } from "@/components/require-role";
import { SkeletonTable } from "@/components/skeleton";
import {
  getSupabase,
  type AuditCategory,
  type AuditStatus,
} from "@/lib/supabase";
import { detectNetwork, explorerTxUrl } from "@/lib/network";

// Unified row shape — admin actions and indexer-decoded on-chain events merge
// into one table with a `source` column for filtering.
type Source = "audit" | "indexer";

type FeedRow = {
  id: string;
  source: Source;
  created_at: string;
  ix_name: string;
  category: AuditCategory;
  actor_wallet: string | null;
  target_label: string | null;
  tx_signature: string | null;
  reason: string | null;
  status: AuditStatus;
  decoded: boolean;
  actor_verified: boolean;
};

const CATEGORY_LABELS: Record<AuditCategory | "all", string> = {
  all: "All",
  platform: "Platform",
  admins: "Admins",
  issuers: "Issuers",
  assets: "Assets",
  "share-class": "Share class",
  launchpad: "Launchpad",
  custody: "Custody",
  otc: "OTC",
  governance: "Governance",
  rights: "Rights",
  kyc: "KYC & privacy",
  other: "Other",
};

const STATUS_BADGE: Record<AuditStatus, string> = {
  success: "bg-emerald-100 text-emerald-800 border-emerald-200",
  failed: "bg-red-100 text-red-800 border-red-200",
  pending: "bg-amber-100 text-amber-800 border-amber-200",
};

const SOURCE_BADGE: Record<Source, string> = {
  audit: "bg-brand-50 text-brand-700 border-brand-200",
  indexer: "bg-slate-100 text-slate-700 border-slate-300",
};

const PAGE_SIZE = 50;

// Map a Helius enhanced ix name (or program log we parse from description) to
// a category for filtering. Best-effort — defaults to "other".
function categorizeIxName(name: string | null): AuditCategory {
  if (!name) return "other";
  const n = name.toLowerCase();
  if (
    n.includes("platform") ||
    n.includes("pause") ||
    // not "treasury" alone: that would also catch mint_to_treasury
    n.includes("protocol_treasury")
  )
    return "platform";
  if (n.includes("admin")) return "admins";
  if (n.includes("issuer") || n.includes("kyb")) return "issuers";
  if (n.includes("asset")) return "assets";
  if (n.includes("share_class") || n.includes("mint") || n.includes("lock_supply")) {
    return "share-class";
  }
  if (n.includes("sale") || n.includes("buy")) return "launchpad";
  if (n.includes("custody") || n.includes("vault")) return "custody";
  if (n.includes("offer")) return "otc";
  if (n.includes("proposal") || n.includes("vote")) return "governance";
  if (n.includes("rights") || n.includes("milestone") || n.includes("claim")) {
    return "rights";
  }
  return "other";
}

export default function AuditPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Audit log
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Privileged actions & on-chain events
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          One unified feed: app reports (with their declared reason and outcome)
          and every on-chain transaction the Helius webhook delivered.
        </p>
      </div>
      <RequireRole role="admin">
        <AuditOps />
      </RequireRole>
    </section>
  );
}

function AuditOps() {
  const conn = useWalletConnection();
  const [rows, setRows] = useState<FeedRow[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<AuditCategory | "all">("all");
  const [statusFilter, setStatusFilter] = useState<AuditStatus | "all">("all");
  const [sourceFilter, setSourceFilter] = useState<Source | "all">("all");
  const [page, setPage] = useState(0);

  const refresh = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) {
      setFailed("Supabase env vars are not configured.");
      return;
    }
    try {
      const network = detectNetwork();
      const start = page * PAGE_SIZE;
      const end = start + PAGE_SIZE - 1;

      const [auditR, indexerR] = await Promise.all([
        listAuditEvents(conn.wallet, page),
        sb
          .from("indexer_events")
          .select("id, created_at, signature, ix_name, decoded")
          .eq("network", network)
          .order("created_at", { ascending: false })
          .range(start, end),
      ]);

      if (indexerR.error) throw indexerR.error;

      const auditRows: FeedRow[] = auditR.map((r) => ({
        id: `audit-${r.id}`,
        source: "audit" as const,
        created_at: r.created_at,
        ix_name: r.ix_name,
        category: r.category as AuditCategory,
        actor_wallet: r.actor_wallet,
        target_label: r.target_label,
        tx_signature: r.tx_signature,
        reason: r.reason,
        status: r.status as AuditStatus,
        decoded: false,
        actor_verified: r.metadata?.actor_verified === true,
      }));

      const indexerRows: FeedRow[] = (indexerR.data ?? []).map((r) => ({
        id: `indexer-${r.id}`,
        source: "indexer" as const,
        created_at: r.created_at,
        ix_name: r.ix_name ?? "(unknown)",
        category: categorizeIxName(r.ix_name),
        actor_wallet: null,
        target_label: null,
        tx_signature: r.signature,
        reason: null,
        status: "success" as AuditStatus,
        decoded: !!r.decoded,
        actor_verified: false,
      }));

      const merged = [...auditRows, ...indexerRows].sort(
        (a, b) => b.created_at.localeCompare(a.created_at),
      );
      setRows(merged);
      setFailed(null);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    }
  }, [page, conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (sourceFilter !== "all" && r.source !== sourceFilter) return false;
      if (category !== "all" && r.category !== category) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!q) return true;
      return (
        r.ix_name.toLowerCase().includes(q) ||
        (r.actor_wallet ?? "").toLowerCase().includes(q) ||
        (r.target_label ?? "").toLowerCase().includes(q) ||
        (r.reason ?? "").toLowerCase().includes(q) ||
        (r.tx_signature ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, category, statusFilter, sourceFilter]);

  if (failed) {
    return (
      <div className="mt-8 rounded-xl border border-red-200 bg-red-50 p-6">
        <p className="text-sm font-semibold text-red-900">
          Audit log unavailable
        </p>
        <p className="mt-1 text-xs text-red-800">{failed}</p>
        <p className="mt-3 text-xs text-red-800/80">
          Check NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY in
          .env.local, and that both <code>audit_events</code> and{" "}
          <code>indexer_events</code> tables exist (migrations 0001 + 0002).
        </p>
      </div>
    );
  }

  const auditCount = rows?.filter((r) => r.source === "audit").length ?? 0;
  const indexerCount = rows?.filter((r) => r.source === "indexer").length ?? 0;

  return (
    <div className="mt-8 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search ix, wallet, target, reason, signature…"
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as AuditCategory | "all")}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
        >
          {Object.entries(CATEGORY_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(["all", "audit", "indexer"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSourceFilter(s)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                sourceFilter === s
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {s === "all"
                ? "Both"
                : s === "audit"
                  ? `Admin (${auditCount})`
                  : `On-chain (${indexerCount})`}
            </button>
          ))}
        </div>
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(["all", "success", "failed", "pending"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                statusFilter === s
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {s === "all" ? "Any" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:border-slate-400"
        >
          ↻ Refresh
        </button>
      </div>

      {rows === null ? (
        <SkeletonTable rows={8} cols={7} />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {(rows.length === 0)
              ? "No events recorded on this network yet — privileged admin actions and on-chain transactions will appear here."
              : "No events match the current filter."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Actor</th>
                <th className="px-4 py-3 font-medium">Target / Reason</th>
                <th className="px-4 py-3 font-medium">Tx</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((r) => (
                <tr key={r.id} className="text-slate-700 align-top">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">
                    {new Date(r.created_at)
                      .toISOString()
                      .slice(0, 16)
                      .replace("T", " ")}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${SOURCE_BADGE[r.source]}`}
                    >
                      {r.source === "audit" ? "App report" : "On-chain"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-mono text-xs font-semibold text-slate-900">
                      {r.ix_name}
                    </p>
                    <p className="mt-0.5 text-[11px] uppercase tracking-wide text-slate-400">
                      {CATEGORY_LABELS[r.category as AuditCategory] ?? r.category}
                    </p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {r.actor_wallet ? (
                      <span title={r.actor_wallet}>
                        {r.actor_wallet.slice(0, 6)}…{r.actor_wallet.slice(-4)}
                        {r.source === "audit" && !r.actor_verified && <span className="mt-1 block font-sans text-[10px] text-amber-700">Unverified actor</span>}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td
                    className="max-w-[280px] px-4 py-3 text-xs"
                    title={r.target_label ?? r.reason ?? ""}
                  >
                    {r.target_label && (
                      <p className="truncate text-slate-700">
                        {r.target_label}
                      </p>
                    )}
                    {r.reason && (
                      <p className="line-clamp-2 text-slate-500">{r.reason}</p>
                    )}
                    {!r.target_label && !r.reason && (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {r.tx_signature ? (
                      <a
                        href={explorerTxUrl(r.tx_signature, detectNetwork())}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-slate-600 underline-offset-2 hover:underline"
                        title={r.tx_signature}
                      >
                        {r.tx_signature.slice(0, 6)}…
                        {r.tx_signature.slice(-4)} ↗
                      </a>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[r.status]}`}
                    >
                      {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows !== null && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            Page {page + 1} · showing {filtered.length} of {rows.length} loaded
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 hover:border-slate-400 disabled:opacity-40"
            >
              ← Prev
            </button>
            <button
              type="button"
              disabled={rows.length < PAGE_SIZE * 2}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 hover:border-slate-400 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
