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
