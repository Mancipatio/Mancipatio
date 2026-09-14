"use client";

import { useCallback, useEffect, useState } from "react";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybePlatform,
  findPlatformPda,
} from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM } from "@/lib/pdas";
import { getSupabase } from "@/lib/supabase";
import { detectNetwork, rpcUrl as networkRpcUrl } from "@/lib/network";
import { runReconcile, runIndexerRetry, type ReconcileReport } from "@/lib/indexer";
import { RequireRole } from "@/components/require-role";
import { SkeletonCard } from "@/components/skeleton";
import { useToast } from "@/lib/toast";

type Probe = {
  ok: boolean;
  warn?: boolean;            // ok=true + warn=true → amber "watch" badge, not red.
  label: string;
  detail?: string;
  value?: string;
  latencyMs?: number;
};

const POLL_MS = 15_000;

export default function HealthPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Health
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          System status
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Live diagnostics — RPC, indexer pipeline, database, and on-chain
          programs. Polls every 15 seconds.
        </p>
      </div>
      <RequireRole role="admin">
        <HealthOps />
      </RequireRole>
    </section>
  );
}

function HealthOps() {
  const client = useSolanaClient();
  const [rpc, setRpc] = useState<Probe | null>(null);
  const [program, setProgram] = useState<Probe | null>(null);
  const [hook, setHook] = useState<Probe | null>(null);
  const [platform, setPlatform] = useState<Probe | null>(null);
  const [db, setDb] = useState<Probe | null>(null);
  const [indexerLag, setIndexerLag] = useState<Probe | null>(null);
  const [webhookCount24h, setWebhookCount24h] = useState<Probe | null>(null);
  const [decodedRatio, setDecodedRatio] = useState<Probe | null>(null);
  const [lastCheck, setLastCheck] = useState<Date | null>(null);

  const probe = useCallback(async () => {
    const rpcUrl = networkRpcUrl();

    // ---------------- RPC slot latency ----------------
    {
      const start = performance.now();
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getSlot",
            params: [{ commitment: "confirmed" }],
          }),
        });
        const body = await res.json();
        const ms = Math.round(performance.now() - start);
        if (body?.result != null) {
          setRpc({
            ok: true,
            label: "RPC",
            value: `slot ${body.result}`,
            detail: rpcUrl.replace(/^https?:\/\//, "").split("/")[0],
            latencyMs: ms,
          });
        } else {
          setRpc({
            ok: false,
            label: "RPC",
            value: body?.error?.message ?? "no result",
            latencyMs: ms,
          });
        }
      } catch (err) {
        setRpc({
          ok: false,
          label: "RPC",
          value: err instanceof Error ? err.message : "unreachable",
        });
      }
    }

    // ---------------- asset_registry program ----------------
    try {
      const info = await client.runtime.rpc
        .getAccountInfo(ASSET_REGISTRY_PROGRAM_ADDRESS, {
          encoding: "base64",
        })
        .send();
      setProgram({
        ok: !!info?.value,
        label: "asset_registry program",
        value: info?.value ? "deployed" : "not found",
        detail: ASSET_REGISTRY_PROGRAM_ADDRESS.slice(0, 6) + "…" + ASSET_REGISTRY_PROGRAM_ADDRESS.slice(-4),
      });
    } catch {
      setProgram({ ok: false, label: "asset_registry program", value: "rpc error" });
    }

    // ---------------- transfer_hook program ----------------
    try {
      const info = await client.runtime.rpc
        .getAccountInfo(TRANSFER_HOOK_PROGRAM, { encoding: "base64" })
        .send();
      setHook({
        ok: !!info?.value,
        label: "transfer_hook program",
        value: info?.value ? "deployed" : "not found",
        detail: TRANSFER_HOOK_PROGRAM.slice(0, 6) + "…" + TRANSFER_HOOK_PROGRAM.slice(-4),
      });
    } catch {
      setHook({ ok: false, label: "transfer_hook program", value: "rpc error" });
    }

    // ---------------- Platform PDA ----------------
    try {
      const [pda] = await findPlatformPda();
      const m = await fetchMaybePlatform(client.runtime.rpc, pda);
      setPlatform({
        ok: m.exists,
        label: "Platform PDA",
        value: m.exists
          ? m.data.paused
            ? "initialized · paused"
            : "initialized · active"
          : "not initialized",
        detail: pda.toString().slice(0, 6) + "…" + pda.toString().slice(-4),
      });
    } catch {
      setPlatform({ ok: false, label: "Platform PDA", value: "rpc error" });
    }

    // ---------------- Supabase reachability ----------------
    const sb = getSupabase();
    if (!sb) {
      setDb({
        ok: false,
        label: "Supabase",
        value: "env not configured",
      });
    } else {
      const start = performance.now();
      try {
        const { error } = await sb
          .from("indexer_events")
          .select("id", { head: true, count: "exact" })
          .limit(1);
        const ms = Math.round(performance.now() - start);
        setDb({
          ok: !error,
          label: "Supabase",
          value: error ? error.message : "reachable",
          latencyMs: ms,
        });
      } catch (err) {
        setDb({
          ok: false,
          label: "Supabase",
          value: err instanceof Error ? err.message : "unreachable",
        });
      }
    }

    // ---------------- Indexer lag ----------------
    if (sb) {
      try {
        const { data } = await sb
          .from("indexer_events")
          .select("created_at, block_time")
          .eq("network", detectNetwork())
          .order("created_at", { ascending: false })
          .limit(1);
        if (data && data.length > 0) {
          const lastTs = data[0].created_at as string;
          const ageS = Math.max(
            0,
            Math.round((Date.now() - new Date(lastTs).getTime()) / 1000),
          );
          // <1h: healthy. 1h–24h: watch (devnet often goes quiet between
          // tests so this isn't really "degraded"). >24h: fail.
          const fresh = ageS < 60 * 60;
          const stale = ageS >= 24 * 60 * 60;
          setIndexerLag({
            ok: !stale,
            warn: !fresh && !stale,
            label: "Indexer last write",
            value:
              ageS < 60
                ? `${ageS}s ago`
                : ageS < 3600
                  ? `${Math.round(ageS / 60)}m ago`
                  : `${Math.round(ageS / 3600)}h ago`,
            detail:
              new Date(lastTs).toISOString().slice(11, 19) +
              " UTC" +
              (stale
                ? " — no events in 24h+"
                : !fresh
                  ? " — quiet network, not a failure"
                  : ""),
          });
        } else {
          setIndexerLag({
            ok: false,
            label: "Indexer last write",
            value: "no events yet",
            detail: "Helius webhook hasn't delivered to this network",
          });
        }
      } catch {
        setIndexerLag({
          ok: false,
          label: "Indexer last write",
          value: "query failed",
        });
      }
    }

    // ---------------- Webhook activity (24h) ----------------
    if (sb) {
      try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count } = await sb
          .from("indexer_events")
          .select("id", { count: "exact", head: true })
          .eq("network", detectNetwork())
          .gte("created_at", since);
        setWebhookCount24h({
          ok: true,
          label: "Webhook events (24h)",
          value: String(count ?? 0),
        });
      } catch {
        setWebhookCount24h({
          ok: false,
          label: "Webhook events (24h)",
          value: "query failed",
        });
      }
    }

    // ---------------- Decoded ratio ----------------
    if (sb) {
      try {
        const network = detectNetwork();
        const [{ count: total }, { count: decoded }] = await Promise.all([
          sb
            .from("indexer_events")
            .select("id", { count: "exact", head: true })
            .eq("network", network),
          sb
            .from("indexer_events")
            .select("id", { count: "exact", head: true })
            .eq("network", network)
            .eq("decoded", true),
        ]);
        const t = total ?? 0;
        const d = decoded ?? 0;
        const pct = t === 0 ? 0 : Math.round((d / t) * 100);
        setDecodedRatio({
          ok: t === 0 || pct >= 50,
          label: "Decoded ratio (all-time)",
          value: t === 0 ? "n/a" : `${pct}% (${d} / ${t})`,
          detail:
            t > 0 && pct < 100
              ? "Some events not decoded — possibly newer ix types"
              : undefined,
        });
      } catch {
        setDecodedRatio({
          ok: false,
          label: "Decoded ratio (all-time)",
          value: "query failed",
        });
      }
    }

    setLastCheck(new Date());
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void probe();
    const t = setInterval(() => {
      void probe();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [probe]);

  const probes = [rpc, program, hook, platform, db, indexerLag, webhookCount24h, decodedRatio];
  const anyFailed = probes.some((p) => p && !p.ok);
  const anyWarn = probes.some((p) => p && p.ok && p.warn);
  const allCleanOk = probes.every((p) => p?.ok && !p.warn);

  const tone = anyFailed ? "fail" : anyWarn ? "warn" : allCleanOk ? "ok" : "pending";
  const banner: Record<typeof tone, { bg: string; text: string; sub: string; label: string }> = {
    ok: {
      bg: "border-emerald-200 bg-emerald-50",
      text: "text-emerald-900",
      sub: "text-emerald-800/80",
      label: "✓ All systems operational",
    },
    warn: {
      bg: "border-amber-200 bg-amber-50",
      text: "text-amber-900",
      sub: "text-amber-800/80",
      label: "● Notice — one or more probes on watch (not failing)",
    },
    fail: {
      bg: "border-red-200 bg-red-50",
      text: "text-red-900",
      sub: "text-red-800/80",
      label: "✗ Degraded — at least one probe is failing",
    },
    pending: {
      bg: "border-slate-200 bg-slate-50",
      text: "text-slate-700",
      sub: "text-slate-500",
      label: "… probing",
    },
  };
  const t = banner[tone];

  return (
    <div className="mt-8 space-y-6">
      <header className={`rounded-xl border px-6 py-4 ${t.bg}`}>
        <div className="flex items-baseline justify-between">
          <p className={`text-base font-semibold ${t.text}`}>{t.label}</p>
          <p className={`text-xs ${t.sub}`}>
            {lastCheck
              ? `Last check: ${lastCheck.toISOString().slice(11, 19)} UTC`
              : "first check pending…"}
          </p>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {probes.map((p, i) =>
          p === null ? <SkeletonCard key={i} rows={2} /> : (
            <ProbeCard key={i} probe={p} />
          ),
        )}
      </section>

      <ReconcileCard />

      {/* Future integrations — explicit placeholders */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Integrations (planned)
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            { name: "Sentry", note: "Live error stream — needs DSN." },
            { name: "Resend", note: "Email delivery rate." },
            { name: "Sumsub", note: "KYC provider response time." },
          ].map((x) => (
            <div
              key={x.name}
              className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-3"
            >
              <p className="text-sm font-semibold text-slate-700">{x.name}</p>
              <p className="mt-1 text-[11px] text-slate-500">{x.note}</p>
              <p className="mt-2 text-[10px] uppercase tracking-wider text-amber-700">
                Not wired
              </p>
            </div>
          ))}
        </div>
      </section>

      <p className="text-xs text-slate-400">
        Polling every 15 seconds. RPC latency is measured for the public
        endpoint configured in <code>NEXT_PUBLIC_SOLANA_RPC_URL</code> from
        this browser, so it reflects your network path — not platform-wide
        latency.
      </p>
    </div>
  );
}

