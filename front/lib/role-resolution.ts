// Which on-chain operational roles a wallet holds (Talas 3.1).
//
// Pure on purpose: no React, no "use client", no lib/siws-client import. The
// browser role provider (lib/auth.ts), the node tests and the 3.3 CLI all use
// the same reads and the same derivation.
//
// Roles, each read from its own on-chain source and never implied by another:
//   * superAdmin          — `Platform.admin`
//   * admin               — the super admin, or a live `Admin` record
//                           (["admin", wallet], owned by asset_registry,
//                           `data.admin === wallet`); mirrors
//                           lib/server/admin-gate.ts
//   * kycProvider         — the live `KycRegistry.authority` of the platform
//                           registry (the pin, or the unpinned heuristic of
//                           lib/kyc-authority); false whenever the registry is
//                           unresolved, ambiguous or a missing pin
//   * blocklistAuthority  — transfer_hook `BlocklistAuthority.authority`
//   * issuer              — the Supabase indexer / chain fallback; resolved by
//                           lib/auth.ts, not here
//
// The UI gate is only a hint: every privileged builder re-reads authoritative
// state and the program enforces the rule. Server gates read at `finalized`;
// the UI reads at `confirmed`.
import {
  fetchEncodedAccount,
  fetchEncodedAccounts,
  type Address,
  type MaybeEncodedAccount,
  type ReadonlyUint8Array,
} from "@solana/kit";
import type { SolanaClient } from "@solana/client";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findAcceptPlatformAdminTransferPda,
  findAdminRecordPda,
  findPlatformPda,
  getAdminDecoder,
  getAdminDiscriminatorBytes,
  getAdminSize,
  getAuthorityTransferDecoder,
  getAuthorityTransferDiscriminatorBytes,
  getAuthorityTransferSize,
  getPlatformDecoder,
  getPlatformDiscriminatorBytes,
  getPlatformSize,
  type Admin,
  type AuthorityTransfer,
  type Platform,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  findBlocklistAuthorityPda,
  findTransferPda as findBlocklistTransferPda,
  getBlocklistAuthorityDecoder,
  getBlocklistAuthorityDiscriminatorBytes,
  getBlocklistAuthoritySize,
  getBlocklistAuthorityTransferDecoder,
  getBlocklistAuthorityTransferDiscriminatorBytes,
  getBlocklistAuthorityTransferSize,
  type BlocklistAuthority,
  type BlocklistAuthorityTransfer,
} from "@/lib/generated/transfer_hook";
import {
  decodeKycRegistryAccount,
  kycGates,
  kycRegistryUnavailableReason,
  loadKycAuthorityContext,
  type KycRegistryRecord,
} from "@/lib/kyc-authority";
import { kycTransferState } from "@/lib/kyc-registry-rotation";
import { findAuthorityTransferPda } from "@/lib/pdas";

export type Rpc = SolanaClient["runtime"]["rpc"];

export type Capability =
  | "superAdmin"
  | "admin"
  | "issuer"
  | "kycProvider"
  | "blocklistAuthority";

/** Human labels for gates, badges and the operator landing. */
export const CAPABILITY_LABEL: Record<Capability, string> = {
  superAdmin: "Super Admin",
  admin: "Admin",
  issuer: "Issuer",
  kycProvider: "KYC provider",
  blocklistAuthority: "Blocklist authority",
};

/** A decoded account together with its owner, as read from the chain. */
export type OwnedAccount<T> = {
  address: Address;
  programAddress: Address;
  data: T;
};

export type RoleSnapshot = {
  platform: OwnedAccount<Platform> | null;
  /** `["admin", wallet]` — decoded only when owner/discriminator/length pass. */
  adminRecord: OwnedAccount<Admin> | null;
  blocklistAuthority: OwnedAccount<BlocklistAuthority> | null;
  /** asset_registry `["authority_transfer", platform]`. */
  platformTransfer: OwnedAccount<AuthorityTransfer> | null;
  /** transfer_hook `["blocklist_authority_transfer"]`. */
  blocklistTransfer: OwnedAccount<BlocklistAuthorityTransfer> | null;
  /** The platform registry (pin, or unpinned heuristic), or null. */
  kycRegistry: KycRegistryRecord | null;
  /** `["authority_transfer", registry]` of `kycRegistry`. */
  kycTransfer: OwnedAccount<AuthorityTransfer> | null;
  /**
   * The KYC registry was looked up: always on a pinned build, only on demand
   * (`withKycScan`) on an unpinned one. False means "not evaluated" — the
   * KYC-provider role is then false (fail closed) and a consumer that needs
   * it must wait for a read with the scan.
   */
  kycResolved: boolean;
  /** Why no registry could be resolved (pin missing / invalid, ambiguous scan, scan error). */
  kycUnavailable: string | null;
};

