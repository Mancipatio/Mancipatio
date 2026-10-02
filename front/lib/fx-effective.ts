// Which EUR rate counts for a payment mint (migration 0080). Pure and
// isomorphic; the SAME rule as SQL public.fx_effective_rate, which every
// ledger function uses (reserve, adopt, treasury floor, revalue):
//
//   1. a manual row of kind eur_peg (an EUR stablecoin, 1:1)      → manual
//   2. a manual row with override_auto (the Super Admin pinned it) → manual_override
//   3. a fresh automatic rate (fx_auto_rates, age < max age)       → auto
//   4. a fresh manual rate (the fallback while auto is stale)      → manual
//   5. nothing fresh: the most recently observed one (manual on a tie), so
//      readers that accept any age (adoption, the treasury floor) use the best
//      price and readers that need a fresh one refuse with FX_RATE_STALE
//   6. neither row                                                 → none (FX_RATE_MISSING)
//
// "Fresh" is the 0066 rule: a rate row is stale once as_of is older than its
// max_age; an eur_peg row never goes stale.
import { FX_AUTO_UPDATED_BY } from "@/lib/fx-auto";
import { intervalSeconds } from "@/lib/pg-interval";

export type FxOrigin = "auto" | "manual" | "manual_override";

/** An fx_rates row (0066 + 0080's override_auto) as PostgREST returns it. */
export type FxManualRow = {
  network?: string;
  payment_mint: string;
  kind: string;
  eur_per_token: string | number;
  decimals: number;
  source: string;
  as_of: string;
  max_age: string;
  updated_by?: string | null;
  updated_at?: string;
  override_auto?: boolean | null;
};

/** An fx_auto_rates row (0080). */
export type FxAutoRow = {
  network?: string;
  payment_mint: string;
  eur_per_token: string | number;
  decimals: number;
  source: string;
  quotes?: unknown;
  as_of: string;
  max_age: string;
  updated_at?: string;
};

export type EffectiveFx = {
  /** The row that counts, in the fx_rates shape (an automatic one has kind rate, updated_by fx-auto). */
  row: FxManualRow;
  origin: FxOrigin;
  fresh: boolean;
};

/** Whether a rate row is within its max age at `now` (eur_peg: always). An unreadable row is stale. */
export function fxRowFresh(row: { kind: string; as_of: string; max_age: string }, now: number): boolean {
  if (row.kind === "eur_peg") return true;
  const maxAge = intervalSeconds(row.max_age);
  const asOf = Date.parse(row.as_of);
  if (row.kind !== "rate" || maxAge === null || !Number.isFinite(asOf)) return false;
  return now - asOf <= maxAge * 1000;
}

/** An automatic row in the fx_rates shape, as SQL fx_effective_rate returns it. */
export function autoAsManual(auto: FxAutoRow): FxManualRow {
  return {
    network: auto.network, payment_mint: auto.payment_mint, kind: "rate", eur_per_token: auto.eur_per_token,
    decimals: auto.decimals, source: auto.source, as_of: auto.as_of, max_age: auto.max_age,
    updated_by: FX_AUTO_UPDATED_BY, updated_at: auto.updated_at ?? auto.as_of, override_auto: false,
  };
}

export function resolveFxRate(manual: FxManualRow | null, auto: FxAutoRow | null, now: number): EffectiveFx | null {
  if (manual && manual.kind === "eur_peg") return { row: manual, origin: "manual", fresh: true };
  if (manual && manual.override_auto) return { row: manual, origin: "manual_override", fresh: fxRowFresh(manual, now) };
  const autoRow = auto ? autoAsManual(auto) : null;
  if (autoRow && fxRowFresh(autoRow, now)) return { row: autoRow, origin: "auto", fresh: true };
  if (manual && fxRowFresh(manual, now)) return { row: manual, origin: "manual", fresh: true };
  if (autoRow && (!manual || Date.parse(autoRow.as_of) > Date.parse(manual.as_of))) {
    return { row: autoRow, origin: "auto", fresh: false };
  }
  if (manual) return { row: manual, origin: "manual", fresh: false };
  return null;
}

/** resolveFxRate for every mint that has either row. */
export function resolveFxRates(manual: readonly FxManualRow[], auto: readonly FxAutoRow[], now: number): Map<string, EffectiveFx> {
  const byMint = new Map<string, { manual: FxManualRow | null; auto: FxAutoRow | null }>();
  for (const row of manual) byMint.set(row.payment_mint, { manual: row, auto: byMint.get(row.payment_mint)?.auto ?? null });
  for (const row of auto) byMint.set(row.payment_mint, { manual: byMint.get(row.payment_mint)?.manual ?? null, auto: row });
  const result = new Map<string, EffectiveFx>();
  for (const [mint, pair] of byMint) {
    const effective = resolveFxRate(pair.manual, pair.auto, now);
    if (effective) result.set(mint, effective);
  }
  return result;
}
