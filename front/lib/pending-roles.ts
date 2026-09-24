// Everything staged for a wallet to accept (Talas 3.1 §4, /account/roles).
//
// Pure on purpose (no React, no lib/siws-client): the /account/roles page, the
// node tests and the 3.3 CLI share it. It generalizes the issuer-only
// `findPendingForWallet` of lib/issuer-authority (which stays as it is for
// /issuer/rotation):
//
// * the same two getProgramAccounts scans — `AuthorityTransfer` and
//   `IssuerRecovery`, both with a memcmp on `new_authority` at offset 72;
// * then ONE batched account read (getMultipleAccounts, chunked at the RPC's
//   100-account limit) for the singletons (Platform, BlocklistAuthority and
//   its transfer, the platform transfer, the platform KYC registry and its
//   transfer, the wallet's Admin record), every transfer target, and the
//   Admin records of every issuer's staged-from key.
//
// A transfer counts only when its address IS `["authority_transfer",
// target]` and every account passes its owner / discriminator / length
// check; anything else is ignored. The singletons are read directly, so a
// failed scan still reports the platform, blocklist and platform-registry
// proposals (`scanError` says what is missing).
//
// Which proposals count, and when each can be accepted, mirrors the program:
//
// | kind           | live when                                          | counted |
// |----------------|----------------------------------------------------|---------|
// | platform       | current = proposed_by = Platform.admin             | yes     |
// | blocklist      | current = BlocklistAuthority.authority             | yes     |
// | kyc            | kycTransferState (current = proposed_by = authority)| platform registry only |
// | custody        | current = vault.authority, proposed_by = Platform.admin, Active/Triggered, acceptor is an Admin | yes |
// | issuer         | issuerTransferState, and NOT (wallet is an Admin key while the old key is not) | never |
// | issuerRecovery | issuerRecoveryState, and the wallet is not an Admin key | never |
//
// Issuer rows are never counted: anyone can register an issuer and stage a
// rotation or recovery to any wallet, so they are not platform roles.
import {
  fetchEncodedAccounts,
  getBase64Encoder,
  type Address,
  type Instruction,
  type MaybeEncodedAccount,
  type TransactionSigner,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  KybStatus,
  VaultState,
  fetchMaybeAuthorityTransfer,
  findAcceptPlatformAdminTransferPda,
  findAdminRecordPda,
  findPlatformPda,
  getAcceptKycRegistryAuthorityInstructionAsync,
  getAdminDecoder,
  getAdminDiscriminatorBytes,
  getAdminSize,
  getAuthorityTransferDecoder,
  getAuthorityTransferDiscriminatorBytes,
  getAuthorityTransferSize,
  getCancelKycRegistryAuthorityTransferInstructionAsync,
  getCustodyVaultDecoder,
  getCustodyVaultDiscriminatorBytes,
  getCustodyVaultSize,
  getIssuerDecoder,
  getIssuerDiscriminatorBytes,
  getIssuerRecoveryDecoder,
  getIssuerRecoveryDiscriminatorBytes,
  getIssuerRecoverySize,
  getIssuerSize,
  getKycRegistryDecoder,
  getKycRegistryDiscriminatorBytes,
  getKycRegistrySize,
  getPlatformDecoder,
  getPlatformDiscriminatorBytes,
  getPlatformSize,
  type AuthorityTransfer,
  type IssuerRecovery,
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
} from "@/lib/generated/transfer_hook";
import {
  describeRecoveryState,
  fetchChainNow,
  findIssuerRecoveryPda,
  issuerRecoveryState,
  issuerTransferState,
  pendingForWalletFilters,
  toIssuerRecoveryRecord,
  toPendingIssuerTransfer,
  type IssuerRecoveryState,
} from "@/lib/issuer-authority";
import { kycTransferState } from "@/lib/kyc-registry-rotation";
import { fetchKycRegistryAt } from "@/lib/kyc-authority";
import {
  buildCustodyAuthorityChange,
  custodyAcceptBlocker,
} from "@/lib/custody-authority";
import { PROPOSAL_NOT_FINALIZED_HINT, buildAcceptOperationalAuthority } from "@/lib/operational-authority";
import { findAuthorityTransferPda } from "@/lib/pdas";
import { decodeOwned, type OwnedAccount, type Rpc } from "@/lib/role-resolution";

