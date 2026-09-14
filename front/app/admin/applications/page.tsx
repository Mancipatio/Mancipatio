"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import type { WalletSession } from "@solana/client";
import { RequireRole } from "@/components/require-role";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonTable } from "@/components/skeleton";
import { useToast } from "@/lib/toast";
import { recordAudit } from "@/lib/supabase";
import {
  listApplications,
  adminListApplicationEvents,
  reviewApplication,
  type ApplicationEvent,
  type ApplicationStatus,
  type LaunchApplication,
} from "@/lib/launchpad";
import { fmtMoney } from "@/lib/format";

type StatusFilter = "pending" | "needs_changes" | "approved" | "rejected" | "all";
type Decision = Exclude<ApplicationStatus, "pending">;

const APP_STATUS_BADGE: Record<ApplicationStatus, string> = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  needs_changes: "bg-orange-100 text-orange-800 border-orange-200",
  approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
};

const STATUS_LABEL: Record<ApplicationStatus, string> = {
  pending: "Pending",
  needs_changes: "Needs changes",
  approved: "Approved",
  rejected: "Rejected",
};

const EVENT_LABEL: Record<ApplicationEvent["action"], string> = {
  submitted: "Submitted",
  resubmitted: "Resubmitted",
  approved: "Approved",
  rejected: "Rejected",
  needs_changes: "Changes requested",
};

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";

export default function ApplicationsPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Launchpad
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Application review queue
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Review and approve or reject founder launch applications before
          issuer onboarding.
        </p>
      </div>
      <RequireRole role="admin">
        <ApplicationsOps />
      </RequireRole>
    </section>
  );
}

