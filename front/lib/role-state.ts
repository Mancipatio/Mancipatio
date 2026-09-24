// The pure half of the role provider (Talas 3.1): what every consumer and
// gate sees for a role-store view. No React and no wallet hooks, so the node
// tests drive it directly; lib/auth.ts (RoleProvider / useRole) and
// components/require-role.tsx only wire it up.
import type { Address } from "@solana/kit";
import type { Network } from "@/lib/network";
import type { KycRegistryRecord } from "@/lib/kyc-authority";
import {
  capabilitiesOf,
  deriveRoles,
  type Capability,
  type OutgoingProposal,
  type PendingRole,
  type RoleFlags,
} from "@/lib/role-resolution";
import type { RoleReadResult, RoleStoreView } from "@/lib/role-store";

export type Role = "superAdmin" | "admin" | "issuer" | "public" | "disconnected";

export type RoleState = {
  loading: boolean;
  /**
   * The values predate the last role change (invalidateRoles) and a fresh
   * read is in flight: pages keep showing them, and a gate only keeps a
   * decision it made before the change (gateOutcome), never makes a new one.
   */
  stale: boolean;
  /** Ranking role (super admin > admin > issuer > public). Side roles are flags. */
  role: Role;
  walletAddress: string | null;
  isSuperAdmin: boolean;
  /** Covers the super admin. */
  isAdmin: boolean;
  isIssuer: boolean;
  isVerifiedIssuer: boolean;
  platformInitialized: boolean;
  /**
   * Live `KycRegistry.authority` of the platform registry. On an unpinned
   * build this is resolved only for consumers that pass `{ kyc: true }`;
   * for the others it stays false.
   */
  isKycProvider: boolean;
  /** transfer_hook `BlocklistAuthority.authority`. */
  isBlocklistAuthority: boolean;
  /** The platform KYC registry (see isKycProvider for when it is resolved). */
  kycRegistry: KycRegistryRecord | null;
  /** Why the platform registry could not be resolved, when it could not. */
  kycUnavailable: string | null;
  /** The current blocklist authority key, or null when not initialised. */
  blocklistAuthority: Address | null;
  /** Live proposals naming this wallet (platform, blocklist, KYC registry). */
  pending: PendingRole[];
  /** Proposals this wallet made as the current authority. */
  outgoing: OutgoingProposal[];
  capabilities: ReadonlySet<Capability>;
  /** The role read failed: gates stay closed and offer `refresh`. */
  error: string | null;
  /** Re-read now, bypassing the cache. */
  refresh: () => void;
};

const NO_CAPABILITIES: ReadonlySet<Capability> = new Set();
const noop = () => {};

const BASE: Omit<RoleState, "loading" | "role" | "walletAddress" | "refresh"> = {
  stale: false,
  isSuperAdmin: false,
  isAdmin: false,
  isIssuer: false,
  isVerifiedIssuer: false,
  platformInitialized: false,
  isKycProvider: false,
  isBlocklistAuthority: false,
  kycRegistry: null,
  kycUnavailable: null,
  blocklistAuthority: null,
  pending: [],
  outgoing: [],
  capabilities: NO_CAPABILITIES,
  error: null,
};

export const INITIAL_ROLE_STATE: RoleState = {
  ...BASE,
  loading: true,
  role: "disconnected",
  walletAddress: null,
  refresh: noop,
};

/** The store key of a wallet on a network; null while no wallet is usable. */
export function roleKeyFor(isReady: boolean, wallet: string | null, network: Network): string | null {
  return isReady && wallet ? `${network}|${wallet}` : null;
}

export type DerivedRoles = {
  flags: RoleFlags;
  result: RoleReadResult;
  withKyc: boolean;
  stale: boolean;
};

/** The flags of a ready view, derived for the wallet the view was keyed by. */
export function deriveView(view: RoleStoreView<RoleReadResult>, wallet: string | null): DerivedRoles | null {
  if (view.status !== "ready" || !wallet) return null;
  return {
    flags: deriveRoles(wallet, view.value.snapshot),
    result: view.value,
    withKyc: view.withKyc,
    stale: view.stale === true,
  };
}

