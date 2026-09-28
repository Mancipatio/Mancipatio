// The v1.0.0-rc (8.3) proposal windows, as the program judges them: a staged
// change is executable inside [eta, expiresAt) of CHAIN time (`require_window`
// in program/programs/asset_registry/src/util.rs; the hook's own checks match).
//
// * Admin grant (`PendingAdmin`) and Super Admin rotation (platform
//   `AuthorityProposal`): eta = proposal + 48 h, waived while the one-way
//   bootstrap window (Platform.pause_flags bit 7) is open — the program's
//   `effective_eta` uses `proposed_at` then; the expiry never is.
// * Recoveries by the program upgrade authority: eta = proposal + 7 days.
// * Every other rotation (custody, issuer, KYC registry, blocklist
//   authority): no timelock (eta == proposed_at), 14 days to accept.
//
// Pure: pages feed it `useChainClock` (display) or `fetchChainNow` (chain).
import { PLATFORM_BOOTSTRAP_OPEN } from "@/lib/pause-flags";

/** Mirrors `ADMIN_TIMELOCK_SECS` / `SUPER_ADMIN_ROTATION_TIMELOCK_SECS` (48 h). */
export const ADMIN_TIMELOCK_SECONDS = 172_800;
/** Mirrors `PROPOSAL_WINDOW_SECS` (14 days after eta). */
export const PROPOSAL_WINDOW_SECONDS = 1_209_600;
/** Mirrors the registry's and the hook's recovery delay (7 days). */
export const RECOVERY_DELAY_SECONDS = 604_800;

export type ProposalWindow = { proposedAt: bigint | number; eta: bigint | number; expiresAt: bigint | number };

export type ProposalWindowState =
  /** Before eta: `remaining` seconds to wait. */
  | { kind: "waiting"; eta: number; expiresAt: number; remaining: number }
  /** Executable until `expiresAt` (`remaining` seconds left). */
  | { kind: "open"; eta: number; expiresAt: number; remaining: number }
  /** Past its window: only a cancel (or a new proposal) helps. */
  | { kind: "expired"; expiresAt: number };

/**
 * The eta the program applies: `proposed_at` while the bootstrap window is
 * open (only for the timelocks it waives: admin grants and the Super Admin
 * rotation), else the stored eta.
 */
export function effectiveEta(
  window: ProposalWindow,
  opts: { pauseFlags?: number | null; bootstrapWaived?: boolean } = {},
): number {
  const open = opts.bootstrapWaived === true && ((opts.pauseFlags ?? 0) & PLATFORM_BOOTSTRAP_OPEN) !== 0;
  return Number(open ? window.proposedAt : window.eta);
}

export function proposalWindowState(
  window: ProposalWindow,
  now: bigint | number,
  opts: { pauseFlags?: number | null; bootstrapWaived?: boolean } = {},
): ProposalWindowState {
  const t = Number(now);
  const eta = effectiveEta(window, opts);
  const expiresAt = Number(window.expiresAt);
  if (t >= expiresAt) return { kind: "expired", expiresAt };
  if (t < eta) return { kind: "waiting", eta, expiresAt, remaining: eta - t };
  return { kind: "open", eta, expiresAt, remaining: expiresAt - t };
}

/** "6d 23h 59m", "3h 02m", "4m 05s", "now". */
function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return "now";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h ${pad(m)}m`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m ${pad(s % 60)}s`;
}

const utc = (unix: number) => `${new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Why the window refuses an execute now, or null inside it. */
export function proposalWindowBlocker(state: ProposalWindowState): string | null {
  switch (state.kind) {
    case "waiting":
      return `Waiting period: this can be executed from ${utc(state.eta)} (in ${countdown(state.remaining)}).`;
    case "expired":
      return `Expired on ${utc(state.expiresAt)}: it can no longer be executed. Cancel it, or have it proposed again.`;
    default:
      return null;
  }
}

/** One line for a pending proposal's status ("executable for 13d 2h 05m", …). */
export function describeProposalWindow(state: ProposalWindowState): string {
  switch (state.kind) {
    case "waiting":
      return `Executable from ${utc(state.eta)} (in ${countdown(state.remaining)}), until ${utc(state.expiresAt)}.`;
    case "open":
      return `Executable now, until ${utc(state.expiresAt)} (${countdown(state.remaining)} left).`;
    case "expired":
      return `Expired on ${utc(state.expiresAt)}.`;
  }
}
