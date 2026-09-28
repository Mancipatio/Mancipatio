// SERVER-ONLY — the daily refresh of the OFAC SDN list (8.5).
//
// Scheduling: its own pg_cron job, 'mancipatio-sanctions-<network>', once a
// day (scripts/ops/sanctions-scheduler.sql), calling POST
// /api/internal/sanctions with the retry worker's credential, like the retry
// and alarm workers. Not a stage of the alarm worker: that worker has a
// 30-second check budget every minute and its own fate isolation (D7); a
// 29 MB download from the Treasury does not belong there. The alarm worker
// only WATCHES the result (the sanctions-list incident when the list is
// older than 3 days), so a job that stops running still pages someone. An
// admin can also run it by hand from /admin/compliance.
//
// One run: download SDN.XML (redirect to a signed file, 45 s, 100 MB cap
// enforced while the body streams in, with or without a content-length),
// parse it (lib/ofac-sdn.ts refuses a truncated or reformatted file), and
// replace the source's addresses in one transaction (replace_sanctions_list,
// migration 0078), which also refuses a publication without a single Solana
// address. Any failure keeps the previous list and records a code
// (record_sanctions_refresh_failure). Concurrent runs are serialized by the
// function's advisory lock; the job is idempotent.
import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectNetwork, type Network } from "@/lib/network";
import { OFAC_SDN_SOURCE, OFAC_SDN_XML_URL, parseSdnXml, SdnListFormatError } from "@/lib/ofac-sdn";
import { clearSanctionsCache } from "@/lib/server/sanctions";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export const SDN_DOWNLOAD_TIMEOUT_MS = 45_000;
export const SDN_MAX_BYTES = 100 * 1024 * 1024;

export type SanctionsRefreshResult =
  | { status: "processed"; network: Network; source: string; publishedOn: string; addresses: number; removed: number; skipped: number }
  | { status: "failed"; network: Network; source: string; error: string };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

class RefreshFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * The body, read chunk by chunk and abandoned as soon as it passes
 * `maxBytes`: a chunked answer (no content-length, e.g. behind the signed
 * redirect) never lands whole in memory before the check.
 */
async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!res.body) {
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength > maxBytes) throw new RefreshFailure("TOO_LARGE");
    return body;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new RefreshFailure("TOO_LARGE");
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err instanceof RefreshFailure) throw err;
    throw new RefreshFailure(signal.aborted ? "TIMEOUT" : "TRANSPORT_ERROR");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function download(fetchImpl: Fetch, signal: AbortSignal, maxBytes: number): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchImpl(OFAC_SDN_XML_URL, {
      method: "GET",
      redirect: "follow",
      headers: { Accept: "application/xml, text/xml" },
      signal,
      cache: "no-store",
    });
  } catch {
    throw new RefreshFailure(signal.aborted ? "TIMEOUT" : "TRANSPORT_ERROR");
  }
  if (!res.ok) throw new RefreshFailure("HTTP_ERROR");
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new RefreshFailure("TOO_LARGE");
  }
  try {
    return await readCapped(res, maxBytes, signal);
  } catch (err) {
    if (err instanceof RefreshFailure) throw err;
    throw new RefreshFailure(signal.aborted ? "TIMEOUT" : "TRANSPORT_ERROR");
  }
}

export async function runSanctionsRefresh(opts: {
  sb?: SupabaseClient;
  fetchImpl?: Fetch;
  signal?: AbortSignal;
  /** The download cap (SDN_MAX_BYTES; tests pass a small one). */
  maxBytes?: number;
} = {}): Promise<SanctionsRefreshResult> {
  const network = detectNetwork();
  const sb = opts.sb ?? getSupabaseAdmin();
  const source = OFAC_SDN_SOURCE;
  const signal = opts.signal ?? AbortSignal.timeout(SDN_DOWNLOAD_TIMEOUT_MS);
  try {
    const bytes = await download(opts.fetchImpl ?? fetch, signal, opts.maxBytes ?? SDN_MAX_BYTES);
    let parsed;
    try {
      parsed = parseSdnXml(new TextDecoder("utf-8").decode(bytes));
    } catch (err) {
      throw new RefreshFailure(err instanceof SdnListFormatError ? err.code : "PARSE_ERROR");
    }
    if (parsed.addresses.length === 0) throw new RefreshFailure("EMPTY_LIST");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { data, error } = await sb.rpc("replace_sanctions_list", {
      p_source: source,
      p_published_on: parsed.publishedOn,
      p_record_count: parsed.recordCount,
      p_sha256: sha256,
      p_addresses: parsed.addresses.map((a) => ({
        address: a.address, currency: a.currency, entry_uid: a.entryUid, entry_name: a.entryName, programs: a.programs,
      })),
    });
    if (error) throw new RefreshFailure("DB_ERROR");
    clearSanctionsCache();
    const written = (data ?? {}) as { addresses?: number; removed?: number };
    return {
      status: "processed", network, source, publishedOn: parsed.publishedOn,
      addresses: Number(written.addresses ?? parsed.addresses.length), removed: Number(written.removed ?? 0),
      skipped: parsed.skipped,
    };
  } catch (err) {
    const code = err instanceof RefreshFailure ? err.code : "UNEXPECTED";
    console.error(`[sanctions] refresh of ${source} failed: ${code}`);
    try {
      await sb.rpc("record_sanctions_refresh_failure", { p_source: source, p_error: code });
    } catch {
      // The failure is in the logs and in the stale list's alarm.
    }
    return { status: "failed", network, source, error: code };
  }
}
