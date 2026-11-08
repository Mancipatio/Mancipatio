// Investor relations (migration 0090): what an issuer publishes for the
// holders of its tokens (company updates, periodic reports and notices, each
// with up to ten verified documents) and how a reader receives it.
// Browser-safe and pure: the issuer page validates with these parsers before
// the wallet signs, and the routes (lib/server/issuer-updates.ts) parse the
// signed params again.
//
// Who reads what:
//   - "public" updates: anyone (the asset page, GET /api/issuer-updates/public);
//   - "holders" updates: a wallet the server finds holding units of a share
//     class of the asset (for an issuer-wide update, of one of the issuer's
//     assets), read on chain at request time, failing closed;
//   - drafts and withdrawn updates: the issuer's authority and the admins.
//
// Anchoring: a published update can be anchored once with a Memo v2
// transaction the issuer authority signs (lib/document-anchor.ts). The memo is
// "<issuerUpdateAnchorReference(id)> sha256:<SHA-256 of issuerUpdateRecordText>":
// the canonical record covers the published text and every document's hash,
// so the chain fixes what holders were told and when. The server recomputes
// both from the stored row and verifies the finalized transaction before it
// records anchor_tx.

import { isAddress } from "@solana/kit";

export const ISSUER_UPDATE_KINDS = ["update", "quarterly_report", "annual_report", "financial_statement", "notice"] as const;
export type IssuerUpdateKind = (typeof ISSUER_UPDATE_KINDS)[number];

export const ISSUER_UPDATE_KIND_LABELS: Record<IssuerUpdateKind, string> = {
  update: "Company update",
  quarterly_report: "Quarterly report",
  annual_report: "Annual report",
  financial_statement: "Financial statement",
  notice: "Notice",
};

/** Kinds that must name their period (the 0090 check). */
export const PERIOD_REQUIRED_KINDS: ReadonlySet<IssuerUpdateKind> = new Set([
  "quarterly_report", "annual_report", "financial_statement",
]);

export const ISSUER_UPDATE_VISIBILITIES = ["public", "holders"] as const;
export type IssuerUpdateVisibility = (typeof ISSUER_UPDATE_VISIBILITIES)[number];

export const ISSUER_UPDATE_VISIBILITY_LABELS: Record<IssuerUpdateVisibility, string> = {
  public: "Public",
  holders: "Holders only",
};

export type IssuerUpdateStatus = "draft" | "published" | "withdrawn";

/** The bounds the routes and 0090 enforce (lengths in UTF-16 units here, characters there: never looser). */
export const ISSUER_UPDATE_LIMITS = {
  title: 180,
  body: 20_000,
  period: 40,
  documents: 10,
  fileName: 200,
  withdrawReasonMin: 10,
  withdrawReasonMax: 500,
  /** Open drafts per issuer (the save route refuses another). */
  drafts: 50,
  /** Asset PDAs one holder read may name. */
  holderAssets: 20,
} as const;

export type IssuerUpdateDocument = {
  id: string;
  file_name: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
};

/** What a reader receives: published content only, no authors or moderation data. */
export type PublicIssuerUpdate = {
  id: string;
  issuer_pda: string;
  asset_pda: string | null;
  kind: IssuerUpdateKind;
  title: string;
  body: string;
  period_label: string | null;
  visibility: IssuerUpdateVisibility;
  published_at: string;
  anchor_tx: string | null;
  documents: IssuerUpdateDocument[];
};

/** A holder read's update, with the held asset through which the wallet may read it (sent back to open its documents). */
export type HolderIssuerUpdate = PublicIssuerUpdate & { via_asset: string };

/** The issuer's (and the admin's) view: every status, who did what, and the memo to sign while unanchored. */
export type IssuerUpdateRecord = Omit<PublicIssuerUpdate, "published_at"> & {
  status: IssuerUpdateStatus;
  published_at: string | null;
  published_by: string | null;
  withdrawn_at: string | null;
  withdrawn_by: string | null;
  withdrawn_by_role: "issuer" | "admin" | null;
  withdrawn_reason: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  /** Published and not anchored yet: the reference and digest of the memo (computed by the server). */
  anchor: { reference: string; sha256: string } | null;
};

