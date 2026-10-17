// The recovery hooks are React code the suite does not render; these pin
// their shape at the source, in the style of tests/send-outcome.test.ts:
// F006 (the pre-wallet gates run on the built instruction before an intent
// is saved; a never-broadcast send forgets it; an abandoned approval can be
// discarded), F072 (finalization before the one signed record), F180 (the
// admin badges refresh after every recovery success) and F073 (the state
// the admin page needs: stage, signature, sent).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const between = (code: string, from: string, to: string) => {
  const start = code.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = code.indexOf(to, start);
  expect(end, to).toBeGreaterThan(start);
  return code.slice(start, end);
};

describe("useCustodyOpenRecovery (lib/use-custody-open-recovery.tsx)", () => {
  const hook = src("lib/use-custody-open-recovery.tsx");
  it("runs the pre-wallet gates on the built instruction, so a refusal saves no approval", () => {
    const preflight = between(hook, "async function preflight(", "async function link(");
    expect(preflight.indexOf("assertInstructionsInScope(instructions, network)")).toBeLessThan(preflight.indexOf("await assertInstructionsNotPaused(rpc, instructions)"));
    expect(preflight.indexOf("await assertInstructionsNotPaused(rpc, instructions)")).toBeLessThan(preflight.indexOf("await assertSiteWritable()"));
    expect(preflight.indexOf("await assertSiteWritable()")).toBeLessThan(preflight.indexOf("simulateInstructions(rpc, {"));
    expect(preflight).toContain("if (refusal) throw refusal;");
    const open = between(hook, "async function open<", "async function retry(");
    expect(open).toContain("preflight,");
    expect(open).toContain("notSent: custodySendNeverBroadcast,");
    // After a failure the saved state is read back: a forgotten intent re-enables "Open vault".
    expect(open.indexOf("readCustodyOpenIntent(scope)")).toBeGreaterThan(open.indexOf("} catch (error) {"));
  });
  it("links only once the vault is finalized, through one signed request, and refreshes the badges", () => {
    const link = between(hook, "async function link(", "async function open<");
    expect(link).toContain("recordOnceFinalized({");
    expect(link.indexOf("awaitCustodyOpenFinalized(rpc, intent")).toBeLessThan(link.indexOf("await signedFetch("));
    expect(link.indexOf("notifyAdminBadges()")).toBeGreaterThan(link.indexOf("await signedFetch("));
    expect(link).toContain('status: "vault_opened"');
  });
  it("offers to discard an approval the network shows was never opened, under the request's lock, on the record as stored then", () => {
    const discard = between(hook, "async function discard()", "  return {");
    expect(discard).toContain("withCustodyOpenLock(scope,");
    // Under the lock (another tab's send holds the same one), storage is read
    // again: a send that settled meanwhile stamped the record (attemptedAt).
    expect(discard.indexOf("withCustodyOpenLock(scope,")).toBeLessThan(discard.indexOf("readCustodyOpenIntent(scope)"));
    expect(discard.indexOf("readCustodyOpenIntent(scope)")).toBeLessThan(discard.indexOf("checkCustodyOpenIntent(rpc, current"));
    expect(discard.indexOf("checkCustodyOpenIntent(rpc, current")).toBeLessThan(discard.indexOf("forgetCustodyOpenIntent(current)"));
    expect(discard).toContain("since: observedSince(intentKey(current))");
    expect(discard).toContain('if (state !== "never_opened") throw new Error(');
    expect(hook).toContain('chainState === "never_opened" && (');
    expect(hook).toContain("Discard — vault never opened");
    // The bound this tab adds: its own observation of this exact record (keyed with attemptedAt).
    expect(hook).toContain("since: observedSince(visibleKey)");
    expect(hook).toContain('${intent.attemptedAt ?? ""}');
    // A retry sends nothing: it does not move the bound.
    const retry = between(hook, "async function retry()", "async function discard()");
    expect(retry).not.toContain("lastAttemptAt.current = Date.now()");
  });
  it("exposes the attempt's stage, signature and sent flag for the audit trail", () => {
    const returned = hook.slice(hook.lastIndexOf("  return {"));
    for (const field of ["stage,", "signature: visible?.signature ?? null,", "sent: visible?.signature != null,", "latestIntent: () => latest.current,"]) expect(returned).toContain(field);
  });
});

