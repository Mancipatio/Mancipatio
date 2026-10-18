// The audit trail of the custody handlers on /admin/custody (F073, r2g5-04):
// `failed` only when nothing was sent, `pending` with the signature once the
// transaction was sent but not recorded, and a stage that tells a wallet
// rejection, a pre-wallet refusal and a landed-but-unrecorded burn apart.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  custodyFailureAudit,
  custodyFailureStage,
  isPreWalletRefusal,
} from "@/lib/custody-authority";
import { PausedFlowError } from "@/lib/pause-gate";
import { PAUSE_CUSTODY_ENTRY } from "@/lib/pause-flags";
import { AssetRegistryInstruction } from "@/lib/generated/asset_registry";

const SIG = "36na8u" + "x".repeat(80);
const base = {
  ix_name: "realize_custody",
  actor_wallet: "W",
  reason: "APR decision 12/2026",
  target_label: "conversion 1234abcd · MANCI0",
  metadata: { conversion_request_id: "1234abcd", request_id: "1234abcd", vault_pda: "V", attestation_hash: "5c" },
  message: "boom",
};

describe("custodyFailureStage", () => {
  it("names how far the action got", () => {
    expect(custodyFailureStage("build", new Error("pda"))).toBe("pre-send");
    expect(custodyFailureStage("send", { code: 4001 })).toBe("wallet");
    expect(custodyFailureStage("send", new Error("transport"))).toBe("wallet");
    expect(custodyFailureStage("send", new PausedFlowError(PAUSE_CUSTODY_ENTRY, AssetRegistryInstruction.OpenCustodyVault))).toBe("pre-send");
    expect(custodyFailureStage("send", Object.assign(new Error("sim"), { name: "SimulationRefusedError" }))).toBe("pre-send");
    expect(custodyFailureStage("record", new Error("503"), SIG)).toBe("sent-unrecorded");
    expect(custodyFailureStage("chain-failed", new Error("failed on-chain"), SIG)).toBe("sent-failed");
    // Without a signature nothing was sent, whatever the stage says.
    expect(custodyFailureStage("record", new Error("x"))).toBe("wallet");
  });

  it("finds a pre-wallet refusal down the cause chain, by name", () => {
    const wrapped = new Error("plan failed", { cause: new Error("hook", { cause: Object.assign(new Error("gate"), { name: "GateAccountSetError" }) }) });
    expect(isPreWalletRefusal(wrapped)).toBe(true);
    for (const name of ["MaintenanceModeError", "MaintenanceUnknownError", "KycOnlyFlowError", "ModuleDisabledFlowError", "SimulationUnavailableError", "EarlierTransactionUnconfirmedError"])
      expect(isPreWalletRefusal(Object.assign(new Error(name), { name })), name).toBe(true);
    expect(isPreWalletRefusal(new Error("Wallet rejected the transaction."))).toBe(false);
    expect(isPreWalletRefusal({ code: 4001 })).toBe(false);
    expect(isPreWalletRefusal(null)).toBe(false);
  });
});

describe("custodyFailureAudit", () => {
  it("a sent, unrecorded burn is pending and keeps its signature in the row and in metadata", () => {
    const row = custodyFailureAudit({ ...base, stage: "record", signature: SIG, err: new Error("Realize is awaiting finalization") });
    expect(row).toMatchObject({
      ix_name: "realize_custody",
      category: "custody",
      actor_wallet: "W",
      reason: base.reason,
      target_label: base.target_label,
      status: "pending",
      tx_signature: SIG,
      metadata: { ...base.metadata, signature: SIG, stage: "sent-unrecorded", error: "boom" },
    });
  });

  it("nothing sent: failed, no signature, with the stage", () => {
    const build = custodyFailureAudit({ ...base, stage: "build", err: new Error("pda") });
    expect(build.status).toBe("failed");
    expect(build.tx_signature).toBeUndefined();
    expect(build.metadata).toMatchObject({ signature: null, stage: "pre-send", error: "boom" });
    expect(custodyFailureAudit({ ...base, stage: "send", err: { code: 4001 } }).metadata?.stage).toBe("wallet");
    expect(custodyFailureAudit({ ...base, stage: "send", err: new PausedFlowError(PAUSE_CUSTODY_ENTRY, AssetRegistryInstruction.OpenCustodyVault) }).metadata?.stage).toBe("pre-send");
  });

  it("a burn the network reported failed: failed, with the signature kept", () => {
    const row = custodyFailureAudit({ ...base, stage: "chain-failed", signature: SIG, err: new Error("failed") });
    expect(row.status).toBe("failed");
    expect(row.tx_signature).toBe(SIG);
    expect(row.metadata).toMatchObject({ signature: SIG, stage: "sent-failed" });
  });

  it("keeps the handler's ids and uses only the allowed status values", () => {
    const row = custodyFailureAudit({ ...base, stage: "send", err: new Error("x") });
    expect(Object.keys(row.metadata ?? {})).toEqual(expect.arrayContaining(["conversion_request_id", "request_id", "vault_pda", "attestation_hash", "signature", "stage", "error"]));
    expect(["success", "failed", "pending"]).toContain(row.status);
  });
});

