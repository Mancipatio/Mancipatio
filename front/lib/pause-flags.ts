// Emergency-pause bits of `Platform.pause_flags` (byte 74 of the on-chain
// Platform account). Mirrors `PAUSE_*` in
// program/programs/asset_registry/src/constants.rs — the IDL carries no
// constants, so tests/pause-flags.test.ts pins these values against the Rust
// source.
//
// Each bit stops one family of platform-mediated ENTRY flows. Exits (cancels,
// expiries, refunds, claims, custody returns and burns) never read the flags,
// and the transfer hook never reads the Platform, so wallet-to-wallet
// transfers stay free. Any Admin may SET bits; only the Super Admin
// (`Platform.admin`) may CLEAR them.

export const PAUSE_ONBOARDING = 0x01;
export const PAUSE_PRIMARY = 0x02;
export const PAUSE_SECONDARY = 0x04;
export const PAUSE_CUSTODY_ENTRY = 0x08;
export const PAUSE_DISTRIBUTIONS = 0x10;
export const PAUSE_ISSUER_PROCEEDS = 0x20;
/** Every defined bit. A freshly initialized Platform starts here. */
export const PAUSE_FLAGS_ALL = 0x3f;

export type PauseFlag = {
  bit: number;
  label: string;
  /** What the bit stops, in user terms. */
  stops: string;
};

export const PAUSE_FLAGS: readonly PauseFlag[] = [
  {
    bit: PAUSE_ONBOARDING,
    label: "Onboarding",
    stops:
      "New issuer registrations, assets, share classes and share-class mints.",
  },
  {
    bit: PAUSE_PRIMARY,
    label: "Primary issuance",
    stops: "Opening sales, buying in a sale and minting to a treasury.",
  },
  {
    bit: PAUSE_SECONDARY,
    label: "Trading through Manci",
    stops:
      "Creating, funding and taking OTC offers; creating and funding OTC deals.",
  },
  {
    bit: PAUSE_CUSTODY_ENTRY,
    label: "Custody entry",
    stops:
      "Opening custody vaults and depositing into them. A burn-only quarantine vault for clawback can still be opened.",
  },
  {
    bit: PAUSE_DISTRIBUTIONS,
    label: "Distributions",
    stops:
      "New distributions and batches, yield routing, vesting deposits and Rights-Token issuances and milestones.",
  },
  {
    bit: PAUSE_ISSUER_PROCEEDS,
    label: "Issuer proceeds",
    stops:
      "Paying sale proceeds to issuers: closing a sale, releasing payout tranches and founder yield claims.",
  },
];

/** What keeps working during any pause. */
export const PAUSE_EXITS_OPEN =
  "Cancels, expiries, refunds, claims, custody returns and wallet-to-wallet transfers keep working.";

export function isPaused(flags: number, bit: number): boolean {
  return (flags & bit) !== 0;
}

/** The defined bits that are set, in bit order. */
export function pausedFlags(flags: number): PauseFlag[] {
  return PAUSE_FLAGS.filter((flag) => isPaused(flags, flag.bit));
}

/** Set bits outside `PAUSE_FLAGS_ALL` — they gate nothing on-chain. */
export function unknownPauseBits(flags: number): number {
  return flags & ~PAUSE_FLAGS_ALL & 0xff;
}

/** "Onboarding, Primary issuance" — or "" when nothing defined is paused. */
export function describePausedAreas(flags: number): string {
  return pausedFlags(flags)
    .map((flag) => flag.label)
    .join(", ");
}

export function formatPauseFlags(flags: number): string {
  return `0x${(flags & 0xff).toString(16).padStart(2, "0")}`;
}

/**
 * `set_pause_flags(set_mask, clear_mask)` arguments. The program computes
 * `new = (old | set) & !clear`, so a pause never wipes a bit another Admin set
 * in the meantime. Only the Super Admin may send a nonzero clear mask.
 */
