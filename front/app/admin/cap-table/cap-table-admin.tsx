"use client";

// /admin/cap-table: pick an asset, read its reconciliation
// (/api/cap-table/admin-read), record the register entry of a converted
// request after the registry decision, void a wrong entry, export the CSV.
// The server re-checks everything (lib/server/cap-table.ts); the form only
// narrows the input the same way first (lib/register-entries.ts) so a typo
// never costs a signature.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletSession } from "@solana/client";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonCard } from "@/components/skeleton";
import { CapTableView, StateBadge } from "@/components/cap-table-view";
import { useToast } from "@/lib/toast";
import { detectNetwork } from "@/lib/network";
import { sha256HexOfFile } from "@/lib/storage-client";
import {
  bpsConsistent,
  formatUnits,
  percentOfSupply,
  percentToBps,
  type AssetReconciliation,
  type ClassReconciliation,
  type ConversionView,
  type RegisterEntryView,
} from "@/lib/cap-table";
import {
  DEFAULT_REGISTRY,
  isoDate,
  parseRegisterEntryInput,
  RegisterEntryInputError,
} from "@/lib/register-entries";
import {
  downloadCsv,
  exportCapTable,
  loadAssetOptions,
  readAdminCapTable,
  recordRegisterEntry,
  voidRegisterEntry,
  type AssetOption,
} from "@/lib/cap-table-client";

const buttonGhost = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50";
const buttonDark = "rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong. Please try again.";
}

export function CapTableAdmin() {
  const { wallet } = useWalletConnection();
  if (!wallet) return null;
  // A table, a form and its answers belong only to the wallet that opened them.
  return <WalletCapTable key={`${detectNetwork()}:${wallet.account.address}`} wallet={wallet} />;
}

type FormTarget = { cls: ClassReconciliation; conversion: ConversionView | null };

