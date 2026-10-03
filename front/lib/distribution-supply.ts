// How many tokens a distribution may still create, and how many of a list
// must be created first (design §0 supply rules, §2).
//
// The program caps an Equity class on CIRCULATING supply (AR util.rs:481-487),
// and a conversion burn lowers circulating supply (realize_custody_vault.rs:
// 172-175): on chain, room reopens after every conversion. The tokenized
// stake is a fixed share of the company, so the UI counts from
// `lifetime_minted` (burns never lower it) and never re-issues tokens for
// shares that already left the pool:
//
//   room     = max_supply − lifetime_minted
//              − Σ(total − sold) of the class's Open sales (`buy` mints them later)
//              − Σ treasury-mint reservations still reserved and not yet minted
//   sendable = treasury balance + room
//   shortfall (what a list must create first) = max(0, total − treasury balance)
//
// Tokens already in the treasury (an unfinished run's unsent rows) are part
// of `lifetime_minted` and are not subtracted twice.
//
// Pure and node-safe: tests/distribution-supply.test.ts.
import { formatTokens } from "@/lib/tokenize-shares";

/** ShareClass.version that carries `lifetime_minted` (AR util.rs:463-471). */
export const LIFETIME_COUNTER_VERSION = 2;

export type SupplyFacts = {
  /** null = uncapped. */
  maxSupply: bigint | null;
  lifetimeMinted: bigint;
  /** ShareClass.version (2 carries lifetime_minted). */
  version: number;
  supplyLocked: boolean;
  mintablePostLaunch: boolean;
  /** Σ(total_for_sale − sold) over the class's Open sales. */
  openSaleRemaining: bigint;
  /** Σ units of the class's treasury-mint reservations still `reserved` (not minted yet). */
  reservedUnminted: bigint;
  /** The issuer treasury's balance of the mint. */
  treasuryBalance: bigint;
};

const ZERO = BigInt(0);
const max0 = (n: bigint) => (n > ZERO ? n : ZERO);

/** Whether more tokens can be created at all, and why not. */
export function creationBlocker(f: Pick<SupplyFacts, "version" | "supplyLocked" | "mintablePostLaunch">): string | null {
  if (f.supplyLocked && !f.mintablePostLaunch) return "The supply is locked, so no more tokens can be created.";
  if (f.version !== LIFETIME_COUNTER_VERSION) {
    return "This share class predates the lifetime supply counter, so tokens cannot be created from this screen.";
  }
  return null;
}

/** Tokens that can still be created (null = no cap); 0 when creation is blocked. */
export function roomToCreate(f: SupplyFacts): bigint | null {
  if (creationBlocker(f)) return ZERO;
  if (f.maxSupply === null) return null;
  return max0(f.maxSupply - f.lifetimeMinted - f.openSaleRemaining - f.reservedUnminted);
}

/** Tokens a list may send in total: what the treasury holds plus what may still be created (null = no cap). */
export function sendable(f: SupplyFacts): bigint | null {
  const room = roomToCreate(f);
  return room === null ? null : f.treasuryBalance + room;
}

/** What a list of `total` tokens must create first. */
export function shortfall(total: bigint, treasuryBalance: bigint): bigint {
  return max0(total - treasuryBalance);
}

export type SupplyVerdict = {
  total: bigint;
  shortfall: bigint;
  room: bigint | null;
  /** null when the list can be sent (after creating `shortfall`). */
  problem: string | null;
};

/** Whether a list of `total` tokens fits: the treasury first, then the room. */
export function supplyVerdict(total: bigint, f: SupplyFacts): SupplyVerdict {
  const short = shortfall(total, f.treasuryBalance);
  const room = roomToCreate(f);
  let problem: string | null = null;
  if (short > ZERO) {
    const blocked = creationBlocker(f);
    if (blocked) {
      problem = `${blocked} The treasury holds ${formatTokens(f.treasuryBalance)}; the list needs ${formatTokens(total)}.`;
    } else if (room !== null && short > room) {
      problem =
        `Only ${formatTokens(room)} more tokens can be created (cap ${formatTokens(f.maxSupply ?? ZERO)}, ` +
        `${formatTokens(f.lifetimeMinted)} created so far` +
        (f.openSaleRemaining > ZERO ? `, ${formatTokens(f.openSaleRemaining)} on sale` : "") +
        (f.reservedUnminted > ZERO ? `, ${formatTokens(f.reservedUnminted)} reserved for a mint` : "") +
        `), and the treasury holds ${formatTokens(f.treasuryBalance)}: the list needs ${formatTokens(total)}.`;
    }
  }
  return { total, shortfall: short, room, problem };
}

export type Allocation = {
  inTreasury: bigint;
  /** Sent or sold: created and no longer in the treasury (converted tokens included). */
  out: bigint;
  onSale: bigint;
  /** Still to be created (null = no cap). */
  notCreated: bigint | null;
  cap: bigint | null;
};

/** The allocation line of the Distribute card. */
export function allocation(f: SupplyFacts): Allocation {
  return {
    inTreasury: f.treasuryBalance,
    out: max0(f.lifetimeMinted - f.treasuryBalance),
    onSale: f.openSaleRemaining,
    notCreated: roomToCreate(f),
    cap: f.maxSupply,
  };
}

/** The cap minus everything ever created: what the checklist calls "not created yet". */
export function remainingFromLifetime(maxSupply: bigint | null, lifetimeMinted: bigint): bigint | null {
  return maxSupply === null ? null : max0(maxSupply - lifetimeMinted);
}
