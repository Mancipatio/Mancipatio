// The platform's KYC registry, pinned BY ADDRESS.
//
// A KycRegistry's address is fixed at creation (`["kyc_registry", creating
// authority]`) while its `authority` can rotate (propose/accept). After a
// rotation the address can no longer be derived from any live key, so the
// deployment names it explicitly: `NEXT_PUBLIC_KYC_REGISTRY`.
//
// Fail closed: a configured but malformed value throws; it never silently
// falls back to the "find a registry" heuristic.
import { isAddress, type Address } from "@solana/kit";

/**
 * Parses a pin value. Blank / unset → null (no pin). Anything else must be a
 * valid base58 address, or this throws.
 */
export function parseKycRegistryPin(raw: string | null | undefined): Address | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  if (!isAddress(value)) {
    throw new Error(`NEXT_PUBLIC_KYC_REGISTRY is not a valid address: "${value}"`);
  }
  return value;
}

/**
 * The pinned platform KYC registry, or null when none is configured.
 * The literal `process.env.NEXT_PUBLIC_KYC_REGISTRY` read is required: Next
 * inlines it at build time only in that exact form.
 */
export function configuredKycRegistry(): Address | null {
  return parseKycRegistryPin(process.env.NEXT_PUBLIC_KYC_REGISTRY);
}
