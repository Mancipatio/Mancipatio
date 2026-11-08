// 0091: assistant knowledge drafts proposed by the workstream PRs of
// 2026-11-08. The file must only ever add drafts (an Admin publishes each one
// on /admin/assistant after review), every row must pass the same validation
// the admin console applies before publishing, and none may reuse an id of
// the corpus 0084 published.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KNOWLEDGE_ENTRIES } from "@/lib/assistant/knowledge";
import { parseAssistantKnowledgeEntry } from "@/lib/assistant/knowledge-admin";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/0091_assistant_knowledge_drafts.sql"), "utf8");
const seed = JSON.parse(migration.split("$manci_knowledge_drafts$")[1]) as Record<string, unknown>[];
const ids = seed.map((entry) => String(entry.id));

describe("0091 assistant knowledge drafts", () => {
  it("inserts drafts only, on this deployment's network, never over an editorial change", () => {
    expect(seed.length).toBeGreaterThan(0);
    expect(migration).toMatch(/seed\.provenance, 'draft'\nfrom jsonb_to_recordset/);
    expect(migration).not.toMatch(/'published'/);
    expect(migration).toMatch(/select public\.deployment_network\(\), seed\.id/);
    expect(migration).not.toMatch(/'(?:mainnet|devnet|testnet|localnet)'/);
    expect(migration).toMatch(/on conflict \(network, id\) do nothing;/);
  });

  it("every draft passes the admin's publish validation, with ids unique and unused by 0084", () => {
    const published = new Set(KNOWLEDGE_ENTRIES.map((entry) => entry.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of seed) {
      expect(published.has(String(entry.id)), String(entry.id)).toBe(false);
      expect(parseAssistantKnowledgeEntry(entry).status).toBe("draft");
      const parsed = parseAssistantKnowledgeEntry({ ...entry, status: "published" });
      expect(parsed.status).toBe("published");
      // Exactly what the admin would publish: nothing trimmed or deduplicated away.
      expect(parsed.keywords).toEqual(entry.keywords);
      expect(parsed.body).toBe(entry.body);
      expect((entry.provenance as { title: string }[])[0].title).toMatch(/^Pull request #\d+: /);
    }
  });

  it("keeps the public copy rules: no audit claim, no promised return", () => {
    for (const entry of seed) {
      const body = String(entry.body);
      expect(body, String(entry.id)).not.toMatch(/\baudited\b/i);
      expect(body, String(entry.id)).not.toMatch(/guaranteed (?:return|profit|yield|income)/i);
    }
  });
});

const db = new LocalPostgres();
describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0091 drafts on isolated PostgreSQL", () => {
  beforeAll(() => {
    try {
      db.initialize();
      db.query(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
    } catch (error) { db.close(); throw error; }
  }, 60_000);
  afterAll(() => db.close());

  const idList = `{${ids.join(",")}}`;

  it("adds every draft on the deployment network as a draft; the published corpus stays 0084's", () => {
    expect(db.query("select network||'|'||status||'|'||count(*) from public.assistant_knowledge where id = any(:'ids'::text[]) group by network, status", { ids: idList }))
      .toBe(`devnet|draft|${ids.length}`);
    expect(db.query("set role service_role; select count(*) from public.assistant_knowledge where status='published'")).toBe(String(KNOWLEDGE_ENTRIES.length));
  });

  it("never overwrites an Admin's edit or publication when replayed", () => {
    const [first] = ids;
    db.query("update public.assistant_knowledge set title='Edited by an admin', status='published' where id=:'id'", { id: first });
    const total = db.query("select count(*) from public.assistant_knowledge");
    db.query(migration);
    expect(db.query("select title||'|'||status from public.assistant_knowledge where id=:'id'", { id: first })).toBe("Edited by an admin|published");
    expect(db.query("select count(*) from public.assistant_knowledge")).toBe(total);
  });
});
