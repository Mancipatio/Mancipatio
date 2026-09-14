import "server-only";
import { randomUUID } from "node:crypto";
import { address } from "@solana/kit";
import { getServerRpc } from "@/lib/server/rpc";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { SiwsError } from "@/lib/server/siws";
import { decodeIndexerAccount, INDEXER_ENTITIES, INDEXER_LAYOUT_VERSION, INDEXER_PROGRAM, type DecodedIndexerAccount } from "@/lib/server/indexer-accounts";

type Job = { id: string; network: string; signature: string; slot: number | string | null; wallets: string[]; attempts: number };
type Stats = { complete: number; pending: number; invalid: number };
function signalFor(deadlineMs: number, parent?: AbortSignal) {
  parent?.throwIfAborted();
  if (Date.now() >= deadlineMs) throw new Error("Indexer deadline reached");
  const remaining = Math.max(1, Math.min(12_000, deadlineMs - Date.now()));
  return parent ? AbortSignal.any([parent, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining);
}
function slotNumber(value: unknown): number {
  if (typeof value !== "bigint" && typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) throw new Error("Invalid RPC snapshot slot");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid RPC snapshot slot");
  return number;
}
function bytes(value: unknown): Uint8Array {
  if (!Array.isArray(value) || value[1] !== "base64" || typeof value[0] !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value[0])) throw new Error("Invalid RPC account data encoding");
  return new Uint8Array(Buffer.from(value[0], "base64"));
}
async function applySnapshot(network: string, slot: number, rows: DecodedIndexerAccount[], closed: string[], signature: string | null, signal: AbortSignal) {
  const { data, error } = await getSupabaseAdmin().rpc("apply_indexer_snapshot", {
    p_network: network, p_slot: slot, p_rows: rows, p_closed: closed, p_signature: signature, p_layout_version: INDEXER_LAYOUT_VERSION,
  }).abortSignal(signal);
  if (error || !data) throw new Error(`Indexer snapshot write unavailable (${error?.code ?? "invalid response"})`);
  return data as { written: number; closed: number; stale: number; applied: string[]; deleted: Record<string, string[]> };
}

/** Validated finalized RPC snapshots; short/malformed responses are errors, never missing accounts. */
export async function refreshIndexedAddresses(addresses: string[], minContextSlot: number | null, signature: string | null, deadlineMs: number, signal?: AbortSignal) {
  const network = detectNetwork();
  let written = 0;
  for (let from = 0; from < addresses.length; from += 100) {
    signal?.throwIfAborted();
    if (Date.now() >= deadlineMs) throw new Error("Indexer deadline reached");
    const chunk = addresses.slice(from, from + 100).map(address);
    const snapshot = await getServerRpc().getMultipleAccounts(chunk, {
      encoding: "base64", commitment: "finalized", ...(minContextSlot === null ? {} : { minContextSlot: BigInt(minContextSlot) }),
    }).send({ abortSignal: signalFor(deadlineMs, signal) });
    if (!snapshot || !snapshot.context || !Array.isArray(snapshot.value) || snapshot.value.length !== chunk.length) throw new Error("Incomplete RPC account snapshot");
    const slot = slotNumber(snapshot.context.slot);
    if (minContextSlot !== null && slot < minContextSlot) throw new Error("RPC snapshot is older than the event");
    const rows: DecodedIndexerAccount[] = [];
    const closed: string[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const account = snapshot.value[i];
      if (account === null) { closed.push(chunk[i]); continue; }
      if (!account || typeof account.owner !== "string") throw new Error("Malformed RPC account");
      const encoded = bytes(account.data);
      const decoded = await decodeIndexerAccount(chunk[i], account.owner, encoded);
      if (decoded) {
        decoded.row.raw = { base64: Buffer.from(encoded).toString("base64") };
        rows.push(decoded);
      } else closed.push(chunk[i]); // owner/type change also retires an old typed mirror
    }
    const result = await applySnapshot(network, slot, rows, closed, signature, signalFor(deadlineMs, signal));
    written += result.written;
  }
  return written;
}

/** Persistent jobs are individually leased, so signed admin and scheduler runs may safely overlap. */
export async function reconcileIndexerJobs(limit = 10, deadlineMs = Date.now() + 20_000, signal?: AbortSignal): Promise<Stats> {
  const sb = getSupabaseAdmin();
  const owner = randomUUID();
  const stats: Stats = { complete: 0, pending: 0, invalid: 0 };
  const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
  for (let count = 0; count < boundedLimit; count++) {
    if (signal?.aborted || Date.now() >= deadlineMs) break;
    const { data, error } = await sb.rpc("claim_indexer_jobs", {
      p_network: detectNetwork(), p_owner: owner, p_limit: 1, p_lease_seconds: 90,
    }).abortSignal(signalFor(deadlineMs, signal));
    if (error || !Array.isArray(data)) throw new SiwsError(503, "Indexer queue unavailable");
    const job = (data as Job[] | null)?.[0];
    if (!job) break;
    try {
      if (job.network !== detectNetwork()) throw new Error("Indexer job belongs to another network");
      await refreshIndexedAddresses(job.wallets, job.slot === null ? null : slotNumber(job.slot), job.signature, deadlineMs, signal);
      const ack = await sb.rpc("finish_indexer_job", { p_id: job.id, p_owner: owner, p_complete: true, p_error: null })
        .abortSignal(signalFor(deadlineMs, signal));
      if (ack.error || ack.data !== true) throw new Error("Indexer job acknowledgement unavailable");
      stats.complete++;
    } catch (error) {
      stats.pending++;
      // Cooperative cancellation stops work. The durable lease will expire;
      // do not write a terminal verdict with a cancelled signal.
      if (signal?.aborted || Date.now() >= deadlineMs) break;
      const message = error instanceof Error ? error.message.slice(0, 240) : "Indexer snapshot unavailable";
      const retry = await sb.rpc("finish_indexer_job", { p_id: job.id, p_owner: owner, p_complete: false, p_error: message })
        .abortSignal(signalFor(deadlineMs, signal));
      if (retry.error || retry.data !== true) throw new SiwsError(503, "Indexer retry acknowledgement unavailable");
    }
  }
  return stats;
}

