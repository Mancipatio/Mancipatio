"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletSession } from "@solana/client";
import { useWalletConnection } from "@solana/react-hooks";
import { signedFetch } from "@/lib/siws-client";
import { detectNetwork } from "@/lib/network";
import {
  parseAssistantKnowledgeSave,
  type AssistantKnowledgeAdminEntry,
  type AssistantKnowledgeCategory,
  type AssistantKnowledgeStatus,
} from "@/lib/assistant/knowledge-admin";
import { knowledgeForm, knowledgeSaveParams, knowledgeSlug, type KnowledgeForm } from "./editor-form";

const CATEGORIES: Record<AssistantKnowledgeCategory, string> = {
  answer: "Answer", policy: "Policy", procedure: "Procedure",
};
const inputClass = "input-base w-full";
const labelClass = "mb-1.5 block text-xs font-medium text-slate-700";
const secondaryClass = "btn-ghost disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass = "btn-brand disabled:cursor-not-allowed disabled:opacity-50";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export function KnowledgeEditor() {
  const { wallet } = useWalletConnection();
  if (!wallet) return null;
  // Drafts and outstanding responses belong only to the wallet that opened them.
  return <WalletKnowledgeEditor key={`${detectNetwork()}:${wallet.account.address}`} wallet={wallet} />;
}

