// SERVER-ONLY — maintenance mode (migration 0061, scripts/ops/maintenance.sh).
//
// While a network's flag is on, verifySigned / readActor refuse every signed
// write, and the pre-send wallet policy check, with 503 before the nonce is
// spent (the classification lives in lib/maintenance.ts). Reads, sign-in, GET
// routes, the indexer webhook and the retry worker keep running. The flag is
// read with the service role and cached for a few seconds per network.
//
// A failed read keeps the LAST KNOWN state: a flag that was on stays on until
// a read succeeds, so a slow or restarting database during the maintenance
// window never reopens writes. Only an instance that never read the flag
// FAILS OPEN (a database hiccup must not take the whole site down; the writes
// themselves and the nonce store still fail closed on their own). A missing
// table means the feature is not installed yet, which is a definite "off".

import "server-only";

import { NextResponse } from "next/server";
import type { Network } from "@/lib/network";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { SiwsError } from "@/lib/server/siws-error";
import {
  MAINTENANCE_CODE, maintenanceNotice, maintenanceText, refusedInMaintenance, type MaintenanceStatus,
} from "@/lib/maintenance";

export { refusedInMaintenance };

const CACHE_MS = 5_000;
/** How long a failed read is reused before the next attempt. */
const RETRY_MS = 1_000;
const READ_TIMEOUT_MS = 2_000;
// PostgREST / Postgres "no such table": migration 0061 not applied yet.
const MISSING_TABLE_CODES: ReadonlySet<string> = new Set(["42P01", "PGRST205"]);

/** `fresh` is false when the latest read failed and the status is the last
 * known one (or the fail-open default). */
export type MaintenanceReading = MaintenanceStatus & { fresh: boolean };

const cache = new Map<Network, { at: number; ttl: number; reading: MaintenanceReading }>();
const lastKnown = new Map<Network, MaintenanceStatus>();
const pending = new Map<Network, Promise<MaintenanceReading>>();
const warned = new Set<Network>();

/** A signed write refused because the site is in maintenance (HTTP 503). */
export class MaintenanceError extends SiwsError {
  readonly maintenanceMessage: string;
  constructor(message: string | null) {
    super(503, maintenanceNotice(message));
    this.name = "MaintenanceError";
    this.maintenanceMessage = maintenanceText(message);
  }
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** The stored flag, or null when it could not be read. */
async function readFlag(network: Network): Promise<MaintenanceStatus | null> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("platform_maintenance")
      .select("enabled,message")
      .eq("network", network)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
      .maybeSingle();
    if (error) throw error;
    warned.delete(network);
    // No row = not in maintenance.
    return data?.enabled === true
      ? { enabled: true, message: maintenanceText(data.message) }
      : { enabled: false, message: null };
  } catch (error) {
    const code = errorCode(error);
    const missing = code !== null && MISSING_TABLE_CODES.has(code);
    // Once per outage; codes only, never connection details or bodies.
    if (!warned.has(network)) {
      warned.add(network);
      console.warn(
        missing ? "[maintenance] flag table missing (migration 0061), treating as off:"
          : "[maintenance] flag unreadable, keeping the last known state:",
        code ?? "read failed",
      );
    }
    return missing ? { enabled: false, message: null } : null;
  }
}

/** The network's maintenance flag with whether this read succeeded. Never throws. */
export async function readMaintenance(network: Network): Promise<MaintenanceReading> {
  const hit = cache.get(network);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.reading;
  let read = pending.get(network);
  if (!read) {
    read = readFlag(network)
      .then((status) => {
        if (status) lastKnown.set(network, status);
        const reading: MaintenanceReading = status
          ? { ...status, fresh: true }
          : { ...(lastKnown.get(network) ?? { enabled: false, message: null }), fresh: false };
        cache.set(network, { at: Date.now(), ttl: status ? CACHE_MS : RETRY_MS, reading });
        return reading;
      })
      .finally(() => pending.delete(network));
    pending.set(network, read);
  }
  return read;
}

/** The network's maintenance flag, at most ~5 s old (last known on a failed read). */
export async function getMaintenance(network: Network): Promise<MaintenanceStatus> {
  const { enabled, message } = await readMaintenance(network);
  return { enabled, message };
}

/** Throw MaintenanceError (503) while the network is in maintenance. */
export async function assertWritable(network: Network): Promise<void> {
  const { enabled, message } = await getMaintenance(network);
  if (enabled) throw new MaintenanceError(message);
}

/** Refuse `action` if it writes and the network is in maintenance. */
export async function assertActionWritable(action: string, network: Network): Promise<void> {
  if (refusedInMaintenance(action)) await assertWritable(network);
}

/** 503 JSON in the house envelope; `code` lets clients tell it apart. */
export function maintenanceResponse(error: MaintenanceError): NextResponse {
  return NextResponse.json(
    { ok: false, error: error.message, code: MAINTENANCE_CODE, message: error.maintenanceMessage },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } },
  );
}
