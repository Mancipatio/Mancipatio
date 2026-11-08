"use client";

// The cap table reconciliation of one asset (lib/cap-table.ts), shared by
// /admin/cap-table and /issuer/cap-table: per share class, the chain side
// next to the company register, the checks with their pass / warn / fail
// state, the conversions, the register entries and the holder list. It
// renders only what the table carries: the issuer's table (from
// /api/cap-table/issuer-read) has no dossier link, note or void reason, so
// none can show here. The admin page adds its actions through the render
// props. max_supply is the class cap in units; a percentage of the company
// shows only where the class has a share of one unit (unit_percent, from
// tokenize figures that match the class), never units ÷ max_supply.

import type { ReactNode } from "react";
import Link from "next/link";
import {
  formatUnits,
  HOLDER_KIND_LABEL,
  percentForUnits,
  type AssetReconciliation,
  type CheckState,
  type ClassReconciliation,
  type ConversionView,
  type RegisterEntryView,
} from "@/lib/cap-table";
import { detectNetwork, explorerAddressUrl, explorerTxUrl } from "@/lib/network";

export const STATE_LABEL: Record<CheckState, string> = { pass: "Pass", warn: "Check", fail: "Mismatch" };
export const STATE_BADGE: Record<CheckState, string> = {
  pass: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
  fail: "border-red-200 bg-red-50 text-red-800",
};

const CONVERSION_STATUS: Record<ConversionView["status"], string> = {
  vault_opened: "Vault opened",
  deposited: "Deposited",
  converted: "Converted",
};

