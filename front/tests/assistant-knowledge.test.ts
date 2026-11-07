import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOWLEDGE_ENTRIES, KNOWLEDGE_VERSION } from "@/lib/assistant/knowledge";
import { instrumentBySlug } from "@/lib/instruments";
import { getSolution } from "@/lib/solutions";

const appRoot = fileURLToPath(new URL("../app/", import.meta.url));

describe("public assistant knowledge integrity", () => {
  it("has stable unique anchors and complete English answers", () => {
    expect(KNOWLEDGE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(KNOWLEDGE_ENTRIES.map((entry) => entry.id)).size).toBe(KNOWLEDGE_ENTRIES.length);
    for (const entry of KNOWLEDGE_ENTRIES) {
      expect(entry.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(typeof entry.title).toBe("string");
      expect(typeof entry.answer).toBe("string");
      expect(entry.title.trim().length).toBeGreaterThan(0);
      expect(entry.answer.trim().length).toBeGreaterThan(0);
      expect(entry.sources.length).toBeGreaterThan(0);
      expect(entry.keywords.length).toBeGreaterThan(0);
      for (const source of entry.provenance ?? []) {
        expect(source.title.trim()).not.toBe("");
        expect(source.section.trim()).not.toBe("");
        expect(source.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("links only to existing app pages, never local evidence files or external destinations", () => {
    for (const { sources } of KNOWLEDGE_ENTRIES) {
      for (const { href } of sources) {
        expect(href).toMatch(/^\/(?!\/)/);
        expect(href).not.toMatch(/(?:\.\.|\\|\.(?:pdf|docx|zip|mjs|txt)(?:$|[?#]))/);
        const path = href.split("#")[0].slice(1);
        const staticRoute = [resolve(appRoot, path, "page.tsx"), resolve(appRoot, "(marketing)", path, "page.tsx")].some(existsSync);
        const instrumentRoute = path.startsWith("markets/types/") && Boolean(instrumentBySlug(path.slice("markets/types/".length)));
        const solutionRoute = path.startsWith("solutions/") && Boolean(getSolution(path.slice("solutions/".length)));
        expect(staticRoute || instrumentRoute || solutionRoute, href).toBe(true);
      }
    }
  });
});
