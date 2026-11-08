import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KNOWLEDGE_ENTRIES } from "@/lib/assistant/knowledge";
import { parseAssistantKnowledgeEntry } from "@/lib/assistant/knowledge-admin";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/0084_assistant_knowledge.sql"), "utf8");

describe("assistant knowledge migration seed", () => {
  it("seeds only the already-public curated corpus and all rows pass publish validation", () => {
    const seed = JSON.parse(migration.split("$manci_knowledge_seed$")[1]) as Record<string, unknown>[];
    expect(seed).toHaveLength(26);
    expect(seed).toEqual(KNOWLEDGE_ENTRIES.map(({ id, title, category, keywords, answer, sources, provenance }) => ({
      id, title, category: category ?? "answer", keywords, body: answer, sources, provenance: provenance ?? [],
    })));
    for (const entry of seed) expect(parseAssistantKnowledgeEntry({ ...entry, status: "published" }).status).toBe("published");
  });
});

const db = new LocalPostgres();
describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0084 knowledge publication on isolated PostgreSQL", () => {
  beforeAll(() => {
    try {
      db.initialize();
      db.query(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
    } catch (error) { db.close(); throw error; }
  }, 60_000);
  afterAll(() => db.close());

  it("seeds the configured network only, has RLS and keeps every row private to browser database roles", () => {
    // 0091 adds drafts on the same network; the published corpus is 0084's.
    expect(db.query("select network||'|'||count(*) from public.assistant_knowledge where status='published' group by network")).toBe("devnet|26");
    expect(db.query("select relrowsecurity from pg_class where oid='public.assistant_knowledge'::regclass")).toBe("t");
    for (const role of ["anon", "authenticated"]) {
      expect(() => db.query(`set role ${role}; select * from public.assistant_knowledge`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role}; insert into public.assistant_knowledge(id,title,body) values ('attack','Attack','Body')`)).toThrow(/permission denied/);
    }
    expect(db.query("set role service_role; select count(*) from public.assistant_knowledge where status='published'")).toBe("26");
    expect(db.query("select category||'|'||count(*) from public.assistant_knowledge where status='published' group by category order by category")).toBe("answer|21\npolicy|2\nprocedure|3");
  });

  it("defaults new policies to draft, refuses sourceless publication and prevents deletion while published", () => {
    db.query("set role service_role; insert into public.assistant_knowledge(id,title,category,body) values ('test-policy','Policy','policy','Internal draft')");
    expect(db.query("select network||'|'||status from public.assistant_knowledge where id='test-policy'")).toBe("devnet|draft");
    expect(() => db.query("set role service_role; update public.assistant_knowledge set status='published' where id='test-policy'")).toThrow(/check constraint/);
    db.query(`set role service_role; update public.assistant_knowledge set status='published',sources='[{"title":"Public policy","href":"/legal/terms"}]' where id='test-policy'`);
    expect(() => db.query("set role service_role; delete from public.assistant_knowledge where id='test-policy'")).toThrow(/Unpublish/);
    db.query("set role service_role; update public.assistant_knowledge set status='draft' where id='test-policy'; delete from public.assistant_knowledge where id='test-policy'");
  });

  it("changes revisions on every write and rejects stale compare-and-swap updates", () => {
    db.query("insert into public.assistant_knowledge(id,title,body,created_by) values ('test-cas','Original','Body','creator')");
    const revision = db.query("select updated_at::text from public.assistant_knowledge where id='test-cas'");
    const changed = db.query(`set role service_role; update public.assistant_knowledge set title='First editor',updated_at='2000-01-01',created_by='spoof' where id='test-cas' and updated_at=:'revision' returning updated_at::text`, { revision });
    expect(Date.parse(changed)).toBeGreaterThanOrEqual(Date.parse(revision));
    expect(changed).not.toBe(revision);
    expect(db.query(`set role service_role; update public.assistant_knowledge set title='Stale editor' where id='test-cas' and updated_at=:'revision' returning id`, { revision })).toBe("");
    expect(db.query("select title||'|'||created_by from public.assistant_knowledge where id='test-cas'")).toBe("First editor|creator");
    db.query("delete from public.assistant_knowledge where id='test-cas'");
  });

  it("installs the network guard and never overwrites an editorial change on migration replay", () => {
    expect(() => db.query("insert into public.assistant_knowledge(network,id,title,body) values ('mainnet','wrong-network','Wrong','Body')")).toThrow(/mainnet/);
    db.query("update public.assistant_knowledge set status='draft',title='Editorial draft' where id='platform-operator'");
    const total = db.query("select count(*) from public.assistant_knowledge");
    db.query(migration);
    expect(db.query("select title||'|'||status from public.assistant_knowledge where id='platform-operator'")).toBe("Editorial draft|draft");
    expect(db.query("select count(*) from public.assistant_knowledge")).toBe(total);
  });
});
