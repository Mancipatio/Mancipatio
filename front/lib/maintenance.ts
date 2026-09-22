// Maintenance mode, shared by the server (lib/server/maintenance.ts) and the
// browser. While an operator has it on (scripts/ops/maintenance.sh), signed
// writes and wallet transactions are refused with HTTP 503 and
// `code: "maintenance"`, and a banner explains why. Reads keep working.

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

/** Browser-side refusal: a transaction or request stopped by maintenance. */
export class MaintenanceModeError extends Error {
  readonly maintenanceMessage: string;
  constructor(message: string | null | undefined) {
    super(maintenanceNotice(message));
    this.name = "MaintenanceModeError";
    this.maintenanceMessage = maintenanceText(message);
  }
}

function announce(state: MaintenanceState) {
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

/** Uncached read of GET /api/maintenance in the browser; null when unreadable. */
export async function fetchMaintenance(): Promise<MaintenanceState | null> {
  if (typeof window === "undefined") return null;
  try {
    const res = await fetch("/api/maintenance", { cache: "no-store", signal: AbortSignal.timeout(5_000) });
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
 * Refuse before a transaction is offered to the wallet. Fails open when the
 * flag cannot be read: the server still refuses the pre-send policy check
 * (account.wallets.transaction) that every wallet transaction needs.
 */
export async function assertSiteWritable(): Promise<void> {
  const state = await fetchMaintenance();
  if (state?.enabled) throw new MaintenanceModeError(state.message);
}
