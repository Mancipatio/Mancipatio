import "server-only";

import type { KnowledgeEntry } from "@/lib/assistant/knowledge";
import {
  AssistantKnowledgeValidationError,
  parseAssistantKnowledgeEntry,
  parseAssistantKnowledgeSave,
  parseAssistantKnowledgeDelete,
  type AssistantKnowledgeAdminEntry,
} from "@/lib/assistant/knowledge-admin";
import { detectNetwork } from "@/lib/network";
import { SiwsError } from "@/lib/server/siws-error";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const TABLE = "assistant_knowledge";
const PUBLIC_COLUMNS: string = "id,title,category,keywords,body,sources,provenance,status,updated_at";
const ADMIN_COLUMNS: string = `${PUBLIC_COLUMNS},network,created_by,updated_by,created_at`;
const PAGE_SIZE = 500;

function unavailable(): never {
  // Draft bodies and database diagnostics never belong in public errors/logs.
  throw new SiwsError(503, "The knowledge base is unavailable. Please try again shortly.");
}
function parse<T>(parser: (input: unknown) => T, input: unknown): T {
  try { return parser(input); }
  catch (error) {
    if (error instanceof AssistantKnowledgeValidationError) throw new SiwsError(400, error.message);
    throw error;
  }
}

async function rows(publishedOnly: boolean): Promise<AssistantKnowledgeAdminEntry[]> {
  try {
    const signal = AbortSignal.timeout(5_000);
    const sb = getSupabaseAdmin(signal);
    const result: AssistantKnowledgeAdminEntry[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      let query = sb.from(TABLE).select(publishedOnly ? PUBLIC_COLUMNS : ADMIN_COLUMNS)
        .eq("network", detectNetwork()).order("id", { ascending: true });
      if (publishedOnly) query = query.eq("status", "published");
      const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1).abortSignal(signal);
      if (error || !Array.isArray(data)) return unavailable();
      result.push(...data as unknown as AssistantKnowledgeAdminEntry[]);
      if (data.length < PAGE_SIZE) return result;
    }
  } catch { return unavailable(); }
}

export async function listAssistantKnowledge(): Promise<AssistantKnowledgeAdminEntry[]> {
  return rows(false);
}

/** Live published content only. An empty database is intentional; never revive static seed data. */
export async function loadPublishedAssistantKnowledge(): Promise<KnowledgeEntry[]> {
  const published = await rows(true);
  try {
    return published.map((row) => {
      if (row.status !== "published") return unavailable();
      const entry = parseAssistantKnowledgeEntry(row);
      return {
        id: entry.id, title: entry.title, answer: entry.body, keywords: entry.keywords, category: entry.category,
        sources: entry.sources, provenance: entry.provenance, updatedAt: row.updated_at,
      };
    });
  } catch { return unavailable(); }
}

export async function saveAssistantKnowledge(input: unknown, wallet: string): Promise<AssistantKnowledgeAdminEntry> {
  const { entry, expected_updated_at } = parse(parseAssistantKnowledgeSave, input);
  try {
    const signal = AbortSignal.timeout(5_000);
    const sb = getSupabaseAdmin(signal);
    const network = detectNetwork();
    const operation = expected_updated_at === null
      ? sb.from(TABLE).insert({ ...entry, network, provenance: entry.provenance ?? [], created_by: wallet, updated_by: wallet })
      : sb.from(TABLE).update({ ...entry, updated_by: wallet })
        .eq("network", network).eq("id", entry.id).eq("updated_at", expected_updated_at);
    const { data, error } = await operation.select(ADMIN_COLUMNS).abortSignal(signal).maybeSingle();
    if (error?.code === "23505") throw new SiwsError(409, "An entry with this ID already exists. Reload the knowledge base.");
    if (error) return unavailable();
    if (!data) throw new SiwsError(409, "This entry changed or was deleted. Reload it before saving.");
    return data as unknown as AssistantKnowledgeAdminEntry;
  } catch (error) {
    if (error instanceof SiwsError) throw error;
    return unavailable();
  }
}

export async function deleteAssistantKnowledge(input: unknown): Promise<{ id: string }> {
  const { id, expected_updated_at } = parse(parseAssistantKnowledgeDelete, input);
  try {
    const signal = AbortSignal.timeout(5_000);
    const { data, error } = await getSupabaseAdmin(signal).from(TABLE).delete()
      .eq("network", detectNetwork()).eq("id", id).eq("status", "draft").eq("updated_at", expected_updated_at)
      .select("id").abortSignal(signal).maybeSingle();
    if (error) return unavailable();
    if (!data) throw new SiwsError(409, "Only an unchanged draft can be deleted. Unpublish or reload the entry first.");
    return { id };
  } catch (error) {
    if (error instanceof SiwsError) throw error;
    return unavailable();
  }
}
