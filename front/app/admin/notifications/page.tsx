"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { RequireRole } from "@/components/require-role";
import { SkeletonTable } from "@/components/skeleton";
import { signedFetch } from "@/lib/siws-client";
import { useToast } from "@/lib/toast";

import { Kpi } from "@/components/kpi";
type Kind = "email" | "in-app" | "both";
type Audience =
  | "all"
  | "issuers"
  | "verified-issuers"
  | "investors"
  | "pending-kyc"
  | "tag"
  | "wallet";

type Status = "draft" | "scheduled" | "sending" | "sent" | "failed";

type Notif = {
  id: string;
  created_at: string;
  kind: Kind;
  audience: Audience;
  audience_param: string | null;
  subject: string;
  body: string;
  template: string | null;
  status: Status;
  scheduled_for: string | null;
  sent_at: string | null;
  recipient_count: number;
  author: string;
  error: string | null;
};

const AUDIENCE_LABEL: Record<Audience, string> = {
  all: "Everyone",
  issuers: "All issuers",
  "verified-issuers": "Verified issuers only",
  investors: "All investors",
  "pending-kyc": "Pending KYC",
  tag: "By tag",
  wallet: "Specific wallet",
};

const STATUS_BADGE: Record<Status, string> = {
  draft: "bg-slate-100 text-slate-700 border-slate-300",
  scheduled: "bg-brand-100 text-brand-800 border-brand-200",
  sending: "bg-amber-100 text-amber-800 border-amber-200",
  sent: "bg-emerald-100 text-emerald-800 border-emerald-200",
  failed: "bg-red-100 text-red-800 border-red-200",
};

const TEMPLATES: { slug: string; label: string; subject: string; body: string }[] = [
  {
    slug: "welcome",
    label: "Welcome",
    subject: "Welcome to Manci",
    body:
      "Hi {{name}},\n\nThanks for joining Manci. You can finish onboarding by linking your wallet at the magic-link we sent you.\n\n— The Manci team",
  },
  {
    slug: "kyc-reminder",
    label: "KYC reminder",
    subject: "Action required: finish KYC verification",
    body:
      "Hi {{name}},\n\nYour Manci verification is not complete yet. You can already browse, buy and trade tokens; verification is required before you can convert tokens into company shares, take delivery of physical goods, or raise capital and issue assets.\n\nReply to this email if you need help.",
  },
  {
    slug: "sale-launch",
    label: "Sale launch",
    subject: "{{asset_name}} primary sale is live",
    body:
      "Issuer {{issuer}} just opened a primary sale for {{asset_name}}.\n\nVisit /marketplace/launchpad to participate.",
  },
  {
    slug: "governance-vote",
    label: "Governance vote",
    subject: "Vote: {{proposal_title}}",
    body:
      "A new proposal is live for {{asset_name}}.\n\nIf your wallet is in the snapshot, vote at /portfolio/governance.",
  },
];

export default function NotificationsPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Notifications
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Broadcasts
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Compose email + in-app broadcasts to any audience slice. Note: this is
          a drafting surface only — broadcasts are recorded but no delivery
          worker sends them yet, so nothing is dispatched to recipients.
          (Transactional emails — application decisions, OTC notices — are sent
          separately and are unaffected.)
        </p>
      </div>
      <RequireRole role="admin">
        <NotificationsOps />
      </RequireRole>
    </section>
  );
}