export type PendingRoleRowKind =
  | "platform"
  | "blocklist"
  | "kyc"
  | "custody"
  | "issuer"
  | "issuerRecovery";

type RowBase = {
  /** Platform, BlocklistAuthority, KycRegistry, CustodyVault or Issuer account. */
  target: Address;
  /** Who holds the role now (the key the proposal moves it away from). */
  currentAuthority: Address;
  /** Who staged it. */
  proposedBy: Address;
  /** Counted in the "Pending roles (N)" badge (never for issuer rows). */
  counted: boolean;
  /**
   * Why this wallet cannot accept / execute it now, or null. The UI then
   * shows this instead of the button.
   */
  blocked: string | null;
};

export type PendingRoleRow =
  | (RowBase & { kind: "platform" })
  | (RowBase & { kind: "blocklist" })
  /** `platformRegistry` false: a registry that is NOT the platform's (flagged, never counted). */
  | (RowBase & { kind: "kyc"; platformRegistry: boolean })
  | (RowBase & { kind: "custody"; vaultState: VaultState })
  | (RowBase & { kind: "issuer"; kybStatus: KybStatus })
  | (RowBase & {
      kind: "issuerRecovery";
      kybStatus: KybStatus;
      recovery: IssuerRecoveryState;
    });

export type PendingRoles = {
  rows: PendingRoleRow[];
  /**
   * The program scans failed: only the directly read proposals (platform,
   * blocklist, platform registry) are in `rows`.
   */
  scanError: string | null;
};

export type PendingRolesOptions = {
  /**
   * The platform KYC registry: the pin, or the unpinned heuristic's registry
   * (useRole({ kyc: true }).kycRegistry). Its proposal is read directly and
   * counted; any other registry is flagged "not the platform registry".
   */
  platformRegistry: Address | null;
  /** "confirmed" in the UI (default); the CLI may ask for "finalized". */
  commitment?: "confirmed" | "finalized";
  /** Called first. The browser passes a cached network verifier; the CLI must pass one. */
  verifyNetwork?: () => Promise<void>;
  /** Chain time (unix s) for recovery windows; defaults to `fetchChainNow`, read only when a recovery is found. */
  chainNow?: () => Promise<number>;
};

/** getMultipleAccounts accepts at most 100 addresses per call. */
export const MAX_ACCOUNTS_PER_READ = 100;

const KIND_ORDER: Record<PendingRoleRowKind, number> = {
  platform: 0,
  blocklist: 1,
  kyc: 2,
  custody: 3,
  issuer: 4,
  issuerRecovery: 5,
};

export const ISSUER_ADMIN_KEY_RULE =
  "This wallet is a Manci admin key. An issuer key can move onto an admin key only from another admin key, so accepting would fail. Ask the issuer to propose a wallet without the admin role.";
export const RECOVERY_ADMIN_KEY_RULE =
  "This wallet is a Manci admin key, and an issuer recovery never lands on one. Ask the Super Admin to propose a wallet without the admin role.";

/** Rows in the "Pending roles (N)" badge: live platform roles only. */
export function pendingBadgeCount(rows: readonly PendingRoleRow[]): number {
  return rows.filter((r) => r.counted).length;
}

type Bytes = { readonly length: number; readonly [index: number]: number };

function hasPrefix(bytes: Bytes, prefix: Bytes): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (bytes[i] !== prefix[i]) return false;
  return true;
}

type Scanned = { address: Address; owner: Address; bytes: Uint8Array };