export type AdminIssuerUpdate = IssuerUpdateRecord & { company_name: string | null };

// ── Parsing (the browser before signing, the routes after) ─────────────────

/** Browser-safe validation, run before signing and again at the API boundary. */
export class IssuerUpdateValidationError extends Error {}

function invalid(message: string): never {
  throw new IssuerUpdateValidationError(message);
}

/** Control characters other than tab, line feed and carriage return. */
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** Any control character (single-line fields). */
const LINE_CONTROL = /[\u0000-\u001f\u007f]/;

export type IssuerUpdateDraft = {
  asset_pda: string | null;
  kind: IssuerUpdateKind;
  title: string;
  body: string;
  period_label: string | null;
  visibility: IssuerUpdateVisibility;
};

const DRAFT_FIELDS = new Set(["asset_pda", "kind", "title", "body", "period_label", "visibility"]);

function line(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") invalid(`${field} is required`);
  const text = value.trim();
  if (!text) invalid(`${field} is required`);
  if (text.length > max) invalid(`${field} is at most ${max} characters`);
  if (LINE_CONTROL.test(text)) invalid(`${field} must be a single line of text`);
  return text;
}

/** The draft content of an update (scope, kind, text, period, visibility); unknown fields are refused. */
export function parseIssuerUpdateDraft(value: unknown): IssuerUpdateDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("The update is missing");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!DRAFT_FIELDS.has(key)) invalid(`Unknown update field "${key}"`);
  }
  const kind = input.kind;
  if (typeof kind !== "string" || !(ISSUER_UPDATE_KINDS as readonly string[]).includes(kind)) {
    invalid("Choose the kind of update");
  }
  const visibility = input.visibility;
  if (typeof visibility !== "string" || !(ISSUER_UPDATE_VISIBILITIES as readonly string[]).includes(visibility)) {
    invalid("Choose who can read the update");
  }
  const title = line(input.title, "The title", ISSUER_UPDATE_LIMITS.title);
  if (typeof input.body !== "string") invalid("The text is required");
  const body = input.body.replace(/\r\n?/g, "\n").trim();
  if (!body) invalid("The text is required");
  if (body.length > ISSUER_UPDATE_LIMITS.body) invalid(`The text is at most ${ISSUER_UPDATE_LIMITS.body.toLocaleString("en-US")} characters`);
  if (BODY_CONTROL.test(body)) invalid("The text contains a control character");
  const period = input.period_label;
  const periodLabel = period === undefined || period === null || (typeof period === "string" && period.trim() === "")
    ? null
    : line(period, "The period", ISSUER_UPDATE_LIMITS.period);
  if (periodLabel === null && PERIOD_REQUIRED_KINDS.has(kind as IssuerUpdateKind)) {
    invalid(`A ${ISSUER_UPDATE_KIND_LABELS[kind as IssuerUpdateKind].toLowerCase()} names its period, for example "Q3 2026"`);
  }
  const asset = input.asset_pda;
  let assetPda: string | null = null;
  if (asset !== undefined && asset !== null && asset !== "") {
    if (typeof asset !== "string" || !isAddress(asset)) invalid("The asset must be an on-chain asset address");
    assetPda = asset;
  }
  return {
    asset_pda: assetPda,
    kind: kind as IssuerUpdateKind,
    title,
    body,
    period_label: periodLabel,
    visibility: visibility as IssuerUpdateVisibility,
  };
}

