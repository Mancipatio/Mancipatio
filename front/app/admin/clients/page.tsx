"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useWalletConnection } from "@solana/react-hooks";
import {
  IconBuilding,
  IconCheck,
  IconUsers,
  IconWallet,
  IconWarning,
} from "@/components/icons";
import { Kpi } from "@/components/kpi";
import { RequireRole } from "@/components/require-role";
import { useRole } from "@/lib/auth";
import { explainRoleRefusal } from "@/lib/role-resolution";
import { SkeletonTable } from "@/components/skeleton";
import {
  createClient as createClientRow,
  listClientDirectory,
  type ClientKycStatus,
  type ClientRow,
  type ClientType,
} from "@/lib/clients";
import type { ClientReviewReason } from "@/lib/admin-badge-rules";
import { COUNTRIES, countryName } from "@/lib/countries";
import { useToast } from "@/lib/toast";

const TYPE_LABEL: Record<ClientType, string> = {
  issuer: "Issuer",
  investor: "Investor",
  delegate: "Delegate",
  officer: "Officer",
};

const TYPE_BADGE: Record<ClientType, string> = {
  issuer: "bg-brand-50 text-brand-700 border-brand-200",
  investor: "bg-emerald-50 text-emerald-700 border-emerald-200",
  delegate: "bg-brand-50 text-brand-700 border-brand-200",
  officer: "bg-amber-50 text-amber-700 border-amber-200",
};

/** Why a dossier is in "Needs review" (the same reasons as the Clients menu count). */
const REVIEW_LABEL: Record<ClientReviewReason, string> = {
  documents: "documents to check",
  final: "ready for the KYC decision",
  kyb: "KYB decision",
};

// "needs_review": dossiers with a reviewer step — the Clients menu count.
type KycFilter = ClientKycStatus | "all" | "needs_review";

const KYC_FILTERS: readonly KycFilter[] = [
  "needs_review", "all", "pending", "more_info", "verified", "rejected", "suspended",
];

const KYC_FILTER_LABEL: Record<Exclude<KycFilter, "needs_review">, string> = {
  all: "All",
  pending: "Pending",
  more_info: "More info",
  verified: "Verified",
  rejected: "Rejected",
  suspended: "Suspended",
  expired: "Expired",
};

const KYC_BADGE: Record<ClientKycStatus, string> = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  verified: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
  suspended: "bg-slate-300 text-slate-700 border-slate-400",
  expired: "bg-orange-100 text-orange-700 border-orange-200",
  more_info: "bg-brand-100 text-brand-800 border-brand-200",
};

export default function ClientsPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="page-eyebrow">Clients</p>
        <h1 className="page-title">KYC&apos;d clients directory</h1>
        <p className="page-sub">
          Every issuer, investor, delegate and officer onboarded on Manci.
          Add new clients manually or wait for them to complete self-service
          onboarding.
        </p>
      </div>
      {/* Admins and the KYC provider (Talas 3.1 K6). Creating a client stays
          admin-only (/api/clients/create is requireAdmin). */}
      <RequireRole anyOf={["admin", "kycProvider"]}>
        {/* useSearchParams needs a Suspense boundary for the static build. */}
        <Suspense fallback={null}>
          <ClientsOps />
        </Suspense>
      </RequireRole>
    </section>
  );
}

