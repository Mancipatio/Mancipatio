/**
 * `npm run chain:idl`: Checks, sends or prepares the canonical IDL (CHAIN_IDL_MODE).
 * A thin runner: the vitest file exists only to run TypeScript with the `@/`
 * alias. All logic, gates and evidence live in scripts/chain/lib/.
 */
import { expect, it } from "vitest";
import { runTool } from "./lib/context";
import { idlTool } from "./lib/idl-plan";

it("chain:idl", async () => {
  const evidence = await runTool("idl", process.env, idlTool, { signalHandlers: true });
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("failed");
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("aborted");
});