async function reconcileCompleteSnapshot(deadlineMs: number, signal?: AbortSignal) {
  const network = detectNetwork();
  const sb = getSupabaseAdmin();
  const snapshot = await getServerRpc().getProgramAccounts(INDEXER_PROGRAM, { encoding: "base64", commitment: "finalized", withContext: true })
    .send({ abortSignal: signalFor(deadlineMs, signal) });
  if (!snapshot || !snapshot.context || !Array.isArray(snapshot.value)) throw new SiwsError(503, "Complete program snapshot unavailable");
  const slot = slotNumber(snapshot.context.slot);
  const rows: DecodedIndexerAccount[] = [];
  const chainPdas = new Set<string>();
  // Validate every tracked account before applying anything or deleting rows.
  for (const account of snapshot.value) {
    if (Date.now() >= deadlineMs) throw new SiwsError(503, "Reconcile deadline reached — try again");
    if (!account?.account || account.account.owner !== INDEXER_PROGRAM) throw new SiwsError(503, "Program snapshot contains an unexpected account owner");
    const encoded = bytes(account.account.data);
    const decoded = await decodeIndexerAccount(account.pubkey, account.account.owner, encoded);
    if (decoded) { decoded.row.raw = { base64: Buffer.from(encoded).toString("base64") }; rows.push(decoded); chainPdas.add(account.pubkey); }
  }
  const report: Record<string, { onchain: number; refreshed: number; deleted: number; missing: number; rebuilt: number }> = {};
  const existingByTable = new Map<string, Set<string>>();
  for (const entity of INDEXER_ENTITIES) {
    const existing = new Set<string>();
    let after: string | null = null;
    for (;;) {
      let query = sb.from(entity.table).select("pda").eq("network", network).order("pda", { ascending: true }).limit(1000);
      if (after !== null) query = query.gt("pda", after);
      const page = await query.abortSignal(signalFor(deadlineMs, signal));
      if (page.error || !page.data) throw new SiwsError(503, `Reconcile read unavailable for ${entity.table}`);
      for (const row of page.data) existing.add(String(row.pda));
      if (page.data.length < 1000) break;
      after = String(page.data[page.data.length - 1].pda);
    }
    existingByTable.set(entity.table, existing);
    const matching = rows.filter((row) => row.table === entity.table);
    const missing = matching.filter(({ row }) => !existing.has(String(row.pda))).length;
    report[entity.table] = { onchain: matching.length, refreshed: 0, deleted: 0, missing, rebuilt: 0 };
  }
  for (let from = 0; from < rows.length; from += 100) {
    const batch = rows.slice(from, from + 100);
    const result = await applySnapshot(network, slot, batch, [], null, signalFor(deadlineMs, signal));
    for (const row of batch.filter(({ row }) => result.applied.includes(String(row.pda)))) {
      if (existingByTable.get(row.table)!.has(String(row.row.pda))) report[row.table].refreshed++;
      else report[row.table].rebuilt++;
    }
  }
  const closed = [...new Set([...existingByTable.values()].flatMap((set) => [...set]).filter((pda) => !chainPdas.has(pda)))];
  for (let from = 0; from < closed.length; from += 100) {
    const batch = closed.slice(from, from + 100);
    const result = await applySnapshot(network, slot, [], batch, null, signalFor(deadlineMs, signal));
    for (const [table, deleted] of Object.entries(result.deleted)) report[table].deleted += deleted.length;
  }
  const state = await sb.from("indexer_sync_state").upsert({ network, status: "ready", last_slot: slot,
    completed_at: new Date().toISOString(), checked_at: new Date().toISOString() }, { onConflict: "network" })
    .abortSignal(signalFor(deadlineMs, signal));
  if (state.error) throw new SiwsError(503, "Indexer sync acknowledgement unavailable");
  return { network, slot, report };
}

export async function reconcileAllIndexerAccounts(deadlineMs = Date.now() + 45_000, signal?: AbortSignal) {
  try { return await reconcileCompleteSnapshot(deadlineMs, signal); }
  catch (error) {
    // A failed complete scan must not leave a previously-ready cache advertised.
    // Independent, bounded cleanup still runs when the original request aborted.
    try {
      await getSupabaseAdmin().from("indexer_sync_state").upsert({ network: detectNetwork(), status: "degraded", checked_at: new Date().toISOString() }, { onConflict: "network" }).abortSignal(AbortSignal.timeout(2_000));
    } catch { /* DB outage also makes the browser readiness check fail closed. */ }
    throw error;
  }
}
