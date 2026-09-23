"use client";

import Link from "next/link";
import { useSolanaClient } from "@solana/react-hooks";
import { useEffect, useState } from "react";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { fetchMaybePlatform, findPlatformPda } from "@/lib/generated/asset_registry";
import { SaleStatus } from "@/lib/generated/asset_registry";
import { Skeleton } from "@/components/skeleton";
import { describePausedAreas, PAUSE_EXITS_OPEN } from "@/lib/pause-flags";

type AlertLevel = "critical" | "warning" | "info";

type Alert = {
  level: AlertLevel;
  title: string;
  description: string;
  href?: string;
};

const LEVEL_STYLES: Record<AlertLevel, string> = {
  critical: "border-red-200 bg-red-50 text-red-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  info: "border-brand-200 bg-brand-50 text-brand-900",
};

const LEVEL_DOT: Record<AlertLevel, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-brand-500",
};

const PENDING_KYB_GRACE_DAYS = 7;
const SALE_EXPIRY_WARN_HOURS = 24;

export function AlertsCard() {
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  /** `Platform.pause_flags`, or null when the Platform is not initialized. */
  const [platformPaused, setPlatformPaused] = useState<number | null>(null);
  const [platformInitialized, setPlatformInitialized] = useState<
    boolean | null
  >(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [pda] = await findPlatformPda();
        const [platform, network] = await Promise.all([
          fetchMaybePlatform(client.runtime.rpc, pda),
          loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)),
        ]);
        if (cancelled) return;
        setPlatformInitialized(platform.exists);
        setPlatformPaused(platform.exists ? platform.data.pauseFlags : null);
        setData(network);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (failed) {
    return (
      <div className="panel panel-pad">
        <p className="page-eyebrow">Alerts</p>
        <p className="mt-3 text-sm text-red-600">
          Failed to compute alerts from on-chain data.
        </p>
      </div>
    );
  }

  if (data === null || platformInitialized === null) {
    return (
      <div className="panel panel-pad">
        <p className="page-eyebrow">Alerts</p>
        <div className="mt-3 space-y-2">
          <Skeleton className="block h-3 w-3/4" />
          <Skeleton className="block h-3 w-2/3" />
          <Skeleton className="block h-3 w-1/2" />
        </div>
      </div>
    );
  }

  const alerts = computeAlerts({
    data,
    platformInitialized,
    platformPaused,
  });
  const worst: AlertLevel | null = alerts.length === 0
    ? null
    : alerts.some((a) => a.level === "critical")
      ? "critical"
      : alerts.some((a) => a.level === "warning")
        ? "warning"
        : "info";
  const stripe =
    worst === "critical"
      ? "linear-gradient(90deg, #ef4444 0%, #b91c1c 100%)"
      : worst === "warning"
        ? "linear-gradient(90deg, #fbbf24 0%, #d97706 100%)"
        : worst === "info"
          ? "linear-gradient(90deg, #9ac8a4 0%, #2e6545 100%)"
          : "linear-gradient(90deg, #34d399 0%, #059669 100%)";

  return (
    <div className="panel overflow-hidden">
      <div className="h-0.5" style={{ background: stripe }} />
      <div className="p-5">
        <div className="flex items-baseline justify-between">
          <p className="page-eyebrow">Alerts</p>
          <span className="text-xs text-slate-400">
            {alerts.length === 0 ? "all clear" : `${alerts.length} active`}
          </span>
        </div>

        {alerts.length === 0 ? (
          <p className="mt-3 text-[13px] text-slate-500">
            No issues detected on-chain.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {alerts.map((a, i) => (
              <li
                key={i}
                className={`rounded-lg border px-3 py-2.5 text-[13px] ${LEVEL_STYLES[a.level]}`}
              >
                <div className="flex items-start gap-2">
                  <span
                    className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL_DOT[a.level]}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{a.title}</p>
                    <p className="mt-0.5 text-xs opacity-80">{a.description}</p>
                  </div>
                  {a.href && (
                    <Link
                      href={a.href}
                      className="shrink-0 self-center text-xs underline-offset-2 hover:underline"
                    >
                      Open →
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function computeAlerts(args: {
  data: NetworkData;
  platformInitialized: boolean;
  platformPaused: number | null;
}): Alert[] {
  const { data, platformInitialized, platformPaused } = args;
  const alerts: Alert[] = [];
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const warnWindow = BigInt(60 * 60 * SALE_EXPIRY_WARN_HOURS);

  if (!platformInitialized) {
    alerts.push({
      level: "critical",
      title: "Platform not initialized",
      description: "No operations can succeed until initialize_platform is called.",
      href: "/admin/platform",
    });
    return alerts;
  }

  const pausedAreas = platformPaused ? describePausedAreas(platformPaused) : "";
  if (pausedAreas) {
    alerts.push({
      level: "critical",
      title: "Emergency pause is on",
      description: `Paused: ${pausedAreas}. ${PAUSE_EXITS_OPEN}`,
      href: "/admin/platform",
    });
  }

  const pendingIssuers = data.issuers.filter((i) => i.kybStatus === 0).length;
  if (pendingIssuers > 0) {
    alerts.push({
      level: pendingIssuers >= 3 ? "warning" : "info",
      title: `${pendingIssuers} issuer${pendingIssuers === 1 ? "" : "s"} pending KYB`,
      description: `Review and verify KYB${pendingIssuers >= 3 ? ` — backlog growing (>= 3 waiting more than ${PENDING_KYB_GRACE_DAYS} days)` : ""}.`,
      href: "/admin/issuers",
    });
  }

  const expiringSales = data.sales.filter(
    (s) =>
      s.status === SaleStatus.Open &&
      s.endTs > BigInt(0) &&
      s.endTs > nowSec &&
      s.endTs - nowSec < warnWindow,
  );
  if (expiringSales.length > 0) {
    alerts.push({
      level: "warning",
      title: `${expiringSales.length} sale${expiringSales.length === 1 ? "" : "s"} closing within ${SALE_EXPIRY_WARN_HOURS}h`,
      description: "Confirm settlement is in order and notifications were sent to buyers.",
      href: "/admin/launchpad",
    });
  }

  const expiredOpenSales = data.sales.filter(
    (s) =>
      s.status === SaleStatus.Open &&
      s.endTs > BigInt(0) &&
      s.endTs <= nowSec,
  );
  if (expiredOpenSales.length > 0) {
    alerts.push({
      level: "warning",
      title: `${expiredOpenSales.length} sale${expiredOpenSales.length === 1 ? "" : "s"} expired but still open`,
      description: "Close them on-chain — buyers cannot purchase but state shows Open.",
      href: "/admin/launchpad",
    });
  }

  const staleMilestones = data.milestones.filter(
    (m) => m.amountPool > BigInt(0) && m.claimed === BigInt(0),
  );
  if (staleMilestones.length >= 3) {
    alerts.push({
      level: "info",
      title: `${staleMilestones.length} unclaimed Rights milestones`,
      description: "Beneficiaries may need a reminder — claim pools are funded but untouched.",
      href: "/admin/rights",
    });
  }

  return alerts;
}
