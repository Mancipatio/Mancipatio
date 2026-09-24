/**
 * `npm run chain:squads-export`: Exports one allowlisted Squads vault operation; never sends.
 * A thin runner: the vitest file exists only to run TypeScript with the `@/`
 * alias. All logic, gates and evidence live in scripts/chain/lib/.
 */
import { expect, it } from "vitest";
import { runTool } from "./lib/context";
import { squadsExportTool } from "./lib/squads-export";

it("chain:squads-export", async () => {
  const evidence = await runTool("squads-export", process.env, squadsExportTool, { signalHandlers: true });
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("failed");
  expect(evidence.status, String(evidence.error ?? "")).not.toBe("aborted");
});
