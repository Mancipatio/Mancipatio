"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { Kpi } from "@/components/kpi";
import { signedFetch } from "@/lib/siws-client";
import type { AccountDirectory } from "@/lib/admin-accounts";

const METHOD_LABEL = { wallet: "Wallet", google: "Google", email: "Email" };
const STATUS_LABEL: Record<string, string> = {
  pending: "In review", more_info: "Changes requested", verified: "KYC verified",
  rejected: "Rejected", suspended: "Suspended", expired: "Expired",
};

/** Shared overview counts and the full, paginated account directory. */
export function AccountsPanel({ compact = false }: { compact?: boolean }) {
  const conn = useWalletConnection();
  const [data, setData] = useState<AccountDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({ query: "", page: 1, method: "all", verification: "all" });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    // The previous wallet's directory must leave the page immediately.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData(null);
    setError(null);
    if (!conn.wallet) { setLoading(false); return; }
    setLoading(true);
    void signedFetch<AccountDirectory>(conn.wallet, "/api/admin/accounts", "admin.accountsList", { ...filters, summary_only: compact })
      .then((result) => { if (current) setData(result); })
      .catch((err: unknown) => { if (current) setError(err instanceof Error ? err.message : "Could not load accounts."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [conn.wallet, compact, filters, revision]);

  return (
    <div className="space-y-4">
      {compact && <div className="flex items-center justify-between gap-3">
        <h2 className="page-eyebrow">Platform accounts</h2>
        <Link href="/admin/accounts" className="text-sm font-medium text-brand-700 hover:underline">View all accounts →</Link>
      </div>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-busy={loading}>
        <Kpi label="Registered accounts" value={data?.summary.total.toLocaleString() ?? "—"} />
        <Kpi label="Wallet linked" value={data?.summary.wallet.toLocaleString() ?? "—"} />
        <Kpi label="Google linked" value={data?.summary.google.toLocaleString() ?? "—"} />
        <Kpi label="Verified email" value={data?.summary.email.toLocaleString() ?? "—"} />
        <Kpi label="Before KYC / KYB" value={data?.summary.without_verification.toLocaleString() ?? "—"} sub="No verification dossier yet" />
      </div>
      <p className="text-xs leading-relaxed text-slate-500">
        Includes accounts before KYC / KYB. Each account is counted once; linked sign-in methods can overlap.
        A wallet connection is recorded after signed authentication. These are account totals, not live sessions or unique people.
      </p>
      {error && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-700">
        <p>{error}</p><button type="button" className="underline" onClick={() => setRevision((value) => value + 1)}>Try again</button>
      </div>}
      {!compact && <>
        <form className="flex flex-wrap items-center gap-3" onSubmit={(event) => { event.preventDefault(); setFilters((value) => ({ ...value, query: query.trim(), page: 1 })); }}>
          <label className="min-w-0 flex-1 basis-64">
            <span className="sr-only">Search accounts by name, email, wallet or account ID</span>
            <input type="search" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email, wallet or account ID…"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <select aria-label="Linked sign-in method" value={filters.method} onChange={(event) => setFilters((value) => ({ ...value, method: event.target.value, page: 1 }))}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="all">All sign-in methods</option><option value="wallet">Wallet linked</option><option value="google">Google linked</option><option value="email">Verified email</option>
          </select>
          <select aria-label="Verification dossier" value={filters.verification} onChange={(event) => setFilters((value) => ({ ...value, verification: event.target.value, page: 1 }))}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="all">All verification stages</option><option value="none">Before KYC / KYB</option><option value="started">With a verification dossier</option>
          </select>
          <button type="submit" className="btn btn-sm btn-outline">Search</button>
          <button type="button" disabled={loading} className="btn btn-sm btn-outline" onClick={() => setRevision((value) => value + 1)}>Refresh</button>
        </form>
        {loading && <p className="text-sm text-slate-500" role="status">Loading accounts…</p>}
        {data && <>
          <p className="text-sm text-slate-500">{data.filtered_total.toLocaleString()} matching accounts · {data.network}</p>
          {data.accounts.length === 0 ? <div className="panel panel-pad text-sm text-slate-500">No accounts match these filters.</div> :
            <div className="panel overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500"><tr>
                  <th className="px-4 py-3">Account</th><th className="px-4 py-3">Linked methods</th><th className="px-4 py-3">Wallets</th><th className="px-4 py-3">Created</th><th className="px-4 py-3">Verification dossier</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">{data.accounts.map((row) => <tr key={row.id}>
                  <td className="max-w-72 px-4 py-4 align-top">
                    <p className="break-words font-medium text-slate-900">{row.display_name || row.email || row.google_email || "Wallet account"}</p>
                    {row.email && row.display_name && <p className="mt-1 break-all text-xs text-slate-500">{row.email}</p>}
                    {row.google_email && row.google_email !== row.email && <p className="mt-1 break-all text-xs text-slate-500">Google: {row.google_email}</p>}
                    <p className="mt-1 break-all font-mono text-[10px] text-slate-400">{row.id}</p>
                  </td>
                  <td className="px-4 py-4 align-top"><div className="flex flex-wrap gap-1">{row.methods.map((method) => <span key={method} className="rounded-full bg-brand-50 px-2 py-1 text-xs text-brand-700">{METHOD_LABEL[method]}</span>)}</div></td>
                  <td className="max-w-52 px-4 py-4 align-top">{row.wallets.length ? row.wallets.map((wallet) => <p key={wallet} className="mb-1 break-all font-mono text-[11px] text-slate-600">{wallet}</p>) : <span className="text-xs text-slate-400">None linked</span>}</td>
                  <td className="whitespace-nowrap px-4 py-4 align-top text-xs text-slate-500">{new Date(row.created_at).toLocaleDateString("en-GB", { timeZone: "UTC" })}</td>
                  <td className="px-4 py-4 align-top">{row.dossiers.length ? row.dossiers.map((dossier) => <Link key={dossier.id} href={`/admin/clients/${dossier.id}`} className="mb-1 block text-xs font-medium text-brand-700 hover:underline">{STATUS_LABEL[dossier.status] ?? "View dossier"} →</Link>) : <span className="text-xs text-slate-500">Not started</span>}</td>
                </tr>)}</tbody>
              </table>
            </div>}
          <div className="flex items-center justify-between gap-3 text-sm">
            <button type="button" disabled={data.page <= 1 || loading} className="btn btn-sm btn-outline" onClick={() => setFilters((value) => ({ ...value, page: data.page - 1 }))}>Previous</button>
            <span className="text-slate-500">Page {data.page} of {Math.max(1, Math.ceil(data.filtered_total / data.page_size))}</span>
            <button type="button" disabled={data.page * data.page_size >= data.filtered_total || loading} className="btn btn-sm btn-outline" onClick={() => setFilters((value) => ({ ...value, page: data.page + 1 }))}>Next</button>
          </div>
        </>}
      </>}
    </div>
  );
}
