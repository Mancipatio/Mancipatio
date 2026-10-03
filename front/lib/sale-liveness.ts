// Whether an Open sale can still take a buy (buy.rs), judged off chain. The
// Primary-issuance (0x02) rules count only these: the pre-clear check before
// the super admin clears 0x02, the re-pause offers (/admin/launchpad, "End
// and collect", "Send to wallets") and the primary-open-idle alarm. A sale
// still marked Open that ended, sold out or whose issuer is frozen cannot
// take a buy: it resumes nothing when 0x02 is cleared, and it does not need
// 0x02 open to be closed (close_sale reads 0x20 and the freeze, never 0x02).
//
// Pure and node-safe (tests/public-sale.test.ts, tests/alarm-checks.test.ts).
import { CHAIN_CLOCK_MARGIN_SECONDS } from "@/lib/deadline-bounds";

/** What buy.rs reads besides the pause bits: the end (0 = no end), the supply offered and sold. */
export type SaleBuyWindow = { endTs: bigint; totalForSale: bigint; sold: bigint };

/** "live": a buy can land; otherwise why it cannot. */
export type SaleBuyState = "live" | "ended" | "sold-out" | "frozen";

/**
 * buy.rs refuses past `end_ts` (SaleEnded), at `sold == total_for_sale`
 * (SaleSoldOut) and under an IssuerFreeze (IssuerProceedsFrozen). The end is
 * judged on the chain's clock, which can lag ours: a sale counts as ended
 * only CHAIN_CLOCK_MARGIN_SECONDS past it. A sale that has not started yet
 * counts as live (it starts on its own). `frozen` null (not read) is not
 * frozen: an unknown freeze never relaxes a check.
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

/** The Open sales that can still take a buy. */
export function liveSales<T extends SaleBuyWindow>(sales: readonly T[], nowSec: number | bigint): T[] {
  return sales.filter((s) => saleBuyState(s, nowSec) === "live");
}

/** Words for a sale that cannot take a buy. */
export const SALE_BUY_STATE_LABEL: Record<Exclude<SaleBuyState, "live">, string> = {
  ended: "ended, not closed yet",
  "sold-out": "sold out, not closed yet",
  frozen: "issuer frozen (no buys while frozen)",
};
