import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  custodyReclaimBlocker,
  linkedCustodyRequests,
  randomAccountId,
  reclaimState,
  type LinkedCustodyRequest,
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
      linked: [] as LinkedCustodyRequest[] | null,
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

  it("keeps the custody reclaim closed until the linked requests are loaded", () => {
    const base = {
      wallet: "A",
      authority: "A",
      terminal: true,
      escrowBalance: BigInt(0),
    };
    expect(custodyReclaimBlocker({ ...base, linked: null })).toMatch(/not loaded/);
    expect(custodyReclaimBlocker({ ...base, linked: [] })).toBeNull();
  });

  it("treats a cancelled request as settled only when it never recorded a deposit", () => {
    const base = {
      wallet: "A",
      authority: "A",
      terminal: true,
      escrowBalance: BigInt(0),
    };
    expect(
      custodyReclaimBlocker({ ...base, linked: [{ status: "cancelled", deposit_evidence: null }] }),
    ).toBeNull();
    expect(
      custodyReclaimBlocker({
        ...base,
        linked: [{ status: "cancelled", deposit_evidence: { signature: "d" } }],
      }),
    ).toMatch(/recorded a deposit/);
  });

  it("reduces the vault-filtered admin lists to the vault's linked requests", () => {
    const deliveries = [
      { vault_pda: "V", status: "delivered", outcome_evidence: { signature: "o" }, deposit_evidence: { signature: "d" } },
      { vault_pda: "W", status: "in_delivery" },
    ];
    const conversions = [
      { vault_pda: "V", status: "cancelled" },
      { vault_pda: null, status: "requested" },
    ];
    expect(linkedCustodyRequests("V", deliveries, conversions)).toEqual([
      { status: "delivered", outcome_evidence: { signature: "o" }, deposit_evidence: { signature: "d" } },
      { status: "cancelled", outcome_evidence: null, deposit_evidence: null },
    ]);
  });

  it("the custody detail renders the full gate (linked requests loaded by vault_pda)", () => {
    const page = readFileSync(join(process.cwd(), "app/admin/custody/page.tsx"), "utf8");
    const gate = page.slice(page.indexOf("const reclaimBlocked = custodyReclaimBlocker("));
    expect(gate.slice(0, 400)).toMatch(/linked: linkedRequests/);
    expect(page).toMatch(/adminListDeliveryRequests\(session, undefined, key\)/);
    expect(page).toMatch(/adminListConversionRequests\(session, key\)/);
  });

  it("the take page treats a URL segment that is not an address as not found", () => {
    const page = readFileSync(join(process.cwd(), "app/marketplace/otc/[offer]/page.tsx"), "utf8");
    const branch = page.slice(page.indexOf("if (!matched) {"), page.indexOf("if (!matched) {") + 800);
    expect(branch).toMatch(/isAddress\(offerPubkey\)\s*\?\s*await fetchEncodedAccount/);
    expect(page).not.toMatch(/\baddress\(offerPubkey\)/);
  });

  it("the clawback panel points a closed passport to the one-transaction recovery", () => {
    const panel = readFileSync(join(process.cwd(), "app/admin/kyc/clawback-panel.tsx"), "utf8");
    expect(panel).toMatch(/pre\.entryStatus === "missing"/);
    expect(panel).toMatch(/ONE transaction that re-approves[\s\S]*revokes the passport and claws back/);
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
