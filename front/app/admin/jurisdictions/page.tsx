"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { RequireRole } from "@/components/require-role";
import { SkeletonTable } from "@/components/skeleton";
import { useRole } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { signedFetch } from "@/lib/siws-client";
import { useToast } from "@/lib/toast";
import { CATEGORY_SLUGS, assetTypeBySlug } from "@/lib/asset-types";

import { Kpi } from "@/components/kpi";
type KycLevel = "none" | "basic" | "enhanced" | "kyb";
type RiskTier = "low" | "medium" | "high" | "prohibited";

type Jurisdiction = {
  code: string;
  name: string;
  alpha2: string | null;
  region: string | null;
  enabled_sale: boolean;
  enabled_otc: boolean;
  enabled_claim: boolean;
  kyc_level: KycLevel;
  risk_tier: RiskTier;
  allowed_asset_types: string[];
  notes: string;
};

const RISK_BADGE: Record<RiskTier, string> = {
  low: "bg-emerald-100 text-emerald-800 border-emerald-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  high: "bg-orange-100 text-orange-700 border-orange-200",
  prohibited: "bg-red-100 text-red-800 border-red-200",
};

const KYC_LABEL: Record<KycLevel, string> = {
  none: "None",
  basic: "Basic",
  enhanced: "Enhanced",
  kyb: "KYB",
};

/** Human label for an asset-type slug, falling back to the raw slug. */
function assetTypeLabel(slug: string): string {
  return assetTypeBySlug(slug)?.title ?? slug;
}

type Tab = "all" | "enabled" | "high-risk" | "prohibited";

export default function JurisdictionsPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Jurisdictions
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Geo-compliance config
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          One row per ISO-3166 jurisdiction. Toggle sale / OTC / claim
          availability and set the per-jurisdiction KYC level and risk tier.
        </p>
      </div>
      <RequireRole role="admin">
        <JurisdictionsOps />
      </RequireRole>
    </section>
  );
}

