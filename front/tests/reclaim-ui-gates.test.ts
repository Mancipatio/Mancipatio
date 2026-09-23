import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  custodyReclaimBlocker,
  randomAccountId,
  reclaimState,
} from "@/lib/reclaim-rent";

describe("2D reclaim UI gates", () => {
  it("offers a reclaim only for a terminal parent whose live escrow reads 0", () => {
    expect(reclaimState(false, BigInt(0))).toBe("live");
    expect(reclaimState(true, BigInt(0))).toBe("reclaimable");
    expect(reclaimState(true, BigInt(1))).toBe("escrow-not-empty");
    expect(reclaimState(true, null)).toBe("unknown");
    expect(reclaimState(true, undefined)).toBe("unknown");
  });

  it("closes a custody vault only when settled, empty, by its authority, with settled requests", () => {
    const base = {
      wallet: "A",
      authority: "A",
      terminal: true,
      escrowBalance: BigInt(0),
      linked: [] as { status: string; outcome_evidence?: unknown }[],
    };
    expect(custodyReclaimBlocker(base)).toBeNull();
    expect(custodyReclaimBlocker({ ...base, terminal: false })).toMatch(/realized/);
    expect(custodyReclaimBlocker({ ...base, wallet: "B" })).toMatch(/authority/);
    expect(custodyReclaimBlocker({ ...base, escrowBalance: null })).toMatch(/could not be read/);
    expect(custodyReclaimBlocker({ ...base, escrowBalance: BigInt(2) })).toMatch(/still holds/);
    expect(
      custodyReclaimBlocker({ ...base, linked: [{ status: "in_delivery" }] }),
    ).toMatch(/in progress/);
    expect(
      custodyReclaimBlocker({ ...base, linked: [{ status: "delivered" }] }),
    ).toMatch(/verified outcome/);
    expect(
      custodyReclaimBlocker({
        ...base,
        linked: [{ status: "returned", outcome_evidence: { signature: "x" } }, { status: "cancelled" }],
      }),
    ).toBeNull();
  });

  it("defaults new offer ids to random u53 values (a tombstoned id is never reusable)", () => {
    const ids = new Set(Array.from({ length: 64 }, randomAccountId));
    expect(ids.size).toBe(64);
    for (const id of ids) {
      expect(id).toMatch(/^\d+$/);
      expect(BigInt(id) <= BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    }
  });

  it("never bundles an offer's reclaim with its cancel", () => {
    const page = readFileSync(join(process.cwd(), "app/portfolio/offers/page.tsx"), "utf8");
    const cancel = page.slice(
      page.indexOf("async function cancelOffer"),
      page.indexOf("if (!conn.isReady || !wallet)"),
    );
    expect(cancel.length).toBeGreaterThan(0);
    expect(cancel).not.toMatch(/reclaim/i);
    const reclaim = page.slice(
      page.indexOf("async function reclaimRent"),
      page.indexOf("async function reclaimRent") + 1200,
    );
    expect(reclaim).toMatch(/instructions: \[ix\]/);
    expect(reclaim).not.toMatch(/Cancel(Offer)?Instruction/);
  });
});
