// Talas 6.3: the e2e error matcher. The two programs' custom codes overlap,
// so a failure is the innermost failing program AND its code; Anchor's own
// errors carry their name in the logs.
import { describe, expect, it } from "vitest";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import { classifyFailure, describeFailure, errorName, matchesExpectation } from "@/scripts/chain/lib/e2e/errors";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

describe("classifyFailure", () => {
  it("a registry custom error: program, code and the Anchor name from the logs", () => {
    const logs = [
      `Program ${ASSET_REGISTRY_PROGRAM_ADDRESS} invoke [1]`,
      "Program log: AnchorError occurred. Error Code: SaleSoldOut. Error Number: 6021. Error Message: sold out.",
      `Program ${ASSET_REGISTRY_PROGRAM_ADDRESS} consumed 5000 of 200000 compute units`,
      `Program ${ASSET_REGISTRY_PROGRAM_ADDRESS} failed: custom program error: 0x1785`,
    ];
    const failure = classifyFailure({ InstructionError: [1, { Custom: 6021 }] }, logs);
    expect(failure).toEqual({ program: "asset_registry", code: 6021, name: "SaleSoldOut" });
    expect(describeFailure(failure)).toBe("asset_registry: SaleSoldOut (6021)");
  });

  it("a hook rejection inside a registry transfer is the hook's (innermost failing program)", () => {
    const logs = [
      `Program ${ASSET_REGISTRY_PROGRAM_ADDRESS} invoke [1]`,
      `Program ${TOKEN_2022} invoke [2]`,
      `Program ${TRANSFER_HOOK_PROGRAM_ADDRESS} invoke [3]`,
      `Program ${TRANSFER_HOOK_PROGRAM_ADDRESS} failed: custom program error: 0x1773`,
      `Program ${TOKEN_2022} failed: custom program error: 0x1773`,
      `Program ${ASSET_REGISTRY_PROGRAM_ADDRESS} failed: custom program error: 0x1773`,
    ];
    const failure = classifyFailure({ InstructionError: [0, { Custom: 6003 }] }, logs);
    expect(failure.program).toBe("transfer_hook");
    expect(failure.code).toBe(6003);
    // 6003 is SenderBlocked in the hook, AssetNotDraft in the registry.
    expect(failure.name).toBe(errorName("transfer_hook", 6003));
    expect(errorName("asset_registry", 6003)).not.toBe(failure.name);
  });

  it("Anchor's AccountNotInitialized (3012) keeps its Anchor name", () => {
    const logs = [
      `Program ${ASSET_REGISTRY_PROGRAM_ADDRESS} invoke [1]`,
      "Program log: AnchorError caused by account: admin_record. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized.",
      `Program ${ASSET_REGISTRY_PROGRAM_ADDRESS} failed: custom program error: 0xbc4`,
    ];
    expect(classifyFailure({ InstructionError: [0, { Custom: 3012 }] }, logs)).toEqual({
      program: "asset_registry",
      code: 3012,
      name: "AccountNotInitialized",
    });
  });

  it("a code without an Anchor log line is named from the generated SDK", () => {
    const logs = [`Program ${ASSET_REGISTRY_PROGRAM_ADDRESS} failed: custom program error: 0x17b5`];
    expect(classifyFailure({ InstructionError: [0, { Custom: 6069 }] }, logs)).toEqual({
      program: "asset_registry",
      code: 6069,
      name: "ReceiverNotApproved",
    });
  });

  it("non-custom instruction errors and transaction errors keep their names", () => {
    expect(classifyFailure({ InstructionError: [2, "InvalidAccountData"] }, [])).toEqual({ program: null, code: null, name: "InvalidAccountData" });
    expect(classifyFailure({ InstructionError: [0, { BorshIoError: "x" }] }, []).name).toBe("BorshIoError");
    expect(classifyFailure("BlockhashNotFound", [])).toEqual({ program: null, code: null, name: "BlockhashNotFound" });
    expect(classifyFailure({ InsufficientFundsForRent: { account_index: 1 } }, []).name).toBe("InsufficientFundsForRent");
  });

  it("a foreign program keeps its address as the label", () => {
    const logs = [`Program ${TOKEN_2022} failed: custom program error: 0x1`];
    expect(classifyFailure({ InstructionError: [0, { Custom: 1 }] }, logs).program).toBe(TOKEN_2022);
  });

  it("an Anchor line for a different code does not rename the failure", () => {
    const logs = [
      "Program log: AnchorError occurred. Error Code: SaleSoldOut. Error Number: 6021. Error Message: x.",
      `Program ${ASSET_REGISTRY_PROGRAM_ADDRESS} failed: custom program error: 0x1785`,
    ];
    expect(classifyFailure({ InstructionError: [0, { Custom: 6019 }] }, logs).name).toBe("SaleNotStarted");
  });
});

describe("matchesExpectation", () => {
  const refused = { ok: false as const, program: "asset_registry" as const, code: 6021, name: "SaleSoldOut" };
  it("needs both the program and the code", () => {
    expect(matchesExpectation(refused, { program: "asset_registry", code: 6021, name: "SaleSoldOut" })).toBe(true);
    expect(matchesExpectation(refused, { program: "transfer_hook", code: 6021, name: "x" })).toBe(false);
    expect(matchesExpectation(refused, { program: "asset_registry", code: 6019, name: "SaleNotStarted" })).toBe(false);
    expect(matchesExpectation(refused, null)).toBe(false);
  });
  it("a success matches only no failure", () => {
    expect(matchesExpectation({ ok: true }, null)).toBe(true);
    expect(matchesExpectation({ ok: true }, { program: null, code: null, name: "x" })).toBe(false);
  });
});
