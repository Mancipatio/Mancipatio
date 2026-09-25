// The cohort-X probe matcher (scripts/sim/lib/transfers.ts): Token-2022
// refusals named `token_2022`, custom codes matched with their program (hook
// 6003 is not registry 6003), runtime errors by name, the hook-invoked flag
// read from the logs, and simulations that say nothing (retried, never a
// finding). Log fixtures follow spl-token-2022 11 wording; the first devnet
// run replaces them with real logs.
import { describe, expect, it } from "vitest";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import { TOKEN_2022 } from "@/lib/transaction-builders";
import {
  INCORRECT_ACCOUNT,
  PROBES,
  classifyProbeFailure,
  matchProbe,
  probeResult,
  simulationInfraFailure,
  type ProbeExpect,
} from "@/scripts/sim/lib/transfers";

const T22 = TOKEN_2022;
const HOOK = TRANSFER_HOOK_PROGRAM_ADDRESS;
const REG = ASSET_REGISTRY_PROGRAM_ADDRESS;
const hex = (n: number) => `0x${n.toString(16)}`;

/** A refusal of Token-2022 itself (the hook never ran). */
const t22Fails = (code: number) => ({
  ok: false,
  err: { InstructionError: [1, { Custom: code }] },
  logs: [`Program ${T22} invoke [1]`, "Program log: Instruction: TransferChecked", `Program ${T22} failed: custom program error: ${hex(code)}`],
});
/** The hook refused inside Token-2022's CPI (the innermost failing program is the hook). */
const hookFails = (code: number, name: string) => ({
  ok: false,
  err: { InstructionError: [1, { Custom: code }] },
  logs: [
    `Program ${T22} invoke [1]`,
    `Program ${HOOK} invoke [2]`,
    `Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${code}. Error Message: x.`,
    `Program ${HOOK} failed: custom program error: ${hex(code)}`,
    `Program ${T22} failed: custom program error: ${hex(code)}`,
  ],
});
const runtimeFails = (name: string) => ({ ok: false, err: { InstructionError: [1, name] }, logs: [`Program ${T22} invoke [1]`, `Program ${T22} failed: ${name}`] });
const accepted = (hook: boolean) => ({
  ok: true,
  err: null,
  logs: [`Program ${T22} invoke [1]`, ...(hook ? [`Program ${HOOK} invoke [2]`, `Program ${HOOK} success`] : []), `Program ${T22} success`],
});
const expectOf = (id: string): ProbeExpect => PROBES.find((d) => d.id === id)!.expect;

describe("classifyProbeFailure", () => {
  it("names Token-2022 token_2022 with its error names, and keeps our programs' labels", () => {
    expect(classifyProbeFailure(t22Fails(1).err, t22Fails(1).logs)).toEqual({ program: "token_2022", code: 1, name: "InsufficientFunds" });
    expect(classifyProbeFailure(t22Fails(INCORRECT_ACCOUNT).err, t22Fails(INCORRECT_ACCOUNT).logs)).toEqual({ program: "token_2022", code: 2_724_315_840, name: "IncorrectAccount" });
    expect(classifyProbeFailure(hookFails(6011, "ImmutableOwnerRequired").err, hookFails(6011, "ImmutableOwnerRequired").logs)).toEqual({
      program: "transfer_hook",
      code: 6011,
      name: "ImmutableOwnerRequired",
    });
    expect(classifyProbeFailure(runtimeFails("IncorrectProgramId").err, runtimeFails("IncorrectProgramId").logs)).toEqual({ program: "token_2022", code: null, name: "IncorrectProgramId" });
  });
});