function NotificationsOps() {
  const conn = useWalletConnection();
  const [rows, setRows] = useState<Notif[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [resendReady, setResendReady] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    if (!conn.wallet) return;
    try {
      // Signed admin read — broadcast rows (incl. per-wallet OTC deal
      // traces) are no longer anon-readable.
      const data = await signedFetch<{
        notifications: Notif[];
        resendConfigured: boolean;
      }>(conn.wallet, "/api/admin-config/read", "adminConfig.read", {
        scope: "notifications",
      });
      setRows(data.notifications ?? []);
      setResendReady(data.resendConfigured === true);
      setLoadError(null);
    } catch (err) {
      setRows(null);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const counts = useMemo(() => {
    if (!rows) return null;
    return {
      drafts: rows.filter((r) => r.status === "draft").length,
      scheduled: rows.filter((r) => r.status === "scheduled").length,
      sent: rows.filter((r) => r.status === "sent").length,
    };
  }, [rows]);

  return (
    <div className="mt-8 space-y-6">
      {counts && (
        <section className="grid gap-3 sm:grid-cols-3">
          <Kpi label="Drafts" value={String(counts.drafts)} />
          <Kpi label="Scheduled" value={String(counts.scheduled)} />
          <Kpi label="Sent (lifetime)" value={String(counts.sent)} />
        </section>
      )}

      {resendReady === false && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <p className="font-semibold text-amber-900">
            Resend not configured
          </p>
          <p className="mt-1 text-xs text-amber-900/90">
            Drafts and schedules are stored, but no email leaves Manci
            until you wire the Resend integration in{" "}
            <a href="/admin/integrations" className="underline">
              /admin/integrations
            </a>
            .
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setShowCompose(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + Compose broadcast
        </button>
      </div>

      {loadError !== null ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6">
          <p className="text-sm font-semibold text-red-900">
            Could not load broadcasts
          </p>
          <p className="mt-1 text-xs text-red-800">{loadError}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            Retry
          </button>
        </div>
      ) : rows === null ? (
        <SkeletonTable rows={4} cols={5} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            No broadcasts yet — compose one to start the timeline.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Subject</th>
                <th className="px-4 py-3 font-medium">Kind</th>
                <th className="px-4 py-3 font-medium">Audience</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Recipients</th>
                <th className="px-4 py-3 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="text-slate-700">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">{r.subject}</p>
                    <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">
                      {r.body.slice(0, 100)}
                      {r.body.length > 100 && "…"}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-xs">{r.kind}</td>
                  <td className="px-4 py-3 text-xs">
                    {AUDIENCE_LABEL[r.audience]}
                    {r.audience_param && (
                      <span className="ml-1 font-mono text-[11px] text-slate-500">
                        {r.audience_param}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[r.status]}`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {r.recipient_count}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {r.sent_at
                      ? `sent ${new Date(r.sent_at).toISOString().slice(0, 10)}`
                      : r.scheduled_for
                        ? `for ${new Date(r.scheduled_for).toISOString().slice(0, 16).replace("T", " ")}`
                        : `drafted ${new Date(r.created_at).toISOString().slice(0, 10)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCompose && (
        <ComposeModal
          onClose={() => setShowCompose(false)}
          onSuccess={() => {
            void refresh();
            setShowCompose(false);
          }}
        />
      )}

      <p className="text-xs text-slate-400">
        Open/click rate tracking arrives with the Resend webhook integration —
        the recipient_count column reflects the estimated audience size today.
      </p>
    </div>
  );
}

function ComposeModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>("both");
  const [audience, setAudience] = useState<Audience>("all");
  const [audienceParam, setAudienceParam] = useState("");
  const [template, setTemplate] = useState<string>("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [scheduled, setScheduled] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function applyTemplate(slug: string) {
    const t = TEMPLATES.find((x) => x.slug === slug);
    if (!t) return;
    setTemplate(t.slug);
    setSubject(t.subject);
    setBody(t.body);
  }

  async function save(asDraft: boolean) {
    if (!conn.wallet || !subject.trim() || !body.trim()) return;
    setSubmitting(true);
    try {
      const isScheduled = !asDraft && scheduled && Boolean(scheduledFor);
      // author is stamped server-side from the verified signer wallet.
      await signedFetch(
        conn.wallet,
        "/api/admin-config/notifications-create",
        "adminConfig.notificationsCreate",
        {
          kind,
          audience,
          audience_param:
            audience === "tag" || audience === "wallet"
              ? audienceParam.trim() || null
              : null,
          subject: subject.trim(),
          body,
          template: template || null,
          status: isScheduled ? "scheduled" : "draft",
          scheduled_for: isScheduled
            ? new Date(scheduledFor).toISOString()
            : null,
        },
      );
      toast.show({
        kind: "success",
        title: asDraft ? "Saved as draft" : "Scheduled",
      });
      onSuccess();
    } catch (err) {
      toast.showError(
        "Failed to save",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Compose broadcast
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          {/* Templates */}
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Start from template
            </span>
            <div className="mt-2 flex flex-wrap gap-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.slug}
                  type="button"
                  onClick={() => applyTemplate(t.slug)}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    template === t.slug
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Channel
              </span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as Kind)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                <option value="email">Email only</option>
                <option value="in-app">In-app banner only</option>
                <option value="both">Both</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Audience
              </span>
              <select
                value={audience}
                onChange={(e) => setAudience(e.target.value as Audience)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                {Object.entries(AUDIENCE_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            {(audience === "tag" || audience === "wallet") && (
              <label className="block sm:col-span-2">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {audience === "tag" ? "Tag value" : "Wallet address"}
                </span>
                <input
                  value={audienceParam}
                  onChange={(e) => setAudienceParam(e.target.value)}
                  placeholder={audience === "tag" ? "early-access" : "Solana address"}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </label>
            )}
          </div>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Subject
            </span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Body (use {"{"}{"{"}name{"}"}{"}"} etc. as merge tokens)
            </span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
            />
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={scheduled}
              onChange={(e) => setScheduled(e.target.checked)}
            />
            Schedule for later
          </label>
          {scheduled && (
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Send at
              </span>
              <input
                type="datetime-local"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save(true)}
            disabled={submitting || !subject.trim() || !body.trim()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:border-slate-400 disabled:opacity-50"
          >
            Save draft
          </button>
          <button
            type="button"
            onClick={() => void save(false)}
            disabled={
              submitting ||
              !subject.trim() ||
              !body.trim() ||
              (scheduled && !scheduledFor)
            }
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {scheduled ? "Schedule" : "Save & queue"}
          </button>
        </div>
      </div>
    </div>
  );
}
