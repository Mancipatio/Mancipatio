// SERVER-ONLY — maintenance mode (migration 0061, scripts/ops/maintenance.sh).
//
// While a network's flag is on, verifySigned / readActor refuse every signed
// write, and the pre-send wallet policy check, with 503 before the nonce is
// spent. Reads, sign-in, GET routes, the indexer webhook and the retry worker
// keep running. The flag is read with the service role and cached for a few
// seconds per network. Reading it FAILS OPEN: a database hiccup or a missing
// table must never take the whole site down (the writes themselves and the
// nonce store still fail closed on their own).

import "server-only";

import { NextResponse } from "next/server";
import type { Network } from "@/lib/network";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { SiwsError } from "@/lib/server/siws-error";
import { isSessionReadAction } from "@/lib/siws-session";
import { MAINTENANCE_CODE, maintenanceNotice, maintenanceText, type MaintenanceStatus } from "@/lib/maintenance";

const CACHE_MS = 5_000;
const READ_TIMEOUT_MS = 2_000;

const cache = new Map<Network, { at: number; status: MaintenanceStatus }>();
const pending = new Map<Network, Promise<MaintenanceStatus>>();
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

async function readFlag(network: Network): Promise<MaintenanceStatus> {
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
    // Once per outage; codes only, never connection details or bodies.
    if (!warned.has(network)) {
      warned.add(network);
      const code = (error as { code?: unknown } | null)?.code;
      console.warn("[maintenance] flag unreadable, treating as off:", typeof code === "string" ? code : "read failed");
    }
    return { enabled: false, message: null };
  }
}

/** The network's maintenance flag, at most ~5 s old. Never throws. */
export async function getMaintenance(network: Network): Promise<MaintenanceStatus> {
  const hit = cache.get(network);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.status;
  let read = pending.get(network);
  if (!read) {
    read = readFlag(network)
      .then((status) => {
        cache.set(network, { at: Date.now(), status });
        return status;
      })
      .finally(() => pending.delete(network));
    pending.set(network, read);
  }
  return read;
}

/** Throw MaintenanceError (503) while the network is in maintenance. */
export async function assertWritable(network: Network): Promise<void> {
  const { enabled, message } = await getMaintenance(network);
  if (enabled) throw new MaintenanceError(message);
}

// Signed actions that stay available in maintenance besides the session
// reads: signing in; accepting the Terms, because the ToS gate
// (components/tos-gate.tsx) blocks reading the marketplace until then; and
// the admin indexer repairs, which only re-derive the mirrors from the chain
// like the retry worker does.
const ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  "auth.session",
  "tos.accept",
  "admin.reconcile",
  "admin.reconcilePurchases",
  "admin.retryIndexer",
]);
// A read by shape, but it is the pre-send policy check of every wallet
// transaction (lib/transaction-wallet-policy.ts), so it stops UI sends.
const REFUSED_READS: ReadonlySet<string> = new Set(["account.wallets.transaction"]);

export function refusedInMaintenance(action: string): boolean {
  if (REFUSED_READS.has(action)) return true;
  return !isSessionReadAction(action) && !ALLOWED_ACTIONS.has(action);
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