export function StateBadge({ state }: { state: CheckState }) {
  return (
    <span className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATE_BADGE[state]}`}>
      {STATE_LABEL[state]}
    </span>
  );
}

function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function TxLink({ signature }: { signature: string | null }) {
  if (!signature) return <span className="text-slate-400">—</span>;
  return (
    <a href={explorerTxUrl(signature, detectNetwork())} target="_blank" rel="noopener noreferrer"
      className="font-mono text-[11px] text-slate-700 underline-offset-2 hover:underline" title={signature}>
      {short(signature)} ↗
    </a>
  );
}

function AddressLink({ address }: { address: string }) {
  return (
    <a href={explorerAddressUrl(address, detectNetwork())} target="_blank" rel="noopener noreferrer"
      className="font-mono text-[11px] text-slate-700 underline-offset-2 hover:underline" title={address}>
      {short(address)} ↗
    </a>
  );
}

function units(value: string | null): string {
  return value === null ? "—" : formatUnits(value);
}

function Figure({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-xs text-slate-500" title={hint}>{label}</dt>
      <dd className="text-right font-mono text-xs text-slate-900">{value}</dd>
    </div>
  );
}

/** Units, with their share of the company when the class has a share of one unit. */
function withPercent(value: string | null, unitPercent: string | null): ReactNode {
  if (value === null) return "—";
  const pct = percentForUnits(value, unitPercent);
  return <>{formatUnits(value)}{pct !== null && <span className="ml-1.5 text-slate-500">({pct} %)</span>}</>;
}

/** The class cap: units, and the share of the company they stand for when known. */
function classCap(maxSupply: string | null, unitPercent: string | null): string {
  if (maxSupply === null) return "No cap";
  const pct = percentForUnits(maxSupply, unitPercent);
  return `${formatUnits(maxSupply)} units${pct === null ? "" : ` (${pct} % of the company)`}`;
}

export function CapTableView({
  table,
  audience,
  renderClassActions,
  renderConversionActions,
  renderEntryActions,
}: {
  table: AssetReconciliation;
  audience: "admin" | "issuer";
  renderClassActions?: (cls: ClassReconciliation) => ReactNode;
  renderConversionActions?: (conversion: ConversionView, cls: ClassReconciliation) => ReactNode;
  renderEntryActions?: (entry: RegisterEntryView, cls: ClassReconciliation) => ReactNode;
}) {
  if (table.classes.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600 shadow-card">
        This asset has no share class with a mint yet, so there is nothing to reconcile.
      </div>
    );
  }
  return (
    <div className="space-y-8">
      {table.classes.map((cls) => (
        <ClassSection key={cls.share_class_pda} cls={cls} audience={audience}
          actions={renderClassActions?.(cls)}
          renderConversionActions={renderConversionActions}
          renderEntryActions={renderEntryActions} />
      ))}
      <p className="text-xs text-slate-500">
        Read from Solana {table.network} at finalized commitment and this network&apos;s records,{" "}
        {new Date(table.generated_at).toLocaleString("en-GB", { timeZone: "UTC" })} UTC.
      </p>
    </div>
  );
}

function ClassSection({
  cls,
  audience,
  actions,
  renderConversionActions,
  renderEntryActions,
}: {
  cls: ClassReconciliation;
  audience: "admin" | "issuer";
  actions?: ReactNode;
  renderConversionActions?: (conversion: ConversionView, cls: ClassReconciliation) => ReactNode;
  renderEntryActions?: (entry: RegisterEntryView, cls: ClassReconciliation) => ReactNode;
}) {
  const c = cls.chain;
  const holders = cls.holders ?? [];
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card" aria-labelledby={`class-${cls.share_class_pda}`}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="min-w-0">
          <h2 id={`class-${cls.share_class_pda}`} className="text-sm font-semibold text-slate-900">
            Share class #{cls.class_index}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Mint <AddressLink address={cls.mint} /> · class <AddressLink address={cls.share_class_pda} />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <StateBadge state={cls.state} />
        </div>
      </header>

      <div className="grid gap-px bg-slate-100 md:grid-cols-2">
        <div className="bg-white px-5 py-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">On chain</h3>
          <dl className="mt-2 divide-y divide-slate-100">
            <Figure label="Class cap" value={classCap(c.max_supply, c.unit_percent)}
              hint="The class's max supply, in units" />
            <Figure label="One unit" value={c.unit_percent === null ? "—" : `${c.unit_percent} % of the company`}
              hint="From the tokenize figures, shown only while they match the class cap" />
            <Figure label="Issued (lifetime minted)" value={withPercent(c.lifetime_minted, c.unit_percent)} />
            <Figure label="Outstanding (circulating)" value={withPercent(c.circulating, c.unit_percent)} />
            <Figure label="Locked" value={units(c.locked)} />
            <Figure label="Burned on chain" value={units(c.burned)} hint="Lifetime minted minus circulating" />
            <Figure label="Burned through conversions" value={units(c.burned_by_conversions)} />
            <Figure label="Mint supply" value={units(c.mint_supply)} />
            <Figure label="In conversion (open escrows)" value={withPercent(c.in_conversion, c.unit_percent)} />
            <Figure label="In custody escrows (all vaults)" value={units(c.custody_escrow)} />
            <Figure label="Issuer treasury" value={withPercent(c.treasury, c.unit_percent)} />
            <Figure label="Other wallets" value={withPercent(c.other_wallets, c.unit_percent)} />
            <Figure label="Program escrows" value={withPercent(c.program_escrows, c.unit_percent)} />
          </dl>
        </div>
        <div className="bg-white px-5 py-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Company register</h3>
          <dl className="mt-2 divide-y divide-slate-100">
            <Figure label="Recorded entries" value={String(cls.register.entries)} />
            <Figure label="Registered units" value={formatUnits(cls.register.units)} />
            <Figure label="Registered stake (as recorded)" value={`${cls.register.percent} %`} />
          </dl>
          {cls.register.decision_refs && cls.register.decision_refs.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-slate-500">Decision references</p>
              <ul className="mt-1 space-y-0.5 text-xs text-slate-800">
                {cls.register.decision_refs.map((ref) => <li key={ref} className="font-mono">{ref}</li>)}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-slate-100 px-5 py-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Checks</h3>
        <ul className="mt-2 space-y-2">
          {cls.checks.map((check) => (
            <li key={check.id} className="flex items-start gap-3">
              <StateBadge state={check.state} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{check.title}</p>
                <p className="text-xs leading-relaxed text-slate-600">{check.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-slate-100 px-5 py-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Conversions ({cls.conversions.length})
        </h3>
        {cls.conversions.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">No open or converted conversion requests.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 text-right font-medium">Units</th>
                  <th className="py-2 pr-3 font-medium">Holder wallet</th>
                  <th className="py-2 pr-3 font-medium">Realize</th>
                  <th className="py-2 pr-3 font-medium">Register entry</th>
                  {renderConversionActions && <th className="py-2 font-medium"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {cls.conversions.map((v) => (
                  <tr key={v.id} className="align-top text-slate-700">
                    <td className="py-2 pr-3">
                      {CONVERSION_STATUS[v.status]}
                      {v.decided_at && v.status === "converted" && (
                        <span className="block text-[11px] text-slate-400">{v.decided_at.slice(0, 10)}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {formatUnits(v.units)}
                      {v.escrow_units !== null && <span className="block text-[11px] text-slate-400">{formatUnits(v.escrow_units)} in escrow</span>}
                    </td>
                    <td className="py-2 pr-3"><AddressLink address={v.holder_wallet} /></td>
                    <td className="py-2 pr-3"><TxLink signature={v.realize_tx} /></td>
                    <td className="py-2 pr-3">
                      {v.status !== "converted" ? <span className="text-slate-400">—</span>
                        : v.register_entry_id ? <span className="text-emerald-700">Recorded</span>
                          : <span className="font-medium text-amber-700">Missing</span>}
                    </td>
                    {renderConversionActions && <td className="py-2 text-right">{renderConversionActions(v, cls)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="border-t border-slate-100 px-5 py-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Register entries ({cls.entries.length})
        </h3>
        {cls.entries.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">No register entries recorded.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">Decision</th>
                  <th className="py-2 pr-3 text-right font-medium">Units</th>
                  <th className="py-2 pr-3 text-right font-medium">Stake</th>
                  <th className="py-2 pr-3 font-medium">Document SHA-256</th>
                  <th className="py-2 pr-3 font-medium">Realize</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  {renderEntryActions && <th className="py-2 font-medium"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {cls.entries.map((e) => (
                  <tr key={e.id} className={`align-top ${e.status === "voided" ? "text-slate-400" : "text-slate-700"}`}>
                    <td className="py-2 pr-3">
                      <span className="block">{e.registry} · {e.decision_date}</span>
                      {e.decision_ref && <span className="block font-mono text-[11px]">{e.decision_ref}</span>}
                      {audience === "admin" && e.holder_client_id && (
                        <Link href={`/admin/clients/${e.holder_client_id}`} className="block text-[11px] text-slate-600 underline-offset-2 hover:underline">
                          Holder dossier
                        </Link>
                      )}
                      {audience === "admin" && e.note && <span className="block whitespace-pre-wrap text-[11px] text-slate-500">{e.note}</span>}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">{formatUnits(e.units)}</td>
                    <td className="py-2 pr-3 text-right font-mono">{e.percent} %</td>
                    <td className="py-2 pr-3 font-mono text-[11px]" title={e.decision_doc_sha256}>{short(e.decision_doc_sha256)}</td>
                    <td className="py-2 pr-3"><TxLink signature={e.realize_tx} /></td>
                    <td className="py-2 pr-3">
                      {e.status === "recorded" ? "Recorded" : "Voided"}
                      {e.status === "voided" && e.void_reason && <span className="block text-[11px]">{e.void_reason}</span>}
                    </td>
                    {renderEntryActions && <td className="py-2 text-right">{renderEntryActions(e, cls)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <details className="border-t border-slate-100 px-5 py-4" open={holders.length > 0 && holders.length <= 10}>
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-slate-500">
          Holders ({cls.chain.holder_count ?? 0})
        </summary>
        {holders.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">No token account of this mint holds units.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">Owner</th>
                  <th className="py-2 pr-3 font-medium">Kind</th>
                  <th className="py-2 pr-3 text-right font-medium">Units</th>
                  <th className="py-2 text-right font-medium">Stake</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {holders.map((h) => (
                  <tr key={h.owner} className="text-slate-700">
                    <td className="py-1.5 pr-3"><AddressLink address={h.owner} /></td>
                    <td className="py-1.5 pr-3">{HOLDER_KIND_LABEL[h.kind]}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{formatUnits(h.units)}</td>
                    <td className="py-1.5 text-right font-mono">{h.percent === null ? "—" : `${h.percent} %`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}
