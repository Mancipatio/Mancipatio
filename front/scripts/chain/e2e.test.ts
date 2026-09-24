/**
 * `npm run chain:e2e`: the Talas 6.3 e2e matrix (dry run prints the plan digest; send runs it; devnet or localnet only).
 * A thin runner: the vitest file exists only to run TypeScript with the `@/`
 * alias. All logic, gates and evidence live in scripts/chain/lib/.
 */
import { expect, it } from "vitest";
import { runTool } from "./lib/context";
import { e2eTool } from "./lib/e2e/tool";

it("chain:e2e", async () => {
  const evidence = await runTool("e2e", process.env, e2eTool, { signalHandlers: true });
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("failed");
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("aborted");
});
