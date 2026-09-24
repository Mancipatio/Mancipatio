/**
 * `npm run chain:inventory`: Read-only inventory with findings per CHAIN_PHASE.
 * A thin runner: the vitest file exists only to run TypeScript with the `@/`
 * alias. All logic, gates and evidence live in scripts/chain/lib/.
 */
import { expect, it } from "vitest";
import { runTool } from "./lib/context";
import { inventoryTool } from "./lib/inventory";

it("chain:inventory", async () => {
  const evidence = await runTool("inventory", process.env, inventoryTool, { signalHandlers: true });
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("failed");
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("aborted");
});
