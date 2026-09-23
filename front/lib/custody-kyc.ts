/**
 * lib/custody-kyc.ts — KYC at conversion and delivery (program 2C-3).
 *
 * Buying and holding need no investor passport. Converting units into company
 * equity, or taking physical delivery, does: the platform opens both as a
 * `DeliveryEscrow` custody vault that pins a KYC registry at open, and
 * `realize_custody_vault` (the burn that records the conversion / delivery)
 * requires the beneficiary's Approved, unexpired, jurisdiction-allowed
 * `KycEntry` in that registry. Without one, the holder's deposit leaves via
 * `return_custody_vault` instead.
 *
 * Everything here is a pre-flight mirror for the admin UI; the program
 * re-checks all of it. `evaluatePassport` follows the on-chain order
 * (`util::require_kyc_entry_current`, then `util::require_jurisdiction_allowed`).
 */
import type { Address } from "@solana/kit";
import {
  fetchMaybeKycEntry,
  fetchMaybeKycRegistry,
  KycStatus,
  VaultType,
  type KycEntry,
  type KycRegistry,
} from "@/lib/generated/asset_registry";
import { bitmapHasCode, getEntryPda, isPassportExpired } from "@/lib/passport";
import { countryName } from "@/lib/countries";

/** `Pubkey::default()` — an unpinned (non-delivery) vault's `kycRegistry`. */
export const DEFAULT_PUBKEY = "11111111111111111111111111111111";

export type PassportStatus =
  | "approved"
  | "missing"
  | "not_approved"
  | "expired"
  | "jurisdiction"
  | "registry_unreadable";

export type PassportEvaluation = {
  status: PassportStatus;
  /** Operator-facing explanation; empty when approved. */
  reason: string;
  /** The entry's expiry (unix seconds), when an entry exists. */
  expiry: bigint | null;
};

/** The vault fields the KYC gate reads (a decoded `CustodyVault` fits). */
export type CustodyKycVault = {
  vaultType: VaultType;
  beneficiary: Address | string;
  kycRegistry: Address | string;
};

const STATUS_LABEL: Record<number, string> = {
  [KycStatus.Pending]: "pending",
  [KycStatus.Approved]: "approved",
  [KycStatus.Revoked]: "revoked",
  [KycStatus.Expired]: "expired",
};

/**
 * Mirrors the realize gate for one (entry, registry) pair. `nowSec` is unix
 * seconds; `expiry == now` counts as expired (the program requires
 * `expiry > now`). A missing registry is reported after the entry checks,
 * as the on-chain jurisdiction check is the last one.
 */
export function evaluatePassport(
  entry: Pick<KycEntry, "status" | "expiry" | "jurisdiction"> | null,
  registry: Pick<KycRegistry, "approvedJurisdictions" | "blockedJurisdictions"> | null,
  nowSec: number,
): PassportEvaluation {
  if (!entry) {
    return {
      status: "missing",
      reason: "The holder has no investor passport in the vault's KYC registry.",
      expiry: null,
    };
  }
  if (entry.status !== KycStatus.Approved) {
    return {
      status: "not_approved",
      reason: `The holder's investor passport is ${STATUS_LABEL[entry.status] ?? "not approved"}.`,
      expiry: entry.expiry,
    };
  }
  if (isPassportExpired(entry.expiry, nowSec)) {
    return {
      status: "expired",
      reason: "The holder's investor passport has expired.",
      expiry: entry.expiry,
    };
  }
  if (!registry) {
    return {
      status: "registry_unreadable",
      reason: "The vault's KYC registry could not be read.",
      expiry: entry.expiry,
    };
  }
  const allowed =
    bitmapHasCode(registry.approvedJurisdictions, entry.jurisdiction) &&
    !bitmapHasCode(registry.blockedJurisdictions, entry.jurisdiction);
  if (!allowed) {
    return {
      status: "jurisdiction",
      reason: `The holder's jurisdiction (${countryName(
        String(entry.jurisdiction).padStart(3, "0"),
      )}) is not allowed by the vault's KYC registry.`,
      expiry: entry.expiry,
    };
  }
  return { status: "approved", reason: "", expiry: entry.expiry };
}

