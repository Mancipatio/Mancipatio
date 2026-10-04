// lib/simulation-gate: what the verified client refuses before the wallet
// opens, and how it says so. The failing program is the innermost
// `Program <id> failed` line (a hook refusal inside a Token-2022 transfer is
// the hook's), the code is read with that program (6003 is SenderBlocked in
// the hook and AssetNotDraft in the registry), and the step number counts
// the app's instructions, not the compute budget the send path puts in front.
import { describe, expect, it, vi } from "vitest";
import {
  address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  type Instruction,
} from "@solana/kit";
import { CLOSE_SALE_DISCRIMINATOR, LOCK_SUPPLY_DISCRIMINATOR, OPEN_SALE_DISCRIMINATOR } from "@/lib/generated/asset_registry";
import {
  computeUnitLimitFromSimulation,
  describeInstruction,
  refusalFromSimulation,
  simulateInstructions,
  simulateMessage,
  SimulationRefusedError,
  waitForSignature,
  waitForSignatures,
  type SimulationRpc,
  type SimulationVerdict,
} from "@/lib/simulation-gate";
import {
  APPROVER_NOT_ADMIN_HINT,
  classifyFailure,
  INVALID_KYC_REGISTRY_HINT,
  KYC_REGISTRY_NOT_AUTHORITY_HINT,
  NO_PENDING_AUTHORITY_TRANSFER_HINT,
  NO_SALE_APPROVAL_HINT,
  PLATFORM_PAUSED_HINT,
  programErrorHint,
  SALE_APPROVAL_OTHER_ID_HINT,
  SALE_AUTHORITY_HINT,
  SALE_SYNC_SUFFIX,
} from "@/lib/program-errors";
import { explainSendError } from "@/lib/tx-error";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS, decodeComputeBudgetInstruction } from "@/lib/compute-budget";

const HOOK = "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy";
const REGISTRY_PROGRAM = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const WALLET = address("6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP");

/** The send: [create recipient account, transfer_checked]. */
const SEND: Instruction[] = [
  { programAddress: address(ATA), data: new Uint8Array([1]) },
  { programAddress: address(TOKEN_2022), data: new Uint8Array([12, 136, 19, 0, 0, 0, 0, 0, 0, 0]) },
];

/** What Token-2022 → hook logs when the hook refuses the transfer at message index 3 ([limit, price, ata, transfer]). */
function hookRefusal(code: number, name: string): SimulationVerdict {
  return {
    err: { InstructionError: [3, { Custom: code }] },
    logs: [
      `Program ${ATA} invoke [1]`,
      `Program ${ATA} success`,
      `Program ${TOKEN_2022} invoke [1]`,
      "Program log: Instruction: TransferChecked",
      `Program ${HOOK} invoke [2]`,
      `Program log: AnchorError thrown in programs/transfer_hook/src/lib.rs:1051. Error Code: ${name}. Error Number: ${code}. Error Message: x.`,
      `Program ${HOOK} consumed 9000 of 180000 compute units`,
      `Program ${HOOK} failed: custom program error: 0x${code.toString(16)}`,
      `Program ${TOKEN_2022} failed: custom program error: 0x${code.toString(16)}`,
    ],
    unitsConsumed: 30_000,
  };
}

const refuse = (verdict: SimulationVerdict, app: Instruction[] = SEND, prefix = 2) =>
  refusalFromSimulation(verdict, { appInstructions: app, messageInstructionCount: app.length + prefix, network: "devnet" });

