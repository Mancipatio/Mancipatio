"use client";

// One issuer update as readers see it (lib/issuer-updates.ts): kind, period,
// date, title, the text (an excerpt that opens in full), the documents with
// their SHA-256 and the server's verification, and the on-chain anchor. Used
// by the asset page ("public": the marketplace's mx tokens), and by the
// portfolio, /issuer/updates and /admin/updates ("workspace": the app's
// slate tokens). Opening a document is the caller's: a public link
// (documentHref) or a signed request (onOpenDocument).

import { useState, type ReactNode } from "react";
import {
  formatDocumentSize,
  formatUpdateDate,
  issuerUpdateExcerpt,
  issuerUpdateParagraphs,
  ISSUER_UPDATE_KIND_LABELS,
  type IssuerUpdateDocument,
  type IssuerUpdateKind,
  type IssuerUpdateVisibility,
} from "@/lib/issuer-updates";
import { detectNetwork, explorerTxUrl } from "@/lib/network";

export type ArticleUpdate = {
  id: string;
  kind: IssuerUpdateKind;
  title: string;
  body: string;
  period_label: string | null;
  visibility: IssuerUpdateVisibility;
  published_at: string | null;
  anchor_tx: string | null;
  documents: IssuerUpdateDocument[];
};

const TONES = {
  public: {
    card: "rounded-[3px] border border-mx-rule bg-white p-5",
    ink: "text-mx-ink",
    soft: "text-mx-ink-soft",
    faint: "text-mx-ink-faint",
    rule: "border-mx-rule",
    link: "text-mx-ink-soft underline-offset-2 hover:underline",
  },
  workspace: {
    card: "rounded-xl border border-slate-200 bg-white p-5 shadow-card",
    ink: "text-slate-900",
    soft: "text-slate-600",
    faint: "text-slate-500",
    rule: "border-slate-100",
    link: "text-brand-700 underline-offset-2 hover:underline",
  },
} as const;

export function shortHash(sha256: string): string {
  return `${sha256.slice(0, 10)}…${sha256.slice(-8)}`;
}

export function UpdateArticle({
  update,
  variant,
  context,
  documentHref,
  onOpenDocument,
  openingDocument,
  expanded: startExpanded = false,
  children,
}: {
  update: ArticleUpdate;
  variant: keyof typeof TONES;
  /** A line above the title (the asset or "All assets of the issuer", a status). */
  context?: ReactNode;
  /** A plain link for a public document (opens in a new tab). */
  documentHref?: (doc: IssuerUpdateDocument) => string;
  /** A signed open for anyone else (holders, the issuer, admins). */
  onOpenDocument?: (doc: IssuerUpdateDocument) => void;
  /** The document being opened (its button says so). */
  openingDocument?: string | null;
  expanded?: boolean;
  /** Actions under the update (issuer and admin views). */
  children?: ReactNode;
}) {
  const tone = TONES[variant];
  const [expanded, setExpanded] = useState(startExpanded);
  const excerpt = issuerUpdateExcerpt(update.body);
  const network = detectNetwork();

  return (
    <article className={tone.card} aria-labelledby={`update-${update.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`text-[11px] font-semibold uppercase tracking-wider ${tone.faint}`}>
          {ISSUER_UPDATE_KIND_LABELS[update.kind]}
          {update.period_label && <> · {update.period_label}</>}
          {update.visibility === "holders" && (
            <span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-amber-800">
              Holders only
            </span>
          )}
        </p>
        {update.published_at && (
          <time dateTime={update.published_at} className={`text-xs ${tone.faint}`}>
            {formatUpdateDate(update.published_at)}
          </time>
        )}
      </div>
      {context && <div className={`mt-1 text-xs ${tone.faint}`}>{context}</div>}
      <h3 id={`update-${update.id}`} className={`mt-2 text-base font-semibold ${tone.ink}`}>
        {update.title}
      </h3>

      {expanded || !excerpt.truncated ? (
        <div className={`mt-2 space-y-3 text-sm leading-relaxed ${tone.soft}`}>
          {issuerUpdateParagraphs(update.body).map((paragraph, i) => (
            <p key={i} className="whitespace-pre-line">{paragraph}</p>
          ))}
        </div>
      ) : (
        <p className={`mt-2 text-sm leading-relaxed ${tone.soft}`}>{excerpt.text}</p>
      )}
      {excerpt.truncated && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className={`mt-2 text-xs font-medium ${tone.link}`}
        >
          {expanded ? "Show less" : "Read the full update"}
        </button>
      )}

      {update.documents.length > 0 && (
        <div className={`mt-4 border-t pt-3 ${tone.rule}`}>
          <p className={`text-[11px] font-semibold uppercase tracking-wider ${tone.faint}`}>Documents</p>
          <ul className="mt-2 space-y-2">
            {update.documents.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                <div className="min-w-0">
                  <p className={`break-all font-medium ${tone.ink}`}>{doc.file_name}</p>
                  <p className={`text-xs ${tone.faint}`}>
                    {formatDocumentSize(doc.size_bytes)} · SHA-256{" "}
                    <code className="font-mono" title={doc.sha256}>{shortHash(doc.sha256)}</code>{" "}
                    <CopyHash value={doc.sha256} className={tone.link} />
                  </p>
                  <p className="mt-0.5 text-[11px] text-emerald-700" title="The server hashed the stored file when it was uploaded; the bytes cannot change afterwards.">
                    File bytes verified by the server
                  </p>
                </div>
                {documentHref ? (
                  <a href={documentHref(doc)} target="_blank" rel="noopener noreferrer" className={`text-xs font-medium ${tone.link}`}>
                    Open ↗
                  </a>
                ) : onOpenDocument ? (
                  <button
                    type="button"
                    onClick={() => onOpenDocument(doc)}
                    disabled={openingDocument === doc.id}
                    className={`text-xs font-medium disabled:opacity-50 ${tone.link}`}
                  >
                    {openingDocument === doc.id ? "Opening…" : "Open ↗"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {update.anchor_tx && (
        <p className={`mt-3 text-xs ${tone.faint}`}>
          Anchored on chain by the issuer:{" "}
          <a href={explorerTxUrl(update.anchor_tx, network)} target="_blank" rel="noopener noreferrer" className={tone.link}>
            view the transaction ↗
          </a>
        </p>
      )}
      {children}
    </article>
  );
}

function CopyHash({ value, className }: { value: string; className: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, () => undefined);
      }}
      className={`text-[11px] ${className}`}
      aria-label="Copy the full SHA-256"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
