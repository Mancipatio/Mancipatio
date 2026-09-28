// `npm run ui-smoke:build`: the production build the UI smoke runs against,
// with the placeholder settings of ui-smoke/env.json (localnet) and nothing
// else from the environment's NEXT_PUBLIC_* / Supabase / RPC settings, so a
// developer's .env.local cannot leak into it. The mainnet build is
// scripts/ci/mainnet-build.sh (run with CI=1 to keep its .next/).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const env = JSON.parse(readFileSync(new URL("./env.json", import.meta.url), "utf8")).localnet;
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(NEXT_PUBLIC_|SUPABASE_|HELIUS_|SOLANA_|SESSION_SECRET$|GEOBLOCK_)/.test(name)),
);
// Next reads .env* files itself; the placeholders are set in the process
// environment, which wins over every .env file.
const result = spawnSync("npx", ["next", "build"], { stdio: "inherit", env: { ...inherited, ...env } });
process.exit(result.status ?? 1);
