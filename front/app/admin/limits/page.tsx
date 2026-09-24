"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { RequireRole } from "@/components/require-role";
import { adminGetRaiseLimits, adminUpdateRaiseLimits, type PlatformRaiseLimits } from "@/lib/launchpad";
import { useToast } from "@/lib/toast";
import { useRole } from "@/lib/auth";
import {
  listSaleReservations,
  readFxRates,
  revalueTreasuryMint,
  writeFxRate,
  type FxRate,
  type ReservationRow,
} from "@/lib/sale-approvals";
import { detectNetwork } from "@/lib/network";
import {
  MAINNET_MAX_RATE_AGE_DAYS,
  NOT_ALLOWED_ON_MAINNET,
  defaultPaymentMint,
  isAllowedPaymentMint,
  paymentMintLabel,
  requiredFxKind,
} from "@/lib/payment-mints";

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
        <AdoptedTreasuryMintsCard />
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
  const network = detectNetwork();
  const [rates, setRates] = useState<FxRate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The network's USDC is prefilled; it is a "rate" token everywhere.
  const [mint, setMint] = useState(() => defaultPaymentMint(network) ?? "");
  const [chosenKind, setKind] = useState<"eur_peg" | "rate">(() => (defaultPaymentMint(network) ? "rate" : "eur_peg"));
  const [rate, setRate] = useState("");
  const [source, setSource] = useState("");
  const [maxAge, setMaxAge] = useState(String(MAINNET_MAX_RATE_AGE_DAYS));
  const [saving, setSaving] = useState(false);
  // Mainnet (D18): only allowlisted mints, the kind the allowlist fixes, a
  // rate at most 7 days old. The server enforces the same rules.
  const typedMint = mint.trim();
  const mainnet = network === "mainnet";
  const fixedKind = mainnet ? requiredFxKind(network, typedMint) : null;
  const kind = fixedKind ?? chosenKind;
  const notAllowed = mainnet && typedMint.length > 0 && !isAllowedPaymentMint(network, typedMint);
  const maxAgeTooLong = mainnet && kind === "rate" && Number(maxAge) > MAINNET_MAX_RATE_AGE_DAYS;

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
    if (notAllowed) {
      setError(NOT_ALLOWED_ON_MAINNET);
      return;
    }
    if (maxAgeTooLong) {
      setError(`On mainnet a rate may be at most ${MAINNET_MAX_RATE_AGE_DAYS} days old.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      setRates(await writeFxRate(conn.wallet, {
        op: "upsert", payment_mint: typedMint, kind, source: source.trim(),
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
                <td className="py-1.5">
                  {paymentMintLabel(r.payment_mint, network)}{" "}
                  <span className="font-mono">{r.payment_mint.slice(0, 6)}…{r.payment_mint.slice(-4)}</span> ({r.decimals} dec.)
                </td>
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
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs" />
            {typedMint && !notAllowed && (
              <span className="mt-1 block text-[11px] text-slate-500">{paymentMintLabel(typedMint, network)}</span>
            )}
            {notAllowed && (
              <span className="mt-1 block text-[11px] text-red-700" role="alert">{NOT_ALLOWED_ON_MAINNET}</span>
            )}</label>
          <label className="text-xs text-slate-600">Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as "eur_peg" | "rate")} disabled={fixedKind !== null}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:bg-slate-50">
              <option value="eur_peg">EUR stablecoin (1:1)</option>
              <option value="rate">Other token (EUR rate)</option>
            </select>
            {fixedKind !== null && (
              <span className="mt-1 block text-[11px] text-slate-500">Fixed for this token on mainnet.</span>
            )}</label>
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
                  className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
                {mainnet && (
                  <span className={`mt-1 block text-[11px] ${maxAgeTooLong ? "text-red-700" : "text-slate-500"}`}>
                    At most {MAINNET_MAX_RATE_AGE_DAYS} days on mainnet; refresh the rate weekly.
                  </span>
                )}</label>
            </>
          )}
          <div className="sm:col-span-2">
            <button disabled={saving || notAllowed || maxAgeTooLong} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
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

/**
 * Treasury mints nobody reserved, counted by the ledger at their floor value
 * (0073 adopt_treasury_mint: at least EUR 1, else the units at the share
 * class's latest sale or approved price). The super admin re-values them
 * with a reason; the value can never go below the floor.
 */
function AdoptedTreasuryMintsCard() {
  const conn = useWalletConnection();
  const { isSuperAdmin } = useRole();
  const toast = useToast();
  const [rows, setRows] = useState<ReservationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!conn.wallet) return;
    try {
      setRows(await listSaleReservations(conn.wallet, { adopted_treasury: true }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the adopted treasury mints");
    }
  }, [conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function revalue(event: FormEvent) {
    event.preventDefault();
    const value = Number(amount);
    if (!editing || !Number.isFinite(value) || value <= 0 || reason.trim().length < 10) return;
    setSaving(true);
    try {
      const result = await revalueTreasuryMint(conn.wallet, editing, value, reason.trim());
      toast.show({
        kind: result.over_cap ? "error" : "success",
        title: "Treasury mint re-valued",
        description: `Now counted at €${Number(result.amount_eur).toLocaleString("en-US")}${result.over_cap ? " — the subject is OVER its raise limit" : ""}.`,
      });
      setEditing(null);
      setAmount("");
      setReason("");
      await load();
    } catch (e) {
      toast.showError("Re-valuation refused", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-6 max-w-3xl rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <p className="text-sm font-medium text-slate-800">Adopted treasury mints</p>
      <p className="mt-0.5 text-xs text-slate-500">
        Treasury mints that landed without a reservation are counted at their floor value so they are never left out
        of the raise limit. Re-value one when its real value is higher{isSuperAdmin ? "" : " (super admin only)"}.
      </p>
      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p>}
      {rows === null && !error ? (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      ) : rows && rows.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">None: every treasury mint was reserved before it landed.</p>
      ) : (
        <table className="mt-3 w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr><th className="py-1">Share class</th><th>Units</th><th>Counted</th><th>Subject</th><th>Booked</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            {(rows ?? []).map((r) => (
              <tr key={r.id}>
                <td className="py-1.5 font-mono">{r.share_class_pda.slice(0, 6)}…{r.share_class_pda.slice(-4)}</td>
                <td>{String(r.amount_units ?? "—")}</td>
                <td>€{Number(r.booked_amount_eur ?? r.amount_eur).toLocaleString("en-US")}</td>
                <td className="font-mono">{r.subject.length > 20 ? `${r.subject.slice(0, 14)}…` : r.subject}</td>
                <td>{String(r.booked_issued_at ?? r.created_at).slice(0, 10)}</td>
                <td className="text-right">
                  {isSuperAdmin && (
                    <button type="button" onClick={() => { setEditing(r.id); setAmount(String(r.booked_amount_eur ?? r.amount_eur)); }}
                      className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50">
                      Re-value
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && isSuperAdmin && (
        <form onSubmit={(e) => void revalue(e)} className="mt-4 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3">
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">New value (EUR)</span>
            <input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none" />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Reason (at least 10 characters)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none" />
          </label>
          <div className="flex justify-end gap-2 sm:col-span-3">
            <button type="button" onClick={() => setEditing(null)} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
            <button type="submit" disabled={saving || reason.trim().length < 10 || !(Number(amount) > 0)}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              {saving ? "Saving…" : "Re-value"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
