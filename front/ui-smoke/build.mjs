// `npm run ui-smoke:build`: the production build the UI smoke runs against,
// with the placeholder settings of ui-smoke/env.json (localnet) and nothing
// else: no NEXT_PUBLIC_* / Supabase / RPC setting from the shell, and no
// .env* file (hermetic-env.mjs). The mainnet build is
// scripts/ci/mainnet-build.sh (run with CI=1 to keep its .next/).
import { spawnSync } from "node:child_process";
import { FRONT, NEXT_BIN, hermeticEnv } from "./hermetic-env.mjs";

let env;
try {
  env = hermeticEnv("localnet");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const result = spawnSync(process.execPath, [NEXT_BIN, "build"], { cwd: FRONT, stdio: "inherit", env });
process.exit(result.status ?? 1);
