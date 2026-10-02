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
  type Instruction,
} from "@solana/kit";
import { LOCK_SUPPLY_DISCRIMINATOR } from "@/lib/generated/asset_registry";
import {
  computeUnitLimitFromSimulation,
  describeInstruction,
  refusalFromSimulation,
  simulateInstructions,
  simulateMessage,
  SimulationRefusedError,
  waitForSignature,
  type SimulationRpc,
  type SimulationVerdict,
} from "@/lib/simulation-gate";
import { classifyFailure, programErrorHint } from "@/lib/program-errors";
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
