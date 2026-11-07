import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ load: vi.fn(), quota: vi.fn(), claude: vi.fn() }));
vi.mock("@/lib/server/assistant-knowledge", () => ({ loadPublishedAssistantKnowledge: mocks.load }));
vi.mock("@/lib/server/assistant-quota", () => ({ reserveAssistantQuota: mocks.quota }));
vi.mock("@/lib/server/manci-assistant", () => ({ answerWithClaude: mocks.claude }));

import { POST } from "@/app/api/assistant/route";
import { KNOWLEDGE_VERSION, type KnowledgeEntry } from "@/lib/assistant/knowledge";
import { publishedKnowledgeVersion } from "@/lib/assistant/version";

const published: KnowledgeEntry = {
  id: "published-registration-policy",
  title: "Current registration policy",
  keywords: ["ownership"],
  answer: "Read the published terms for your issuance.\n\n1. Check the instrument.\n2. Confirm the legal transfer steps.",
  sources: [{ title: "Legal structure", href: "/legal-structure" }],
  category: "policy",
  updatedAt: "2026-11-07T20:00:00.000Z",
};
const unrelated: KnowledgeEntry = {
  ...published, id: "published-delivery-procedure", title: "Delivery procedure",
  keywords: ["delivery"], answer: "The separately published delivery procedure.",
  updatedAt: "2026-11-08T10:00:00.000Z",
};
const request = (question = "How does token ownership work?") => new Request("https://www.manci.io/api/assistant", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://www.manci.io" },
  body: JSON.stringify({ messages: [{ role: "user", content: question }] }),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.manci.io");
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-provider-key");
  mocks.load.mockResolvedValue([published, unrelated]);
  mocks.quota.mockResolvedValue("allowed");
  mocks.claude.mockResolvedValue({
    answer: "The published terms explain the registration steps.",
    sources: [{ title: published.title, href: `/docs/manci-answers#${published.id}` }],
    mode: "claude", knowledgeVersion: "stale-provider-version",
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("public assistant uses the current published knowledge", () => {
  it("returns the actual published body and latest corpus revision when no provider key is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: {
      answer: published.answer,
      sources: [{ title: published.title, href: `/docs/manci-answers#${published.id}` }],
      mode: "knowledge", knowledgeVersion: unrelated.updatedAt,
    } });
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.claude).not.toHaveBeenCalled();
  });

  it("passes only matching published entries to Claude after loading and reserving quota", async () => {
    const response = await POST(request());
    const body = await response.json();
    expect(body.data.mode).toBe("claude");
    expect(body.data.knowledgeVersion).toBe(unrelated.updatedAt);
    expect(mocks.claude).toHaveBeenCalledOnce();
    expect(mocks.claude.mock.calls[0][1]).toEqual([published]);
    expect(mocks.load.mock.invocationCallOrder[0]).toBeLessThan(mocks.quota.mock.invocationCallOrder[0]);
    expect(mocks.quota.mock.invocationCallOrder[0]).toBeLessThan(mocks.claude.mock.invocationCallOrder[0]);
  });

  it("uses the published body, rather than a seed copy, when the quota store is unavailable", async () => {
    mocks.quota.mockResolvedValue("unavailable");
    const body = await (await POST(request())).json();
    expect(body.data).toMatchObject({ answer: published.answer, mode: "knowledge", knowledgeVersion: unrelated.updatedAt });
    expect(mocks.claude).not.toHaveBeenCalled();
  });

  it("reflects an edited published answer and revision on the next request", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const edited = { ...published, answer: "The newly published procedure replaces the previous answer.", updatedAt: "2026-11-09T09:30:00.000Z" };
    mocks.load.mockResolvedValueOnce([published]).mockResolvedValueOnce([edited]);
    const before = await (await POST(request())).json();
    const after = await (await POST(request())).json();
    expect(before.data).toMatchObject({ answer: published.answer, knowledgeVersion: published.updatedAt });
    expect(after.data).toMatchObject({ answer: edited.answer, knowledgeVersion: edited.updatedAt });
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it.each(["Hello", "How does token ownership work?"])("an empty published library never revives static content for %s", async (question) => {
    mocks.load.mockResolvedValue([]);
    const response = await POST(request(question));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.mode).toBe("knowledge");
    expect(body.data.sources).toEqual([{ title: "Contact the Manci team", href: "/contact" }]);
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.claude).not.toHaveBeenCalled();
  });

  it("does not retrieve an unpublished seed topic even when another entry is published", async () => {
    mocks.load.mockResolvedValue([unrelated]);
    const body = await (await POST(request("How does conversion into ownership work?"))).json();
    expect(body.data.sources).toEqual([{ title: "Contact the Manci team", href: "/contact" }]);
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.claude).not.toHaveBeenCalled();
  });

  it.each(["synthetic-provider-key", ""])("fails closed on a library read error without leaking diagnostics, key=%s", async (key) => {
    vi.stubEnv("ANTHROPIC_API_KEY", key);
    const privateDetail = "private database credential, draft article body and internal address";
    mocks.load.mockRejectedValue(new Error(privateDetail));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.data).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(privateDetail);
    expect(errorLog).not.toHaveBeenCalled();
    expect(warningLog).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.claude).not.toHaveBeenCalled();
  });
});

describe("published knowledge revision", () => {
  it("chooses the latest instant across offsets and ignores malformed timestamps", () => {
    expect(publishedKnowledgeVersion([
      { ...published, updatedAt: "2026-11-09T12:00:00+02:00" },
      { ...unrelated, updatedAt: "2026-11-09T11:00:00Z" },
      { ...published, updatedAt: "not-a-date" },
    ])).toBe("2026-11-09T11:00:00.000Z");
  });
  it("keeps the seed edition for legacy or empty entries without implying any published answer", () => {
    expect(publishedKnowledgeVersion([])).toBe(KNOWLEDGE_VERSION);
    expect(publishedKnowledgeVersion([{ ...published, updatedAt: undefined }])).toBe(KNOWLEDGE_VERSION);
  });
});
