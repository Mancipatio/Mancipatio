// Bits of `Platform.pause_flags` (byte 74 of the on-chain Platform account).
// Mirrors `PAUSE_*` and `PLATFORM_BOOTSTRAP_OPEN` in
// program/programs/asset_registry/src/constants.rs — the IDL carries no
// constants, so tests/pause-flags.test.ts pins these values against the Rust
// source.
//
// Bits 0-6 are pauses. Each stops one family of platform-mediated ENTRY
// flows. Exits (cancels, expiries, refunds, claims, custody returns and burns)
// never read the flags, and the transfer hook never reads the Platform, so
// wallet-to-wallet transfers stay free. Any Admin may SET bits; only the Super
// Admin (`Platform.admin`) may CLEAR them, and bit 6 (the payout / Merkle
// modules, off on mainnet) only in a `set_pause_flags` call of its own
// (PayoutModulesClearNotExplicit, 6154).
//
// Bit 7 is NOT a pause: it is the one-way bootstrap marker. A fresh Platform
// starts at 0xFF; any clear (including `set_pause(false)`) closes bit 7 for
// good, and while it is open the admin-grant and super-admin-rotation
// timelocks are waived at execution.

export const PAUSE_ONBOARDING = 0x01;
export const PAUSE_PRIMARY = 0x02;
export const PAUSE_SECONDARY = 0x04;
export const PAUSE_CUSTODY_ENTRY = 0x08;
export const PAUSE_DISTRIBUTIONS = 0x10;
export const PAUSE_ISSUER_PROCEEDS = 0x20;
/** D2: Startup raises, yield routing, Rights-Token issuances and milestones (off on mainnet). */
export const PAUSE_PAYOUT_MODULES = 0x40;
/** Every pause bit (0x7F). Setting it is "pause everything". */
export const PAUSE_FLAGS_ALL = 0x7f;
/** Bit 7: the one-way bootstrap window. Not a pause bit and never in PAUSE_FLAGS_ALL. */
export const PLATFORM_BOOTSTRAP_OPEN = 0x80;
/** The emergency-pause areas (0x3F): every pause bit but the payout modules. */
export const EMERGENCY_PAUSE_BITS = PAUSE_FLAGS_ALL & ~PAUSE_PAYOUT_MODULES;
/**
 * "Resume everything" (0xBF): every emergency area and the bootstrap marker
 * (any clear closes it anyway), never the payout modules, which the program
 * switches on only in a call of their own (6154).
 */