/** What the provider hands every consumer. */
export type RoleStateInput = {
  isReady: boolean;
  wallet: string | null;
  view: RoleStoreView<RoleReadResult>;
  derived: DerivedRoles | null;
  refresh: () => void;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toRoleState(ctx: RoleStateInput | null, needKyc: boolean): RoleState {
  if (!ctx || !ctx.isReady) return INITIAL_ROLE_STATE;
  if (!ctx.wallet) {
    return { ...INITIAL_ROLE_STATE, loading: false, role: "disconnected", refresh: ctx.refresh };
  }
  const base = { ...BASE, walletAddress: ctx.wallet, refresh: ctx.refresh };
  if (ctx.view.status === "error") {
    // Never fall back to "public" silently: gates show the error and a retry.
    return { ...base, loading: false, role: "public", error: errorMessage(ctx.view.error) };
  }
  const d = ctx.derived;
  if (!d) return { ...base, loading: true, role: "disconnected" };
  const { flags, result } = d;
  const role: Role = flags.isSuperAdmin
    ? "superAdmin"
    : flags.isAdmin
      ? "admin"
      : result.isIssuer
        ? "issuer"
        : "public";
  const snapshot = result.snapshot;
  return {
    ...base,
    // A consumer that needs the KYC role keeps loading until a read resolved
    // it (unpinned builds scan only on demand); the other flags are already
    // final, so menus need not flicker meanwhile.
    loading: needKyc && !d.withKyc,
    stale: d.stale,
    role,
    isSuperAdmin: flags.isSuperAdmin,
    isAdmin: flags.isAdmin,
    isIssuer: result.isIssuer,
    isVerifiedIssuer: result.isVerifiedIssuer,
    platformInitialized: flags.platformInitialized,
    isKycProvider: flags.isKycProvider,
    isBlocklistAuthority: flags.isBlocklistAuthority,
    kycRegistry: snapshot.kycRegistry,
    kycUnavailable: snapshot.kycUnavailable,
    blocklistAuthority: snapshot.blocklistAuthority?.data.authority ?? null,
    pending: flags.pending,
    outgoing: flags.outgoing,
    capabilities: capabilitiesOf({ ...flags, isIssuer: result.isIssuer }),
  };
}

/**
 * The wallet holds an operator role managed on /account/roles (Super Admin,
 * KYC provider, blocklist authority): an "Access denied" screen points there.
 */
export function holdsOperatorRole(
  state: Pick<RoleState, "isSuperAdmin" | "isKycProvider" | "isBlocklistAuthority">,
): boolean {
  return state.isSuperAdmin || state.isKycProvider || state.isBlocklistAuthority;
}

// ── Gate decision (components/require-role) ────────────────────────────────

export type RequiredRole = "superAdmin" | "admin" | "issuer";

export type RoleRequirement =
  /** Ranking semantics: the role or any higher one. */
  | { role: RequiredRole; anyOf?: never }
  /** Any one of these capabilities (operator roles do not rank). */
  | { role?: never; anyOf: readonly Capability[] };

const RANK: Record<Role, number> = {
  disconnected: -1,
  public: 0,
  issuer: 1,
  admin: 2,
  superAdmin: 3,
};

const REQUIRED: Record<RequiredRole, number> = {
  issuer: 1,
  admin: 2,
  superAdmin: 3,
};

export function meetsRequirement(state: RoleState, requirement: RoleRequirement): boolean {
  return requirement.anyOf
    ? requirement.anyOf.some((c) => state.capabilities.has(c))
    : RANK[state.role] >= REQUIRED[requirement.role];
}

export type GateOutcome = "loading" | "disconnected" | "error" | "denied" | "allowed";

/** A decision a gate instance made on a fresh (non-stale) read. */
export type GateDecision = {
  wallet: string;
  requirement: string;
  outcome: "allowed" | "denied";
};

export function requirementKey(requirement: RoleRequirement): string {
  return requirement.anyOf ? `anyOf:${requirement.anyOf.join(",")}` : `role:${requirement.role}`;
}

/**
 * The gate's decision. `last` is this gate instance's last decision on a
 * fresh read. While the roles are stale (right after a role change, until
 * the re-read lands) the gate keeps that decision when the stale value
 * agrees with it for the same wallet and requirement, so an open page keeps
 * its local state. A stale value never makes a new decision: without a
 * matching previous one the gate shows the loading state.
 */
export function gateOutcome(
  state: RoleState,
  requirement: RoleRequirement,
  last: GateDecision | null = null,
): GateOutcome {
  if (state.loading) return "loading";
  if (state.role === "disconnected") return "disconnected";
  if (state.error) return "error";
  const outcome = meetsRequirement(state, requirement) ? "allowed" : "denied";
  if (state.stale) {
    const kept =
      last !== null &&
      last.wallet === state.walletAddress &&
      last.requirement === requirementKey(requirement) &&
      last.outcome === outcome;
    return kept ? outcome : "loading";
  }
  return outcome;
}