describe("matchProbe", () => {
  it("matches every Token-2022 row on program and code", () => {
    expect(matchProbe(expectOf("P4"), probeResult(t22Fails(1)))).toBe("expected-error");
    expect(matchProbe(expectOf("P5"), probeResult(t22Fails(4)))).toBe("expected-error");
    expect(matchProbe(expectOf("P6"), probeResult(t22Fails(18)))).toBe("expected-error");
    expect(matchProbe(expectOf("P7"), probeResult(t22Fails(3)))).toBe("expected-error");
    expect(matchProbe(expectOf("B3"), probeResult(t22Fails(INCORRECT_ACCOUNT)))).toBe("expected-error");
    expect(matchProbe(expectOf("D2"), probeResult(t22Fails(INCORRECT_ACCOUNT)))).toBe("expected-error");
    expect(matchProbe(expectOf("L1"), probeResult(t22Fails(31)))).toBe("expected-error");
    expect(matchProbe(expectOf("E1"), probeResult(t22Fails(4)))).toBe("expected-error");
    // Another Token-2022 code is a mismatch, not a pass.
    expect(matchProbe(expectOf("P4"), probeResult(t22Fails(4)))).toBe("tx-error");
  });

  it("matches the hook rows, and a code from the other program never matches", () => {
    expect(matchProbe(expectOf("P8"), probeResult(hookFails(6011, "ImmutableOwnerRequired")))).toBe("expected-error");
    expect(matchProbe(expectOf("B2"), probeResult(hookFails(6002, "MissingExtraAccount")))).toBe("expected-error");
    const registry6002 = {
      ok: false,
      err: { InstructionError: [1, { Custom: 6002 }] },
      logs: [`Program ${REG} invoke [1]`, "Program log: AnchorError occurred. Error Code: X. Error Number: 6002. Error Message: x.", `Program ${REG} failed: custom program error: 0x1772`],
    };
    expect(matchProbe(expectOf("B2"), probeResult(registry6002))).toBe("tx-error");
    // The same code from Token-2022 (a hook code Token-2022 would never raise) is not the hook's either.
    expect(matchProbe(expectOf("B2"), probeResult(t22Fails(6002)))).toBe("tx-error");
  });

  it("matches runtime errors by name: P1 accepts spl-token-2022 11 and 6.x, B1 the missing hook program", () => {
    expect(matchProbe(expectOf("P1"), probeResult(runtimeFails("IncorrectProgramId")))).toBe("expected-error");
    expect(matchProbe(expectOf("P1"), probeResult(runtimeFails("InvalidAccountData")))).toBe("expected-error");
    expect(matchProbe(expectOf("P1"), probeResult(runtimeFails("MissingAccount")))).toBe("tx-error");
    expect(matchProbe(expectOf("B1"), probeResult(runtimeFails("MissingAccount")))).toBe("expected-error");
  });

  it("reads the hook CPI from the logs: P2 (self-transfer) must not invoke it, P3 (amount 0) must", () => {
    expect(probeResult(accepted(true)).hookInvoked).toBe(true);
    expect(probeResult(accepted(false)).hookInvoked).toBe(false);
    expect(matchProbe(expectOf("P2"), probeResult(accepted(false)))).toBe("ok");
    expect(matchProbe(expectOf("P2"), probeResult(accepted(true)))).toBe("tx-error");
    expect(matchProbe(expectOf("P3"), probeResult(accepted(true)))).toBe("ok");
    expect(matchProbe(expectOf("P3"), probeResult(accepted(false)))).toBe("tx-error");
    expect(matchProbe(expectOf("E2"), probeResult(t22Fails(4)))).toBe("tx-error");
  });

  it("an expected refusal that simulates OK is an unexpected accept", () => {
    expect(matchProbe(expectOf("P4"), probeResult(accepted(true)))).toBe("unexpected-accept");
    expect(matchProbe(expectOf("P8"), probeResult(accepted(true)))).toBe("unexpected-accept");
  });
});

describe("simulationInfraFailure", () => {
  it("retries a simulation that says nothing about the transfer, never a refusal or a payer without SOL", () => {
    expect(simulationInfraFailure({ ok: false, err: "BlockhashNotFound", logs: [] })).toBe("BlockhashNotFound");
    expect(simulationInfraFailure({ ok: false, err: { BlockhashNotFound: null }, logs: [] })).toBe("BlockhashNotFound");
    expect(simulationInfraFailure({ ok: false, err: "AlreadyProcessed", logs: [] })).toBe("AlreadyProcessed");
    expect(simulationInfraFailure({ ok: false, err: "AccountNotFound", logs: [] })).toBeNull();
    expect(simulationInfraFailure(t22Fails(1))).toBeNull();
    expect(simulationInfraFailure(accepted(true))).toBeNull();
  });
});
