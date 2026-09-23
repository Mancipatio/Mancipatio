"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { RequireRole } from "@/components/require-role";
import { adminGetRaiseLimits, adminUpdateRaiseLimits, type PlatformRaiseLimits } from "@/lib/launchpad";
import { useToast } from "@/lib/toast";
import { useRole } from "@/lib/auth";
import { readFxRates, writeFxRate, type FxRate } from "@/lib/sale-approvals";

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
        <FxRatesCard />
      </RequireRole>
    </section>
  );
}

/**
 * EUR rates of the payment tokens sales may use (0066 fx_rates). A sale
 * approval reserves its maximum raise in EUR at the rate here, and the sale is
 * booked at that same locked rate. EUR stablecoins are pegged 1:1; any other
 * token needs a rate that is refused once older than its maximum age.
 * Admins read; only the Super Admin changes them.
 */
function FxRatesCard() {
  const conn = useWalletConnection();
  const { isSuperAdmin } = useRole();
  const toast = useToast();
  const [rates, setRates] = useState<FxRate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mint, setMint] = useState("");
  const [kind, setKind] = useState<"eur_peg" | "rate">("eur_peg");
  const [rate, setRate] = useState("");
  const [source, setSource] = useState("");
  const [maxAge, setMaxAge] = useState("7");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!conn.wallet) return;
    let cancelled = false;
    readFxRates(conn.wallet)
      .then((r) => { if (!cancelled) setRates(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the rates"); });
    return () => { cancelled = true; };
  }, [conn.wallet]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      setRates(await writeFxRate(conn.wallet, {
        op: "upsert", payment_mint: mint.trim(), kind, source: source.trim(),
        ...(kind === "rate" ? { eur_per_token: rate.trim(), max_age_days: Number(maxAge) } : {}),
      }));
      toast.show({ kind: "success", title: "EUR rate saved" });
      setMint(""); setRate(""); setSource("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the rate");
    } finally {
      setSaving(false);
    }
  }

  async function remove(paymentMint: string) {
    try {
      setRates(await writeFxRate(conn.wallet, { op: "delete", payment_mint: paymentMint }));
      toast.show({ kind: "success", title: "EUR rate removed" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the rate");
    }
  }

  return (
    <div className="mt-6 max-w-3xl rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <p className="text-sm font-medium text-slate-800">Payment tokens and EUR rates</p>
      <p className="mt-0.5 text-xs text-slate-500">
        Sale approvals count their maximum raise in EUR at these rates against the rolling 12-month limit (per SPV,
        or per issuer without one), and closed sales are booked at the rate locked when they were approved.
      </p>
      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p>}
      {rates === null && !error ? (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      ) : rates && rates.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No payment token configured: no sale can be approved yet.</p>
      ) : (
        <table className="mt-3 w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr><th className="py-1">Mint</th><th>Rate</th><th>Source</th><th>As of</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            {(rates ?? []).map((r) => (
              <tr key={r.payment_mint}>
                <td className="py-1.5 font-mono">{r.payment_mint.slice(0, 6)}…{r.payment_mint.slice(-4)} ({r.decimals} dec.)</td>
                <td>{r.kind === "eur_peg" ? "EUR 1:1" : `${Number(r.eur_per_token)} EUR · max age ${r.max_age}`}</td>
                <td>{r.source}</td>
                <td>{new Date(r.as_of).toLocaleString("en-GB")}</td>
                <td className="text-right">
                  {isSuperAdmin && (
                    <button type="button" onClick={() => void remove(r.payment_mint)} className="text-red-700 hover:underline">
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {isSuperAdmin && (
        <form onSubmit={(e) => void save(e)} className="mt-5 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
          <label className="text-xs text-slate-600 sm:col-span-2">Payment mint
            <input value={mint} onChange={(e) => setMint(e.target.value)} required
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs" /></label>
          <label className="text-xs text-slate-600">Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as "eur_peg" | "rate")}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm">
              <option value="eur_peg">EUR stablecoin (1:1)</option>
              <option value="rate">Other token (EUR rate)</option>
            </select></label>
          <label className="text-xs text-slate-600">Source
            <input value={source} onChange={(e) => setSource(e.target.value)} required maxLength={200}
              placeholder="e.g. ECB reference rate" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" /></label>
          {kind === "rate" && (
            <>
              <label className="text-xs text-slate-600">EUR per whole token
                <input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" required
                  className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" /></label>
              <label className="text-xs text-slate-600">Maximum age (days)
                <input value={maxAge} onChange={(e) => setMaxAge(e.target.value.replace(/\D/g, ""))} inputMode="numeric"
                  className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" /></label>
            </>
          )}
          <div className="sm:col-span-2">
            <button disabled={saving} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              {saving ? "Saving…" : "Save rate"}
            </button>
            <span className="ml-3 text-xs text-slate-500">Decimals are read from the mint on-chain.</span>
          </div>
        </form>
      )}
    </div>
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
