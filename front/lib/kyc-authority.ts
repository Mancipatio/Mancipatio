// KYC provider vs. platform admin: two separate on-chain roles.
//
// A KycRegistry's ADDRESS is fixed at creation (`["kyc_registry", creating
// authority]`). Its `authority` rotates (propose/accept) and gates
// approve/revoke/jurisdictions. `Platform.admin` (super admin) is a different
// role. Rotating either one never moves the registry and never grants the
// other role anything, so the registry is never derived from a live key:
//
// 1. The deployment PINS it by address (`NEXT_PUBLIC_KYC_REGISTRY`, see
//    lib/kyc-registry-pin). A pin wins and is read directly, with no scan.
//    A pin that is missing on-chain is reported as `pinnedMissing` and is
//    never replaced by the heuristic (fail closed).
// 2. With no pin, the legacy heuristic scans for KycRegistry accounts and
//    picks one (see selectKycRegistry).
//
// KYC-provider actions are gated on the live `registry.authority` only.
import {
  fetchEncodedAccount,
  getBase58Decoder,
  type Address,
  type Base58EncodedBytes,
} from "@solana/kit";
import type { SolanaClient } from "@solana/client";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybePlatform,
  findPlatformPda,
  getKycRegistryDecoder,
  getKycRegistryDiscriminatorBytes,
  getKycRegistrySize,
  type KycRegistry,
} from "@/lib/generated/asset_registry";
import { configuredKycRegistry } from "@/lib/kyc-registry-pin";

type Rpc = SolanaClient["runtime"]["rpc"];

export type KycRegistryRecord = { address: Address; registry: KycRegistry };

export type KycAuthorityContext = {
  /** Current `Platform.admin`, or null when the platform is not initialised. */
  platformAdmin: Address | null;
  /** The live KYC registry, or null when none exists / none can be chosen. */
  registry: KycRegistryRecord | null;
  /** Every registry found on-chain (normally 0 or 1; only the pin when pinned). */
  registries: KycRegistryRecord[];
  /** True when more than one registry exists and none could be selected. */
  ambiguous: boolean;
  /** The configured `NEXT_PUBLIC_KYC_REGISTRY` pin, or null when unset. */
  pinned: Address | null;
  /** A pin is configured but no KycRegistry exists at it on this network. */
  pinnedMissing: boolean;
};

export type KycRegistrySelection = {
  registry: KycRegistryRecord | null;
  ambiguous: boolean;
  pinnedMissing: boolean;
};

/**
 * Picks the live registry from the on-chain set.
 *
 * With a PIN (`NEXT_PUBLIC_KYC_REGISTRY`), this returns the registry at that
 * address, or `pinnedMissing` when it is absent. It never falls back to the
 * heuristic.
 *
 * Without a pin (legacy heuristic), the preference order is:
 * 1. the registry whose authority is the current platform admin (bootstrap
 *    case: provider and admin are the same key);
 * 2. the only registry that exists (post-rotation case);
 * 3. otherwise the choice is ambiguous and the UI must say so.
 *
 * The heuristic has known limits. The program also allows issuer-specific,
 * stricter registries (`create_kyc_registry` doc, `Asset.extra_kyc_registry`),
 * each co-signed by an admin, and a rotated registry no longer matches any
 * seed. Every deployment should pin the platform registry.
 */
export function selectKycRegistry(
  registries: readonly KycRegistryRecord[],
  platformAdmin: Address | string | null,
  pinned: Address | string | null = null,
): KycRegistrySelection {
  if (pinned !== null) {
    const hit = registries.find((r) => r.address.toString() === pinned.toString());
    return hit
      ? { registry: hit, ambiguous: false, pinnedMissing: false }
      : { registry: null, ambiguous: false, pinnedMissing: true };
  }
  if (registries.length === 0) return { registry: null, ambiguous: false, pinnedMissing: false };
  const admin = platformAdmin?.toString() ?? null;
  const byAdmin = registries.find((r) => r.registry.authority.toString() === admin);
  if (byAdmin) return { registry: byAdmin, ambiguous: false, pinnedMissing: false };
  if (registries.length === 1) {
    return { registry: registries[0], ambiguous: false, pinnedMissing: false };
  }
  return { registry: null, ambiguous: true, pinnedMissing: false };
}

/**
 * Why no registry could be resolved, for operator-facing copy: a configured
 * pin that is absent on this network (fix the pin, do NOT create a registry),
 * or several registries with no pin. Null when there is simply no registry
 * yet (or one was resolved).
 */
