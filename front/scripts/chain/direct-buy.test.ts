/**
 * `npm run chain:direct-buy`: DEVNET ONLY. Buys units of an Open sale by calling the program directly with a test key (no sign-in, no Terms), to verify the off-platform buy alarm (#58); see ops/runbook-mainnet.md §15.
 * A thin runner: the vitest file exists only to run TypeScript with the `@/`
 * alias. All logic, gates and evidence live in scripts/chain/lib/.
 */
import { expect, it } from "vitest";
import { directBuyTool } from "./lib/direct-buy";
import { runTool } from "./lib/context";

it("chain:direct-buy", async () => {
  const evidence = await runTool("direct-buy", process.env, directBuyTool, { signalHandlers: true });
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("failed");
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("aborted");
});