function WalletCapTable({ wallet }: { wallet: WalletSession }) {
  const client = useSolanaClient();
  const toast = useToast();
  const [assets, setAssets] = useState<AssetOption[] | null>(null);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [table, setTable] = useState<AssetReconciliation | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormTarget | null>(null);
  const [voiding, setVoiding] = useState<RegisterEntryView | null>(null);
  const [busy, setBusy] = useState<"void" | "export" | null>(null);
  const [confirmPersonal, setConfirmPersonal] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    let cancelled = false;
    loadAssetOptions(client.runtime.rpc)
      .then((list) => { if (!cancelled) setAssets(list); })
      .catch((err) => { if (!cancelled) setAssetsError(errorText(err)); });
    return () => { cancelled = true; };
  }, [client]);

  const load = useCallback(async (assetPda: string) => {
    const request = ++generation.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await readAdminCapTable(wallet, assetPda);
      if (request === generation.current) setTable(next);
    } catch (err) {
      if (request === generation.current) { setTable(null); setLoadError(errorText(err)); }
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [wallet]);

  function pick(assetPda: string) {
    setSelected(assetPda);
    setTable(null);
    if (assetPda) void load(assetPda);
  }

  async function runExport(personal: boolean) {
    if (!selected) return;
    setBusy("export");
    try {
      const file = await exportCapTable(wallet, selected, personal);
      downloadCsv(file.filename, file.csv);
      toast.show({ kind: "success", title: "Cap table exported", description: personal ? "The file names holders; the export is logged in each holder's access log." : file.filename });
    } catch (err) {
      toast.showError("Export failed", errorText(err));
    } finally {
      setBusy(null);
      setConfirmPersonal(false);
    }
  }

  async function confirmVoid(reason: string) {
    if (!voiding) return;
    setBusy("void");
    try {
      await voidRegisterEntry(wallet, voiding.id, reason.trim());
      toast.show({ kind: "success", title: "Register entry voided", description: "Record the corrected entry if one is due." });
      setVoiding(null);
      if (selected) await load(selected);
    } catch (err) {
      toast.showError("Could not void the entry", errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const missing = table?.classes.flatMap((c) => c.conversions.filter((v) => v.status === "converted" && !v.register_entry_id)) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-[280px] flex-1">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Asset</span>
          <select value={selected} onChange={(e) => pick(e.target.value)} disabled={assets === null}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none">
            <option value="">{assets === null ? "Loading assets…" : assets.length === 0 ? "No asset with a minted share class" : "Choose an asset"}</option>
            {(assets ?? []).map((a) => (
              <option key={a.pda} value={a.pda}>{a.name} · {a.assetId} · {a.symbol}</option>
            ))}
          </select>
        </label>
        <button type="button" className={buttonGhost} disabled={!selected || loading} onClick={() => void load(selected)}>
          Refresh
        </button>
        <button type="button" className={buttonGhost} disabled={!table || busy !== null} onClick={() => void runExport(false)}>
          Export CSV
        </button>
        <button type="button" className={buttonGhost} disabled={!table || busy !== null} onClick={() => setConfirmPersonal(true)}>
          Export CSV with holder names
        </button>
      </div>
      {assetsError && <p role="alert" className="text-sm text-red-600">Could not load the assets: {assetsError}</p>}

      {loading && <SkeletonCard rows={6} />}
      {loadError && !loading && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {loadError}{" "}
          <button type="button" className="font-medium underline" onClick={() => void load(selected)}>Retry</button>
        </div>
      )}

      {table && !loading && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <StateBadge state={table.state} />
            <p className="text-sm text-slate-700">
              <span className="font-medium text-slate-900">{table.name}</span> · {table.asset_id} · {table.symbol}
            </p>
          </div>
          {missing.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {missing.length === 1 ? "One converted request has" : `${missing.length} converted requests have`} no register
              entry yet. After the registry decision, use <span className="font-medium">Record register entry</span> on the
              request below.
            </div>
          )}
          <CapTableView
            table={table}
            audience="admin"
            renderClassActions={(cls) => (
              <button type="button" className={buttonGhost} onClick={() => setForm({ cls, conversion: null })}>
                + Unlinked entry
              </button>
            )}
            renderConversionActions={(v, cls) => v.status === "converted" && !v.register_entry_id ? (
              <button type="button" className={buttonDark} onClick={() => setForm({ cls, conversion: v })}>
                Record register entry
              </button>
            ) : null}
            renderEntryActions={(e) => e.status === "recorded" ? (
              <button type="button" className="text-xs font-medium text-red-700 hover:underline" onClick={() => setVoiding(e)}>
                Void
              </button>
            ) : null}
          />
        </>
      )}

      {form && table && (
        <RegisterEntryModal
          key={`${form.cls.share_class_pda}:${form.conversion?.id ?? "unlinked"}`}
          wallet={wallet}
          target={form}
          onClose={() => setForm(null)}
          onSaved={async () => {
            setForm(null);
            toast.show({ kind: "success", title: "Register entry recorded" });
            await load(table.asset_pda);
          }}
        />
      )}

      <ConfirmModal
        open={voiding !== null}
        onClose={() => { if (busy !== "void") setVoiding(null); }}
        onConfirm={confirmVoid}
        title="Void this register entry?"
        description={voiding && (
          <p>
            {formatUnits(voiding.units)} units ({voiding.percent} %), {voiding.registry} decision of {voiding.decision_date}.
            A voided entry stays on record and can never be restored; record a corrected entry afterwards.
          </p>
        )}
        confirmLabel="Void entry"
        reasonPlaceholder="Why is this entry void? (kept with the entry)"
        busy={busy === "void"}
      />

      <ConfirmModal
        open={confirmPersonal}
        onClose={() => { if (busy !== "export") setConfirmPersonal(false); }}
        onConfirm={() => runExport(true)}
        title="Export with holder names?"
        description={
          <p>
            This file adds the holders&apos; names and dossier ids to the register entries and conversions. The export is
            logged in each named holder&apos;s access log. Share it only with the accountant or counsel who need it.
          </p>
        }
        kind="warning"
        requireReason={false}
        confirmLabel="Export with names"
        busy={busy === "export"}
      />
    </div>
  );
}

