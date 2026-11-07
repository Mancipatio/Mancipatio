import { KNOWLEDGE_VERSION, type KnowledgeEntry } from "./knowledge";

/** Public revision follows published content, including edits made after deploy. */
export function publishedKnowledgeVersion(entries: readonly KnowledgeEntry[]): string {
  const dates = entries.flatMap((entry) => {
    if (!entry.updatedAt) return [];
    const date = new Date(entry.updatedAt);
    return Number.isFinite(date.getTime()) ? [date.toISOString()] : [];
  });
  return dates.sort().at(-1) ?? KNOWLEDGE_VERSION;
}
