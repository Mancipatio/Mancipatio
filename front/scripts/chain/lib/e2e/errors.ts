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
import type { Expect } from "./matrix";
import type { ChainFailure } from "@/lib/program-errors";

// The classifier itself lives in lib/program-errors (shared with the front's
// simulation gate and the post-wallet explanation); re-exported here for the
// e2e runner, the sim and their tests.
export { classifyFailure, errorName, type ChainFailure } from "@/lib/program-errors";

const CAUSED_BY_LINE = /AnchorError caused by account: (\w+)\. Error Code: (\w+)\. Error Number: (\d+)\./;

/** The account Anchor names for the failure with `code` ("AnchorError caused by account: …"), or null. */
export function failedAccount(logs: readonly string[], code: number | null): string | null {
  for (const line of logs) {
    const caused = CAUSED_BY_LINE.exec(line);
    if (caused && (code === null || Number(caused[3]) === code)) return caused[1];
  }
  return null;
}

/**
 * Whether an actual outcome is what the step expects. `failure` is null for a
 * success. An expectation that names an account also needs the simulation's
 * logs to name that account for the same code: 3012 is raised for whichever
 * account is missing first, so the code alone would pass a refusal for an
 * unrelated account.
 */
export function matchesExpectation(expect: Expect, failure: ChainFailure | null, logs: readonly string[] = []): boolean {
  if (expect.ok) return failure === null;
  if (failure === null || failure.program !== expect.program || failure.code !== expect.code) return false;
  return expect.account === undefined || failedAccount(logs, expect.code) === expect.account;
}

export function describeFailure(failure: ChainFailure | null): string {
  if (!failure) return "ok";
  const where = failure.program ?? "?";
  if (failure.code === null) return `${where}: ${failure.name ?? "error"}`;
  return `${where}: ${failure.name ?? "error"} (${failure.code})`;
}
