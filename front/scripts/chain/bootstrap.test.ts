/**
 * `npm run chain:bootstrap`: Plans (dry run) or sends one bootstrap cycle; see ops/runbook-mainnet.md steps 4-7.
 * A thin runner: the vitest file exists only to run TypeScript with the `@/`
 * alias. All logic, gates and evidence live in scripts/chain/lib/.
 */
import { expect, it } from "vitest";
import { runTool } from "./lib/context";
import { bootstrapTool } from "./lib/bootstrap-plan";

it("chain:bootstrap", async () => {
  const evidence = await runTool("bootstrap", process.env, bootstrapTool, { signalHandlers: true });
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("failed");
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("aborted");
});
