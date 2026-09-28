/**
 * `npm run chain:handover`: Read-only, ordered plan to move live roles to new keys; see ops/runbook-mainnet.md, Company wallet model.
 * A thin runner: the vitest file exists only to run TypeScript with the `@/`
 * alias. All logic, gates and evidence live in scripts/chain/lib/.
 */
import { expect, it } from "vitest";
import { runTool } from "./lib/context";
import { handoverTool } from "./lib/handover-plan";

it("chain:handover", async () => {
  const evidence = await runTool("handover", process.env, handoverTool, { signalHandlers: true });
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("failed");
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("aborted");
});