export const RESUME_EVERYTHING_MASK = EMERGENCY_PAUSE_BITS | PLATFORM_BOOTSTRAP_OPEN;

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
  {
    bit: PAUSE_PAYOUT_MODULES,
    label: "Payout modules",
    stops:
      "Startup raises (opening a Startup sale and buying into one), yield routing, Rights-Token issuances and milestones. Off on mainnet; switching them on is a Super Admin call of its own.",
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

/**
 * Set bits that are neither a pause bit nor the bootstrap marker. Every bit
 * of the byte is defined since v1.0.0-rc, so this is 0 for any u8; it stays
 * for callers that normalize a wider value.
 */
export function unknownPauseBits(flags: number): number {
  return flags & ~(PAUSE_FLAGS_ALL | PLATFORM_BOOTSTRAP_OPEN) & 0xff;
}

/** The one-way bootstrap window is still open (bit 7). */
export function isBootstrapOpen(flags: number): boolean {
  return (flags & PLATFORM_BOOTSTRAP_OPEN) !== 0;
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

/** Refusal of a clear mask that mixes the payout modules with other bits (the program's 6154). */
export const PAYOUT_MODULES_CLEAR_ALONE =
  "The payout modules (0x40) are switched on in a call of their own; resume the other areas separately.";

/**
 * `set_pause_flags(set_mask, clear_mask)` arguments. The program computes
 * `new = (old | set) & !clear`, so a pause never wipes a bit another Admin set
 * in the meantime. Only the Super Admin may send a nonzero clear mask; one
 * that holds 0x40 must be exactly 0x40 (6154), so a mixed resume throws here
 * before any wallet prompt. Any nonzero clear also closes the bootstrap
 * window on-chain.
 */
export function pauseMasks(
  action: "pause" | "resume",
  bits: number,
): { setMask: number; clearMask: number } {
  const mask = bits & 0xff;
  if (action === "pause") return { setMask: mask & PAUSE_FLAGS_ALL, clearMask: 0 };
  if ((mask & PAUSE_PAYOUT_MODULES) !== 0 && mask !== PAUSE_PAYOUT_MODULES)
    throw new Error(PAYOUT_MODULES_CLEAR_ALONE);
  return { setMask: 0, clearMask: mask };
}

/** `set_pause_flags(0, 0x80)`: the Super Admin closes the bootstrap window explicitly. */
export const CLOSE_BOOTSTRAP_MASKS = { setMask: 0, clearMask: PLATFORM_BOOTSTRAP_OPEN } as const;

/** The flags the program will store for these masks. */
export function nextPauseFlags(
  old: number,
  setMask: number,
  clearMask: number,
): number {
  return (old | setMask) & ~clearMask & 0xff;
}

export type PauseStatus = {
  /** "notice": no area is paused, but the bootstrap window is still open. */
  tone: "active" | "paused" | "notice";
  label: string;
};

const EMERGENCY_AREAS = PAUSE_FLAGS.filter((f) => (f.bit & EMERGENCY_PAUSE_BITS) !== 0).length;

/**
 * The one status every surface shows (dashboard card, /admin/platform chip).
 * It counts the six emergency areas; the payout modules (off for good on
 * mainnet) and the bootstrap window are named after it, so the normal
 * mainnet byte 0x40 reads "Active · payout modules off", not "paused".
 */
export function pauseStatus(flags: number): PauseStatus {
  const paused = pausedFlags(flags & EMERGENCY_PAUSE_BITS).length;
  const notes = [
    isPaused(flags, PAUSE_PAYOUT_MODULES) ? "payout modules off" : null,
    isBootstrapOpen(flags) ? "bootstrap open" : null,
  ].filter((n): n is string => n !== null);
  const suffix = notes.length ? ` · ${notes.join(" · ")}` : "";
  if (paused === EMERGENCY_AREAS) return { tone: "paused", label: `Fully paused${suffix}` };
  if (paused > 0) return { tone: "paused", label: `${paused} of ${EMERGENCY_AREAS} paused${suffix}` };
  return { tone: isBootstrapOpen(flags) ? "notice" : "active", label: `Active${suffix}` };
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
  /** Clears RESUME_EVERYTHING_MASK: every emergency area, never the payout modules. */
  resumeEverything: boolean;
  /** Super Admin, bit 7 set: `set_pause_flags(0, 0x80)`. */
  closeBootstrap: boolean;
  /** Per pause bit, in bit order: the one action this wallet may take. */
  rows: { bit: number; paused: boolean; action: "pause" | "resume" | null }[];
};

export type PauseControlOptions = {
  /**
   * Whether the payout modules may be switched on from this surface (never on
   * mainnet: D2 keeps 0x40 set there). Default false, so a caller that does
   * not decide never offers it.
   */
  allowPayoutModules?: boolean;
};

export function pauseControls(
  flags: number,
  role: PauseRole,
  opts: PauseControlOptions = {},
): PauseControls {
  return {
    pauseEverything:
      role.isAdmin && (flags & PAUSE_FLAGS_ALL) !== PAUSE_FLAGS_ALL,
    resumeEverything: role.isSuperAdmin && (flags & EMERGENCY_PAUSE_BITS) !== 0,
    closeBootstrap: role.isSuperAdmin && isBootstrapOpen(flags),
    rows: PAUSE_FLAGS.map(({ bit }) => {
      const paused = isPaused(flags, bit);
      const mayResume =
        role.isSuperAdmin && (bit !== PAUSE_PAYOUT_MODULES || opts.allowPayoutModules === true);
      return {
        bit,
        paused,
        action: paused ? (mayResume ? "resume" : null) : role.isAdmin ? "pause" : null,
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