describe("refusalFromSimulation", () => {
  it("nothing to refuse when the simulation succeeded", () => {
    expect(refuse({ err: null, logs: [], unitsConsumed: 1 })).toBeNull();
  });

  it("6005 ReceiverNotApproved: step 2 of 2, the transfer hook, in plain words", () => {
    const refusal = refuse(hookRefusal(6005, "ReceiverNotApproved"))!;
    expect(refusal).toBeInstanceOf(SimulationRefusedError);
    expect(refusal.name).toBe("SimulationRefusedError");
    expect([refusal.instructionIndex, refusal.instructionCount, refusal.program, refusal.code, refusal.errorName]).toEqual([
      1, 2, "transfer_hook", 6005, "ReceiverNotApproved",
    ]);
    expect(refusal.message).toBe(
      "This transaction would fail, so your wallet was not opened. Step 2 of 2 (token transfer) was refused by the Manci transfer hook: " +
        "The recipient has no approved investor passport in this share class's KYC registry (ReceiverNotApproved, 6005).",
    );
    expect(explainSendError(refusal)).toBe(refusal.message);
  });

  it("6006 HolderKycExpired and 6003 SenderBlocked", () => {
    expect(refuse(hookRefusal(6006, "HolderKycExpired"))!.detail).toBe(
      "Step 2 of 2 (token transfer) was refused by the Manci transfer hook: The recipient's investor passport has expired. It must be renewed before the recipient can receive tokens (HolderKycExpired, 6006).",
    );
    const blocked = refuse(hookRefusal(6003, "SenderBlocked"))!;
    expect(blocked.errorName).toBe("SenderBlocked");
    expect(blocked.detail).toMatch(/^Step 2 of 2 \(token transfer\) was refused by the Manci transfer hook: The sending wallet is on the Manci blocklist/);
  });

  it("hook 6003 and registry 6003 (AssetNotDraft) are told apart by the program", () => {
    const registry: SimulationVerdict = {
      err: { InstructionError: [2, { Custom: 6003 }] },
      logs: [`Program ${REGISTRY_PROGRAM} invoke [1]`, `Program ${REGISTRY_PROGRAM} failed: custom program error: 0x1773`],
      unitsConsumed: 1,
    };
    const app = [{ programAddress: address(REGISTRY_PROGRAM), data: new Uint8Array(8) }];
    const refusal = refuse(registry, app)!;
    expect([refusal.program, refusal.errorName]).toEqual(["asset_registry", "AssetNotDraft"]);
    expect(refusal.detail).toMatch(/^Step 1 of 1 \(.+\) was refused by the Manci registry program: It failed with AssetNotDraft, 6003\.$/);
    const hook = refuse(hookRefusal(6003, "SenderBlocked"))!;
    expect([hook.program, hook.errorName]).toEqual(["transfer_hook", "SenderBlocked"]);
    expect(classifyFailure(registry.err, registry.logs)).toEqual({ program: "asset_registry", code: 6003, name: "AssetNotDraft" });
  });

  it("registry 6144 PartyBlocklisted keeps the registry's own wording", () => {
    const refusal = refuse({
      err: { InstructionError: [2, { Custom: 6144 }] },
      logs: [`Program ${REGISTRY_PROGRAM} failed: custom program error: 0x1800`],
      unitsConsumed: 1,
    }, [{ programAddress: address(REGISTRY_PROGRAM), data: new Uint8Array(8) }])!;
    expect(refusal.detail).toMatch(/was refused by the Manci registry program: A wallet in this transaction .+\(PartyBlocklisted\)\.$/);
  });

  it("Token-2022 InsufficientFunds (1) and IncorrectAccount (0xa261c2c0)", () => {
    const funds = refuse({
      err: { InstructionError: [3, { Custom: 1 }] },
      logs: ["Program log: Error: insufficient funds", `Program ${TOKEN_2022} failed: custom program error: 0x1`],
      unitsConsumed: 1,
    })!;
    expect(funds.detail).toBe(
      "Step 2 of 2 (token transfer) was refused by the Token-2022 program: The sending token account does not hold enough tokens for this amount (InsufficientFunds, 1).",
    );
    const incorrect = refuse({
      err: { InstructionError: [3, { Custom: 2_724_315_840 }] },
      logs: [`Program ${TOKEN_2022} failed: custom program error: 0xa261c2c0`],
      unitsConsumed: 1,
    })!;
    expect(incorrect.errorName).toBe("IncorrectAccount");
  });

  it("a transaction-level error (no instruction ran) uses the network wording", () => {
    const refusal = refuse({ err: "InsufficientFundsForFee", logs: [], unitsConsumed: 0 })!;
    expect(refusal.instructionIndex).toBeNull();
    expect(refusal.message).toBe(
      "This transaction would fail, so your wallet was not opened. The paying wallet does not have enough SOL on devnet for the network fee (InsufficientFundsForFee).",
    );
    expect(refuse({ err: { InsufficientFundsForRent: { account_index: 1 } }, logs: [], unitsConsumed: 0 })!.detail).toMatch(/InsufficientFundsForRent/);
    expect(refuse({ err: "AccountNotFound", logs: [], unitsConsumed: 0 })!.detail).toBe("The paying wallet has no SOL on devnet (AccountNotFound).");
  });

  it("bigint index and code (as some RPC transports return them)", () => {
    const verdict = hookRefusal(6005, "ReceiverNotApproved");
    verdict.err = { InstructionError: [BigInt(3), { Custom: BigInt(6005) }] };
    const refusal = refuse(verdict)!;
    expect([refusal.instructionIndex, refusal.code, refusal.errorName]).toEqual([1, 6005, "ReceiverNotApproved"]);
  });

  it("without logs, a hook-range code under Token-2022 is the hook's; a runtime error keeps its name", () => {
    const noLogs = refuse({ err: { InstructionError: [3, { Custom: 6005 }] }, logs: [], unitsConsumed: 0 })!;
    expect([noLogs.program, noLogs.errorName]).toEqual(["transfer_hook", "ReceiverNotApproved"]);
    const budget = refuse({ err: { InstructionError: [3, "ComputationalBudgetExceeded"] }, logs: [], unitsConsumed: 0 })!;
    expect(budget.detail).toBe("Step 2 of 2 (token transfer) was refused by the Token-2022 program: It ran out of compute units (ComputationalBudgetExceeded).");
  });

  it("a failure in the send path's own compute-budget instructions is not an app step", () => {
    const refusal = refuse({ err: { InstructionError: [0, "InvalidInstructionData"] }, logs: [], unitsConsumed: 0 })!;
    expect(refusal.instructionIndex).toBeNull();
    expect(refusal.detail).toMatch(/^The compute-budget setup was refused/);
  });
});

