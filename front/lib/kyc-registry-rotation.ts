// Pure helpers for the KYC registry panel (2C-1): proposed-authority
// validation, pending-transfer state, and jurisdiction bitmap diffs. The
// program enforces every rule itself. These helpers only keep an operator
// from signing a transaction that must fail, and show what a change does.
import { isAddress } from "@solana/kit";
import { DEFAULT_ADDRESS } from "@/lib/protocol-treasury";

/**
 * Why `candidate` cannot be proposed as the registry's new authority, or null
 * when it can (an empty input is not an error yet). This mirrors
 * `validate_new_authority`: a valid, non-default key that is not the current
 * authority.
 */
export function proposedKycAuthorityError(
  candidate: string,
  currentAuthority: string | null | undefined,
): string | null {
  const value = candidate.trim();
  if (!value) return null;
  if (!isAddress(value)) return "Not a valid Solana address.";
  if (value === DEFAULT_ADDRESS) return "The default 1111…1111 address cannot be an authority.";
  if (currentAuthority && value === currentAuthority) return "This wallet is already the registry authority.";
  return null;
}

export type PendingKycTransfer = {
  target: string;
  currentAuthority: string;
  newAuthority: string;
  proposedBy: string;
};

export type KycTransferState =
  /** Nothing staged. */
  | { kind: "none" }
  /** Staged by the current authority: the named wallet can accept, the current authority can cancel. */
  | { kind: "live"; newAuthority: string }
  /**
   * Staged, but it no longer matches the registry (the authority moved since).
   * Accept would fail with InvalidAuthorityTransfer. The current authority
   * can cancel it, or overwrite it with a new proposal.
   */
  | { kind: "stale"; newAuthority: string };

/**
 * Derives the pending-transfer state exactly as `accept_kyc_registry_authority`
 * checks it: target is this registry, and both `current_authority` and
 * `proposed_by` equal the registry's live authority.
 */
export function kycTransferState(
  registryAddress: string,
  registryAuthority: string,
  pending: PendingKycTransfer | null,
): KycTransferState {
  if (!pending || pending.target !== registryAddress) return { kind: "none" };
  const live =
    pending.currentAuthority === registryAuthority && pending.proposedBy === registryAuthority;
  return live
    ? { kind: "live", newAuthority: pending.newAuthority }
    : { kind: "stale", newAuthority: pending.newAuthority };
}

/** What the connected wallet may do in the panel, from on-chain state only. */
export function kycRegistryActions(
  wallet: string | null | undefined,
  registryAuthority: string,
  state: KycTransferState,
): { canPropose: boolean; canCancel: boolean; canAccept: boolean; canEditJurisdictions: boolean } {
  const isAuthority = !!wallet && wallet === registryAuthority;
  return {
    canPropose: isAuthority,
    canCancel: isAuthority && state.kind !== "none",
    canAccept: !!wallet && state.kind === "live" && state.newAuthority === wallet,
    canEditJurisdictions: isAuthority,
  };
}

/**
 * Checkbox semantics of the registry jurisdiction editor (create + update):
 * a code is never both approved and blocked. Setting one side clears the
 * other, and unsetting just clears it. Codes are zero-padded ISO strings.
 */
export function toggleJurisdiction(
  approved: ReadonlySet<string>,
  blocked: ReadonlySet<string>,
  code: string,
  target: "approved" | "blocked",
): { approved: Set<string>; blocked: Set<string> } {
  const nextApproved = new Set(approved);
  const nextBlocked = new Set(blocked);
  const [mine, other] = target === "approved" ? [nextApproved, nextBlocked] : [nextBlocked, nextApproved];
  if (mine.has(code)) {
    mine.delete(code);
  } else {
    mine.add(code);
    other.delete(code);
  }
  return { approved: nextApproved, blocked: nextBlocked };
}

/** The set bits of an on-chain bitmap as zero-padded ISO strings ("688"). */
export function bitmapCodeStrings(bitmap: ArrayLike<number>): Set<string> {
  return new Set(bitmapCodes(bitmap).map((c) => String(c).padStart(3, "0")));
}

/** Every jurisdiction code whose bit is set (ascending). */
export function bitmapCodes(bitmap: ArrayLike<number>): number[] {
  const codes: number[] = [];
  for (let byte = 0; byte < bitmap.length; byte++) {
    const value = bitmap[byte];
    if (!value) continue;
    for (let bit = 0; bit < 8; bit++) {
      if (value & (1 << bit)) codes.push(byte * 8 + bit);
    }
  }
  return codes;
}

export type JurisdictionDiff = {
  approvedAdded: number[];
  approvedRemoved: number[];
  blockedAdded: number[];
  blockedRemoved: number[];
  /** True when nothing would change on-chain. */
  unchanged: boolean;
};

function difference(a: readonly number[], b: readonly number[]): number[] {
  const set = new Set(b);
  return a.filter((code) => !set.has(code));
}

/** The change `update_kyc_registry_jurisdictions` would make, per map. */
export function jurisdictionDiff(
  current: { approved: ArrayLike<number>; blocked: ArrayLike<number> },
  next: { approved: ArrayLike<number>; blocked: ArrayLike<number> },
): JurisdictionDiff {
  const curApproved = bitmapCodes(current.approved);
  const curBlocked = bitmapCodes(current.blocked);
  const nextApproved = bitmapCodes(next.approved);
  const nextBlocked = bitmapCodes(next.blocked);
  const diff = {
    approvedAdded: difference(nextApproved, curApproved),
    approvedRemoved: difference(curApproved, nextApproved),
    blockedAdded: difference(nextBlocked, curBlocked),
    blockedRemoved: difference(curBlocked, nextBlocked),
  };
  return {
    ...diff,
    unchanged:
      diff.approvedAdded.length === 0 &&
      diff.approvedRemoved.length === 0 &&
      diff.blockedAdded.length === 0 &&
      diff.blockedRemoved.length === 0,
  };
}
