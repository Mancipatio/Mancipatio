"use client";

// The draft editor of /issuer/updates: scope, kind, period, visibility, title
// and text, saved as a draft (POST /api/issuer-updates/save); then documents
// (uploaded to the private bucket, verified by the server, attached to the
// draft) and the publication, which freezes it. Every step validates with
// lib/issuer-updates.ts before the wallet signs; the routes check again.

import { useEffect, useState } from "react";
import type { WalletSession } from "@solana/client";
import { ConfirmModal } from "@/components/confirm-modal";
import { UpdateArticle } from "@/components/issuer-updates/update-article";
import {
  formatDocumentSize,
  ISSUER_UPDATE_KINDS,
  ISSUER_UPDATE_KIND_LABELS,
  ISSUER_UPDATE_LIMITS,
  ISSUER_UPDATE_VISIBILITY_LABELS,
  PERIOD_REQUIRED_KINDS,
  parseIssuerUpdateDraft,
  type IssuerUpdateKind,
  type IssuerUpdateRecord,
  type IssuerUpdateVisibility,
} from "@/lib/issuer-updates";
import {
  attachIssuerUpdateDocument,
  detachIssuerUpdateDocument,
  discardIssuerUpdate,
  openIssuerUpdateDocument,
  publishIssuerUpdate,
  saveIssuerUpdate,
} from "@/lib/issuer-updates-client";
import { MAX_UPLOAD_BYTES, UPLOAD_MIME_ALLOWLIST, uploadContentType } from "@/lib/storage-client";
import { useToast } from "@/lib/toast";

export type IssuerAsset = { pda: string; name: string };

type Form = {
  asset_pda: string;
  kind: IssuerUpdateKind;
  period_label: string;
  visibility: IssuerUpdateVisibility;
  title: string;
  body: string;
};

function formOf(record: IssuerUpdateRecord | null): Form {
  return {
    asset_pda: record?.asset_pda ?? "",
    kind: record?.kind ?? "update",
    period_label: record?.period_label ?? "",
    visibility: record?.visibility ?? "public",
    title: record?.title ?? "",
    body: record?.body ?? "",
  };
}