/** True when the vault's realize is KYC-gated (a pinned DeliveryEscrow). */
export function isKycGatedVault(vault: CustodyKycVault): boolean {
  return vault.vaultType === VaultType.DeliveryEscrow;
}

/**
 * Reads the beneficiary's entry and the pinned registry, then evaluates them.
 * Fails closed: any RPC / decode failure is `registry_unreadable`.
 */
export async function loadBeneficiaryPassport(
  rpc: Parameters<typeof fetchMaybeKycEntry>[0],
  vault: CustodyKycVault,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<PassportEvaluation> {
  if (vault.kycRegistry.toString() === DEFAULT_PUBKEY) {
    return {
      status: "registry_unreadable",
      reason: "This vault pins no KYC registry — return the deposit and re-open the vault.",
      expiry: null,
    };
  }
  try {
    const registryAddress = vault.kycRegistry as Address;
    const entryAddress = await getEntryPda(registryAddress, vault.beneficiary as Address);
    const [entry, registry] = await Promise.all([
      fetchMaybeKycEntry(rpc, entryAddress),
      fetchMaybeKycRegistry(rpc, registryAddress),
    ]);
    return evaluatePassport(
      entry.exists ? entry.data : null,
      registry.exists ? registry.data : null,
      nowSec,
    );
  } catch (err) {
    return {
      status: "registry_unreadable",
      reason: `Could not read the holder's investor passport: ${
        err instanceof Error ? err.message : String(err)
      }`,
      expiry: null,
    };
  }
}

/**
 * The trailing accounts `realize_custody_vault` needs: the pinned registry and
 * the beneficiary's entry for a DeliveryEscrow, nothing for any other type
 * (the builder then fills both optional slots with the program id).
 */
export async function realizeKycAccounts(
  vault: CustodyKycVault,
): Promise<{ kycRegistry?: Address; kycEntry?: Address }> {
  if (!isKycGatedVault(vault)) return {};
  if (vault.kycRegistry.toString() === DEFAULT_PUBKEY) {
    throw new Error(
      "This delivery vault pins no KYC registry (legacy vault) — return the deposit and re-open the vault.",
    );
  }
  const kycRegistry = vault.kycRegistry as Address;
  return {
    kycRegistry,
    kycEntry: await getEntryPda(kycRegistry, vault.beneficiary as Address),
  };
}

/**
 * Where an operator issues the holder's passport: the client page when the
 * request is linked to a client, otherwise the client list searched by wallet.
 */
export function passportShortcutHref({
  clientId,
  wallet,
}: {
  clientId: string | null | undefined;
  wallet: string;
}): string {
  if (clientId) return `/admin/clients/${encodeURIComponent(clientId)}`;
  return `/admin/clients?q=${encodeURIComponent(wallet)}`;
}

/**
 * Warns when a vault's pin is not the platform registry
 * (`NEXT_PUBLIC_KYC_REGISTRY`). The program checks the beneficiary in
 * whatever registry was pinned at open, so a stray pin changes who may
 * convert. Null when the pin matches, or when no platform pin is configured
 * and the vault has one.
 */
export function pinnedRegistryWarning(
  vaultRegistry: Address | string,
  configured: Address | string | null,
): string | null {
  const pin = vaultRegistry.toString();
  if (pin === DEFAULT_PUBKEY) {
    return "This vault pins no KYC registry — its realize cannot pass.";
  }
  if (configured !== null && pin !== configured.toString()) {
    return `This vault pins KYC registry ${pin}, not the platform registry ${configured.toString()}.`;
  }
  return null;
}

/** Badge copy for the admin UI. */
export const PASSPORT_STATUS_LABEL: Record<PassportStatus, string> = {
  approved: "Approved",
  missing: "No passport",
  not_approved: "Not approved",
  expired: "Expired",
  jurisdiction: "Jurisdiction not allowed",
  registry_unreadable: "Unverifiable",
};
