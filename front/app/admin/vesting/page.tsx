"use client";

// Admin — Vesting series review queue (spec §11.1.4: "Our team reviews the
// form. Approve or send back to fix."). Decisions are recorded with a reason
// and surfaced to the client in their issuer console.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { address } from "@solana/kit";
import { ConfirmModal } from "@/components/confirm-modal";
import { RequireRole } from "@/components/require-role";
import { SkeletonTable } from "@/components/skeleton";
import { Kpi } from "@/components/kpi";
import { useToast } from "@/lib/toast";
import {
  adminListVestingSeries,
  adminReviewVestingSeries,
  type VestingSeriesRow,
} from "@/lib/vesting-series";
import {
  fetchMintDecimals,
  formatAmountWithUnits,
  formatUtcAndLocal,
  localZoneLabel,
} from "@/lib/vesting-amounts";

const STATUS_BADGE: Record<VestingSeriesRow["status"], string> = {
  submitted: "bg-amber-100 text-amber-800 border-amber-200",
  needs_changes: "bg-orange-100 text-orange-800 border-orange-200",
  approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
  created: "bg-brand-100 text-brand-800 border-brand-200",
  cancelled: "bg-slate-200 text-slate-600 border-slate-300",
};

/** UTC (what the program stores) plus the reviewer's local reading (F06). */
function fmtTs(ts: number): string {
  return formatUtcAndLocal(ts);
}

/** Submitted amounts are BASE units; show the token reading once the mint
 *  decimals are known so "100" cannot be misread as 100 tokens (F03). */
function fmtAmount(base: string, decimals: number | null | undefined): string {
  if (!/^\d+$/.test(base)) return `${base} (not a valid base-unit amount)`;
  return formatAmountWithUnits(BigInt(base), decimals);
}

