"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { SkeletonTable } from "@/components/skeleton";
import { useRole } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import {
  type VestingSchedule,
  type VestingStatus,
} from "@/lib/vesting";
import { Kpi } from "@/components/kpi";

const STATUS_LABEL: Record<VestingStatus, string> = {
  draft: "Draft",
  beneficiaries_set: "Beneficiaries",
  merkle_built: "Merkle built",
  published: "Published",
  live: "Live",
  completed: "Completed",
  cancelled: "Cancelled",
};

const STATUS_BADGE: Record<VestingStatus, string> = {
  draft: "bg-slate-100 text-slate-600 border-slate-300",
  beneficiaries_set: "bg-brand-100 text-brand-800 border-brand-200",
  merkle_built: "bg-brand-100 text-brand-800 border-brand-200",
  published: "bg-amber-100 text-amber-800 border-amber-200",
  live: "bg-emerald-100 text-emerald-800 border-emerald-200",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  cancelled: "bg-slate-200 text-slate-600 border-slate-300",
};

export default function IssuerVestingPage() {
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;
  const { loading: roleLoading, isAdmin } = useRole();
  const toast = useToast();
  const [rows, setRows] = useState<VestingSchedule[] | null>(null);

  const refresh = useCallback(async () => {
    const sb = getSupabase();
    if (!sb || !wallet) return;
    let query = sb.from("vesting_schedules").select("*").order(
      "created_at",
      { ascending: false },
    );
    // Admins see everything; issuers see only what they authored.
    if (!isAdmin) query = query.eq("author", wallet);
    const { data, error } = await query;
    if (error) {
      toast.showError("Load failed", error.message);
      return;
    }
    setRows((data ?? []) as VestingSchedule[]);
  }, [wallet, isAdmin, toast]);

  useEffect(() => {
    if (roleLoading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh, roleLoading]);

  const counts = useMemo(() => {
    if (!rows) return null;
    return {
      total: rows.length,
      live: rows.filter((r) => r.status === "live" || r.status === "published")
        .length,
      drafts: rows.filter(
        (r) =>
          r.status === "draft" ||
          r.status === "beneficiaries_set" ||
          r.status === "merkle_built",
      ).length,
    };
  }, [rows]);

  if (!wallet) {
    return (
      <main className="min-w-0 flex-1">
        <WalletRequired />
      </main>
    );
  }

  return (
    <main className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            Vesting
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">
            Vesting schedules
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Your asset&apos;s vesting schedules — how a chunk unlocks over time
            and who gets what. Schedule design and on-chain milestone publishing
            are currently coordinated with the Mancipatio team; reach out via
            support to set one up.
          </p>
        </div>
      </div>

      {counts && (
        <section className="mt-6 grid gap-3 sm:grid-cols-3">
          <Kpi label="Total" value={String(counts.total)} />
          <Kpi label="Live or published" value={String(counts.live)} />
          <Kpi
            label="In progress"
            value={String(counts.drafts)}
            tone={counts.drafts > 0 ? "warn" : "default"}
          />
        </section>
      )}

      <div className="mt-6">
        {rows === null ? (
          <SkeletonTable rows={4} cols={5} />
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-card">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">Asset</th>
                  <th className="px-4 py-3">Curve</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{r.title}</p>
                      {r.description && (
                        <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">
                          {r.description}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-slate-700">{r.asset_label || "—"}</p>
                      <p className="font-mono text-[11px] text-slate-500">
                        {r.asset_mint.slice(0, 6)}…{r.asset_mint.slice(-4)}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{r.curve}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-900">
                      {Number(r.total_amount).toLocaleString("en-US")}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_BADGE[r.status]}`}
                      >
                        {STATUS_LABEL[r.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {new Date(r.created_at)
                        .toISOString()
                        .slice(0, 16)
                        .replace("T", " ")}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/issuer/vesting/${r.id}`}
                        className="text-slate-700 underline-offset-2 hover:underline"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
      <p className="text-sm font-medium text-slate-900">
        No vesting schedules yet
      </p>
      <p className="mt-2 text-xs text-slate-500">
        Vesting schedules unlock entitlements to your investors over time. Setup
        is currently coordinated with the Mancipatio team — reach out via support
        to design one for your asset.
      </p>
    </div>
  );
}
