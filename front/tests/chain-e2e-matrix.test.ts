// Talas 6.3 (design-6.3 §E): the e2e matrix is pure data the runner and the
// plan digest share. These checks keep it honest: unique one-transaction
// steps, expected codes that exist in the generated SDK under the name the
// matrix gives them, group parsing, network filtering and a digest that
// moves with every input it claims to cover.
import { describe, expect, it } from "vitest";
import { ANCHOR_ACCOUNT_NOT_INITIALIZED, E2E_STEPS, e2ePlanDigest, parseGroups, stepSpec, stepsFor } from "@/scripts/chain/lib/e2e/matrix";
import { errorName } from "@/scripts/chain/lib/e2e/errors";

const ROLES = new Set([
  "funder",
  "admin",
  "issuer",
  "superAdmin",
  "blocklistAuthority",
  "kycAuthority",
  "buyer1",
  "buyer2",
  "buyer3",
  "buyer4",
]);

describe("e2e matrix", () => {
  it("has unique ids that start with their group", () => {
    const ids = E2E_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of E2E_STEPS) {
      expect(step.id.startsWith(`${step.group}.`)).toBe(true);
      expect(step.group).toBeGreaterThanOrEqual(0);
      expect(step.group).toBeLessThanOrEqual(8);
      expect(step.networks.length).toBeGreaterThan(0);
      expect(ROLES.has(step.signer)).toBe(true);
      expect(step.title.length).toBeGreaterThan(5);
    }
  });

  it("names every expected failure as the generated SDK does", () => {
    for (const step of E2E_STEPS) {
      if (step.expect.ok) continue;
      if (step.expect.code === ANCHOR_ACCOUNT_NOT_INITIALIZED) {
        expect(step.expect.name).toBe("AccountNotInitialized");
        continue;
      }
      expect(errorName(step.expect.program, step.expect.code), `${step.id}`).toBe(step.expect.name);
    }
  });

  it("group 0 and the Super-Admin / BA / KYC-authority signers are localnet only", () => {
    for (const step of E2E_STEPS) {
      if (step.group === 0 || ["superAdmin", "blocklistAuthority", "kycAuthority"].includes(step.signer)) {
        // 1.3 is the one devnet exception: the user's browser signature at checkpoint C1.
        if (step.id === "1.3") continue;
        expect(step.networks, step.id).toEqual(["localnet"]);
      }
    }
    expect(stepSpec("1.3").networks).toEqual(["devnet", "localnet"]);
  });

  it("filters by network and group", () => {
    const devnet = stepsFor("devnet", [1, 2, 3]);
    expect(devnet.some((s) => s.id === "1.11")).toBe(false);
    expect(devnet.some((s) => s.id === "1.10")).toBe(true);
    expect(devnet.every((s) => [1, 2, 3].includes(s.group))).toBe(true);
    expect(stepsFor("localnet", [0]).map((s) => s.id)).toEqual(["0.1", "0.2"]);
    expect(() => stepSpec("9.9")).toThrow(/Unknown e2e step/);
  });

  it("parses group lists and ranges", () => {
    expect(parseGroups("1-3")).toEqual([1, 2, 3]);
    expect(parseGroups("3,1, 2")).toEqual([1, 2, 3]);
    expect(parseGroups("0-1,1")).toEqual([0, 1]);
    for (const bad of ["", "x", "3-1", "9", "1-9", "10"]) expect(() => parseGroups(bad), bad).toThrow();
  });

  it("the plan digest covers network, genesis, payer, run id and groups", () => {
    const base = { network: "devnet" as const, genesis: "g", payer: "p", runId: "abcd12", groups: [1, 2, 3] };
    const digest = e2ePlanDigest(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(e2ePlanDigest({ ...base })).toBe(digest);
    for (const change of [
      { network: "localnet" as const },
      { genesis: "h" },
      { payer: "q" },
      { runId: "abcd13" },
      { groups: [1, 2] },
    ]) {
      expect(e2ePlanDigest({ ...base, ...change })).not.toBe(digest);
    }
  });
});