export function pauseMasks(
  action: "pause" | "resume",
  bits: number,
): { setMask: number; clearMask: number } {
  const mask = bits & 0xff;
  return action === "pause"
    ? { setMask: mask & PAUSE_FLAGS_ALL, clearMask: 0 }
    : { setMask: 0, clearMask: mask };
}

/** The flags the program will store for these masks. */
export function nextPauseFlags(
  old: number,
  setMask: number,
  clearMask: number,
): number {
  return (old | setMask) & ~clearMask & 0xff;
}

export type PauseStatus = {
  /** "undefined": only bits outside PAUSE_FLAGS_ALL are set (they gate nothing). */
  tone: "active" | "paused" | "undefined";
  label: string;
};

/**
 * The one status every surface shows (dashboard card, /admin/platform chip),
 * so a byte with only undefined bits (e.g. 0xC0 before a rollback
 * normalization) reads the same everywhere: neither a plain "Active" nor
 * "paused".
 */
export function pauseStatus(flags: number): PauseStatus {
  const paused = pausedFlags(flags).length;
  if (paused === PAUSE_FLAGS.length) return { tone: "paused", label: "Fully paused" };
  if (paused > 0)
    return { tone: "paused", label: `${paused} of ${PAUSE_FLAGS.length} paused` };
  const unknown = unknownPauseBits(flags);
  if (unknown !== 0)
    return { tone: "undefined", label: `Undefined bits ${formatPauseFlags(unknown)}` };
  return { tone: "active", label: "Active" };
}

export type PauseRole = { isAdmin: boolean; isSuperAdmin: boolean };

/**
 * Who may press what. The Super Admin is `Platform.admin` (it needs no Admin
 * record); any Admin-record holder is an Admin. Mirrors `set_pause_flags`:
 * any Admin SETS bits, only the Super Admin CLEARS them.
 */
export function pauseRole(
  wallet: string | null | undefined,
  platformAdmin: string,
  hasAdminRecord: boolean,
): PauseRole {
  const isSuperAdmin = !!wallet && wallet === platformAdmin;
  return { isSuperAdmin, isAdmin: isSuperAdmin || (!!wallet && hasAdminRecord) };
}

export type PauseControls = {
  pauseEverything: boolean;
  resumeEverything: boolean;
  /** Per defined bit, in bit order: the one action this wallet may take. */
  rows: { bit: number; paused: boolean; action: "pause" | "resume" | null }[];
};

export function pauseControls(flags: number, role: PauseRole): PauseControls {
  return {
    pauseEverything:
      role.isAdmin && (flags & PAUSE_FLAGS_ALL) !== PAUSE_FLAGS_ALL,
    // Clears undefined bits too (rollback normalization).
    resumeEverything: role.isSuperAdmin && (flags & 0xff) !== 0,
    rows: PAUSE_FLAGS.map(({ bit }) => {
      const paused = isPaused(flags, bit);
      return {
        bit,
        paused,
        action: paused
          ? role.isSuperAdmin
            ? "resume"
            : null
          : role.isAdmin
            ? "pause"
            : null,
      };
    }),
  };
}

/**
 * Audit metadata for one `set_pause_flags`. `expected_*` come from the panel's
 * last read of the Platform, which another Admin may have changed before this
 * transaction landed (that is why the program takes masks). `observed_after`
 * is a fresh read after confirmation (null when it failed). The authoritative
 * before/after pair is the PauseFlagsChanged event in `tx_signature`.
 */
export function pauseAuditMetadata(
  setMask: number,
  clearMask: number,
  cachedFlags: number,
  observedAfter?: number | null,
): Record<string, string | null> {
  return {
    set: formatPauseFlags(setMask),
    clear: formatPauseFlags(clearMask),
    expected_old: formatPauseFlags(cachedFlags),
    expected_new: formatPauseFlags(nextPauseFlags(cachedFlags, setMask, clearMask)),
    ...(observedAfter === undefined
      ? {}
      : {
          observed_after:
            observedAfter === null ? null : formatPauseFlags(observedAfter),
        }),
  };
}
