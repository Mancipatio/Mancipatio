import { isAddress } from "@solana/kit";

/** Pubkey::default() — initialize_platform and set_protocol_treasury reject it
 *  (InvalidProtocolTreasury). */
export const DEFAULT_ADDRESS = "11111111111111111111111111111111";

/**
 * Why `candidate` cannot be the new protocol treasury, or null when it can
 * (an empty input is not an error yet). The program enforces the same rules;
 * this only keeps the Super Admin from signing a transaction that must fail.
 */
export function protocolTreasuryError(
  candidate: string,
  currentTreasury: string | null | undefined,
): string | null {
  const value = candidate.trim();
  if (!value) return null;
  if (!isAddress(value)) return "Not a valid Solana address.";
  if (value === DEFAULT_ADDRESS)
    return "The default 1111…1111 address cannot be the treasury.";
  if (currentTreasury && value === currentTreasury)
    return "This is already the treasury.";
  return null;
}
