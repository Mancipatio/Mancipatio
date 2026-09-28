// Which of the registry's two permanent-delegate clawback instructions applies
// to a holder — pure, so the admin panel and its tests share one decision.
//
//   blocklist — clawback_blocklisted_holder: the holder's wallet carries a
//               live transfer-hook BlockEntry (added by the Blocklist
//               Authority) and an Admin signs. Open OR KYC-gated mints.
//   kyc       — clawback_from_holder: KYC-gated mint, the holder's passport
//               is revoked, or expired at least 30 days ago (v1.0.0-rc: the
//               grace lets a holder renew first; KYC provider + Admin).
//
// A blocked holder always takes the blocklist path, even when the passport
// path would also apply: its authorisation (two separate keys) is the
// stronger record. Both land in the same burn-only quarantine vault.

import type { Address } from "@solana/kit";

/**
 * "expired": past its expiry by the 30-day grace, so the passport path
 * applies; "grace": expired, but inside the grace (the program refuses the
 * passport path with 6079 until it ends).
 */
export type PassportStatus = "revoked" | "expired" | "grace" | "eligible" | "missing";

/** Mirrors the program's `KYC_EXPIRY_CLAWBACK_GRACE_SECS` (30 days). */
export const KYC_EXPIRY_CLAWBACK_GRACE_SECONDS = 2_592_000;

/**
 * A passport's clawback status exactly as `clawback_from_holder` judges it:
 * Revoked, or `expiry + 30 days <= now` (chain time; the program's own clock
 * decides, this only keeps a transaction that must fail from being signed).
 */
export function passportStatus(
  entry: { revoked: boolean; expiry: bigint | number } | null,
  nowSec: number,
): PassportStatus {
  if (!entry) return "missing";
  if (entry.revoked) return "revoked";
  const expiry = Number(entry.expiry);
  if (expiry + KYC_EXPIRY_CLAWBACK_GRACE_SECONDS <= nowSec) return "expired";
  if (expiry <= nowSec) return "grace";
  return "eligible";
}
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
  const check = checkSameKey(admin, blockedBy, blocklistAuthority);
  return check.asBlockedBy || check.asBlocklistAuthority === true;
}

export type SameKeyCheck = {
  /** The connected Admin added this BlockEntry — the event will show
   *  `admin == blocked_by`. */
  asBlockedBy: boolean;
  /** The connected Admin is the CURRENT Blocklist Authority; `null` when the
   *  Blocklist Authority could not be read (only `asBlockedBy` was checked). */
  asBlocklistAuthority: boolean | null;
};

/** Which of the two blocklist-path keys the connected Admin also holds. */
export function checkSameKey(
  admin: Address | null,
  blockedBy: Address | null,
  blocklistAuthority: Address | null,
): SameKeyCheck {
  return {
    asBlockedBy: admin !== null && admin === blockedBy,
    asBlocklistAuthority:
      blocklistAuthority === null ? null : admin !== null && admin === blocklistAuthority,
  };
}

/**
 * Panel copy for a {@link SameKeyCheck}: worded by WHICH key matched, since
 * only `asBlockedBy` shows up in the on-chain event (admin == blocked_by); a
 * rotated Blocklist Authority that is now the Admin shows admin != blocked_by
 * and is visible only in the audit metadata. `null` = nothing to say.
 */
export function sameKeyWarning(check: SameKeyCheck): string | null {
  const base =
    "The blocklist path is meant to need two different keys; the program does not enforce it.";
  if (check.asBlockedBy)
    return `The connected Admin wallet is the key that added this holder to the blocklist. ${base} The event and audit log will show the same key as admin and blocked_by.`;
  if (check.asBlocklistAuthority === true)
    return `The connected Admin wallet is also the current Blocklist Authority (a different key added this entry). ${base} The event will show two different keys; the audit log records that one key now holds both roles.`;
  if (check.asBlocklistAuthority === null)
    return "The current Blocklist Authority could not be read, so only the key that added this entry was compared with the connected wallet.";
  return null;
}
