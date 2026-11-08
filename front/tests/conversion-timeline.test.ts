// lib/conversion-timeline.ts: one timeline per conversion request, for every
// status the 0034 table allows, with the current step, who acts next, the
// vault deadline (only where it matters) and a typical duration per step
// that never reads as a promise.
import { describe, expect, it } from "vitest";
import {
  CONVERSION_DURATIONS_NOTE,
  CONVERSION_STEPS,
  CONVERSION_TYPICAL_DURATIONS,
  conversionTimeline,
  conversionTimelineSummary,
  formatConversionDeadline,
} from "@/lib/conversion-timeline";

const NOW = 1_800_000_000;
const states = (status: string, hasVault = true, vaultDeadlineSec?: number) =>
  conversionTimeline({ status, hasVault, vaultDeadlineSec, nowSec: NOW }).steps.map((s) => s.state);

describe("conversionTimeline", () => {
  it("lists the five steps in order, the off-chain ones marked", () => {
    expect(CONVERSION_STEPS.map((s) => s.label)).toEqual([
      "Requested",
      "Approved, escrow vault open",
      "Units in escrow",
      "Notary and business register filing (off-chain)",
      "Registered, units burned",
    ]);
    expect(CONVERSION_STEPS.filter((s) => s.offChain).map((s) => s.id)).toEqual(["requested", "filing"]);
  });

  it("requested: the review is current, Manci acts next, no deadline yet", () => {
    const t = conversionTimeline({ status: "requested", hasVault: false, vaultDeadlineSec: NOW + 99, nowSec: NOW });
    expect(t.steps.map((s) => s.state)).toEqual(["current", "upcoming", "upcoming", "upcoming", "upcoming"]);
    expect(t.current).toBe("requested");
    expect(t.position).toBe(1);
    expect(t.next).toEqual({
      actor: "manci",
      text: "Manci reviews your request and opens the escrow vault.",
      operatorText: "Review the request; approving opens the escrow vault.",
    });
    expect(t.deadline).toBeNull();
    expect(t.terminal).toBeNull();
    expect(t.complete).toBe(false);
  });

  it("vault_opened: the deposit is current and the holder acts before the on-chain deadline", () => {
    const t = conversionTimeline({ status: "vault_opened", hasVault: true, vaultDeadlineSec: BigInt(NOW + 86_400), nowSec: BigInt(NOW) });
    expect(t.steps.map((s) => s.state)).toEqual(["done", "current", "upcoming", "upcoming", "upcoming"]);
    expect(t.current).toBe("escrow_open");
    expect(t.next?.actor).toBe("holder");
    expect(t.deadline).toEqual({ atSec: NOW + 86_400, passed: false });
  });

  it("vault_opened after the deadline: asks to contact Manci instead of depositing", () => {
    const t = conversionTimeline({ status: "vault_opened", hasVault: true, vaultDeadlineSec: NOW - 1, nowSec: NOW });
    expect(t.deadline).toEqual({ atSec: NOW - 1, passed: true });
    expect(t.next).toMatchObject({ actor: "manci", text: "The vault deadline has passed: contact Manci before depositing." });
    expect(t.next?.operatorText).toMatch(/Cancel \(no deposit\)/);
  });

  it("deposited: units in escrow are done, the off-chain filing is current, Manci acts", () => {
    const t = conversionTimeline({ status: "deposited", hasVault: true, vaultDeadlineSec: NOW + 10, nowSec: NOW });
    expect(t.steps.map((s) => s.state)).toEqual(["done", "done", "done", "current", "upcoming"]);
    expect(t.current).toBe("filing");
    expect(t.position).toBe(4);
    expect(t.next?.actor).toBe("manci");
    expect(t.deadline?.passed).toBe(false);
  });

  it("deposited after the deadline: the holder may reclaim", () => {
    const t = conversionTimeline({ status: "deposited", hasVault: true, vaultDeadlineSec: NOW, nowSec: NOW });
    expect(t.deadline?.passed).toBe(true);
    expect(t.next?.actor).toBe("holder");
    expect(t.next?.text).toMatch(/you can reclaim your units/);
    expect(t.next?.operatorText).toMatch(/anyone can now return the escrow/);
  });

  it("converted: every step done, nothing next, no deadline", () => {
    const t = conversionTimeline({ status: "converted", hasVault: true, vaultDeadlineSec: NOW + 5, nowSec: NOW });
    expect(t.steps.every((s) => s.state === "done")).toBe(true);
    expect(t).toMatchObject({ complete: true, current: null, next: null, deadline: null, terminal: null, position: 5 });
  });

  it("cancelled before approval and after the vault opened: different branch points, nothing moved", () => {
    const early = conversionTimeline({ status: "cancelled", hasVault: false });
    expect(early.steps.map((s) => s.state)).toEqual(["done", "skipped", "skipped", "skipped", "skipped"]);
    expect(early.terminal).toMatchObject({ kind: "cancelled", afterStep: "requested" });
    expect(early.terminal?.detail).toMatch(/no units moved/);
    const late = conversionTimeline({ status: "cancelled", hasVault: true });
    expect(late.steps.map((s) => s.state)).toEqual(["done", "done", "skipped", "skipped", "skipped"]);
    expect(late.terminal).toMatchObject({ kind: "cancelled", afterStep: "escrow_open" });
    expect(late.next).toBeNull();
    expect(late.deadline).toBeNull();
  });

  it("returned: branches after the units were in escrow", () => {
    expect(states("returned")).toEqual(["done", "done", "done", "skipped", "skipped"]);
    const t = conversionTimeline({ status: "returned", hasVault: true });
    expect(t.terminal).toMatchObject({ kind: "returned", afterStep: "in_escrow" });
    expect(t.terminal?.detail).toMatch(/returned to the holder's wallet/);
  });

  it("an unknown status (an older schema's approved) marks nothing", () => {
    for (const status of ["approved", "", "delivered"]) {
      const t = conversionTimeline({ status, hasVault: false });
      expect(t.known).toBe(false);
      expect(t.steps.every((s) => s.state === "upcoming")).toBe(true);
      expect(t.next).toBeNull();
      expect(conversionTimelineSummary(t)).toBe("Status unknown");
    }
  });

  it("ignores an unreadable deadline", () => {
    for (const vaultDeadlineSec of [0, -5, null, undefined, Number.NaN]) {
      expect(conversionTimeline({ status: "vault_opened", hasVault: true, vaultDeadlineSec, nowSec: NOW }).deadline).toBeNull();
    }
  });
});

describe("typical durations", () => {
  it("carries the owner's figures, one per step that has a duration", () => {
    expect(CONVERSION_TYPICAL_DURATIONS).toEqual({
      review: "about 2 business days",
      deposit: "until the vault deadline",
      filing: "5–10 business days",
      registerDecision: "about 5 business days after filing",
    });
    const byId = Object.fromEntries(CONVERSION_STEPS.map((s) => [s.id, s.typical]));
    expect(byId).toEqual({
      requested: "Review by Manci: typically about 2 business days.",
      escrow_open: "Deposit: any time until the vault deadline.",
      in_escrow: "Recorded as soon as the deposit is final on Solana.",
      filing: "Notary appointment and filing: typically 5–10 business days.",
      registered: "Register decision: typically about 5 business days after filing; then the escrowed units are burned.",
    });
  });

  it("phrases durations as typical, never as a promise", () => {
    const texts = [
      ...CONVERSION_STEPS.map((s) => s.typical),
      ...["requested", "vault_opened", "deposited"].flatMap((status) =>
        [NOW - 1, NOW + 1].flatMap((d) => {
          const next = conversionTimeline({ status, hasVault: true, vaultDeadlineSec: d, nowSec: NOW }).next;
          return [next?.text ?? "", next?.operatorText ?? ""];
        })),
    ];
    for (const text of texts) expect(text).not.toMatch(/\b(will take|guarantee[ds]?|promise[ds]?|within|at most|no later than)\b/i);
    // The note under every timeline is the disclaimer itself.
    expect(CONVERSION_DURATIONS_NOTE).toMatch(/^Durations are typical, not guaranteed:/);
  });
});

describe("conversionTimelineSummary", () => {
  it("names the step, the ending or completion", () => {
    expect(conversionTimelineSummary(conversionTimeline({ status: "deposited", hasVault: true })))
      .toBe("Step 4 of 5: Notary and business register filing (off-chain)");
    expect(conversionTimelineSummary(conversionTimeline({ status: "requested", hasVault: false }))).toBe("Step 1 of 5: Requested");
    expect(conversionTimelineSummary(conversionTimeline({ status: "converted", hasVault: true }))).toBe("Step 5 of 5: complete");
    expect(conversionTimelineSummary(conversionTimeline({ status: "returned", hasVault: true })))
      .toBe("Returned after step 3 of 5 (Units in escrow)");
    expect(conversionTimelineSummary(conversionTimeline({ status: "cancelled", hasVault: false })))
      .toBe("Cancelled after step 1 of 5 (Requested)");
  });
});

describe("formatConversionDeadline", () => {
  it("writes the chain instant in UTC", () => {
    expect(formatConversionDeadline(Date.parse("2027-03-09T14:00:59Z") / 1000)).toBe("2027-03-09 14:00 UTC");
  });
});