function WalletKnowledgeEditor({ wallet }: { wallet: WalletSession }) {
  const [entries, setEntries] = useState<AssistantKnowledgeAdminEntry[] | null>(null);
  const [selected, setSelected] = useState<AssistantKnowledgeAdminEntry | null>(null);
  const [form, setForm] = useState<KnowledgeForm | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | AssistantKnowledgeStatus>("all");
  const [category, setCategory] = useState<"all" | AssistantKnowledgeCategory>("all");
  const [busy, setBusy] = useState<"load" | "save" | "delete" | null>("load");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewPublish, setReviewPublish] = useState(false);
  const operation = useRef(false);
  const generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const currentSession = useRef(wallet);

  useEffect(() => { currentSession.current = wallet; }, [wallet]);

  const dirty = form !== null && JSON.stringify(form) !== JSON.stringify(knowledgeForm(selected));

  const load = useCallback(async (interactive: boolean, selectedId?: string) => {
    if (operation.current) return;
    operation.current = true;
    const request = ++generation.current;
    setBusy("load");
    setLoadError(null);
    try {
      const data = await signedFetch<{ entries: AssistantKnowledgeAdminEntry[] }>(
        currentSession.current, "/api/admin/assistant-knowledge/list", "assistantKnowledge.list", {},
        { interactive: interactive ? true : "session-only" },
      );
      if (request !== generation.current) return;
      const next = selectedId ? data.entries.find((entry) => entry.id === selectedId) ?? null : data.entries[0] ?? null;
      setEntries(data.entries);
      setSelected(next);
      setForm(next ? knowledgeForm(next) : null);
      setReviewPublish(false);
      setEditError(null);
      setNotice(null);
    } catch (error) {
      if (request === generation.current) setLoadError(errorMessage(error));
    } finally {
      if (request === generation.current) {
        operation.current = false;
        setBusy(null);
      }
    }
  }, []);

  useEffect(() => {
    // A background load uses an existing session; signing starts from Retry.
    void load(false);
    return () => { generation.current += 1; operation.current = false; };
  }, [load]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  function mayDiscard() {
    return !dirty || window.confirm("Discard your unsaved changes?");
  }

  function openEntry(entry: AssistantKnowledgeAdminEntry | null) {
    if (operation.current || !mayDiscard()) return;
    setSelected(entry);
    setForm(knowledgeForm(entry));
    setEditError(null);
    setNotice(null);
    setReviewPublish(false);
    requestAnimationFrame(() => heading.current?.focus());
  }

  function updateForm(update: Partial<KnowledgeForm>) {
    setForm((current) => current ? { ...current, ...update } : current);
    setReviewPublish(false);
    setEditError(null);
    setNotice(null);
  }

  function validate(status: AssistantKnowledgeStatus) {
    if (!form) return null;
    try {
      const params = parseAssistantKnowledgeSave(knowledgeSaveParams(form, selected, status));
      setEditError(null);
      return params;
    } catch (error) {
      setEditError(errorMessage(error));
      return null;
    }
  }

  async function save(status: AssistantKnowledgeStatus) {
    if (operation.current) return;
    const params = validate(status);
    if (!params) return;
    if (status === "draft" && selected?.status === "published" &&
        !window.confirm("Save this entry as a draft? It will be removed from public answers until you publish it again.")) return;
    operation.current = true;
    const request = ++generation.current;
    setBusy("save");
    setNotice(null);
    if (status === "draft") setReviewPublish(false);
    try {
      const { entry } = await signedFetch<{ entry: AssistantKnowledgeAdminEntry }>(
        wallet, "/api/admin/assistant-knowledge/save", "assistantKnowledge.save", params,
      );
      if (request !== generation.current) return;
      setEntries((current) => [entry, ...(current ?? []).filter((item) => item.id !== entry.id)]);
      setSelected(entry);
      setForm(knowledgeForm(entry));
      setReviewPublish(false);
      setNotice(status === "published" ? "Published. This entry is available to Ask Manci." : "Draft saved. This entry is private.");
    } catch (error) {
      if (request === generation.current) setEditError(errorMessage(error));
    } finally {
      if (request === generation.current) { operation.current = false; setBusy(null); }
    }
  }

  async function deleteDraft() {
    if (operation.current || !selected || selected.status !== "draft") return;
    if (!window.confirm(`Delete the draft “${selected.title}”${dirty ? " and your unsaved changes" : ""}? This cannot be undone.`)) return;
    operation.current = true;
    const request = ++generation.current;
    setBusy("delete");
    setEditError(null);
    setNotice(null);
    try {
      await signedFetch(wallet, "/api/admin/assistant-knowledge/delete", "assistantKnowledge.delete", {
        id: selected.id, expected_updated_at: selected.updated_at,
      });
      if (request !== generation.current) return;
      setEntries((current) => (current ?? []).filter((entry) => entry.id !== selected.id));
      setSelected(null);
      setForm(null);
      setNotice("Draft deleted.");
    } catch (error) {
      if (request === generation.current) setEditError(errorMessage(error));
    } finally {
      if (request === generation.current) { operation.current = false; setBusy(null); }
    }
  }

  const search = query.trim().toLowerCase();
  const filtered = (entries ?? []).filter((entry) =>
    (filter === "all" || entry.status === filter) &&
    (category === "all" || entry.category === category) &&
    (!search || [entry.title, entry.id, entry.body, ...entry.keywords].some((text) => text.toLowerCase().includes(search))),
  );
  const published = entries?.filter((entry) => entry.status === "published").length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500" aria-live="polite">
          {entries ? `${published} published · ${entries.length - published} drafts` : "Knowledge library"}
        </p>
        <div className="flex gap-2">
          <button type="button" className={secondaryClass} disabled={busy !== null} onClick={() => {
            if (mayDiscard()) void load(true, selected?.id);
          }}>{busy === "load" ? "Loading…" : "Reload"}</button>
          <button type="button" className={primaryClass} disabled={busy !== null || entries === null} onClick={() => openEntry(null)}>New entry</button>
        </div>
      </div>

      {loadError && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-medium">Could not load the knowledge library</p>
        <p className="mt-1 text-xs">{loadError}</p>
        {entries && <p className="mt-1 text-xs">The entries below are from your last successful load.</p>}
        <button type="button" className={`${secondaryClass} mt-3`} disabled={busy !== null} onClick={() => {
          if (mayDiscard()) void load(true, selected?.id);
        }}>Retry loading</button>
      </div>}

      {notice && <p role="status" className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900">{notice}</p>}
      {entries === null ? (!loadError && <p role="status" className="panel panel-pad text-sm text-slate-500">Loading knowledge…</p>) : (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.8fr)]">
          <section aria-label="Knowledge entries" className="panel min-w-0 overflow-hidden">
            <div className="space-y-3 border-b border-slate-100 p-4">
              <label className="block">
                <span className={labelClass}>Search the library</span>
                <input type="search" className={inputClass} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, keyword, or content" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label><span className={labelClass}>Status</span><select className={inputClass} value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
                  <option value="all">All statuses</option><option value="published">Published</option><option value="draft">Drafts</option>
                </select></label>
                <label><span className={labelClass}>Category</span><select className={inputClass} value={category} onChange={(event) => setCategory(event.target.value as typeof category)}>
                  <option value="all">All categories</option>{Object.entries(CATEGORIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></label>
              </div>
            </div>
            <ul className="max-h-[35rem] divide-y divide-slate-100 overflow-y-auto">
              {filtered.map((entry) => <li key={entry.id}>
                <button type="button" aria-current={selected?.id === entry.id ? "true" : undefined} disabled={busy !== null}
                  onClick={() => { if (selected?.id !== entry.id) openEntry(entry); }}
                  className={`w-full px-4 py-3 text-left transition-colors disabled:opacity-60 ${selected?.id === entry.id ? "bg-brand-50" : "hover:bg-slate-50"}`}>
                  <span className="block text-sm font-medium leading-5 text-slate-900">{entry.title}</span>
                  <span className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-500"><StatusBadge status={entry.status} />{CATEGORIES[entry.category]}</span>
                </button>
              </li>)}
            </ul>
            {filtered.length === 0 && <p className="p-6 text-center text-sm text-slate-500">{entries.length ? "No entries match these filters." : "No entries yet. Create an answer, policy, or procedure to get started."}</p>}
          </section>

          {!form ? <div className="panel panel-pad text-sm text-slate-500">Select an entry or create a new one.</div> : (
            <form className="panel min-w-0" onSubmit={(event) => { event.preventDefault(); if (selected?.status === "published") { if (validate("published")) setReviewPublish(true); } else void save("draft"); }}>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 p-5">
                <div>
                  <h2 ref={heading} tabIndex={-1} className="text-base font-semibold text-slate-900 outline-none">{selected ? "Edit entry" : "New entry"}</h2>
                  <p className="mt-1 text-xs text-slate-500">{selected ? `Last saved ${new Date(selected.updated_at).toLocaleString("en-GB")}` : "New entries start as private drafts."}</p>
                </div>
                <div className="flex items-center gap-2"><StatusBadge status={selected?.status ?? "draft"} />{dirty && <span className="text-[11px] text-amber-700">Unsaved changes</span>}</div>
              </div>
              <fieldset disabled={busy !== null} className="min-w-0 space-y-5 p-5 disabled:opacity-70">
                <label className="block"><span className={labelClass}>Title</span>
                  <input className={inputClass} required maxLength={180} value={form.title} onChange={(event) => {
                    const title = event.target.value;
                    updateForm({ title, ...(!selected && (!form.id || form.id === knowledgeSlug(form.title)) ? { id: knowledgeSlug(title) } : {}) });
                  }} placeholder="For example, How ownership works" />
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label><span className={labelClass}>Category</span><select className={inputClass} value={form.category} onChange={(event) => updateForm({ category: event.target.value as AssistantKnowledgeCategory })}>
                    {Object.entries(CATEGORIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select></label>
                  <label><span className={labelClass}>Entry ID</span><input className={`${inputClass} font-mono text-xs`} required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" readOnly={selected !== null} value={form.id} onChange={(event) => updateForm({ id: event.target.value })} aria-describedby="entry-id-help" />
                    <span id="entry-id-help" className="mt-1 block text-[11px] text-slate-500">{selected ? "The ID stays the same after creation." : "Lowercase letters, numbers, and hyphens."}</span>
                  </label>
                </div>
                <label className="block"><span className={labelClass}>Keywords</span><input className={inputClass} value={form.keywords} maxLength={3280} onChange={(event) => updateForm({ keywords: event.target.value })} placeholder="ownership, shares, investor rights" aria-describedby="keywords-help" />
                  <span id="keywords-help" className="mt-1 block text-[11px] text-slate-500">Separate up to 40 keywords or short phrases with commas.</span>
                </label>
                <label className="block"><span className={labelClass}>Content</span><textarea className={`${inputClass} min-h-56 resize-y leading-relaxed`} required rows={12} maxLength={12000} value={form.body} onChange={(event) => updateForm({ body: event.target.value })} placeholder="Write the approved answer or describe the policy or procedure in clear English." aria-describedby="content-help" />
                  <span id="content-help" className="mt-1 flex justify-between gap-3 text-[11px] text-slate-500"><span>Use plain text. Keep personal or confidential information out of public entries.</span><span className="shrink-0">{form.body.length.toLocaleString("en-GB")} / 12,000</span></span>
                </label>

                <section aria-labelledby="sources-heading" className="space-y-3">
                  <div className="flex items-center justify-between gap-3"><div><h3 id="sources-heading" className="text-sm font-medium text-slate-900">Sources</h3><p className="mt-1 text-[11px] text-slate-500">Add at least one public source before publishing.</p></div>
                    <button type="button" className={secondaryClass} disabled={form.sources.length >= 12} onClick={() => updateForm({ sources: [...form.sources, { title: "", href: "", section: "" }] })}>Add source</button>
                  </div>
                  {form.sources.map((source, index) => <fieldset key={index} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <legend className="px-1 text-[11px] font-medium text-slate-500">Source {index + 1}</legend>
                    <label className="block"><span className={labelClass}>Source title</span><input className={inputClass} required maxLength={180} value={source.title} onChange={(event) => updateForm({ sources: form.sources.map((item, i) => i === index ? { ...item, title: event.target.value } : item) })} /></label>
                    <label className="block"><span className={labelClass}>Public link</span><input className={inputClass} required maxLength={1000} value={source.href} onChange={(event) => updateForm({ sources: form.sources.map((item, i) => i === index ? { ...item, href: event.target.value } : item) })} placeholder="/legal-structure or https://…" /></label>
                    <div className="flex items-end gap-3"><label className="min-w-0 flex-1"><span className={labelClass}>Section <span className="font-normal text-slate-500">(optional)</span></span><input className={inputClass} maxLength={240} value={source.section} onChange={(event) => updateForm({ sources: form.sources.map((item, i) => i === index ? { ...item, section: event.target.value } : item) })} placeholder="Page or section reference" /></label>
                      <button type="button" className="px-2 py-2 text-xs font-medium text-red-700 hover:underline" aria-label={`Remove source ${index + 1}`} onClick={() => updateForm({ sources: form.sources.filter((_, i) => i !== index) })}>Remove</button>
                    </div>
                  </fieldset>)}
                </section>

                {selected?.provenance && selected.provenance.length > 0 && <details className="text-xs text-slate-500"><summary className="cursor-pointer font-medium">Original material references</summary><ul className="mt-2 space-y-1">{selected.provenance.map((source, index) => <li key={index}>{source.title} · {source.section} · {source.date}</li>)}</ul><p className="mt-2">These references are preserved when you save.</p></details>}
                <details className="rounded-lg border border-slate-200 p-3 text-sm"><summary className="cursor-pointer font-medium text-slate-700">Preview content</summary><div className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{form.body.trim() || "Your content will appear here."}</div></details>
                {selected?.status === "published" && <p className="text-xs leading-relaxed text-slate-500">This entry is live. Publish changes to update it, or save it as a draft to remove it from public answers.</p>}
              </fieldset>

              <div className="space-y-4 border-t border-slate-100 p-5">
                {editError && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"><p>{editError}</p><p className="mt-1 text-xs">Your edits are still here. Reload only when you are ready to discard them and load the latest version.</p></div>}
                {reviewPublish && <div className="rounded-lg border border-brand-200 bg-brand-50 p-4">
                  <h3 className="text-sm font-semibold text-brand-900">Ready to publish?</h3>
                  <p className="mt-1 text-xs leading-relaxed text-brand-900">This content and its sources will be available to everyone through Ask Manci and the public answer library. Confirm that it is approved for public use.</p>
                  <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={primaryClass} disabled={busy !== null} onClick={() => void save("published")}>{busy === "save" ? "Publishing…" : "Confirm publication"}</button><button type="button" className={secondaryClass} disabled={busy !== null} onClick={() => setReviewPublish(false)}>Keep editing</button></div>
                </div>}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={selected?.status === "published" ? secondaryClass : primaryClass} disabled={busy !== null || (!dirty && selected?.status === "draft")} onClick={() => void save("draft")}>{busy === "save" && !reviewPublish ? "Saving…" : selected?.status === "published" ? "Save as draft" : "Save draft"}</button>
                    <button type="button" className={selected?.status === "published" ? primaryClass : secondaryClass} disabled={busy !== null || reviewPublish || (!dirty && selected?.status === "published")} onClick={() => { if (validate("published")) setReviewPublish(true); }}>{selected?.status === "published" ? "Review changes" : "Review & publish"}</button>
                  </div>
                  {selected?.status === "draft" && <button type="button" className="text-xs font-medium text-red-700 hover:underline disabled:opacity-50" disabled={busy !== null} onClick={() => void deleteDraft()}>{busy === "delete" ? "Deleting…" : "Delete draft"}</button>}
                </div>
                <p className="text-[11px] text-slate-500">Saving, publishing, and deleting require confirmation in your wallet.</p>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: AssistantKnowledgeStatus }) {
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${status === "published" ? "border-brand-200 bg-brand-50 text-brand-800" : "border-slate-200 bg-slate-100 text-slate-600"}`}>{status === "published" ? "Published" : "Draft"}</span>;
}
