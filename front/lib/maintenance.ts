// Maintenance mode, shared by the server (lib/server/maintenance.ts) and the
// browser. While an operator has it on (scripts/ops/maintenance.sh), signed
// writes and wallet transactions are refused with HTTP 503 and
// `code: "maintenance"`, and a banner explains why. Reads keep working.

import { isSessionReadAction } from "@/lib/siws-session";

export const MAINTENANCE_CODE = "maintenance";
/** Window event carrying a fresh MaintenanceState (the banner listens). */
export const MAINTENANCE_EVENT = "manci:maintenance";
export const DEFAULT_MAINTENANCE_MESSAGE = "Platform upgrade in progress. It should be over shortly.";

export type MaintenanceStatus = { enabled: boolean; message: string | null };
/** Wire shape of GET /api/maintenance. */
export type MaintenanceState = MaintenanceStatus & { network: string };

export function maintenanceText(message: string | null | undefined): string {
  return message?.trim() || DEFAULT_MAINTENANCE_MESSAGE;
}

/** The one sentence users see wherever an action is refused. */
export function maintenanceNotice(message: string | null | undefined): string {
  return `Manci is in maintenance: ${maintenanceText(message)}`;
}

// ── Which signed actions maintenance refuses ────────────────────────────────
// One classification for the server guard (verifySigned / readActor) and the
// browser, which does not prompt the wallet to sign a request the server
// would refuse anyway (lib/siws-client.ts createSignedRequest).
//
// Allowed besides the session reads:
//   * signing in, and accepting the Terms: the ToS gate
//     (components/tos-gate.tsx) blocks reading the marketplace until then;
//   * the admin indexer repairs, which only re-derive the mirrors from the
//     chain like the retry worker does;
//   * receipts of a transaction that already landed. Each one only records a
//     signature the server verifies on chain and grants nothing new, and for
//     most of them the receipt kept in that one browser is the only way back:
//     no server-side job exists until the receipt is posted (a purchase
//     recorded after maintenance began would otherwise be lost for good if the
//     buyer switched device). Admin receipts (passport sync, plan binding)
//     stay refused; their pages keep a retry.
const ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  "auth.session",
  "tos.accept",
  "admin.reconcile",
  "admin.reconcilePurchases",
  "admin.retryIndexer",
  "launchpad.recordPurchase",
  "vesting-series.record-step",
  "conversion.deposited",
  "conversion.reclaim",
  "delivery.deposited",
  "delivery.reclaim",
]);
// A read by shape, but it is the pre-send policy check of every wallet
// transaction (lib/transaction-wallet-policy.ts), so it stops UI sends.
const REFUSED_READS: ReadonlySet<string> = new Set(["account.wallets.transaction"]);

/** True when maintenance refuses this signed action. */
export function refusedInMaintenance(action: string): boolean {
  if (REFUSED_READS.has(action)) return true;
  return !isSessionReadAction(action) && !ALLOWED_ACTIONS.has(action);
}

// ── Browser ─────────────────────────────────────────────────────────────────

/** Browser-side refusal: a transaction or request stopped by maintenance. */
export class MaintenanceModeError extends Error {
  readonly maintenanceMessage: string;
  constructor(message: string | null | undefined) {
    super(maintenanceNotice(message));
    this.name = "MaintenanceModeError";
    this.maintenanceMessage = maintenanceText(message);
  }
}

/** The flag could not be read and the caller must not guess (issuer recovery). */
export class MaintenanceUnknownError extends Error {
  constructor() {
    super("We could not confirm that Manci is out of maintenance. Check your connection and try again.");
    this.name = "MaintenanceUnknownError";
  }
}

// Last state this page learned (a poll, a pre-send check or a refusal). A
// failed read keeps it, so a flag that was on stays on until a read says off.
let lastKnown: MaintenanceState | null = null;

function announce(state: MaintenanceState) {
  lastKnown = state;
  try {
    window.dispatchEvent(new CustomEvent<MaintenanceState>(MAINTENANCE_EVENT, { detail: state }));
  } catch { /* no window (tests, server) */ }
}

/** A server answer with `code: "maintenance"`: show the banner now and refuse. */
export function maintenanceRefusal(message: unknown, network = ""): MaintenanceModeError {
  const error = new MaintenanceModeError(typeof message === "string" ? message : null);
  if (typeof window !== "undefined") announce({ enabled: true, message: error.maintenanceMessage, network });
  return error;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  // Older browsers: without this the request itself would throw and every
  // check would read as "unknown".
  if (typeof AbortController !== "function") return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Read GET /api/maintenance in the browser; null when unreadable (network
 * error, timeout, or the server could not read the flag either). The answer
 * may come from the CDN, at most a few seconds old; `fresh` bypasses it.
 */
export async function fetchMaintenance(options: { fresh?: boolean } = {}): Promise<MaintenanceState | null> {
  if (typeof window === "undefined") return null;
  try {
    const url = options.fresh ? `/api/maintenance?fresh=${Date.now()}` : "/api/maintenance";
    const res = await fetch(url, { cache: "no-store", signal: timeoutSignal(5_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<MaintenanceState> | null;
    if (!json || typeof json.enabled !== "boolean") return null;
    const state: MaintenanceState = {
      enabled: json.enabled,
      message: json.enabled ? maintenanceText(json.message) : null,
      network: typeof json.network === "string" ? json.network : "",
    };
    announce(state);
    return state;
  } catch {
    return null;
  }
}

/**
 * Refuse before a signed request is offered to the wallet when this page
 * already knows maintenance is on (the banner polls every 30 s and on focus,
 * and every refusal announces it). No request of its own: signing stays as
 * fast as before, and the server refuses whatever gets past this.
 */
export function assertNotInKnownMaintenance(): void {
  if (lastKnown?.enabled) throw new MaintenanceModeError(lastKnown.message);
}

/**
 * Refuse before a transaction is offered to the wallet. When the flag cannot
 * be read, the last state this page saw decides; with none, it fails open,
 * because the server still refuses the default send path's pre-send policy
 * check (account.wallets.transaction). `failClosed` is for sends the server
 * never sees (issuer recovery): it needs a fresh answer that maintenance is off.
 */
export async function assertSiteWritable(options: { failClosed?: boolean } = {}): Promise<void> {
  const state = await fetchMaintenance({ fresh: options.failClosed });
  const known = state ?? lastKnown;
  if (known?.enabled) throw new MaintenanceModeError(known.message);
  if (!state && options.failClosed) throw new MaintenanceUnknownError();
}
