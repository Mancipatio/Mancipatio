import "server-only";
import { isAddress } from "@solana/kit";
import { SiwsError } from "@/lib/server/siws";

/**
 * Optional signed `vault_pda` filter of the delivery / conversion admin
 * lists: undefined when absent, a 400 when present but not a base58 address.
 */
export function vaultPdaFilter(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !isAddress(value))
    throw new SiwsError(400, "vault_pda must be a base58 address");
  return value;
}