function JurisdictionsOps() {
  const conn = useWalletConnection();
  const { isSuperAdmin } = useRole();
  const toast = useToast();
  const [rows, setRows] = useState<Jurisdiction[] | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<Jurisdiction | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    const { data, error } = await sb
      .from("jurisdictions")
      .select("*")
      .order("name", { ascending: true });
    if (!error) setRows((data ?? []) as Jurisdiction[]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const counts = useMemo(() => {
    if (!rows) return null;
    return {
      total: rows.length,
      enabled: rows.filter(
        (r) => r.enabled_sale && r.enabled_otc && r.enabled_claim,
      ).length,
      highRisk: rows.filter((r) => r.risk_tier === "high").length,
      prohibited: rows.filter((r) => r.risk_tier === "prohibited").length,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab === "enabled") {
        if (!(r.enabled_sale && r.enabled_otc && r.enabled_claim)) return false;
      }
      if (tab === "high-risk" && r.risk_tier !== "high") return false;
      if (tab === "prohibited" && r.risk_tier !== "prohibited") return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.code.includes(q) ||
        (r.alpha2 ?? "").toLowerCase().includes(q) ||
        (r.region ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, tab, query]);

  async function patch(code: string, patch: Partial<Jurisdiction>) {
    try {
      await signedFetch(
        conn.wallet,
        "/api/admin-config/jurisdictions-upsert",
        "adminConfig.jurisdictionsUpsert",
        { mode: "update", code, row: patch },
      );
    } catch (err) {
      toast.showError(
        "Update failed",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    await refresh();
  }

  return (
    <div className="mt-8 space-y-6">
      {counts && (
        <section className="grid gap-3 sm:grid-cols-4">
          <Kpi label="Total" value={String(counts.total)} />
          <Kpi label="Fully enabled" value={String(counts.enabled)} />
          <Kpi label="High risk" value={String(counts.highRisk)} tone={counts.highRisk > 0 ? "warn" : "default"} />
          <Kpi label="Prohibited" value={String(counts.prohibited)} tone={counts.prohibited > 0 ? "warn" : "default"} />
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, ISO code, region…"
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(["all", "enabled", "high-risk", "prohibited"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                tab === t
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {t === "all"
                ? "All"
                : t === "enabled"
                  ? "Enabled"
                  : t === "high-risk"
                    ? "High risk"
                    : "Prohibited"}
            </button>
          ))}
        </div>
        {isSuperAdmin && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Add
          </button>
        )}
      </div>

      {rows === null ? (
        <SkeletonTable rows={6} cols={8} />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">No jurisdictions match.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Jurisdiction</th>
                <th className="px-4 py-3 font-medium">KYC</th>
                <th className="px-4 py-3 font-medium">Risk</th>
                <th className="px-4 py-3 font-medium">Categories</th>
                <th className="px-4 py-3 text-center font-medium">Sale</th>
                <th className="px-4 py-3 text-center font-medium">OTC</th>
                <th className="px-4 py-3 text-center font-medium">Claim</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((r) => (
                <tr key={r.code} className="text-slate-700">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">{r.name}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {r.alpha2 ?? "?"} · {r.code} · {r.region ?? "—"}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-xs">{KYC_LABEL[r.kyc_level]}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${RISK_BADGE[r.risk_tier]}`}
                    >
                      {r.risk_tier}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {!r.allowed_asset_types || r.allowed_asset_types.length === 0 ? (
                      <span className="text-xs text-slate-500">All</span>
                    ) : (
                      <div className="flex max-w-[260px] flex-wrap gap-1">
                        {r.allowed_asset_types.map((slug) => (
                          <span
                            key={slug}
                            className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600"
                          >
                            {assetTypeLabel(slug)}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <Toggle
                    on={r.enabled_sale}
                    disabled={!isSuperAdmin || r.risk_tier === "prohibited"}
                    onToggle={() =>
                      void patch(r.code, { enabled_sale: !r.enabled_sale })
                    }
                  />
                  <Toggle
                    on={r.enabled_otc}
                    disabled={!isSuperAdmin || r.risk_tier === "prohibited"}
                    onToggle={() =>
                      void patch(r.code, { enabled_otc: !r.enabled_otc })
                    }
                  />
                  <Toggle
                    on={r.enabled_claim}
                    disabled={!isSuperAdmin || r.risk_tier === "prohibited"}
                    onToggle={() =>
                      void patch(r.code, { enabled_claim: !r.enabled_claim })
                    }
                  />
                  <td className="px-4 py-3 text-right text-xs">
                    {isSuperAdmin && (
                      <button
                        type="button"
                        onClick={() => setEdit(r)}
                        className="text-slate-600 underline-offset-2 hover:underline"
                      >
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {edit && (
        <EditModal
          row={edit}
          onClose={() => setEdit(null)}
          onSuccess={() => {
            void refresh();
            setEdit(null);
          }}
        />
      )}

      {showAdd && (
        <EditModal
          row={null}
          onClose={() => setShowAdd(false)}
          onSuccess={() => {
            void refresh();
            setShowAdd(false);
          }}
        />
      )}

      <p className="text-xs text-slate-400">
        Per-jurisdiction enforcement at instruction-call time arrives once the
        UI calls the geo-check before each fee-bearing or sale-bearing
        instruction. Today these flags drive UI gating and the Compliance
        report.
      </p>
    </div>
  );
}

function Toggle({
  on,
  disabled,
  onToggle,
}: {
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <td className="px-4 py-3 text-center">
      <button
        type="button"
        disabled={disabled}
        onClick={onToggle}
        className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          on ? "bg-emerald-500" : "bg-slate-300"
        } ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            on ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </td>
  );
}

function EditModal({
  row,
  onClose,
  onSuccess,
}: {
  row: Jurisdiction | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const isAdd = row === null;
  const [code, setCode] = useState(row?.code ?? "");
  const [name, setName] = useState(row?.name ?? "");
  const [alpha2, setAlpha2] = useState(row?.alpha2 ?? "");
  const [region, setRegion] = useState(row?.region ?? "");
  const [kycLevel, setKycLevel] = useState<KycLevel>(row?.kyc_level ?? "basic");
  const [riskTier, setRiskTier] = useState<RiskTier>(row?.risk_tier ?? "medium");
  const [allowedTypes, setAllowedTypes] = useState<string[]>(
    row?.allowed_asset_types ?? [],
  );
  const [notes, setNotes] = useState(row?.notes ?? "");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!code.trim() || !name.trim()) return;
    setSubmitting(true);
    try {
      // enabled_sale/otc/claim are derived server-side on insert (prohibited
      // => everything disabled) and forced off when risk_tier is prohibited.
      await signedFetch(
        conn.wallet,
        "/api/admin-config/jurisdictions-upsert",
        "adminConfig.jurisdictionsUpsert",
        {
          mode: isAdd ? "insert" : "update",
          code: code.trim(),
          row: {
            name: name.trim(),
            alpha2: alpha2.trim() || null,
            region: region.trim() || null,
            kyc_level: kycLevel,
            risk_tier: riskTier,
            allowed_asset_types: allowedTypes,
            notes,
          },
        },
      );
      toast.show({ kind: "success", title: isAdd ? "Added" : "Saved" });
      onSuccess();
    } catch (err) {
      toast.showError(
        "Save failed",
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
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            {isAdd ? "Add jurisdiction" : `Edit ${row.name}`}
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                ISO-3166 numeric code
              </span>
              <input
                value={code}
                disabled={!isAdd}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="688"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none disabled:bg-slate-100"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Alpha-2
              </span>
              <input
                value={alpha2}
                onChange={(e) => setAlpha2(e.target.value.toUpperCase())}
                placeholder="RS"
                maxLength={2}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm uppercase focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Name
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Region
              </span>
              <input
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="Europe / Asia / …"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                KYC level
              </span>
              <select
                value={kycLevel}
                onChange={(e) => setKycLevel(e.target.value as KycLevel)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                <option value="none">None</option>
                <option value="basic">Basic</option>
                <option value="enhanced">Enhanced</option>
                <option value="kyb">KYB</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Risk tier
              </span>
              <select
                value={riskTier}
                onChange={(e) => setRiskTier(e.target.value as RiskTier)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="prohibited">Prohibited</option>
              </select>
            </label>
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Allowed asset categories
              </span>
              {allowedTypes.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAllowedTypes([])}
                  className="text-[11px] text-slate-500 underline-offset-2 hover:underline"
                >
                  Clear (allow all)
                </button>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {CATEGORY_SLUGS.map((slug) => {
                const active = allowedTypes.includes(slug);
                return (
                  <button
                    key={slug}
                    type="button"
                    onClick={() =>
                      setAllowedTypes((prev) =>
                        prev.includes(slug)
                          ? prev.filter((x) => x !== slug)
                          : [...prev, slug],
                      )
                    }
                    aria-pressed={active}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                    }`}
                  >
                    {assetTypeLabel(slug)}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              {allowedTypes.length === 0
                ? "No restriction — every asset category is allowed in this jurisdiction."
                : "Only the selected categories may be offered in this jurisdiction."}
            </p>
          </div>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Notes
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
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
            disabled={submitting || !code.trim() || !name.trim()}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting ? "Saving…" : isAdd ? "Add" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
