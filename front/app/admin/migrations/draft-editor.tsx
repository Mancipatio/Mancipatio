"use client";

// A token migration draft, with the embedded calculator (lib/token-migration/
// ratio.ts). The share class is picked from the issuers' on-chain classes
// that have an initialized mint; "Read the token" asks the server for the
// old mint's verdict and the excluded wallets' balances (a session read);
// the calculator then shows S_old, N_target, the lot rounded up to a nice
// number, the units cap, the effective equity and the warnings, live, before
// anything is saved. Saving sends only the inputs: the server reads the
// chain again and computes the same ratio itself (app/api/token-migrations/
// admin/save), so a stale screen can never store a wrong lot.

import { useEffect, useMemo, useState } from "react";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { findAssetPda } from "@/lib/generated/asset_registry";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { findShareClassPda } from "@/lib/pdas";
import { withRpcReadRetry } from "@/lib/rpc-retry";
import { useToast } from "@/lib/toast";
import { inspectOldToken, saveMigrationDraft, type InspectAnswer } from "@/lib/token-migration/client";
import {
  MIGRATION_SOURCE_LABEL,
  MIGRATION_SOURCES,
  UNCLAIMED_POLICIES,
  UNCLAIMED_POLICY_LABEL,
  WINDOW_DEFAULT_DAYS,
  WINDOW_MAX_DAYS,
  WINDOW_MIN_DAYS,
} from "@/lib/token-migration/model";
import {
  computeMigrationRatio,
  DEFAULT_GRANULARITY,
  formatBaseUnits,
  formatEquityBps,
  formatParityPercent,
  formatPercentE4,
  formatUnits,
  lotsFor,
  MAX_GRANULARITY,
  MIGRATION_GRANULARITIES,
  MIN_GRANULARITY,
  parseEquityPercent,
  parseGranularity,
  parseTokenAmount,
  percentClause,
  percentFigure,
  percentText,
  RatioInputError,
  unitPercent,
  type MigrationRatio,
} from "@/lib/token-migration/ratio";
import type { MigrationRow } from "@/lib/token-migration/rows";
import { Card, errorText, Field, inputClass, Notes, primaryButton, secondaryButton } from "./ui";

type ClassOption = { pda: string; label: string; assetName: string };

const DAY_MS = 86_400_000;
/** The granularity list's value for a G typed by hand (a joint-stock company: its number of shares). */
const CUSTOM_GRANULARITY = "custom";
const GRANULARITY_RANGE = `from ${formatUnits(MIN_GRANULARITY)} to ${formatUnits(MAX_GRANULARITY)}`;

