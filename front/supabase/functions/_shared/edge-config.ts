/**
 * Configuration of the helius-webhook edge function (Talas 4.3), runtime-
 * neutral and pure so it is tested under Node.
 *
 * Per project secrets (supabase.sh <target> secrets set --env-file …):
 *   MANCI_SUPABASE_SECRET_KEY  the project's secret API key, sb_secret_…
 *                              (a custom name: the CLI refuses SUPABASE_-
 *                              prefixed ones). No fallback to the legacy
 *                              SUPABASE_SERVICE_ROLE_KEY (D12).
 *   HELIUS_WEBHOOK_SECRET      the Authorization value Helius sends
 *   INDEXER_NETWORK            the network this project indexes
 * SUPABASE_URL is injected by the platform and must be https.
 * Anything missing or malformed answers 503, so Helius keeps retrying the
 * delivery instead of it being dropped.
 */
export type EdgeConfig = { url: string; key: string; secret: string; network: string };
export type EdgeConfigResult = { ok: true; config: EdgeConfig } | { ok: false };

const NETWORKS = new Set(["mainnet", "devnet", "testnet", "localnet"]);
export const SECRET_API_KEY = /^sb_secret_[A-Za-z0-9_-]{20,}$/;

export function readEdgeConfig(get: (name: string) => string | undefined): EdgeConfigResult {
  const url = get("SUPABASE_URL")?.trim() ?? "";
  const key = get("MANCI_SUPABASE_SECRET_KEY")?.trim() ?? "";
  const secret = get("HELIUS_WEBHOOK_SECRET") ?? "";
  const network = get("INDEXER_NETWORK")?.trim() ?? "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return { ok: false };
  if (!SECRET_API_KEY.test(key)) return { ok: false };
  if (secret.length < 32 || /\s/.test(secret)) return { ok: false };
  if (!NETWORKS.has(network)) return { ok: false };
  return { ok: true, config: { url, key, secret, network } };
}

/** The same answer _shared/indexer-webhook.ts gives an unconfigured receiver. */
export function notConfigured(): Response {
  return Response.json({ message: "Indexer receiver is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