async function scanNewAuthority(
  rpc: Rpc,
  discriminator: Bytes,
  wallet: Address,
  commitment: "confirmed" | "finalized",
): Promise<Scanned[]> {
  const records = await rpc
    .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, {
      commitment,
      encoding: "base64",
      filters: pendingForWalletFilters(discriminator, wallet),
    })
    .send({ abortSignal: AbortSignal.timeout(10_000) });
  const base64 = getBase64Encoder();
  return records.map((r) => ({
    address: r.pubkey,
    owner: r.account.owner,
    bytes: Uint8Array.from(base64.encode(r.account.data[0])),
  }));
}

function decodeScanned<T>(
  record: Scanned,
  discriminator: Bytes,
  size: number,
  decode: (bytes: Uint8Array) => T,
): T | null {
  if (record.owner !== ASSET_REGISTRY_PROGRAM_ADDRESS) return null;
  if (record.bytes.length < size || !hasPrefix(record.bytes, discriminator)) return null;
  try {
    return decode(record.bytes);
  } catch {
    return null;
  }
}

async function readAccounts(
  rpc: Rpc,
  addresses: readonly Address[],
  commitment: "confirmed" | "finalized",
): Promise<Map<string, MaybeEncodedAccount>> {
  const out = new Map<string, MaybeEncodedAccount>();
  for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_READ) {
    const chunk = addresses.slice(i, i + MAX_ACCOUNTS_PER_READ);
    const accounts = await fetchEncodedAccounts(
      rpc as unknown as Parameters<typeof fetchEncodedAccounts>[0],
      chunk,
      { commitment, abortSignal: AbortSignal.timeout(10_000) },
    );
    chunk.forEach((a, j) => out.set(a, accounts[j]));
  }
  return out;
}

const REGISTRY = ASSET_REGISTRY_PROGRAM_ADDRESS;

/**
 * Every proposal naming `wallet` as the next authority, classified by its
 * target (see the table at the top). Throws only when the batched account
 * read (or the network check) fails; a failed scan is reported in
 * `scanError` next to the directly read proposals.
 */
