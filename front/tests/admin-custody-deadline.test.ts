// /admin/custody, the conversion escrow deadline (F007): the Approve dialog
// proposes 150 days and warns under 120 (the runbook's window: the escrow
// waits for the notary and the APR decision; after the deadline anyone can
// return it to the holder), the queue shows each live escrow's deadline with
// the days left, and the header counts the escrows near it. The warning never
// blocks the open.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CUSTODY_DEADLINE_SOON_DAYS,
  CUSTODY_DEADLINE_URGENT_DAYS,
  DEFAULT_CONVERSION_DEADLINE_DAYS,
  MIN_CONVERSION_DEADLINE_DAYS,
  conversionDeadlineDefault,
  conversionDeadlineWarning,
  custodyDeadlineUrgency,
  deliveryDeadlineError,
} from "@/lib/deadline-bounds";

const DAY = 86_400;
const DAY_MS = DAY * 1000;
// Minute-aligned, and 150 days later is not in a DST fall-back hour anywhere.
const nowMs = Date.UTC(2026, 8, 28, 12, 0, 0);
const parse = (value: string) => new Date(value).getTime();
const at = (days: number) => new Date(nowMs + days * DAY_MS).toISOString();

describe("conversionDeadlineDefault", () => {
  it("proposes exactly 150 days, a value the program accepts", () => {
    expect(DEFAULT_CONVERSION_DEADLINE_DAYS).toBe(150);
    expect(MIN_CONVERSION_DEADLINE_DAYS).toBe(120);
    const value = conversionDeadlineDefault(nowMs);
    expect(parse(value) - nowMs).toBe(150 * DAY_MS);
    expect(deliveryDeadlineError(value, nowMs)).toBeNull();
    expect(conversionDeadlineWarning(value, { nowMs })).toBeNull();
  });
});

describe("conversionDeadlineWarning", () => {
  it("warns under 120 days and names the window", () => {
    expect(conversionDeadlineWarning(at(119), { nowMs })).toMatch(/120–180 days/);
    expect(conversionDeadlineWarning(at(30), { nowMs })).toMatch(/anyone can return/);
    expect(conversionDeadlineWarning(new Date(nowMs + 120 * DAY_MS + 60_000).toISOString(), { nowMs })).toBeNull();
    expect(conversionDeadlineWarning(at(150), { nowMs })).toBeNull();
    expect(conversionDeadlineWarning(at(180), { nowMs })).toBeNull();
  });

  it("warns when the holder's passport expires before the deadline", () => {
    const nowSec = BigInt(nowMs / 1000);
    expect(conversionDeadlineWarning(at(150), { nowMs, passportExpirySec: nowSec + BigInt(100 * DAY) })).toMatch(/passport expires on 2027-01-06/);
    expect(conversionDeadlineWarning(at(150), { nowMs, passportExpirySec: nowSec + BigInt(200 * DAY) })).toBeNull();
    // A passport that has already expired is named as such, not as "expires on".
    expect(conversionDeadlineWarning(at(150), { nowMs, passportExpirySec: nowSec - BigInt(10 * DAY) })).toMatch(/passport expired on 2026-09-18: the burn is refused until the passport is renewed/);
    // No entry (0) or no passport read (null): nothing to warn about.
    expect(conversionDeadlineWarning(at(150), { nowMs, passportExpirySec: BigInt(0) })).toBeNull();
    expect(conversionDeadlineWarning(at(150), { nowMs, passportExpirySec: null })).toBeNull();
    // The short-window warning comes first.
    expect(conversionDeadlineWarning(at(100), { nowMs, passportExpirySec: nowSec + BigInt(50 * DAY) })).toMatch(/120–180 days/);
  });

  it("stays silent while the value is empty or outside the program's bounds (the error shows instead)", () => {
    expect(conversionDeadlineWarning("", { nowMs })).toBeNull();
    expect(conversionDeadlineWarning("not a date", { nowMs })).toBeNull();
    expect(conversionDeadlineWarning(at(0.5), { nowMs })).toBeNull();
    expect(conversionDeadlineWarning(at(400), { nowMs })).toBeNull();
  });
});

