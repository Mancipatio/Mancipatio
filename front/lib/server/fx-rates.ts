// SERVER-ONLY — reads both EUR rate tables of a network: the manual rows
// (0066 fx_rates, /admin/limits) and the automatic ones (0080 fx_auto_rates,
// /api/internal/fx). Before 0080 is applied the automatic table does not
// exist: that reads as "no automatic rates" (autoInstalled false), so a front
// deployed ahead of the migration keeps the manual behaviour.
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Network } from "@/lib/network";
import { resolveFxRate, resolveFxRates, type EffectiveFx, type FxAutoRow, type FxManualRow } from "@/lib/fx-effective";

/** PostgREST / PostgreSQL codes for a table that does not exist (yet). */
export const TABLE_MISSING_CODES: ReadonlySet<string> = new Set(["42P01", "PGRST205"]);

export function tableMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TABLE_MISSING_CODES.has(code);
}

export class FxReadError extends Error {
  constructor(readonly table: "fx_rates" | "fx_auto_rates") {
    super(`${table} unavailable`);
  }
}

export type FxTables = { manual: FxManualRow[]; auto: FxAutoRow[]; autoInstalled: boolean };

const MANUAL_COLUMNS = "network,payment_mint,kind,eur_per_token,decimals,source,as_of,max_age,updated_by,updated_at,override_auto";
const MANUAL_COLUMNS_0066 = "network,payment_mint,kind,eur_per_token,decimals,source,as_of,max_age,updated_by,updated_at";
const AUTO_COLUMNS = "network,payment_mint,eur_per_token,decimals,source,quotes,as_of,max_age,updated_at";

/** PostgreSQL / PostgREST codes for a column that does not exist (yet), e.g. override_auto before 0080. */
export function undefinedColumn(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "42703" || code === "PGRST204";
}

/**
 * Both tables for `network` (one mint when given). Throws FxReadError when
 * either cannot be read, except a missing fx_auto_rates (before 0080) and a
 * missing override_auto column (likewise), which read as their 0066 state.
 */
export async function readFxTables(
  sb: SupabaseClient, network: Network, opts: { mint?: string; signal?: AbortSignal } = {},
): Promise<FxTables> {
  const signal = opts.signal ?? AbortSignal.timeout(8_000);
  const manualQuery = (columns: string) => {
    let q = sb.from("fx_rates").select(columns).eq("network", network);
    if (opts.mint) q = q.eq("payment_mint", opts.mint);
    return q.abortSignal(signal);
  };
  let autoQuery = sb.from("fx_auto_rates").select(AUTO_COLUMNS).eq("network", network);
  if (opts.mint) autoQuery = autoQuery.eq("payment_mint", opts.mint);
  const [manualFirst, autoRes] = await Promise.all([manualQuery(MANUAL_COLUMNS), autoQuery.abortSignal(signal)]);
  let manualRes = manualFirst;
  if (manualRes.error && undefinedColumn(manualRes.error)) manualRes = await manualQuery(MANUAL_COLUMNS_0066);
  if (manualRes.error) throw new FxReadError("fx_rates");
  let auto: FxAutoRow[] = [];
  let autoInstalled = true;
  if (autoRes.error) {
    if (!tableMissing(autoRes.error)) throw new FxReadError("fx_auto_rates");
    autoInstalled = false;
  } else {
    auto = (autoRes.data ?? []) as unknown as FxAutoRow[];
  }
  return { manual: (manualRes.data ?? []) as unknown as FxManualRow[], auto, autoInstalled };
}

/** The effective rate of every mint of the network (lib/fx-effective.ts rule). */
export function effectiveRates(tables: FxTables, now = Date.now()): Map<string, EffectiveFx> {
  return resolveFxRates(tables.manual, tables.auto, now);
}

/** The effective rate of one mint; null when it has neither row. Throws FxReadError. */
export async function readEffectiveFxRate(
  sb: SupabaseClient, network: Network, mint: string, signal?: AbortSignal, now = Date.now(),
): Promise<EffectiveFx | null> {
  const tables = await readFxTables(sb, network, { mint, signal });
  // Both reads are filtered by the mint: at most one row each.
  return resolveFxRate(tables.manual[0] ?? null, tables.auto[0] ?? null, now);
}