/** A withdrawal's reason: kept with the update and shown to its issuer. */
export function parseWithdrawReason(value: unknown): string {
  if (typeof value !== "string") invalid("Give the reason for the withdrawal");
  const reason = value.replace(/\r\n?/g, "\n").trim();
  if (reason.length < ISSUER_UPDATE_LIMITS.withdrawReasonMin) {
    invalid(`Give the reason for the withdrawal (at least ${ISSUER_UPDATE_LIMITS.withdrawReasonMin} characters)`);
  }
  if (reason.length > ISSUER_UPDATE_LIMITS.withdrawReasonMax) {
    invalid(`The reason is at most ${ISSUER_UPDATE_LIMITS.withdrawReasonMax} characters`);
  }
  if (BODY_CONTROL.test(reason)) invalid("The reason contains a control character");
  return reason;
}

/** The name a document is shown under (the stored object has its own sanitized name). */
export function parseDocumentFileName(value: unknown): string {
  const name = line(value, "The file name", ISSUER_UPDATE_LIMITS.fileName);
  if (/[/\\]/.test(name)) invalid("The file name cannot contain / or \\");
  return name;
}

// ── Storage (the upload route content-addresses the destination) ────────────

/** Bucket-relative path the issuer page asks the upload route for: issuer-updates/<issuer>/<sha8>-<name>. */
export function issuerUpdateUploadPath(issuerPda: string, sha256: string, fileName: string): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "").slice(-120) || "document";
  return `issuer-updates/${issuerPda}/${sha256.slice(0, 8)}-${safe}`;
}

// ── Anchoring ───────────────────────────────────────────────────────────────

/** The memo reference of an update: "manci-update:<id>" (49 characters, a valid DOCUMENT_ANCHOR_REFERENCE_PATTERN). */
export function issuerUpdateAnchorReference(id: string): string {
  return `manci-update:${id}`;
}

export type IssuerUpdateRecordInput = {
  network: string;
  id: string;
  issuer_pda: string;
  asset_pda: string | null;
  kind: string;
  title: string;
  body: string;
  period_label: string | null;
  visibility: string;
  published_at: string;
  documents: ReadonlyArray<Pick<IssuerUpdateDocument, "file_name" | "sha256" | "size_bytes" | "content_type">>;
};

/**
 * The canonical record an anchor fingerprints: one JSON text with a fixed key
 * order, published_at at millisecond precision (ISO 8601, UTC) and the
 * documents sorted by SHA-256, then name. Anyone holding the published
 * update can rebuild it and compare its SHA-256 with the memo.
 */
export function issuerUpdateRecordText(update: IssuerUpdateRecordInput): string {
  const documents = update.documents
    .map((d) => ({ name: d.file_name, sha256: d.sha256, size: d.size_bytes, type: d.content_type }))
    .sort((a, b) => (a.sha256 === b.sha256 ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.sha256 < b.sha256 ? -1 : 1));
  return JSON.stringify({
    v: 1,
    record: "manci-issuer-update",
    network: update.network,
    id: update.id,
    issuer: update.issuer_pda,
    asset: update.asset_pda,
    kind: update.kind,
    period: update.period_label,
    visibility: update.visibility,
    published_at: new Date(update.published_at).toISOString(),
    title: update.title,
    body: update.body,
    documents,
  });
}

// ── Display ─────────────────────────────────────────────────────────────────

/** The opening of the text, cut at a word boundary, for list views. */
export function issuerUpdateExcerpt(body: string, max = 280): { text: string; truncated: boolean } {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return { text: flat, truncated: false };
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return { text: `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`, truncated: true };
}

/** The text's paragraphs (blank-line separated); single line breaks stay inside a paragraph. */
export function issuerUpdateParagraphs(body: string): string[] {
  return body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

export function formatDocumentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "8 November 2026" (UTC, so a reader in another zone sees the same day the record carries). */
export function formatUpdateDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** Newest first; drafts (no publication date) by their last edit. */
export function byPublicationDesc<T extends { published_at: string | null; updated_at?: string; id: string }>(a: T, b: T): number {
  const at = a.published_at ?? a.updated_at ?? "";
  const bt = b.published_at ?? b.updated_at ?? "";
  if (at !== bt) return at < bt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