// The codes the registry shares with the hook or with every Anchor account
// (6000, 6001, 3012, 2006) have no table entry: the account / Anchor name in
// the log decides, as lib/tx-error did after a failed preflight.
describe("refusalFromSimulation: hints named by the account or the Anchor name", () => {
  /** A registry instruction refused at message index 2 ([limit, price, ix]), Anchor naming the account when it does. */
  function registryRefusal(code: number, name: string, account?: string): SimulationVerdict {
    const where = account ? `caused by account: ${account}.` : "thrown in programs/asset_registry/src/lib.rs:100.";
    return {
      err: { InstructionError: [2, { Custom: code }] },
      logs: [
        `Program ${REGISTRY_PROGRAM} invoke [1]`,
        `Program log: AnchorError ${where} Error Code: ${name}. Error Number: ${code}. Error Message: x.`,
        `Program ${REGISTRY_PROGRAM} failed: custom program error: 0x${code.toString(16)}`,
      ],
      unitsConsumed: 1,
    };
  }
  const openSale = [{ programAddress: address(REGISTRY_PROGRAM), data: OPEN_SALE_DISCRIMINATOR }];
  const closeSale = [{ programAddress: address(REGISTRY_PROGRAM), data: CLOSE_SALE_DISCRIMINATOR }];
  const registryIx = [{ programAddress: address(REGISTRY_PROGRAM), data: new Uint8Array(8) }];
  const refuseRegistry = (verdict: SimulationVerdict, app = registryIx, issuerRotation?: boolean) =>
    refusalFromSimulation(verdict, { appInstructions: app, messageInstructionCount: app.length + 2, network: "devnet", issuerRotation });

  it("open_sale without a live approval (sale_approval, 3012)", () => {
    const refusal = refuseRegistry(registryRefusal(3012, "AccountNotInitialized", "sale_approval"), openSale)!;
    expect([refusal.program, refusal.code, refusal.errorName]).toEqual(["asset_registry", 3012, "AccountNotInitialized"]);
    expect(refusal.detail).toBe(
      `Step 1 of 1 (open sale) was refused by the Manci registry program: ${NO_SALE_APPROVAL_HINT.slice(0, -1)} (AccountNotInitialized, 3012).`,
    );
    expect(explainSendError(refusal)).toBe(refusal.message);
  });

  it("open_sale with another sale id's approval (2006) or an approver no longer admin (3012)", () => {
    expect(refuseRegistry(registryRefusal(2006, "ConstraintSeeds", "sale_approval"), openSale)!.detail).toBe(
      `Step 1 of 1 (open sale) was refused by the Manci registry program: ${SALE_APPROVAL_OTHER_ID_HINT.slice(0, -1)} (ConstraintSeeds, 2006).`,
    );
    expect(refuseRegistry(registryRefusal(3012, "AccountNotInitialized", "approver_admin_record"), openSale)!.detail).toContain(
      `${APPROVER_NOT_ADMIN_HINT.slice(0, -1)} (AccountNotInitialized, 3012).`,
    );
  });

  it("another account's 3012 keeps the bare name and number", () => {
    expect(refuseRegistry(registryRefusal(3012, "AccountNotInitialized", "admin_record"))!.detail).toBe(
      "Step 1 of 1 (Manci registry instruction) was refused by the Manci registry program: It failed with AccountNotInitialized, 3012.",
    );
  });

  it("sale Unauthorized (6001) points at the sale sync only while issuer rotation is on", () => {
    const verdict = registryRefusal(6001, "Unauthorized", "sale");
    const withSync = refuseRegistry(verdict, closeSale, true)!;
    expect(withSync.detail).toBe(
      `Step 1 of 1 (close sale) was refused by the Manci registry program: ${SALE_AUTHORITY_HINT}${SALE_SYNC_SUFFIX}`,
    );
    expect(withSync.errorName).toBe("Unauthorized");
    for (const rotation of [false, undefined]) {
      expect(refuseRegistry(verdict, closeSale, rotation)!.detail).toBe(
        `Step 1 of 1 (close sale) was refused by the Manci registry program: ${SALE_AUTHORITY_HINT}`,
      );
    }
  });

  it("KYC registry Unauthorized (6001) and the missing authority transfer (3012)", () => {
    expect(refuseRegistry(registryRefusal(6001, "Unauthorized", "kyc_registry"))!.detail).toBe(
      `Step 1 of 1 (Manci registry instruction) was refused by the Manci registry program: ${KYC_REGISTRY_NOT_AUTHORITY_HINT.slice(0, -1)} (Unauthorized, 6001).`,
    );
    expect(refuseRegistry(registryRefusal(3012, "AccountNotInitialized", "transfer"))!.detail).toContain(
      `${NO_PENDING_AUTHORITY_TRANSFER_HINT.slice(0, -1)} (AccountNotInitialized, 3012).`,
    );
  });

  it("PlatformPaused (6000) is the registry's pause, not the hook's 6000", () => {
    const paused = refuseRegistry(registryRefusal(6000, "PlatformPaused", "platform"))!;
    expect(paused.detail).toBe(
      `Step 1 of 1 (Manci registry instruction) was refused by the Manci registry program: ${PLATFORM_PAUSED_HINT.slice(0, -1)} (PlatformPaused, 6000).`,
    );
    // The hook's own 6000 (KycRegistryRequired) keeps the hook's wording.
    expect(refuse(hookRefusal(6000, "KycRegistryRequired"))!.detail).toMatch(/names no KYC registry.*\(KycRegistryRequired, 6000\)\.$/);
  });

  it("registry InvalidKycRegistry (6072) gets the neutral hint; the hook's 6009 keeps its transfer wording", () => {
    expect(refuseRegistry(registryRefusal(6072, "InvalidKycRegistry"))!.detail).toBe(
      `Step 1 of 1 (Manci registry instruction) was refused by the Manci registry program: ${INVALID_KYC_REGISTRY_HINT}`,
    );
    expect(refuse(hookRefusal(6009, "InvalidKycRegistry"))!.detail).toBe(
      "Step 2 of 2 (token transfer) was refused by the Manci transfer hook: The KYC registry in the transfer is not the one this share class's transfer hook names, or cannot be read. Reload the page and try again (InvalidKycRegistry, 6009).",
    );
  });

  it("the hints are the ones lib/tx-error gives after a failed preflight", () => {
    const withLogs = (logs: string[]) => Object.assign(new Error("Transaction simulation failed"), { context: { logs } });
    expect(explainSendError(withLogs(registryRefusal(3012, "AccountNotInitialized", "sale_approval").logs))).toBe(NO_SALE_APPROVAL_HINT);
    expect(explainSendError(withLogs(registryRefusal(6000, "PlatformPaused", "platform").logs))).toBe(PLATFORM_PAUSED_HINT);
    expect(explainSendError(withLogs(registryRefusal(6072, "InvalidKycRegistry").logs))).toBe(INVALID_KYC_REGISTRY_HINT);
  });
});

