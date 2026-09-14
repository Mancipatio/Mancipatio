"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonCard, SkeletonTable } from "@/components/skeleton";
import { getSupabase, recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import {
  markVestingMilestonePublished,
  readVestingBeneficiaries,
  updateVestingScheduleStatus,
  vestedUpTo,
  type VestingBeneficiary,
  type VestingClaim,
  type VestingMilestone,
  type VestingSchedule,
  type VestingStatus,
} from "@/lib/vesting";

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

export default function VestingDetailPage() {
  const params = useParams<{ id: string }>();
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;
  const toast = useToast();

  const [schedule, setSchedule] = useState<VestingSchedule | null | "missing">(
    null,
  );
  const [milestones, setMilestones] = useState<VestingMilestone[] | null>(null);
  const [beneficiaries, setBeneficiaries] = useState<
    VestingBeneficiary[] | null
  >(null);
  const [claims, setClaims] = useState<VestingClaim[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const refresh = useCallback(async () => {
    const sb = getSupabase();
    if (!sb || !conn.wallet) { setBeneficiaries(null); setCanManage(false); return; }
    try {
      const [{ data: s, error: sErr }, { data: m }, beneficiaryResult, { data: c }] =
        await Promise.all([
          sb
            .from("vesting_schedules")
            .select("*")
            .eq("id", params.id)
            .maybeSingle(),
          sb
            .from("vesting_milestones")
            .select("*")
            .eq("schedule_id", params.id)
            .order("idx", { ascending: true }),
          readVestingBeneficiaries(conn.wallet, params.id),
          sb
            .from("vesting_claims")
            .select("*")
            .eq("schedule_id", params.id),
        ]);
      if (sErr) throw sErr;
      setSchedule((s as VestingSchedule | null) ?? "missing");
      setMilestones((m ?? []) as VestingMilestone[]);
      setBeneficiaries(beneficiaryResult.beneficiaries);
      setCanManage(beneficiaryResult.can_manage);
      setClaims((c ?? []) as VestingClaim[]);
      setLoadError(null);
    } catch (err) {
      setBeneficiaries(null);
      setCanManage(false);
      setLoadError(err instanceof Error ? err.message : "Could not load beneficiaries");
    }
  }, [params.id, conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const canEdit = canManage;

  const vestedNow = useMemo(() => {
    if (!milestones) return BigInt(0);
    return vestedUpTo(milestones);
  }, [milestones]);

  const claimsByMilestone = useMemo(() => {
    const map = new Map<number, VestingClaim[]>();
    for (const c of claims ?? []) {
      const list = map.get(c.milestone_idx) ?? [];
      list.push(c);
      map.set(c.milestone_idx, list);
    }
    return map;
  }, [claims]);

  async function updateStatus(next: VestingStatus, reason: string) {
    if (!canEdit || !wallet || schedule === null || schedule === "missing")
      return;
    setBusy(true);
    try {
      // Signed route — server enforces admin OR author OR issuer authority.
      await updateVestingScheduleStatus(conn.wallet, params.id, next);
      void recordAudit({
        ix_name: "update_vesting_status",
        category: "rights",
        actor_wallet: wallet,
        reason,
        target_label: schedule.title,
        metadata: {
          schedule_id: params.id,
          previous: schedule.status,
          next,
        },
      });
      toast.show({ kind: "success", title: `Status → ${STATUS_LABEL[next]}` });
      await refresh();
    } catch (err) {
      toast.showError(
        "Update failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function markMilestonePublished(idx: number) {
    if (!canEdit || !wallet) return;
    setBusy(true);
    try {
      // Signed route — server enforces admin OR author OR issuer authority.
      await markVestingMilestonePublished(conn.wallet, params.id, idx);
      void recordAudit({
        ix_name: "mark_milestone_published",
        category: "rights",
        actor_wallet: wallet,
        reason: `Milestone #${idx} published`,
        target_label:
          schedule !== null && schedule !== "missing" ? schedule.title : "",
        metadata: { schedule_id: params.id, milestone_idx: idx },
      });
      toast.show({ kind: "success", title: `Milestone #${idx} marked published` });
      await refresh();
    } catch (err) {
      toast.showError(
        "Update failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  if (!wallet) return <main><WalletRequired /></main>;

  if (loadError) return <main className="min-w-0 flex-1"><div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900"><p>{loadError}</p><button type="button" onClick={() => void refresh()} className="btn-brand mt-3">Try again</button></div></main>;

  if (schedule === null) {
    return (
      <main className="min-w-0 flex-1">
        <Link href="/issuer/vesting" className="text-xs uppercase tracking-widest text-slate-500 hover:text-slate-700">
          ← Vesting
        </Link>
        <div className="mt-6 space-y-4">
          <SkeletonCard rows={4} />
          <SkeletonTable rows={5} cols={4} />
        </div>
      </main>
    );
  }

  if (schedule === "missing") {
    return (
      <main className="min-w-0 flex-1">
        <Link
          href="/issuer/vesting"
          className="text-xs uppercase tracking-widest text-slate-500 hover:text-slate-700"
        >
          ← Vesting
        </Link>
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
          Schedule not found.
        </div>
      </main>
    );
  }

  const total = BigInt(schedule.total_amount);
  const remaining = total - vestedNow;
  const pct =
    total > BigInt(0)
      ? Number((vestedNow * BigInt(10000)) / total) / 100
      : 0;

  return (
    <main className="min-w-0 flex-1">
      <Link
        href="/issuer/vesting"
        className="text-xs uppercase tracking-widest text-slate-500 hover:text-slate-700"
      >
        ← Vesting
      </Link>

      <header className="mt-4 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-slate-500">
              {schedule.curve}
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-900">
              {schedule.title}
            </h1>
            {schedule.description && (
              <p className="mt-2 max-w-2xl text-sm text-slate-600">
                {schedule.description}
              </p>
            )}
          </div>
          <span
            className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wider ${STATUS_BADGE[schedule.status]}`}
          >
            {STATUS_LABEL[schedule.status]}
          </span>
        </div>

        <dl className="mt-6 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">
              Asset
            </dt>
            <dd className="mt-1 text-sm font-medium text-slate-900">
              {schedule.asset_label || "—"}
            </dd>
            <p className="font-mono text-[11px] text-slate-500">
              {schedule.asset_mint.slice(0, 8)}…{schedule.asset_mint.slice(-4)}
            </p>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">
              Total amount
            </dt>
            <dd className="mt-1 font-mono text-sm text-slate-900">
              {Number(total).toLocaleString("en-US")}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">
              Vested so far
            </dt>
            <dd className="mt-1 font-mono text-sm text-slate-900">
              {Number(vestedNow).toLocaleString("en-US")}{" "}
              <span className="text-xs text-slate-500">
                ({pct.toFixed(2)}%)
              </span>
            </dd>
            <p className="text-[11px] text-slate-500">
              {Number(remaining).toLocaleString("en-US")} remaining
            </p>
          </div>
          {schedule.merkle_root && (
            <div className="sm:col-span-3">
              <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                Merkle root
              </dt>
              <dd className="mt-1 break-all font-mono text-[11px] text-slate-700">
                {schedule.merkle_root}
              </dd>
            </div>
          )}
        </dl>

        {canEdit && (
          <div className="mt-5 flex flex-wrap gap-2">
            {schedule.status === "merkle_built" && (
              <button
                type="button"
                onClick={() =>
                  void updateStatus(
                    "published",
                    "All milestones now published on-chain",
                  )
                }
                disabled={busy}
                className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                Mark as published
              </button>
            )}
            {schedule.status === "published" && (
              <button
                type="button"
                onClick={() =>
                  void updateStatus("live", "Claims open to beneficiaries")
                }
                disabled={busy}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Go live
              </button>
            )}
            {schedule.status === "live" &&
              (milestones?.every((m) => m.published) ?? false) &&
              vestedNow === total && (
                <button
                  type="button"
                  onClick={() =>
                    void updateStatus(
                      "completed",
                      "All milestones unlocked and published",
                    )
                  }
                  disabled={busy}
                  className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  Mark completed
                </button>
              )}
            {schedule.status !== "cancelled" &&
              schedule.status !== "completed" && (
                <button
                  type="button"
                  onClick={() => setConfirmCancel(true)}
                  disabled={busy}
                  className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  Cancel schedule
                </button>
              )}
          </div>
        )}
      </header>

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500">
          Milestones
        </h2>
        {milestones === null ? (
          <div className="mt-3">
            <SkeletonTable rows={3} cols={5} />
          </div>
        ) : milestones.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-slate-300 bg-white p-4 text-center text-xs text-slate-500">
            No milestones saved yet.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-card">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2">#</th>
                  <th className="px-4 py-2">Unlock date</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                  <th className="px-4 py-2">On-chain</th>
                  <th className="px-4 py-2 text-right">Claims</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {milestones.map((m) => {
                  const ms = claimsByMilestone.get(m.idx) ?? [];
                  const isPast = m.unlock_date <= new Date().toISOString().slice(0, 10);
                  return (
                    <tr key={m.idx} className="hover:bg-slate-50">
                      <td className="px-4 py-2 font-mono text-xs text-slate-500">
                        #{m.idx}
                      </td>
                      <td
                        className={`px-4 py-2 ${isPast ? "text-slate-900" : "text-slate-400"}`}
                      >
                        {m.unlock_date}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        {Number(m.amount).toLocaleString("en-US")}
                      </td>
                      <td className="px-4 py-2">
                        {m.published ? (
                          <span className="text-emerald-700">Published</span>
                        ) : (
                          <span className="text-slate-500">Pending</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-700">
                        {ms.length} / {beneficiaries?.length ?? 0}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {canEdit && !m.published && (
                          <button
                            type="button"
                            onClick={() => void markMilestonePublished(m.idx)}
                            disabled={busy}
                            className="text-xs text-slate-700 underline-offset-2 hover:underline"
                          >
                            Mark published
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
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500">
          Beneficiaries
        </h2>
        {beneficiaries === null ? (
          <div className="mt-3">
            <SkeletonTable rows={4} cols={3} />
          </div>
        ) : beneficiaries.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-slate-300 bg-white p-4 text-center text-xs text-slate-500">
            No beneficiaries saved yet.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-card">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2">Wallet</th>
                  <th className="px-4 py-2 text-right">Entitlement</th>
                  <th className="px-4 py-2 text-right">% of total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {beneficiaries.map((b) => {
                  const ent = BigInt(b.entitlement);
                  const benTotal = beneficiaries.reduce(
                    (acc, x) => acc + BigInt(x.entitlement),
                    BigInt(0),
                  );
                  const p =
                    benTotal > BigInt(0)
                      ? Number((ent * BigInt(10000)) / benTotal) / 100
                      : 0;
                  return (
                    <tr key={b.wallet} className="hover:bg-slate-50">
                      <td className="px-4 py-2 font-mono text-xs text-slate-700">
                        {b.wallet}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        {Number(ent).toLocaleString("en-US")}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-500">
                        {p.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmModal
        open={confirmCancel}
        kind="destructive"
        title="Cancel this vesting schedule?"
        description="Beneficiaries lose access to unpublished milestones. Already-published on-chain milestones remain claimable from the rights program — this only flips the off-chain status."
        confirmLabel="Cancel schedule"
        cancelLabel="Keep"
        requireReason
        reasonPlaceholder="Why are we cancelling?"
        busy={busy}
        onClose={() => setConfirmCancel(false)}
        onConfirm={async (reason) => {
          await updateStatus("cancelled", reason);
          setConfirmCancel(false);
        }}
      />
    </main>
  );
}
