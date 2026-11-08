"use client";

// "Supply and conversions" on the public asset page
// (/marketplace/assets/[id]): per share class, what 100 % of the company is,
// how many units were issued, how many are outstanding and how many sit in
// conversion custody, and the conversions recorded in the company register
// with the decision document's SHA-256 and the realize transaction. Read from
// /api/cap-table/public (open, cached, no personal data, no case number), so
// it renders in KYC-only mode like the rest of the page. Facts only: it
// offers no action and says nothing about which services are available.

import { useEffect, useState } from "react";
import { SkeletonCard } from "@/components/skeleton";
import { formatUnits, percentOfSupply, type PublicSupply, type PublicSupplyClass } from "@/lib/cap-table";
import { detectNetwork, explorerTxUrl } from "@/lib/network";

type State = { asset: string; supply: PublicSupply | null; failed: boolean };

async function fetchSupply(assetPda: string, signal: AbortSignal): Promise<PublicSupply> {
  const res = await fetch(`/api/cap-table/public?asset=${encodeURIComponent(assetPda)}`, { signal });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: PublicSupply } | null;
  if (!res.ok || !body?.ok || !body.data) throw new Error("Supply figures unavailable");
  return body.data;
}

export function SupplyConversionsPanel({ assetPda }: { assetPda: string }) {
  const [state, setState] = useState<State>({ asset: "", supply: null, failed: false });

  useEffect(() => {
    if (!assetPda) return;
    const controller = new AbortController();
    fetchSupply(assetPda, controller.signal)
      .then((supply) => setState({ asset: assetPda, supply, failed: false }))
      .catch(() => { if (!controller.signal.aborted) setState({ asset: assetPda, supply: null, failed: true }); });
    return () => controller.abort();
  }, [assetPda]);

  const current = state.asset === assetPda ? state : null;
  if (current?.supply && current.supply.classes.length === 0) return null;

  return (
    <section className="mt-10" aria-labelledby="supply-conversions">
      <h2 id="supply-conversions" className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
        Supply and conversions
      </h2>
      {!current ? (
        <div className="mt-4"><SkeletonCard rows={4} /></div>
      ) : current.failed || !current.supply ? (
        <p className="mt-4 rounded-[3px] border border-mx-rule bg-white p-6 text-sm text-mx-ink-soft">
          Supply figures are temporarily unavailable. Please try again shortly.
        </p>
      ) : (
        <SupplyConversionsFigures supply={current.supply} />
      )}
    </section>
  );
}

/** The figures and the conversion record of a loaded PublicSupply. */
export function SupplyConversionsFigures({ supply }: { supply: PublicSupply }) {
  return (
    <div className="mt-4 space-y-4">
      {supply.classes.map((cls) => (
        <ClassSupply key={cls.share_class_pda} cls={cls} labelled={supply.classes.length > 1} />
      ))}
      <p className="text-xs leading-relaxed text-mx-ink-faint">
        Figures are read from the Solana {supply.network} programs and the register entries Manci records
        after each registry decision. The SHA-256 lets anyone holding a copy of the decision document check that it
        is the document a record refers to. Case numbers and the identities of holders are not published.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-mx-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-sm text-mx-ink">{value}</dd>
    </div>
  );
}

function ClassSupply({ cls, labelled }: { cls: PublicSupplyClass; labelled: boolean }) {
  const max = cls.max_supply === null ? null : BigInt(cls.max_supply);
  const withPercent = (units: string) => {
    const pct = percentOfSupply(BigInt(units), max);
    return `${formatUnits(units)} units${pct === null ? "" : ` (${pct} %)`}`;
  };
  const count = cls.converted.count;
  return (
    <div className="rounded-[3px] border border-mx-rule bg-white p-6">
      {labelled && <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-mx-ink-soft">Share class #{cls.class_index}</p>}
      <dl className="grid gap-3 sm:grid-cols-2">
        <Row
          label="100 % of the company"
          value={max === null ? "No maximum supply set" : `${formatUnits(cls.max_supply!)} units${cls.unit_percent ? ` · 1 unit = ${cls.unit_percent} %` : ""}`}
        />
        <Row label="Issued" value={withPercent(cls.issued)} />
        <Row label="Outstanding" value={withPercent(cls.outstanding)} />
        <Row label="In conversion" value={withPercent(cls.in_conversion)} />
        <Row
          label="Converted into registered ownership"
          value={count === 0 ? "None yet" : `${count} ${count === 1 ? "conversion" : "conversions"} · ${formatUnits(cls.converted.units)} units · ${cls.converted.percent} % of the company`}
        />
      </dl>
      {cls.records.length > 0 && (
        <div className="mt-5 overflow-x-auto border-t border-mx-rule pt-4">
          <table className="w-full text-left text-xs">
            <caption className="mb-2 text-left text-xs font-medium uppercase tracking-wide text-mx-ink-faint">Conversion record</caption>
            <thead className="text-[11px] uppercase tracking-wider text-mx-ink-faint">
              <tr>
                <th className="py-2 pr-3 font-medium">Decision date</th>
                <th className="py-2 pr-3 text-right font-medium">Units</th>
                <th className="py-2 pr-3 text-right font-medium">Of the company</th>
                <th className="py-2 pr-3 font-medium">Registry</th>
                <th className="py-2 pr-3 font-medium">Decision document SHA-256</th>
                <th className="py-2 font-medium">Realize transaction</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mx-rule text-mx-ink-soft">
              {cls.records.map((r, i) => (
                <tr key={`${r.decision_date}:${r.realize_tx ?? i}:${r.decision_doc_sha256}`} className="align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">{r.decision_date}</td>
                  <td className="py-2 pr-3 text-right font-mono">{formatUnits(r.units)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{r.percent} %</td>
                  <td className="py-2 pr-3">{r.registry}</td>
                  <td className="py-2 pr-3"><code className="block max-w-[22rem] break-all font-mono text-[11px]">{r.decision_doc_sha256}</code></td>
                  <td className="py-2">
                    {r.realize_tx ? (
                      <a href={explorerTxUrl(r.realize_tx, detectNetwork())} target="_blank" rel="noopener noreferrer"
                        className="font-mono text-[11px] text-mx-ink underline-offset-2 hover:underline" title={r.realize_tx}>
                        {r.realize_tx.slice(0, 8)}…{r.realize_tx.slice(-4)} ↗
                      </a>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