function ReconcileCard() {
  const conn = useWalletConnection();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ReconcileReport | null>(null);

  async function run() {
    setBusy(true);
    try {
      const { report: r } = await runReconcile(conn.wallet);
      setReport(r);
      const drift = Object.values(r).reduce(
        (n, t) => n + t.deleted + t.missing,
        0,
      );
      const rebuilt = Object.values(r).reduce((n, t) => n + (t.rebuilt ?? 0), 0);
      toast.show({
        kind: drift > 0 ? "info" : "success",
        title: "Reconcile complete",
        description:
          drift > 0
            ? `${drift} drifted rows (pruned/missing)${rebuilt > 0 ? `, ${rebuilt} row(s) rebuilt from chain` : ""} — see the table.`
            : "Indexer matches chain.",
      });
    } catch (err) {
      toast.showError(
        "Reconcile failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    try {
      const result = await runIndexerRetry(conn.wallet);
      toast.show({ kind: result.pending ? "info" : "success", title: "Indexer retry complete", description: `${result.complete} jobs completed; ${result.pending} need another attempt.` });
    } catch (err) { toast.showError("Indexer retry failed", err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Indexer reconcile
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            Rebuild all 14 mirror types from a complete finalized snapshot and
            prune closed accounts. Retry processes up to 10 queued webhook jobs;
            unresolved jobs stay durable for the next attempt.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || !conn.wallet}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? "Working…" : "Run reconcile"}
        </button>
        <button type="button" onClick={() => void retry()} disabled={busy || !conn.wallet}
          className="rounded-lg border border-emerald-200 px-4 py-2 text-sm font-medium text-emerald-800 disabled:opacity-50">
          Retry queued jobs
        </button>
      </div>
      {report && (
        <table className="mt-4 w-full text-sm">
          <thead className="border-b border-slate-100 text-left text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="py-2 font-medium">Table</th>
              <th className="py-2 text-right font-medium">On-chain</th>
              <th className="py-2 text-right font-medium">Refreshed</th>
              <th className="py-2 text-right font-medium">Pruned</th>
              <th className="py-2 text-right font-medium">Missing</th>
              <th className="py-2 text-right font-medium">Rebuilt</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {Object.entries(report).map(([table, r]) => (
              <tr key={table} className="text-slate-700">
                <td className="py-2 font-mono text-xs">{table}</td>
                <td className="py-2 text-right font-mono">{r.onchain}</td>
                <td className="py-2 text-right font-mono">{r.refreshed}</td>
                <td
                  className={`py-2 text-right font-mono ${r.deleted > 0 ? "text-amber-700" : ""}`}
                >
                  {r.deleted}
                </td>
                <td
                  className={`py-2 text-right font-mono ${r.missing > 0 ? "text-red-600" : ""}`}
                >
                  {r.missing}
                </td>
                <td
                  className={`py-2 text-right font-mono ${(r.rebuilt ?? 0) > 0 ? "text-emerald-700" : "text-slate-400"}`}
                >
                  {r.rebuilt ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ProbeCard({ probe }: { probe: Probe }) {
  // 3-state badge: ok (emerald), warn (amber), fail (red). Tailwind needs the
  // full class names to be visible at build time, hence the explicit literals.
  const badge = !probe.ok
    ? { cls: "text-red-700", txt: "✗", aria: "failing" }
    : probe.warn
      ? { cls: "text-amber-700", txt: "WATCH", aria: "on watch" }
      : { cls: "text-emerald-700", txt: "OK", aria: "ok" };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-card">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] uppercase tracking-wider text-slate-500">
          {probe.label}
        </p>
        <span
          className={`text-xs font-semibold ${badge.cls}`}
          aria-label={badge.aria}
        >
          {badge.txt}
        </span>
      </div>
      <p className="mt-2 text-sm font-medium text-slate-900">{probe.value}</p>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        {probe.detail && (
          <p className="break-all text-[11px] text-slate-500">{probe.detail}</p>
        )}
        {typeof probe.latencyMs === "number" && (
          <p
            className={`shrink-0 text-[11px] font-mono ${
              probe.latencyMs < 300
                ? "text-emerald-700"
                : probe.latencyMs < 800
                  ? "text-amber-700"
                  : "text-red-700"
            }`}
          >
            {probe.latencyMs} ms
          </p>
        )}
      </div>
    </div>
  );
}