describe("describeInstruction", () => {
  it("names our instructions and the token steps", () => {
    expect(describeInstruction(SEND[0])).toBe("token account creation");
    expect(describeInstruction(SEND[1])).toBe("token transfer");
    expect(describeInstruction({ programAddress: REGISTRY_PROGRAM, data: LOCK_SUPPLY_DISCRIMINATOR })).toBe("lock supply");
    expect(describeInstruction({ programAddress: REGISTRY_PROGRAM, data: new Uint8Array(8) })).toBe("Manci registry instruction");
    expect(describeInstruction({ programAddress: "Stake11111111111111111111111111111111111111" })).toMatch(/^instruction of program Stak…1111$/);
  });
});

describe("post-wallet explanations use the failing program too", () => {
  const withLogs = (logs: string[]) => Object.assign(new Error("Transaction simulation failed"), { context: { logs } });
  it("a hook refusal inside a Token-2022 transfer reads as the hook's", () => {
    expect(explainSendError(withLogs(hookRefusal(6005, "ReceiverNotApproved").logs))).toBe(
      "The recipient has no approved investor passport in this share class's KYC registry (ReceiverNotApproved).",
    );
    expect(explainSendError(withLogs(hookRefusal(6007, "JurisdictionBlocked").logs))).toMatch(/passport country is not allowed .*\(JurisdictionBlocked\)\.$/);
  });
  it("a registry hint is unchanged", () => {
    expect(explainSendError(withLogs([`Program ${REGISTRY_PROGRAM} failed: custom program error: 0x1800`]))).toMatch(/PartyBlocklisted/);
    expect(programErrorHint({ program: "asset_registry", code: 6003 })).toBeNull();
  });
});

