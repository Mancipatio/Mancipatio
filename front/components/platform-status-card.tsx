"use client";

import Link from "next/link";
import { useSolanaClient } from "@solana/react-hooks";
import { useCallback, useEffect, useState } from "react";
import {
  fetchMaybePlatform,
  findPlatformPda,
  type Platform,
} from "@/lib/generated/asset_registry";
import { PauseFlagsPanel } from "@/components/pause-flags-panel";
import { SkeletonCard } from "@/components/skeleton";
import { PAUSE_FLAGS, pausedFlags } from "@/lib/pause-flags";

export function PlatformStatusCard() {
  const client = useSolanaClient();
  const [platform, setPlatform] = useState<Platform | null | undefined>(
    undefined,
  );

  const refresh = useCallback(async () => {
    const [pda] = await findPlatformPda();
    const maybe = await fetchMaybePlatform(client.runtime.rpc, pda);
    setPlatform(maybe.exists ? maybe.data : null);
  }, [client]);

  useEffect(() => {
    // Async fetch on mount — switch to SWR / React Query when added to stack.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  if (platform === undefined) {
    return <SkeletonCard rows={4} />;
  }

  if (platform === null) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 shadow-card">
        <p className="text-xs font-semibold uppercase tracking-wider text-amber-900">
          Platform not initialized
        </p>
        <h2 className="mt-2 text-lg font-semibold text-amber-950">
          Bootstrap required
        </h2>
        <p className="mt-2 text-sm text-amber-900/90">
          The Platform singleton must be initialized before any other
          on-chain operation can succeed. The wallet that initializes becomes
          the permanent Super Admin.
        </p>
        <Link
          href="/admin/platform"
          className="mt-4 inline-flex items-center rounded-lg bg-amber-900 px-4 py-2 text-sm font-medium text-white hover:bg-amber-950"
        >
          Initialize Platform →
        </Link>
      </div>
    );
  }

  const paused = pausedFlags(platform.pauseFlags).length;
  const status =
    paused === PAUSE_FLAGS.length
      ? "Fully paused"
      : paused > 0
        ? `${paused} of ${PAUSE_FLAGS.length} paused`
        : "Active";
  const anyPaused = paused > 0;

  return (
    <div className="panel overflow-hidden">
      <div
        className="h-0.5"
        style={{
          background: anyPaused
            ? "linear-gradient(90deg, #ef4444 0%, #b91c1c 100%)"
            : "linear-gradient(90deg, #10b981 0%, #059669 100%)",
        }}
      />
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="page-eyebrow">Platform</p>
            <h2 className="mt-1 text-[16px] font-semibold text-slate-900">
              On-chain singleton
            </h2>
          </div>
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${
              anyPaused
                ? "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200"
                : "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200"
            }`}
          >
            <span
              className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${
                anyPaused ? "bg-red-500" : "bg-emerald-500 animate-pulse"
              }`}
            />
            {status}
          </span>
        </div>

        <dl className="mt-4 space-y-1.5 text-[13px]">
          <Row label="Super Admin" value={platform.admin.toString()} mono />
          <Row label="Treasury" value={platform.protocolTreasury.toString()} mono />
          <Row
            label="Protocol fee"
            value={`${platform.protocolFeeBps} bps — reserved on-chain field, not charged`}
          />
          <Row label="Issuers" value={String(platform.issuersCount)} />
          <Row label="Version" value={String(platform.version)} />
        </dl>

        <div className="mt-5">
          <PauseFlagsPanel platform={platform} onChanged={refresh} />
        </div>

        <div className="mt-4">
          <Link
            href="/admin/platform"
            className="text-xs text-brand-700 underline-offset-2 hover:underline"
          >
            Open console →
          </Link>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right text-slate-700 ${mono ? "font-mono text-xs" : ""}`}
        title={mono ? value : undefined}
      >
        {mono ? `${value.slice(0, 4)}…${value.slice(-4)}` : value}
      </dd>
    </div>
  );
}
