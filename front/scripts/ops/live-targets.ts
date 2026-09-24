// Target selection for the live operator runners (deployment-smoke,
// reconcile-index). Pure: callers pass the environment and, in tests, the
// targets; nothing here reads a file other than scripts/ops/targets.json or
// touches the network.
import { loadTargets, SITE_ORIGIN } from "./target.mjs";

export type LiveNetwork = "devnet" | "mainnet";
type Env = Record<string, string | undefined>;
type Targets = Record<string, { network: string; projectRef: string | null; siteOrigin: string | null }>;

function liveNetwork(value: string | undefined, variable: string, env: Env): LiveNetwork {
  if (value !== "devnet" && value !== "mainnet") {
    throw new Error(`Explicit ${variable}=devnet or ${variable}=mainnet is required; nothing was accessed`);
  }
  if (value === "mainnet" && env.MANCI_ALLOW_MAINNET !== "1") {
    throw new Error(`${variable}=mainnet also needs MANCI_ALLOW_MAINNET=1`);
  }
  return value;
}

export const otherNetwork = (network: LiveNetwork): LiveNetwork => (network === "devnet" ? "mainnet" : "devnet");

/**
 * MANCIPATIO_LIVE_SMOKE=<devnet|mainnet> → the origin to probe: the target's
 * siteOrigin from targets.json (refused while null). SMOKE_ORIGIN may point
 * the run elsewhere (a preview), but must be https://<host> and never another
 * target's origin.
 */
export function smokeTarget(env: Env, targets: Targets = loadTargets()): { network: LiveNetwork; origin: string } {
  const network = liveNetwork(env.MANCIPATIO_LIVE_SMOKE, "MANCIPATIO_LIVE_SMOKE", env);
  const configured = targets[network]?.siteOrigin ?? null;
  if (!configured) throw new Error(`scripts/ops/targets.json has no siteOrigin for ${network} yet`);
  const override = env.SMOKE_ORIGIN?.trim();
  if (!override) return { network, origin: configured };
  if (!SITE_ORIGIN.test(override)) throw new Error("SMOKE_ORIGIN must be https://<host> with no port or path");
  const foreign = Object.entries(targets).some(([name, target]) => name !== network && target.siteOrigin === override);
  if (foreign) throw new Error("SMOKE_ORIGIN is another target's origin");
  return { network, origin: override };
}

/** RPC keys the reconcile runner may take from its env file, per network. */
export const RECONCILE_RPC_KEYS: Record<LiveNetwork, readonly string[]> = {
  devnet: ["HELIUS_DEVNET_RPC"],
  mainnet: ["HELIUS_MAINNET_RPC", "SOLANA_MAINNET_RPC"],
};

/**
 * MANCIPATIO_RECONCILE=<devnet|mainnet>, with MANCIPATIO_RECONCILE_PROJECT
 * equal to that target's projectRef. The env file defaults to .env.local on
 * devnet only; mainnet names it explicitly.
 */
export function reconcileTarget(env: Env, targets: Targets = loadTargets()) {
  const network = liveNetwork(env.MANCIPATIO_RECONCILE, "MANCIPATIO_RECONCILE", env);
  const project = targets[network]?.projectRef ?? null;
  if (!project) throw new Error(`scripts/ops/targets.json has no projectRef for ${network} yet`);
  if (env.MANCIPATIO_RECONCILE_PROJECT !== project) {
    throw new Error(`MANCIPATIO_RECONCILE_PROJECT must equal the ${network} projectRef in scripts/ops/targets.json`);
  }
  const envFile = env.MANCIPATIO_RECONCILE_ENV_FILE || (network === "devnet" ? ".env.local" : "");
  if (!envFile) throw new Error("MANCIPATIO_RECONCILE_ENV_FILE is required for mainnet (there is no .env.local default)");
  return { network, project, envFile };
}

/**
 * Copies only the reviewed keys from the parsed env file into `env`, and
 * removes every other *_RPC key, so an inherited RPC for another network can
 * never be picked up by the server RPC resolver.
 */
export function applyReconcileEnv(parsed: Env, network: LiveNetwork, env: Env = process.env) {
  const keys = [
    "NEXT_PUBLIC_NETWORK",
    "NEXT_PUBLIC_SOLANA_GENESIS_HASH",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    ...RECONCILE_RPC_KEYS[network],
  ];
  for (const key of Object.keys(env)) {
    if (/_RPC$/.test(key) && !keys.includes(key)) delete env[key];
  }
  for (const key of keys) {
    if (parsed[key] === undefined) delete env[key];
    else env[key] = parsed[key];
  }
}

/** The reconcile RPC: the network's provider key; the public RPC only on devnet. */
export function reconcileRpcUrl(env: Env, network: LiveNetwork): URL {
  const configured = RECONCILE_RPC_KEYS[network].map((key) => env[key]).find((value) => value);
  if (!configured && network === "mainnet") {
    throw new Error("No mainnet RPC in the env file (HELIUS_MAINNET_RPC or SOLANA_MAINNET_RPC); there is no public fallback");
  }
  const url = new URL(configured || "https://api.devnet.solana.com");
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid RPC configuration");
  return url;
}