export function kycRegistryUnavailableReason(
  ctx: Pick<KycAuthorityContext, "registry" | "pinned" | "pinnedMissing" | "ambiguous" | "registries">,
  network: string,
): string | null {
  if (ctx.registry) return null;
  if (ctx.pinnedMissing && ctx.pinned) {
    return `Pinned KYC registry ${ctx.pinned} not found on ${network} — check NEXT_PUBLIC_KYC_REGISTRY.`;
  }
  if (ctx.ambiguous) {
    return `${ctx.registries.length} KYC registries exist and none could be selected — pin the platform registry with NEXT_PUBLIC_KYC_REGISTRY.`;
  }
  return null;
}

export type KycGates = {
  /** Wallet equals the live `KycRegistry.authority` → may issue/revoke passports. */
  isKycProvider: boolean;
  /** Wallet equals `Platform.admin` → may run platform-admin actions. */
  isPlatformAdmin: boolean;
  /** Registry authority and platform admin are the same key (pre-rotation). */
  providerIsPlatformAdmin: boolean;
};

/** Pure gate derivation; the two roles never imply each other. */
export function kycGates(
  wallet: Address | string | null | undefined,
  registryAuthority: Address | string | null | undefined,
  platformAdmin: Address | string | null | undefined,
): KycGates {
  const w = wallet ? wallet.toString() : null;
  const ra = registryAuthority ? registryAuthority.toString() : null;
  const pa = platformAdmin ? platformAdmin.toString() : null;
  return {
    isKycProvider: w !== null && ra !== null && w === ra,
    isPlatformAdmin: w !== null && pa !== null && w === pa,
    providerIsPlatformAdmin: ra !== null && pa !== null && ra === pa,
  };
}

/** Scan the program for every KycRegistry account. */
export async function listKycRegistries(rpc: Rpc): Promise<KycRegistryRecord[]> {
  const disc = getKycRegistryDiscriminatorBytes();
  const records = await rpc
    .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, {
      // "confirmed" matches the client's tx confirmation level: the bootstrap
      // card re-reads right after `create_kyc_registry` lands and a
      // finalized-only scan would flip it back to "No registry yet" for the
      // ~15–30 s until finalization.
      commitment: "confirmed",
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset: BigInt(0),
            encoding: "base58",
            bytes: getBase58Decoder().decode(disc) as Base58EncodedBytes,
          },
        },
      ],
    })
    .send({ abortSignal: AbortSignal.timeout(10_000) });
  const out: KycRegistryRecord[] = [];
  for (const r of records) {
    if (r.account.owner !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Unexpected KYC registry owner");
    const bytes = Uint8Array.from(atob(r.account.data[0]), (c) => c.charCodeAt(0));
    if (!disc.every((b, i) => b === bytes[i])) throw new Error("Unexpected KYC registry discriminator");
    out.push({ address: r.pubkey, registry: getKycRegistryDecoder().decode(bytes) });
  }
  return out;
}

/**
 * Reads ONE registry by address (the pinned path, with no program scan).
 * Returns null when nothing exists there. Throws when the account exists but
 * is not a KycRegistry (wrong owner, discriminator or length), so a mistyped
 * pin fails loudly instead of resolving to some other account.
 */
export async function fetchKycRegistryAt(
  rpc: Rpc,
  registryAddress: Address,
  commitment: "confirmed" | "finalized" = "confirmed",
): Promise<KycRegistryRecord | null> {
  const account = await fetchEncodedAccount(
    rpc as unknown as Parameters<typeof fetchEncodedAccount>[0],
    registryAddress,
    { commitment, abortSignal: AbortSignal.timeout(10_000) },
  );
  if (!account.exists) return null;
  if (account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) {
    throw new Error(`KYC registry ${registryAddress} is not owned by asset_registry`);
  }
  const disc = getKycRegistryDiscriminatorBytes();
  const bytes = account.data;
  if (bytes.length < getKycRegistrySize() || !disc.every((b, i) => b === bytes[i])) {
    throw new Error(`Account ${registryAddress} is not a KycRegistry`);
  }
  return { address: registryAddress, registry: getKycRegistryDecoder().decode(bytes) };
}

async function fetchKycAuthorityContext(
  rpc: Rpc,
  pinned: Address | null,
): Promise<KycAuthorityContext> {
  const [platformPda] = await findPlatformPda();
  const platform = await fetchMaybePlatform(rpc, platformPda);
  const platformAdmin = platform.exists ? platform.data.admin : null;
  let registries: KycRegistryRecord[];
  if (pinned) {
    const one = await fetchKycRegistryAt(rpc, pinned);
    registries = one ? [one] : [];
  } else {
    registries = await listKycRegistries(rpc);
  }
  const { registry, ambiguous, pinnedMissing } = selectKycRegistry(
    registries,
    platformAdmin,
    pinned,
  );
  return { platformAdmin, registry, registries, ambiguous, pinned, pinnedMissing };
}