describe("useCustodyOutcomeRecovery (lib/use-custody-outcome-recovery.tsx)", () => {
  const hook = src("lib/use-custody-outcome-recovery.tsx");
  it("records a sent outcome only once it is finalized, through the shared record path", () => {
    const record = between(hook, "async function record(", "async function retry(");
    expect(record.indexOf("recovery.remember(")).toBeLessThan(record.indexOf("await settle(receipt)"));
    const settle = between(hook, "async function settle(", "function prepare(");
    expect(settle).toContain("recovery.recordFinalized(receipt, () =>");
    expect(settle).toContain('if (outcome === "failed") throw new Error(OUTCOME_FAILED_MESSAGE)');
    expect(settle).toContain('if (outcome === "not_finalized")');
  });
  it("refreshes the admin badges after a recorded outcome, and offers discard for a dead receipt", () => {
    const finish = between(hook, "async function finish(", "async function settle(");
    expect(finish.indexOf("await signedFetch(")).toBeLessThan(finish.indexOf("recovery.forget(receipt)"));
    expect(finish.indexOf("recovery.forget(receipt)")).toBeLessThan(finish.indexOf("notifyAdminBadges()"));
    expect(finish.indexOf("notifyAdminBadges()")).toBeLessThan(finish.indexOf("await refresh()"));
    expect(hook).toContain("Discard receipt\n");
    expect(hook).not.toContain("transaction never landed)");
    // A dead receipt is listed once, with its discard: not among those awaiting recording.
    expect(hook).toContain("receipts={awaiting}");
    const retry = between(hook, "async function retry(", "async function discard(");
    expect(retry).toContain('if (state === "failed" || state === "did_not_land")');
    // "landed" covers confirmed: through the wait (it returns at once when
    // finalized); only an unreadable status goes straight to the one signed record.
    expect(retry).toContain('if (state === "unknown") await finish(receipt);');
    expect(retry).toContain("else await settle(receipt);");
  });
  it("scopes sent / signature to the attempt: prepare() and retry() start a new one, and a catch block reads latestAttempt()", () => {
    const prepare = between(hook, "function prepare(", "function release(");
    expect(prepare).toContain("recovery.resetAttempt();");
    const retry = between(hook, "async function retry(", "async function discard(");
    expect(retry.indexOf("recovery.resetAttempt()")).toBeLessThan(retry.indexOf("recovery.check(receipt)"));
    const returned = hook.slice(hook.lastIndexOf("  return {"));
    for (const field of ["stage: recovery.stage,", "signature: recovery.signature,", "sent: recovery.signature !== null,", "latestAttempt: recovery.latestAttempt,", "retry,", "discard,"]) expect(returned).toContain(field);
    const record = src("lib/use-chain-record-recovery.ts");
    expect(record).toContain("const resetAttempt = useCallback(");
    expect(record).toContain("const latestAttempt = useCallback(() => attemptRef.current, []);");
    const finalized = between(record, "const recordFinalized = useCallback(", "  return {");
    expect(finalized).toContain('outcome === "recorded" ? null : { ...current, stage: null }');
  });
});

describe("the shared helpers", () => {
  it("openCustodyOnce: the preflight runs before the intent is saved; a never-broadcast send forgets it before the error is rethrown", () => {
    const run = between(src("lib/custody-open-recovery.ts"), "const run = async () => {", "return withCustodyOpenLock(");
    expect(run.indexOf("await input.preflight?.(prepared)")).toBeLessThan(run.indexOf("save(intent);"));
    expect(run.indexOf("save(intent);")).toBeLessThan(run.indexOf("await input.send(prepared)"));
    expect(run).toContain("if (input.notSent?.(error)) {");
    expect(run).toContain("if (forgetCustodyOpenIntent(intent)) input.onIntent(null);");
    // An uncertain send stamps the kept record with the moment it settled.
    expect(run).toContain("const marked = markCustodyOpenAttempted(intent);");
    expect(run.indexOf("input.onIntent(null)")).toBeLessThan(run.indexOf("throw error;"));
    expect(run).toContain("intent = { ...intent, signature, attemptedAt: new Date().toISOString() };");
  });
  it("useChainRecordRecovery checks each receipt once, and discards only through the network's answer and storage's", () => {
    const hook = src("lib/use-chain-record-recovery.ts");
    expect(hook).toContain("checkPendingChainRecord(rpc, receipt)");
    const discard = between(hook, "const discard = useCallback(", "const awaitFinalized = useCallback(");
    expect(discard.indexOf("checkPendingChainRecord(rpc, receipt)")).toBeLessThan(discard.indexOf("discardPendingChainRecord(receipt, state)"));
    // Storage has the last word (a newer receipt is never removed): its answer is what is reported.
    expect(discard).toContain("discardableChainRecordState(state) &&\n        discardPendingChainRecord(receipt, state);");
  });
  it("the server's every 'not yet' is the one typed 409 the client recognizes", () => {
    const server = src("lib/server/chain-evidence.ts");
    expect(server).toContain('export const AWAITING_FINALIZATION_CODE = "awaiting_finalization";');
    expect(server).toContain("export class AwaitingFinalizationError extends SiwsError");
    expect(src("lib/chain-record-recovery.ts")).toContain('export const AWAITING_FINALIZATION_CODE = "awaiting_finalization";');
    const custody = src("lib/server/custody-evidence.ts");
    expect(custody).not.toMatch(/awaiting finalization\. Retry/);
    expect(custody).toContain("await readFinalizedTransaction(");
    expect(custody).toContain("await refuseUnrealized(expected.vault_pda!)");
  });
  it("the purchase path keeps its 503 and one finalized read: the queue marks a 4xx invalid for good", () => {
    const purchase = between(src("lib/server/chain-evidence.ts"), "export async function requirePurchaseEvidence(", "/** `Pubkey::default()`");
    expect(purchase).toContain("retries: 0,");
    expect(purchase).toContain("if (error instanceof AwaitingFinalizationError)");
    expect(purchase).toContain("throw new SiwsError(503, PURCHASE_NOT_FINALIZED_MESSAGE);");
    // The rule this depends on (lib/server/purchase-records.ts processPurchaseJob).
    expect(src("lib/server/purchase-records.ts")).toContain("error instanceof SiwsError && error.status >= 400 && error.status < 500");
  });

});