export type PendingRoleKind = "platform" | "blocklist" | "kyc";

/** A live proposal naming this wallet as the next authority (single-account reads). */
export type PendingRole = {
  kind: PendingRoleKind;
  /** Platform PDA, BlocklistAuthority PDA or the KYC registry address. */
  target: Address;
  currentAuthority: Address;
};

/** A proposal this wallet made as the current authority. */
export type OutgoingProposal = {
  kind: PendingRoleKind;
  target: Address;
  newAuthority: Address;
  /** False for a KYC proposal that no longer matches the registry (cancel or replace it). */
  live: boolean;
};

export type RoleFlags = {
  platformInitialized: boolean;
  isSuperAdmin: boolean;
  /** Covers the super admin, like the server's requireAdmin. */
  isAdmin: boolean;
  isKycProvider: boolean;
  isBlocklistAuthority: boolean;
  pending: PendingRole[];
  outgoing: OutgoingProposal[];
};

export type ReadRoleSnapshotOptions = {
  /** The deployment's pinned KYC registry (NEXT_PUBLIC_KYC_REGISTRY), or null. */
  pinned: Address | null;
  /** Unpinned builds only: scan for the registry (30 s cached). Ignored when pinned. */
  withKycScan: boolean;
  /** "confirmed" in the UI (default); the CLI may ask for "finalized". */
  commitment?: "confirmed" | "finalized";
  /** Called first. The browser passes a cached network verifier; the CLI must pass one. */
  verifyNetwork?: () => Promise<void>;
  /** Only for the unpinned-registry message. */
  network?: string;
};

const EMPTY_SNAPSHOT: RoleSnapshot = {
  platform: null,
  adminRecord: null,
  blocklistAuthority: null,
  platformTransfer: null,
  blocklistTransfer: null,
  kycRegistry: null,
  kycTransfer: null,
  kycResolved: false,
  kycUnavailable: null,
};

function hasPrefix(data: ReadonlyUint8Array, prefix: ReadonlyUint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (data[i] !== prefix[i]) return false;
  return true;
}

/**
 * Decodes `account` only after its owner, discriminator and length are
 * checked. Anything else (absent, foreign owner, wrong discriminator, short)
 * is null: never a role.
 */
function decodeOwned<T>(
  account: MaybeEncodedAccount,
  owner: Address,
  discriminator: ReadonlyUint8Array,
  size: number,
  decoder: { decode: (bytes: ReadonlyUint8Array) => T },
): OwnedAccount<T> | null {
  if (!account.exists) return null;
  if (account.programAddress !== owner) return null;
  if (account.data.length < size || !hasPrefix(account.data, discriminator)) return null;
  try {
    return {
      address: account.address,
      programAddress: account.programAddress,
      data: decoder.decode(account.data),
    };
  } catch {
    return null;
  }
}

const decodePlatform = (a: MaybeEncodedAccount) =>
  decodeOwned(a, ASSET_REGISTRY_PROGRAM_ADDRESS, getPlatformDiscriminatorBytes(), getPlatformSize(), getPlatformDecoder());
const decodeAdmin = (a: MaybeEncodedAccount) =>
  decodeOwned(a, ASSET_REGISTRY_PROGRAM_ADDRESS, getAdminDiscriminatorBytes(), getAdminSize(), getAdminDecoder());
const decodeAuthorityTransfer = (a: MaybeEncodedAccount) =>
  decodeOwned(
    a,
    ASSET_REGISTRY_PROGRAM_ADDRESS,
    getAuthorityTransferDiscriminatorBytes(),
    getAuthorityTransferSize(),
    getAuthorityTransferDecoder(),
  );
