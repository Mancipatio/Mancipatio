// The public company fields of a token's profile (lib/company-profile.ts):
// the company's name, its team, its links and the path of its logo. One set
// of rules for writing, projecting and showing a value.
import { describe, expect, it } from "vitest";
import {
  COMPANY_NAME_MAX,
  TEAM_ENTRY_MAX,
  TEAM_MAX,
  companyLinkHref,
  isLogoPathOf,
  normalizeCompanyLink,
  normalizeCompanyName,
  normalizeTeam,
  teamFromLines,
  teamMember,
} from "@/lib/company-profile";

const ASSET = "HzjgBogwPPMzj5m2CgGLyPUv5Qz27TmvbFy9MWbevuv6";

describe("company name", () => {
  it("is one trimmed line, or nothing", () => {
    expect(normalizeCompanyName("  Mancipatio   d.o.o.\n")).toBe("Mancipatio d.o.o.");
    expect(normalizeCompanyName("   ")).toBeNull();
    expect(normalizeCompanyName(null)).toBeNull();
    expect(normalizeCompanyName(undefined)).toBeNull();
  });
  it("refuses what is not text, control characters and an over-long name", () => {
    expect(() => normalizeCompanyName(42)).toThrow();
    expect(() => normalizeCompanyName("Acme\u0000")).toThrow();
    expect(normalizeCompanyName("a".repeat(COMPANY_NAME_MAX))).toHaveLength(COMPANY_NAME_MAX);
    expect(() => normalizeCompanyName("a".repeat(COMPANY_NAME_MAX + 1))).toThrow(/at most/);
  });
});

describe("team", () => {
  it("keeps one line per person and drops blanks", () => {
    expect(normalizeTeam([" Mladen Rakić — CEO & CTO ", "", "Vladimir  Rajković — Legal"])).toEqual([
      "Mladen Rakić — CEO & CTO", "Vladimir Rajković — Legal",
    ]);
    expect(normalizeTeam(null)).toEqual([]);
    expect(teamFromLines("Ana — CFO\r\n\n  Marko  \n")).toEqual(["Ana — CFO", "Marko"]);
  });
  it("refuses what is not a list of text, too many people and an over-long entry", () => {
    expect(() => normalizeTeam("Ana")).toThrow();
    expect(() => normalizeTeam(["Ana", 7])).toThrow();
    expect(() => normalizeTeam(["Ana\u0007"])).toThrow();
    expect(normalizeTeam(Array.from({ length: TEAM_MAX }, (_, i) => `Person ${i}`))).toHaveLength(TEAM_MAX);
    expect(() => normalizeTeam(Array.from({ length: TEAM_MAX + 1 }, (_, i) => `Person ${i}`))).toThrow(/at most/);
    expect(() => normalizeTeam(["a".repeat(TEAM_ENTRY_MAX + 1)])).toThrow(/at most/);
  });
  it("reads a name and an optional role", () => {
    expect(teamMember("Mladen Rakić — CEO & CTO")).toEqual({ name: "Mladen Rakić", role: "CEO & CTO" });
    expect(teamMember("Ana Petrović - CFO")).toEqual({ name: "Ana Petrović", role: "CFO" });
    expect(teamMember("Jean-Luc Picard")).toEqual({ name: "Jean-Luc Picard", role: null });
    expect(teamMember("Marko")).toEqual({ name: "Marko", role: null });
  });
});

describe("links", () => {
  it("accepts an https page on the service's own host", () => {
    expect(normalizeCompanyLink("link_x", " https://x.com/Manci_rwa ")).toBe("https://x.com/Manci_rwa");
    expect(normalizeCompanyLink("link_x", "https://twitter.com/Manci_rwa")).toBe("https://twitter.com/Manci_rwa");
    expect(normalizeCompanyLink("link_linkedin", "https://www.linkedin.com/company/manci")).toBe("https://www.linkedin.com/company/manci");
    expect(normalizeCompanyLink("link_github", "https://github.com/Mancipatio/Mancipatio")).toBe("https://github.com/Mancipatio/Mancipatio");
    expect(normalizeCompanyLink("link_github", "")).toBeNull();
    expect(normalizeCompanyLink("link_github", null)).toBeNull();
  });
  it("refuses another host, another scheme, credentials, a port and a bare home page", () => {
    for (const bad of [
      "https://x.com.evil.example/Manci_rwa", "https://evil.example/x.com/Manci_rwa", "http://x.com/Manci_rwa",
      "javascript:alert(1)", "https://user:pw@x.com/Manci_rwa", "https://x.com:8443/Manci_rwa", "https://x.com/", "x.com/Manci_rwa", 7,
    ]) {
      expect(() => normalizeCompanyLink("link_x", bad), String(bad)).toThrow();
      expect(companyLinkHref("link_x", bad), String(bad)).toBeNull();
    }
    expect(() => normalizeCompanyLink("link_github", "https://x.com/Manci_rwa")).toThrow(/github\.com/);
  });
});

describe("logo path", () => {
  it("is a file under logos/<asset PDA>/, with no traversal", () => {
    expect(isLogoPathOf(ASSET, `logos/${ASSET}/ab12cd.png`)).toBe(true);
    expect(isLogoPathOf(ASSET, `logos/${ASSET}/v1/ab12cd.jpg`)).toBe(true);
    for (const bad of [
      `logos/Other/ab12cd.png`, `whitepapers/${ASSET}/ab12cd.png`, `logos/${ASSET}/../x.png`, `logos/${ASSET}/`,
      `logos/${ASSET}/a b.png`, `https://evil.example/logos/${ASSET}/a.png`, null, 7,
    ]) expect(isLogoPathOf(ASSET, bad), String(bad)).toBe(false);
    expect(isLogoPathOf("", "logos//a.png")).toBe(false);
  });
});