/** A datetime-local value (the browser's local time) for an ISO instant. */
function localInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function linesOf(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

export function DraftEditor({ draft, onSaved, onCancel }: { draft: MigrationRow | null; onSaved: (m: MigrationRow) => void; onCancel: () => void }) {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const toast = useToast();
  const wallet = conn.wallet?.account.address.toString() ?? "";
  const [classes, setClasses] = useState<ClassOption[] | null>(null);
  const [classesError, setClassesError] = useState<string | null>(null);
  const [shareClass, setShareClass] = useState(draft?.share_class_pda ?? "");
  const [slug, setSlug] = useState(draft?.slug ?? "");
  const [company, setCompany] = useState(draft?.company_name ?? "");
  const [oldMint, setOldMint] = useState(draft?.old_mint ?? "");
  const [oldSymbol, setOldSymbol] = useState(draft?.old_symbol ?? "");
  const [oldName, setOldName] = useState(draft?.old_name ?? "");
  const [excludedText, setExcludedText] = useState((draft?.excluded_wallets ?? []).join("\n"));
  const [manualText, setManualText] = useState(draft ? formatBaseUnits(BigInt(draft.excluded_manual_amount), draft.old_decimals).replace(/,/g, "") : "0");
  const [note, setNote] = useState(draft?.excluded_note ?? "");
  const [equityText, setEquityText] = useState(draft ? formatEquityBps(draft.equity_bps) : "");
  // G: a preset, or "Custom" with the number typed in.
  const draftGranularity = draft ? BigInt(draft.granularity) : DEFAULT_GRANULARITY;
  const draftPreset = MIGRATION_GRANULARITIES.includes(draftGranularity);
  const [granularityChoice, setGranularityChoice] = useState(draftPreset ? draftGranularity.toString() : CUSTOM_GRANULARITY);
  const [customGranularity, setCustomGranularity] = useState(draftPreset ? "" : draftGranularity.toString());
  const [marketCap, setMarketCap] = useState("");
  const [valuation, setValuation] = useState("");
  const [source, setSource] = useState<string>(draft?.source ?? "founder_transfer");
  const [unclaimed, setUnclaimed] = useState<string>(draft?.unclaimed_policy ?? "return_to_source");
  const [depositOwner, setDepositOwner] = useState(draft?.deposit_owner ?? "");
  const [treasury, setTreasury] = useState(draft?.treasury_wallet ?? wallet);
  // A lazy initial value: tomorrow, for a new draft.
  const [opensAt, setOpensAt] = useState(() => localInput(draft?.window_opens_at ?? new Date(Date.now() + DAY_MS).toISOString()));
  const [days, setDays] = useState(draft ? String(Math.round((Date.parse(draft.window_closes_at) - Date.parse(draft.window_opens_at)) / DAY_MS)) : String(WINDOW_DEFAULT_DAYS));
  const [termsSha, setTermsSha] = useState(draft?.terms_doc_sha256 ?? "");
  const [termsUrl, setTermsUrl] = useState(draft?.terms_doc_url ?? "");
  const [example, setExample] = useState("");
  const [inspect, setInspect] = useState<{ key: string; answer: InspectAnswer } | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ warnings: string[] } | null>(null);

  // The issuers' share classes with an initialized mint (indexer first, the chain behind it).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadNetworkPreferIndexer(() => withRpcReadRetry(() => loadNetwork(client.runtime.rpc)));
        const assets = new Map<string, { name: string; assetId: string }>();
        for (const a of data.assets) {
          const [pda] = await findAssetPda({ issuer: a.issuer, assetId: a.assetId });
          assets.set(pda.toString(), { name: a.name, assetId: String(a.assetId) });
        }
        const options: ClassOption[] = [];
        for (const sc of data.shareClasses) {
          if (!sc.mintInitialized) continue;
          const asset = assets.get(sc.asset.toString());
          if (!asset) continue;
          const pda = (await findShareClassPda(sc.asset, sc.classIndex)).toString();
          options.push({ pda, label: `${asset.name} · class #${sc.classIndex} · ${asset.assetId}`, assetName: asset.name });
        }
        if (!cancelled) setClasses(options);
      } catch (err) {
        if (!cancelled) setClassesError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const excluded = useMemo(() => linesOf(excludedText), [excludedText]);
  const inspectKey = `${oldMint.trim()}|${excluded.join(",")}|${shareClass}`;
  const current = inspect && inspect.key === inspectKey ? inspect.answer : null;
  const granularity = granularityChoice === CUSTOM_GRANULARITY ? parseGranularity(customGranularity) : BigInt(granularityChoice);

  async function readToken() {
    if (!conn.wallet || inspecting) return;
    setInspecting(true);
    try {
      const answer = await inspectOldToken(conn.wallet, { oldMint: oldMint.trim(), excludedWallets: excluded, shareClassPda: shareClass || null });
      setInspect({ key: inspectKey, answer });
      if (!company && answer.share_class) setCompany(answer.share_class.assetName);
    } catch (err) {
      toast.showError("Could not read the token", errorText(err));
    } finally {
      setInspecting(false);
    }
  }

  // The calculator: only from what the server read for these exact inputs.
  const calc = useMemo((): { ratio: MigrationRatio | null; problem: string | null } => {
    if (!current) return { ratio: null, problem: "Read the token to see the ratio." };
    const decimals = current.old_mint.decimals;
    const manual = parseTokenAmount(manualText || "0", decimals);
    if (manual === null) return { ratio: null, problem: `The manual excluded amount must be a number of whole tokens with at most ${decimals} decimals.` };
    const equityBps = parseEquityPercent(equityText);
    if (equityBps === null) return { ratio: null, problem: "Enter E as a percent between 0.01 and 100 (at most two decimals)." };
    if (granularity === null) return { ratio: null, problem: `Enter G, the number of shares, as a whole number ${GRANULARITY_RANGE}.` };
    try {
      const ratio = computeMigrationRatio({
        oldTotalSupply: BigInt(current.old_mint.supply),
        excludedAmount: BigInt(current.excluded_total) + manual,
        equityBps,
        granularity,
        decimals,
        marketCap: marketCap ? Number(marketCap) : null,
        valuation: valuation ? Number(valuation) : null,
      });
      return { ratio, problem: null };
    } catch (err) {
      return { ratio: null, problem: err instanceof RatioInputError ? err.message : errorText(err) };
    }
  }, [current, manualText, equityText, granularity, marketCap, valuation]);

  const opensIso = Number.isFinite(Date.parse(opensAt)) ? new Date(opensAt).toISOString() : null;
  const dayCount = Number(days);
  const closesIso = opensIso && Number.isFinite(dayCount) ? new Date(Date.parse(opensIso) + dayCount * DAY_MS).toISOString() : null;
  const windowProblem = !opensIso ? "Choose when the window opens." : !(dayCount >= WINDOW_MIN_DAYS && dayCount <= WINDOW_MAX_DAYS) ? `The window lasts ${WINDOW_MIN_DAYS}–${WINDOW_MAX_DAYS} days.` : null;
  const ownWallet = depositOwner.trim() === wallet && wallet !== "";
  const exampleBase = current ? parseTokenAmount(example || "0", current.old_mint.decimals) : null;

  async function save() {
    if (!conn.wallet || saving || !current || !calc.ratio || !opensIso || !closesIso || windowProblem) return;
    setSaving(true);
    try {
      const result = await saveMigrationDraft(conn.wallet, {
        id: draft?.id ?? null,
        slug: slug.trim(),
        company_name: company.trim(),
        share_class_pda: shareClass,
        old_mint: oldMint.trim(),
        old_symbol: oldSymbol.trim(),
        old_name: oldName.trim(),
        excluded_wallets: excluded,
        excluded_manual_amount: (parseTokenAmount(manualText || "0", current.old_mint.decimals) ?? BigInt(0)).toString(),
        excluded_note: note.trim(),
        equity_bps: calc.ratio.equityBps,
        granularity: calc.ratio.granularity.toString(),
        source,
        unclaimed_policy: unclaimed,
        deposit_owner: depositOwner.trim(),
        treasury_wallet: treasury.trim(),
        window_opens_at: opensIso,
        window_closes_at: closesIso,
        terms_doc_sha256: termsSha.trim() || null,
        terms_doc_url: termsUrl.trim() || null,
      });
      setSaved({ warnings: result.warnings });
      toast.show({ kind: "success", title: draft ? "Draft updated" : "Draft saved", description: `${formatUnits(BigInt(result.migration.units_cap))} units, lot ${formatBaseUnits(BigInt(result.migration.lot_base_units), result.migration.old_decimals)} ${result.migration.old_symbol}` });
      onSaved(result.migration);
    } catch (err) {
      toast.showError("Draft not saved", errorText(err));
    } finally {
      setSaving(false);
    }
  }

  const r = calc.ratio;
  const decimals = current?.old_mint.decimals ?? 0;
  return (
    <Card title={draft ? `Edit draft ${draft.slug}` : "New token migration draft"} aside={<button type="button" className={secondaryButton} onClick={onCancel}>Close</button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Share class to deliver" hint={classesError ? `Could not list the share classes: ${classesError}` : "Classes with an initialized mint. One unit of it is the company share the ratio pays."}>
          <select className={inputClass} value={shareClass} onChange={(e) => setShareClass(e.target.value)}>
            <option value="">{classes === null ? "Loading…" : "Choose a share class"}</option>
            {(classes ?? []).map((c) => <option key={c.pda} value={c.pda}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Company name (as the public pages show it)">
          <input className={inputClass} value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Public address" hint="Lowercase letters, digits and hyphens: /migrations/<address>.">
          <input className={inputClass} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} maxLength={64} placeholder="acme-2027" />
        </Field>
        <Field label="Old token mint (Solana)">
          <input className={`${inputClass} font-mono`} value={oldMint} onChange={(e) => setOldMint(e.target.value)} />
        </Field>
        <Field label="Old token symbol"><input className={inputClass} value={oldSymbol} onChange={(e) => setOldSymbol(e.target.value)} maxLength={16} /></Field>
        <Field label="Old token name"><input className={inputClass} value={oldName} onChange={(e) => setOldName(e.target.value)} maxLength={80} /></Field>
        <Field label="Excluded wallets or token accounts" hint="One per line: team, treasury, liquidity pools, exchanges. Their balances are read on chain and left out of the qualified supply, and they cannot deposit.">
          <textarea className={`${inputClass} font-mono text-xs`} rows={4} value={excludedText} onChange={(e) => setExcludedText(e.target.value)} />
        </Field>
        <div className="space-y-4">
          <Field label="Extra excluded amount (whole tokens)" hint="Tokens locked or burned outside these wallets; explain below.">
            <input className={inputClass} value={manualText} onChange={(e) => setManualText(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Note on the excluded supply"><input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></Field>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className={secondaryButton} disabled={inspecting || !oldMint.trim()} onClick={() => void readToken()}>
          {inspecting ? "Reading…" : "Read the token"}
        </button>
        {current && (
          <span className="text-xs text-slate-600">
            {current.old_mint.token_program.startsWith("Tokenz") ? "Token-2022" : "SPL Token"} · {current.old_mint.decimals} decimals · supply {formatBaseUnits(BigInt(current.old_mint.supply), current.old_mint.decimals)} · excluded wallets hold {formatBaseUnits(BigInt(current.excluded_total), current.old_mint.decimals)}
          </span>
        )}
      </div>
      {current && <Notes tone="bad" items={current.old_mint.refusals.map((x) => `${x.extension}: ${x.reason}`)} />}
      {current && <Notes tone="warn" items={current.old_mint.warnings} />}

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Field label="Share for the holders, E (%)" hint="The shareholders' decision."><input className={inputClass} value={equityText} onChange={(e) => setEquityText(e.target.value)} inputMode="decimal" placeholder="12" /></Field>
        <Field label="Granularity G (units = 100 %)" hint="1,000,000 by default. A joint-stock company uses its number of shares: one unit is then one share.">
          <select className={inputClass} value={granularityChoice} onChange={(e) => setGranularityChoice(e.target.value)}>
            {MIGRATION_GRANULARITIES.map((g) => <option key={g.toString()} value={g.toString()}>{formatUnits(g)} (1 unit {percentClause(unitPercent(g))})</option>)}
            <option value={CUSTOM_GRANULARITY}>Custom (joint-stock company: number of shares)</option>
          </select>
        </Field>
        {granularityChoice === CUSTOM_GRANULARITY && (
          <Field label="G: the number of shares" hint={granularity !== null ? `1 unit ${percentClause(unitPercent(granularity))} of the company.` : `A whole number ${GRANULARITY_RANGE}.`}>
            <input className={inputClass} value={customGranularity} onChange={(e) => setCustomGranularity(e.target.value)} inputMode="numeric" placeholder="37,000" />
          </Field>
        )}
        <Field label="Example holder (whole tokens)"><input className={inputClass} value={example} onChange={(e) => setExample(e.target.value)} inputMode="decimal" /></Field>
        <Field label="Market cap of the qualified supply (optional)"><input className={inputClass} value={marketCap} onChange={(e) => setMarketCap(e.target.value)} inputMode="decimal" /></Field>
        <Field label="Company valuation, same currency (optional)" hint="Parity reference only: it never changes the ratio."><input className={inputClass} value={valuation} onChange={(e) => setValuation(e.target.value)} inputMode="decimal" /></Field>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
        {r ? (
          <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            <div><dt className="inline text-slate-500">Qualified supply S_old: </dt><dd className="inline font-mono">{formatBaseUnits(r.qualifiedSupply, decimals)}</dd></div>
            <div><dt className="inline text-slate-500">Units the decision allows N_target: </dt><dd className="inline font-mono">{formatUnits(r.targetUnits)}</dd></div>
            <div><dt className="inline text-slate-500">Lot L (rounded up): </dt><dd className="inline font-mono">{formatBaseUnits(r.lot, decimals)} {oldSymbol || "tokens"}</dd></div>
            <div><dt className="inline text-slate-500">Units cap N_eff: </dt><dd className="inline font-mono">{formatUnits(r.unitsCap)}</dd></div>
            <div><dt className="inline text-slate-500">Effective share E_eff: </dt><dd className="inline font-mono">{percentText(r.effectiveShare)} % (decided {formatPercentE4(r.equityPercentE4)} %)</dd></div>
            <div><dt className="inline text-slate-500">Parity reference: </dt><dd className="inline font-mono">{formatParityPercent(r.parityPercent) ? `${formatParityPercent(r.parityPercent)} %` : "—"}</dd></div>
            {exampleBase !== null && exampleBase > BigInt(0) && (
              <div className="sm:col-span-2"><dt className="inline text-slate-500">Example holder: </dt><dd className="inline">
                {formatUnits(lotsFor(exampleBase, r.lot))} lots = {formatUnits(lotsFor(exampleBase, r.lot))} units ({percentText(percentFigure(lotsFor(exampleBase, r.lot), r.granularity))} %); {formatBaseUnits(exampleBase % r.lot, decimals)} {oldSymbol || "tokens"} stay in the wallet
              </dd></div>
            )}
          </dl>
        ) : (
          <p className="text-slate-600">{calc.problem}</p>
        )}
        {r && <Notes tone="warn" items={r.warnings.map((w) => w.text)} />}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label="Source of the units">
          <select className={inputClass} value={source} onChange={(e) => setSource(e.target.value)}>
            {MIGRATION_SOURCES.map((s) => <option key={s} value={s}>{MIGRATION_SOURCE_LABEL[s]}</option>)}
          </select>
        </Field>
        <Field label="Units nobody claims">
          <select className={inputClass} value={unclaimed} onChange={(e) => setUnclaimed(e.target.value)}>
            {UNCLAIMED_POLICIES.map((s) => <option key={s} value={s}>{UNCLAIMED_POLICY_LABEL[s]}</option>)}
          </select>
        </Field>
        <Field label="Deposit owner" hint="Owns the deposit account (its ATA of the old token). A Squads vault is recommended: refunds and the burn then go through its proposals.">
          <input className={`${inputClass} font-mono`} value={depositOwner} onChange={(e) => setDepositOwner(e.target.value)} />
        </Field>
        <Field label="Treasury wallet" hint="Holds the minted units and signs the deliveries.">
          <input className={`${inputClass} font-mono`} value={treasury} onChange={(e) => setTreasury(e.target.value)} />
        </Field>
        <Field label="Window opens (your local time)"><input type="datetime-local" className={inputClass} value={opensAt} onChange={(e) => setOpensAt(e.target.value)} /></Field>
        <Field label={`Window length (${WINDOW_MIN_DAYS}–${WINDOW_MAX_DAYS} days)`} hint={closesIso ? `Closes ${new Date(closesIso).toUTCString()}` : undefined}>
          <input className={inputClass} value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Swap Terms SHA-256" hint="Required before the campaign opens; 64 hexadecimal characters of the signed document."><input className={`${inputClass} font-mono text-xs`} value={termsSha} onChange={(e) => setTermsSha(e.target.value)} /></Field>
        <Field label="Swap Terms link (https)"><input className={inputClass} value={termsUrl} onChange={(e) => setTermsUrl(e.target.value)} /></Field>
      </div>
      <Notes tone="warn" items={[
        ...(windowProblem ? [windowProblem] : []),
        ...(ownWallet ? ["The deposit owner is your own wallet: one key could then move every deposit. A Squads vault is recommended."] : []),
      ]} />
      {saved && <Notes tone="warn" items={saved.warnings} />}
      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" className={primaryButton} disabled={saving || !current || !current.old_mint.ok || !r || r.unitsCap < BigInt(1) || !!windowProblem || !shareClass} onClick={() => void save()}>
          {saving ? "Saving…" : draft ? "Save the draft" : "Save as draft"}
        </button>
        <p className="self-center text-xs text-slate-500">The server reads the chain again and recomputes the ratio when it saves.</p>
      </div>
    </Card>
  );
}
