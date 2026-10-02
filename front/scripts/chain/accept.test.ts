/**
 * `npm run chain:accept`: The bootstrap steps a role key signs itself (A3, X3, X2, X1, S5c, S6) with its Ledger or a keypair, without the front; see ops/runbook-mainnet.md §5.
 * A thin runner: the vitest file exists only to run TypeScript with the `@/`
 * alias. All logic, gates and evidence live in scripts/chain/lib/.
 */
import { expect, it } from "vitest";
import { acceptTool } from "./lib/accept";
import { runTool } from "./lib/context";

it("chain:accept", async () => {
  const evidence = await runTool("accept", process.env, acceptTool, { signalHandlers: true });
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("failed");
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("aborted");
});