describe("/admin/custody handlers (source)", () => {
  const page = readFileSync(join(process.cwd(), "app/admin/custody/page.tsx"), "utf8");
  const functionSource = (name: string) => {
    const start = page.indexOf(`\nfunction ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const end = page.indexOf("\nfunction ", start + 1);
    return page.slice(start, end < 0 ? undefined : end);
  };
  const handler = (src: string, name: string) => {
    const start = src.indexOf(`async function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const end = src.indexOf("\n  async function ", start + 1);
    return src.slice(start, end < 0 ? undefined : end);
  };

  it("the four send handlers mark the stage before the wallet and report through custodyFailureAudit", () => {
    expect(page.match(/custodyFailureAudit\(/g)).toHaveLength(6);
    for (const [section, names] of [
      ["ConversionRequestsSection", ["confirmConversion", "cancelAndReturn"]],
      ["DeliveryRequestsSection", ["confirmDelivery", "cancelAndReturn"]],
    ] as const) {
      const src = functionSource(section);
      for (const name of names) {
        const h = handler(src, name);
        const send = h.indexOf('stage = "send";');
        expect(send, `${name} stage=send`).toBeGreaterThan(-1);
        expect(h.indexOf("await tx.send("), `${name} send after stage`).toBeGreaterThan(send);
        expect(h.indexOf('stage = "record";'), `${name} stage=record`).toBeGreaterThan(h.indexOf("sentSignature = sig;"));
        expect(h).toContain("signature: sentSignature,");
        expect(h).toContain("if (prepared)\n        void recordAudit(\n          custodyFailureAudit({");
        expect(h).not.toContain('status: "failed"');
        // The directory shows a landed transaction even when recording failed.
        expect(h).toContain("if (sentSignature) {");
        expect(h).toContain("void onVaultsChanged();");
      }
    }
    // Only the vault card's realize / revert (no request to record) and the
    // no-deposit cancel still write `failed` directly.
    expect(functionSource("VaultDetail").match(/status: "failed"/g)).toHaveLength(2);
    expect(functionSource("ConversionRequestsSection").match(/status: "failed"/g)).toHaveLength(1);
    expect(functionSource("DeliveryRequestsSection")).not.toContain('status: "failed"');
  });

  it("a burn's receipt is saved before any wait, the burn is finalized before it is recorded, and a network failure drops the receipt and is never recorded", () => {
    for (const [section, name, status] of [
      ["ConversionRequestsSection", "confirmConversion", "converted"],
      ["DeliveryRequestsSection", "confirmDelivery", "delivered"],
    ] as const) {
      const h = handler(functionSource(section), name);
      const sent = h.indexOf("sentSignature = sig;");
      // The receipt first — synchronously, right after the send, before the
      // handler waits: a reload during the wait offers Retry recording.
      const save = h.indexOf("const receipt = saveCustodyOutcomeReceipt(");
      expect(save, `${name} receipt`).toBeGreaterThan(sent);
      expect(h.slice(sent, save), `${name} nothing awaited before the receipt`).not.toContain("await ");
      expect(h.slice(save, save + 160)).toContain(`"${status}",`);
      const wait = h.indexOf("await waitForSignature(client.runtime.rpc, sig, {");
      expect(wait, `${name} wait after the receipt`).toBeGreaterThan(save);
      const finality = h.indexOf("await waitForFinalizedSignature(client.runtime.rpc, sig);");
      expect(finality, `${name} finality after the confirmation`).toBeGreaterThan(wait);
      const record = h.indexOf("await outcomeRecovery.record(req.id,");
      expect(record, `${name} record after finality`).toBeGreaterThan(finality);
      const failed = h.indexOf('if (outcome === "failed") {');
      expect(failed).toBeGreaterThan(wait);
      expect(h.slice(failed, finality)).toContain('stage = "chain-failed";');
      expect(h.slice(failed, finality)).toContain("dropCustodyOutcomeReceipt(receipt);");
      expect(h).toContain('"Burn sent — recording pending"');
      expect(h).not.toContain("send() resolves with the confirmed signature");
    }
    expect(functionSource("ConversionRequestsSection")).toContain('"Return sent — recording pending"');
    // The helpers write the hook's own record (same kind, same identity) and only ever drop it.
    const save = functionSource("saveCustodyOutcomeReceipt");
    expect(save).toContain("savePendingChainRecord({");
    expect(save).toContain('kind: "custody_outcome",');
    expect(save).toContain("entityId: custodyOutcomeId(product, requestId, status),");
    expect(functionSource("dropCustodyOutcomeReceipt")).toContain("clearPendingChainRecord(receipt);");
  });

  it("the approve modals report an open that did not complete from the saved intent", () => {
    for (const name of ["ApproveConversionModal", "ApproveDeliveryModal"]) {
      const modal = functionSource(name);
      expect(modal).toContain('stage: saved?.signature ? "record" : saved ? "send" : "build",');
      expect(modal).toContain("signature: saved?.signature ?? undefined,");
      expect(modal).toContain("attestation_hash: attHash,");
    }
    expect(functionSource("savedCustodyOpenIntent")).toContain("readCustodyOpenIntent({");
  });
});
