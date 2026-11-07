import { beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  signed: vi.fn(), admin: vi.fn(),
  db: null as ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> | null,
}));
vi.mock("@/lib/server/siws", async (original) => ({
  ...(await original<typeof import("@/lib/server/siws")>()), verifySigned: h.signed,
}));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: h.admin }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => h.db!.client }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));

import { POST as list } from "@/app/api/admin/assistant-knowledge/list/route";
import { POST as save } from "@/app/api/admin/assistant-knowledge/save/route";
import { POST as remove } from "@/app/api/admin/assistant-knowledge/delete/route";
import { SiwsError } from "@/lib/server/siws-error";
import { loadPublishedAssistantKnowledge } from "@/lib/server/assistant-knowledge";
import { parseAssistantKnowledgeSave, isAssistantKnowledgeSourceUrl } from "@/lib/assistant/knowledge-admin";
import { isSessionReadAction } from "@/lib/siws-session";

const TABLE = "assistant_knowledge";
const NOW = "2026-11-07T12:00:00.000Z";
const LATER = "2026-11-07T12:00:01.000Z";
const entry = (extra: Record<string, unknown> = {}) => ({
  id: "ownership", title: "What do I own?", category: "answer", keywords: ["own", "ownership"],
  body: "Rights follow the issuance instrument.", sources: [{ title: "Legal structure", href: "/legal-structure" }],
  status: "draft", ...extra,
});
const row = (extra: Record<string, unknown> = {}) => ({
  ...entry(), provenance: [], network: "devnet", created_by: "creator", updated_by: "editor",
  created_at: NOW, updated_at: NOW, ...extra,
});
const call = async (route: typeof save, params: Record<string, unknown> = {}) => {
  h.signed.mockResolvedValue({ wallet: "admin-wallet", params });
  const response = await route(new Request("https://manci.test/api/admin/assistant-knowledge", { method: "POST" }));
  return { response, body: await response.json() };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.admin.mockResolvedValue(undefined);
  h.db = memorySupabase();
  h.db.ordered = true;
  h.db.uniqueIds.add(TABLE);
  h.db.defaults[TABLE] = () => ({ created_at: NOW, updated_at: NOW });
});