function ClientsOps() {
  const conn = useWalletConnection();
  const { isAdmin } = useRole({ kyc: true });
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  // False when the server could not read the review reasons (tab disabled).
  const [reviewAvailable, setReviewAvailable] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  // `?q=` seeds the search — the custody page links here by wallet to issue
  // a holder's passport (2C-3).
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [typeFilter, setTypeFilter] = useState<ClientType | "all">("all");
  const [kycFilter, setKycFilter] = useState<KycFilter>("all");
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(async () => {
    if (!conn.wallet) return;
    try {
      const data = await listClientDirectory(conn.wallet);
      setRows(data.clients);
      setReviewAvailable(data.reviewAvailable);
      setFailed(null);
    } catch (err) {
      setFailed(explainRoleRefusal(err instanceof Error ? err.message : String(err)));
    }
  }, [conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (
        typeFilter !== "all" &&
        !(r.types?.length ? r.types : [r.type]).includes(typeFilter)
      )
        return false;
      if (kycFilter === "needs_review") {
        if (!r.review_reasons?.length) return false;
      } else if (kycFilter !== "all" && r.kyc_status !== kycFilter) return false;
      if (!q) return true;
      return (
        r.display_name.toLowerCase().includes(q) ||
        (r.email ?? "").toLowerCase().includes(q) ||
        (r.company_name ?? "").toLowerCase().includes(q) ||
        (r.wallet ?? "").toLowerCase().includes(q) ||
        (r.jurisdiction ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, typeFilter, kycFilter]);

  const counts = useMemo(() => {
    if (!rows) return null;
    return {
      total: rows.length,
      issuers: rows.filter((r) => r.type === "issuer").length,
      investors: rows.filter((r) => r.type === "investor").length,
      verified: rows.filter((r) => r.kyc_status === "verified").length,
      pending: rows.filter((r) => r.kyc_status === "pending").length,
      needsReview: rows.filter((r) => (r.review_reasons?.length ?? 0) > 0).length,
    };
  }, [rows]);

  if (failed) {
    return (
      <p className="mt-8 text-sm text-red-600">{failed}</p>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      {/* KPIs */}
      {counts && (
        <div className="grid gap-3 sm:grid-cols-5">
          <Kpi label="Total" value={String(counts.total)} icon={<IconUsers />} />
          <Kpi
            label="Issuers"
            value={String(counts.issuers)}
            icon={<IconBuilding />}
          />
          <Kpi
            label="Investors"
            value={String(counts.investors)}
            icon={<IconWallet />}
          />
          <Kpi
            label="Verified"
            value={String(counts.verified)}
            icon={<IconCheck />}
            tone="good"
          />
          <Kpi
            label="Pending"
            value={String(counts.pending)}
            icon={<IconWarning />}
            tone={counts.pending > 0 ? "warn" : "quiet"}
          />
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, email, wallet, jurisdiction…"
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as ClientType | "all")}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
        >
          <option value="all">All types</option>
          <option value="issuer">Issuer</option>
          <option value="investor">Investor</option>
          <option value="delegate">Delegate</option>
          <option value="officer">Officer</option>
        </select>
        <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {KYC_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setKycFilter(s)}
              disabled={s === "needs_review" && !reviewAvailable}
              title={
                s === "needs_review"
                  ? reviewAvailable
                    ? "Dossiers with a reviewer step: documents to check, a KYC decision (every document approved) or a KYB decision — the Clients menu count"
                    : "The review queue could not be read — reload to try again"
                  : undefined
              }
              className={`rounded-md px-3 py-1.5 transition-colors disabled:opacity-50 ${
                kycFilter === s
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {s === "needs_review"
                ? `Needs review${counts && reviewAvailable ? ` (${counts.needsReview})` : ""}`
                : KYC_FILTER_LABEL[s]}
            </button>
          ))}
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Add client
          </button>
        )}
      </div>

      {rows === null ? (
        <SkeletonTable rows={5} cols={6} />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {rows.length === 0
              ? "No clients yet — admin-side onboarding starts with the + Add button."
              : "No clients match the current filter."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Wallet</th>
                <th className="px-4 py-3 font-medium">Jurisdiction</th>
                <th className="px-4 py-3 font-medium">KYC</th>
                <th className="px-4 py-3 font-medium">Onboarding</th>
                <th className="px-4 py-3 font-medium">ToS</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((r) => (
                <tr key={r.id} className="text-slate-700">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">
                      {r.display_name || "(unnamed)"}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {r.email ?? "—"}
                      {r.company_name && ` · ${r.company_name}`}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap gap-1">
                      {(r.types?.length ? r.types : [r.type]).map((t) => (
                        <span
                          key={t}
                          className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TYPE_BADGE[t]}`}
                        >
                          {TYPE_LABEL[t]}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-slate-500">
                    {r.wallet
                      ? `${r.wallet.slice(0, 6)}…${r.wallet.slice(-4)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {countryName(r.jurisdiction)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${KYC_BADGE[r.kyc_status]}`}
                    >
                      {r.kyc_status}
                    </span>
                    {r.review_reasons && r.review_reasons.length > 0 && (
                      <p className="mt-1 text-[11px] text-amber-700">
                        Review: {r.review_reasons.map((reason) => REVIEW_LABEL[reason]).join(" · ")}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {r.onboarding_status}
                  </td>
                  <td className="px-4 py-3">
                    {r.tos_accepted_at ? (
                      <span
                        title={`ToS v${r.tos_version ?? "?"} accepted ${new Date(r.tos_accepted_at).toISOString().slice(0, 10)}`}
                        className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"
                      >
                        ✓
                      </span>
                    ) : (
                      <span
                        title="Terms of Service not accepted"
                        className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700"
                      >
                        —
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/clients/${r.id}`}
                      className="text-xs text-slate-600 underline-offset-2 hover:underline"
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && isAdmin && (
        <AddClientModal
          onClose={() => setShowAdd(false)}
          onSuccess={() => {
            void refresh();
            setShowAdd(false);
          }}
        />
      )}
    </div>
  );
}

function AddClientModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const toast = useToast();
  const conn = useWalletConnection();
  const [types, setTypes] = useState<ClientType[]>(["investor"]);
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [jurisdiction, setJurisdiction] = useState("688");
  const [tier, setTier] = useState("starter");
  const [wallet, setWallet] = useState("");
  const [walletErr, setWalletErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [createdWallet, setCreatedWallet] = useState<string | null>(null);

  async function submit() {
    if (!displayName.trim() || types.length === 0) return;
    const walletTrim = wallet.trim();
    if (walletTrim && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletTrim)) {
      setWalletErr("Not a valid base58 pubkey");
      return;
    }
    setWalletErr(null);
    setSubmitting(true);
    try {
      const row = await createClientRow(conn.wallet, {
        types,
        display_name: displayName.trim(),
        company_name: companyName.trim() || undefined,
        email: email.trim() || undefined,
        jurisdiction: jurisdiction.trim() || undefined,
        tier,
        wallet: walletTrim || undefined,
      });
      if (!row) throw new Error("Insert returned no row");
      setCreatedToken(row.onboarding_token);
      setCreatedId(row.id);
      setCreatedWallet(row.wallet);
      toast.show({
        kind: "success",
        title: "Client created",
        description: `${row.display_name} added as ${types.join(", ")}.`,
      });
      onSuccess();
    } catch (err) {
      toast.showError(
        "Failed to add client",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const inviteLink =
    createdToken && createdId
      ? `${typeof window !== "undefined" ? window.location.origin : "https://www.manci.io"}/onboarding/${createdId}?t=${createdToken}`
      : null;
  // After-create success view shows up either when we have an invite link
  // (no wallet supplied) or a pre-linked wallet (skipping the magic-link).
  const createdSuccess = !!createdId && (inviteLink || createdWallet);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Add client
          </p>
        </div>

        {!createdSuccess ? (
          <>
            <div className="space-y-4 px-5 py-4">
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Client type (one or more)
                </span>
                <div className="mt-2 flex gap-2">
                  {(
                    ["investor", "issuer", "delegate", "officer"] as ClientType[]
                  ).map((t) => {
                    const active = types.includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() =>
                          setTypes((prev) =>
                            prev.includes(t)
                              ? prev.filter((x) => x !== t)
                              : [...prev, t],
                          )
                        }
                        aria-pressed={active}
                        className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                          active
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                        }`}
                      >
                        {TYPE_LABEL[t]}
                      </button>
                    );
                  })}
                </div>
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Display name *
                  </span>
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={types.includes("issuer") ? "ACME Industries" : "Petar Petrović"}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Email
                  </span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="founders@acme.io"
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                  />
                </label>
                {(types.includes("issuer") || types.includes("officer")) && (
                  <label className="block sm:col-span-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      Company name
                    </span>
                    <input
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                    />
                  </label>
                )}
                <label className="block">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Country
                  </span>
                  <select
                    value={jurisdiction}
                    onChange={(e) => setJurisdiction(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                  >
                    <option value="">Select a country…</option>
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Tier
                  </span>
                  <select
                    value={tier}
                    onChange={(e) => setTier(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                  >
                    <option value="starter">Starter</option>
                    <option value="pro">Pro</option>
                    <option value="enterprise">Enterprise</option>
                  </select>
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Wallet (optional — base58 pubkey)
                  </span>
                  <input
                    value={wallet}
                    onChange={(e) => {
                      setWallet(e.target.value);
                      if (walletErr) setWalletErr(null);
                    }}
                    placeholder="Skip to issue a magic-link instead"
                    aria-invalid={!!walletErr}
                    className={`mt-1 w-full rounded-md border px-3 py-2 font-mono text-xs focus:outline-none ${
                      walletErr
                        ? "border-red-400 focus:border-red-500"
                        : "border-slate-300 focus:border-slate-400"
                    }`}
                  />
                  {walletErr && (
                    <p className="mt-1 text-[11px] text-red-700">{walletErr}</p>
                  )}
                </label>
              </div>

              <p className="text-[11px] text-slate-400">
                {wallet.trim()
                  ? "Wallet is supplied — the client will be linked immediately, no magic-link needed."
                  : "No wallet supplied — a magic-link is generated; the client connects their wallet on the onboarding page."}
              </p>
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
                onClick={() => void submit()}
                disabled={submitting || !displayName.trim() || !conn.wallet}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {submitting ? "Saving…" : "Create client"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-4 px-5 py-4">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-sm font-semibold text-emerald-900">
                  ✓ Client created
                </p>
                <p className="mt-1 text-xs text-emerald-900/90">
                  {createdWallet
                    ? "Wallet linked directly — KYC review can start immediately."
                    : "Share this magic-link with the client. They open it, connect a Solana wallet, and onboarding is completed on their end."}
                </p>
              </div>
              {createdWallet ? (
                <label className="block">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Linked wallet
                  </span>
                  <input
                    readOnly
                    value={createdWallet}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700"
                  />
                  <p className="mt-2 text-[11px] text-slate-400">
                    No magic-link needed. Onboarding status starts at
                    &quot;connected&quot;.
                  </p>
                </label>
              ) : inviteLink ? (
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Magic-link
                </span>
                <div className="mt-1 flex gap-2">
                  <input
                    readOnly
                    value={inviteLink}
                    className="w-full rounded-md border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(inviteLink);
                      toast.show({ kind: "info", title: "Copied", duration: 2000 });
                    }}
                    className="rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700 hover:border-slate-400"
                  >
                    Copy
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-slate-400">
                  The client opens this link, connects a Solana wallet and
                  finishes onboarding on their side.
                </p>
              </label>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
              <Link
                href={`/admin/clients/${createdId}`}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:border-slate-400"
              >
                Open detail →
              </Link>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