function RegisterEntryModal({
  wallet,
  target,
  onClose,
  onSaved,
}: {
  wallet: WalletSession;
  target: FormTarget;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { cls, conversion } = target;
  const max = cls.chain.max_supply === null ? null : BigInt(cls.chain.max_supply);
  const [units, setUnits] = useState(conversion?.units ?? "");
  const [percent, setPercent] = useState(() => (conversion && max !== null ? percentOfSupply(BigInt(conversion.units), max) ?? "" : ""));
  const [registry, setRegistry] = useState(DEFAULT_REGISTRY);
  const [decisionRef, setDecisionRef] = useState("");
  const [decisionDate, setDecisionDate] = useState("");
  const [sha, setSha] = useState("");
  const [hashing, setHashing] = useState(false);
  const [realizeTx, setRealizeTx] = useState(conversion?.realize_tx ?? "");
  const [holderClientId, setHolderClientId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const validUnits = /^[1-9]\d{0,19}$/.test(units) ? BigInt(units) : null;
  const bps = percentToBps(percent);
  const computed = validUnits !== null && max !== null ? percentOfSupply(validUnits, max) : null;
  const unitsDiffer = conversion !== null && validUnits !== null && validUnits !== BigInt(conversion.units);
  const percentOff = bps !== null && validUnits !== null && max !== null && !bpsConsistent(bps, validUnits, max);

  async function hashFile(file: File | undefined) {
    if (!file) return;
    setHashing(true);
    try {
      setSha(await sha256HexOfFile(file));
    } catch {
      setError("Could not read the file to hash it.");
    } finally {
      setHashing(false);
    }
  }

  async function submit() {
    setError(null);
    let input;
    try {
      if (bps === null) throw new RegisterEntryInputError("Enter the percent as written in the decision (above 0 and at most 100, up to six decimals)");
      input = parseRegisterEntryInput({
        share_class_pda: cls.share_class_pda,
        units,
        percent_bps: bps,
        registry,
        decision_ref: decisionRef,
        decision_date: decisionDate,
        decision_doc_sha256: sha,
        conversion_request_id: conversion?.id ?? null,
        realize_tx: realizeTx || null,
        holder_client_id: conversion ? null : holderClientId || null,
        note,
      });
    } catch (err) {
      setError(errorText(err));
      return;
    }
    setSaving(true);
    try {
      await recordRegisterEntry(wallet, input);
      await onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  const field = "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none";
  const label = "text-xs font-medium uppercase tracking-wide text-slate-500";

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="register-entry-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p id="register-entry-title" className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Record register entry · share class #{cls.class_index}
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-slate-600">
            {conversion
              ? <>Records the registry decision behind the conversion of {formatUnits(conversion.units)} units (realize <span className="font-mono text-xs">{conversion.realize_tx?.slice(0, 8)}…</span>). Enter the figures as the decision states them.</>
              : <>An entry not linked to a conversion request. Prefer recording from a converted request; an unlinked entry is flagged until it names a realize transaction of this class.</>}
            {" "}The entry cannot be edited later: a wrong entry is voided and recorded again.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={label}>Units *</span>
              <input value={units} onChange={(e) => setUnits(e.target.value.trim())} inputMode="numeric" className={field} />
              {unitsDiffer && <span className="mt-1 block text-xs text-amber-700">The conversion moved {formatUnits(conversion!.units)} units; the reconciliation will flag a difference.</span>}
            </label>
            <label className="block">
              <span className={label}>Percent of the company *</span>
              <input value={percent} onChange={(e) => setPercent(e.target.value)} inputMode="decimal" placeholder="e.g. 2.5" className={field} />
              <span className="mt-1 block text-xs text-slate-500">
                As written in the decision.{computed !== null && <> Units ÷ max supply: {computed} %.</>}
              </span>
              {percentOff && <span className="mt-1 block text-xs text-amber-700">This differs from units ÷ max supply; the reconciliation will flag it.</span>}
            </label>
            <label className="block">
              <span className={label}>Registry *</span>
              <input value={registry} onChange={(e) => setRegistry(e.target.value)} className={field} />
            </label>
            <label className="block">
              <span className={label}>Decision reference (case number) *</span>
              <input value={decisionRef} onChange={(e) => setDecisionRef(e.target.value)} placeholder="e.g. BD 12345/2026" className={field} />
              <span className="mt-1 block text-xs text-slate-500">Shown to admins and the issuer, never publicly.</span>
            </label>
            <label className="block">
              <span className={label}>Decision date *</span>
              <input type="date" value={decisionDate} max={isoDate(new Date())} onChange={(e) => setDecisionDate(e.target.value)} className={field} />
            </label>
            <label className="block">
              <span className={label}>Decision document *</span>
              <input type="file" accept=".pdf,application/pdf,image/*" onChange={(e) => void hashFile(e.target.files?.[0])}
                className="mt-1 block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs" />
              <span className="mt-1 block text-xs text-slate-500">Hashed in this browser; the file is not uploaded.</span>
            </label>
            <label className="block sm:col-span-2">
              <span className={label}>Decision document SHA-256 *</span>
              <input value={sha} onChange={(e) => setSha(e.target.value.trim())} placeholder={hashing ? "Hashing…" : "64 hex characters, or choose the file above"}
                className={`${field} font-mono text-xs`} />
              <span className="mt-1 block text-xs text-slate-500">Published on the asset page with the conversion record.</span>
            </label>
            <label className="block sm:col-span-2">
              <span className={label}>Realize transaction</span>
              <input value={realizeTx} onChange={(e) => setRealizeTx(e.target.value.trim())} readOnly={conversion !== null}
                className={`${field} font-mono text-xs ${conversion ? "bg-slate-50 text-slate-500" : ""}`} />
            </label>
            {conversion ? (
              <p className="text-xs text-slate-500 sm:col-span-2">
                Holder: the conversion request&apos;s dossier{conversion.client_id && <> (<Link href={`/admin/clients/${conversion.client_id}`} className="underline">open</Link>)</>}, kept admin-only.
              </p>
            ) : (
              <label className="block sm:col-span-2">
                <span className={label}>Holder dossier id (optional, admin-only)</span>
                <input value={holderClientId} onChange={(e) => setHolderClientId(e.target.value.trim())} className={`${field} font-mono text-xs`} />
              </label>
            )}
            <label className="block sm:col-span-2">
              <span className={label}>Note (optional, admin-only)</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={field} />
            </label>
          </div>
          {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button type="button" className={buttonGhost} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className={buttonDark} onClick={() => void submit()} disabled={saving || hashing}>
            {saving ? "Recording…" : "Sign and record"}
          </button>
        </div>
      </div>
    </div>
  );
}
