// Which of the registry's two permanent-delegate clawback instructions applies
// to a holder — pure, so the admin panel and its tests share one decision.
//
//   blocklist — clawback_blocklisted_holder: the holder's wallet carries a
//               live transfer-hook BlockEntry (added by the Blocklist
//               Authority) and an Admin signs. Open OR KYC-gated mints.
//   kyc       — clawback_from_holder: KYC-gated mint, the holder's passport
//               is revoked or has expired (KYC provider + Admin).
//
// A blocked holder always takes the blocklist path, even when the passport
// path would also apply: its authorisation (two separate keys) is the
// stronger record. Both land in the same burn-only quarantine vault.

import type { Address } from "@solana/kit";

export type PassportStatus = "revoked" | "expired" | "eligible" | "missing";
export type ClawbackPath = "blocklist" | "kyc";

export type ClawbackPathInput = {
  /** The holder has a live BlockEntry (lib/blocklist `fetchBlockEntry`). */
  blocked: boolean;
  /** The mint has a transfer-hook config (every initialised share class). */
  hookConfigured: boolean;
  /** The mint's hook config is in KycGated mode. */
  kycGated: boolean;
  /** The holder's passport on the mint's registry (KycGated only). */
  entryStatus: PassportStatus;
};

export function chooseClawbackPath({
  blocked,
  hookConfigured,
  kycGated,
  entryStatus,
}: ClawbackPathInput): ClawbackPath | null {
  if (!hookConfigured) return null;
  if (blocked) return "blocklist";
  if (kycGated && (entryStatus === "revoked" || entryStatus === "expired"))
    return "kyc";
  return null;
}

/** The on-chain instruction name recorded in the audit log per path. */
export const CLAWBACK_IX_NAME: Record<ClawbackPath, string> = {
  blocklist: "clawback_blocklisted_holder",
  kyc: "clawback_from_holder",
};

/**
 * The blocklist path is meant to need two different keys. The program does
 * not enforce it (a single Squads vault may legitimately hold both roles), so
 * the panel warns when the connected Admin wallet is the key that added the
 * BlockEntry or the current Blocklist Authority.
 */
export function sameKeyHoldsBothRoles(
  admin: Address | null,
  blockedBy: Address | null,
  blocklistAuthority: Address | null,
): boolean {
  if (!admin) return false;
  return admin === blockedBy || admin === blocklistAuthority;
}
