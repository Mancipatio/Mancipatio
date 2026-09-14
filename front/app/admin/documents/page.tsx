"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { RequireRole } from "@/components/require-role";
import { SkeletonTable } from "@/components/skeleton";
import { useRole } from "@/lib/auth";
import { signedFetch } from "@/lib/siws-client";
import {
  sha256HexOfFile,
  signedUpload,
  uploadContentType,
  UPLOAD_MIME_ALLOWLIST,
} from "@/lib/storage-client";
import { useToast } from "@/lib/toast";

type Category =
  | "legal"
  | "kyb-template"
  | "issuer-agreement"
  | "compliance"
  | "marketing"
  | "other";

type Document = {
  id: string;
  created_at: string;
  updated_at: string;
  category: Category;
  slug: string;
  version: number;
  title: string;
  description: string;
  storage_path: string | null;
  external_url: string | null;
  sha256: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  published: boolean;
  published_at: string | null;
  uploaded_by: string;
  /**
   * Resolved by the signed list route: external URL, public-bucket URL for
   * public categories, or a 60-minute signed URL for confidential categories
   * (compliance / issuer-agreement / other live in a PRIVATE bucket).
   */
  download_url: string | null;
};

const CATEGORY_LABEL: Record<Category, string> = {
  legal: "Legal",
  "kyb-template": "KYB templates",
  "issuer-agreement": "Issuer agreements",
  compliance: "Compliance",
  marketing: "Marketing",
  other: "Other",
};

/**
 * Lowercased kebab slug: matches the upload route's SEGMENT_RE and the
 * create route's SLUG_RE, so "AML Policy" becomes "aml-policy" as you type
 * instead of 400-ing at submit time (after the wallet signature).
 */
function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

export default function DocumentsPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Documents
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Global document repository
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Terms of Service, Privacy, KYB templates, issuer agreements,
          compliance memos. Each upload becomes a new version; one version per
          slug is &quot;published&quot; at a time.
        </p>
      </div>
      <RequireRole role="admin">
        <DocsOps />
      </RequireRole>
    </section>
  );
}