const INPUT = "input-base w-full";
const LABEL = "mb-1.5 block text-xs font-medium text-slate-700";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function DraftEditor({ session, issuerPda, assets, record, canCompose, onChanged, onDiscarded, onClose }: {
  session: WalletSession;
  issuerPda: string;
  assets: IssuerAsset[];
  /** null: a new draft. */
  record: IssuerUpdateRecord | null;
  /** Issuance is on and the issuer is verified: saving, documents and publishing are offered. */
  canCompose: boolean;
  onChanged: (record: IssuerUpdateRecord) => void;
  onDiscarded: (id: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState<Form>(() => formOf(record));
  const [busy, setBusy] = useState<null | "save" | "upload" | "publish" | "discard" | string>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "publish" | "discard">(null);
  const saved = formOf(record);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const update = (patch: Partial<Form>) => {
    setForm((current) => ({ ...current, ...patch }));
    setProblem(null);
  };

  function validated() {
    try {
      const draft = parseIssuerUpdateDraft({ ...form, asset_pda: form.asset_pda || null, period_label: form.period_label || null });
      setProblem(null);
      return draft;
    } catch (err) {
      setProblem(message(err));
      return null;
    }
  }

  async function save() {
    const draft = validated();
    if (!draft || busy) return;
    setBusy("save");
    try {
      const next = await saveIssuerUpdate(session, { issuer: issuerPda, update: draft, id: record?.id ?? null, expectedUpdatedAt: record?.updated_at ?? null });
      setForm(formOf(next));
      onChanged(next);
      toast.show({ kind: "success", title: "Draft saved", description: "Only you can see it until you publish it." });
    } catch (err) {
      setProblem(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File | undefined) {
    if (!file || !record || busy) return;
    if (file.size > MAX_UPLOAD_BYTES) return setProblem("A document is at most 25 MB.");
    if (!(UPLOAD_MIME_ALLOWLIST as readonly string[]).includes(uploadContentType(file))) return setProblem("Attach a PDF, PNG, JPG or DOCX file.");
    if (record.documents.length >= ISSUER_UPDATE_LIMITS.documents) return setProblem(`An update carries at most ${ISSUER_UPDATE_LIMITS.documents} documents.`);
    setBusy("upload");
    setProblem(null);
    try {
      const next = await attachIssuerUpdateDocument(session, { issuer: issuerPda, updateId: record.id, file });
      onChanged(next);
      toast.show({ kind: "success", title: "Document attached", description: "The server verified the file's SHA-256." });
    } catch (err) {
      setProblem(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(documentId: string) {
    if (busy) return;
    setBusy(documentId);
    try {
      onChanged(await detachIssuerUpdateDocument(session, documentId));
    } catch (err) {
      setProblem(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!record || busy) return;
    setBusy("publish");
    try {
      const next = await publishIssuerUpdate(session, record);
      setConfirm(null);
      onChanged(next);
      toast.show({ kind: "success", title: "Update published", description: "It is now shown to its readers." });
      onClose();
    } catch (err) {
      setConfirm(null);
      setProblem(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    if (!record || busy) return;
    setBusy("discard");
    try {
      await discardIssuerUpdate(session, record);
      setConfirm(null);
      onDiscarded(record.id);
    } catch (err) {
      setConfirm(null);
      setProblem(message(err));
    } finally {
      setBusy(null);
    }
  }

  const periodRequired = PERIOD_REQUIRED_KINDS.has(form.kind);
  const working = busy !== null;
  const assetName = (pda: string | null) => (pda ? assets.find((a) => a.pda === pda)?.name ?? `${pda.slice(0, 6)}…` : "every asset of your issuer");

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card" aria-labelledby="draft-editor-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="draft-editor-title" className="text-lg font-semibold text-slate-900">{record ? "Edit draft" : "New update"}</h2>
          <p className="mt-1 text-sm text-slate-600">Drafts are private. Once published, an update cannot be edited; you can withdraw it with a reason.</p>
        </div>
        <button type="button" onClick={() => (!dirty || window.confirm("Discard your unsaved changes?")) && onClose()} className="btn-ghost" disabled={working}>
          Close
        </button>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL}>Concerns</span>
          <select className={INPUT} value={form.asset_pda} onChange={(e) => update({ asset_pda: e.target.value })} disabled={!canCompose || working}>
            <option value="">Every asset of your issuer</option>
            {assets.map((a) => <option key={a.pda} value={a.pda}>{a.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Kind</span>
          <select className={INPUT} value={form.kind} onChange={(e) => update({ kind: e.target.value as IssuerUpdateKind })} disabled={!canCompose || working}>
            {ISSUER_UPDATE_KINDS.map((k) => <option key={k} value={k}>{ISSUER_UPDATE_KIND_LABELS[k]}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Period {periodRequired ? "(required)" : "(optional)"}</span>
          <input className={INPUT} value={form.period_label} maxLength={ISSUER_UPDATE_LIMITS.period} placeholder="Q3 2026"
            onChange={(e) => update({ period_label: e.target.value })} disabled={!canCompose || working} />
        </label>
        <fieldset>
          <legend className={LABEL}>Who can read it</legend>
          <div className="flex flex-wrap gap-4 pt-1.5 text-sm text-slate-700">
            {(["public", "holders"] as const).map((v) => (
              <label key={v} className="inline-flex items-center gap-2">
                <input type="radio" name="visibility" value={v} checked={form.visibility === v} onChange={() => update({ visibility: v })} disabled={!canCompose || working} />
                {ISSUER_UPDATE_VISIBILITY_LABELS[v]}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {form.visibility === "holders"
              ? "Shown only to wallets that hold units of the asset (any of your assets for an issuer-wide update), checked on chain."
              : "Shown to everyone on the asset page."}
          </p>
        </fieldset>
      </div>

      <label className="mt-4 block">
        <span className={LABEL}>Title</span>
        <input className={INPUT} value={form.title} maxLength={ISSUER_UPDATE_LIMITS.title} onChange={(e) => update({ title: e.target.value })} disabled={!canCompose || working} />
        <span className="mt-1 block text-right text-[11px] text-slate-400">{form.title.length} / {ISSUER_UPDATE_LIMITS.title}</span>
      </label>
      <label className="block">
        <span className={LABEL}>Text</span>
        <textarea className={`${INPUT} min-h-[220px] leading-relaxed`} value={form.body} maxLength={ISSUER_UPDATE_LIMITS.body}
          onChange={(e) => update({ body: e.target.value })} disabled={!canCompose || working} />
        <span className="mt-1 flex justify-between text-[11px] text-slate-400">
          <span>Plain text; separate paragraphs with an empty line.</span>
          <span>{form.body.length.toLocaleString("en-US")} / {ISSUER_UPDATE_LIMITS.body.toLocaleString("en-US")}</span>
        </span>
      </label>

      {problem && <p role="alert" className="mt-3 text-sm text-red-600">{problem}</p>}

      {(canCompose || record) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {canCompose && (
            <button type="button" onClick={() => void save()} disabled={working || (!dirty && !!record)} className="btn-brand disabled:opacity-50">
              {busy === "save" ? "Saving…" : record ? "Save changes" : "Save draft"}
            </button>
          )}
          {canCompose && record && (
            <button type="button" onClick={() => setConfirm("publish")} disabled={working || dirty} className="btn-ghost disabled:opacity-50"
              title={dirty ? "Save your changes first" : undefined}>
              Review and publish
            </button>
          )}
          {/* Discarding is a take-down: offered even while composing is paused. */}
          {record && (
            <button type="button" onClick={() => setConfirm("discard")} disabled={working} className="btn-ghost text-red-700 disabled:opacity-50">
              Discard draft
            </button>
          )}
        </div>
      )}

      {record && (
        <div className="mt-6 border-t border-slate-100 pt-4">
          <h3 className="text-sm font-semibold text-slate-900">Documents ({record.documents.length} / {ISSUER_UPDATE_LIMITS.documents})</h3>
          <p className="mt-1 text-xs text-slate-500">
            PDF, PNG, JPG or DOCX up to 25 MB. The file is stored privately and the server records its SHA-256; readers can check the
            file they download against it. Uploading asks your wallet to sign three times.
          </p>
          {record.documents.length > 0 && (
            <ul className="mt-3 space-y-2">
              {record.documents.map((doc) => (
                <li key={doc.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block break-all font-medium text-slate-800">{doc.file_name}</span>
                    <span className="block text-xs text-slate-500">{formatDocumentSize(doc.size_bytes)} · SHA-256 <code className="font-mono" title={doc.sha256}>{doc.sha256.slice(0, 12)}…</code></span>
                  </span>
                  <span className="flex gap-3 text-xs">
                    <button type="button" className="text-brand-700 hover:underline" onClick={() => void openIssuerUpdateDocument(session, doc.id).catch((err) => setProblem(message(err)))}>
                      Open ↗
                    </button>
                    {canCompose && (
                      <button type="button" className="text-red-700 hover:underline disabled:opacity-50" disabled={working} onClick={() => void remove(doc.id)}>
                        {busy === doc.id ? "Removing…" : "Remove"}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canCompose && record.documents.length < ISSUER_UPDATE_LIMITS.documents && (
            <label className="mt-3 inline-flex items-center gap-2 text-xs text-slate-600">
              <span className="btn-ghost">{busy === "upload" ? "Uploading and verifying…" : "Attach a document"}</span>
              <input type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.docx" disabled={working}
                onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirm === "publish" && !!record}
        onClose={() => setConfirm(null)}
        onConfirm={() => publish()}
        title="Publish this update"
        kind="warning"
        requireReason={false}
        confirmLabel="Publish"
        busy={busy === "publish"}
        busyLabel="Publishing…"
        description={record ? (
          <div className="space-y-3">
            <p>
              It will be shown {record.visibility === "holders" ? "to holders of" : "on the page of"} {assetName(record.asset_pda)} from now on, exactly as below.
              A published update cannot be edited; you can withdraw it later with a reason, and the record of it stays.
            </p>
            <div className="max-h-[45vh] overflow-y-auto">
              <UpdateArticle update={record} variant="workspace" expanded />
            </div>
          </div>
        ) : null}
      />
      <ConfirmModal
        open={confirm === "discard" && !!record}
        onClose={() => setConfirm(null)}
        onConfirm={() => discard()}
        title="Discard this draft"
        requireReason={false}
        confirmLabel="Discard"
        busy={busy === "discard"}
        busyLabel="Discarding…"
        description="The draft and its document list are deleted. Nothing was published."
      />
    </section>
  );
}
