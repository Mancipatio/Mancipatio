/**
 * `npm run sim` with SIM_CMD=plan|pilot|wave|watch|report (and SIM_WAVE=1-5).
 * A thin runner: all logic, gates and evidence live in scripts/sim/lib/.
 */
import { expect, it } from "vitest";
import { runSim } from "./lib/runner";

it("sim", async () => {
  const result = await runSim(process.env, { signalHandlers: true });
  expect(result.status, result.detail ?? "").not.toBe("stopped");
});
