import type {
  AssistantKnowledgeAdminEntry,
  AssistantKnowledgeCategory,
  AssistantKnowledgeStatus,
} from "@/lib/assistant/knowledge-admin";

export type KnowledgeForm = {
  id: string;
  title: string;
  category: AssistantKnowledgeCategory;
  keywords: string;
  body: string;
  sources: { title: string; href: string; section: string }[];
};

export function knowledgeForm(entry: AssistantKnowledgeAdminEntry | null): KnowledgeForm {
  return {
    id: entry?.id ?? "",
    title: entry?.title ?? "",
    category: entry?.category ?? "answer",
    keywords: entry?.keywords.join(", ") ?? "",
    body: entry?.body ?? "",
    sources: entry?.sources.map((source) => ({ ...source, section: source.section ?? "" })) ?? [],
  };
}

export function knowledgeSlug(title: string): string {
  return title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80).replace(/-$/g, "");
}

/** Preserve provenance and the loaded revision; the server rejects stale saves. */
export function knowledgeSaveParams(
  form: KnowledgeForm,
  baseline: AssistantKnowledgeAdminEntry | null,
  status: AssistantKnowledgeStatus,
) {
  return {
    entry: {
      id: baseline?.id ?? form.id.trim(),
      title: form.title.trim(),
      category: form.category,
      keywords: [...new Set(form.keywords.split(",").map((keyword) => keyword.trim()).filter(Boolean))],
      body: form.body.trim(),
      sources: form.sources.map((source) => ({
        title: source.title.trim(),
        href: source.href.trim(),
        ...(source.section.trim() ? { section: source.section.trim() } : {}),
      })),
      ...(baseline?.provenance ? { provenance: baseline.provenance } : {}),
      status,
    },
    expected_updated_at: baseline?.updated_at ?? null,
  };
}