/** How long a resolved context is reused before the chain is read again. */
export const KYC_AUTHORITY_CACHE_TTL_MS = 30_000;

type CacheEntry = { at: number; pinned: Address | null; promise: Promise<KycAuthorityContext> };
// Keyed by the rpc object so every page sharing one Solana client shares one
// read; a failed read is evicted so the next caller retries.
const contextCache = new WeakMap<object, CacheEntry>();

/** Drop the cached context (e.g. right after the registry was created or rotated). */
export function invalidateKycAuthorityContext(rpc: Rpc): void {
  contextCache.delete(rpc as object);
}

/**
 * Loads the platform admin and the live registry, keeping the two roles
 * separate.
 *
 * The result is cached per rpc for KYC_AUTHORITY_CACHE_TTL_MS, and concurrent
 * callers share one in-flight request. Pass `fresh: true` to bypass the cache
 * (after a write). `pinned` defaults to the deployment's
 * `NEXT_PUBLIC_KYC_REGISTRY`. An invalid pin rejects (fail closed).
 */
export async function loadKycAuthorityContext(
  rpc: Rpc,
  opts: { fresh?: boolean; now?: () => number; pinned?: Address | null } = {},
): Promise<KycAuthorityContext> {
  const pinned = opts.pinned !== undefined ? opts.pinned : configuredKycRegistry();
  const now = opts.now ?? Date.now;
  const key = rpc as object;
  const hit = contextCache.get(key);
  if (!opts.fresh && hit && hit.pinned === pinned && now() - hit.at < KYC_AUTHORITY_CACHE_TTL_MS) {
    return hit.promise;
  }
  const promise = fetchKycAuthorityContext(rpc, pinned);
  contextCache.set(key, { at: now(), pinned, promise });
  try {
    return await promise;
  } catch (err) {
    if (contextCache.get(key)?.promise === promise) contextCache.delete(key);
    throw err;
  }
}

/**
 * Polls (fresh reads) until a registry is visible or the attempts run out.
 * Used right after `create_kyc_registry`, so that a lagging RPC node does not
 * make the bootstrap card fall back to the Create form.
 */
export async function waitForKycRegistry(
  rpc: Rpc,
  opts: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    pinned?: Address | null;
  } = {},
): Promise<KycAuthorityContext> {
  const attempts = opts.attempts ?? 6;
  const delayMs = opts.delayMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const load = () => loadKycAuthorityContext(rpc, { fresh: true, pinned: opts.pinned });
  let ctx = await load();
  for (let i = 1; i < attempts && !ctx.registry && !ctx.ambiguous; i++) {
    await sleep(delayMs);
    ctx = await load();
  }
  return ctx;
}

export type PassportAuthority = {
  /** Address of the live registry every passport op must target (null = none). */
  registryAddress: Address | null;
  /** Live `KycRegistry.authority`, the only key that may issue/revoke. */
  registryAuthority: Address | null;
  platformAdmin: Address | null;
  /** Connected wallet equals `registryAuthority`. */
  isKycProvider: boolean;
  /** Connected wallet equals `Platform.admin` (never implies isKycProvider). */
  isPlatformAdmin: boolean;
  ambiguous: boolean;
  /** A pin is configured but its registry does not exist on this network. */
  pinnedMissing: boolean;
};

/**
 * What a passport surface (issue/revoke panel) may do with the connected
 * wallet. The registry address and signer authority come from the live
 * registry, never from the wallet or `Platform.admin`. So after a rotation of
 * either role, nobody is offered a tx against a registry derived from their
 * own key.
 */
export function passportAuthorityFor(
  wallet: Address | string | null | undefined,
  ctx: KycAuthorityContext | null | undefined,
): PassportAuthority {
  const registryAuthority = ctx?.registry?.registry.authority ?? null;
  const platformAdmin = ctx?.platformAdmin ?? null;
  const gates = kycGates(wallet, registryAuthority, platformAdmin);
  return {
    registryAddress: ctx?.registry?.address ?? null,
    registryAuthority,
    platformAdmin,
    isKycProvider: gates.isKycProvider,
    isPlatformAdmin: gates.isPlatformAdmin,
    ambiguous: ctx?.ambiguous ?? false,
    pinnedMissing: ctx?.pinnedMissing ?? false,
  };
}