const decodeBlocklistAuthority = (a: MaybeEncodedAccount) =>
  decodeOwned(
    a,
    TRANSFER_HOOK_PROGRAM_ADDRESS,
    getBlocklistAuthorityDiscriminatorBytes(),
    getBlocklistAuthoritySize(),
    getBlocklistAuthorityDecoder(),
  );
const decodeBlocklistTransfer = (a: MaybeEncodedAccount) =>
  decodeOwned(
    a,
    TRANSFER_HOOK_PROGRAM_ADDRESS,
    getBlocklistAuthorityTransferDiscriminatorBytes(),
    getBlocklistAuthorityTransferSize(),
    getBlocklistAuthorityTransferDecoder(),
  );

/**
 * Reads everything the role derivation needs.
 *
 * Pinned: `verifyNetwork()` first, then ONE `getMultipleAccounts` for the 7
 * accounts (Platform, the wallet's Admin record, BlocklistAuthority, the
 * platform and blocklist transfers, the pinned registry and its transfer).
 *
 * Unpinned (devnet / preview only — mainnet builds require a pin): the same
 * batch minus the registry pair; the registry is resolved only when
 * `withKycScan` is set, through the 30 s cached `loadKycAuthorityContext`
 * scan. A scan failure fails the KYC role closed (`kycUnavailable`) rather
 * than the whole read.
 *
 * Throws on an RPC or network-verification error: the caller shows an error
 * and never falls back to "public".
 */
export async function readRoleSnapshot(
  rpc: Rpc,
  wallet: Address,
  opts: ReadRoleSnapshotOptions,
): Promise<RoleSnapshot> {
  if (opts.verifyNetwork) await opts.verifyNetwork();
  const commitment = opts.commitment ?? "confirmed";
  const [platformPda] = await findPlatformPda();
  const [adminPda] = await findAdminRecordPda({ authority: wallet });
  const [blocklistAuthorityPda] = await findBlocklistAuthorityPda();
  const [platformTransferPda] = await findAcceptPlatformAdminTransferPda({ platform: platformPda });
  const [blocklistTransferPda] = await findBlocklistTransferPda();
  const addresses: Address[] = [
    platformPda,
    adminPda,
    blocklistAuthorityPda,
    platformTransferPda,
    blocklistTransferPda,
  ];
  if (opts.pinned) addresses.push(opts.pinned, await findAuthorityTransferPda(opts.pinned));

  const accounts = await fetchEncodedAccounts(
    rpc as unknown as Parameters<typeof fetchEncodedAccounts>[0],
    addresses,
    { commitment, abortSignal: AbortSignal.timeout(10_000) },
  );

  const snapshot: RoleSnapshot = {
    ...EMPTY_SNAPSHOT,
    platform: decodePlatform(accounts[0]),
    adminRecord: decodeAdmin(accounts[1]),
    blocklistAuthority: decodeBlocklistAuthority(accounts[2]),
    platformTransfer: decodeAuthorityTransfer(accounts[3]),
    blocklistTransfer: decodeBlocklistTransfer(accounts[4]),
  };

  if (opts.pinned) {
    snapshot.kycResolved = true;
    try {
      snapshot.kycRegistry = decodeKycRegistryAccount(accounts[5]);
    } catch (err) {
      snapshot.kycUnavailable = err instanceof Error ? err.message : String(err);
      return snapshot;
    }
    if (!snapshot.kycRegistry) {
      snapshot.kycUnavailable = `Pinned KYC registry ${opts.pinned} not found on ${opts.network ?? "this network"} — check NEXT_PUBLIC_KYC_REGISTRY.`;
      return snapshot;
    }
    snapshot.kycTransfer = decodeAuthorityTransfer(accounts[6]);
    return snapshot;
  }

  if (!opts.withKycScan) return snapshot;

  snapshot.kycResolved = true;
  try {
    const ctx = await loadKycAuthorityContext(rpc, { pinned: null });
    snapshot.kycRegistry = ctx.registry;
    snapshot.kycUnavailable = kycRegistryUnavailableReason(ctx, opts.network ?? "this network");
    if (ctx.registry) {
      const transfer = await fetchEncodedAccount(
        rpc as unknown as Parameters<typeof fetchEncodedAccount>[0],
        await findAuthorityTransferPda(ctx.registry.address),
        { commitment, abortSignal: AbortSignal.timeout(10_000) },
      );
      snapshot.kycTransfer = decodeAuthorityTransfer(transfer);
    }
  } catch (err) {
    snapshot.kycRegistry = null;
    snapshot.kycTransfer = null;
    snapshot.kycUnavailable = `Could not load the KYC registry: ${err instanceof Error ? err.message : String(err)}`;
  }
  return snapshot;
}

