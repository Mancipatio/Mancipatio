import { describe, expect, it } from "vitest";
import { knowledgeForm, knowledgeSaveParams, knowledgeSlug } from "@/app/admin/assistant/editor-form";
import { parseAssistantKnowledgeSave, type AssistantKnowledgeAdminEntry } from "@/lib/assistant/knowledge-admin";

const baseline: AssistantKnowledgeAdminEntry = {
  id: "ownership", title: "How ownership works", category: "answer", status: "published",
  keywords: ["ownership", "investor rights"], body: "The rights depend on the offer documents.",
  sources: [{ title: "Legal structure", href: "/legal-structure" }],
  provenance: [{ title: "Manci presentation", section: "Ownership", date: "2026-11-07" }],
  network: "mainnet", created_by: "wallet-one", updated_by: "wallet-two",
  created_at: "2026-11-07T10:00:00Z", updated_at: "2026-11-07T11:00:00.123456Z",
};

describe("assistant knowledge editor", () => {
  it("keeps the loaded revision and provenance when changing public text", () => {
    const form = knowledgeForm(baseline);
    form.body = "Updated approved wording.";
    const saved = parseAssistantKnowledgeSave(knowledgeSaveParams(form, baseline, "published"));
    expect(saved.expected_updated_at).toBe(baseline.updated_at);
    expect(saved.entry.provenance).toEqual(baseline.provenance);
    expect(saved.entry.body).toBe(form.body);
    expect(saved.entry).not.toHaveProperty("network");
    expect(saved.entry).not.toHaveProperty("created_by");
    expect(saved.entry).not.toHaveProperty("updated_by");
  });

  it("never turns an existing edit into a new entry by changing its ID", () => {
    const form = knowledgeForm(baseline);
    form.id = "different-id";
    const params = knowledgeSaveParams(form, baseline, "draft");
    expect(params.entry.id).toBe("ownership");
    expect(params.entry.status).toBe("draft");
    expect(params.expected_updated_at).toBe(baseline.updated_at);
  });

  it("keeps new content private until an explicit publish action with a source", () => {
    const form = { ...knowledgeForm(null), id: "new-policy", title: "New policy", category: "policy" as const, body: "Approved process." };
    const draft = parseAssistantKnowledgeSave(knowledgeSaveParams(form, null, "draft"));
    expect(draft.expected_updated_at).toBeNull();
    expect(draft.entry.status).toBe("draft");
    expect(draft.entry.sources).toEqual([]);
    expect(() => parseAssistantKnowledgeSave(knowledgeSaveParams(form, null, "published"))).toThrow(/source/i);
    form.sources.push({ title: "Public policy", href: "/legal/privacy", section: "" });
    expect(parseAssistantKnowledgeSave(knowledgeSaveParams(form, null, "published")).entry.status).toBe("published");
  });

  it("copies source rows so typing cannot alter the saved baseline", () => {
    const form = knowledgeForm(baseline);
    form.sources[0].href = "/legal/terms";
    expect(baseline.sources[0].href).toBe("/legal-structure");
    expect(knowledgeForm(baseline).sources[0].section).toBe("");
  });

  it("normalizes comma-separated keywords and optional source sections", () => {
    const form = knowledgeForm(baseline);
    form.keywords = "ownership, investor rights, , ownership, procedures ";
    form.sources[0].section = "  Section two  ";
    const { entry } = parseAssistantKnowledgeSave(knowledgeSaveParams(form, baseline, "draft"));
    expect(entry.keywords).toEqual(["ownership", "investor rights", "procedures"]);
    expect(entry.sources[0].section).toBe("Section two");
  });

  it("checks the same URL rules before a wallet prompt", () => {
    const form = knowledgeForm(baseline);
    for (const href of ["javascript:alert(1)", "//example.com", "/admin/documents"]) {
      form.sources[0].href = href;
      expect(() => parseAssistantKnowledgeSave(knowledgeSaveParams(form, baseline, "published"))).toThrow(/Source URL/i);
    }
  });

  it("generates valid bounded IDs from ordinary titles", () => {
    expect(knowledgeSlug("  Investor rights & procedures?  ")).toBe("investor-rights-procedures");
    expect(knowledgeSlug("Café ownership")).toBe("cafe-ownership");
    expect(knowledgeSlug(`${"a".repeat(79)} next`)).toBe("a".repeat(79));
    expect(knowledgeSlug("a".repeat(200))).toHaveLength(80);
  });
});
