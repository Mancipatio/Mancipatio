// Talas 4.4b: invocations in execution order (top-level, then its inner
// CPIs; ALT keys resolved) and events attributed only to the program's own
// frames of the invoke stack.
import { describe, expect, it } from "vitest";
import { attributeProgramData, flattenInvocations, transactionInvocations } from "@/lib/server/tx-invocations";
import { b64, buildTx, logTree } from "./helpers/chain-tx";

const REGISTRY = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";
const HOOK = "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy";
const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const A = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const B = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const ALT_KEY = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9";
const SIG = "5".repeat(88);
const ix = (program: string, accounts: string[] = [A], data = new Uint8Array([1, 2, 3])) => ({ program, accounts, data });
const EVENT_1 = b64(new Uint8Array([9, 9, 9]));
const EVENT_2 = b64(new Uint8Array([8, 8]));

describe("flattenInvocations", () => {
  it("orders top-level instructions, each followed by its inner CPIs, and resolves ALT keys", () => {
    const { tx } = buildTx({
      signature: SIG,
      instructions: [
        { ix: ix(COMPUTE) },
        { ix: ix(SQUADS, [A]), inner: [ix(REGISTRY, [A, ALT_KEY]), ix(TOKEN22, [B]), ix(HOOK, [B])] },
        { ix: ix(REGISTRY, [B]) },
      ],
      loaded: { readonly: [ALT_KEY] },
    });
    const flat = flattenInvocations(tx);
    expect(flat.map((i) => [i.ordinal, i.programId, i.inner, i.topIndex])).toEqual([
      [0, COMPUTE, false, 0], [1, SQUADS, false, 1], [2, REGISTRY, true, 1], [3, TOKEN22, true, 1], [4, HOOK, true, 1], [5, REGISTRY, false, 2],
    ]);
    expect(flat[2].accounts).toEqual([A, ALT_KEY]);
    expect([...flat[0].data]).toEqual([1, 2, 3]);
  });

  it("refuses an account index outside the key list", () => {
    const { tx } = buildTx({ signature: SIG, instructions: [{ ix: ix(REGISTRY) }] });
    tx.transaction.message.instructions[0].accounts = [99];
    expect(() => flattenInvocations(tx)).toThrow(/account index/);
  });
});

describe("event attribution", () => {
  it("Squads → registry → token-2022 → hook: the registry frame keeps its own events only", () => {
    const logs = logTree([{ program: SQUADS, children: [{
      program: REGISTRY, data: [EVENT_1],
      children: [{ program: TOKEN22, children: [{ program: HOOK, data: [EVENT_2] }] }],
    }] }]);
    const frames = attributeProgramData(logs, REGISTRY);
    expect(frames).toMatchObject({ frames: [[EVENT_1]], closed: [true], truncated: false, consistent: true });
  });

  it("Squads → loader: nested depths are consistent; the loader has no registry frame", () => {
    const logs = logTree([{ program: SQUADS, children: [{ program: LOADER }] }]);
    expect(attributeProgramData(logs, REGISTRY)).toMatchObject({ frames: [], consistent: true });
  });

  it("never attributes a spoofed Program data line written by another program on top of the stack", () => {
    const logs = [
      `Program ${REGISTRY} invoke [1]`,
      `Program ${B} invoke [2]`,
      `Program data: ${EVENT_2}`,
      `Program ${B} success`,
      `Program data: ${EVENT_1}`,
      `Program ${REGISTRY} success`,
    ];
    expect(attributeProgramData(logs, REGISTRY).frames).toEqual([[EVENT_1]]);
  });

  it("marks an inconsistent stack, a truncated log and a count mismatch", () => {
    expect(attributeProgramData([`Program ${REGISTRY} invoke [2]`, `Program ${REGISTRY} success`], REGISTRY).consistent).toBe(false);
    const truncated = attributeProgramData([`Program ${REGISTRY} invoke [1]`, `Program data: ${EVENT_1}`, "Log truncated"], REGISTRY);
    expect(truncated).toMatchObject({ truncated: true, frames: [[EVENT_1]], closed: [false] });

    const two = buildTx({ signature: SIG, instructions: [{ ix: ix(REGISTRY) }, { ix: ix(REGISTRY) }],
      logs: logTree([{ program: REGISTRY, data: [EVENT_1] }]) }).tx;
    expect(transactionInvocations(two, REGISTRY).map((i) => i.eventState)).toEqual(["mismatch", "mismatch"]);
  });

  it("pairs the k-th registry invocation with the k-th registry frame, top-level and inner alike", () => {
    const { tx } = buildTx({
      signature: SIG,
      instructions: [{ ix: ix(SQUADS), inner: [ix(REGISTRY)] }, { ix: ix(REGISTRY) }],
      logs: logTree([{ program: SQUADS, children: [{ program: REGISTRY, data: [EVENT_1] }] }, { program: REGISTRY, data: [EVENT_2] }]),
    });
    const registry = transactionInvocations(tx, REGISTRY).filter((i) => i.programId === REGISTRY);
    expect(registry.map((i) => [i.inner, i.eventState, i.events.map((e) => [...e])])).toEqual([
      [true, "complete", [[9, 9, 9]]],
      [false, "complete", [[8, 8]]],
    ]);
  });

  it("no logs: missing; truncated after the first frame closed: the first stays complete", () => {
    const none = buildTx({ signature: SIG, instructions: [{ ix: ix(REGISTRY) }], logs: null }).tx;
    expect(transactionInvocations(none, REGISTRY)[0].eventState).toBe("missing");
    const cut = buildTx({ signature: SIG, instructions: [{ ix: ix(REGISTRY) }, { ix: ix(REGISTRY) }],
      logs: [...logTree([{ program: REGISTRY, data: [EVENT_1] }]), `Program ${REGISTRY} invoke [1]`, "Log truncated"] }).tx;
    expect(transactionInvocations(cut, REGISTRY).map((i) => i.eventState)).toEqual(["complete", "truncated"]);
  });
});
