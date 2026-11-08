"use client";

// "New certificate" on /admin/certificates: pick the kind, the share class
// (every class with a mint, from the chain) and, for a holding, the wallet;
// Preview reads the chain on the server and prefills the company's details
// and the scale; the admin checks or corrects them, adds the holder's name
// and ID number only if this certificate needs them, and creates the draft
// (a fresh wallet signature: it spends the next number). Create is offered
// only for exactly what was last previewed, so the admin has seen the
// statement the draft will carry; the server reads the chain again at
// creation and states the slot it read.

import { useEffect, useState } from "react";
import type { WalletSession } from "@solana/client";
import { useSolanaClient } from "@solana/react-hooks";
import { findAssetPda, type Asset } from "@/lib/generated/asset_registry";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { findShareClassPda } from "@/lib/pdas";
import { ConfirmModal } from "@/components/confirm-modal";
import { createCertificate, previewCertificate } from "@/lib/certificates-client";
import { certificateTokenSymbol, type CertificateDetail, type CertificatePreview } from "@/lib/certificates/payload";
import { formatTokens } from "@/lib/tokenize-shares";
import {
  EMPTY_CERTIFICATE_FORM,
  certificateFormParams,
  prefillSourceLabel,
  withPrefill,
  type CertificateForm,
} from "./certificate-form";

const inputClass = "input-base w-full";
const labelClass = "mb-1.5 block text-xs font-medium text-slate-700";
const hintClass = "mt-1 block text-[11px] text-slate-500";

type ClassOption = { pda: string; label: string };
type Rpc = ReturnType<typeof useSolanaClient>["runtime"]["rpc"];