describe("custodyDeadlineUrgency", () => {
  const nowSec = 1_800_000_000;
  const deadline = (days: number) => BigInt(nowSec + Math.round(days * DAY));
  it("null without a deadline, then ok / soon / urgent / passed", () => {
    expect(CUSTODY_DEADLINE_SOON_DAYS).toBe(30);
    expect(CUSTODY_DEADLINE_URGENT_DAYS).toBe(7);
    expect(custodyDeadlineUrgency(BigInt(0), nowSec)).toBeNull();
    expect(custodyDeadlineUrgency(BigInt(-5), nowSec)).toBeNull();
    expect(custodyDeadlineUrgency(deadline(40), nowSec)).toEqual({ level: "ok", daysLeft: 40 });
    expect(custodyDeadlineUrgency(deadline(30), nowSec)).toEqual({ level: "ok", daysLeft: 30 });
    expect(custodyDeadlineUrgency(deadline(29.5), nowSec)).toEqual({ level: "soon", daysLeft: 29 });
    expect(custodyDeadlineUrgency(deadline(7), nowSec)).toEqual({ level: "soon", daysLeft: 7 });
    expect(custodyDeadlineUrgency(deadline(6), nowSec)).toEqual({ level: "urgent", daysLeft: 6 });
    expect(custodyDeadlineUrgency(deadline(0.5), nowSec)).toEqual({ level: "urgent", daysLeft: 0 });
    expect(custodyDeadlineUrgency(BigInt(nowSec), nowSec)).toEqual({ level: "passed", daysLeft: 0 });
    expect(custodyDeadlineUrgency(BigInt(nowSec - 1), nowSec)).toEqual({ level: "passed", daysLeft: 0 });
  });
});

describe("/admin/custody wiring (source)", () => {
  const page = readFileSync(join(process.cwd(), "app/admin/custody/page.tsx"), "utf8");
  const functionSource = (name: string) => {
    const start = page.indexOf(`\nfunction ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const end = page.indexOf("\nfunction ", start + 1);
    return page.slice(start, end < 0 ? undefined : end);
  };

  it("the conversion approval proposes the conversion default and warns; the delivery approval keeps its 30 days", () => {
    const modal = functionSource("ApproveConversionModal");
    expect(modal).toContain("conversionDeadlineDefault()");
    expect(modal).toContain("conversionDeadlineWarning(deadlineDate, {");
    expect(modal).toContain("passportExpirySec: holderPassport?.expiry ?? null");
    expect(modal).not.toContain("30 * DAY_MS");
    expect(modal).toContain("{deadlineWarning}");
    expect(modal).toContain("Burn right after the registration.");
    // Advisory only: the warning is in neither the guard nor the button.
    const guard = modal.slice(modal.indexOf("async function approve()"), modal.indexOf("const target = conversionTargetLabel(req);"));
    expect(guard).not.toContain("deadlineWarning");
    const button = modal.slice(modal.indexOf("onClick={() => void approve()}"), modal.indexOf("Open vault", modal.indexOf("onClick={() => void approve()}")));
    expect(button).toContain("deadlineError !== null");
    expect(button).not.toContain("deadlineWarning");
    expect(functionSource("ApproveDeliveryModal")).toContain("30 * DAY_MS");
  });

  it("the conversion queue has a Deadline column and counts the escrows near it", () => {
    const queue = functionSource("ConversionRequestsSection");
    expect(queue).toContain('<th className="px-4 py-3 font-medium">Deadline</th>');
    expect(queue).toContain("<DeadlineCell info={info} nowSec={nowSec} />");
    expect(queue).toContain("custodyDeadlineUrgency(info.deadline, nowSec)");
    expect(queue).toContain("{nearDeadline} near deadline");
    const cell = functionSource("DeadlineCell");
    expect(cell).toContain("custodyDeadlineUrgency(info.deadline, nowSec)");
    expect(cell).toContain("Deadline passed — anyone can return the escrow to the holder");
    expect(cell).toContain("{urgency.daysLeft} days left");
  });
});