describe("assistant knowledge admin authorization and lifecycle", () => {
  it.each([[list, "list"], [save, "save"], [remove, "delete"]] as const)("checks the signed %s action and current admin role", async (route, action) => {
    h.admin.mockRejectedValueOnce(new SiwsError(403, "Admin privileges required"));
    const { response } = await call(route);
    expect(response.status).toBe(403);
    expect(h.signed).toHaveBeenCalledWith(expect.any(Request), `assistantKnowledge.${action}`);
    expect(h.admin).toHaveBeenCalledWith("admin-wallet");
    expect(h.db!.rows(TABLE)).toEqual([]);
  });

  it("allows session reads only; both mutations still require a fresh signature", () => {
    expect(isSessionReadAction("assistantKnowledge.list")).toBe(true);
    expect(isSessionReadAction("assistantKnowledge.save")).toBe(false);
    expect(isSessionReadAction("assistantKnowledge.delete")).toBe(false);
  });

  it("lists drafts and published entries only in the server deployment", async () => {
    h.db!.rows(TABLE).push(row(), row({ id: "public", status: "published" }), row({ id: "other", network: "mainnet" }));
    const { response, body } = await call(list, { network: "mainnet" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.data.entries.map((item: { id: string }) => item.id)).toEqual(["ownership", "public"]);
  });

  it("creates private drafts by default, ignores submitted network and author, and does not overwrite duplicates", async () => {
    const input = entry({ status: undefined, network: "mainnet", created_by: "spoofed" });
    const first = await call(save, { entry: input, expected_updated_at: null });
    expect(first.response.status).toBe(200);
    expect(first.body.data.entry).toMatchObject({ status: "draft", network: "devnet", created_by: "admin-wallet", updated_by: "admin-wallet" });
    expect((await call(save, { entry: input, expected_updated_at: null })).response.status).toBe(409);
    expect(h.db!.rows(TABLE)).toHaveLength(1);
  });

  it("publishes an unchanged draft and preserves evidence when the editor omits it", async () => {
    const provenance = [{ title: "Reviewed public policy", section: "Transfer rules", date: "2026-11-07" }];
    h.db!.rows(TABLE).push(row({ provenance }));
    const result = await call(save, { entry: entry({ status: "published", category: "policy" }), expected_updated_at: NOW });
    expect(result.response.status).toBe(200);
    expect(result.body.data.entry).toMatchObject({ status: "published", category: "policy", provenance, updated_by: "admin-wallet" });
  });

  it("refuses stale updates including a race after the request began", async () => {
    h.db!.rows(TABLE).push(row());
    h.db!.beforeUpdate = () => { h.db!.rows(TABLE)[0].updated_at = LATER; };
    expect((await call(save, { entry: entry({ body: "stale text" }), expected_updated_at: NOW })).response.status).toBe(409);
    expect(h.db!.rows(TABLE)[0].body).toBe("Rights follow the issuance instrument.");
  });

  it("cannot create or update without an explicit concurrency token", async () => {
    expect((await call(save, { entry: entry() })).response.status).toBe(400);
    expect(h.db!.rows(TABLE)).toEqual([]);
  });

  it("cannot modify an entry in another network", async () => {
    h.db!.rows(TABLE).push(row({ network: "mainnet" }));
    expect((await call(save, { entry: entry({ status: "published" }), expected_updated_at: NOW })).response.status).toBe(409);
    expect((await call(remove, { id: "ownership", expected_updated_at: NOW })).response.status).toBe(409);
    expect(h.db!.rows(TABLE)[0].status).toBe("draft");
  });

  it("requires unpublishing before deletion and checks the revision on deletion", async () => {
    h.db!.rows(TABLE).push(row({ status: "published" }));
    expect((await call(remove, { id: "ownership", expected_updated_at: NOW })).response.status).toBe(409);
    expect((await call(save, { entry: entry(), expected_updated_at: NOW })).response.status).toBe(200);
    expect((await call(remove, { id: "ownership", expected_updated_at: LATER })).response.status).toBe(409);
    const deleted = await call(remove, { id: "ownership", expected_updated_at: NOW });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.data).toEqual({ id: "ownership" });
    expect(h.db!.rows(TABLE)).toEqual([]);
  });

  it("returns a safe unavailable response on database failure", async () => {
    h.db!.failWrites.add(TABLE);
    const result = await call(save, { entry: entry({ body: "Private policy body" }), expected_updated_at: null });
    expect(result.response.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain("Private policy body");
  });
});

describe("published knowledge loading", () => {
  it("exposes only published content in this deployment with no private author fields", async () => {
    h.db!.rows(TABLE).push(row(), row({ id: "published", status: "published", category: "procedure" }), row({ id: "other", network: "mainnet", status: "published" }));
    const result = await loadPublishedAssistantKnowledge();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "published", answer: "Rights follow the issuance instrument.", category: "procedure", updatedAt: NOW });
    expect(result[0]).not.toHaveProperty("updated_by");
    expect(result[0]).not.toHaveProperty("created_by");
    expect(result[0]).not.toHaveProperty("network");
  });

  it("returns an intentional empty corpus after unpublishing and never revives static entries", async () => {
    h.db!.rows(TABLE).push(row({ status: "published" }));
    expect(await loadPublishedAssistantKnowledge()).toHaveLength(1);
    await call(save, { entry: entry(), expected_updated_at: NOW });
    expect(await loadPublishedAssistantKnowledge()).toEqual([]);
  });

  it("fails closed on database failure or malformed published data", async () => {
    h.db!.failReads.add(TABLE);
    await expect(loadPublishedAssistantKnowledge()).rejects.toMatchObject({ status: 503 });
    h.db!.failReads.clear();
    h.db!.rows(TABLE).push(row({ status: "published", sources: [{ title: "Bad", href: "javascript:alert(1)" }] }));
    await expect(loadPublishedAssistantKnowledge()).rejects.toMatchObject({ status: 503 });
  });

  it("reads beyond the PostgREST page size rather than silently dropping knowledge", async () => {
    h.db!.rows(TABLE).push(...Array.from({ length: 501 }, (_, index) => row({ id: `item-${index}`, status: "published" })));
    expect(await loadPublishedAssistantKnowledge()).toHaveLength(501);
  });
});

describe("shared knowledge validation", () => {
  it.each(["/legal-structure", "/docs/manci-answers#rights", "https://example.com/terms"])("accepts public source %s", (url) => {
    expect(isAssistantKnowledgeSourceUrl(url)).toBe(true);
  });
  it.each(["javascript:alert(1)", "http://example.com", "//example.com", "/\\example.com", "https://user:password@example.com", "/api/private", "/admin", "/account/docs", "/docs/../admin", "/%61dmin", "/bad%5cpath", "https://example.com/\n"])("rejects unsafe or private source %s", (url) => {
    expect(isAssistantKnowledgeSourceUrl(url)).toBe(false);
  });
  it.each([
    { id: "Uppercase" }, { title: " " }, { body: "x".repeat(12_001) }, { category: "private" },
    { keywords: Array(41).fill("keyword") }, { keywords: ["x".repeat(81)] },
    { status: "published", sources: [] }, { sources: [{ title: "Bad", href: "ftp://example.com" }] },
    { provenance: [{ title: "Evidence", section: "Section", date: "2026-99-99" }] },
  ])("refuses invalid data before signing (%j)", (patch) => {
    expect(() => parseAssistantKnowledgeSave({ entry: entry(patch), expected_updated_at: null })).toThrow();
  });
});