/** Pure: the wallet's roles from one snapshot. Mirrors the server gates. */
export function deriveRoles(wallet: Address | string, s: RoleSnapshot): RoleFlags {
  const w = wallet.toString();
  const platform =
    s.platform && s.platform.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS ? s.platform : null;
  const platformAdmin = platform ? platform.data.admin.toString() : null;

  const isSuperAdmin = platformAdmin !== null && platformAdmin === w;
  // lib/server/admin-gate.ts: the Admin record counts only on an initialised
  // platform, when owned by asset_registry and naming this wallet.
  const adminRecordValid =
    platform !== null &&
    s.adminRecord !== null &&
    s.adminRecord.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS &&
    s.adminRecord.data.admin.toString() === w;
  const isAdmin = isSuperAdmin || adminRecordValid;

  const ba =
    s.blocklistAuthority && s.blocklistAuthority.programAddress === TRANSFER_HOOK_PROGRAM_ADDRESS
      ? s.blocklistAuthority
      : null;
  const baAuthority = ba ? ba.data.authority.toString() : null;
  const isBlocklistAuthority = baAuthority !== null && baAuthority === w;

  const registryAuthority = s.kycRegistry ? s.kycRegistry.registry.authority.toString() : null;
  const isKycProvider = kycGates(w, registryAuthority, platformAdmin).isKycProvider;

  const pending: PendingRole[] = [];
  const outgoing: OutgoingProposal[] = [];

  // Platform: accept_platform_admin requires current = proposed_by = Platform.admin
  // (rotate_authority.rs) and the transfer to target the Platform PDA.
  const pt =
    s.platformTransfer && s.platformTransfer.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS
      ? s.platformTransfer.data
      : null;
  if (platform && pt && pt.target === platform.address) {
    const live = pt.currentAuthority === platform.data.admin && pt.proposedBy === platform.data.admin;
    if (live && pt.newAuthority.toString() === w) {
      pending.push({ kind: "platform", target: platform.address, currentAuthority: platform.data.admin });
    }
    if (live && isSuperAdmin) {
      outgoing.push({ kind: "platform", target: platform.address, newAuthority: pt.newAuthority, live: true });
    }
  }

  // Blocklist: accept requires transfer.current_authority === BA.authority.
  const bt =
    s.blocklistTransfer && s.blocklistTransfer.programAddress === TRANSFER_HOOK_PROGRAM_ADDRESS
      ? s.blocklistTransfer.data
      : null;
  if (ba && bt && bt.currentAuthority === ba.data.authority) {
    if (bt.newAuthority.toString() === w) {
      pending.push({ kind: "blocklist", target: ba.address, currentAuthority: ba.data.authority });
    }
    if (isBlocklistAuthority) {
      outgoing.push({ kind: "blocklist", target: ba.address, newAuthority: bt.newAuthority, live: true });
    }
  }

  // KYC registry: exactly the accept check of kyc-registry-rotation.
  const kt =
    s.kycTransfer && s.kycTransfer.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS
      ? s.kycTransfer.data
      : null;
  if (s.kycRegistry && kt && registryAuthority) {
    const state = kycTransferState(s.kycRegistry.address.toString(), registryAuthority, {
      target: kt.target.toString(),
      currentAuthority: kt.currentAuthority.toString(),
      newAuthority: kt.newAuthority.toString(),
      proposedBy: kt.proposedBy.toString(),
    });
    if (state.kind === "live" && state.newAuthority === w) {
      pending.push({
        kind: "kyc",
        target: s.kycRegistry.address,
        currentAuthority: s.kycRegistry.registry.authority,
      });
    }
    if (state.kind !== "none" && isKycProvider) {
      outgoing.push({
        kind: "kyc",
        target: s.kycRegistry.address,
        newAuthority: kt.newAuthority,
        live: state.kind === "live",
      });
    }
  }

  return {
    platformInitialized: platform !== null,
    isSuperAdmin,
    isAdmin,
    isKycProvider,
    isBlocklistAuthority,
    pending,
    outgoing,
  };
}

