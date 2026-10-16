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
  it("offers to discard an approval the network shows was never opened, under the request's lock", () => {
    const discard = between(hook, "async function discard()", "  return {");
    expect(discard).toContain("withCustodyOpenLock(scope,");
    expect(discard.indexOf("checkCustodyOpenIntent(rpc, intent")).toBeLessThan(discard.indexOf("forgetCustodyOpenIntent(intent)"));
    expect(discard).toContain('if (state !== "never_opened") throw new Error(');
    expect(hook).toContain('chainState === "never_opened" && (');
    expect(hook).toContain("Discard — vault never opened");
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
    expect(hook).toContain("Discard receipt (transaction never landed)");
    const retry = between(hook, "async function retry(", "async function discard(");
    expect(retry).toContain('if (state === "failed" || state === "did_not_land")');
  });
  it("exposes stage, signature and sent", () => {
    const returned = hook.slice(hook.lastIndexOf("  return {"));
    for (const field of ["stage: recovery.stage,", "signature: recovery.signature,", "sent: recovery.signature !== null,", "retry,", "discard,"]) expect(returned).toContain(field);
  });
});

describe("the shared helpers", () => {
  it("openCustodyOnce: the preflight runs before the intent is saved; a never-broadcast send forgets it before the error is rethrown", () => {
    const run = between(src("lib/custody-open-recovery.ts"), "const run = async () => {", "return withCustodyOpenLock(");
    expect(run.indexOf("await input.preflight?.(prepared)")).toBeLessThan(run.indexOf("save(intent);"));
    expect(run.indexOf("save(intent);")).toBeLessThan(run.indexOf("await input.send(prepared)"));
    expect(run).toContain("if (input.notSent?.(error) && forgetCustodyOpenIntent(intent))");
    expect(run.indexOf("input.onIntent(null)")).toBeLessThan(run.indexOf("throw error;"));
  });
  it("useChainRecordRecovery checks each receipt once, and discards only through the network's answer", () => {
    const hook = src("lib/use-chain-record-recovery.ts");
    expect(hook).toContain("checkPendingChainRecord(rpc, receipt)");
    const discard = between(hook, "const discard = useCallback(", "const awaitFinalized = useCallback(");
    expect(discard.indexOf("checkPendingChainRecord(rpc, receipt)")).toBeLessThan(discard.indexOf("discardPendingChainRecord(receipt, state)"));
    expect(discard).toContain("discardableChainRecordState(state)");
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
});