describe("computeUnitLimitFromSimulation (the SDK's formula)", () => {
  it("ceil(units × 1.1), at least 200k, at most 1.4M; no estimate is 200k", () => {
    expect(computeUnitLimitFromSimulation(300_000)).toBe(330_000);
    expect(computeUnitLimitFromSimulation(10_000)).toBe(200_000);
    expect(computeUnitLimitFromSimulation(1_399_999)).toBe(1_400_000);
    expect(computeUnitLimitFromSimulation(null)).toBe(200_000);
    expect(computeUnitLimitFromSimulation(0)).toBe(200_000);
    expect(computeUnitLimitFromSimulation(300_000, 1.2)).toBe(360_000);
  });
});

function fakeSimulationRpc(value: { err: unknown; logs?: string[] | null; unitsConsumed?: bigint }) {
  const calls: { wire: string; config: unknown }[] = [];
  const rpc = {
    simulateTransaction: (wire: string, config: unknown) => ({
      send: async () => {
        calls.push({ wire, config });
        return { context: { slot: BigInt(1) }, value };
      },
    }),
  } as unknown as SimulationRpc;
  return { rpc, calls };
}

function instructionsOf(wire: string): string[] {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  return message.instructions.map((ix) => {
    const program = message.staticAccounts[ix.programAddressIndex];
    if (program !== COMPUTE_BUDGET_PROGRAM_ADDRESS) return program;
    const decoded = decodeComputeBudgetInstruction({ programAddress: program, data: ix.data });
    return decoded?.kind === "limit" ? `limit:${decoded.units}` : "cb";
  });
}

