"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { RequireRole } from "@/components/require-role";
import { adminGetRaiseLimits, adminUpdateRaiseLimits, type PlatformRaiseLimits } from "@/lib/launchpad";
import { useToast } from "@/lib/toast";

export default function RaiseLimitsPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Raise limits</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Application limits</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Platform defaults for /apply, adjustable when the law changes. The annual cap counts every live
          application (pending, changes requested, approved) of one person across all wallets linked to their
          account, per calendar year. Individual clients can get their own limits on their client page, and
          single applications can be adjusted in Applications.
        </p>
      </div>
      <RequireRole role="admin">
        <LimitsForm />
      </RequireRole>
    </section>
  );
}

function LimitsForm() {
  const conn = useWalletConnection();
  const toast = useToast();
  const [limits, setLimits] = useState<PlatformRaiseLimits | null>(null);
  const [cap, setCap] = useState("");
  const [equity, setEquity] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conn.wallet) return;
    let cancelled = false;
    adminGetRaiseLimits(conn.wallet).then((l) => {
      if (cancelled) return;
      setLimits(l);
      setCap(String(Number(l.annual_raise_cap_eur)));
      setEquity(String(Number(l.max_equity_percent)));
    }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the limits"); });
    return () => { cancelled = true; };
  }, [conn.wallet]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const capValue = Number(cap.replace(/[^\d.]/g, ""));
    const equityValue = Number(equity);
    if (!Number.isFinite(capValue) || capValue <= 0 || !Number.isFinite(equityValue) || equityValue <= 0 || equityValue > 100) {
      setError("Enter a positive EUR amount and an equity percentage between 0 and 100.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await adminUpdateRaiseLimits(conn.wallet, { annual_raise_cap_eur: capValue, max_equity_percent: equityValue });
      setLimits(saved);
      toast.show({ kind: "success", title: "Raise limits saved" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the limits");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} className="mt-6 max-w-xl rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      {error && <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p>}
      {!limits && !error ? <p className="text-sm text-slate-500">Loading…</p> : (
        <>
          <label className="block text-sm font-medium text-slate-800" htmlFor="cap">Annual raise cap per applicant (EUR)</label>
          <p className="mt-0.5 text-xs text-slate-500">Maximum total raised per person per calendar year. Legal default: €3,000,000.</p>
          <input id="cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} required
            className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <label className="mt-5 block text-sm font-medium text-slate-800" htmlFor="equity">Maximum equity offered per application (%)</label>
          <p className="mt-0.5 text-xs text-slate-500">Upper bound of the equity slider on /apply.</p>
          <input id="equity" inputMode="decimal" value={equity} onChange={(e) => setEquity(e.target.value)} required
            className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <div className="mt-6 flex items-center gap-3">
            <button disabled={saving} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              {saving ? "Saving…" : "Save limits"}
            </button>
            {limits?.updated_at && <span className="text-xs text-slate-500">Last changed {new Date(limits.updated_at).toLocaleString("en-GB")}</span>}
          </div>
        </>
      )}
    </form>
  );
}
