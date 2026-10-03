// Whether an Open sale can still take a buy (buy.rs), judged off chain. The
// Primary-issuance (0x02) rules count only these: the pre-clear check before
// the super admin clears 0x02, the re-pause offers (/admin/launchpad, the
// pre-clear panel's "Close Primary issuance again", "End and collect", "Send
// to wallets") and the primary-open-idle alarm. A sale still marked Open that
// ended, sold out or whose issuer is frozen cannot take a buy: it resumes
// nothing when 0x02 is cleared, and it does not need 0x02 open to be closed
// (close_sale reads 0x20 and the freeze, never 0x02).
//
// Every one of those rules gets the freeze from the same place: the browser
// paths from lib/open-sales-chain listOpenSalesWithFreezes (each Open sale
// with its issuer's IssuerFreeze, read at finalized), the alarm from the
// issuer_freezes mirror (lib/server/alarm-checks primaryIdleReport). A sale
// whose freeze could not be read (`frozen: null`) counts by the rule's own
// side of safety (FreezePolicy).
//
// Pure and node-safe (tests/public-sale.test.ts, tests/alarm-checks.test.ts).
import { CHAIN_CLOCK_MARGIN_SECONDS } from "@/lib/deadline-bounds";

/** What buy.rs reads besides the pause bits: the end (0 = no end), the supply offered and sold. */
export type SaleBuyWindow = { endTs: bigint; totalForSale: bigint; sold: bigint };

/** An Open sale with its issuer's freeze as read: true frozen, false not, null could not be read. */
export type SaleWithFreeze = SaleBuyWindow & { frozen: boolean | null };

/** "live": a buy can land; otherwise why it cannot. */
export type SaleBuyState = "live" | "ended" | "sold-out" | "frozen";

/**
 * What a freeze that could not be read counts as.
 *  · "pre-clear": not frozen, so the sale is live — the check before 0x02 is
 *    cleared never passes on an unknown;
 *  · "re-pause": frozen, so the sale is not live — an unknown never hides an
 *    offer (or the alarm) to set 0x02 again: closing Primary issuance is
 *    always safe (a live sale only stops taking buys until it is reopened).
 */
export type FreezePolicy = "pre-clear" | "re-pause";

/**
 * buy.rs refuses past `end_ts` (SaleEnded), at `sold == total_for_sale`
 * (SaleSoldOut) and under an IssuerFreeze (IssuerProceedsFrozen). The end is
 * judged on the chain's clock, which can lag ours: a sale counts as ended
 * only CHAIN_CLOCK_MARGIN_SECONDS past it. A sale that has not started yet
 * counts as live (it starts on its own). `frozen` null (not read) is not
 * frozen here; liveSales applies the policy of the rule asking.
 */
export function saleBuyState(sale: SaleBuyWindow, nowSec: number | bigint, frozen: boolean | null = false): SaleBuyState {
  const now = BigInt(nowSec);
  if (sale.endTs > BigInt(0) && sale.endTs + BigInt(CHAIN_CLOCK_MARGIN_SECONDS) < now) return "ended";
  if (sale.sold >= sale.totalForSale) return "sold-out";
  if (frozen === true) return "frozen";
  return "live";
}

/** Unix seconds now (this machine's clock; saleBuyState allows for the chain's lag). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Whether the sale can take a buy, with an unread freeze counted by `policy`. */
export function isLiveSale(sale: SaleWithFreeze, nowSec: number | bigint, policy: FreezePolicy): boolean {
  if (saleBuyState(sale, nowSec, sale.frozen) !== "live") return false;
  return sale.frozen !== null || policy === "pre-clear";
}

/** The Open sales that can still take a buy, an unread freeze counted by `policy`. */
export function liveSales<T extends SaleWithFreeze>(sales: readonly T[], nowSec: number | bigint, policy: FreezePolicy): T[] {
  return sales.filter((s) => isLiveSale(s, nowSec, policy));
}

/** Open sales that would take a buy unless their issuer is frozen, and whose freeze could not be read. */
export function freezeUnread<T extends SaleWithFreeze>(sales: readonly T[], nowSec: number | bigint): T[] {
  return sales.filter((s) => s.frozen === null && saleBuyState(s, nowSec, null) === "live");
}

/** Words for a sale that cannot take a buy. */
export const SALE_BUY_STATE_LABEL: Record<Exclude<SaleBuyState, "live">, string> = {
  ended: "ended, not closed yet",
  "sold-out": "sold out, not closed yet",
  frozen: "issuer frozen (no buys while frozen)",
};

/** Words for a sale whose issuer's freeze could not be read. */
export const FREEZE_UNREAD_LABEL = "issuer freeze state unreadable (it may still take buys)";
