"use client";

// /admin/migrations — token migrations (V1, operator-delivered): a company
// that already issued a token on Solana moves its holders onto Manci. The
// operator prepares a draft with the embedded calculator, opens the campaign
// (the module's holder-facing entry: lib/features.ts tokenMigration),
// reconciles the deposit account daily, delivers the units from the
// treasury, refunds irregular deposits, closes the campaign after its
// window, records the burn of the collected old tokens and completes it
// with the final report (ops/runbook-mainnet.md §24). Every route behind
// this page is admin-gated on chain (app/api/token-migrations/admin/*);
// drafts and records stay usable in KYC-only mode like the rest of the
// admin console, and the AppShell shows the module notice above the page
// while the module is off (lib/pilot-scope.ts).

import { useCallback, useEffect, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { RequireRole } from "@/components/require-role";
import { SkeletonTable } from "@/components/skeleton";
import { WalletSessionRequiredError } from "@/lib/siws-client";
import { listAdminMigrations, type AdminMigration } from "@/lib/token-migration/client";
import { MIGRATION_STATUS_LABEL } from "@/lib/token-migration/model";
import { formatUnits } from "@/lib/token-migration/ratio";
import type { MigrationRow } from "@/lib/token-migration/rows";
import { CampaignPanel } from "./campaign-panel";
import { DraftEditor } from "./draft-editor";
import { errorText, primaryButton, secondaryButton, utcText } from "./ui";

export default function MigrationsAdminPage() {
  return (
    <section className="min-w-0 flex-1">
      <div className="max-w-3xl">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Migrations</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Token migrations</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Holders of a company&apos;s existing Solana token deposit it during an opt-in window and receive units of the
          company&apos;s share class, delivered from the treasury. Deposits, refunds and the burn are plain SPL transfers: no
          program pause bit covers them, so a campaign is stopped by cancelling it.
        </p>
      </div>
      <RequireRole role="admin">
        <MigrationsConsole />
      </RequireRole>
    </section>
  );
}

function MigrationsConsole() {
  const conn = useWalletConnection();
  const [list, setList] = useState<AdminMigration[] | null>(null);
  const [error, setError] = useState<{ session: boolean; message: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<MigrationRow | "new" | null>(null);

  const load = useCallback(async (interactive: boolean | "session-only" = "session-only") => {
    if (!conn.wallet) return;
    setError(null);
    try {
      setList(await listAdminMigrations(conn.wallet, { interactive }));
    } catch (err) {
      setError({ session: err instanceof WalletSessionRequiredError, message: errorText(err) });
    }
  }, [conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap gap-3">
        <button type="button" className={primaryButton} onClick={() => { setEditing("new"); setSelected(null); }}>+ New draft</button>
        <button type="button" className={secondaryButton} onClick={() => void load(true)}>Refresh</button>
      </div>
      {error && (
        <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 sm:flex-row sm:items-center sm:justify-between">
          <span role="alert">{error.session ? "Sign in with your wallet to load the campaigns (one signature, nothing is sent on chain)." : `Could not load the campaigns: ${error.message}`}</span>
          <button type="button" className={secondaryButton} onClick={() => void load(true)}>{error.session ? "Sign in" : "Retry"}</button>
        </div>
      )}

      {editing && (
        <DraftEditor
          key={editing === "new" ? "new" : editing.id}
          draft={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={(m) => {
            setEditing(null);
            setSelected(m.id);
            void load();
          }}
        />
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-card">
        <h2 className="text-base font-semibold text-slate-900">Campaigns</h2>
        {list === null && !error ? (
          <div className="mt-4"><SkeletonTable rows={3} cols={5} /></div>
        ) : list && list.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No campaign yet. Start with a draft: the calculator shows the ratio before anything is saved.</p>
        ) : list ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr><th className="px-3 py-2">Campaign</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Window</th><th className="px-3 py-2 text-right">Units delivered / due / cap</th><th className="px-3 py-2 text-right">Holders</th><th className="px-3 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.map((m) => (
                  <tr key={m.id} className={selected === m.id ? "bg-brand-50/50" : undefined}>
                    <td className="px-3 py-2"><span className="font-medium text-slate-900">{m.old_symbol} → {m.company_name}</span><span className="block text-xs text-slate-500">{m.slug}</span></td>
                    <td className="px-3 py-2 text-xs">{MIGRATION_STATUS_LABEL[m.status]}</td>
                    <td className="px-3 py-2 text-xs">{utcText(m.window_opens_at)} – {utcText(m.window_closes_at)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{formatUnits(BigInt(m.progress.unitsDelivered))} / {formatUnits(BigInt(m.progress.unitsDue))} / {formatUnits(BigInt(m.units_cap))}</td>
                    <td className="px-3 py-2 text-right text-xs">{m.progress.holders}{m.progress.refundsDue ? ` · ${m.progress.refundsDue} refunds due` : ""}</td>
                    <td className="px-3 py-2 text-right"><button type="button" className="text-xs font-semibold text-brand-700 underline" onClick={() => { setSelected(m.id); setEditing(null); }}>Manage</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {selected && !editing && (
        <CampaignPanel
          key={selected}
          id={selected}
          onEdit={(m) => setEditing(m)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}
