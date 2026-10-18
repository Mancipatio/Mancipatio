// Evidence in the admin custody queues and the vault detail (r2g5-10,
// r2g6-05): the deposit and burn transactions with what the server verified
// about them, the attestation the vault carries, and what settled a terminal
// vault — read from the request's outcome evidence, never the deposit ledger.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  custodyAttestationHex,
  custodyRequestEvidence,
  custodySettlementProof,
} from "@/lib/custody-authority";

const DEPOSIT = "D".repeat(88);
const BURN = "B".repeat(88);
const converted = {
  status: "converted",
  amount: 250,
  deposit_tx: DEPOSIT,
  outcome_tx: BURN,
  deposit_evidence: { signature: DEPOSIT, slot: "100", amountAtomic: "250", instructionIndex: 1, vault: "V" },
  outcome_evidence: { signature: BURN, slot: "200", amountAtomic: "250", instructionIndex: 1, vault: "V" },
};

describe("custodyRequestEvidence", () => {
  it("a converted row: the verified deposit and the verified burn", () => {
    expect(custodyRequestEvidence(converted)).toEqual([
      { kind: "deposit", signature: DEPOSIT, verified: true, text: "Deposit verified: 250 units · slot 100" },
      { kind: "burn", signature: BURN, verified: true, text: "Burn verified: 250 units · slot 200" },
    ]);
  });

  it("names a burned amount that differs from the request", () => {
    const lines = custodyRequestEvidence({ ...converted, outcome_evidence: { ...converted.outcome_evidence, amountAtomic: "300" } });
    expect(lines[1].text).toBe("Burn verified: 300 units · slot 200 (request 250)");
  });

  it("a returned row names the surplus left in the vault", () => {
    const returned = { ...converted, status: "returned", outcome_evidence: { ...converted.outcome_evidence, surplusRemaining: "5" } };
    expect(custodyRequestEvidence(returned)[1]).toEqual({ kind: "return", signature: BURN, verified: true, text: "Return verified: 250 units · slot 200 · surplus left in vault: 5" });
    const clean = { ...returned, outcome_evidence: { ...returned.outcome_evidence, surplusRemaining: "0" } };
    expect(custodyRequestEvidence(clean)[1].text).toBe("Return verified: 250 units · slot 200");
  });

  it("a cancelled row with a vault close is unverified; a deposit without evidence too", () => {
    expect(custodyRequestEvidence({ status: "cancelled", amount: 1, deposit_tx: null, outcome_tx: BURN })).toEqual([
      { kind: "close", signature: BURN, verified: false, text: "Vault close tx (not verified)" },
    ]);
    expect(custodyRequestEvidence({ status: "deposited", amount: 1, deposit_tx: DEPOSIT, outcome_tx: null })).toEqual([
      { kind: "deposit", signature: DEPOSIT, verified: false, text: "Deposit (not verified)" },
    ]);
    expect(custodyRequestEvidence({ status: "requested", amount: 1, deposit_tx: null, outcome_tx: null })).toEqual([]);
  });

  it("evidence of another signature, or malformed evidence, never counts as verified and never throws", () => {
    const other = { ...converted, outcome_evidence: { ...converted.outcome_evidence, signature: "Z".repeat(88) } };
    expect(custodyRequestEvidence(other)[1]).toMatchObject({ verified: false, text: "Burn (not verified)" });
    for (const bad of ["string", null, 7, [], { signature: BURN }, { signature: BURN, slot: "1" }, { signature: BURN, slot: "x", amountAtomic: "1" }, { signature: BURN, slot: "1", amountAtomic: "1.5" }])
      expect(custodyRequestEvidence({ ...converted, outcome_evidence: bad })[1].verified, JSON.stringify(bad)).toBe(false);
    // Numbers are accepted for slot and amount (the proof stores strings).
    expect(custodyRequestEvidence({ ...converted, outcome_evidence: { signature: BURN, slot: 200, amountAtomic: 250 } })[1].verified).toBe(true);
    expect(custodyRequestEvidence({ ...converted, status: "delivered" })[1].kind).toBe("burn");
  });
});

describe("custodySettlementProof", () => {
  it("reads the verified burn of the converted request, else the verified return", () => {
    expect(custodySettlementProof([{ status: "cancelled" }, { status: "converted", outcome_evidence: converted.outcome_evidence }])).toEqual({ kind: "burn", signature: BURN, amountAtomic: "250", slot: "200" });
    expect(custodySettlementProof([{ status: "returned", outcome_evidence: converted.outcome_evidence }])).toEqual({ kind: "return", signature: BURN, amountAtomic: "250", slot: "200" });
    expect(custodySettlementProof([{ status: "converted", outcome_evidence: { signature: BURN } }])).toBeNull();
    expect(custodySettlementProof([{ status: "converted" }])).toBeNull();
    expect(custodySettlementProof([])).toBeNull();
    expect(custodySettlementProof(null)).toBeNull();
  });
});

describe("custodyAttestationHex", () => {
  const hex = "5c556bbd66342790f5ab2fd662b3958b0830f8937ac76f3c3ae44dfca791e3b7";
  const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
  it("round-trips the attestation and reports no hash for all zeros", () => {
    expect(custodyAttestationHex(bytes(hex))).toBe(hex);
    expect(custodyAttestationHex(new Uint8Array(32))).toBeNull();
    expect(custodyAttestationHex([])).toBeNull();
    expect(custodyAttestationHex([0, 1])).toBe("0001");
  });
});

describe("/admin/custody shows the evidence (source)", () => {
  const page = readFileSync(join(process.cwd(), "app/admin/custody/page.tsx"), "utf8");
  const functionSource = (name: string) => {
    const start = page.indexOf(`\nfunction ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const end = page.indexOf("\nfunction ", start + 1);
    return page.slice(start, end < 0 ? undefined : end);
  };

  it("both queues render the row's evidence and the vault PDA; the directory feeds the attestation", () => {
    for (const name of ["ConversionRequestsSection", "DeliveryRequestsSection"]) {
      const src = functionSource(name);
      expect(src).toContain("<RequestTxEvidence\n");
      expect(src).toContain("row={r}");
      expect(src).toContain("attestation={requestAttestation(attestations, r) ?? undefined}");
      expect(src).toContain('<CopyableAddress label="vault" value={r.vault_pda} />');
    }
    expect(page).toContain('import { detectNetwork, explorerTxUrl } from "@/lib/network";');
    expect(functionSource("RequestTxEvidence")).toContain("custodyRequestEvidence(row)");
    expect(functionSource("CustodyOps")).toContain("custodyAttestationHex(vault.metadataHash)");
  });

  it("the vault detail shows the attestation and what settled the vault, and the surplus line only while a return is possible", () => {
    const detail = functionSource("VaultDetail");
    expect(detail).toContain("custodyAttestationHex(vault.metadataHash)");
    expect(detail).toContain('label="Attestation (sha256)"');
    expect(detail).toContain("custodySettlementProof(linkedRequests)");
    expect(detail).toContain('{settlement.kind === "burn" ? "Burned (verified)" : "Returned (verified)"}');
    expect(detail).not.toContain("String(vault.deposited)} units");
    const surplus = detail.indexOf("0 — a return is KYC-free and closes the vault");
    expect(surplus).toBeGreaterThan(-1);
    // Every vault type: the program's split decides against the mint's hook mode, not the vault type.
    const guard = detail.lastIndexOf("{vaultLive && (", surplus);
    expect(detail).not.toContain("{kycGated && vaultLive && (");
    expect(guard).toBeGreaterThan(-1);
    expect(detail.slice(guard, surplus)).not.toContain("</Field>");
  });
});
