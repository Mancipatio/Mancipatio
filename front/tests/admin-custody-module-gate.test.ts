// /admin/custody with conversion off (F074; KYC-only mode included): the
// conversion queue hides only the ENTRY — "Approve & open vault", which
// opens a new escrow — and keeps every exit (reject, cancel, return, confirm)
// and "Finish recording approval" for a vault this wallet already opened.
// The same shape as the delivery queue's gate (tests/pause-gate.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Without comments (a comment may name anything).
const custodyPage = () =>
  readFileSync(join(process.cwd(), "app/admin/custody/page.tsx"), "utf8")
    .replace(/(^[ \t]*|\{)\/\*[\s\S]*?\*\//gm, "$1")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const functionAt = (code: string, index: number) =>
  [...code.slice(0, index).matchAll(/^(?:export (?:default )?)?function (\w+)\(/gm)].at(-1)?.[1];
const functionSource = (code: string, name: string) => {
  const start = code.indexOf(`\nfunction ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = code.indexOf("\nfunction ", start + 1);
  return code.slice(start, end < 0 ? undefined : end);
};
/** Each JSX `{<condition> && (…)}` block whose condition matches `guard`, from its "(" to the matching ")". */
const guardedBlocks = (code: string, guard: RegExp) => {
  const blocks: string[] = [];
  for (const m of code.matchAll(/\{([^{};]*?)&&\s*\(/g)) {
    if (!guard.test(m[1])) continue;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) break;
    }
    blocks.push(code.slice(open, i + 1));
  }
  return blocks;
};

describe("/admin/custody with conversion off hides only the conversion entry", () => {
  const code = custodyPage();

  it("the conversion switch is read by the conversion queue only, on the lines that decide the entry", () => {
    const owners = new Set([...code.matchAll(/\bconversionOn\b/g)].map((m) => functionAt(code, m.index)));
    expect(owners).toEqual(new Set(["ConversionRequestsSection"]));
    const queue = functionSource(code, "ConversionRequestsSection");
    expect(queue.split("\n").filter((l) => /\bconversionOn\b/.test(l)).map((l) => l.trim())).toEqual([
      'const conversionOn = moduleEnabled("custodyConversion");',
      "conversionOn",
      "conversionOn || savedOpens.has(r.id);",
      // The custody-entry pause (0x08) disables the real approve, never "Finish recording".
      "tx.isSending || (conversionOn && entryPaused === true)",
      "conversionOn && entryPaused === true",
      "{conversionOn ? (",
      "{!conversionOn && !savedOpens.has(r.id) ? (",
      "recordOnly={!conversionOn}",
    ]);
  });

  it("every exit stays outside the conversion condition", () => {
    const queue = functionSource(code, "ConversionRequestsSection");
    const guarded = guardedBlocks(queue, /\bconversionOn\b|\bapprovalOffered\(/);
    expect(guarded).toHaveLength(2);
    expect(guarded[0]).toContain("onClick={() => setApproveReq(r)}");
    expect(guarded[1]).toMatch(/^\(\s*<ApproveConversionModal\b/);
    expect(guarded[1]).toContain("recordOnly={!conversionOn}");
    const exits = [
      "setRejectReq(r)", "setCancelOpenReq(r)", "setConfirmReq(r)", "setReturnReq(r)",
      "open={rejectReq !== null}", "open={cancelOpenReq !== null}", "open={confirmReq !== null}", "open={returnReq !== null}",
    ];
    for (const exit of exits) {
      expect(queue).toContain(exit);
      for (const block of guarded) expect(block).not.toContain(exit);
    }
    // Off, the row says why there is no approve button.
    expect(queue).toContain("Approval paused: conversion is switched off.");
    expect(queue).toContain('title={moduleDisabledMessage("custodyConversion")}');
  });

  it("off, the conversion modal never shows the approval form or Open vault", () => {
    const modal = functionSource(code, "ApproveConversionModal");
    expect(modal).toMatch(/async function approve\(\) \{\s*if \(\s*recordOnly \|\|/);
    const recordOnlyView = modal.slice(modal.indexOf("if (recordOnly)"), modal.indexOf("\n  return (", modal.indexOf("if (recordOnly)")));
    expect(recordOnlyView).toContain("{recovery.panel}");
    expect(recordOnlyView).toContain("Finish recording conversion approval");
    expect(recordOnlyView).not.toMatch(/approve\(\)|Open vault|setVaultId|AttestationDocSection|withGateFacts|kycRegistry/);
    // The pinned registry is resolved only when a vault may be opened.
    expect(modal).toContain("usePlatformKycRegistry(!recordOnly)");
  });

  it("keeps the gate facts of the conversion open and the pinned registry exactly where they were", () => {
    expect(code.match(/\bwithGateFacts\(/g)).toHaveLength(1);
    expect(code.match(/custodyPurpose/g)).toHaveLength(1);
    expect(code.match(/kycRegistry: pinnedRegistry,/g)).toHaveLength(2);
  });
});
