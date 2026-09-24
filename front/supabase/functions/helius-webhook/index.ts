// Apply 0047 and deploy/configure the authenticated Next retry worker BEFORE
// switching this receiver. HTTP 202 means event + job committed atomically;
// RPC, generated decoding and typed snapshots execute behind the durable queue.
//
// Talas 4.3: supabase-js comes from the import map (deno.json, the version
// package-lock.json pins), the database key is the custom secret
// MANCI_SUPABASE_SECRET_KEY (sb_secret_…, no legacy fallback), and the client
// is created once per isolate. Set the secrets first, then deploy:
//   bash scripts/ops/supabase.sh <target> secrets set --env-file <file>
//   bash scripts/ops/supabase.sh <target> functions deploy helius-webhook
// A wrong INDEXER_NETWORK is refused by the database (0071 network guard), so
// the delivery answers 503 and Helius retries it.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { notConfigured, readEdgeConfig } from "../_shared/edge-config.ts";
import { handleIndexerWebhook } from "../_shared/indexer-webhook.ts";

const configured = readEdgeConfig((name) => Deno.env.get(name));
let client: SupabaseClient | null = null;

Deno.serve((request: Request) => {
  if (!configured.ok) return notConfigured();
  const { url, key, secret, network } = configured.config;
  return handleIndexerWebhook(request, {
    secret, network,
    enqueue: async (events, signal) => {
      client ??= createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await client.rpc("enqueue_indexer_events", { p_network: network, p_events: events }).abortSignal(signal);
      if (error || typeof data !== "number") throw new Error("Durable enqueue failed");
      return data;
    },
  });
});