function ApplicationsOps() {
  const conn = useWalletConnection();
  const adminWallet = conn.wallet?.account.address?.toString() ?? "";
  const toast = useToast();

  const [apps, setApps] = useState<LaunchApplication[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!conn.wallet) return;
    try {
      const filter: ApplicationStatus | undefined =
        statusFilter === "all" ? undefined : statusFilter;
      const rows = await listApplications(conn.wallet, filter);
      setApps(rows);
    } catch {
      setFailed(true);
    }
  }, [statusFilter, conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setApps(null);
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!apps) return [];
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) =>
      a.company_name.toLowerCase().includes(q),
    );
  }, [apps, query]);

  const selected = useMemo(
    () => (selectedId ? (apps?.find((a) => a.id === selectedId) ?? null) : null),
    [apps, selectedId],
  );

  if (failed) {
    return (
      <p className="mt-8 text-sm text-red-600">
        Failed to load applications.
      </p>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by company name…"
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(["pending", "needs_changes", "approved", "rejected", "all"] as const).map((s) => (
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
              {s === "all" ? "All" : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {apps === null ? (
        <SkeletonTable rows={5} cols={6} />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {apps.length === 0
              ? "No applications in this status."
              : "No applications match the search."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 text-right font-medium">Raising</th>
                <th className="px-4 py-3 text-right font-medium">Equity</th>
                <th className="px-4 py-3 font-medium">Submitted</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((app) => {
                const isSelected = app.id === selectedId;
                return (
                  <tr
                    key={app.id}
                    onClick={() => setSelectedId(isSelected ? null : app.id)}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? "bg-slate-50" : "hover:bg-slate-50/60"
                    }`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {app.company_name}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-500 line-clamp-1">
                        {app.one_liner}
                      </p>
                    </td>
                    <td className="px-4 py-3 capitalize text-slate-700">
                      {app.raise_type}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {fmtMoney(app.raise_amount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {app.equity_offered}%
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {fmtDate(app.submitted_at ?? app.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          APP_STATUS_BADGE[app.status]
                        }`}
                      >
                        {STATUS_LABEL[app.status]}
                        {app.revision_count > 0 && (
                          <span className="ml-1 opacity-70">· rev {app.revision_count}</span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-xs text-slate-500">
                        {isSelected ? "▾ collapse" : "▸ expand"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail drawer */}
      {selected && (
        <ApplicationDetail
          app={selected}
          session={conn.wallet}
          adminWallet={adminWallet}
          onRefresh={refresh}
          onClose={() => setSelectedId(null)}
          toast={toast}
        />
      )}
    </div>
  );
}

function ApplicationDetail({
  app,
  session,
  adminWallet,
  onRefresh,
  onClose,
  toast,
}: {
  app: LaunchApplication;
  session: WalletSession | null | undefined;
  adminWallet: string;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [confirm, setConfirm] = useState<Decision | null>(null);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<ApplicationEvent[] | null>(null);

  const loadEvents = useCallback(async () => {
    setEvents(await adminListApplicationEvents(session, app.id));
  }, [session, app.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEvents(null);
    let cancelled = false;
    void (async () => {
      const evs = await adminListApplicationEvents(session, app.id);
      if (!cancelled) setEvents(evs);
    })();
    return () => {
      cancelled = true;
    };
  }, [session, app.id]);

  async function handleReview(decision: Decision, reason: string) {
    setBusy(true);
    try {
      // Signed + admin-gated route: writes the decision, logs the
      // application_events row server-side, and emails the founder.
      const { emailSent } = await reviewApplication(session, app.id, decision, reason);
      await recordAudit({
        ix_name: `review_application:${decision}`,
        category: "issuers",
        actor_wallet: adminWallet,
        reason,
        target_label: app.company_name,
        status: "success",
      });
      toast.show({
        kind: "success",
        title:
          decision === "needs_changes"
            ? "Changes requested"
            : `Application ${decision}`,
        description: emailSent
          ? "Decision email sent to the founder."
          : "No decision email sent (no founder email or email not configured).",
      });
      setConfirm(null);
      void onRefresh();
      void loadEvents();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Please try again.";
      toast.showError("Review failed", message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Application detail
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">
            {app.company_name}
          </h3>
          <p className="mt-0.5 text-sm text-slate-600">{app.one_liner}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-400 hover:text-slate-700"
        >
          Close ✕
        </button>
      </div>

      {/* Company */}
      <Section label="Company">
        <Field label="Name" value={app.company_name} />
        <Field label="One-liner" value={app.one_liner} />
        <Field label="Website" value={app.website ?? "—"} />
        <Field label="Category" value={app.category} />
        <Field label="Stage" value={app.stage ?? "—"} />
        <Field label="Incorporation" value={app.incorporation ?? "—"} />
        <Field label="Valuation" value={app.valuation ?? "—"} />
        <Field label="Annual revenue" value={app.annual_revenue ?? "—"} />
        <Field label="Existing investors" value={app.existing_investors ?? "—"} />
        <Field label="Problem / Why" value={app.problem_or_why ?? "—"} />
      </Section>

      {/* Raise */}
      <Section label="Raise">
        <Field label="Raise amount" value={fmtMoney(app.raise_amount)} />
        <Field label="Equity offered" value={`${app.equity_offered}%`} />
        <Field label="Min ticket" value={app.min_ticket ?? "—"} />
        <Field label="Raise structure" value={app.raise_structure ?? "—"} />
        <Field label="Cliff (months)" value={String(app.cliff_months)} />
        <Field label="Vesting (months)" value={String(app.vesting_months)} />
      </Section>

      {/* Founder */}
      <Section label="Founder">
        <Field label="Name" value={app.founder_name ?? "—"} />
        <Field label="Email" value={app.founder_email ?? "—"} />
        <Field label="Twitter" value={app.founder_twitter ?? "—"} />
        <Field label="LinkedIn" value={app.founder_linkedin ?? "—"} />
        <Field label="Why this / why now" value={app.founder_why ?? "—"} />
        <Field label="Pitch deck" value={app.pitch_deck ?? "—"} />
      </Section>

      {/* Review meta */}
      <Section label="Review">
        <Field label="Status" value={STATUS_LABEL[app.status]} />
        <Field label="Revision" value={app.revision_count > 0 ? `Revision ${app.revision_count}` : "Original submission"} />
        <Field label="Review reason" value={app.review_reason ?? "—"} />
        <Field label="Reviewed by" value={app.reviewed_by ?? "—"} mono />
        <Field label="Reviewed at" value={fmtDate(app.reviewed_at)} />
        <Field label="Applicant wallet" value={app.applicant_wallet} mono />
        <Field label="First submitted" value={fmtDate(app.created_at)} />
        <Field label="Last submitted" value={fmtDate(app.submitted_at ?? app.created_at)} />
      </Section>

      {/* Event timeline */}
      <div className="mt-5 border-t border-slate-100 pt-4">
        <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          History
        </p>
        <div>
          {events === null ? (
            <p className="text-xs text-slate-400">Loading history…</p>
          ) : events.length === 0 ? (
            <p className="text-xs text-slate-400">No recorded events for this application.</p>
          ) : (
            <ol className="space-y-2.5">
              {events.map((ev) => (
                <li key={ev.id} className="flex items-start gap-3 text-sm">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      ev.action === "approved"
                        ? "bg-emerald-500"
                        : ev.action === "rejected"
                          ? "bg-red-500"
                          : ev.action === "needs_changes"
                            ? "bg-orange-500"
                            : "bg-slate-400"
                    }`}
                  />
                  <div className="min-w-0">
                    <p className="text-slate-800">
                      <span className="font-medium">{EVENT_LABEL[ev.action]}</span>
                      <span className="text-slate-500"> · {ev.actor}</span>
                      <span className="text-slate-400"> · {fmtDate(ev.created_at)}</span>
                    </p>
                    {ev.reason && (
                      <p className="mt-0.5 text-xs text-slate-500">{ev.reason}</p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      {/* Actions — pending and resubmitted apps can be decided; a needs_changes
          app can still be approved or finally rejected without waiting. */}
      {(app.status === "pending" || app.status === "needs_changes") && (
        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirm("approved")}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Approve
          </button>
          {app.status === "pending" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirm("needs_changes")}
              className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
            >
              Request changes
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirm("rejected")}
            className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      )}

      {app.status === "approved" && (
        <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-5">
          <Link
            href={`/issuer/launchpad?application=${app.id}`}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Open the sale from this application →
          </Link>
          <Link
            href="/issuer/onboarding"
            className="text-sm font-medium text-slate-600 hover:underline"
          >
            Issuer onboarding (if not yet verified)
          </Link>
        </div>
      )}

      <ConfirmModal
        open={confirm === "approved"}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => handleReview("approved", reason)}
        title="Approve application"
        kind="info"
        confirmLabel="Approve"
        description={
          <>
            <p>
              Approving this application allows the founder to proceed to
              issuer onboarding. Ensure the pitch deck and financials have
              been reviewed.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log.
            </p>
          </>
        }
        busy={busy}
      />
      <ConfirmModal
        open={confirm === "needs_changes"}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => handleReview("needs_changes", reason)}
        title="Request changes"
        kind="warning"
        confirmLabel="Request changes"
        description={
          <>
            <p>
              The founder will see your explanation on their application page
              and can edit and resubmit the same application. This review loop
              can repeat until the application is approved or finally rejected.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              The explanation is shown to the applicant and recorded in the
              audit log.
            </p>
          </>
        }
        busy={busy}
      />
      <ConfirmModal
        open={confirm === "rejected"}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => handleReview("rejected", reason)}
        title="Reject application"
        kind="destructive"
        confirmLabel="Reject"
        description={
          <>
            <p>
              Rejecting closes this application — the founder cannot proceed
              to issuer onboarding with it. They may still start a fresh
              application later; if you want them to fix and resubmit this
              one instead, use “Request changes”.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log and shown to the
              applicant.
            </p>
          </>
        }
        busy={busy}
      />
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5 border-t border-slate-100 pt-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {label}
      </p>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">{children}</dl>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd
        className={`mt-0.5 break-all text-slate-800 ${mono ? "font-mono text-xs" : "text-sm"}`}
      >
        {value || "—"}
      </dd>
    </div>
  );
}