export function capabilitiesOf(
  f: Pick<RoleFlags, "isSuperAdmin" | "isAdmin" | "isKycProvider" | "isBlocklistAuthority"> & {
    isIssuer?: boolean;
  },
): ReadonlySet<Capability> {
  const caps = new Set<Capability>();
  if (f.isSuperAdmin) caps.add("superAdmin");
  if (f.isAdmin || f.isSuperAdmin) caps.add("admin");
  if (f.isIssuer) caps.add("issuer");
  if (f.isKycProvider) caps.add("kycProvider");
  if (f.isBlocklistAuthority) caps.add("blocklistAuthority");
  return caps;
}

// ── Server refusals right after a rotation ──────────────────────────────────

/** The UI reads roles at `confirmed`, the server gates at `finalized`. */
export const ROLE_NOT_FINALIZED_HINT = "Role change not finalized yet — retry in about 30 s.";

/** A server gate refused the caller's role (admin / KYC-provider 403). */
export function isRoleRefusal(message: string): boolean {
  return /privileges required/i.test(message);
}

/**
 * Error copy for a signed read on a role-gated page: a refusal of a role the
 * UI already shows is most likely a rotation that is confirmed but not yet
 * finalized.
 */
export function explainRoleRefusal(message: string): string {
  return isRoleRefusal(message) ? `${message}. ${ROLE_NOT_FINALIZED_HINT}` : message;
}

// ── Admin area access (default deny, whole path segments) ───────────────────

export type AdminRouteRule = {
  /** A path under /admin. Matches itself and, unless `exact`, its sub-paths. */
  match: string;
  exact?: boolean;
  /** Any one of these capabilities opens the path. */
  anyOf: readonly Capability[];
};

/** Every /admin path not listed below. */
export const ADMIN_ROUTE_DEFAULT: readonly Capability[] = ["admin"];

/**
 * The /admin paths an operator role may open. Anything else is admin-only.
 * Each role is widened in its own slice together with its safety changes.
 */
export const ADMIN_ROUTE_ACCESS: readonly AdminRouteRule[] = [
  // The overview; an operator without an Admin record lands on OperatorLanding.
  { match: "/admin", exact: true, anyOf: ["admin", "kycProvider", "blocklistAuthority"] },
  // K6: the KYC provider triages the queue and the dossiers. Its routes are
  // requireAdminOrKycProvider; AML evidence and admin-only actions are not.
  { match: "/admin/kyc", anyOf: ["admin", "kycProvider"] },
  { match: "/admin/clients", anyOf: ["admin", "kycProvider"] },
  // K7/K8: the blocklist authority changes entries and the transfer-hook
  // mode (both re-checked against the finalized BlocklistAuthority by the
  // builders, and enforced by the hook). No server route is widened.
  { match: "/admin/blocklist", anyOf: ["admin", "blocklistAuthority"] },
  { match: "/admin/share-classes", anyOf: ["admin", "blocklistAuthority"] },
];

function normalizePath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0];
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function ruleMatches(rule: AdminRouteRule, path: string): boolean {
  if (path === rule.match) return true;
  return !rule.exact && path.startsWith(`${rule.match}/`);
}

/**
 * The capabilities that open `pathname`: the most specific matching rule
 * (whole segments only — `/admin/kycx` never matches `/admin/kyc`), or the
 * admin-only default.
 */
export function adminRouteRequirement(
  pathname: string,
  table: readonly AdminRouteRule[] = ADMIN_ROUTE_ACCESS,
): readonly Capability[] {
  const path = normalizePath(pathname);
  let best: AdminRouteRule | null = null;
  for (const rule of table) {
    if (ruleMatches(rule, path) && (!best || rule.match.length > best.match.length)) best = rule;
  }
  return best ? best.anyOf : ADMIN_ROUTE_DEFAULT;
}

export function adminRouteAllows(
  pathname: string,
  caps: ReadonlySet<Capability>,
  table: readonly AdminRouteRule[] = ADMIN_ROUTE_ACCESS,
): boolean {
  return adminRouteRequirement(pathname, table).some((c) => caps.has(c));
}