export async function findPendingRolesForWallet(
  rpc: Rpc,
  wallet: Address,
  opts: PendingRolesOptions,
): Promise<PendingRoles> {
  if (opts.verifyNetwork) await opts.verifyNetwork();
  const commitment = opts.commitment ?? "confirmed";

  // 1. The two scans (lazy by nature: only this page and /issuer/rotation run them).
  const transferDisc = getAuthorityTransferDiscriminatorBytes();
  const recoveryDisc = getIssuerRecoveryDiscriminatorBytes();
  let scanError: string | null = null;
  const transfers = new Map<string, AuthorityTransfer>();
  const recoveries = new Map<string, IssuerRecovery>();
  try {
    const [t, r] = await Promise.all([
      scanNewAuthority(rpc, transferDisc, wallet, commitment),
      scanNewAuthority(rpc, recoveryDisc, wallet, commitment),
    ]);
    for (const record of t) {
      const transfer = decodeScanned(record, transferDisc, getAuthorityTransferSize(), (b) =>
        getAuthorityTransferDecoder().decode(b),
      );
      if (!transfer || transfer.newAuthority !== wallet) continue;
      if (record.address !== (await findAuthorityTransferPda(transfer.target))) continue;
      transfers.set(record.address, transfer);
    }
    for (const record of r) {
      const recovery = decodeScanned(record, recoveryDisc, getIssuerRecoverySize(), (b) =>
        getIssuerRecoveryDecoder().decode(b),
      );
      if (!recovery || recovery.newAuthority !== wallet) continue;
      if (record.address !== (await findIssuerRecoveryPda(recovery.issuer))) continue;
      recoveries.set(record.address, recovery);
    }
  } catch (err) {
    transfers.clear();
    recoveries.clear();
    scanError = `Could not scan for proposals: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 2. One batched read: the singletons, every target and the Admin records.
  const [platformPda] = await findPlatformPda();
  const [platformTransferPda] = await findAcceptPlatformAdminTransferPda({ platform: platformPda });
  const [baPda] = await findBlocklistAuthorityPda();
  const [blocklistTransferPda] = await findBlocklistTransferPda();
  const [walletAdminPda] = await findAdminRecordPda({ authority: wallet });
  const registryTransferPda = opts.platformRegistry
    ? await findAuthorityTransferPda(opts.platformRegistry)
    : null;
  const wanted = new Set<Address>([
    platformPda,
    platformTransferPda,
    baPda,
    blocklistTransferPda,
    walletAdminPda,
  ]);
  if (opts.platformRegistry && registryTransferPda) {
    wanted.add(opts.platformRegistry);
    wanted.add(registryTransferPda);
  }
  // Admin PDA of each transfer's staged-from key (the issuer Admin-key rule).
  const adminOf = new Map<string, Address>();
  for (const t of transfers.values()) {
    wanted.add(t.target);
    if (!adminOf.has(t.currentAuthority)) {
      adminOf.set(t.currentAuthority, (await findAdminRecordPda({ authority: t.currentAuthority }))[0]);
    }
  }
  for (const pda of adminOf.values()) wanted.add(pda);
  for (const r of recoveries.values()) wanted.add(r.issuer);
  const accounts = await readAccounts(rpc, [...wanted], commitment);
  const get = (a: Address) => accounts.get(a) ?? ({ exists: false, address: a } as MaybeEncodedAccount);

  const platform = decodeOwned(
    get(platformPda),
    REGISTRY,
    getPlatformDiscriminatorBytes(),
    getPlatformSize(),
    getPlatformDecoder(),
  );
  const platformAdmin = platform ? platform.data.admin : null;
  const isActiveAdmin = (key: Address, pda: Address | undefined) => {
    if (!pda) return false;
    const record = decodeOwned(get(pda), REGISTRY, getAdminDiscriminatorBytes(), getAdminSize(), getAdminDecoder());
    return platform !== null && record !== null && record.data.admin === key;
  };
  const walletIsAdmin = isActiveAdmin(wallet, walletAdminPda);

  // The directly read proposals join the scanned ones (same checks).
  for (const pda of [platformTransferPda, registryTransferPda]) {
    if (!pda || transfers.has(pda)) continue;
    const t = decodeOwned(
      get(pda),
      REGISTRY,
      getAuthorityTransferDiscriminatorBytes(),
      getAuthorityTransferSize(),
      getAuthorityTransferDecoder(),
    );
    if (!t || t.data.newAuthority !== wallet) continue;
    if (pda !== (await findAuthorityTransferPda(t.data.target))) continue;
    transfers.set(pda, t.data);
  }

  const rows: PendingRoleRow[] = [];

  // Blocklist: the transfer_hook singleton pair.
  const ba = decodeOwned(
    get(baPda),
    TRANSFER_HOOK_PROGRAM_ADDRESS,
    getBlocklistAuthorityDiscriminatorBytes(),
    getBlocklistAuthoritySize(),
    getBlocklistAuthorityDecoder(),
  );
  const bt = decodeOwned(
    get(blocklistTransferPda),
    TRANSFER_HOOK_PROGRAM_ADDRESS,
    getBlocklistAuthorityTransferDiscriminatorBytes(),
    getBlocklistAuthorityTransferSize(),
    getBlocklistAuthorityTransferDecoder(),
  );
  if (ba && bt && bt.data.newAuthority === wallet && bt.data.currentAuthority === ba.data.authority) {
    rows.push({
      kind: "blocklist",
      target: baPda,
      currentAuthority: ba.data.authority,
      proposedBy: ba.data.authority,
      counted: true,
      blocked: null,
    });
  }

  for (const t of transfers.values()) {
    const row = classifyTransfer(t, {
      target: get(t.target),
      platformPda,
      platform,
      platformRegistry: opts.platformRegistry,
      walletIsAdmin,
      oldKeyIsAdmin: () => isActiveAdmin(t.currentAuthority, adminOf.get(t.currentAuthority)),
    });
    if (row) rows.push(row);
  }

  if (recoveries.size > 0) {
    let now: number | null = null;
    for (const r of recoveries.values()) {
      const issuer = decodeOwned(
        get(r.issuer),
        REGISTRY,
        getIssuerDiscriminatorBytes(),
        getIssuerSize(),
        getIssuerDecoder(),
      );
      if (!issuer) continue;
      if (now === null) now = opts.chainNow ? await opts.chainNow() : (await fetchChainNow(rpc)).now;
      const state = issuerRecoveryState(
        toIssuerRecoveryRecord(r),
        { address: r.issuer, authority: issuer.data.authority },
        platformAdmin,
        now,
      );
      if (state.kind === "none") continue;
      rows.push({
        kind: "issuerRecovery",
        target: r.issuer,
        currentAuthority: issuer.data.authority,
        proposedBy: r.proposedBy,
        counted: false,
        blocked: walletIsAdmin
          ? RECOVERY_ADMIN_KEY_RULE
          : state.kind === "executable"
            ? null
            : describeRecoveryState(state),
        kybStatus: issuer.data.kybStatus,
        recovery: state,
      });
    }
  }

  // By kind; within a kind the counted rows (e.g. the platform registry) first.
  rows.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      Number(b.counted) - Number(a.counted) ||
      a.target.toString().localeCompare(b.target.toString()),
  );
  return { rows, scanError };
}

function classifyTransfer(
  t: AuthorityTransfer,
  ctx: {
    target: MaybeEncodedAccount;
    platformPda: Address;
    platform: OwnedAccount<{ admin: Address }> | null;
    platformRegistry: Address | null;
    walletIsAdmin: boolean;
    oldKeyIsAdmin: () => boolean;
  },
): PendingRoleRow | null {
  const base = { target: t.target, currentAuthority: t.currentAuthority, proposedBy: t.proposedBy };

  // Platform: accept_platform_admin (current = proposed_by = Platform.admin).
  if (t.target === ctx.platformPda) {
    const admin = ctx.platform?.data.admin;
    if (!admin || t.currentAuthority !== admin || t.proposedBy !== admin) return null;
    return { kind: "platform", ...base, counted: true, blocked: null };
  }

  const registry = decodeOwned(
    ctx.target,
    REGISTRY,
    getKycRegistryDiscriminatorBytes(),
    getKycRegistrySize(),
    getKycRegistryDecoder(),
  );
  if (registry) {
    const state = kycTransferState(t.target, registry.data.authority, toPendingIssuerTransfer(t));
    if (state.kind === "none") return null;
    const platformRegistry = ctx.platformRegistry !== null && t.target === ctx.platformRegistry;
    return {
      kind: "kyc",
      ...base,
      currentAuthority: registry.data.authority,
      platformRegistry,
      counted: state.kind === "live" && platformRegistry,
      blocked:
        state.kind === "live"
          ? null
          : "Stale: proposed under a previous registry authority, so it can no longer be accepted. The current authority can cancel it or propose again.",
    };
  }

  const vault = decodeOwned(
    ctx.target,
    REGISTRY,
    getCustodyVaultDiscriminatorBytes(),
    getCustodyVaultSize(),
    getCustodyVaultDecoder(),
  );
  if (vault) {
    const stale =
      ctx.platform === null ||
      t.currentAuthority !== vault.data.authority ||
      t.proposedBy !== ctx.platform.data.admin;
    const blocked = custodyAcceptBlocker({
      stale,
      vaultState: vault.data.state,
      acceptorIsAdmin: ctx.walletIsAdmin,
    });
    return {
      kind: "custody",
      ...base,
      currentAuthority: vault.data.authority,
      vaultState: vault.data.state,
      counted: blocked === null,
      blocked,
    };
  }

  const issuer = decodeOwned(
    ctx.target,
    REGISTRY,
    getIssuerDiscriminatorBytes(),
    getIssuerSize(),
    getIssuerDecoder(),
  );
  if (issuer) {
    const state = issuerTransferState(t.target, issuer.data.authority, toPendingIssuerTransfer(t));
    if (state.kind === "none") return null;
    // accept_issuer_authority: an issuer key moves onto an Admin key only
    // from an Admin key (the staged-from key IS the live authority when live).
    const blocked =
      state.kind === "stale"
        ? "Stale: the issuer key changed after this proposal, so it can no longer be accepted. The issuer can cancel it or propose again."
        : ctx.walletIsAdmin && !ctx.oldKeyIsAdmin()
          ? ISSUER_ADMIN_KEY_RULE
          : null;
    return {
      kind: "issuer",
      ...base,
      currentAuthority: issuer.data.authority,
      kybStatus: issuer.data.kybStatus,
      counted: false,
      blocked,
    };
  }
  return null; // Foreign or unknown target: never a role.
}

// ── Builders (each re-reads the authoritative state) ────────────────────────

async function liveKycProposal(rpc: Rpc, registry: Address) {
  const record = await fetchKycRegistryAt(rpc, registry, "finalized");
  if (!record) throw new Error(`KYC registry ${registry} not found`);
  const transferPda = await findAuthorityTransferPda(registry);
  const transfer = await fetchMaybeAuthorityTransfer(rpc, transferPda, {
    commitment: "finalized",
    abortSignal: AbortSignal.timeout(10_000),
  });
  const pending =
    transfer.exists && transfer.programAddress === REGISTRY && transfer.data.target === registry
      ? toPendingIssuerTransfer(transfer.data)
      : null;
  return {
    authority: record.registry.authority,
    transferPda,
    state: kycTransferState(registry, record.registry.authority, pending),
  };
}

/**
 * `accept_kyc_registry_authority` after re-reading the registry and its
 * transfer at `finalized`: the proposal must be live and name the signer.
 */
export async function buildAcceptKycRegistryRole(
  rpc: Rpc,
  registry: Address,
  signer: TransactionSigner,
): Promise<Instruction> {
  const { state, transferPda } = await liveKycProposal(rpc, registry);
  if (state.kind !== "live" || state.newAuthority !== signer.address) {
    throw new Error(
      `No live proposal names this wallet for this KYC registry (${PROPOSAL_NOT_FINALIZED_HINT}).`,
    );
  }
  return getAcceptKycRegistryAuthorityInstructionAsync({
    newAuthority: signer,
    kycRegistry: registry,
    transfer: transferPda,
  });
}

/**
 * `cancel_kyc_registry_authority_transfer` after re-reading: the signer must
 * be the registry's live authority and a proposal must exist (live or stale).
 */
export async function buildCancelKycRegistryProposal(
  rpc: Rpc,
  registry: Address,
  signer: TransactionSigner,
): Promise<Instruction> {
  const { authority, state, transferPda } = await liveKycProposal(rpc, registry);
  if (authority !== signer.address) {
    throw new Error(`Connect the registry authority (current: ${authority}) to cancel its proposal`);
  }
  if (state.kind === "none") throw new Error("No proposal is staged for this registry");
  return getCancelKycRegistryAuthorityTransferInstructionAsync({
    authority: signer,
    kycRegistry: registry,
    transfer: transferPda,
  });
}

/**
 * The accept instruction of a platform-role row, built by the builder that
 * re-reads its authority. Issuer rows are accepted on /issuer/rotation (sync
 * bundling), never here.
 */
export async function buildAcceptPendingRole(
  rpc: Rpc,
  row: PendingRoleRow,
  signer: TransactionSigner,
): Promise<Instruction> {
  if (row.blocked) throw new Error(row.blocked);
  switch (row.kind) {
    case "platform":
    case "blocklist":
      return buildAcceptOperationalAuthority(rpc, row.kind, signer);
    case "kyc":
      return buildAcceptKycRegistryRole(rpc, row.target, signer);
    case "custody":
      return buildCustodyAuthorityChange(rpc, row.target, signer, "accept");
    default:
      throw new Error("Issuer keys are accepted on /issuer/rotation");
  }
}

/** The instruction name each accept records in the audit trail. */
export const ACCEPT_IX_NAME: Record<"platform" | "blocklist" | "kyc" | "custody", string> = {
  platform: "accept_platform_admin",
  blocklist: "accept_blocklist_authority",
  kyc: "accept_kyc_registry_authority",
  custody: "accept_custody_authority",
};

export { KybStatus, VaultState };