export default function AdminVestingPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const toast = useToast();
  const [rows, setRows] = useState<VestingSeriesRow[] | null>(null);
  /** Mint → decimals; null = could not be read (amounts stay in base units). */
  const [decimalsByMint, setDecimalsByMint] = useState<
    Record<string, number | null>
  >({});
  const zoneLabel = useMemo(() => localZoneLabel(), []);
  const [listError, setListError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [review, setReview] = useState<{
    row: VestingSeriesRow;
    decision: "approved" | "needs_changes" | "rejected";
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!conn.wallet) return;
    try {
      const data = await adminListVestingSeries(conn.wallet);
      setRows(data);
      setListError(null);
    } catch (err) {
      setListError(
        err instanceof Error ? err.message : "Could not load the queue",
      );
    }
  }, [conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Read the decimals of every submitted mint so the review shows amounts in
  // tokens next to the exact base units (the terms become immutable here).
  useEffect(() => {
    if (!rows) return;
    const mints = Array.from(new Set(rows.map((r) => r.token_mint)));
    let cancelled = false;
    void Promise.all(
      mints.map(async (m) => {
        try {
          return [m, await fetchMintDecimals(client.runtime.rpc, address(m))];
        } catch {
          return [m, null];
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setDecimalsByMint(
        Object.fromEntries(pairs as [string, number | null][]),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [rows, client]);

  async function decide(reason: string) {
    if (!review || !conn.wallet) return;
    setBusy(true);
    try {
      await adminReviewVestingSeries(
        conn.wallet,
        review.row.id,
        review.decision,
        reason,
      );
      toast.show({ kind: "success", title: `Series ${review.decision}` });
      setReview(null);
      await refresh();
    } catch (err) {
      toast.showError(
        "Review failed",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }

  const needsReview = (r: VestingSeriesRow) =>
    r.status === "submitted" ||
    (r.status === "approved" && !r.approved_terms_hash && !r.series_pda);
  const queue = rows?.filter(needsReview) ?? [];
  const history = rows?.filter((r) => !needsReview(r)) ?? [];

  return (
    <RequireRole role="admin">
      <section className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Vesting
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">
          Vesting series review
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Clients submit vesting series for review. Approve them so the client
          can create the on-chain series, send them back to fix, or reject.
        </p>

        {rows && (
          <section className="mt-6 grid gap-3 sm:grid-cols-3">
            <Kpi
              label="Awaiting review"
              value={String(queue.length)}
              tone={queue.length > 0 ? "warn" : "default"}
            />
            <Kpi
              label="Approved / live"
              value={String(
                history.filter(
                  (r) => r.status === "approved" || r.status === "created",
                ).length,
              )}
            />
            <Kpi label="Total submissions" value={String(rows.length)} />
          </section>
        )}

        <div className="mt-6">
          {rows === null && !listError ? (
            <SkeletonTable rows={3} cols={5} />
          ) : listError ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {listError}
            </p>
          ) : rows!.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
              <p className="text-sm font-medium text-slate-900">
                No submissions yet
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {[...queue, ...history].map((row) => (
                <div
                  key={row.id}
                  className="rounded-xl border border-slate-200 bg-white p-4 shadow-card"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {row.token_label || "Vesting series"}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                        {row.client_wallet.slice(0, 6)}…
                        {row.client_wallet.slice(-4)} · mint{" "}
                        {row.token_mint.slice(0, 6)}…{row.token_mint.slice(-4)}{" "}
                        · {row.recipients.length} recipients ·{" "}
                        {row.schedule.length} tranches · {row.timing_mode}/
                        {row.delivery_mode}
                        {row.recovery_enabled ? " · recovery" : ""}
                        {row.cancellation_enabled ? " · cancellable" : ""}
                        {row.pre_cliff_bps > 0
                          ? ` · pre-cliff ${row.pre_cliff_bps / 100}%`
                          : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_BADGE[row.status]}`}
                      >
                        {row.status.replace("_", " ")}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((e) => (e === row.id ? null : row.id))
                        }
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400"
                      >
                        {expanded === row.id ? "Hide" : "Details"}
                      </button>
                      {needsReview(row) && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              setReview({ row, decision: "approved" })
                            }
                            className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setReview({ row, decision: "needs_changes" })
                            }
                            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                          >
                            Send back
                          </button>
                          <button
                            type="button"
                            disabled={row.status === "approved"}
                            onClick={() =>
                              setReview({ row, decision: "rejected" })
                            }
                            className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100"
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {expanded === row.id && (
                    <div className="mt-4 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                          Recipients
                        </p>
                        <p className="mt-1 text-[11px] text-slate-500">
                          Amounts are stored in base units of the mint
                          {(() => {
                            const dec = decimalsByMint[row.token_mint];
                            return dec === undefined
                              ? " (reading decimals…)"
                              : dec === null
                                ? " (decimals could not be read — token reading unavailable)"
                                : ` (${dec} decimal${dec === 1 ? "" : "s"})`;
                          })()}
                          .
                        </p>
                        <ul className="mt-2 space-y-1 font-mono text-xs text-slate-700">
                          {row.recipients.map((r, i) => (
                            <li key={i} className="flex justify-between gap-2">
                              <span>
                                {r.wallet.slice(0, 8)}…{r.wallet.slice(-6)}
                              </span>
                              <span className="text-right">
                                {fmtAmount(
                                  r.allocation,
                                  decimalsByMint[row.token_mint],
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                          Schedule
                        </p>
                        <p className="mt-1 text-[11px] text-slate-500">
                          Unlock times in UTC (on-chain) · local = {zoneLabel}
                        </p>
                        <ul className="mt-2 space-y-1 text-xs text-slate-700">
                          {row.schedule.map((t, i) => (
                            <li
                              key={i}
                              className="flex flex-wrap justify-between gap-x-3 gap-y-0.5"
                            >
                              <span>{fmtTs(t.unlock_ts)}</span>
                              <span className="font-mono">
                                {fmtAmount(
                                  t.amount,
                                  decimalsByMint[row.token_mint],
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 text-xs text-slate-500">
                          {row.timing_mode === "approval"
                            ? `Approval mode — window ${Math.round(row.approval_window_secs / 3600)}h`
                            : "Auto mode"}{" "}
                          · {row.delivery_mode} delivery · recovery{" "}
                          {row.recovery_enabled ? "ON" : "off"} · cancellation{" "}
                          {row.cancellation_enabled ? "ON" : "off"}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <ConfirmModal
          open={review !== null}
          title={
            review?.decision === "approved"
              ? "Approve this vesting series?"
              : review?.decision === "needs_changes"
                ? "Send back for fixes?"
                : "Reject this vesting series?"
          }
          description={
            review?.decision === "approved"
              ? "The client will be able to create the on-chain series exactly as submitted."
              : review?.decision === "needs_changes"
                ? "Explain what needs fixing — the client sees this and can resubmit."
                : "Explain the rejection — the client sees this."
          }
          kind={
            review?.decision === "approved"
              ? "info"
              : review?.decision === "needs_changes"
                ? "warning"
                : "destructive"
          }
          confirmLabel={
            review?.decision === "approved"
              ? "Approve"
              : review?.decision === "needs_changes"
                ? "Send back"
                : "Reject"
          }
          requireReason={review?.decision !== "approved"}
          reasonPlaceholder={
            review?.decision === "approved"
              ? "Optional note (visible to the client)"
              : "What needs fixing / why is it rejected? (visible to the client)"
          }
          busy={busy}
          onConfirm={(reason) => void decide(reason)}
          onClose={() => setReview(null)}
        />
      </section>
    </RequireRole>
  );
}
