import { describe, expect, it } from "vitest";
import { retrieveKnowledge } from "@/lib/assistant/retrieval";
import type { KnowledgeEntry } from "@/lib/assistant/knowledge";

const entry: KnowledgeEntry = {
  id: "refund-policy", title: "Refund policy", keywords: [],
  answer: "The documented refund conditions.",
  sources: [{ title: "Terms", href: "/legal/terms" }],
};

describe("admin-authored titles without keywords", () => {
  it.each(["Refund policy", "What is the refund policy?", "Please explain the refund policy"])("finds %s", (content) => {
    expect(retrieveKnowledge({ messages: [{ role: "user", content }] }, [entry])).toEqual([entry]);
  });
  it("does not mistake a partial title or unrelated question for a match", () => {
    for (const content of ["policy", "What is your privacy policy?", "Tell me about ownership"]) {
      expect(retrieveKnowledge({ messages: [{ role: "user", content }] }, [entry])).toEqual([]);
    }
  });
});
