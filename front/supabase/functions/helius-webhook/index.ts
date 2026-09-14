// Apply 0047 and deploy/configure the authenticated Next retry worker BEFORE
// switching this receiver. HTTP 202 means event + job committed atomically;
// RPC, generated decoding and typed snapshots execute behind the durable queue.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { handleIndexerWebhook } from "../_shared/indexer-webhook.ts";
const url = Deno.env.get("SUPABASE_URL") ?? "";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const secret = Deno.env.get("HELIUS_WEBHOOK_SECRET") ?? "";
const network = Deno.env.get("INDEXER_NETWORK") ?? "";
Deno.serve((request: Request) => handleIndexerWebhook(request, {
  secret, network,
  enqueue: async (events, signal) => {
    if (!url || !key) throw new Error("Database is not configured");
    const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await sb.rpc("enqueue_indexer_events", { p_network: network, p_events: events }).abortSignal(signal);
    if (error || typeof data !== "number") throw new Error("Durable enqueue failed");
    return data;
  },
}));
