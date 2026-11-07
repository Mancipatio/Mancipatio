import type { KnowledgeEntry } from "@/lib/assistant/knowledge";

export type AssistantKnowledgeCategory = "answer" | "policy" | "procedure";
export type AssistantKnowledgeStatus = "draft" | "published";
export type AssistantKnowledgeInput = {
  id: string;
  title: string;
  category: AssistantKnowledgeCategory;
  keywords: string[];
  body: string;
  sources: KnowledgeEntry["sources"];
  provenance?: KnowledgeEntry["provenance"];
  status: AssistantKnowledgeStatus;
};
export type AssistantKnowledgeAdminEntry = AssistantKnowledgeInput & {
  network: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

/** Browser-safe validation runs before signing and again at the API boundary. */
export class AssistantKnowledgeValidationError extends Error {}

function invalid(message: string): never {
  throw new AssistantKnowledgeValidationError(message);
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || value.includes("\0")) {
    invalid(`${field} must contain 1–${max} characters`);
  }
  return value.trim();
}
function array(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(`${field} must contain at most ${max} items`);
  return value;
}
function id(value: unknown): string {
  const result = text(value, "ID", 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) invalid("ID must use lowercase letters, numbers and single hyphens");
  return result;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))) invalid("Reload the entry before saving or deleting it");
  return value;
}

export function isAssistantKnowledgeSourceUrl(value: string): boolean {
  if (!value || /[\s\\\u0000-\u001f\u007f]/.test(value) || /%5c/i.test(value)) return false;
  try {
    if (value.startsWith("/") && !value.startsWith("//")) {
      const path = decodeURIComponent(new URL(value, "https://manci.invalid").pathname);
      return !/^\/(?:admin|api|account|app|issuer|portfolio|onboarding|login)(?:\/|$)/i.test(path);
    }
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export function parseAssistantKnowledgeEntry(value: unknown): AssistantKnowledgeInput {
  const entry = record(value, "Entry");
  const category = entry.category ?? "answer";
  if (category !== "answer" && category !== "policy" && category !== "procedure") invalid("Choose answer, policy or procedure");
  const status = entry.status ?? "draft";
  if (status !== "draft" && status !== "published") invalid("Choose draft or published");
  const sources = array(entry.sources ?? [], "Sources", 12).map((item, index) => {
    const source = record(item, `Source ${index + 1}`);
    const href = text(source.href, "Source URL", 1_000);
    if (!isAssistantKnowledgeSourceUrl(href)) invalid("Source URLs must be public page paths or HTTPS links without credentials");
    return {
      title: text(source.title, "Source title", 180), href,
      ...(source.section == null || source.section === "" ? {} : { section: text(source.section, "Source section", 240) }),
    };
  });
  if (status === "published" && !sources.length) invalid("Add at least one public source before publishing");
  const provenance = entry.provenance === undefined ? undefined : array(entry.provenance, "Provenance", 12).map((item) => {
    const evidence = record(item, "Provenance");
    const date = text(evidence.date, "Evidence date", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      invalid("Evidence dates must use YYYY-MM-DD");
    }
    return { title: text(evidence.title, "Evidence title", 180), section: text(evidence.section, "Evidence section", 300), date };
  });
  return {
    id: id(entry.id), title: text(entry.title, "Title", 180), category,
    body: text(entry.body, "Answer or procedure", 12_000),
    keywords: [...new Set(array(entry.keywords ?? [], "Keywords", 40).map((item) => text(item, "Keyword", 80)))],
    sources, ...(provenance === undefined ? {} : { provenance }), status,
  };
}

export function parseAssistantKnowledgeSave(value: unknown): { entry: AssistantKnowledgeInput; expected_updated_at: string | null } {
  const params = record(value, "Request");
  return {
    entry: parseAssistantKnowledgeEntry(params.entry),
    expected_updated_at: params.expected_updated_at === null ? null : timestamp(params.expected_updated_at),
  };
}

export function parseAssistantKnowledgeDelete(value: unknown): { id: string; expected_updated_at: string } {
  const params = record(value, "Request");
  return { id: id(params.id), expected_updated_at: timestamp(params.expected_updated_at) };
}