describe("simulateMessage / simulateInstructions", () => {
  it("one simulateTransaction: base64, signatures not verified, the node's blockhash, confirmed", async () => {
    const { rpc, calls } = fakeSimulationRpc({ err: null, logs: ["a"], unitsConsumed: BigInt(42) });
    const { verdict, refusal } = await simulateInstructions(rpc, { feePayer: WALLET, instructions: SEND });
    expect(calls).toHaveLength(1);
    expect(calls[0].config).toEqual({ encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    expect(verdict).toEqual({ err: null, logs: ["a"], unitsConsumed: 42 });
    expect(refusal).toBeNull();
    // The limit goes first, like a send.
    expect(instructionsOf(calls[0].wire)).toEqual(["limit:1400000", ATA, TOKEN_2022]);
  });

  it("a refusal counts the app's steps after the placeholder limit", async () => {
    const verdict = hookRefusal(6005, "ReceiverNotApproved");
    verdict.err = { InstructionError: [2, { Custom: 6005 }] }; // [limit, ata, transfer]
    const { rpc } = fakeSimulationRpc({ err: verdict.err, logs: verdict.logs });
    const { refusal } = await simulateInstructions(rpc, { feePayer: WALLET, instructions: SEND, network: "devnet" });
    expect(refusal!.detail).toMatch(/^Step 2 of 2 \(token transfer\) was refused by the Manci transfer hook/);
  });

  it("RPC failures propagate (the client fails closed)", async () => {
    const rpc = { simulateTransaction: () => ({ send: async () => { throw new Error("fetch failed"); } }) } as unknown as SimulationRpc;
    await expect(simulateInstructions(rpc, { feePayer: WALLET, instructions: SEND })).rejects.toThrow("fetch failed");
  });

  it("simulateMessage normalizes missing logs and bigint units", async () => {
    const { rpc } = fakeSimulationRpc({ err: "BlockhashNotFound", logs: null });
    const { verdict } = await simulateInstructions(rpc, { feePayer: WALLET, instructions: SEND });
    expect(verdict).toEqual({ err: "BlockhashNotFound", logs: [], unitsConsumed: null });
    expect(typeof simulateMessage).toBe("function");
  });
});

describe("waitForSignature", () => {
  const rpcWith = (...answers: unknown[]) => {
    const statuses = vi.fn();
    for (const answer of answers) {
      if (answer instanceof Error) statuses.mockRejectedValueOnce(answer);
      else statuses.mockResolvedValueOnce({ value: [answer] });
    }
    return { statuses, rpc: { getSignatureStatuses: () => ({ send: statuses }) } as unknown as Parameters<typeof waitForSignature>[0] };
  };
  it("confirmed, failed, unreadable", async () => {
    expect(await waitForSignature(rpcWith({ confirmationStatus: "confirmed", err: null }).rpc, "s")).toBe("confirmed");
    expect(await waitForSignature(rpcWith({ confirmationStatus: "finalized", err: null }).rpc, "s")).toBe("confirmed");
    expect(await waitForSignature(rpcWith({ confirmationStatus: "processed", err: { InstructionError: [0, "X"] } }).rpc, "s")).toBe("failed");
    expect(await waitForSignature(rpcWith(new Error("down")).rpc, "s")).toBe("unknown");
  });
  it("polls until confirmed, or gives up at the timeout", async () => {
    const polled = rpcWith(null, { confirmationStatus: "processed", err: null }, { confirmationStatus: "confirmed", err: null });
    expect(await waitForSignature(polled.rpc, "s", { pollMs: 1 })).toBe("confirmed");
    expect(polled.statuses).toHaveBeenCalledTimes(3);
    const never = { getSignatureStatuses: () => ({ send: async () => ({ value: [null] }) }) } as unknown as Parameters<typeof waitForSignature>[0];
    expect(await waitForSignature(never, "s", { pollMs: 5, timeoutMs: 20 })).toBe("timeout");
  });
});

describe("waitForSignatures", () => {
  type Status = { err: unknown; confirmationStatus: string } | null;
  const http = (statusCode: number) => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "HTTP", statusCode });
  /** An RPC whose answers come from `answer(signature, read)` (read counts the calls); throwing is a failed read. */
  function rpcOf(answer: (signature: string, read: number) => Status) {
    const calls: string[][] = [];
    const rpc = {
      getSignatureStatuses: (signatures: readonly string[]) => ({
        send: async () => {
          calls.push([...signatures]);
          return { value: signatures.map((s) => answer(s, calls.length)) };
        },
      }),
    } as unknown as Parameters<typeof waitForSignatures>[0];
    return { rpc, calls };
  }
  const confirmed: Status = { err: null, confirmationStatus: "confirmed" };

  it("reads all of them in one call per poll, decides each on its own, and asks again only for the open ones", async () => {
    const { rpc, calls } = rpcOf((s, read) =>
      s === "a" ? confirmed : s === "b" ? { err: { InstructionError: [0, "X"] }, confirmationStatus: "processed" } : read >= 3 ? confirmed : null,
    );
    expect(await waitForSignatures(rpc, ["a", "b", "c"], { pollMs: 1 })).toEqual(["confirmed", "failed", "confirmed"]);
    expect(calls).toEqual([["a", "b", "c"], ["c"], ["c"]]);
  });

  it("what the timeout leaves open is \"timeout\"; a read that fails leaves it \"unknown\"", async () => {
    expect(await waitForSignatures(rpcOf((s) => (s === "a" ? confirmed : null)).rpc, ["a", "b"], { pollMs: 5, timeoutMs: 20 })).toEqual(["confirmed", "timeout"]);
    const down = rpcOf(() => {
      throw new Error("down");
    });
    expect(await waitForSignatures(down.rpc, ["a", "b"])).toEqual(["unknown", "unknown"]);
    expect(down.calls).toHaveLength(1);
  });

  it("retryReads: a read refused for a moment (429, 5xx) is read again after a jittered wait, not answered \"unknown\"", async () => {
    const waits: number[] = [];
    const { rpc, calls } = rpcOf((_, read) => {
      if (read === 1) throw http(429);
      if (read === 2) throw http(503);
      return confirmed;
    });
    const sleep = async (ms: number) => void waits.push(ms);
    expect(await waitForSignatures(rpc, ["a"], { retryReads: { delaysMs: [100, 200, 400], sleep, random: () => 0.5 } })).toEqual(["confirmed"]);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([100, 200]);
    // Without retryReads the same 429 ends the wait at once.
    const once = rpcOf(() => {
      throw http(429);
    });
    expect(await waitForSignature(once.rpc, "a")).toBe("unknown");
    expect(once.calls).toHaveLength(1);
  });

  it("retryReads: anything but a transient failure, and the last retry's failure, still end the wait (\"unknown\")", async () => {
    const sleep = async () => undefined;
    const refused = rpcOf(() => {
      throw new Error("Invalid params");
    });
    expect(await waitForSignatures(refused.rpc, ["a"], { retryReads: { sleep } })).toEqual(["unknown"]);
    expect(refused.calls).toHaveLength(1);
    const limited = rpcOf(() => {
      throw http(429);
    });
    expect(await waitForSignatures(limited.rpc, ["a"], { retryReads: { delaysMs: [1, 1, 1], sleep } })).toEqual(["unknown"]);
    expect(limited.calls).toHaveLength(4);
  });

  it("retryReads is bounded by the timeout: a retry's wait ends with it and no read starts after it", async () => {
    const limited = rpcOf(() => {
      throw http(429);
    });
    const started = Date.now();
    expect(await waitForSignatures(limited.rpc, ["a"], { timeoutMs: 30, retryReads: { delaysMs: [10_000] } })).toEqual(["unknown"]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(limited.calls).toHaveLength(1);
  });
});
