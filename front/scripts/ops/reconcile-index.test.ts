import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { it, vi } from "vitest";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import { applyReconcileEnv, reconcileRpcUrl, reconcileTarget } from "./live-targets";

// This marker shim is local to the operator process. RPC, decoding, Supabase
// authorization and the actual server reconciliation helper are not mocked.
vi.mock("server-only", () => ({}));

// MANCIPATIO_RECONCILE=<devnet|mainnet> (mainnet also needs
// MANCI_ALLOW_MAINNET=1), MANCIPATIO_RECONCILE_PROJECT = that target's
// projectRef in scripts/ops/targets.json, and an env file: .env.local by
// default on devnet only, MANCIPATIO_RECONCILE_ENV_FILE always on mainnet.
// Only the network's own RPC keys are taken from it (every other *_RPC key is
// removed); mainnet has no public RPC fallback. The database must report the
// same network (public.deployment_network(), migration 0070) before any work.
it("completely reconciles the explicitly selected index", async () => {
  const { network, project, envFile } = reconcileTarget(process.env);
  const output = process.env.MANCIPATIO_RECONCILE_OUTPUT;
  if (!output)
    throw new Error(
      "MANCIPATIO_RECONCILE_OUTPUT must name the aggregate evidence file",
    );

  const started = Date.now();
  const deadline = started + 45_000;
  const originalFetch = globalThis.fetch;
  let phase = "configuration";
  try {
    applyReconcileEnv(parseEnv(readFileSync(path.resolve(envFile), "utf8")), network);
    if (process.env.NEXT_PUBLIC_NETWORK !== network)
      throw new Error("Network mismatch");
    const supabaseUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    if (
      supabaseUrl.href.replace(/\/$/, "") !== `https://${project}.supabase.co`
    )
      throw new Error("Project mismatch");
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
      throw new Error("Missing operator credential");
    const rpcUrl = reconcileRpcUrl(process.env, network);

    // Bound every real request, including genesis verification and cleanup.
    // Refuse Solana writes and requests outside the selected two endpoints.
    globalThis.fetch = async (input, init) => {
      if (Date.now() >= deadline) throw new Error("Operator deadline reached");
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input));
      if (url.href === rpcUrl.href) {
        const body =
          init?.body ?? (request ? await request.clone().text() : undefined);
        if (
          typeof body !== "string" ||
          !["getGenesisHash", "getProgramAccounts"].includes(
            JSON.parse(body).method,
          )
        ) {
          throw new Error("Non-read-only Solana request refused");
        }
      } else if (
        url.origin !== supabaseUrl.origin ||
        !url.pathname.startsWith("/rest/v1/")
      ) {
        throw new Error("Unexpected operator request destination");
      }
      const parent = init?.signal ?? request?.signal;
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      return originalFetch(input, {
        ...init,
        signal: parent ? AbortSignal.any([parent, signal]) : signal,
        redirect: "error",
      });
    };

    // Imports occur after configuration so the real cached clients use only
    // the reviewed environment file, never mixed inherited credentials.
    const { getServerRpc } = await import("@/lib/server/rpc");
    const { getSupabaseAdmin } = await import("@/lib/supabase-server");
    const { reconcileAllIndexerAccounts } =
      await import("@/lib/server/indexer-sync");
    phase = "genesis";
    const genesis = await getServerRpc()
      .getGenesisHash()
      .send({ abortSignal: AbortSignal.timeout(10_000) });
    if (genesis !== CLUSTER_GENESIS_HASHES[network])
      throw new Error("Genesis mismatch");
    phase = "database-identity";
    const identity = await getSupabaseAdmin()
      .rpc("deployment_network")
      .abortSignal(AbortSignal.timeout(Math.max(1, deadline - Date.now())));
    if (identity.error || identity.data !== network)
      throw new Error("Database network mismatch");
    phase = "database-access";
    const access = await getSupabaseAdmin()
      .from("indexer_jobs")
      .select("id", { count: "exact", head: true })
      .eq("network", network)
      .abortSignal(AbortSignal.timeout(Math.max(1, deadline - Date.now())));
    if (access.error || access.count === null)
      throw new Error(
        "Private indexer schema or service-role access unavailable",
      );

    phase = "complete-reconcile";
    // Reserve five seconds for the helper's degraded-state cleanup and the
    // final readiness read; all requests still share the 45-second hard bound.
    const workDeadline = deadline - 5_000;
    if (Date.now() >= workDeadline)
      throw new Error("Preflight exhausted the work budget");
    const result = await reconcileAllIndexerAccounts(
      workDeadline,
      AbortSignal.timeout(workDeadline - Date.now()),
    );
    phase = "readiness";
    const state = await getSupabaseAdmin()
      .from("indexer_sync_state")
      .select("network,status,last_slot")
      .eq("network", network)
      .abortSignal(AbortSignal.timeout(Math.max(1, deadline - Date.now())))
      .single();
    if (
      state.error ||
      state.data?.status !== "ready" ||
      BigInt(state.data.last_slot) < BigInt(result.slot)
    ) {
      throw new Error("Complete reconcile readiness was not acknowledged");
    }
    const summary = {
      schema: "mancipatio-operator-index-reconcile-v1",
      started_at_utc: new Date(started).toISOString(),
      completed_at_utc: new Date().toISOString(),
      project_ref: project,
      network: result.network,
      genesis_verified: true,
      context_slot: result.slot,
      readiness: state.data.status,
      readiness_slot: String(state.data.last_slot),
      report: result.report,
      elapsed_ms: Date.now() - started,
    };
    mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    writeFileSync(
      path.resolve(output),
      JSON.stringify(summary, null, 2) + "\n",
    );
    console.log(JSON.stringify(summary));
  } catch {
    // RPC/SDK exceptions may contain a credential-bearing URL. Never send the
    // original exception, body, raw accounts or service key to Vitest output.
    throw new Error(
      `Operator reconcile failed during ${phase}; sensitive details withheld. Readiness must be checked before retrying.`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
