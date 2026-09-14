// KYC provider vs. platform admin — two separate on-chain roles.
//
// The program seeds the KycRegistry PDA with the *original* provider key and
// gates approve/revoke on `registry.authority`. `Platform.admin` (super admin)
// is a different role: rotating the platform admin does not move the registry
// and does not grant the new admin any passport rights. The UI must therefore
// resolve the live registry by scanning for KycRegistry accounts, never by
// deriving it from the current platform admin, and must gate KYC-provider
// actions on `registry.authority` only.
import { getBase58Decoder, type Address, type Base58EncodedBytes } from "@solana/kit";
import type { SolanaClient } from "@solana/client";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybePlatform,
  findPlatformPda,
  getKycRegistryDecoder,
  getKycRegistryDiscriminatorBytes,
  type KycRegistry,
} from "@/lib/generated/asset_registry";

type Rpc = SolanaClient["runtime"]["rpc"];

export type KycRegistryRecord = { address: Address; registry: KycRegistry };

export type KycAuthorityContext = {
  /** Current `Platform.admin`, or null when the platform is not initialised. */
  platformAdmin: Address | null;
  /** The live KYC registry, or null when none exists / none can be chosen. */
  registry: KycRegistryRecord | null;
  /** Every registry found on-chain (normally 0 or 1). */
  registries: KycRegistryRecord[];
  /** True when more than one registry exists and none could be selected. */
  ambiguous: boolean;
};

/**
 * Pick the live registry from the on-chain set. Preference order:
 * 1. the registry whose authority is the current platform admin (bootstrap
 *    case — provider and admin are the same key);
 * 2. the only registry that exists (post-rotation case);
 * 3. otherwise the choice is ambiguous and the UI must say so.
 *
 * Known limitation: the program also allows issuer-specific stricter
 * registries (`create_kyc_registry` doc, `Asset.extra_kyc_registry`), each
 * admin co-signed. No UI creates those today; if one ever exists before the
 * global registry is bootstrapped, rule 2 would pick it and the bootstrap
 * card would hide the Create form. Once such registries are supported, prefer
 * the registry referenced by the KycGated transfer-hook configs instead.
 */
export function selectKycRegistry(
  registries: readonly KycRegistryRecord[],
  platformAdmin: Address | string | null,
): { registry: KycRegistryRecord | null; ambiguous: boolean } {
  if (registries.length === 0) return { registry: null, ambiguous: false };
  const admin = platformAdmin?.toString() ?? null;
  const byAdmin = registries.find((r) => r.registry.authority.toString() === admin);
  if (byAdmin) return { registry: byAdmin, ambiguous: false };
  if (registries.length === 1) return { registry: registries[0], ambiguous: false };
  return { registry: null, ambiguous: true };
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

async function fetchKycAuthorityContext(rpc: Rpc): Promise<KycAuthorityContext> {
  const [platformPda] = await findPlatformPda();
  const platform = await fetchMaybePlatform(rpc, platformPda);
  const platformAdmin = platform.exists ? platform.data.admin : null;
  const registries = await listKycRegistries(rpc);
  const { registry, ambiguous } = selectKycRegistry(registries, platformAdmin);
  return { platformAdmin, registry, registries, ambiguous };
}

/** How long a resolved context is reused before the chain is scanned again. */
export const KYC_AUTHORITY_CACHE_TTL_MS = 30_000;

type CacheEntry = { at: number; promise: Promise<KycAuthorityContext> };
// Keyed by the rpc object so every page sharing one Solana client shares one
// scan; a failed scan is evicted so the next caller retries.
const contextCache = new WeakMap<object, CacheEntry>();

/** Drop the cached context (e.g. right after the registry was created). */
export function invalidateKycAuthorityContext(rpc: Rpc): void {
  contextCache.delete(rpc as object);
}

/**
 * Load platform admin + live registry, keeping the two roles separate.
 *
 * The registry scan is a `getProgramAccounts` call, so the result is cached
 * per rpc for KYC_AUTHORITY_CACHE_TTL_MS and concurrent callers share one
 * in-flight request. Pass `fresh: true` to bypass the cache (after a write).
 */
export async function loadKycAuthorityContext(
  rpc: Rpc,
  opts: { fresh?: boolean; now?: () => number } = {},
): Promise<KycAuthorityContext> {
  const now = opts.now ?? Date.now;
  const key = rpc as object;
  const hit = contextCache.get(key);
  if (!opts.fresh && hit && now() - hit.at < KYC_AUTHORITY_CACHE_TTL_MS) return hit.promise;
  const promise = fetchKycAuthorityContext(rpc);
  contextCache.set(key, { at: now(), promise });
  try {
    return await promise;
  } catch (err) {
    if (contextCache.get(key)?.promise === promise) contextCache.delete(key);
    throw err;
  }
}

/**
 * Poll (fresh scans) until a registry is visible or the attempts run out —
 * used right after `create_kyc_registry` so a lagging RPC node does not make
 * the bootstrap card fall back to the Create form.
 */
export async function waitForKycRegistry(
  rpc: Rpc,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<KycAuthorityContext> {
  const attempts = opts.attempts ?? 6;
  const delayMs = opts.delayMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let ctx = await loadKycAuthorityContext(rpc, { fresh: true });
  for (let i = 1; i < attempts && !ctx.registry && !ctx.ambiguous; i++) {
    await sleep(delayMs);
    ctx = await loadKycAuthorityContext(rpc, { fresh: true });
  }
  return ctx;
}

export type PassportAuthority = {
  /** PDA of the live registry every passport op must target (null = none). */
  registryAddress: Address | null;
  /** Live `KycRegistry.authority` — the only key that may issue/revoke. */
  registryAuthority: Address | null;
  platformAdmin: Address | null;
  /** Connected wallet equals `registryAuthority`. */
  isKycProvider: boolean;
  /** Connected wallet equals `Platform.admin` (never implies isKycProvider). */
  isPlatformAdmin: boolean;
  ambiguous: boolean;
};

/**
 * What a passport surface (issue/revoke panel) may do with the connected
 * wallet. The registry PDA and signer authority come from the live registry —
 * never from the wallet or `Platform.admin` — so after admin rotation the new
 * Super Admin is not offered a tx against a registry PDA that does not exist.
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
  };
}
