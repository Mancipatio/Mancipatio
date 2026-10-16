// Issuers and operators on phones could not reach Manage, Activate or Archive
// on /issuer/assets and /admin/assets: the trailing Manage column was clipped
// by an overflow-hidden container (#76 found the same on the holder pages).
// The row actions now render under the asset name, with the same handlers
// and disabled states, and the table scrolls sideways as a safety net.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (...segments: string[]) =>
  fs.readFileSync(path.join(__dirname, "..", "app", ...segments, "page.tsx"), "utf8");

const pages = {
  "/issuer/assets": {
    src: read("issuer", "assets"),
    idLine: "{a.assetId} · {a.symbolPrefix}",
    // In this order, under the ID line: Archive/Unarchive, then Manage.
    actions: ["setArchiveTarget({ pda, label: title", "Manage →"],
    skeleton: "<SkeletonTable rows={3} cols={4} />",
  },
  "/admin/assets": {
    src: read("admin", "assets"),
    idLine: "{asset.assetId} · {asset.symbolPrefix}",
    // Activate, then Archive/Unarchive, then Manage.
    actions: ["setActivateTarget({ asset, assetPda })", "setArchiveTarget({ assetPda, label: title", "Manage →"],
    skeleton: "<SkeletonTable rows={5} cols={5} />",
  },
};

describe.each(Object.entries(pages))("%s row actions", (_route, page) => {
  it("has no trailing Manage column and a horizontally scrollable table", () => {
    expect(page.src).not.toMatch(/>Manage<\/th>/);
    expect(page.src).toMatch(/overflow-x-auto rounded-xl[^"]*">\s*<table/);
    expect(page.src).not.toMatch(/overflow-hidden rounded-xl[^"]*">\s*<table/);
    // One column fewer in the loading skeleton too.
    expect(page.src).toContain(page.skeleton);
  });

  it("renders each action once, under the asset name (before the Category cell)", () => {
    const idLine = page.src.indexOf(page.idLine);
    const categoryCell = page.src.indexOf("{categoryLabel}</td>");
    expect(idLine).toBeGreaterThan(-1);
    expect(categoryCell).toBeGreaterThan(idLine);
    expect(page.src.indexOf(page.idLine, idLine + 1)).toBe(-1);
    let previous = idLine;
    for (const anchor of page.actions) {
      const at = page.src.indexOf(anchor);
      expect(at, anchor).toBeGreaterThan(previous);
      expect(at, anchor).toBeLessThan(categoryCell);
      expect(page.src.indexOf(anchor, at + 1), anchor).toBe(-1);
      previous = at;
    }
  });
});

describe("/admin/assets Activate on a touch screen", () => {
  const src = pages["/admin/assets"].src;

  it("says why Activate is disabled as visible text, since a title tooltip never shows on a phone", () => {
    expect(src).toContain('<span className="basis-full text-[11px] text-slate-500">{blockHint}</span>');
    // The tooltip stays for pointer devices, with the same hint.
    expect(src).toMatch(/title=\{\s*blockHint \?\?/);
  });

  it("keeps the row key by PDA (two issuers may share an assetId)", () => {
    expect(src).toContain("key={assetPda ?? `${asset.issuer}:${asset.assetId}`}");
  });
});
