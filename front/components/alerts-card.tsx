"use client";

import Link from "next/link";
import { useSolanaClient } from "@solana/react-hooks";
import { useEffect, useState } from "react";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { fetchMaybePlatform, findPlatformPda } from "@/lib/generated/asset_registry";
import { SaleStatus } from "@/lib/generated/asset_registry";
import { Skeleton } from "@/components/skeleton";
import { EMERGENCY_PAUSE_ANCHOR } from "@/lib/distribute-guidance";
import { moduleEnabled, scopeEnabled } from "@/lib/features";
import { detectNetwork, type Network } from "@/lib/network";
import {
  describePausedAreas,
  EMERGENCY_PAUSE_BITS,
  formatPauseFlags,
  PAUSE_CUSTODY_ENTRY,
  PAUSE_DISTRIBUTIONS,
  PAUSE_EXITS_OPEN,
  PAUSE_FLAGS,
  PAUSE_ISSUER_PROCEEDS,
  PAUSE_ONBOARDING,
  PAUSE_PAYOUT_MODULES,
  PAUSE_PRIMARY,
  PAUSE_SECONDARY,
} from "@/lib/pause-flags";
import { saleBuyState } from "@/lib/sale-liveness";
import { usePauseFlags } from "@/lib/use-pause-flags";

type AlertLevel = "critical" | "warning" | "info";

export type Alert = {
  level: AlertLevel;
  title: string;
  description: string;
  href?: string;
};

// ── The pause rows (pure, node-safe: tests/pause-panel-alerts.test.ts) ──────

/**
 * The pause bits set ON PURPOSE on this network: the pilot scope, from the
 * same switches every gate reads (lib/features.ts). Off mainnet it is 0, so
 * every paused emergency area is the critical row, as before. On mainnet:
 * the payout modules (D2) and the three window bits, cleared only for a
 * sale (0x02, 0x20) or a conversion vault's open and deposit (0x08); plus
 * Onboarding while issuance is off (KYC-only mode), Trading through Manci
 * while secondary trading is off, and Distributions while distributions,
 * rights and vesting are all off. 0x7F under KYC-only mode (ops/env-vars.md),
 * 0x7E for the plain pilot, 0x7A with OTC on.
 */
export function pilotPauseMask(network: Network = detectNetwork()): number {
  if (network !== "mainnet") return 0;
  let mask = PAUSE_PAYOUT_MODULES | PAUSE_PRIMARY | PAUSE_ISSUER_PROCEEDS | PAUSE_CUSTODY_ENTRY;
  if (!scopeEnabled("issuance", network)) mask |= PAUSE_ONBOARDING;
  if (!moduleEnabled("secondaryTrading", network)) mask |= PAUSE_SECONDARY;
  if (!moduleEnabled("distributions", network) && !moduleEnabled("rights", network) && !moduleEnabled("vesting", network)) {
    mask |= PAUSE_DISTRIBUTIONS;
  }
  return mask;
}

/**
 * The overview's pause rows. `expected` is the pilot mask (pilotPauseMask),
 * so red means a deviation from it, not the steady state: a bit paused
 * outside the mask is the critical row; the mask itself an info row; a mask
 * bit that is clear a window to close (0x08 after the holder's deposit, 0x02
 * once no sale takes buys, 0x20 after the close_sale) or a drift from what
 * this build keeps off. `liveSales` counts the Open sales that can take a buy.
 */
export function pauseAlerts(flags: number | null, expected: number, liveSales: number): Alert[] {
  if (flags === null) return [];
  const alerts: Alert[] = [];
  const panel = `/admin/platform#${EMERGENCY_PAUSE_ANCHOR}`;
  // The emergency areas only: the payout modules (0x40) stay off on mainnet
  // by decision (D2), which is no emergency.
  const unexpected = describePausedAreas(flags & EMERGENCY_PAUSE_BITS & ~expected);
  if (unexpected) {
    alerts.push({
      level: "critical",
      title: "Emergency pause is on",
      description: `Paused: ${unexpected}. ${PAUSE_EXITS_OPEN}`,
      href: "/admin/platform",
    });
  }
  const pilot = flags & expected;
  if (pilot) {
    alerts.push({
      level: "info",
      title: `Pilot pause mask active (${formatPauseFlags(pilot)})`,
      description: `Closed on purpose (Terms and module switches), not an emergency: ${describePausedAreas(pilot)}. ${PAUSE_EXITS_OPEN}`,
      href: panel,
    });
  }
  const open = expected & ~flags;
  if (open & PAUSE_CUSTODY_ENTRY) {
    alerts.push({
      level: "warning",
      title: "Custody entry window is open — close it after the deposit",
      description:
        "Admins can open custody vaults (delivery escrows included) and holders can deposit. Pause custody entry again as soon as the holder's deposit has landed (any Admin; the request is on /admin/custody).",
      href: panel,
    });
  }
  if (open & PAUSE_PRIMARY) {
    alerts.push(
      liveSales > 0
        ? {
            level: "info",
            title: `Primary issuance is open for ${liveSales} live sale${liveSales === 1 ? "" : "s"}`,
            description: "Buys land while the sale's window runs; the launchpad offers the re-pause once it is over.",
            href: "/admin/launchpad",
          }
        : {
            level: "warning",
            title: "Primary issuance is open with no sale taking buys",
            description: "Sale openings, buys and treasury mints are possible platform-wide: set 0x02 again (the launchpad offers the re-pause).",
            href: "/admin/launchpad",
          },
    );
  }
  if (open & PAUSE_ISSUER_PROCEEDS) {
    alerts.push({
      level: "warning",
      title: "Issuer proceeds is open (0x20)",
      description: "Opened for a close_sale or a payout release: set it again once that transaction has landed.",
      href: "/admin/launchpad",
    });
  }
  for (const flag of PAUSE_FLAGS) {
    const windowBit = flag.bit === PAUSE_CUSTODY_ENTRY || flag.bit === PAUSE_PRIMARY || flag.bit === PAUSE_ISSUER_PROCEEDS;
    if (!(open & flag.bit) || windowBit) continue;
    alerts.push({
      level: "warning",
      title: `${flag.label}: open on-chain, off on this site`,
      description:
        "This build keeps the area off (KYC-only mode or its module switch), but the chain accepts transactions signed outside the site: pause it again on the platform page.",
      href: panel,
    });
  }
  return alerts;
}

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
  /** `Platform.pause_flags` at the first read, or null when the Platform is not initialized. */
  const [platformPaused, setPlatformPaused] = useState<number | null>(null);
  const [platformInitialized, setPlatformInitialized] = useState<
    boolean | null
  >(null);
  const [failed, setFailed] = useState(false);
  // Re-read every 30 s through the pause gate's cache, which the pause panel
  // beside this card clears after a change: a re-pause clears the window
  // warning without a reload. Null until read or when unreadable.
  const liveFlags = usePauseFlags();

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
    platformPaused: platformInitialized ? (liveFlags ?? platformPaused) : null,
    expected: pilotPauseMask(),
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
  /** The pilot pause mask (pilotPauseMask): the bits set on purpose. */
  expected: number;
}): Alert[] {
  const { data, platformInitialized, platformPaused, expected } = args;
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

  // The Open sales that can take a buy (lib/sale-liveness; the issuer freeze
  // is not read here): they justify an open Primary issuance (0x02).
  const liveSales = data.sales.filter(
    (s) => s.status === SaleStatus.Open && saleBuyState(s, nowSec) === "live",
  ).length;
  alerts.push(...pauseAlerts(platformPaused, expected, liveSales));

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