/** Every share class with a mint, labelled "<asset> · <symbol> · class <n>". */
async function loadClassOptions(rpc: Rpc): Promise<ClassOption[]> {
  const data = await loadNetworkPreferIndexer(() => loadNetwork(rpc));
  const assets = new Map<string, Asset>();
  for (const asset of data.assets) {
    const [pda] = await findAssetPda({ issuer: asset.issuer, assetId: asset.assetId });
    assets.set(pda.toString(), asset);
  }
  const options: ClassOption[] = [];
  for (const shareClass of data.shareClasses) {
    if (!shareClass.mintInitialized) continue;
    const asset = assets.get(shareClass.asset.toString());
    const pda = await findShareClassPda(shareClass.asset, shareClass.classIndex);
    options.push({
      pda: pda.toString(),
      label: asset
        ? `${asset.name} · ${certificateTokenSymbol(asset.symbolPrefix, shareClass.classIndex)} · class ${shareClass.classIndex} (${asset.assetId})`
        : `Class ${shareClass.classIndex} of ${shareClass.asset.toString()}`,
    });
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

const formKey = (form: CertificateForm) => JSON.stringify(certificateFormParams(form));

export function NewCertificateForm({ session, onCreated }: { session: WalletSession; onCreated: (detail: CertificateDetail) => void }) {
  const client = useSolanaClient();
  const [options, setOptions] = useState<ClassOption[] | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [form, setForm] = useState<CertificateForm>(EMPTY_CERTIFICATE_FORM);
  const [preview, setPreview] = useState<{ key: string; data: CertificatePreview } | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "create">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadClassOptions(client.runtime.rpc).then(
      (loaded) => {
        if (!cancelled) setOptions(loaded);
      },
      (err) => {
        if (!cancelled) setOptionsError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const update = (patch: Partial<CertificateForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const current = preview && preview.key === formKey(form) ? preview.data : null;
  const holding = form.kind === "holding";

  async function runPreview() {
    if (busy) return;
    setBusy("preview");
    setError(null);
    try {
      const data = await previewCertificate(session, certificateFormParams(form));
      // The server merged what was typed with its prefill field by field; the
      // form now shows exactly what it previewed.
      const filled = withPrefill(form, data.prefill);
      setForm(filled);
      setPreview({ key: formKey(filled), data });
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    if (busy || !current?.payload) return;
    setBusy("create");
    setError(null);
    try {
      const detail = await createCertificate(session, certificateFormParams(form));
      setConfirmOpen(false);
      setForm(EMPTY_CERTIFICATE_FORM);
      setPreview(null);
      onCreated(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const source = current ? prefillSourceLabel(current.prefill.company_source) : null;
  return (
    <form
      className="panel min-w-0"
      onSubmit={(event) => {
        event.preventDefault();
        void runPreview();
      }}
    >
      <div className="border-b border-slate-100 p-5">
        <h2 className="text-base font-semibold text-slate-900">New certificate</h2>
        <p className="mt-1 text-xs text-slate-500">
          Preview reads the chain and fills in what the platform already knows. Check every field: the draft you create is
          what the signer signs.
        </p>
      </div>
      <fieldset disabled={busy !== null} className="min-w-0 space-y-5 p-5 disabled:opacity-70">
        <div className="flex flex-wrap gap-4 text-sm">
          {(["holding", "issuance"] as const).map((kind) => (
            <label key={kind} className="flex items-center gap-2">
              <input type="radio" name="certificate-kind" checked={form.kind === kind} onChange={() => update({ kind })} />
              {kind === "holding" ? "Holding: the units a wallet holds" : "Issuance: the share class as issued"}
            </label>
          ))}
        </div>

        <label className="block">
          <span className={labelClass}>Share class</span>
          <select className={inputClass} value={form.shareClass} onChange={(event) => update({ shareClass: event.target.value })} required>
            <option value="">{options === null ? (optionsError ? "Could not load the share classes" : "Loading share classes…") : "Choose a share class"}</option>
            {(options ?? []).map((option) => (
              <option key={option.pda} value={option.pda}>
                {option.label}
              </option>
            ))}
          </select>
          {optionsError && <span className="mt-1 block text-[11px] text-red-700">{optionsError}</span>}
        </label>

        {holding && (
          <label className="block">
            <span className={labelClass}>Holder&apos;s wallet</span>
            <input className={`${inputClass} font-mono text-xs`} value={form.wallet} onChange={(event) => update({ wallet: event.target.value })} placeholder="Wallet address" spellCheck={false} autoComplete="off" required />
          </label>
        )}

        <section aria-labelledby="certificate-company" className="space-y-3">
          <div>
            <h3 id="certificate-company" className="text-sm font-medium text-slate-900">Company</h3>
            <p className="mt-1 text-[11px] text-slate-500">
              The company whose interest the asset concerns, as its register records it.{source ? ` Prefilled ${source}: check it.` : ""}
            </p>
          </div>
          <label className="block">
            <span className={labelClass}>Legal name</span>
            <input className={inputClass} maxLength={200} value={form.legalName} onChange={(event) => update({ legalName: event.target.value })} />
          </label>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,0.6fr)_minmax(0,1.4fr)]">
            <label className="block">
              <span className={labelClass}>Registration number</span>
              <input className={inputClass} maxLength={64} value={form.registrationNumber} onChange={(event) => update({ registrationNumber: event.target.value })} />
            </label>
            <label className="block">
              <span className={labelClass}>Registered address</span>
              <input className={inputClass} maxLength={300} value={form.address} onChange={(event) => update({ address: event.target.value })} />
            </label>
          </div>
          <label className="block">
            <span className={labelClass}>Units for 100 % of the company</span>
            <input className={`${inputClass} font-mono`} inputMode="numeric" value={form.unitsFor100Percent} onChange={(event) => update({ unitsFor100Percent: event.target.value })} placeholder="10000" />
            <span className={hintClass}>
              The scale of the units: 10000 means 1 unit = 0.01 % of the company.
              {current?.prefill.scale_source ? ` Prefilled from the ${current.prefill.scale_source === "certificate" ? "last certificate" : "tokenization record"}.` : ""}
            </span>
          </label>
        </section>

        {holding && (
          <section aria-labelledby="certificate-holder" className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
            <div>
              <h3 id="certificate-holder" className="text-sm font-medium text-slate-900">Holder&apos;s name and ID number (optional)</h3>
              <p className="mt-1 text-[11px] text-slate-600">
                Personal data: fill these in only when this certificate must name the holder (for example for an authority).
                They are printed on the certificate and kept with it, visible to admins only, never on the public page.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={labelClass}>Full name</span>
                <input className={inputClass} maxLength={200} value={form.holderName} onChange={(event) => update({ holderName: event.target.value })} autoComplete="off" />
              </label>
              <label className="block">
                <span className={labelClass}>Identification number</span>
                <input className={inputClass} maxLength={64} value={form.holderIdNumber} onChange={(event) => update({ holderIdNumber: event.target.value })} autoComplete="off" />
              </label>
            </div>
          </section>
        )}

        <label className="block">
          <span className={labelClass}>
            Evidence transactions <span className="font-normal text-slate-500">(optional)</span>
          </span>
          <textarea
            className={`${inputClass} min-h-20 resize-y font-mono text-xs`}
            rows={3}
            value={form.evidence}
            onChange={(event) => update({ evidence: event.target.value })}
            placeholder="One transaction signature per line, then an optional note, e.g. 5RBD…qm Transfer of 500 units"
            spellCheck={false}
          />
          <span className={hintClass}>Up to 10. Each must be finalized and successful on this network.</span>
        </label>
      </fieldset>

      <div className="space-y-4 border-t border-slate-100 p-5">
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </p>
        )}
        {current && <PreviewCard preview={current} />}
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className={current ? "btn-ghost" : "btn-brand"} disabled={busy !== null || !form.shareClass}>
            {busy === "preview" ? "Reading the chain…" : current ? "Preview again" : "Preview"}
          </button>
          <button type="button" className="btn-brand disabled:cursor-not-allowed disabled:opacity-50" disabled={busy !== null || !current?.payload} onClick={() => setConfirmOpen(true)}>
            Create draft
          </button>
        </div>
        <p className="text-[11px] text-slate-500">
          {preview && !current ? "The form changed since the preview: preview again before you create the draft. " : ""}
          Creating a draft asks your wallet to sign the request and takes the next certificate number. Nothing is public until the
          draft is signed.
        </p>
      </div>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => create()}
        title="Create a certificate draft"
        kind="info"
        requireReason={false}
        confirmLabel="Create draft"
        busy={busy === "create"}
        description={
          <div className="space-y-2 text-[13px]">
            <p>This takes the next certificate number of this year and stores the draft with you as its signer.</p>
            <p>The server reads the chain again now; the draft states the slot it read. You sign the draft next, from its page.</p>
          </div>
        }
      />
    </form>
  );
}

function PreviewCard({ preview }: { preview: CertificatePreview }) {
  const { facts, payload, problem } = preview;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-[13px]">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Preview</p>
      <dl className="mt-2 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-slate-500">Asset</dt>
        <dd className="text-slate-900">
          {facts.asset_id} · {facts.asset_name} · {facts.symbol}, class {facts.class_index}
        </dd>
        <dt className="text-slate-500">Token mint</dt>
        <dd className="break-all font-mono text-xs text-slate-900">{facts.mint}</dd>
        <dt className="text-slate-500">Maximum supply</dt>
        <dd className="text-slate-900">{facts.max_supply === null ? "No maximum" : formatTokens(BigInt(facts.max_supply))}</dd>
        {facts.holding && (
          <>
            <dt className="text-slate-500">Units held</dt>
            <dd className="text-slate-900">
              {formatTokens(BigInt(facts.holding.units))}
              {payload?.holding ? ` = ${payload.holding.percent_of_company} % of the company` : ""} (slot {facts.holding.slot})
            </dd>
          </>
        )}
        {facts.supply && (
          <>
            <dt className="text-slate-500">In circulation</dt>
            <dd className="text-slate-900">
              {formatTokens(BigInt(facts.supply.circulating))}
              {payload?.supply ? ` = ${payload.supply.circulating_percent} % of the company` : ""}, {formatTokens(BigInt(facts.lifetime_minted))} issued to date (slot{" "}
              {facts.supply.slot})
            </dd>
          </>
        )}
      </dl>
      {problem ? (
        <p className="mt-3 text-sm text-amber-800">{problem}</p>
      ) : payload ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-slate-600">The certificate will state:</p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-800">{payload.statement}</p>
        </div>
      ) : null}
    </div>
  );
}
