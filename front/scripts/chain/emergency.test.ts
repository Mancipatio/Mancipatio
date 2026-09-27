/**
 * `npm run chain:emergency`: Out-of-band pause / unpause / blocklist / hook mode with a Ledger or a keypair; see ops/runbook-mainnet.md §11.
 * A thin runner: the vitest file exists only to run TypeScript with the `@/`
 * alias. All logic, gates and evidence live in scripts/chain/lib/.
 */
import { expect, it } from "vitest";
import { runTool } from "./lib/context";
import { emergencyTool } from "./lib/emergency";

it("chain:emergency", async () => {
  const evidence = await runTool("emergency", process.env, emergencyTool, { signalHandlers: true });
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("failed");
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("aborted");
});
