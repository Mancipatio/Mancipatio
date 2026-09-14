"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { RequireRole } from "@/components/require-role";
import { SkeletonCard } from "@/components/skeleton";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { listClients, type ClientRow } from "@/lib/clients";
import { SaleStatus, type Asset } from "@/lib/generated/asset_registry";
import { findAssetPda } from "@/lib/generated/asset_registry";

function isoMonthStart(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function downloadCsv(filename: string, rows: (string | number | bigint)[][]) {
  const lines = rows.map((r) =>
    r
      .map((v) => {
        const s = String(v);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(","),
  );
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Reports
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Platform reports
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Pre-built operational reports — pick a date range and export to CSV.
        </p>
      </div>
      <RequireRole role="admin">
        <ReportsOps />
      </RequireRole>
    </section>
  );
}

function ReportsOps() {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const [from, setFrom] = useState(isoMonthStart());
  const [to, setTo] = useState(isoToday());
  const [data, setData] = useState<NetworkData | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [assetPdaMap, setAssetPdaMap] = useState<Map<string, Asset>>(new Map());
  const [now, setNow] = useState<number>(() => Date.now());

  const refresh = useCallback(async () => {
    if (!conn.wallet) return;
    const [network, cs] = await Promise.all([
      loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)),
      listClients(conn.wallet),
    ]);
    setData(network);
    setClients(cs);
    setNow(Date.now());

    const m = new Map<string, Asset>();
    for (const a of network.assets) {
      const [pda] = await findAssetPda({
        issuer: a.issuer,
        assetId: a.assetId,
      });
      m.set(pda.toString(), a);
    }
    setAssetPdaMap(m);
  }, [client, conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const fromMs = useMemo(
    () => new Date(`${from}T00:00:00Z`).getTime(),
    [from],
  );
  const toMs = useMemo(
    () => new Date(`${to}T23:59:59Z`).getTime(),
    [to],
  );

  // KYC throughput — clients whose verification landed in the window.
  const kycReport = useMemo(() => {
    const verified = clients.filter((c) => {
      if (!c.kyc_verified_at) return false;
      const t = new Date(c.kyc_verified_at).getTime();
      return t >= fromMs && t <= toMs;
    });
    const rejected = clients.filter((c) => c.kyc_status === "rejected");
    return {
      verifiedInWindow: verified.length,
      rejectedTotal: rejected.length,
      pending: clients.filter((c) => c.kyc_status === "pending").length,
      averageDays: verified.length === 0
        ? 0
        : Math.round(
            verified.reduce((acc, c) => {
              const created = new Date(c.created_at).getTime();
              const verifiedAt = new Date(c.kyc_verified_at!).getTime();
              return acc + (verifiedAt - created);
            }, 0) /
              verified.length /
              (24 * 60 * 60 * 1000),
          ),
    };
  }, [clients, fromMs, toMs]);

  // Issuer activity
  const issuerReport = useMemo(() => {
    if (!data) return null;
    const newIssuers = clients.filter((c) => {
      if (c.type !== "issuer") return false;
      const t = new Date(c.created_at).getTime();
      return t >= fromMs && t <= toMs;
    }).length;
    return {
      totalIssuers: data.issuers.length,
      verifiedIssuers: data.issuers.filter((i) => i.kybStatus === 1).length,
      newIssuersInWindow: newIssuers,
      totalAssets: data.assets.length,
    };
  }, [data, clients, fromMs, toMs]);

  // On-chain volume — sum of all open + closed sale proceeds (sold × price).
  const volumeReport = useMemo(() => {
    if (!data) return null;
    let primarySaleVolume = BigInt(0);
    let primarySaleUnits = BigInt(0);
    for (const s of data.sales) {
      primarySaleUnits += s.sold;
      primarySaleVolume += s.sold * s.pricePerUnit;
    }
    let otcVolume = BigInt(0);
    let otcCount = 0;
    for (const o of data.offers) {
      if (o.status === 1) { // Filled
        otcCount += 1;
        otcVolume += o.price;
      }
    }
    return {
      primarySaleVolume,
      primarySaleUnits,
      activeSales: data.sales.filter((s) => s.status === SaleStatus.Open).length,
      otcVolume,
      otcFilledCount: otcCount,
      openOffers: data.offers.filter((o) => o.status === 0).length,
    };
  }, [data]);

  // Top assets — by share class count + holders proxy (circulating supply).
  const topAssets = useMemo(() => {
    if (!data) return [];
    return [...data.assets]
      .map((a) => {
        const classes = data.shareClasses.filter(
          (sc) => sc.asset.toString() === a.issuer.toString() ? false : true,
        );
        void classes;
        // Compute by matching asset PDA via assetPdaMap.
        const myClasses = Array.from(assetPdaMap.entries())
          .filter(([, asset]) => asset.assetId === a.assetId)
          .flatMap(([pda]) =>
            data.shareClasses.filter((sc) => sc.asset.toString() === pda),
          );
        const totalCirculating = myClasses.reduce(
          (acc, sc) => acc + sc.circulatingSupply,
          BigInt(0),
        );
        return {
          name: a.name,
          assetId: a.assetId,
          classCount: a.shareClassesCount,
          totalCirculating,
        };
      })
      .sort((a, b) => Number(b.totalCirculating - a.totalCirculating))
      .slice(0, 5);
  }, [data, assetPdaMap]);

  const loading = data === null;

  return (
    <div className="mt-6 space-y-5">
      {/* Date range */}
      <section className="panel panel-pad">
        <p className="page-eyebrow">Reporting period</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              From
            </span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              To
            </span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <div className="ml-auto flex gap-2 text-xs">
            <button
              type="button"
              onClick={() => {
                setFrom(isoMonthStart());
                setTo(isoToday());
              }}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:border-slate-400"
            >
              This month
            </button>
            <button
              type="button"
              onClick={() => {
                const d = new Date();
                d.setDate(d.getDate() - 30);
                setFrom(d.toISOString().slice(0, 10));
                setTo(isoToday());
              }}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:border-slate-400"
            >
              Last 30 days
            </button>
            <button
              type="button"
              onClick={() => {
                const d = new Date();
                setFrom(new Date(Date.UTC(d.getUTCFullYear(), 0, 1)).toISOString().slice(0, 10));
                setTo(isoToday());
              }}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:border-slate-400"
            >
              YTD
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:border-slate-400"
              title="Refresh data"
            >
              ↻
            </button>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Last refreshed:{" "}
          {new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC
        </p>
      </section>

      {/* Reports grid */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* KYC throughput */}
        <ReportCard
          title="KYC throughput"
          loading={loading}
          rows={
            kycReport
              ? [
                  ["Verified in window", String(kycReport.verifiedInWindow)],
                  ["Pending now", String(kycReport.pending)],
                  ["Rejected (all-time)", String(kycReport.rejectedTotal)],
                  [
                    "Avg time to verify",
                    kycReport.averageDays === 0
                      ? "—"
                      : `${kycReport.averageDays} days`,
                  ],
                ]
              : []
          }
          onExport={() =>
            downloadCsv(`mancipatio-kyc-${from}-to-${to}.csv`, [
              ["metric", "value"],
              ["verified_in_window", kycReport.verifiedInWindow],
              ["pending", kycReport.pending],
              ["rejected_all_time", kycReport.rejectedTotal],
              ["avg_days_to_verify", kycReport.averageDays],
            ])
          }
        />

        {/* Issuer activity */}
        <ReportCard
          title="Issuer activity"
          loading={loading}
          rows={
            issuerReport
              ? [
                  ["Total issuers", String(issuerReport.totalIssuers)],
                  ["Verified KYB", String(issuerReport.verifiedIssuers)],
                  [
                    "New issuers in window",
                    String(issuerReport.newIssuersInWindow),
                  ],
                  ["Total assets registered", String(issuerReport.totalAssets)],
                ]
              : []
          }
          onExport={() =>
            issuerReport &&
            downloadCsv(`mancipatio-issuers-${from}-to-${to}.csv`, [
              ["metric", "value"],
              ["total_issuers", issuerReport.totalIssuers],
              ["verified_kyb", issuerReport.verifiedIssuers],
              ["new_issuers_in_window", issuerReport.newIssuersInWindow],
              ["total_assets", issuerReport.totalAssets],
            ])
          }
        />

        {/* On-chain volume */}
        <ReportCard
          title="On-chain volume (lifetime)"
          loading={loading}
          rows={
            volumeReport
              ? [
                  [
                    "Primary sale gross (price × sold)",
                    String(volumeReport.primarySaleVolume),
                  ],
                  [
                    "Primary sale units sold",
                    String(volumeReport.primarySaleUnits),
                  ],
                  ["Active sales", String(volumeReport.activeSales)],
                  [
                    "OTC filled volume",
                    String(volumeReport.otcVolume),
                  ],
                  ["OTC trades filled", String(volumeReport.otcFilledCount)],
                  ["Open OTC offers", String(volumeReport.openOffers)],
                ]
              : []
          }
          onExport={() =>
            volumeReport &&
            downloadCsv(`mancipatio-volume-lifetime.csv`, [
              ["metric", "value"],
              ["primary_sale_gross", volumeReport.primarySaleVolume],
              ["primary_sale_units", volumeReport.primarySaleUnits],
              ["active_sales", volumeReport.activeSales],
              ["otc_volume", volumeReport.otcVolume],
              ["otc_filled", volumeReport.otcFilledCount],
              ["open_offers", volumeReport.openOffers],
            ])
          }
          footer={
            <p className="text-[11px] text-slate-400">
              Volume calculated client-side from indexer NetworkData. Date-range
              filtering for on-chain volume needs per-event timestamps —
              coming with indexer enhancement.
            </p>
          }
        />

        {/* Top assets */}
        <ReportCard
          title="Top assets by circulating supply"
          loading={loading}
          rows={topAssets.map((a) => [
            `${a.name} (${a.assetId})`,
            String(a.totalCirculating),
          ])}
          onExport={() =>
            downloadCsv(`mancipatio-top-assets.csv`, [
              ["name", "asset_id", "share_classes", "total_circulating"],
              ...topAssets.map((a) => [
                a.name,
                a.assetId,
                a.classCount,
                a.totalCirculating,
              ]),
            ])
          }
          empty={topAssets.length === 0 ? "No assets registered yet." : null}
        />
      </div>

      {/* Fee revenue — not yet available */}
      <section className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Fee revenue — not yet available
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Fee revenue cannot be reported yet: on-chain fee enforcement is not
          enabled — the program stores the protocol fee on the Platform
          account but no instruction collects it, so there are no fee
          transfers to sum. Once enforcement ships and the indexer decodes
          the resulting fee transfers, this report will sum per-period revenue
          per recipient + per fee_type, using the schedule in{" "}
          <a href="/admin/fees" className="underline">
            /admin/fees
          </a>
          .
        </p>
      </section>

      <p className="text-xs text-slate-400">
        Scheduled / emailed reports arrive when Resend is wired up. Until then,
        export buttons above let you grab the rows manually.
      </p>
    </div>
  );
}

function ReportCard({
  title,
  loading,
  rows,
  onExport,
  empty,
  footer,
}: {
  title: string;
  loading: boolean;
  rows: [string, string][];
  onExport?: () => void;
  empty?: string | null;
  footer?: React.ReactNode;
}) {
  return (
    <section className="panel relative overflow-hidden p-5">
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-0.5"
        style={{
          background:
            "linear-gradient(180deg, var(--brand-400) 0%, var(--brand-600) 100%)",
          opacity: 0.7,
        }}
      />
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-slate-900 tracking-tight">
          {title}
        </h2>
        {onExport && !loading && (
          <button
            type="button"
            onClick={onExport}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50"
          >
            Export CSV
          </button>
        )}
      </div>
      {loading ? (
        <div className="mt-4">
          <SkeletonCard rows={4} />
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-[13px] text-slate-500">{empty ?? "—"}</p>
      ) : (
        <dl className="mt-4 space-y-1.5 text-[13px]">
          {rows.map(([k, v], i) => (
            <div
              key={i}
              className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1.5 last:border-0 last:pb-0"
            >
              <dt className="text-slate-600">{k}</dt>
              <dd className="font-mono font-medium text-slate-900 tabular-nums">
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {footer && !loading && <div className="mt-3">{footer}</div>}
    </section>
  );
}
