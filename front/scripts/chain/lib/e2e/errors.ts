/**
 * Classifies a failed simulation or transaction for the e2e matrix: which
 * program failed and with which code (design-6.3 §A "error matcher").
 *
 * The two programs' custom codes overlap (6003 is AssetNotDraft in the
 * registry and SenderBlocked in the hook), so a match needs both. The failing
 * program is the innermost `Program <id> failed` line: when a hook rejects a
 * Token-2022 transfer inside a registry instruction, the hook fails first and
 * its custom code is what the transaction error carries. Pure.
 */
import * as registryErrors from "@/lib/generated/asset_registry/errors/assetRegistry";
import * as hookErrors from "@/lib/generated/transfer_hook/errors/transferHook";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import type { Expect, ProgramLabel } from "./matrix";

export type ChainFailure = {
  /** The innermost failing program, by label when it is one of ours. */
  program: ProgramLabel | string | null;
  code: number | null;
  /** The Anchor error name from the logs, or the transaction error's own name. */
  name: string | null;
};

const PROGRAM_LABELS: Record<string, ProgramLabel> = {
  [ASSET_REGISTRY_PROGRAM_ADDRESS]: "asset_registry",
  [TRANSFER_HOOK_PROGRAM_ADDRESS]: "transfer_hook",
};

function codeNames(module: Record<string, unknown>, prefix: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const [key, value] of Object.entries(module)) {
    if (key.startsWith(prefix) && typeof value === "number") out.set(value, key.slice(prefix.length));
  }
  return out;
}
const REGISTRY_NAMES = codeNames(registryErrors, "ASSET_REGISTRY_ERROR__");
const HOOK_NAMES = codeNames(hookErrors, "TRANSFER_HOOK_ERROR__");

/** SCREAMING_SNAKE (generated constant suffix) → the program's PascalCase name. */
function pascal(snake: string): string {
  return snake
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function errorName(program: ProgramLabel, code: number): string | null {
  const names = program === "asset_registry" ? REGISTRY_NAMES : HOOK_NAMES;
  const snake = names.get(code);
  return snake ? pascal(snake) : null;
}

const FAILED_LINE = /^Program (\w{32,44}) failed/;
const ANCHOR_LINE = /Error Code: (\w+)\. Error Number: (\d+)\./;

export function classifyFailure(err: unknown, logs: readonly string[]): ChainFailure {
  let program: string | null = null;
  for (const line of logs) {
    const failed = FAILED_LINE.exec(line);
    if (failed) {
      program = failed[1];
      break;
    }
  }
  const label = program ? (PROGRAM_LABELS[program] ?? program) : null;

  let code: number | null = null;
  let name: string | null = null;
  const instructionError =
    err && typeof err === "object" && "InstructionError" in err
      ? (err as { InstructionError: [unknown, unknown] }).InstructionError
      : null;
  if (instructionError) {
    const inner = instructionError[1];
    if (inner && typeof inner === "object" && "Custom" in inner) {
      code = Number((inner as { Custom: number | bigint }).Custom);
    } else if (typeof inner === "string") {
      name = inner;
    } else if (inner && typeof inner === "object") {
      name = Object.keys(inner)[0] ?? null;
    }
  } else if (typeof err === "string") {
    name = err;
  } else if (err && typeof err === "object") {
    name = Object.keys(err)[0] ?? null;
  }

  for (const line of logs) {
    const anchor = ANCHOR_LINE.exec(line);
    if (anchor && (code === null || Number(anchor[2]) === code)) {
      name = anchor[1];
      code ??= Number(anchor[2]);
      break;
    }
  }
  if (name === null && code !== null && (label === "asset_registry" || label === "transfer_hook")) {
    name = errorName(label, code);
  }
  return { program: label, code, name };
}

/** Whether an actual outcome is what the step expects. `failure` is null for a success. */
export function matchesExpectation(expect: Expect, failure: ChainFailure | null): boolean {
  if (expect.ok) return failure === null;
  return failure !== null && failure.program === expect.program && failure.code === expect.code;
}

export function describeFailure(failure: ChainFailure | null): string {
  if (!failure) return "ok";
  const where = failure.program ?? "?";
  if (failure.code === null) return `${where}: ${failure.name ?? "error"}`;
  return `${where}: ${failure.name ?? "error"} (${failure.code})`;
}