function DocsOps() {
  const { isSuperAdmin } = useRole();
  const conn = useWalletConnection();
  const toast = useToast();
  const [rows, setRows] = useState<Document[] | null>(null);
  const [category, setCategory] = useState<Category | "all">("all");
  const [query, setQuery] = useState("");
  const [showUpload, setShowUpload] = useState(false);

  const refresh = useCallback(async () => {
    // The documents table is no longer anon-readable (paths of unpublished /
    // confidential files) — the signed admin list also resolves per-row
    // download URLs (signed URLs for the private confidential bucket).
    if (!conn.wallet) return;
    try {
      const data = await signedFetch<{ documents: Document[] }>(
        conn.wallet,
        "/api/storage/documents/list",
        "storage.documents.list",
        {},
      );
      setRows(data.documents ?? []);
    } catch {
      setRows([]);
    }
  }, [conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Group rows by (category, slug). Each group lists newest version first.
  const grouped = useMemo(() => {
    if (!rows) return [];
    const map = new Map<string, Document[]>();
    for (const r of rows) {
      if (category !== "all" && r.category !== category) continue;
      const q = query.trim().toLowerCase();
      if (
        q &&
        !r.title.toLowerCase().includes(q) &&
        !r.slug.toLowerCase().includes(q) &&
        !r.description.toLowerCase().includes(q)
      )
        continue;
      const key = `${r.category}::${r.slug}`;
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    return Array.from(map.entries()).map(([key, versions]) => ({
      key,
      category: versions[0].category,
      slug: versions[0].slug,
      versions, // already DESC by version
      current: versions.find((v) => v.published) ?? versions[0],
    }));
  }, [rows, category, query]);

  async function publish(doc: Document) {
    try {
      // Signed route unpublishes all siblings of (category, slug) and
      // publishes this version — server-enforced admin gate.
      await signedFetch(
        conn.wallet,
        "/api/storage/documents/publish",
        "storage.documents.publish",
        { id: doc.id },
      );
      toast.show({
        kind: "success",
        title: `Published ${doc.title} v${doc.version}`,
      });
      await refresh();
    } catch (err) {
      toast.showError(
        "Publish failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title / slug / description…"
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as Category | "all")}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
        >
          <option value="all">All categories</option>
          {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {isSuperAdmin && (
          <button
            type="button"
            onClick={() => setShowUpload(true)}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Upload document
          </button>
        )}
      </div>

      {rows === null ? (
        <SkeletonTable rows={4} cols={4} />
      ) : grouped.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {rows.length === 0
              ? "No documents yet — upload your first."
              : "No documents match the filter."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map((g) => (
            <article
              key={g.key}
              className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card"
            >
              <header className="flex items-baseline justify-between gap-3 border-b border-slate-100 bg-slate-50 px-5 py-3">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    {CATEGORY_LABEL[g.category]}
                  </p>
                  <h3 className="mt-0.5 text-base font-semibold text-slate-900">
                    {g.current.title}
                  </h3>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                    {g.slug} · {g.versions.length} version
                    {g.versions.length === 1 ? "" : "s"}
                  </p>
                </div>
                {g.current.published && (
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold text-emerald-800">
                    Published v{g.current.version}
                  </span>
                )}
              </header>
              <table className="w-full text-sm">
                <thead className="border-b border-slate-100 bg-slate-50/50 text-left text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-5 py-2 font-medium">Version</th>
                    <th className="px-5 py-2 font-medium">Uploaded</th>
                    <th className="px-5 py-2 font-medium">Size</th>
                    <th className="px-5 py-2 font-medium">Hash</th>
                    <th className="px-5 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {g.versions.map((d) => (
                    <tr key={d.id} className="text-slate-700">
                      <td className="px-5 py-2 font-mono">
                        v{d.version}
                        {d.published && (
                          <span className="ml-2 text-[10px] font-semibold text-emerald-700">
                            CURRENT
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-2 text-xs text-slate-500">
                        {new Date(d.created_at).toISOString().slice(0, 10)} ·{" "}
                        <span className="font-mono">
                          {d.uploaded_by.slice(0, 6)}…{d.uploaded_by.slice(-4)}
                        </span>
                      </td>
                      <td className="px-5 py-2 text-xs text-slate-500">
                        {d.size_bytes
                          ? `${(d.size_bytes / 1024).toFixed(1)} KB`
                          : d.external_url
                            ? "external"
                            : "—"}
                      </td>
                      <td className="px-5 py-2 font-mono text-[11px] text-slate-500">
                        {d.sha256
                          ? `${d.sha256.slice(0, 6)}…${d.sha256.slice(-4)}`
                          : "—"}
                      </td>
                      <td className="space-x-3 px-5 py-2 text-right text-xs">
                        {d.download_url ? (
                          <a
                            href={d.download_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-slate-600 underline-offset-2 hover:underline"
                          >
                            {d.storage_path ? "Download ↓" : "View ↗"}
                          </a>
                        ) : null}
                        {isSuperAdmin && !d.published && (
                          <button
                            type="button"
                            onClick={() => void publish(d)}
                            className="text-slate-700 underline-offset-2 hover:underline"
                          >
                            Publish
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          ))}
        </div>
      )}

      {showUpload && (
        <UploadModal
          docs={rows ?? []}
          onClose={() => setShowUpload(false)}
          onSuccess={() => {
            void refresh();
            setShowUpload(false);
          }}
        />
      )}

      <p className="text-xs text-slate-400">
        Uploads go through the signed storage route: legal, marketing and KYB
        templates land in the public <code>documents</code> bucket; compliance
        memos, issuer agreements and &quot;other&quot; land in a private bucket
        and are served via 60-minute signed links. The version + hash chain is
        what enables an on-chain attestation later. The &quot;forced acceptance
        of new ToS&quot; flow still arrives in a later iteration.
      </p>
    </div>
  );
}

function UploadModal({
  docs,
  onClose,
  onSuccess,
}: {
  /** Already-loaded repository rows — used to compute the next version. */
  docs: Document[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [category, setCategory] = useState<Category>("legal");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [sha256, setSha256] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileMeta, setFileMeta] = useState<{
    size: number;
    mime: string;
    sha: string;
  } | null>(null);
  const [hashing, setHashing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleFile(f: File) {
    // Surface unsupported types immediately — the upload route enforces the
    // same allowlist, but only after the wallet-signature prompt.
    const mime = uploadContentType(f);
    if (!(UPLOAD_MIME_ALLOWLIST as readonly string[]).includes(mime)) {
      toast.showError(
        "Unsupported file type",
        "Allowed: PDF, PNG, JPG, DOCX.",
      );
      return;
    }
    setFile(f);
    setHashing(true);
    try {
      const sha = await sha256HexOfFile(f);
      setFileMeta({ size: f.size, mime: f.type || "application/octet-stream", sha });
      setSha256(sha);
      // Use the file name as default title if user hasn't filled one yet.
      if (!title.trim()) setTitle(f.name);
    } finally {
      setHashing(false);
    }
  }

  async function submit() {
    const cleanSlug = normalizeSlug(slug).replace(/^-+|-+$/g, "");
    if (!wallet || !cleanSlug || !title.trim()) return;
    setSubmitting(true);
    try {
      // Next version for this (category, slug), computed from the loaded
      // repository rows (the table is not anon-readable anymore). A
      // concurrent upload of the same version is caught by the unique
      // (category, slug, version) constraint server-side (409).
      const nextVersion =
        docs.reduce(
          (max, d) =>
            d.category === category && d.slug === cleanSlug
              ? Math.max(max, d.version)
              : max,
          0,
        ) + 1;

      let storagePath: string | null = null;
      let uploadedSha: string | null = null;
      if (file) {
        // Path: {category}/{slug}/v{n}-{filename} — uploaded through the
        // signed /api/storage/upload route (payload-hash binding).
        const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
        storagePath = `${category}/${cleanSlug}/v${nextVersion}-${safeName}`;
        const result = await signedUpload(conn.wallet, {
          path: storagePath,
          file,
          sha256: fileMeta?.sha,
        });
        uploadedSha = result.sha256;
      }

      // Metadata row via the signed admin route (uploaded_by is server-set
      // from the verified wallet).
      await signedFetch(
        conn.wallet,
        "/api/storage/documents/create",
        "storage.documents.create",
        {
          category,
          slug: cleanSlug,
          version: nextVersion,
          title: title.trim(),
          description,
          external_url: storagePath ? null : externalUrl.trim() || null,
          storage_path: storagePath,
          size_bytes: fileMeta?.size ?? null,
          mime_type: fileMeta?.mime ?? null,
          sha256: uploadedSha ?? (sha256.trim() || null),
        },
      );
      toast.show({
        kind: "success",
        title: `Uploaded ${title} v${nextVersion}`,
        description: storagePath
          ? `Stored in /${storagePath}`
          : "Metadata-only entry",
      });
      onSuccess();
    } catch (err) {
      toast.showError(
        "Upload failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Upload document
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Adds a new version under (category, slug). If the slug already
            exists, this becomes vN+1 — otherwise v1.
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Category
              </span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Slug
              </span>
              <input
                value={slug}
                onChange={(e) => setSlug(normalizeSlug(e.target.value))}
                placeholder="terms-of-service"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm focus:border-slate-400 focus:outline-none"
              />
              <span className="mt-1 block text-[11px] text-slate-400">
                Identifies the document family across versions. Lowercase
                letters, digits and dashes only (normalized as you type).
              </span>
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Title
              </span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Terms of Service"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Description
              </span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                File (preferred)
              </span>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.docx,application/pdf,image/png,image/jpeg,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                }}
                className="mt-1 block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-slate-800"
              />
              {hashing && (
                <p className="mt-1 text-[11px] text-slate-500">
                  Hashing locally…
                </p>
              )}
              {file && fileMeta && !hashing && (
                <p className="mt-1 text-[11px] text-slate-500">
                  {file.name} · {(fileMeta.size / 1024).toFixed(1)} KB · sha256{" "}
                  <span className="font-mono">{fileMeta.sha.slice(0, 12)}…</span>
                </p>
              )}
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                External URL (used only when no file is attached)
              </span>
              <input
                value={externalUrl}
                onChange={(e) => setExternalUrl(e.target.value)}
                placeholder="https://…"
                disabled={!!file}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none disabled:bg-slate-100"
              />
              <span className="mt-1 block text-[11px] text-slate-400">
                For docs hosted elsewhere (Notion, IPFS, partner storage). When
                a file is attached the URL is ignored — the storage path takes
                precedence.
              </span>
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                SHA-256 (auto-filled from file, override if needed)
              </span>
              <input
                value={sha256}
                onChange={(e) =>
                  setSha256(e.target.value.toLowerCase().replace(/[^0-9a-f]/g, ""))
                }
                placeholder="64 hex chars"
                maxLength={64}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
              />
              <span className="mt-1 block text-[11px] text-slate-400">
                Used by future on-chain attestation. Computed locally for
                attached files; paste manually for external URLs.
              </span>
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={
              submitting ||
              !slug.replace(/^-+|-+$/g, "") ||
              !title.trim() ||
              !wallet
            }
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}
